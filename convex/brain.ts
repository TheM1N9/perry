import { createThread, listMessages } from "@convex-dev/agent";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { agentFor } from "./agents";
import { sendMessage, sendTyping } from "./lib/telegram";
import { DEFAULT_MODE, type Mode, type ModeName } from "./modes";
import { vChannel } from "./schema";

/**
 * One turn, end to end: resolve the conversation, resolve the mode, run the
 * agent bound to that mode, deliver the reply.
 *
 * Scheduled rather than called inline, so it sits off the Telegram request path
 * and may take as long as it needs to.
 */

type Channel = "telegram" | "web";

const HELP = `
Your private assistant.

Modes
  /perry    read and remember only. cheap, safe, default
  /agentp   full tools, long leash. say what you want done
Other
  /status   plumbing and recent errors
  /reset    start a fresh conversation, keep memories
  /help     this

Everything else is just talk to me.
`.trim();

/**
 * Where a reply goes depends on where the message came from.
 *
 * The web dashboard needs nothing here: it subscribes to the thread and the
 * assistant message appears as soon as the Agent component stores it. Only
 * Telegram requires an outbound call.
 */
async function deliver(
  ctx: ActionCtx,
  channel: Channel,
  externalId: string,
  text: string,
): Promise<void> {
  if (channel !== "telegram") return;

  const token: string | null = await ctx.runQuery(internal.secrets.get, {
    name: "TELEGRAM_BOT_TOKEN",
  });
  await sendMessage(token, externalId, text);
}

