import { createThread, historyOf, saveMessages } from "./lib/agent";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { INSTRUCTIONS } from "./assistant";
import { ownerClock, ownerNow, QUIET } from "./jobs";
import {
  ACCESS_LABELS, chatModel, currentModel, describeAccess, describeEfforts, describeMissed, describeModels, effortUnused, parseAccessCommand,
  parseMissedCommand, parseModelCommand, parseThinkCommand, PAUSED_ERROR, PAUSED_OWNER, PAUSED_REPLY, pickAccess, pickEffort, pickModel, runLabel,
  turnEffort, type MissedRun, type ModelOption,
} from "./lib/commands";
import { ENGINE_LABELS, type EngineKind } from "./lib/engines";
import type { Choice } from "./lib/routing";
import { DOWNLOAD_LIMIT, downloadFile, sendMessage, sendTyping } from "./lib/telegram";
import { resumeOf } from "./engines";
import { sha256 } from "./memories";
import { LEFT_PROJECT } from "./projects";
import { routeOf, type Route } from "./routing";
import { vChannel, vEngine, vRoute, vTelegramMedia } from "./schema";

/** Perry's own reminder, sent with each message from the owner, ahead of it. */
const REMEMBER_NOTE = "# Your own reminder\n\nNot from the owner. If their message below tells you anything about their life (a person and who they are, a date or birthday, a plan, something they have to do, their health or routine, their work and the projects, pages or channels they run, what they made or how something went), save it with remember in this reply, even when they only ask a question about it, naming in about anyone else it is about. Then answer.";

/**
 * One turn, end to end: resolve the conversation, gather what the assistant
 * should know, and hand the turn to the chat's engine on the owner's runner.
 * The reply comes back through codex.finishTurn.
 *
 * Scheduled rather than called inline, so it sits off the Telegram request path
 * and may take as long as it needs to.
 */

type Channel = "telegram" | "web" | "whatsapp";

