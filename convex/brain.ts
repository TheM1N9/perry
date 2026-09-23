import { createThread, listMessages } from "@convex-dev/agent";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { INSTRUCTIONS } from "./assistant";
import { describeModels, parseModelCommand, pickModel, type ModelOption } from "./lib/commands";
import { downloadFile, sendMessage, sendTyping } from "./lib/telegram";
import { vChannel, vTelegramMedia } from "./schema";

/**
 * One turn, end to end: resolve the conversation, gather what the assistant
 * should know, and hand the turn to Codex on the owner's runner. The reply
 * comes back through codex.finishTurn.
 *
 * Scheduled rather than called inline, so it sits off the Telegram request path
 * and may take as long as it needs to.
 */

type Channel = "telegram" | "web";

const HELP = `
Your private assistant.

  /model    list the Codex models; /model <name> switches this chat
  /stop     stop the reply I am writing
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
  const [raw] = text.trim().split(/\s+/);
  const command = raw.toLowerCase().replace(/@.*$/, ""); // strip /cmd@botname

  const modelCommand = parseModelCommand(text);
  if (modelCommand) {
    const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
    if (!modelCommand.name) return describeModels(models, conversation.model);
    const { model, reply } = pickModel(models, modelCommand.name);
    if (model) await ctx.runMutation(internal.conversations.setModel, { id: conversation._id, model: model.id });
    return reply;
  }

  switch (command) {
    case "/start":
    case "/help":
      return HELP;

    case "/status": {
      const stats = await ctx.runQuery(internal.conversations.stats, {
        id: conversation._id,
      });
      const memoryCount = await ctx.runQuery(internal.memories.count, {});
      const lines = [
        `model     ${conversation.model ? `codex/${conversation.model}` : "codex default"}`,
        `memories  ${memoryCount}`,
        `runs      ${stats?.recentRuns ?? 0} recent`,
      ];
      if (stats?.lastError) lines.push("", `last error: ${stats.lastError}`);
      return lines.join("\n");
    }

    case "/stop": {
      const stopped: number = await ctx.runMutation(internal.codex.requestStop, { conversationId: conversation._id });
      return stopped ? "Stopping." : "Nothing is running.";
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
    /** Files sent on Telegram, downloaded here before the turn. */
    telegramMedia: v.optional(v.array(vTelegramMedia)),
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
    const telegramToken = channel === "telegram"
      ? await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" })
      : null;

    let delegated = false;
    try {
      if (channel === "telegram" && args.text.startsWith("/") && !args.telegramMedia?.length) {
        const reply = await runCommand(ctx, conversation, args.text);
        await sendMessage(telegramToken, args.externalId, reply);
        return null;
      }

      // Telegram files live on Telegram's servers; bring them into storage so
      // they show in the chat and reach Codex like any attachment.
      let prompt = args.text;
      const attachmentIds = [...(args.attachmentIds ?? [])];
      if (args.telegramMedia?.length) {
        const messageKey = crypto.randomUUID();
        for (const item of args.telegramMedia) {
          try {
            const bytes = await downloadFile(telegramToken, item.fileId);
            const storageId = await ctx.storage.store(new Blob([bytes], { type: item.contentType }));
            attachmentIds.push(await ctx.runMutation(internal.media.attachStored, {
              conversationId: conversation._id, messageKey, storageId, fileName: item.fileName, contentType: item.contentType, size: bytes.byteLength,
            }));
          } catch (error) {
            console.error(`Could not fetch a Telegram file: ${String(error)}`);
            prompt = `${prompt}\n\n(${item.fileName} could not be downloaded from Telegram.)`.trim();
          }
        }
        if (attachmentIds.length) prompt = `${prompt}\n\n<!-- attachments: ${messageKey} -->`.trim();
      }

      const attachments = attachmentIds.length > 0
        ? await ctx.runQuery(internal.media.forTurn, { conversationId: conversation._id, attachmentIds })
        : [];
      const memoryContext: string = await ctx.runAction(internal.memories.context, { query: args.text })
        .catch((error) => { console.error(`Memory context unavailable: ${String(error)}`); return ""; });
      const model = conversation.model ? `codex/${conversation.model}` : "codex subscription";
      const runId: Id<"runs"> = await ctx.runMutation(internal.runs.start, {
        conversationId: conversation._id,
        prompt: args.text,
      });
      if (telegramToken) await sendTyping(telegramToken, args.externalId);

      try {
        // A fresh Codex thread has not seen this chat, so it gets the recent history once.
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
        await ctx.runMutation(internal.codex.enqueueTurn, {
          conversationId: conversation._id,
          runId,
          prompt,
          history,
          instructions: [INSTRUCTIONS, memoryContext].filter(Boolean).join("\n\n"),
          model: conversation.model,
          attachments,
        });
        delegated = true;
      } catch (error) {
        // Usually no runner is online. Say so: a silent failure is worse than
        // an admitted one, because you keep waiting for a reply that never comes.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`turn failed: ${message}`);
        await ctx.runMutation(internal.runs.finish, { id: runId, status: "error", model, error: message.slice(0, 1000) });
        if (telegramToken) {
          await sendMessage(telegramToken, args.externalId, `That broke: ${message.slice(0, 300)}`)
            .catch((sendError) => console.error(`could not report failure: ${String(sendError)}`));
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
