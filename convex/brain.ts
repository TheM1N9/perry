import { createThread, listMessages } from "./lib/agent";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { INSTRUCTIONS } from "./assistant";
import { ownerClock, ownerNow, QUIET } from "./jobs";
import {
  ACCESS_LABELS, chatModel, currentModel, describeAccess, describeEfforts, describeModels, effortUnused, parseAccessCommand, parseModelCommand,
  parseThinkCommand, pickAccess, pickEffort, pickModel, runLabel, turnEffort, type ModelOption,
} from "./lib/commands";
import { DOWNLOAD_LIMIT, downloadFile, sendMessage, sendTyping } from "./lib/telegram";
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
  /think    list the thinking levels; /think <level> sets this chat's
  /access   supervised or full: whether Codex asks before acting
  /stop     stop the reply I am writing
  /compact  shrink what Codex carries of this chat, keep the chat
  /status   plumbing and recent errors
  /reset    save this chat to memory, then start a fresh one
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
    const { model, reply } = pickModel(models, modelCommand.name, conversation.effort);
    if (model) await ctx.runMutation(internal.conversations.setModel, { id: conversation._id, model: model.id });
    return reply;
  }

  const thinkCommand = parseThinkCommand(text);
  if (thinkCommand) {
    const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
    if (!thinkCommand.level) return describeEfforts(models, conversation.model, conversation.effort);
    const picked = pickEffort(models, conversation.model, thinkCommand.level);
    if (picked.ok) await ctx.runMutation(internal.conversations.setEffort, { id: conversation._id, effort: picked.effort });
    return picked.reply;
  }

  const accessCommand = parseAccessCommand(text);
  if (accessCommand) {
    if (!accessCommand.mode) return describeAccess(conversation.access ?? "supervised");
    const { access, reply } = pickAccess(accessCommand.mode);
    if (access) await ctx.runMutation(internal.conversations.setAccess, { id: conversation._id, access });
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
      const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
      const model = chatModel(models, conversation.model);
      const effort = turnEffort(models, conversation.model, conversation.effort);
      const unused = model && effortUnused(model, conversation.effort) ? ` (${conversation.effort} is not one ${model.name} takes)` : "";
      const lines = [
        `model     ${conversation.model && model?.id === conversation.model ? `codex/${conversation.model}` : `codex default${model ? ` (${model.id})` : ""}`}`,
        `thinking  ${conversation.effort && !unused ? conversation.effort : `default${effort ? ` (${effort})` : ""}${unused}`}`,
        `access    ${ACCESS_LABELS[conversation.access ?? "supervised"]}`,
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

    case "/compact": {
      // finalizeTurn says when it is done. An offline runner is said, not thrown.
      try {
        const compacting = await ctx.runMutation(internal.codex.requestCompact, { conversationId: conversation._id });
        return compacting ? "Compacting this chat…" : "Nothing to compact yet.";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    case "/reset":
      return await reset(ctx, conversation);

    default:
      return `Don't know ${command}. /help lists what I do know.`;
  }
}

/**
 * What Codex gets besides the prompt: the instructions with the memory guide
 * and owner profile, the memory recalled as data for this turn, and, for a
 * fresh Codex thread that has not seen this chat, its recent history.
 */
async function prepareTurn(ctx: ActionCtx, conversation: Doc<"conversations">, query: string) {
  const fresh = !conversation.codexThreadId;
  const memory: { instructions: string; recalled: string; digest: string } | null = await ctx.runAction(internal.memories.context, {
    query,
    seen: fresh ? undefined : conversation.recallDigest,
  }).catch((error) => { console.error(`Memory context unavailable: ${String(error)}`); return null; });
  let history: string | undefined;
  if (fresh) {
    const page = await listMessages(ctx, {
      threadId: conversation.threadId,
      excludeToolMessages: true,
      paginationOpts: { cursor: null, numItems: 60 },
    });
    const lines = page.page.reverse()
      .filter((item) => item.message?.role === "user" || item.message?.role === "assistant")
      .map((item) => `${item.message?.role}: ${item.text ?? ""}`);
    history = lines.join("\n\n").slice(-24_000) || undefined;
  }
  // Codex knows the date but not the time, and "remind me in an hour" needs both.
  const now = `It is now ${ownerNow(await ctx.runQuery(internal.jobs.ownerTimezone, {}))}.`;
  // Who the assistant is opens the instructions; who the owner is (USER.md, whole) closes them.
  const persona: { identity: string; user: string } = await ctx.runQuery(internal.persona.forPrompt, {});
  // Which channel this is, where the reply goes, and where what it sets up will report (channels.ts).
  const where: string = await ctx.runQuery(internal.channels.describe, { conversationId: conversation._id });
  return {
    instructions: [persona.identity, INSTRUCTIONS, now, where, memory?.instructions, persona.user].filter(Boolean).join("\n\n"),
    recalled: memory?.recalled || undefined,
    recallDigest: memory?.digest,
    history,
  };
}

/**
 * How the chat's turns run: its model, the thinking level that model takes
 * (a level it does not take falls back to its default), and its access.
 *
 * The model is always named. Left out, Codex falls back to the `model` in
 * ~/.codex/config.toml, which the Codex app may have set to one this account
 * cannot use; the account's own default is the one model/list marks.
 */
async function turnSettings(ctx: ActionCtx, conversation: Doc<"conversations">, jobModel?: string) {
  const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
  const model = currentModel(models, jobModel ?? conversation.model);
  return {
    model,
    effort: turnEffort(models, model, conversation.effort),
    access: conversation.access ?? "supervised" as const,
  };
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/harness/compaction-prompt.ts
const FLUSH = [
  "This is a memory checkpoint before the owner resets this chat, not a message from the owner. Afterwards this conversation is gone from the chat.",
  "Write a handoff for a future you who will not see it, with remember kind=daily, one self-contained note per item:",
  "- key decisions made and work completed, stated as done so it is not repeated;",
  "- important context, constraints and owner preferences;",
  "- what remains to be done, with clear next steps;",
  "- critical data needed to continue: exact names, dates, numbers, paths and identifiers.",
  "Skip what today's notes already say, anything trivial, and secrets. A standing preference or durable fact can go to kind=profile or kind=core instead, superseding what it replaces.",
  `Do not continue the conversation, answer its questions, or invent facts. Do not message the owner: reply with exactly ${QUIET} when done.`,
].join("\n");

/**
 * /reset, like OpenClaw's memory flush before compaction: a quiet Codex turn
 * in this chat first writes what is worth keeping to today's notes, and when
 * it finishes the chat starts afresh (codex.finalizeTurn). With no runner to
 * write it, the chat is reset at once and says the summary was skipped.
 */
async function reset(ctx: ActionCtx, conversation: Doc<"conversations">): Promise<string> {
  await ctx.runMutation(internal.conversations.beginReset, { id: conversation._id });
  const runId: Id<"runs"> = await ctx.runMutation(internal.runs.start, { conversationId: conversation._id, prompt: "/reset" });
  const settings = await turnSettings(ctx, conversation);
  let delegated = false;
  try {
    await ctx.runMutation(internal.codex.enqueueTurn, {
      conversationId: conversation._id,
      runId,
      prompt: FLUSH,
      ...await prepareTurn(ctx, conversation, ""),
      ...settings,
      flush: true,
    });
    delegated = true;
    return "Saving what is worth keeping from this chat to memory, then starting fresh.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.runs.finish, { id: runId, status: "error", model: runLabel(settings.model, settings.effort, settings.access), error: message.slice(0, 1000) });
    const threadId = await createThread(ctx, { userId: userIdOf(conversation), title: conversation.title });
    await ctx.runMutation(internal.conversations.clearThread, { id: conversation._id, threadId });
    return `Fresh start, but this chat was not summarised into memory first: ${message}`;
  } finally {
    if (conversation.channel === "web" && !delegated) {
      await ctx.runMutation(internal.conversations.finishWebTurn, { id: conversation._id });
    }
  }
}

/** The web chat's /reset. */
export const resetChat = internalAction({
  args: { id: v.id("conversations") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const conversation = await ctx.runQuery(internal.conversations.getWebById, { id: args.id });
    if (!conversation) throw new Error("This chat was deleted.");
    return await reset(ctx, conversation);
  },
});

/** Whose messages a chat's agent thread holds. */
const userIdOf = (conversation: Doc<"conversations">) =>
  conversation.channel === "web" ? "web:dashboard" : `telegram:${conversation.externalId}`;

/**
 * Find the conversation for this chat, creating it and its agent thread on
 * first contact.
 */
export async function loadConversation(
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

  const threadId = await createThread(ctx, {
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
    /** Not the owner's words (the greeting after the welcome page): only the reply is saved to the chat. */
    hidden: v.optional(v.boolean()),
    /** What the run is listed as in Activity, when the prompt itself is not the owner's. */
    label: v.optional(v.string()),
    /** A scheduled job's model, which its runs use whatever its chat has picked. */
    model: v.optional(v.string()),
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
        const tooBig: string[] = [];
        for (const item of args.telegramMedia) {
          // A bot can download only 20 MB; asking for more fails after the wait.
          if ((item.size ?? 0) > DOWNLOAD_LIMIT) {
            tooBig.push(item.fileName);
            prompt = `${prompt}\n\n(${item.fileName} was too big to download from Telegram.)`.trim();
            continue;
          }
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
        if (tooBig.length) {
          await sendMessage(telegramToken, args.externalId,
            `${tooBig.join(", ")} ${tooBig.length === 1 ? "is" : "are"} too big for me: Telegram lets bots download files up to 20 MB. ` +
            "Send a smaller file, or put it somewhere I can reach, like a link.");
          // Nothing else came with it, so there is nothing to answer.
          if (!args.text && !attachmentIds.length) return null;
        }
      }

      const attachments = attachmentIds.length > 0
        ? await ctx.runQuery(internal.media.forTurn, { conversationId: conversation._id, attachmentIds })
        : [];
      const settings = await turnSettings(ctx, conversation, args.model);
      const runId: Id<"runs"> = await ctx.runMutation(internal.runs.start, {
        conversationId: conversation._id,
        prompt: args.label ?? args.text,
      });
      if (telegramToken) await sendTyping(telegramToken, args.externalId);

      const turn = await prepareTurn(ctx, conversation, args.hidden ? "" : args.text);
      // What the assistant sent here on its own since the owner last wrote: their message may answer it.
      const sent = conversation.unprompted ?? [];
      if (sent.length) {
        const timezone: string = await ctx.runQuery(internal.jobs.ownerTimezone, {});
        const block = "# Sent by you since their last message\n\nYou messaged the owner here on your own; what they write now may answer it.\n" +
          sent.map((message) => `- [${ownerClock(timezone, message.at)}] ${message.text}`).join("\n");
        turn.recalled = [block, turn.recalled].filter(Boolean).join("\n\n");
      }

      try {
        await ctx.runMutation(internal.codex.enqueueTurn, {
          conversationId: conversation._id,
          runId,
          prompt,
          ...turn,
          ...settings,
          attachments,
          ...(args.hidden ? { hidden: true } : {}),
          // The owner's message joins a reply that is running; a job's prompt waits its turn.
          policy: conversation.jobId ? "queue" : "steer",
        });
        delegated = true;
        if (sent.length) await ctx.runMutation(internal.conversations.clearUnprompted, { id: conversation._id, through: sent[sent.length - 1].at });
      } catch (error) {
        // Usually no runner is online. Say so: a silent failure is worse than
        // an admitted one, because you keep waiting for a reply that never comes.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`turn failed: ${message}`);
        await ctx.runMutation(internal.runs.finish, { id: runId, status: "error", model: runLabel(settings.model, settings.effort, settings.access), error: message.slice(0, 1000) });
        if (conversation.jobId) await ctx.runMutation(internal.jobs.finished, { id: conversation.jobId, error: message });
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