const HELP = `
Your private assistant.

  /model    list the models; /model <name> switches this chat
  /think    list the thinking levels; /think <level> sets this chat's
  /access   ask, auto or full: whether it asks before acting
  /stop     stop the reply I am writing
  /pause    stop everything I am doing, and start nothing new
  /resume   start again; /run and /skip settle what was missed
  /compact  shrink what I carry of this chat, keep the chat
  /note     /note <words> adds them to your Inbox note; /note alone saves my last reply as a note
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

  // The chat's own engine, else the default it follows; none while the owner has not chosen one.
  const engine = conversation.engine ?? (await ctx.runQuery(internal.installation.getDefaultEngine, {})) ?? undefined;
  const modelCommand = parseModelCommand(text);
  if (modelCommand) {
    const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
    if (!modelCommand.name) return describeModels(models, conversation.model, engine);
    const { model, reply } = pickModel(models, modelCommand.name, conversation.effort, engine);
    if (model) await ctx.runMutation(internal.conversations.setModel, { id: conversation._id, model: model.id, engine: model.engine });
    return reply;
  }

  const thinkCommand = parseThinkCommand(text);
  if (thinkCommand) {
    const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
    if (!thinkCommand.level) return describeEfforts(models, conversation.model, conversation.effort, engine);
    const picked = pickEffort(models, conversation.model, thinkCommand.level, engine);
    if (picked.ok) await ctx.runMutation(internal.conversations.setEffort, { id: conversation._id, effort: picked.effort });
    return picked.reply;
  }

  const missedCommand = parseMissedCommand(text);
  if (missedCommand) return await settleMissed(ctx, missedCommand);

  const accessCommand = parseAccessCommand(text);
  if (accessCommand) {
    if (!accessCommand.mode) return describeAccess(conversation.access ?? "supervised");
    const { access, reply } = pickAccess(accessCommand.mode);
    if (access) await ctx.runMutation(internal.conversations.setAccess, { id: conversation._id, access });
    return reply;
  }

  // Paused, nothing that starts a turn goes ahead (pause.ts): /reset would start the chat afresh without saving it.
  const paused = await ctx.runQuery(internal.pause.state, {});
  if (paused && (command === "/compact" || command === "/reset")) return PAUSED_OWNER;

  switch (command) {
    case "/start":
    case "/help":
      return HELP;

    case "/pause": {
      const done: { changed: boolean; stopped: number } = await ctx.runMutation(internal.pause.pauseFrom, { by: conversation.channel === "whatsapp" ? "whatsapp" : "telegram" });
      if (!done.changed) return PAUSED_OWNER;
      return `Paused. ${done.stopped ? "I stopped what I was doing, and nothing" : "Nothing"} runs until you send /resume. Approvals waiting on you stay.`;
    }

    case "/resume": {
      const done: { changed: boolean; missed: MissedRun[] } = await ctx.runMutation(internal.pause.resumeFrom, {});
      const head = done.changed ? "Back on." : "I'm not paused.";
      return done.missed.length ? `${head}\n\n${describeMissed(done.missed)}` : head;
    }

    case "/missed":
      return describeMissed(await ctx.runQuery(internal.pause.missed, {}));

    case "/status": {
      const stats = await ctx.runQuery(internal.conversations.stats, {
        id: conversation._id,
      });
      const memoryCount = await ctx.runQuery(internal.memories.count, {});
      const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
      const model = chatModel(models, conversation.model, engine);
      const effort = turnEffort(models, conversation.model, conversation.effort, engine);
      const unused = model && effortUnused(model, conversation.effort) ? ` (${conversation.effort} is not one ${model.name} takes)` : "";
      const lines = [
        ...(paused ? ["paused    yes: /resume starts me again"] : []),
        `model     ${!engine ? "none: Perry has no default engine yet" : conversation.model && model?.id === conversation.model ? `${engine}/${conversation.model}` : `${engine} default${model ? ` (${model.id})` : ""}`}`,
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
        // What matters goes to memory first: compaction summarises the rest away.
        await checkpoint(ctx, conversation);
        const compacting = await ctx.runMutation(internal.codex.requestCompact, { conversationId: conversation._id });
        return compacting ? "Compacting this chat…" : "Nothing to compact yet.";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    case "/reset":
      return await reset(ctx, conversation);

    // Noting something down from the phone without a turn: instant, and no engine needed (notes.ts).
    case "/note": {
      const words = text.trim().replace(/^\S+\s*/, "");
      if (words) {
        const noted: { title: string } = await ctx.runMutation(internal.notes.jotFromPhone, { text: words });
        return `Added to your ${noted.title} note.`;
      }
      const saved: { title: string } | null = await ctx.runMutation(internal.notes.lastReplyFromPhone, { conversationId: conversation._id });
      return saved ? `Saved my last reply as the note “${saved.title}”.` : "There's no reply of mine here to save. /note <words> adds them to your Inbox note.";
    }

    default:
      return `Don't know ${command}. /help lists what I do know.`;
  }
}

/** /run <n>, /run all, /skip, /skip <n>: the schedules missed while paused, numbered as describeMissed lists them. */
async function settleMissed(ctx: ActionCtx, command: { action: "run" | "skip"; which?: "all" | number }): Promise<string> {
  const missed: MissedRun<Id<"jobs">>[] = await ctx.runQuery(internal.pause.missed, {});
  if (!missed.length) return "Nothing was missed.";
  const which = command.which ?? (command.action === "skip" ? "all" : undefined);
  if (which === undefined) return describeMissed(missed);
  const picked = which === "all" ? missed : missed[which - 1] ? [missed[which - 1]] : [];
  if (!picked.length) return `There is no ${which} on the list.\n\n${describeMissed(missed)}`;
  if (command.action === "skip") {
    const skipped: number = which === "all"
      ? await ctx.runMutation(internal.pause.skipMissedFrom, {})
      : await ctx.runMutation(internal.pause.skipMissedFrom, { id: picked[0].id });
    return skipped === 1 ? `Let ${picked[0].name} go.` : `Let ${skipped} go.`;
  }
  if (await ctx.runQuery(internal.pause.state, {})) return PAUSED_OWNER;
  const ran: number = await ctx.runMutation(internal.pause.runMissedFrom, { ids: picked.map((item) => item.id) });
  return ran === 1 ? `Running ${picked[0].name} now.` : `Running ${ran} now.`;
}

