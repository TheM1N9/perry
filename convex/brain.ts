import { createThread } from "@convex-dev/agent";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { agentFor } from "./agents";
import { sendMessage, sendTyping } from "./lib/telegram";
import { DEFAULT_MODE, MODES, type ModeName } from "./modes";

/**
 * One turn, end to end: resolve the conversation, resolve the mode, run the
 * agent bound to that mode, reply.
 *
 * Scheduled from ingest, so it sits off the Telegram request path and may take
 * as long as it needs to.
 */

const CHANNEL = "telegram" as const;

const HELP = `
Perry, your assistant.

Modes
  /perry    read and remember only. cheap, safe, default
  /agentp   full tools, long leash. say what you want done
  /mode     which mode am I in

Other
  /status   plumbing and recent errors
  /reset    start a fresh conversation, keep memories
  /help     this

Everything else is just talk to me.
`.trim();

/** Commands never reach the model. They are plumbing, not conversation. */
async function runCommand(
  ctx: ActionCtx,
  conversation: Doc<"conversations">,
  text: string,
): Promise<string> {
  const [raw, ...rest] = text.trim().split(/\s+/);
  const command = raw.toLowerCase().replace(/@.*$/, ""); // strip /cmd@botname

  const describe = (name: ModeName) => {
    const mode = MODES[name];
    return `${mode.label}: ${mode.tools.join(", ")}, ${mode.stepBudget} steps, ${mode.model}`;
  };

  const switchTo = async (name: ModeName) => {
    if (name === conversation.mode) return `Already ${MODES[name].label}.`;
    await ctx.runMutation(internal.conversations.setMode, {
      id: conversation._id,
      mode: name,
    });
    return describe(name);
  };

  switch (command) {
    case "/start":
    case "/help":
      return HELP;

    case "/perry":
      return await switchTo("perry");

    case "/agentp":
      return await switchTo("agentP");

    case "/mode": {
      const requested = rest[0]?.toLowerCase();
      if (!requested) return describe(conversation.mode);

      const match = (Object.keys(MODES) as ModeName[]).find(
        (m) => m.toLowerCase() === requested,
      );
      if (!match) return "No such mode. Try /perry or /agentp.";
      return await switchTo(match);
    }

    case "/status": {
      const stats = await ctx.runQuery(internal.conversations.stats, {
        id: conversation._id,
      });
      const memoryCount = await ctx.runQuery(internal.memories.count, {});
      const lines = [
        `mode      ${MODES[stats?.mode ?? conversation.mode].label}`,
        `memories  ${memoryCount}`,
        `runs      ${stats?.recentRuns ?? 0} recent`,
        `model     ${MODES[stats?.mode ?? conversation.mode].model}`,
      ];
      if (stats?.lastError) lines.push("", `last error: ${stats.lastError}`);
      return lines.join("\n");
    }

    case "/reset":
      await ctx.runMutation(internal.conversations.clearThread, {
        id: conversation._id,
      });
      return "Fresh start. I still remember what I remembered.";

    default:
      return `Don't know ${command}. /help lists what I do know.`;
  }
}

/**
 * Find the conversation for this chat, creating it and its agent thread on
 * first contact.
 */
async function loadConversation(
  ctx: ActionCtx,
  chatId: string,
  title?: string,
): Promise<Doc<"conversations">> {
  const find = () =>
    ctx.runQuery(internal.conversations.getByExternalId, {
      channel: CHANNEL,
      externalId: chatId,
    });

  const existing = await find();
  if (existing) return existing;

  const threadId = await createThread(ctx, components.agent, {
    userId: `telegram:${chatId}`,
    title,
  });
  await ctx.runMutation(internal.conversations.create, {
    channel: CHANNEL,
    externalId: chatId,
    threadId,
    title,
  });

  const created = await find();
  if (!created) throw new Error("conversation missing immediately after create");
  return created;
}

export const handleTurn = internalAction({
  args: {
    chatId: v.string(),
    text: v.string(),
    title: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await loadConversation(ctx, args.chatId, args.title);

    if (args.text.startsWith("/")) {
      await sendMessage(args.chatId, await runCommand(ctx, conversation, args.text));
      return null;
    }

    // The mode is resolved exactly once, here. Everything below is bound by it
    // and nothing downstream can widen it.
    const modeName: ModeName = conversation.mode ?? DEFAULT_MODE;
    const mode = MODES[modeName];

    const runId: Id<"runs"> = await ctx.runMutation(internal.runs.start, {
      conversationId: conversation._id,
      mode: modeName,
      prompt: args.text,
    });

    await sendTyping(args.chatId);

    try {
      const result = await agentFor(modeName).generateText(
        ctx,
        { threadId: conversation.threadId, userId: `telegram:${args.chatId}` },
        { prompt: args.text },
      );

      const toolCalls: string[] = [];
      for (const step of result.steps ?? []) {
        for (const call of step.toolCalls ?? []) {
          if (call?.toolName) toolCalls.push(call.toolName);
        }
      }

      const text =
        result.text?.trim() ||
        (toolCalls.length > 0
          ? "Done."
          : "I came back with nothing. Try asking again.");

      await sendMessage(args.chatId, text);
      await ctx.runMutation(internal.conversations.touch, {
        id: conversation._id,
      });
      await ctx.runMutation(internal.runs.finish, {
        id: runId,
        status: "ok",
        steps: result.steps?.length,
        toolCalls,
        model: mode.model,
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            }
          : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`turn failed (${modeName}): ${message}`);

      await ctx.runMutation(internal.runs.finish, {
        id: runId,
        status: "error",
        model: mode.model,
        error: message.slice(0, 1000),
      });

      // Say what broke. A bot that silently swallows failures is worse than one
      // that admits it, because you keep waiting for a reply that never comes.
      await sendMessage(args.chatId, `That broke: ${message.slice(0, 300)}`);
    }

    return null;
  },
});

/** Replies that bypass the agent entirely, such as the first-run claim prompt. */
export const sendDirect = internalAction({
  args: { chatId: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await sendMessage(args.chatId, args.text);
    return null;
  },
});