/** Commands never reach the model. They are plumbing, not conversation. */
async function runCommand(
  ctx: ActionCtx,
  conversation: Doc<"conversations">,
  text: string,
): Promise<string> {
  const [raw, ...rest] = text.trim().split(/\s+/);
  const command = raw.toLowerCase().replace(/@.*$/, ""); // strip /cmd@botname

  switch (command) {
    case "/start":
    case "/help":
      return HELP;

    case "/perry":
    case "/agentp":
    case "/mode":
      return "There is one assistant now; mode switching has been retired. Use /help for commands.";

    case "/status": {
      const stats = await ctx.runQuery(internal.conversations.stats, {
        id: conversation._id,
      });
      const memoryCount = await ctx.runQuery(internal.memories.count, {});
      const mode: Mode = await ctx.runQuery(internal.config.resolveMode, {
        mode: conversation.mode,
      });
      const lines = [
        `model     ${mode.model}`,
        `tools     ${mode.tools.join(", ")}`,
        `memories  ${memoryCount}`,
        `runs      ${stats?.recentRuns ?? 0} recent`,
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
  channel: Channel,
  externalId: string,
  title?: string,
): Promise<Doc<"conversations">> {
  const find = () =>
    ctx.runQuery(internal.conversations.getByExternalId, {
      channel,
      externalId,
    });

  const existing = await find();
  if (existing) return existing;
  if (channel === "web" && externalId !== "dashboard") {
    throw new Error("This chat was deleted.");
  }

  const threadId = await createThread(ctx, components.agent, {
    userId: `${channel}:${externalId}`,
    title,
  });
  await ctx.runMutation(internal.conversations.create, {
    channel,
    externalId,
    threadId,
    title,
  });

  const created = await find();
  if (!created) throw new Error("conversation missing immediately after create");
  return created;
}

export const handleTurn = internalAction({
  args: {
    channel: vChannel,
    externalId: v.string(),
    text: v.string(),
    title: v.optional(v.string()),
    attachmentIds: v.optional(v.array(v.id("chatAttachments"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const channel = args.channel as Channel;
    const conversation = await loadConversation(
      ctx,
      channel,
      args.externalId,
      args.title,
    );

    let delegated = false;
    try {

    if (channel === "telegram" && args.text.startsWith("/")) {
      const reply = await runCommand(ctx, conversation, args.text);
      await deliver(ctx, channel, args.externalId, reply);
      return null;
    }

    const attachmentIds = args.attachmentIds ?? [];
    const attachments = attachmentIds.length > 0
      ? await ctx.runQuery(internal.media.forTurn, { conversationId: conversation._id, attachmentIds })
      : [];

    // The assistant configuration is resolved exactly once, here, from stored config layered over
    // the code defaults. Everything below is bound by it and nothing downstream
    // can widen it.
    const modeName: ModeName = conversation.mode ?? DEFAULT_MODE;
    const configured: Mode = await ctx.runQuery(internal.config.resolveMode, {
      mode: modeName,
    });
    // A model picked in the composer applies to its own engine only.
    const mode: Mode = conversation.engine === "gateway" && conversation.model
      ? { ...configured, model: conversation.model }
      : configured;

    const memoryContext: string = await ctx.runAction(internal.memories.context, { query: args.text })
      .catch((error) => { console.error(`Memory context unavailable: ${String(error)}`); return ""; });

    const runId: Id<"runs"> = await ctx.runMutation(internal.runs.start, {
      conversationId: conversation._id,
      mode: modeName,
      prompt: args.text,
    });

    if (channel === "telegram") {
      const token: string | null = await ctx.runQuery(internal.secrets.get, {
        name: "TELEGRAM_BOT_TOKEN",
      });
      await sendTyping(token, args.externalId);
    }

    try {
      const gatewayKey: string | null = await ctx.runQuery(internal.secrets.get, {
        name: "AI_GATEWAY_API_KEY",
      });
      const engine: "codex" | "gateway" = conversation.engine ?? await ctx.runQuery(internal.codex.activeEngine, {});
      if (engine === "codex") {
        let history: string | undefined;
        if (!conversation.codexThreadId) {
          const page = await listMessages(ctx, components.agent, {
            threadId: conversation.threadId,
            excludeToolMessages: true,
            paginationOpts: { cursor: null, numItems: 60 },
          });
          const lines = page.page.reverse()
            .filter((item) => item.message?.role === "user" || item.message?.role === "assistant")
            .map((item) => `${item.message?.role}: ${item.text ?? ""}`);
          history = lines.join("\n\n").slice(-24_000) || undefined;
        }
        const instructions = [
          mode.instructions,
          "This is a private assistant chat. Be direct, thoughtful, and explicit about uncertainty. The runner controls filesystem access.",
          "Images you generate with your image generation tool are delivered to the chat automatically, even when the tool's text output looks empty. Do not retry just because no image data was printed, and never paste image data into your reply.",
          "Your `assistant` MCP tools are the owner's memory (recall, remember, read_memory, forget), their connected accounts (list_connectors, then find_action, then run_action), and task tracking. When a request involves email, calendar, documents or any other account, check list_connectors before saying you cannot do it, and never guess an action name. Ask before consequential external actions such as sending, deleting, publishing or spending.",
          memoryContext,
        ].filter(Boolean).join("\n\n");
        try {
          await ctx.runMutation(internal.codex.enqueueTurn, {
            conversationId: conversation._id,
            runId,
            mode: modeName,
            prompt: args.text,
            history,
            instructions,
            model: conversation.engine === "codex" ? conversation.model : undefined,
            attachments,
          });
          delegated = true;
          return null;
        } catch (error) {
          console.warn(`Codex unavailable, using gateway: ${String(error)}`);
        }
      }
      const attachmentContext = attachments.length
        ? `\n\nAttached files:\n${attachments.map((item) => `- ${item.fileName}: ${item.url}`).join("\n")}`
        : "";
      const result = await agentFor(mode, gatewayKey).generateText(
        ctx,
        {
          threadId: conversation.threadId,
          userId: channel === "web" ? "web:dashboard" : `${channel}:${args.externalId}`,
        },
        { prompt: `${args.text}${attachmentContext}`, instructions: `${mode.instructions}\n\n${memoryContext}` },
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

      await deliver(ctx, channel, args.externalId, text);
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
      // The dashboard reads the run record, so it only needs Telegram told.
      if (channel === "telegram") {
        try {
          const token: string | null = await ctx.runQuery(internal.secrets.get, {
            name: "TELEGRAM_BOT_TOKEN",
          });
          await sendMessage(token, args.externalId, `That broke: ${message.slice(0, 300)}`);
        } catch (sendError) {
          console.error(`could not report failure: ${String(sendError)}`);
        }
      }
    }

    return null;
    } finally {
      if (channel === "web" && !delegated) {
        await ctx.runMutation(internal.conversations.finishWebTurn, { id: conversation._id });
      }
    }
  },
});

/** A failed subscription turn continues through the configured gateway model. */
export const gatewayFallback = internalAction({
  args: { id: v.id("codexTurns") },
  handler: async (ctx, args): Promise<{ status: "ok" | "error"; model: string; error?: string; toolCalls?: string[] }> => {
    const data = await ctx.runQuery(internal.codex.getTurn, args);
    if (!data?.conversation) return { status: "error", model: "codex subscription", error: "Chat was deleted." };
    const { job, conversation } = data;
    const mode: Mode = await ctx.runQuery(internal.config.resolveMode, { mode: job.mode });
    try {
      const memoryContext: string = await ctx.runAction(internal.memories.context, { query: job.prompt })
        .catch((error) => { console.error(`Memory context unavailable: ${String(error)}`); return ""; });
      const gatewayKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "AI_GATEWAY_API_KEY" });
      const result = await agentFor(mode, gatewayKey).generateText(ctx, {
        threadId: conversation.threadId,
        userId: conversation.channel === "web" ? "web:dashboard" : `telegram:${conversation.externalId}`,
      }, { instructions: `${mode.instructions}\n\n${memoryContext}`, prompt: `${job.prompt}${job.attachments?.length ? `\n\nAttached files:\n${job.attachments.map((item) => `- ${item.fileName}: ${item.url}`).join("\n")}` : ""}` });
      const toolCalls = (result.steps ?? []).flatMap((step) => (step.toolCalls ?? []).map((call) => call?.toolName).filter((name): name is string => Boolean(name)));
      await deliver(ctx, conversation.channel, conversation.externalId,
        result.text?.trim() || (toolCalls.length ? "Done." : "I came back with nothing. Try asking again."));
      return { status: "ok", model: mode.model, toolCalls };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deliver(ctx, conversation.channel, conversation.externalId, `Codex and gateway failed: ${message.slice(0, 300)}`)
        .catch((cause) => console.error(`Could not deliver fallback failure: ${String(cause)}`));
      return { status: "error", model: mode.model, error: `Codex: ${job.error ?? "failed"}; gateway: ${message}`.slice(0, 1000) };
    }
  },
});

/** Replies that bypass the agent entirely, such as the first-run claim prompt. */
export const sendDirect = internalAction({
  args: { chatId: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "TELEGRAM_BOT_TOKEN",
    });
    await sendMessage(token, args.chatId, args.text);
    return null;
  },
});