/**
 * What the engine gets besides the prompt: the instructions with the memory
 * guide and owner profile, the memory recalled as data for this turn, and, for
 * a fresh engine session that has not seen this chat, its recent history.
 *
 * What changes from turn to turn (the time, the active goals) goes with the
 * message, not in the instructions: a Codex thread keeps the instructions it
 * started with while its app-server has it loaded, and a new chat's
 * instructions are then the same as the last one's, so the runner can have its
 * thread started before the owner sends (runner/engines/codex.ts).
 */
async function prepareTurn(ctx: ActionCtx, conversation: Doc<"conversations">, query: string, engine: EngineKind | undefined) {
  const fresh = !resumeOf(conversation, engine);
  const memory: { instructions: string; recalled: string; digest: string } | null = await ctx.runAction(internal.memories.context, {
    query,
    chat: conversation._id,
    seen: fresh ? undefined : conversation.recallDigest,
  }).catch((error) => { console.error(`Memory context unavailable: ${String(error)}`); return null; });
  const history = fresh ? await historyOf(ctx, conversation) : undefined;
  // Codex knows the date but not the time, and "remind me in an hour" needs both.
  const now = `It is now ${ownerNow(await ctx.runQuery(internal.jobs.ownerTimezone, {}))}.`;
  // Who the assistant is opens the instructions; who the owner is (USER.md, whole) closes them.
  const persona: { identity: string; user: string } = await ctx.runQuery(internal.persona.forPrompt, {});
  // Which channel this is, where the reply goes, and where what it sets up will report (channels.ts).
  const where: string = await ctx.runQuery(internal.channels.describe, { conversationId: conversation._id });
  // The project's instructions and its other chats go with the message, like memory, and again whenever they
  // change: the session keeps the instructions it started with, and an edit must reach a chat already going.
  const project: string | null = await ctx.runQuery(internal.projects.forTurn, { conversationId: conversation._id });
  const projectDigest = project ? await sha256(project) : undefined;
  const told = fresh ? undefined : conversation.projectDigest;
  const aboutProject = projectDigest === told ? "" : project ?? LEFT_PROJECT;
  // A goal is slow, so "I ran my first 10k" often comes in a chat that never mentioned it: the active ones come with every turn.
  const active = (await ctx.runQuery(internal.work.listGoals, {})).filter((goal) => goal.status === "active").slice(0, 10);
  const goals = active.length
    ? `The owner's active goals; when they reach a milestone, tick it off with update_goal:\n${active.map((goal) => `- ${goal.title} (id ${goal._id}): ${goal.milestones.map((step) => `[${step.done ? "x" : " "}] ${step.title}`).join(", ")}`).join("\n")}`
    : "";
  // Told once at the start, an agent answers the question and lets the fact in it go ("I started swimming;
  // any tips?"), so every message from the owner comes with the reminder.
  const note = conversation.jobId || conversation.taskId ? "" : REMEMBER_NOTE;
  return {
    // About me comes with the memory guide (pages.standing); USER.md by itself only when memory could not be had.
    instructions: [persona.identity, INSTRUCTIONS, where, memory?.instructions ?? persona.user].filter(Boolean).join("\n\n"),
    recalled: [`# Right now\n\n${now}`, goals, aboutProject, memory?.recalled, note].filter(Boolean).join("\n\n"),
    recallDigest: memory?.digest,
    projectDigest,
    history,
  };
}

/**
 * A turn in a chat with someone else: routed only among the engines its
 * computer can lock down for it, so it has no shell, files or computer
 * (routing.chooseGuest); asking about nothing. With none that can take it,
 * there is no turn: the run says why, and so does the owner's phone, once.
 */
async function guestRoute(ctx: ActionCtx, conversation: Doc<"conversations">): Promise<Route | { none: string }> {
  const chosen: Choice | { none: string } | null = await ctx.runQuery(internal.routing.forGuest, { id: conversation._id });
  if (!chosen) return { none: "This chat is not with someone else." };
  if ("none" in chosen) return chosen;
  await ctx.runMutation(internal.routing.guestOn, { id: conversation._id, engine: chosen.engine });
  return routeOf(chosen);
}

/**
 * All a chat with someone else is given (contacts.guestPrompt): who Perry is,
 * who it is talking with, the rules, and what the owner lets it share with
 * them; what it remembers from this chat, and a group's lead-up. Nothing of
 * the owner's memory, USER.md, goals or other chats.
 */
async function guestTurn(ctx: ActionCtx, conversation: Doc<"conversations">, contactId: Id<"contacts">, engine: EngineKind | undefined, context?: string) {
  const prompt: { instructions: string; brief: string; memory: string; now: string; reminder: string } = await ctx.runQuery(internal.contacts.guestPrompt, { contactId, conversationId: conversation._id });
  return {
    instructions: prompt.instructions,
    recalled: [`# Right now\n\n${prompt.now}`, prompt.brief, prompt.memory, context, prompt.reminder].filter(Boolean).join("\n\n"),
    recallDigest: undefined,
    history: resumeOf(conversation, engine) ? undefined : await historyOf(ctx, conversation),
  };
}

/**
 * How the chat's turns run: its engine and model, the thinking level that
 * model takes (a level it does not take falls back to its default), and its
 * access. A scheduled job's model, with its engine, wins over the chat's; a
 * chat without an engine of its own (a phone, schedule or task chat, or a new
 * one) is on the owner's default. With neither, the engine is unset and the
 * turn is refused, asking the owner to choose (codex.enqueueTurn): Perry
 * never picks one for them.
 *
 * The model is always named. Left out, Codex falls back to the `model` in
 * ~/.codex/config.toml, which the Codex app may have set to one this account
 * cannot use; the account's own default is the one model/list marks.
 */
async function turnSettings(ctx: ActionCtx, conversation: Doc<"conversations">, job?: { model?: string; engine?: EngineKind }) {
  const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
  const engine = job?.model && job.engine ? job.engine
    : conversation.engine ?? (await ctx.runQuery(internal.installation.getDefaultEngine, {})) ?? undefined;
  const model = currentModel(models, job?.model ?? conversation.model, engine);
  return {
    engine,
    model,
    effort: turnEffort(models, model, conversation.effort, engine),
    access: conversation.access ?? "supervised" as const,
  };
}

/**
 * A job whose model is on another engine than its chat moves the chat there,
 * which starts afresh with the chat so far; the chat as it is then. Without a
 * model of the job's own, a chat that follows the default stays unset.
 */
async function onEngine(ctx: ActionCtx, conversation: Doc<"conversations">, settings: { engine?: EngineKind; model?: string }, jobModel: boolean): Promise<Doc<"conversations">> {
  if (!jobModel || !settings.engine || conversation.engine === settings.engine) return conversation;
  await ctx.runMutation(internal.conversations.setModel, { id: conversation._id, model: settings.model, engine: settings.engine });
  return (await ctx.runQuery(internal.conversations.getById, { id: conversation._id })) ?? conversation;
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
      ...await prepareTurn(ctx, conversation, "", settings.engine),
      ...settings,
      flush: true,
    });
    delegated = true;
    return "Saving what is worth keeping from this chat to memory, then starting fresh.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.runs.finish, { id: runId, status: "error", model: runLabel(settings.model, settings.effort, settings.access, settings.engine), error: message.slice(0, 1000) });
    const threadId = await createThread(ctx, { userId: userIdOf(conversation), title: conversation.title });
    await ctx.runMutation(internal.conversations.clearThread, { id: conversation._id, threadId });
    return `Fresh start, but this chat was not summarised into memory first: ${message}`;
  } finally {
    if (conversation.channel === "web" && !delegated) {
      await ctx.runMutation(internal.conversations.finishWebTurn, { id: conversation._id });
    }
  }
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/harness/compaction-prompt.ts
const CHECKPOINT = [
  "This is a memory checkpoint, not a message from the owner. The earlier part of this conversation is about to be summarised to make room, and the chat goes on afterwards.",
  "Save what a future you would need that is not saved yet, with remember kind=daily, one self-contained note per item:",
  "- decisions made and work completed, stated as done so it is not repeated;",
  "- important context, constraints and owner preferences;",
  "- what remains to be done, with clear next steps;",
  "- critical data needed to continue: exact names, dates, numbers, paths and identifiers.",
  "Skip what memory already holds, anything trivial, and secrets. A standing preference or durable fact can go to kind=profile or kind=core instead, superseding what it replaces.",
  `Do not continue the conversation, answer its questions, or invent facts. Do not message the owner: reply with exactly ${QUIET} when done.`,
].join("\n");

/** Fuller than this, the chat's Codex thread is near the point where Codex compacts it by itself. PERRY_CHECKPOINT_AT changes it. */
const CHECKPOINT_AT = Number(process.env.PERRY_CHECKPOINT_AT) || 0.75;

/**
 * A memory checkpoint, like OpenClaw's flush before compaction: a quiet turn
 * in this chat saves what is worth keeping, and leaves nothing in the chat
 * (codex.finalizeTurn). Run before /compact, and before Codex compacts a long
 * thread by itself (checkpointIfFull). Queued, so it waits for a reply that is
 * running. False when there is nothing to save yet, or no runner.
 */
async function checkpoint(ctx: ActionCtx, conversation: Doc<"conversations">): Promise<boolean> {
  const settings = await turnSettings(ctx, conversation);
  // Nothing to save before the chat's engine has a session of it.
  if (!resumeOf(conversation, settings.engine)) return false;
  const runId: Id<"runs"> = await ctx.runMutation(internal.runs.start, { conversationId: conversation._id, prompt: "Memory checkpoint" });
  try {
    await ctx.runMutation(internal.codex.enqueueTurn, {
      conversationId: conversation._id,
      runId,
      prompt: CHECKPOINT,
      ...await prepareTurn(ctx, conversation, "", settings.engine),
      ...settings,
      checkpoint: true,
      policy: "queue",
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.runs.finish, { id: runId, status: "error", model: runLabel(settings.model, settings.effort, settings.access, settings.engine), error: message.slice(0, 1000) });
    return false;
  }
}

/** After a reply: a thread this full gets one checkpoint before Codex compacts it (cleared when it does). */
export const checkpointIfFull = internalAction({
  args: { id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.runQuery(internal.conversations.getById, { id: args.id });
    // A chat with someone else keeps no memory of the owner's kind to write down (contacts.ts).
    if (!conversation || conversation.jobId || conversation.contactId || conversation.checkpointedAt || (conversation.contextFill ?? 0) < CHECKPOINT_AT) return null;
    // Paused, no turn starts (pause.ts); the chat is checkpointed after the next reply instead.
    if (await ctx.runQuery(internal.pause.state, {})) return null;
    await ctx.runMutation(internal.conversations.markCheckpointed, { id: conversation._id });
    await checkpoint(ctx, conversation);
    return null;
  },
});

/** The web chat's /compact: a checkpoint, then the compaction. The compaction's turn, or null with nothing to compact. */
export const compactChat = internalAction({
  args: { id: v.id("conversations") },
  returns: v.union(v.null(), v.id("codexTurns")),
  handler: async (ctx, args): Promise<Id<"codexTurns"> | null> => {
    const conversation = await ctx.runQuery(internal.conversations.getById, { id: args.id });
    if (!conversation) throw new Error("This chat was deleted.");
    await checkpoint(ctx, conversation);
    return await ctx.runMutation(internal.codex.requestCompact, { conversationId: args.id });
  },
});

/** The web chat's /reset. */
export const resetChat = internalAction({
  args: { id: v.id("conversations") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const conversation = await ctx.runQuery(internal.conversations.getById, { id: args.id });
    if (!conversation) throw new Error("This chat was deleted.");
    return await reset(ctx, conversation);
  },
});

/** Whose messages a chat's agent thread holds. */
const userIdOf = (conversation: Doc<"conversations">) =>
  conversation.channel === "web" ? "web:dashboard" : `${conversation.channel}:${conversation.externalId}`;

/**
 * Find the conversation for this chat, creating it and its agent thread on
 * first contact.
 */
export async function loadConversation(
  ctx: ActionCtx,
  channel: Channel,
  externalId: string,
  title?: string,
  /** A chat with someone other than the owner (contacts.ts). */
  contactId?: Id<"contacts">,
): Promise<Doc<"conversations">> {
  const find = () =>
    ctx.runQuery(internal.conversations.getByExternalId, {
      channel,
      externalId,
    });

  const existing = await find();
  if (existing && (!contactId || existing.contactId === contactId)) return existing;
  // Someone else's chat is never one the owner already has; an old row for it is marked theirs.
  if (existing) {
    await ctx.runMutation(internal.conversations.create, { channel, externalId, threadId: existing.threadId, contactId });
    return (await find())!;
  }
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
    ...(contactId ? { contactId } : {}),
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
    /** Files that came with a WhatsApp message, already stored (whatsapp.receive). */
    storedMedia: v.optional(v.array(v.object({ storageId: v.id("_storage"), fileName: v.string(), contentType: v.string(), size: v.number() }))),
    /** Not the owner's words (the greeting after the welcome page): only the reply is saved to the chat. */
    hidden: v.optional(v.boolean()),
    /** What the run is listed as in Activity, when the prompt itself is not the owner's. */
    label: v.optional(v.string()),
    /** A scheduled job's model, which its runs use whatever its chat has picked. */
    model: v.optional(v.string()),
    /** The engine the job's model is one of. */
    engine: v.optional(vEngine),
    /** Where a job's or task's turn runs, on what and why, as routing chose it (lib/routing.ts); it wins over model and engine. */
    route: v.optional(vRoute),
    /** Written in the web app in the owner's Telegram or WhatsApp chat: the web app shows it as its own, and the phone hears of it. */
    fromWeb: v.optional(v.boolean()),
    /** From someone other than the owner (contacts.ts), already allowed: a sealed turn in their chat. */
    guest: v.optional(v.id("contacts")),
    /** What led up to it in a group, sent with the message. */
    guestContext: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const channel = args.channel as Channel;
    // What the web app keeps track of while it waits: its own chats, and what it sent into a messaging app's.
    const web = channel === "web" || args.fromWeb === true;
    let conversation = await loadConversation(
      ctx,
      channel,
      args.externalId,
      args.title,
      args.guest,
    );
    const guest = args.guest ?? conversation.contactId;
    // Someone else's chat takes only their messages, as contacts.ts passes them on: never the owner's commands or web app.
    if (conversation.contactId && !args.guest) {
      console.warn(`[perry] a message for ${conversation.title ?? "a chat with someone else"} that did not come from them was dropped`);
      return null;
    }
    // The owner wrote: what Perry sent them on its own is not being ignored (notify.ts).
    if (!guest && !conversation.jobId && !conversation.taskId && !args.hidden) await ctx.runMutation(internal.installation.ownerWrote, {});
    const telegramToken = channel === "telegram"
      ? await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" })
      : null;
    // A plain reply in a messaging app, outside a turn: a command's answer, or a failure.
    const say = async (text: string) => {
      if (channel === "telegram") await sendMessage(telegramToken, args.externalId, text);
      else if (channel === "whatsapp") await ctx.runMutation(internal.whatsapp.send, { to: args.externalId, text });
    };

    let delegated = false;
    try {
      const command = !guest && channel !== "web" && !args.fromWeb && args.text.startsWith("/") && !args.telegramMedia?.length && !args.storedMedia?.length;
      // Paused (pause.ts): a schedule's or task's turn on its way is held for the owner; a message from the phone is
      // answered that Perry is paused, the owner's with how to resume; commands still work, /resume among them.
      // The web app's own messages go on to be refused where the turn is queued, and the chat shows why.
      if (!command && (channel !== "web" || conversation.jobId || conversation.taskId) && await ctx.runQuery(internal.pause.state, {})) {
        if (conversation.jobId || conversation.taskId) await ctx.runMutation(internal.pause.held, { conversationId: conversation._id });
        else if (!args.fromWeb) await say(guest ? PAUSED_REPLY : PAUSED_OWNER);
        return null;
      }
      if (command) {
        await say(await runCommand(ctx, conversation, args.text));
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
          await say(
            `${tooBig.join(", ")} ${tooBig.length === 1 ? "is" : "are"} too big for me: Telegram lets bots download files up to 20 MB. ` +
            "Send a smaller file, or put it somewhere I can reach, like a link.");
          // Nothing else came with it, so there is nothing to answer.
          if (!args.text && !attachmentIds.length) return null;
        }
      }
      if (args.storedMedia?.length) {
        const messageKey = crypto.randomUUID();
        for (const item of args.storedMedia) {
          attachmentIds.push(await ctx.runMutation(internal.media.attachStored, { conversationId: conversation._id, messageKey, ...item }));
        }
        prompt = `${prompt}

<!-- attachments: ${messageKey} -->`.trim();
      }

      const attachments = attachmentIds.length > 0
        ? await ctx.runQuery(internal.media.forTurn, { conversationId: conversation._id, attachmentIds })
        : [];
      // A job's or task's turn comes routed; an owner's chat is routed here: its engine (its own, else the owner's
      // default) while that has room (lib/routing.ts). With neither, nothing is routed and the turn is refused,
      // asking the owner to choose (codex.enqueueTurn): routing never picks a default for them.
      const owners = !guest && !conversation.jobId && !conversation.taskId;
      const chosen: Choice | null = owners && !args.route && !args.model ? await ctx.runQuery(internal.routing.forChat, { id: conversation._id }) : null;
      // Someone else's chat is routed only among the engines that can be locked down for it; with none, no turn runs.
      const guestly = guest ? await guestRoute(ctx, conversation) : undefined;
      const stuck = guestly && "none" in guestly ? guestly.none : undefined;
      if (guestly && !stuck) conversation = (await ctx.runQuery(internal.conversations.getById, { id: conversation._id })) ?? conversation;
      const route: Route | undefined = guest ? (guestly && !("none" in guestly) ? guestly : undefined) : args.route ?? (chosen ? routeOf(chosen) : undefined);
      const settings = guest ? { engine: route?.engine, model: route?.model, effort: route?.effort, access: "supervised" as const }
        : route ? { engine: route.engine, model: route.model, effort: route.effort, access: conversation.access ?? "supervised" as const }
          : await turnSettings(ctx, conversation, args.model ? { model: args.model, engine: args.engine } : undefined);
      const moved = owners ? route?.movedFrom : undefined;
      if (moved && route) {
        // Moved for its engine's limit. A chat on an engine of its own goes on on the new one; one that follows the
        // default runs there until the default has room again (routing.moveChat). Said once for each move.
        const anew = conversation.engine !== undefined || conversation.moved?.from !== moved.engine || conversation.moved?.to !== route.engine;
        await ctx.runMutation(internal.routing.moveChatTo, { id: conversation._id, engine: route.engine, moved: { from: moved.engine, why: moved.why } });
        conversation = (await ctx.runQuery(internal.conversations.getById, { id: conversation._id })) ?? conversation;
        if (anew) await say(`${moved.why}, so ${ENGINE_LABELS[route.engine]} answers this chat now.`).catch((error) => console.error(`could not say the chat moved: ${String(error)}`));
      } else {
        // Back on the default it follows: the note about the move goes.
        if (owners && route && !conversation.engine && conversation.moved) await ctx.runMutation(internal.routing.clearMoved, { id: conversation._id });
        conversation = await onEngine(ctx, conversation, settings, !guest && Boolean(args.model));
      }
      const runId: Id<"runs"> = await ctx.runMutation(internal.runs.start, {
        conversationId: conversation._id,
        prompt: args.label ?? args.text,
        ...(route ? { route } : {}),
      });
      // The phone shows the reply, so it shows what it answers too.
      if (args.fromWeb && channel !== "web") {
        const said = args.text.replace(/\n?<!-- attachments:[^>]+ -->\s*$/, "").trim();
        const files = attachmentIds.length ? `${said ? "\n" : ""}(with ${attachmentIds.length === 1 ? "a file" : `${attachmentIds.length} files`})` : "";
        await say(`💻 You, in the web app:\n${said.slice(0, 1500)}${files}`)
          .catch((error) => console.error(`could not show the web message on the phone: ${String(error)}`));
      }
      // Nothing will answer a chat no engine can take, so nothing says it is typing.
      if (telegramToken && !stuck) await sendTyping(telegramToken, args.externalId);
      if (channel === "whatsapp" && !stuck) await ctx.runMutation(internal.whatsapp.typing, { to: args.externalId });

      const turn = guest ? await guestTurn(ctx, conversation, guest, settings.engine, args.guestContext) : await prepareTurn(ctx, conversation, args.hidden ? "" : args.text, settings.engine);
      // What the assistant sent here on its own since the owner last wrote: their message may answer it.
      const sent = guest ? [] : conversation.unprompted ?? [];
      if (sent.length) {
        const timezone: string = await ctx.runQuery(internal.jobs.ownerTimezone, {});
        const block = "# Sent by you since their last message\n\nYou messaged the owner here on your own; what they write now may answer it.\n" +
          sent.map((message) => `- [${ownerClock(timezone, message.at)}] ${message.text}`).join("\n");
        turn.recalled = [block, turn.recalled].filter(Boolean).join("\n\n");
      }

      try {
        if (stuck) throw new Error(stuck);
        await ctx.runMutation(internal.codex.enqueueTurn, {
          conversationId: conversation._id,
          runId,
          prompt,
          ...turn,
          ...settings,
          attachments,
          ...(args.hidden ? { hidden: true } : {}),
          ...(guest ? { guest: true } : {}),
          // The owner's message joins a reply that is running; a job's prompt waits its turn.
          policy: conversation.jobId || conversation.taskId ? "queue" : "steer",
        });
        delegated = true;
        if (guest) await ctx.runMutation(internal.routing.guestsStuck, { why: null });
        if (sent.length) await ctx.runMutation(internal.conversations.clearUnprompted, { id: conversation._id, through: sent[sent.length - 1].at });
      } catch (error) {
        // Usually no runner is online. Say so: a silent failure is worse than
        // an admitted one, because you keep waiting for a reply that never comes.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`turn failed: ${message}`);
        await ctx.runMutation(internal.runs.finish, { id: runId, status: "error", model: runLabel(settings.model, settings.effort, settings.access, settings.engine), error: message.slice(0, 1000) });
        // Paused while it was on its way: a job has missed a run and a task waits, rather than failing (pause.ts).
        const paused = message === PAUSED_ERROR;
        if (paused && (conversation.jobId || conversation.taskId)) await ctx.runMutation(internal.pause.held, { conversationId: conversation._id });
        else if (conversation.jobId) await ctx.runMutation(internal.jobs.finished, { id: conversation.jobId, error: message });
        else if (conversation.taskId) await ctx.runMutation(internal.tasks.afterTurn, { id: conversation.taskId, error: message });
        // The message stays in the chat with the error under it, as a turn would have saved it: the owner's
        // (in any channel, so the dashboard shows what failed) and a job's prompt alike. It never became a turn.
        if (!args.hidden) {
          await saveMessages(ctx, { threadId: conversation.threadId, userId: userIdOf(conversation), order: "next", messages: [{ role: "user", content: prompt }] })
            .catch((saveError) => console.error(`could not keep the message: ${String(saveError)}`));
        }
        // Someone else never hears why: what broke is the owner's business, and the dashboard shows it.
        if (channel !== "web" && !guest) {
          await say(paused ? PAUSED_OWNER : `That broke: ${message.slice(0, 300)}`)
            .catch((sendError) => console.error(`could not report failure: ${String(sendError)}`));
        }
        // No engine could take it: the owner's phone hears why once, not at every message.
        if (stuck && await ctx.runMutation(internal.routing.guestsStuck, { why: stuck })) {
          await ctx.runAction(internal.notify.deliver, { text: `Chats with other people get no reply for now. ${stuck}` })
            .catch((sendError) => console.error(`could not tell the owner: ${String(sendError)}`));
        }
      }
      return null;
    } finally {
      if (web && !delegated) {
        await ctx.runMutation(internal.conversations.finishWebTurn, { id: conversation._id, prompt: args.text });
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
