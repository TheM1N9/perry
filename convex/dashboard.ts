import { streamState } from "./lib/turn-stream";
import { turnErrorCode, type TurnFailure, type TurnErrorCode } from "../lib/turn-errors";
import { hide, savedValues } from "./vault";
import { createThread, deleteMessages, deleteThread, listMessages, saveMessages, searchMessages } from "./lib/agent";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { problemWith, resolve as resolveShortcuts, SHORTCUT_IDS, SHORTCUTS, type ShortcutId, type Shortcuts } from "./lib/shortcuts";
import { ABSOLUTE_PATH, stepsKey } from "./media";
import { chatDeleted, index as indexInLibrary, storedElsewhere } from "./library";
import { defaultAccess, defaultEngine, engineFor, type Onboarding } from "./installation";
import { callName, DEFAULT_NAME, readPersona, type Persona, type PersonaVersion } from "./persona";
import { PAUSED_ERROR, type Access } from "./lib/commands";
import { assertRunning } from "./pause";
import type { EngineKind } from "./lib/engines";
import type { CatalogApp, ConnectedAccount } from "./composio";
import { policyOf, type Policy } from "./runner";
import { turnHealth } from "./lib/turn-health";
import { vAccess, vEngine, vMemoryKind, vPolicy } from "./schema";
import { pickPatch } from "./engines";
import { APPROVAL_TTL_MS, accessChanged } from "./approvals";
import { QUIET } from "./jobs";
import type { VaultEntry } from "./vault";
import { OUTBOX_TTL_MS } from "./conversations";
import { assertQueueRoom, byQueuePosition, queuePosition, steerable } from "./queue";
import { beingNamed, cancelTitle, requestTitle } from "./titles";
import { watchProblem } from "./work";
import { describeStep, spansOfCalls, STARTING, summarize, WAITING, WRITING, type Step } from "./lib/activity";
import { STOPPED } from "./codex";
import { pictureOf, stepCard, type StepCard } from "./lib/steps";
import { diagnostics } from "./lib/internet";
import { choiceForChat } from "./routing";
import { recheckInternetConnections } from "./composio";
import { findBrowser } from "./lib/browser";

/**
 * Everything the web dashboard is allowed to do.
 *
 * These are the only public functions in the deployment. Each one checks the
 * dashboard key first and does nothing before it passes, so there is exactly
 * one line to audit per entry point.
 */

/** Web sessions have their own Agent threads and share the same memory pool. */
const WEB_CHANNEL = "web" as const;

const vKey = v.string();

// --- Web chat ------------------------------------------------------------

export type ChatMessage = {
  id: string;
  attachmentKey?: string;
  runId?: Id<"runs">;
  failure?: TurnFailure;
  role: string;
  text: string;
  createdAt: number;
  /** Its files; one deleted from the Library is `removed`, with no address. */
  attachments: Array<{ id?: Id<"chatAttachments">; url: string; fileName: string; contentType: string; removed?: true }>;
  /** Sent, and not yet in the history: the history only gets it with its reply. */
  pending?: boolean;
  queued?: QueuedTurn;
  /** The memories a reply said it relied on (codex.finishTurn). */
  memories?: Array<{ id: string; text: string }>;
  reactions?: { owner?: string; perry?: string };
};

/**
 * A message sent and waiting its turn in the chat's queue (queue.ts). `now`: it is not waiting behind anything,
 * so it stays with the conversation rather than under Up next: it is being prepared to join the reply running,
 * or with nothing running it is the first to start. `action`: what sending it early does:
 * "steer" joins the reply running; "send" moves it to the front, to start next. `retry`: another engine's try
 * at an earlier message, which keeps its words. `held`: it waits for its engine's limit to reset (routing.ts).
 */
export type QueuedTurn = {
  id: Id<"codexTurns">; conversationId: Id<"conversations">; position: number; action: "steer" | "send";
  preparing?: true; now?: true; retry?: true; held?: true;
};

/** Where a saved reply keeps the memories it relied on. */
const MEMORIES_MARKER = /\n?<!-- memories: ([^>]+) -->/;

const ATTACHMENTS_MARKER = /\n?<!-- attachments:([^>]+) -->\s*$/;

function assistantMedia(text: string): Array<{ url: string; fileName: string; contentType: string }> {
  const found = new Set<string>();
  const result: Array<{ url: string; fileName: string; contentType: string }> = [];
  const pattern = /(?:!\[[^\]]*\]|\[[^\]]*\])\((https?:\/\/[^)\s]+)\)|(?<![\w"'=])(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|m4a)(?:\?[^\s)]*)?)/gi;
  for (const match of text.matchAll(pattern)) {
    const url = match[1] ?? match[2];
    if (!url || found.has(url)) continue;
    found.add(url);
    const clean = url.split("?")[0];
    const extension = clean.split(".").pop()?.toLowerCase() ?? "";
    // A link to a page is just a link; only real media files become players.
    const contentType = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)
      ? `image/${extension === "jpg" ? "jpeg" : extension}`
      : ["mp4", "webm", "mov"].includes(extension) ? `video/${extension === "mov" ? "quicktime" : extension}`
        : ["mp3", "wav", "m4a"].includes(extension) ? `audio/${extension === "mp3" ? "mpeg" : extension === "m4a" ? "mp4" : extension}`
          : null;
    if (!contentType) continue;
    result.push({ url, fileName: clean.split("/").pop() || "shared media", contentType });
  }
  return result;
}

function webChat(conversation: Doc<"conversations"> | null) {
  if (!conversation || conversation.channel !== WEB_CHANNEL) {
    throw new Error("Chat not found.");
  }
  return conversation;
}

/**
 * Any of the owner's chats: a web chat, or their Telegram or WhatsApp chat,
 * which the web app shows and writes in too. Deleting, branching and
 * rewinding stay web-only (webChat): a messaging app's messages are already
 * on the phone and cannot be taken back.
 */
function ownerChat(conversation: Doc<"conversations"> | null) {
  if (!conversation) throw new Error("Chat not found.");
  return conversation;
}

/** The channels the chat list shows. */
const LISTED = ["web", "telegram", "whatsapp"] as const;
const APP_NAME = { web: "Untitled chat", telegram: "Telegram", whatsapp: "WhatsApp" } as const;
const titleOf = (chat: Doc<"conversations">) => chat.title ?? APP_NAME[chat.channel];

/**
 * Whether a reply is on its way. A web chat counts what it sent (pendingTurns);
 * a messaging app's chat also runs turns sent from the phone, so its queued or
 * running turn says.
 */
async function isBusy(ctx: QueryCtx, chat: Doc<"conversations">): Promise<boolean> {
  if ((chat.pendingTurns ?? 0) > 0) return true;
  if (chat.channel === WEB_CHANNEL) return false;
  for (const status of ["running", "queued"] as const) {
    const turn = await ctx.db.query("codexTurns")
      .withIndex("by_conversation_status", (q) => q.eq("conversationId", chat._id).eq("status", status))
      .first();
    if (turn && turn.kind !== "compact" && !turn.flush && !turn.checkpoint) return true;
  }
  return false;
}

/** What a chat is doing, for the dot beside it: waiting on the owner comes first. */
export type ChatStatus = "needs-approval" | "running" | "error" | "idle";

export type ChatSummary = {
  id: Id<"conversations">;
  /** Where the chat happens: the web app, or the owner's Telegram or WhatsApp. */
  channel: "web" | "telegram" | "whatsapp";
  title: string;
  lastMessageAt: number;
  parentConversationId?: Id<"conversations">;
  branchedFromMessageId?: string;
  status: ChatStatus;
  pinned: boolean;
  /** Set on the chat where a scheduled job's results collect. */
  jobId?: Id<"jobs">;
  /** A reply came after the owner last had the chat open. */
  unseen: boolean;
  /** A runner is naming it; its title is the first message until then (titles.ts). */
  naming: boolean;
  /** The project it is in, whose folder the sidebar shows it in (projects.ts). */
  projectId?: Id<"projects">;
};

/** A reply after the owner last looked. A job's quiet NOTHING is not one; a chat never opened only counts for jobs. */
function isUnseen(chat: Doc<"conversations">, job: Doc<"jobs"> | undefined | null): boolean {
  if ((chat.pendingTurns ?? 0) > 0) return false;
  if (chat.jobId) return Boolean(job?.lastResult && job.lastResult.trim() !== QUIET) && chat.lastMessageAt > (chat.seenAt ?? 0);
  return chat.seenAt !== undefined && chat.lastMessageAt > chat.seenAt;
}

export const listChats = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<ChatSummary[]> => {
    assertDashboardKey(args.key);
    const chats = (await Promise.all(LISTED.map((channel) => ctx.db.query("conversations")
      .withIndex("by_channel_last", (q) => q.eq("channel", channel))
      .order("desc")
      .collect()))).flat().sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const asking = new Set((await ctx.db.query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending").gt("createdAt", Date.now() - APPROVAL_TTL_MS))
      .collect()).map((row) => row.conversationId));
    const jobs = new Map((await ctx.db.query("jobs").collect()).map((job) => [job._id, job]));
    const naming = await beingNamed(ctx);
    const summaries = await Promise.all(chats.map(async (chat): Promise<ChatSummary> => {
      const running = await isBusy(ctx, chat);
      const latestRun = running || asking.has(chat._id) ? null : await ctx.db.query("runs")
        .withIndex("by_conversation", (q) => q.eq("conversationId", chat._id))
        .order("desc")
        .first();
      return {
        id: chat._id,
        channel: chat.channel,
        title: titleOf(chat),
        lastMessageAt: chat.lastMessageAt,
        parentConversationId: chat.parentConversationId,
        branchedFromMessageId: chat.branchedFromMessageId,
        status: asking.has(chat._id) ? "needs-approval" : running ? "running" : latestRun?.status === "error" ? "error" : "idle",
        pinned: chat.pinnedAt !== undefined,
        jobId: chat.jobId,
        unseen: isUnseen(chat, chat.jobId ? jobs.get(chat.jobId) : undefined),
        naming: naming.has(chat._id),
        ...(chat.projectId ? { projectId: chat.projectId } : {}),
      };
    }));
    // Pinned first, most recently pinned on top; the rest stay newest first.
    const pinnedAt = new Map(chats.map((chat) => [chat._id, chat.pinnedAt ?? 0]));
    return [
      ...summaries.filter((chat) => chat.pinned).sort((a, b) => pinnedAt.get(b.id)! - pinnedAt.get(a.id)!),
      ...summaries.filter((chat) => !chat.pinned),
    ];
  },
});

export const setChatPinned = mutation({
  args: { key: vKey, id: v.id("conversations"), pinned: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    ownerChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, { pinnedAt: args.pinned ? Date.now() : undefined });
    return null;
  },
});

/** The owner has the chat open: what is in it now is seen. */
export const markChatSeen = mutation({
  args: { key: vKey, id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const chat = ownerChat(await ctx.db.get(args.id));
    if ((chat.seenAt ?? 0) < chat.lastMessageAt) await ctx.db.patch(args.id, { seenAt: Date.now() });
    return null;
  },
});

export const createChat = mutation({
  /** projectId: started inside a project, the chat is in it from its first message. */
  args: { key: vKey, projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (args.projectId && !await ctx.db.get(args.projectId)) throw new Error("This project was deleted.");
    const threadId = await createThread(ctx, { userId: "web:dashboard", title: "New chat" });
    const engine = await defaultEngine(ctx);
    return await ctx.db.insert("conversations", {
      channel: WEB_CHANNEL,
      externalId: `session:${threadId}`,
      threadId,
      title: "New chat",
      // On the owner's default engine, kept when that changes; with none chosen yet, it is set at the first turn.
      ...(engine ? { engine } : {}),
      access: await defaultAccess(ctx),
      lastMessageAt: Date.now(),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    });
  },
});

export const renameChat = mutation({
  args: { key: vKey, id: v.id("conversations"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    ownerChat(await ctx.db.get(args.id));
    const title = args.title.trim().slice(0, 100);
    if (!title) throw new Error("Enter a chat name.");
    await ctx.db.patch(args.id, { title });
    await cancelTitle(ctx, args.id);
    return null;
  },
});

export const deleteChat = mutation({
  args: { key: vKey, id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const chat = webChat(await ctx.db.get(args.id));
    if ((chat.pendingTurns ?? 0) > 0) {
      throw new Error("Wait for this chat to finish before deleting it.");
    }
    const runs = await ctx.db.query("runs")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    if (runs.some((run) => run.status === "running")) {
      throw new Error("Wait for this chat to finish before deleting it.");
    }
    const task = chat.taskId ? await ctx.db.get(chat.taskId) : null;
    if (task && ["queued", "running", "blocked"].includes(task.status)) {
      await ctx.db.patch(task._id, { status: "cancelled", question: undefined, waiting: undefined, updatedAt: Date.now() });
    }
    for (const run of runs) {
      const spans = await ctx.db.query("runSpans").withIndex("by_run", (q) => q.eq("runId", run._id)).collect();
      for (const span of spans) await ctx.db.delete(span._id);
      await ctx.db.delete(run._id);
    }
    const attachments = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    // Its files stay in the Library, with another chat that has them or none (library.chatDeleted).
    await chatDeleted(ctx, args.id);
    for (const attachment of attachments) {
      // Local files stay where they are on the owner's machine, in the Library. A stored one goes with the
      // chat, unless a branch of it still shows it.
      if (attachment.storageId && !await storedElsewhere(ctx, attachment.storageId, args.id)) await ctx.storage.delete(attachment.storageId);
      await ctx.db.delete(attachment._id);
    }
    await ctx.runMutation(internal.codex.pruneOrphans, { conversationId: args.id });
    await cancelTitle(ctx, args.id);
    for (const artifact of await ctx.db.query("interactiveAnswers").withIndex("by_conversation", (q) => q.eq("conversationId", args.id)).collect()) await ctx.db.delete(artifact._id);
    for (const source of await ctx.db.query("interactiveSources").withIndex("by_conversation", (q) => q.eq("conversationId", args.id)).collect()) await ctx.db.delete(source._id);
    await ctx.db.delete(args.id);
    await deleteThread(ctx, chat.threadId);
    return null;
  },
});

export const branchChat = action({
  args: { key: vKey, id: v.id("conversations"), messageId: v.string() },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    assertDashboardKey(args.key);
    const source = await ctx.runQuery(internal.conversations.getWebById, { id: args.id });
    if (!source) throw new Error("Source chat was deleted.");
    const newest: Array<{ _id: string; message?: { role: string }; text?: string }> = [];
    let cursor: string | null = null;
    let found = false;
    while (true) {
      const page = await listMessages(ctx, {
        threadId: source.threadId,
        excludeToolMessages: true,
        paginationOpts: { cursor, numItems: 100 },
      });
      for (const message of page.page) {
        if (message._id === args.messageId) {
          found = true;
        }
        if (found) newest.push(message);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (!found) throw new Error("That message is no longer available to branch.");

    const title = `${source.title ?? "Chat"} · branch`.slice(0, 100);
    const threadId = await createThread(ctx, { userId: "web:dashboard", title });
    const history = newest.reverse()
      .filter((message) =>
        (message.message?.role === "user" || message.message?.role === "assistant") &&
        typeof message.text === "string" && message.text.trim().length > 0,
      );
    try {
      for (let start = 0; start < history.length; start += 100) {
        await saveMessages(ctx, {
          threadId,
          userId: "web:dashboard",
          order: "next",
          messages: history.slice(start, start + 100).map((message) => ({
            role: message.message!.role as "user" | "assistant",
            content: message.text!,
          })),
        });
      }
      const branchId = await ctx.runMutation(internal.conversations.createBranch, {
        parentId: source._id,
        threadId,
        title,
        messageId: args.messageId,
      });
      const keys = new Set(newest.flatMap((message) => {
        const raw = typeof message.text === "string" ? message.text : "";
        const match = raw.match(/\n?<!-- attachments:([^>]+) -->\s*$/);
        return match?.[1] ? [match[1].trim()] : [];
      }));
      await ctx.runMutation(internal.conversations.copyAttachments, {
        sourceId: source._id,
        targetId: branchId,
        messageKeys: [...keys],
      });
      return branchId;
    } catch (error) {
      await deleteThread(ctx, threadId);
      throw error;
    }
  },
});

export const searchChats = action({
  args: { key: vKey, search: v.string() },
  handler: async (ctx, args): Promise<Array<{ id: Id<"conversations">; title: string; snippet: string; lastMessageAt: number }>> => {
    assertDashboardKey(args.key);
    const needle = args.search.trim().toLocaleLowerCase();
    if (!needle) return [];
    const chats: Doc<"conversations">[] = await ctx.runQuery(internal.conversations.listDashboard, {});
    // Each channel's chats keep their messages under their own user id (agentStore.ts).
    const users = [...new Set(chats.map((chat) => chat.channel === WEB_CHANNEL ? "web:dashboard" : `${chat.channel}:${chat.externalId}`))];
    const messages = (await Promise.all(users.map((userId) => searchMessages(ctx, { userId, text: args.search.trim(), limit: 100 })))).flat();
    const snippets = new Map<string, string>(messages.map((message) => [message.threadId, message.text ?? ""]));
    return chats.filter((chat) =>
      titleOf(chat).toLocaleLowerCase().includes(needle) || snippets.has(chat.threadId),
    ).slice(0, 30).map((chat) => ({
      id: chat._id,
      title: titleOf(chat),
      snippet: snippets.get(chat.threadId)?.slice(0, 160) ?? "",
      lastMessageAt: chat.lastMessageAt,
    }));
  },
});

export const getChat = query({
  args: { key: vKey, id: v.id("conversations") },
  handler: async (
    ctx,
    args,
  ): Promise<{ channel: ChatSummary["channel"]; engine?: EngineKind; moved?: Doc<"conversations">["moved"]; waiting?: { until: number; why: string }; project?: { id: Id<"projects">; name: string }; model?: string; effort?: string; access: Access; title: string; isRunning: boolean; unresponsive?: boolean; lastAliveAt?: number; lastError?: string; lastErrorCode?: TurnErrorCode; lastErrorRunId?: Id<"runs">; contact?: { name: string; group: boolean }; context?: { fill: number; window: number } }> => {
    assertDashboardKey(args.key);
    const conversation = ownerChat(await ctx.db.get(args.id));
    // Perry's chat with someone else (contacts.ts): the owner reads it, and does not write in it.
    const contact = conversation.contactId ? await ctx.db.get(conversation.contactId) : null;
    const isRunning = await isBusy(ctx, conversation);
    const latestRun = await ctx.db.query("runs")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .order("desc")
      .first();
    const running = isRunning
      ? await ctx.db.query("codexTurns")
        .withIndex("by_conversation_status", (q) => q.eq("conversationId", args.id).eq("status", "running"))
        .first()
      : null;
    const runner = running?.runnerId ? await ctx.db.get(running.runnerId) : null;
    const health = running ? turnHealth(running, runner, Date.now()) : null;
    const waiting = running ? undefined : (await ctx.db.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", args.id)).collect())
      .filter(turn => turn.finalizedAt === undefined && (turn.status === "queued" || turn.status === "error" && turn.retrying))
      .sort(byQueuePosition)[0]?.waiting;
    const project = conversation.projectId ? await ctx.db.get(conversation.projectId) : null;
    const taskChoice = conversation.taskId ? await choiceForChat(ctx, conversation) : null;
    return {
      channel: conversation.channel,
      // Its own, else the default it follows; unset while there is neither.
      engine: taskChoice?.engine ?? await engineFor(ctx, conversation),
      // Perry moved it to this engine because its own had no room (routing.moveChat).
      ...(conversation.moved ? { moved: conversation.moved } : {}),
      ...(project ? { project: { id: project._id, name: project.name } } : {}),
      model: taskChoice?.model ?? conversation.model,
      effort: taskChoice ? taskChoice.effort : conversation.effort,
      access: conversation.access ?? "supervised",
      title: titleOf(conversation),
      isRunning,
      ...(waiting ? { waiting } : {}),
      ...(health ? { unresponsive: health.unresponsive, lastAliveAt: health.lastAliveAt } : {}),
      lastError: latestRun?.status === "error" && latestRun.error ? hide(latestRun.error, await savedValues(ctx)) : undefined,
      lastErrorCode: latestRun?.status === "error" ? turnErrorCode(latestRun) : undefined,
      lastErrorRunId: latestRun?.status === "error" ? latestRun._id : undefined,
      ...(contact ? { contact: { name: contact.name, group: contact.kind === "group" } } : {}),
      // How full its engine's context is, as its last turn said (codex.ts, recordTrace): unset until one has.
      ...(conversation.contextWindow && conversation.contextFill !== undefined ? { context: { fill: conversation.contextFill, window: conversation.contextWindow } } : {}),
    };
  },
});

export type Activity = {
  conversationId: Id<"conversations">;
  /** The chat it is for, when that is not the one asked about. */
  chat?: string;
  running: boolean;
  startedAt: number;
  /** What it is doing now, while it runs. */
  /** `live` when it is a step Codex is on, or an approval; otherwise it is only thinking or writing between steps. */
  step?: Step & { since: number; live: boolean };
  /**
   * The step that finished last, and when. A quick step can start and finish
   * between two reports from the runner, and is never seen running; the pet
   * holds this up for a moment by its own clock instead.
   */
  recent?: Step & { since: number; endedAt: number };
  /** What it did, once it is over: "Ran 3 commands · read 2 pages". */
  summary: string;
};

/**
 * What Perry is doing, for the desktop pet (lib/activity.ts): the latest turn
 * of this chat, or with no chat given, whatever turn is running anywhere (a
 * job, a Telegram message). Null when there is nothing to say.
 */
export const getActivity = query({
  args: { key: vKey, id: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<Activity | null> => {
    assertDashboardKey(args.key);
    const run = args.id
      ? await ctx.db.query("runs").withIndex("by_conversation", (q) => q.eq("conversationId", args.id!)).order("desc").first()
      : (await ctx.db.query("runs").withIndex("by_started").order("desc").take(20)).find((item) => item.status === "running") ?? null;
    if (!run) return null;
    const running = run.status === "running";
    const spans = (await ctx.db.query("runSpans").withIndex("by_run", (q) => q.eq("runId", run._id)).collect())
      .sort((a, b) => a.startedAt - b.startedAt);
    let step: Activity["step"];
    let recent: Activity["recent"];
    if (running) {
      const asking = (await ctx.db.query("approvals")
        .withIndex("by_status", (q) => q.eq("status", "pending").gt("createdAt", Date.now() - APPROVAL_TTL_MS))
        .collect()).find((row) => row.conversationId === run.conversationId);
      const live = [...spans].reverse().find((span) => span.status === "running");
      const last = spans.at(-1);
      const turn = await ctx.db.query("codexTurns").withIndex("by_conversation_status", (q) => q.eq("conversationId", run.conversationId).eq("status", "running")).first();
      const ended = last ? last.startedAt + (last.durationMs ?? 0) : run.startedAt;
      const runner = turn?.runnerId ? await ctx.db.get(turn.runnerId) : null;
      const health = turn ? turnHealth(turn, runner, Date.now()) : null;
      if (health?.unresponsive) step = { label: "Computer unresponsive", pose: "waiting", since: health.lastAliveAt, live: false };
      else if (asking) step = { ...WAITING, since: asking.createdAt, live: true };
      else if (live) step = { ...describeStep(live), since: live.startedAt, live: true };
      else step = { ...(turn && (turn.partial || (await streamState(ctx, turn._id))?.length) ? WRITING : STARTING), since: ended, live: false };
      if (last && last.status !== "running" && last.kind !== "reasoning") recent = { ...describeStep(last), since: last.startedAt, endedAt: ended };
    }
    const chat = args.id ? null : await ctx.db.get(run.conversationId);
    return {
      conversationId: run.conversationId,
      ...(chat ? { chat: titleOf(chat) } : {}),
      running,
      startedAt: run.startedAt,
      ...(step ? { step } : {}),
      ...(recent ? { recent } : {}),
      summary: running ? "" : summarize(spans),
    };
  },
});

/**
 * One run of a chat, without its steps: how it went, how many steps it took
 * and, once it is over, what they came to ("Ran 2 commands and changed 3
 * files"). The steps are read only for the run going on and for a fold the
 * owner opens (getRunSteps).
 */
export type Work = {
  runId: Id<"runs">; status: Doc<"runs">["status"]; startedAt: number; finishedAt?: number; stepCount: number; summary?: string;
  /** The owner stopped it (codex.STOPPED). */
  stopped?: true;
  /** A /compact, not a reply: the chat says "Compacting context", then "Context compacted". */
  compact?: true;
};
/** A step of a run, as the chat lists it: `label` while it runs ("Running git status"), `done` once it is over ("Ran git status"). */
export type WorkStep = Step & { id: Id<"runSpans">; done: string; kind: Doc<"runSpans">["kind"]; status: Doc<"runSpans">["status"]; startedAt: number; durationMs?: number };
/** The runs a chat pairs with its replies: its latest, which covers the replies it shows. */
const WORK_RUNS = 50;
/** The most steps a fold lists for a run: its newest, so the one going on is always among them. */
const RUN_STEPS = 500;

/**
 * A chat's latest runs, oldest first, for the chat to pair with its replies
 * ("Worked for 46s" above each) and to show the one going on. Only the runs'
 * own rows are read, so a step written while a reply runs costs this one
 * small read, not every step of fifty runs.
 */
export const getChatRuns = query({
  args: { key: vKey, id: v.id("conversations") },
  handler: async (ctx, args): Promise<Work[]> => {
    assertDashboardKey(args.key);
    ownerChat(await ctx.db.get(args.id));
    const runs = await ctx.db.query("runs").withIndex("by_conversation", (q) => q.eq("conversationId", args.id)).order("desc").take(WORK_RUNS);
    return runs.reverse().map((run): Work => {
      // Each step but reasoning is a tool call (codex.ts, recordTrace); a run that ended before summaries were kept is summed up from those.
      const calls = run.toolCalls ?? [];
      const summary = run.summary ?? (run.status !== "running" && calls.length ? summarize(spansOfCalls(calls), { sentence: true }) : "");
      return {
        runId: run._id, status: run.status, startedAt: run.startedAt, stepCount: calls.length,
        ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
        ...(summary ? { summary } : {}),
        ...(run.status === "error" && run.error === STOPPED ? { stopped: true as const } : {}),
        // Commands never become messages, so only requestCompact's run carries this prompt.
        ...(run.prompt === "/compact" ? { compact: true as const } : {}),
      };
    });
  },
});

/**
 * The steps of one or more runs of a chat (the runs that went as one turn),
 * in the order they started, reasoning left out; its time is in the run's.
 * `limit`: only the newest, for the one line a reply in progress shows.
 * Only runs of one of the owner's chats, and of the same one, are read.
 */
export const getRunSteps = query({
  args: { key: vKey, runIds: v.array(v.id("runs")), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<WorkStep[]> => {
    assertDashboardKey(args.key);
    const limit = Math.max(1, Math.min(args.limit ?? RUN_STEPS, RUN_STEPS));
    const steps: WorkStep[] = [];
    let chat: Id<"conversations"> | undefined;
    for (const runId of args.runIds.slice(0, 10)) {
      const run = await ctx.db.get(runId);
      if (!run || (chat ??= run.conversationId) !== run.conversationId) continue;
      ownerChat(await ctx.db.get(run.conversationId));
      // Newest first, so a long run keeps its latest steps; reasoning is skipped as it comes, not counted against the limit.
      let taken = 0;
      for await (const span of ctx.db.query("runSpans").withIndex("by_run_started", (q) => q.eq("runId", runId)).order("desc")) {
        if (span.kind === "reasoning") continue;
        steps.push({
          ...describeStep(span),
          done: describeStep(span, { done: true }).label,
          id: span._id,
          kind: span.kind,
          status: span.status,
          startedAt: span.startedAt,
          ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
        });
        if (++taken >= limit) break;
      }
    }
    return steps.sort((a, b) => a.startedAt - b.startedAt).slice(-limit);
  },
});

/** A step opened in the chat or on Activity: what it ran, changed, saw or answered, live while it runs. */
export type StepView = StepCard & { status: Doc<"runSpans">["status"] };

/**
 * One step, as a card (lib/steps.ts), with what it links to: each file it
 * changed and the picture Perry's browser took, served by the local media
 * server (app/api/media). Loaded only when the step is opened.
 */
export const getStep = query({
  args: { key: vKey, id: v.string() },
  handler: async (ctx, args): Promise<StepView | null> => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("runSpans", args.id);
    const span = id ? await ctx.db.get(id) : null;
    const run = span ? await ctx.db.get(span.runId) : null;
    if (!span || !run) return null;
    const files = span.kind === "fileChange"
      ? new Map((await ctx.db.query("chatAttachments")
        .withIndex("by_message", (q) => q.eq("conversationId", run.conversationId).eq("messageKey", stepsKey(run._id)))
        .collect()).flatMap((row) => row.localPath ? [[row.localPath, `/api/media/${row._id}`] as const] : []))
      : undefined;
    const pictureId = pictureOf(span);
    const pictureRow = pictureId ? ctx.db.normalizeId("chatAttachments", pictureId) : null;
    const picture = pictureRow ? await ctx.db.get(pictureRow) : null;
    // Only a picture registered for this chat's steps, whatever id a tool's answer carried.
    const shown = picture?.conversationId === run.conversationId && picture.messageKey === "steps" && picture.localPath ? `/api/media/${picture._id}` : undefined;
    return { ...stepCard(span, { files, ...(shown ? { picture: shown } : {}) }), status: span.status };
  },
});

/**
 * The files on this computer a chat can open, by where they are: the ones its
 * runs changed (codex.ts, linkFiles) and the ones sent in it, each with the
 * address the media server gives it. A reply's link to one of these paths
 * opens the file (components/dashboard/chat/markdown.tsx); a path not here
 * is never served.
 */
export const getChatFiles = query({
  args: { key: vKey, id: v.id("conversations") },
  handler: async (ctx, args): Promise<Array<{ path: string; url: string }>> => {
    assertDashboardKey(args.key);
    ownerChat(await ctx.db.get(args.id));
    const rows = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .order("desc")
      .take(1000);
    return rows.flatMap((row) => row.localPath && !row.removedAt ? [{ path: row.localPath, url: `/api/media/${row._id}?preview` }] : []);
  },
});

export const getChatMessages = query({
  args: { key: vKey, id: v.id("conversations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const conversation = ownerChat(await ctx.db.get(args.id));
    const page = await listMessages(ctx, {
      threadId: conversation.threadId,
      excludeToolMessages: true,
      paginationOpts: args.paginationOpts,
    });
    const attachments = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    const attachmentMap = new Map<string, ChatMessage["attachments"]>();
    attachments.sort((a, b) => (a.position ?? a.createdAt) - (b.position ?? b.createdAt));
    for (const attachment of attachments) {
      // Deleted from the Library: the chat says so where the file was.
      if (attachment.removedAt) {
        const list = attachmentMap.get(attachment.messageKey) ?? [];
        list.push({ id: attachment._id, url: "", fileName: attachment.fileName, contentType: attachment.contentType, removed: true });
        attachmentMap.set(attachment.messageKey, list);
        continue;
      }
      // Local media is served by the Next.js server on the owner's machine.
      const url = attachment.localPath
        ? `/api/media/${attachment._id}`
        : attachment.storageId ? await ctx.storage.getUrl(attachment.storageId) : null;
      if (!url) continue;
      const list = attachmentMap.get(attachment.messageKey) ?? [];
      list.push({ id: attachment._id, url, fileName: attachment.fileName, contentType: attachment.contentType });
      attachmentMap.set(attachment.messageKey, list);
    }
    // Earlier Codex turns could finish before their media was uploaded. When
    // recovered later, their saved assistant message has no attachment marker.
    const codexTurns = await ctx.db.query("codexTurns")
      .withIndex("by_conversation_status", (q) => q.eq("conversationId", args.id))
      .collect();
    // The memories replies relied on, looked up once for the page.
    const cited = new Map<string, { id: string; text: string }>();
    for (const doc of page.page) {
      const ids = (typeof doc.text === "string" ? MEMORIES_MARKER.exec(doc.text)?.[1] : undefined)?.split(",") ?? [];
      for (const raw of ids) {
        const id = ctx.db.normalizeId("memories", raw.trim());
        const memory = id && !cited.has(id) ? await ctx.db.get(id) : null;
        if (memory) cited.set(memory._id, { id: memory._id, text: memory.text });
      }
    }
    const failureRuns = new Map<string, TurnFailure>();
    const values = await savedValues(ctx);
    for (const runId of new Set(page.page.flatMap((doc) => doc.runId ? [doc.runId] : []))) {
      const run = await ctx.db.get(runId);
      if (run?.conversationId === args.id && run.status === "error") failureRuns.set(runId, { errorCode: turnErrorCode(run), ...(run.error ? { error: hide(run.error, values) } : {}) });
    }
    const history = page.page.map((doc): ChatMessage => {
        const raw = typeof doc.text === "string" ? doc.text : "";
        const memories = (MEMORIES_MARKER.exec(raw)?.[1]?.split(",") ?? []).flatMap((id) => cited.get(id.trim()) ?? []);
        const marker = raw.match(/\n?<!-- attachments:([^>]+) -->\s*$/);
        const messageKey = marker?.[1]?.trim();
        const recovered = !messageKey && doc.message?.role === "assistant"
          ? codexTurns.find((turn) =>
              turn.response === raw && turn.finishedAt !== undefined &&
              doc._creationTime >= turn.finishedAt &&
              doc._creationTime <= (turn.finalizedAt ?? turn.finishedAt) + 60_000 &&
              attachmentMap.has(`codex-${turn._id}`),
            )
          : undefined;
        return {
          id: doc._id,
          ...(doc.ownerReaction || doc.perryReaction ? { reactions: { owner: doc.ownerReaction, perry: doc.perryReaction } } : {}),
          ...(doc.runId ? { runId: doc.runId, failure: failureRuns.get(doc.runId) } : {}),
          attachmentKey: messageKey ?? (recovered ? `codex-${recovered._id}` : undefined),
          role: doc.message?.role ?? "assistant",
          text: (marker ? raw.slice(0, marker.index) : raw).replace(MEMORIES_MARKER, "").trimEnd(),
          createdAt: doc._creationTime,
          ...(memories.length ? { memories } : {}),
          attachments: messageKey
            ? attachmentMap.get(messageKey) ?? []
            : recovered
              ? attachmentMap.get(`codex-${recovered._id}`) ?? []
              : doc.message?.role === "assistant" ? assistantMedia(raw) : [],
        };
      }).filter((message) => message.text.trim().length > 0 || message.attachments.length > 0);
    // The newest page also carries what was sent and is not in the history yet, from the same read, so
    // a message never shows twice or blinks out between the outbox, its turn and the history.
    const pending = args.paginationOpts.cursor === null ? inFlight(conversation, codexTurns, await steersOf(ctx, codexTurns)) : [];
    const saved = history.filter((message) => message.role === "user");
    const shown = pending.flatMap((entry, index): ChatMessage[] => {
      // Saved a moment before its turn says so: the saved copy stands.
      const copy = saved.findIndex((message) => message.text === entry.text && message.createdAt >= entry.at);
      if (copy >= 0) { saved.splice(copy, 1); return []; }
      const marker = entry.prompt.match(ATTACHMENTS_MARKER);
      return [{
        id: `pending-${entry.at}-${index}`,
        role: "user",
        text: entry.text,
        createdAt: entry.at,
        attachments: marker?.[1] ? attachmentMap.get(marker[1].trim()) ?? [] : [],
        pending: true,
        ...(entry.reaction ? { reactions: { perry: entry.reaction } } : {}),
        ...(entry.queued ? { queued: entry.queued } : {}),
      }];
    });
    return { ...page, page: [...shown.reverse(), ...history] };
  },
});

type InFlight = { prompt: string; text: string; at: number; reaction?: string; queued?: QueuedTurn };

/** The live turns' steers that joined them, and those still waiting to. */
async function steersOf(ctx: QueryCtx, turns: Doc<"codexTurns">[]): Promise<Doc<"codexSteers">[]> {
  const live = turns.filter((turn) => turn.savedAt === undefined && turn.kind !== "compact" && !turn.flush && !turn.checkpoint);
  const found: Doc<"codexSteers">[] = [];
  for (const turn of live) {
    for (const status of ["pending", "applied"] as const) {
      found.push(...await ctx.db.query("codexSteers").withIndex("by_turn_status", (q) => q.eq("turnId", turn._id).eq("status", status)).collect());
    }
  }
  return found;
}

/**
 * The owner's messages not in the history yet, oldest first: in the outbox
 * until a turn takes them, then the prompt of a turn (or a steer that joined
 * it) until its reply is saved with it.
 */
function inFlight(conversation: Doc<"conversations">, turns: Doc<"codexTurns">[], steers: Doc<"codexSteers">[]): InFlight[] {
  const entry = (prompt: string, at: number): InFlight => ({ prompt, at, text: prompt.replace(ATTACHMENTS_MARKER, "").trimEnd() });
  const running = turns.find((turn) => turn.status === "running") ?? null;
  const next = running ? undefined : turns.filter((turn) => turn.status === "queued" && !turn.waiting && turn.finalizedAt === undefined).sort(byQueuePosition)[0];
  const queued = (turn: Doc<"codexTurns">): QueuedTurn => ({
    id: turn._id, conversationId: turn.conversationId, position: queuePosition(turn),
    action: turn.engine && steerable(running, turn.engine) ? "steer" : "send",
    ...(turn.preparing ? { preparing: true as const } : {}),
    ...((turn.preparing && turn.steerTarget) || turn === next ? { now: true as const } : {}),
    ...(turn.retryOf ? { retry: true as const } : {}),
    ...(turn.waiting ? { held: true as const } : {}),
  });
  const items: InFlight[] = [
    ...(conversation.outbox ?? []).filter((item) => item.at > Date.now() - OUTBOX_TTL_MS).map((item) => entry(item.text, item.at)),
    ...turns.filter((turn) => turn.savedAt === undefined && turn.kind !== "compact" && !turn.flush && !turn.checkpoint && !turn.hidden
      // A finished turn is saved a moment later; one left unsaved and unfinalized for long is not coming.
      && (turn.status === "queued" || turn.status === "running" || (turn.finalizedAt === undefined && (turn.waiting || turn.createdAt > Date.now() - OUTBOX_TTL_MS))))
      .map((turn) => ({ ...entry(turn.prompt, turn.createdAt), ...(turn.webReaction ? { reaction: turn.webReaction } : {}), ...(turn.status === "queued" ? { queued: queued(turn) } : {}) })),
    ...steers.map((steer) => entry(steer.prompt, steer.createdAt)),
  ];
  return items.sort((a, b) => a.at - b.at);
}

export const generateUploadUrl = mutation({
  args: { key: vKey },
  returns: v.string(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await ctx.storage.generateUploadUrl();
  },
});

export const registerAttachment = mutation({
  args: {
    key: vKey,
    conversationId: v.id("conversations"),
    messageKey: v.string(),
    /** Exactly one: a Convex upload, or where the local media server saved it. */
    storageId: v.optional(v.id("_storage")),
    localPath: v.optional(v.string()),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    /** A file staged for an edit, rather than an already sent message. */
    editOf: v.optional(v.string()),
    /** Sent from the desktop pet, as the Library says where it came from. */
    from: v.optional(v.literal("pet")),
  },
  returns: v.id("chatAttachments"),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const chat = ownerChat(await ctx.db.get(args.conversationId));
    const editOf = args.editOf ? ctx.db.normalizeId("agentMessages", args.editOf) : null;
    if (args.editOf) {
      const message = editOf ? await ctx.db.get(editOf) : null;
      if (chat.channel !== WEB_CHANNEL || message?.threadId !== chat.threadId || message.message.role !== "user") {
        throw new Error("That message changed. Cancel this edit and open it again.");
      }
      const existing = await ctx.db.query("chatAttachments")
        .withIndex("by_message", (q) => q.eq("conversationId", args.conversationId).eq("messageKey", args.messageKey)).collect();
      const uploaded = existing.find((item) => item.editOf === args.editOf && item.localPath === args.localPath && item.storageId === args.storageId);
      if (uploaded) return uploaded._id;
    }
    if (!args.fileName.trim() || args.size <= 0 || args.size > 50 * 1024 * 1024) {
      throw new Error("Attachments must be between 1 byte and 50 MB.");
    }
    if (Boolean(args.storageId) === Boolean(args.localPath)) throw new Error("Attach either an upload or a local file.");
    if (args.localPath && !ABSOLUTE_PATH.test(args.localPath)) throw new Error("Local files need an absolute path.");
    const stored = args.storageId ? await ctx.storage.getMetadata(args.storageId) : null;
    if (args.storageId && !stored) throw new Error("Upload could not be found.");
    const id = await ctx.db.insert("chatAttachments", {
      conversationId: args.conversationId,
      messageKey: args.messageKey,
      ...(editOf ? { editOf } : {}),
      storageId: args.storageId,
      localPath: args.localPath,
      fileName: args.fileName.trim().slice(0, 200),
      contentType: args.contentType || stored?.contentType || "application/octet-stream",
      size: args.size,
      createdAt: Date.now(),
    });
    await indexInLibrary(ctx, id, args.from ? { from: args.from } : {});
    return id;
  },
});

export const sendChat = mutation({
  args: {
    key: vKey,
    id: v.id("conversations"),
    text: v.string(),
    attachmentIds: v.optional(v.array(v.id("chatAttachments"))),
    messageKey: v.optional(v.string()),
    /** The model picked in the composer. Unset keeps the chat's current one. */
    model: v.optional(v.string()),
    /** The engine of that model; another than the chat's moves the chat there. Unset keeps the chat's. */
    engine: v.optional(vEngine),
    /** Picked in the composer before the chat existed; "" is the model's default. Unset keeps the chat's. */
    effort: v.optional(v.string()),
    access: v.optional(vAccess),
    mode: v.optional(v.union(v.literal("auto"), v.literal("queue"))),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);

    const text = args.text.trim();
    const attachmentIds = args.attachmentIds ?? [];
    if (text.length === 0 && attachmentIds.length === 0) return null;
    const chat = ownerChat(await ctx.db.get(args.id));
    // What is written here would reach them as Perry's; the owner tells Perry what to say in their own chat.
    if (chat.contactId) throw new Error("This is Perry's chat with someone else. To have Perry tell them something, ask in your own chat.");
    // Paused, the message is not sent; it stays in the box for when he is back (pause.ts).
    await assertRunning(ctx);
    // Reserve durable queue capacity before asynchronous preparation.
    await assertQueueRoom(ctx, chat);
    const messageKey = args.messageKey?.trim() || crypto.randomUUID();
    const attachments = await Promise.all(attachmentIds.map((id) => ctx.db.get(id)));
    if (attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length) throw new Error("A message can have up to 10 different attachments.");
    if (attachments.some((attachment) => !attachment || attachment.removedAt || attachment.conversationId !== args.id || attachment.messageKey !== messageKey)) {
      throw new Error("One of the attachments is no longer available.");
    }
    const prompt = attachmentIds.length > 0
      ? `${text}\n\n<!-- attachments: ${messageKey} -->`.trim()
      : text;
    // The first message titles a new chat at once; a runner names it properly soon after.
    const first = chat.title === "New chat";
    const title = first ? (text || "Attached files").slice(0, 80) : chat.title;
    if (first) await requestTitle(ctx, args.id, text, title!);
    const web = chat.channel === WEB_CHANNEL;
    await ctx.db.patch(args.id, {
      lastMessageAt: Date.now(),
      // Writing in it, the owner has seen what is there; the reply is unseen until they look.
      seenAt: Date.now(),
      title,
      // A messaging app's chat shows its turns as they run (isBusy), whichever side sent them.
      ...(web ? { pendingTurns: (chat.pendingTurns ?? 0) + 1 } : {}),
      ...(args.model !== undefined ? pickPatch(chat, args.model, args.engine, await engineFor(ctx, chat)) : {}),
      ...(args.effort !== undefined ? { effort: args.effort.trim() || (chat.taskId ? "" : undefined) } : {}),
      ...(args.access !== undefined ? { access: args.access } : {}),
    });

    const preparingId = await ctx.runMutation(internal.codex.prepareTurn, { conversationId: chat._id, prompt, queue: args.mode === "queue" });

    // Sent while a reply is running, this joins that reply (see codex.enqueueTurn).
    // Written in a Telegram or WhatsApp chat, it is that chat's turn, so the reply goes to the phone too.
    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: chat.channel,
      externalId: chat.externalId,
      text: prompt,
      title: chat.title,
      attachmentIds,
      preparingId,
      ...(web ? {} : { fromWeb: true }),
    });
    return null;
  },
});

/**
 * Atomically replace a message and its later replies, then resend on a fresh engine session.
 * Messages are immutable revisions: an edit's source id must still exist in this transaction.
 * A running reply must finish (or be stopped) before saving, as for regeneration.
 */
export const rewindChat = mutation({
  args: {
    key: vKey, id: v.id("conversations"), messageId: v.string(), text: v.optional(v.string()),
    attachmentIds: v.optional(v.array(v.id("chatAttachments"))),
    requestId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const chat = ownerChat(await ctx.db.get(args.id));
    if (chat.channel !== WEB_CHANNEL || chat.contactId) throw new Error("Only your own web messages can be edited.");
    if (args.requestId && chat.lastRewindRequest === args.requestId) return null;
    await assertRunning(ctx);
    const targetId = ctx.db.normalizeId("agentMessages", args.messageId);
    const target = targetId ? await ctx.db.get(targetId) : null;
    if (!target || target.threadId !== chat.threadId) throw new Error("That message changed. Cancel this edit and open it again.");
    if ((args.text !== undefined || args.attachmentIds !== undefined) && target.message.role !== "user") {
      throw new Error("Only your own messages can be edited.");
    }
    const sent = target.message.role === "user" ? target : await ctx.db.query("agentMessages")
      .withIndex("by_thread_order", (q) => q.eq("threadId", target.threadId).lte("order", target.order))
      .order("desc").filter((q) => q.eq(q.field("message.role"), "user")).first();
    if (!sent) throw new Error("That message is no longer in this chat.");
    const raw = sent.text;
    const marker = raw.match(ATTACHMENTS_MARKER);
    const originalKey = marker?.[1]?.trim();
    const original = originalKey ? await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", chat._id).eq("messageKey", originalKey)).collect() : [];
    original.sort((a, b) => (a.position ?? a.createdAt) - (b.position ?? b.createdAt));
    const originalIds = new Set(original.map((item) => item._id));
    const text = (args.text ?? (marker ? raw.slice(0, marker.index) : raw)).trim();
    let attachmentIds = args.attachmentIds ?? original.map((item) => item._id);
    if (attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length) throw new Error("A message can have up to 10 different attachments.");
    const files = await Promise.all(attachmentIds.map((id) => ctx.db.get(id)));
    for (const file of files) {
      if (!file || file.conversationId !== chat._id || (!originalIds.has(file._id) &&
        (!args.requestId || file.editOf !== sent._id || file.messageKey !== args.requestId || file.removedAt))) {
        throw new Error("One of the attachments is no longer available for this edit.");
      }
    }
    if (!text && !files.some((file) => file && !file.removedAt)) throw new Error("The message is empty. Use Delete chat to remove it instead.");
    // Keep files and other messages' references intact. Each edited set has its own ordered references.
    let messageKey = originalKey;
    if (args.attachmentIds !== undefined) {
      if (!args.requestId) throw new Error("This edit needs a request id.");
      messageKey = `edit-${args.requestId}`;
      attachmentIds = [];
      for (const [position, file] of files.entries()) {
        if (!file) continue;
        attachmentIds.push(await ctx.db.insert("chatAttachments", {
          conversationId: chat._id, messageKey, position,
          localPath: file.localPath, storageId: file.storageId,
          fileName: file.fileName, contentType: file.contentType, size: file.size,
          createdAt: Date.now(), ...(file.removedAt ? { removedAt: file.removedAt } : {}),
        }));
      }
    }
    await ctx.runMutation(internal.conversations.rewind, { id: chat._id });
    const replaced = await ctx.db.query("agentMessages")
      .withIndex("by_thread_order", (q) => q.eq("threadId", sent.threadId).gte("order", sent.order)).collect();
    await deleteMessages(ctx, replaced.map((message) => message._id));
    const prompt = attachmentIds.length ? `${text}\n\n<!-- attachments: ${messageKey} -->`.trim() : text;
    await ctx.db.patch(chat._id, {
      recallDigest: undefined,
      ...(args.requestId ? { lastRewindRequest: args.requestId } : {}),
      outbox: [{ text: prompt, at: Date.now() }],
    });
    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: WEB_CHANNEL, externalId: chat.externalId, text: prompt, title: chat.title, attachmentIds,
    });
    return null;
  },
});

/** Stop the chat's running reply, keeping what it has written so far. */
export const stopChat = mutation({
  args: { key: vKey, id: v.id("conversations") },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    assertDashboardKey(args.key);
    ownerChat(await ctx.db.get(args.id));
    return await ctx.runMutation(internal.codex.requestStop, { conversationId: args.id });
  },
});

/** /reset: save what is worth keeping from this chat to memory, then start it afresh. Says what happened. */
export const resetChat = action({
  args: { key: vKey, id: v.id("conversations") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.brain.resetChat, { id: args.id });
  },
});

/** /compact: what matters goes to memory first (a checkpoint), then the chat's engine session is summarised. Null when there is nothing to compact yet. */
export const compactChat = action({
  args: { key: vKey, id: v.id("conversations") },
  returns: v.union(v.null(), v.id("codexTurns")),
  handler: async (ctx, args): Promise<Id<"codexTurns"> | null> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.brain.compactChat, { id: args.id });
  },
});

/** How a /compact is going, for the composer to report when it is done. */
export const getCompaction = query({
  args: { key: vKey, id: v.id("codexTurns") },
  handler: async (ctx, args): Promise<{ status: Doc<"codexTurns">["status"]; error?: string } | null> => {
    assertDashboardKey(args.key);
    const turn = await ctx.db.get(args.id);
    return turn?.kind === "compact" ? { status: turn.status, error: turn.error } : null;
  },
});

/**
 * Pick this chat's model. Unset means its engine's default. Another engine's
 * model moves the chat to that engine, which picks up from the chat so far.
 */
export const setChatModel = mutation({
  args: { key: vKey, id: v.id("conversations"), model: v.optional(v.string()), engine: v.optional(vEngine) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const chat = ownerChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, pickPatch(chat, args.model, args.engine, await engineFor(ctx, chat)));
    return null;
  },
});

/** Pick this chat's thinking level. Unset means the model's default. */
export const setChatEffort = mutation({
  args: { key: vKey, id: v.id("conversations"), effort: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const chat = ownerChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, { effort: args.effort?.trim().toLowerCase() || (chat.taskId ? "" : undefined) });
    return null;
  },
});

/** Ask, Auto or Full access for this chat, at once: a reply already running follows it too. */
export const setChatAccess = mutation({
  args: { key: vKey, id: v.id("conversations"), access: vAccess },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    ownerChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, { access: args.access });
    await accessChanged(ctx, args.id, args.access);
    return null;
  },
});

/** The access new chats start with, for Settings and the composer of a chat not yet sent. */
/**
 * A new chat starts on the owner's default engine, with the model and
 * thinking level of the chat on it written in last, so a pick carries over
 * without a setting of its own. A scheduled job's chat has its own model, and
 * is passed over. No engine while the owner has not chosen one.
 */
export const getLastPicks = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<{ engine?: EngineKind; model?: string; effort?: string }> => {
    assertDashboardKey(args.key);
    const engine = await defaultEngine(ctx);
    if (!engine) return {};
    const recent = await ctx.db.query("conversations")
      .withIndex("by_channel_last", (q) => q.eq("channel", WEB_CHANNEL))
      .order("desc")
      .take(20);
    // A chat sent from the composer always has its model; the welcome chat and the like leave it unset.
    const last = recent.find((chat) => !chat.jobId && chat.model && chat.engine === engine);
    return { engine, model: last?.model, effort: last?.effort };
  },
});

/** Quiet hours and the day's limit for Perry's own messages (notify.ts), and what is waiting because of them. */
export const getManners = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<{ quietHours?: { start: string; end: string }; dailyLimit?: number; waiting: number }> => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    const waiting = (await ctx.db.query("sent").withIndex("by_sent", (q) => q.eq("sentAt", undefined)).collect()).length;
    return { ...(install?.quietHours ? { quietHours: install.quietHours } : {}), ...(install?.dailyLimit ? { dailyLimit: install.dailyLimit } : {}), waiting };
  },
});

export const setManners = mutation({
  args: { key: vKey, quietHours: v.optional(v.object({ start: v.string(), end: v.string() })), dailyLimit: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.setManners, { quietHours: args.quietHours, dailyLimit: args.dailyLimit });
    return null;
  },
});

export const getDefaultAccess = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<Access> => {
    assertDashboardKey(args.key);
    return await defaultAccess(ctx);
  },
});

export const setDefaultAccess = mutation({
  args: { key: vKey, access: vAccess },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.setDefaultAccess, { access: args.access });
    return null;
  },
});

/** The engine Perry uses unless a chat or job picks another, for the welcome page, Settings and the composer. Null until chosen. */
export const getDefaultEngine = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<EngineKind | null> => {
    assertDashboardKey(args.key);
    return (await defaultEngine(ctx)) ?? null;
  },
});

/** The owner chose the default engine: new chats start on it, and chats that follow it move to it from their next turn. */
export const setDefaultEngine = mutation({
  args: { key: vKey, engine: vEngine },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.setDefaultEngine, { engine: args.engine });
    return null;
  },
});

// --- Keyboard shortcuts ----------------------------------------------------

export type ShortcutsView = {
  shortcuts: Shortcuts;
  /**
   * The desktop pet, as it last checked in: whether it is running, and each of its global shortcuts' standing, by id;
   * for Talk, why its keys can only be tapped (`hold`), where holding them does not work.
   */
  pet: { running: boolean; keys: Partial<Record<string, { hotkey?: string; error?: string; hold?: string }>> };
};

export const getShortcuts = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<ShortcutsView> => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    // The pet on Perry's own computer while it runs; otherwise the one heard from last, on another computer.
    const pets = (await ctx.db.query("petPresence").collect()).sort((a, b) => b.seenAt - a.seenAt);
    const pet = pets.find((row) => !row.device && Date.now() - row.seenAt < 150_000) ?? pets[0];
    return {
      shortcuts: resolveShortcuts(install?.shortcuts),
      pet: { running: Boolean(pet && Date.now() - pet.seenAt < 150_000), keys: { talk: { hotkey: pet?.hotkey, error: pet?.hotkeyError, hold: pet?.hotkeyHold }, ...pet?.keys } },
    };
  },
});

/** Change a shortcut, or with null put it back to its default. Two shortcuts cannot share keys. */
export const setShortcut = mutation({
  args: { key: vKey, id: v.string(), accelerator: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    if (!(SHORTCUT_IDS as string[]).includes(args.id)) throw new Error("There is no such shortcut.");
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    const saved = { ...install.shortcuts };
    if (args.accelerator === null) delete saved[args.id];
    else {
      const problem = problemWith(args.accelerator);
      if (problem) throw new Error(problem);
      const current = resolveShortcuts(saved);
      const clash = SHORTCUT_IDS.find((id) => id !== args.id && current[id] === args.accelerator);
      if (clash) throw new Error(`That is already the shortcut for ${SHORTCUTS[clash].label}.`);
      if (args.accelerator === SHORTCUTS[args.id as ShortcutId].default) delete saved[args.id];
      else saved[args.id] = args.accelerator;
    }
    await ctx.db.patch(install._id, { shortcuts: saved });
    return null;
  },
});

// --- Memories ------------------------------------------------------------

export type MemoryView = {
  id: string;
  forgetAt?: number;
  forgetError?: string;
  text: string;
  tags: string[];
  source: string;
  kind: "profile" | "core" | "daily";
  day?: string;
  origin?: "owner" | "tool" | "job";
  createdAt: number;
  editedAt?: number;
  /** Kept to one chat: that chat, and its title. */
  chatId?: string;
  chat?: string;
  /** Kept to a project: that project, and its name. */
  projectId?: string;
  project?: string;
};

export const listMemories = query({
  args: { key: vKey, query: v.optional(v.string()), kind: v.optional(vMemoryKind) },
  handler: async (ctx, args): Promise<MemoryView[]> => {
    assertDashboardKey(args.key);
    // Memories only: a page's lines are searched with them elsewhere (pages.search), not listed here.
    const found = await ctx.runQuery(internal.memories.search, {
      query: args.query ?? "",
      limit: 25,
      kind: args.kind,
      everywhere: true,
      memoriesOnly: true,
      // Older memories, from before they were lines in pages; those are read and edited in their pages.
      loose: true,
    }) as MemoryView[];
    // A memory kept to one chat or one project says which.
    return await Promise.all(found.map(async (memory) => {
      const stored = await ctx.db.get(memory.id as Id<"memories">);
      memory = { ...memory, forgetAt: stored?.forgetAt, forgetError: stored?.forgetError };
      if (memory.projectId) {
        const project = await ctx.db.get(memory.projectId as Id<"projects">);
        return { ...memory, project: project?.name ?? "a deleted project" };
      }
      if (!memory.chatId) return memory;
      const chat = await ctx.db.get(memory.chatId as Id<"conversations">);
      return { ...memory, chat: chat ? titleOf(chat) : "a deleted chat" };
    }));
  },
});

export const addMemory = mutation({
  args: { key: vKey, text: v.string(), tags: v.optional(v.array(v.string())), kind: v.optional(vMemoryKind) },
  /** Why the memory was refused, such as a full layer; null once saved. */
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args): Promise<string | null> => {
    assertDashboardKey(args.key);
    const text = args.text.trim();
    if (text.length === 0) return null;

    await ctx.runMutation(internal.memories.add, {
      text,
      tags: args.tags ?? [],
      source: "dashboard",
      kind: args.kind,
      origin: "owner",
      by: "owner",
    });
    return null;
  },
});

/** Change a memory's words; returns why not, such as a full layer, or null once saved. */
export const editMemory = mutation({
  args: { key: vKey, id: v.string(), text: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args): Promise<string | null> => {
    assertDashboardKey(args.key);
    const result: { saved: boolean; error?: string } = await ctx.runMutation(internal.memories.edit, { id: args.id, text: args.text });
    return result.error ?? null;
  },
});

export const deleteMemory = mutation({
  args: { key: vKey, id: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.memories.removeMany, { ids: [args.id] });
    return null;
  },
});

/** The server owns the deadline; a toast only offers the matching Undo action. */
export const forgetMemory = mutation({
  args: { key: vKey, id: v.id("memories") },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    assertDashboardKey(args.key);
    const memory = await ctx.db.get(args.id);
    if (!memory || memory.kind === "page") throw new Error("This memory is no longer available.");
    if (memory.forgetAt !== undefined) return memory.forgetAt;
    const at = Date.now() + 5_000;
    await ctx.db.patch(args.id, { forgetAt: at, forgetError: undefined });
    await ctx.scheduler.runAt(at, internal.dashboard.finishForgettingMemory, { id: args.id, at });
    return at;
  },
});

export const undoForgetMemory = mutation({
  args: { key: vKey, id: v.id("memories"), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    assertDashboardKey(args.key);
    const memory = await ctx.db.get(args.id);
    // A stale toast must never undo a later Forget, or extend the deadline.
    if (!memory || memory.forgetAt !== args.at || Date.now() >= args.at) return false;
    await ctx.db.patch(args.id, { forgetAt: undefined });
    return true;
  },
});

export const finishForgettingMemory = internalMutation({
  args: { id: v.id("memories"), at: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const memory = await ctx.db.get(args.id);
    if (!memory || memory.forgetAt !== args.at) return;
    try {
      await ctx.runMutation(internal.memories.removeMany, { ids: [args.id] });
    } catch {
      // The nested mutation rolls back on failure. Restore the row with an
      // error that is also visible after a reload, instead of hiding it forever.
      await ctx.db.patch(args.id, { forgetAt: undefined, forgetError: "Perry could not forget this memory. Try again." });
    }
  },
});

// --- Activity ------------------------------------------------------------

export type RunView = {
  id: string;
  sessionId: Id<"conversations">;
  threadId?: string;
  chatTitle: string;
  channel: string;
  prompt: string;
  status: string;
  steps?: number;
  toolCalls?: string[];
  model?: string;
  /** What it ran on, who chose it and why (lib/routing.ts). */
  route?: Doc<"runs">["route"];
  totalTokens?: number;
  usage?: Doc<"runs">["usage"];
  error?: string;
  startedAt: number;
  durationMs?: number;
};

export const listRuns = query({
  args: { key: vKey, conversationId: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<RunView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.runs.recent, { limit: 100, conversationId: args.conversationId });
  },
});

export type SpanView = {
  id: string;
  kind: Doc<"runSpans">["kind"];
  name: string;
  status: Doc<"runSpans">["status"];
  startedAt: number;
  durationMs?: number;
  input?: string;
  output?: string;
};

/** One run's trace, loaded only when its row is opened. */
export const runTrace = query({
  args: { key: vKey, runId: v.id("runs") },
  handler: async (ctx, args): Promise<SpanView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.runs.spans, { runId: args.runId });
  },
});

export const listActivitySessions = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<Array<{
    id: Id<"conversations">;
    title: string;
    channel: "telegram" | "web" | "whatsapp";
  }>> => {
    assertDashboardKey(args.key);
    const conversations: Doc<"conversations">[] = await ctx.runQuery(internal.conversations.list, {});
    return conversations.map((chat) => ({
      id: chat._id,
      title: chat.title ?? (chat.channel === "web" ? "Untitled chat" : "Telegram chat"),
      channel: chat.channel,
    }));
  },
});

export const getStatus = query({
  args: { key: vKey },
  handler: async (
    ctx,
    args,
  ): Promise<{
    memories: number;
    conversations: Array<{ channel: string; lastMessageAt: number }>;
    claimed: boolean;
    /** Telegram in particular; the install can be claimed on WhatsApp alone. */
    telegramPaired: boolean;
    ownerName?: string;
    /** What to call the owner: USER.md's "Call them", else their Telegram name. */
    displayName?: string;
    pairingCode?: string;
    pairingExpiresAt?: number;
    telegramConfigured: boolean;
    onboarding: Onboarding;
    assistantName: string;
    /** Unset until the owner chooses one: the welcome page asks first. */
    defaultEngine?: EngineKind;
  }> => {
    assertDashboardKey(args.key);

    const memories: number = await ctx.runQuery(internal.memories.count, {});
    const conversations = await ctx.runQuery(internal.conversations.list, {});
    const install = await ctx.runQuery(internal.installation.status, {});
    const persona = await readPersona(ctx);
    const telegramToken: string | null = await ctx.runQuery(
      internal.secrets.get,
      { name: "TELEGRAM_BOT_TOKEN" },
    );

    return {
      memories,
      conversations: conversations.map((c) => ({
        channel: c.channel,
        lastMessageAt: c.lastMessageAt,
      })),
      claimed: install.claimed,
      telegramPaired: install.claimed && install.ownerChannel === "telegram",
      ownerName: install.ownerName,
      displayName: callName(persona.user) ?? install.ownerName,
      pairingCode: install.pairingCode,
      pairingExpiresAt: install.pairingExpiresAt,
      telegramConfigured: Boolean(telegramToken),
      onboarding: install.onboarding,
      assistantName: persona.name,
      ...(install.defaultEngine ? { defaultEngine: install.defaultEngine } : {}),
    };
  },
});

// --- Getting to know each other -------------------------------------------

/**
 * Written as the owner's turn but never shown as one: it asks for the first
 * reply in the chat the welcome page lands on (see codex.finalizeTurn).
 */
const GREETING = `
(This is not a message from the owner. They have just finished the welcome
page, where they chose your name and personality and wrote USER.md, which is
at the end of your instructions. This chat is where they land.)

Greet them by what they asked to be called, in your personality, in two or
three short sentences. Show you have read USER.md by picking up one or two
specifics, not by summarising it. Then offer one concrete thing you could do
for them right now, based on what they want help with, or ask the one
question that would help you most. Do not call any tools for this reply.
`.trim();

/** The same, when the owner would rather talk than fill in the welcome page. */
const INTERVIEW = `
(This is not a message from the owner. They opened the welcome page and chose
to get to know each other by chatting instead of filling it in. This chat is
where they land.)

Introduce yourself in one or two sentences, in your personality, and say you
would like to learn a little about them so you can be useful. Then ask about
one thing at a time, and wait for each answer: what to call them, what they
do, what a typical day looks like, the people who matter to them, how they
like replies, and what they most want help with. Keep it light; they can stop
whenever they like. As you learn things, write them into USER.md with
update_user_md, under short headings, and tell them it is there to read and
edit under Profile, About you. Do not call any tools for this first reply.
`.trim();

async function startWelcomeChat(
  ctx: MutationCtx,
  options: { title: string; prompt: string; label: string },
): Promise<Id<"conversations">> {
  const threadId = await createThread(ctx, { userId: "web:dashboard", title: options.title });
  const engine = await defaultEngine(ctx);
  const id = await ctx.db.insert("conversations", {
    channel: WEB_CHANNEL,
    externalId: `session:${threadId}`,
    threadId,
    title: options.title,
    ...(engine ? { engine } : {}),
    access: await defaultAccess(ctx),
    lastMessageAt: Date.now(),
    pendingTurns: 1,
  });
  await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
    channel: WEB_CHANNEL,
    externalId: `session:${threadId}`,
    text: options.prompt,
    title: options.title,
    hidden: true,
    label: options.label,
  });
  return id;
}

export type PersonaView = Persona & { defaultName: string };

export const getPersona = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<PersonaView> => {
    assertDashboardKey(args.key);
    return { ...(await readPersona(ctx)), defaultName: DEFAULT_NAME };
  },
});

export const personaHistory = query({
  args: { key: vKey, kind: v.union(v.literal("user"), v.literal("identity")) },
  handler: async (ctx, args): Promise<PersonaVersion[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.persona.history, { kind: args.kind, limit: 50 });
  },
});

/** USER.md from the About you page, saved as the owner types: the same words again change nothing, and a sitting's saves are one version. */
export const saveUserMd = mutation({
  args: { key: vKey, text: v.string() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.persona.writeUser, { text: args.text, by: "owner", typing: true });
  },
});

/** The assistant's name, its personality or both, saved as typed like USER.md; what is not given stays as it is. */
export const saveIdentity = mutation({
  args: { key: vKey, name: v.optional(v.string()), personality: v.optional(v.string()) },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.persona.writeIdentity, { name: args.name, personality: args.personality, by: "owner", typing: true });
  },
});

export const restorePersonaVersion = mutation({
  args: { key: vKey, id: v.id("persona") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.persona.restore, { id: args.id });
  },
});

/**
 * The welcome page's last step: save who the assistant is and USER.md, then
 * open the chat it lands on, where the assistant speaks first. Without
 * userMd, the owner chose to chat instead, and the assistant asks.
 */
export const finishOnboarding = mutation({
  args: { key: vKey, name: v.string(), personality: v.string(), userMd: v.optional(v.string()) },
  returns: v.id("conversations"),
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.persona.writeIdentity, { name: args.name, personality: args.personality, by: "owner" });
    const userMd = args.userMd?.trim();
    if (userMd) await ctx.runMutation(internal.persona.writeUser, { text: userMd, by: "owner" });
    await ctx.runMutation(internal.installation.setOnboarding, { state: "done" });
    return await startWelcomeChat(ctx, userMd
      ? { title: "Welcome", prompt: GREETING, label: "Welcome greeting" }
      : { title: "Getting to know you", prompt: INTERVIEW, label: "Getting to know you" });
  },
});

/** Not now: the dashboard opens on chat, and About you can start it again. */
export const skipOnboarding = mutation({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.setOnboarding, { state: "skipped" });
    return null;
  },
});

/** Go through the welcome page again; what it saves becomes the newest version. */
export const redoOnboarding = mutation({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.setOnboarding, { state: "pending" });
    return null;
  },
});

/** Mint a fresh pairing code, for a first claim or to move Assistant to a new chat. */
export const startPairing = mutation({
  args: { key: vKey },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.installation.startPairing, {});
  },
});

/** Release ownership. The next correct pairing code claims Assistant again. */
export const unclaim = mutation({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.unclaim, {});
    return null;
  },
});

// --- Work ----------------------------------------------------------------

export type WorkView = {
  tasks: Doc<"tasks">[];
  goals: Doc<"goals">[];
  monitors: Doc<"monitors">[];
};

export const getWork = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<WorkView> => {
    assertDashboardKey(args.key);

    const tasks: Doc<"tasks">[] = await ctx.runQuery(internal.work.listTasks, {
      limit: 25,
    });
    const goals: Doc<"goals">[] = await ctx.runQuery(internal.work.listGoals, {});
    const monitors: Doc<"monitors">[] = await ctx.runQuery(
      internal.work.listMonitors,
      {},
    );

    return { tasks, goals, monitors };
  },
});

export const toggleMonitor = mutation({
  args: { key: vKey, monitorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.work.toggleMonitor, {
      monitorId: args.monitorId,
    });
    return null;
  },
});

export const deleteMonitor = mutation({
  args: { key: vKey, monitorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.work.deleteMonitor, {
      monitorId: args.monitorId,
    });
    return null;
  },
});

/** A goal made or changed on the Work page. */
export const saveGoal = mutation({
  args: {
    key: vKey,
    id: v.optional(v.id("goals")),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"), v.literal("done"))),
    milestones: v.array(v.object({ title: v.string(), done: v.boolean() })),
  },
  returns: v.id("goals"),
  handler: async (ctx, args): Promise<Id<"goals">> => {
    assertDashboardKey(args.key);
    const { key: _key, ...goal } = args;
    return await ctx.runMutation(internal.work.saveGoal, goal);
  },
});

/** A page watch made or changed on the Work page, with the checks the agent's watch_page makes. One made here reports to the owner's messaging app. */
export const saveMonitor = mutation({
  args: {
    key: vKey,
    id: v.optional(v.id("monitors")),
    title: v.string(),
    url: v.string(),
    condition: v.union(v.literal("change"), v.literal("contains"), v.literal("price_below")),
    value: v.optional(v.string()),
    intervalMinutes: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const { key: _key, id, ...watch } = args;
    const url = watch.url.trim();
    if (id) {
      await ctx.runMutation(internal.work.updateMonitor, { id, ...watch, url });
      return null;
    }
    const value = watch.condition === "change" ? undefined : watch.value?.trim();
    const problem = watchProblem({ url, condition: watch.condition, value });
    if (problem) throw new Error(problem);
    await ctx.runMutation(internal.work.createMonitor, { ...watch, url, value, title: watch.title.trim() || new URL(url).hostname });
    return null;
  },
});

export const cancelTask = mutation({
  args: { key: vKey, taskId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.work.updateTask, {
      taskId: args.taskId,
      status: "cancelled",
    });
    return null;
  },
});

/** Run every due monitor now, instead of waiting for the next tick. */
export const checkMonitorsNow = action({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    if (await ctx.runQuery(internal.pause.state, {})) throw new Error(PAUSED_ERROR);
    await ctx.runAction(internal.web.checkMonitors, {});
    return null;
  },
});

// --- Needs you -------------------------------------------------------------

/**
 * What is waiting on the owner, other than approvals (approvals.pending): a
 * plan blocked on a question, work that failed, a scheduled job's news or
 * error, and a watch that fired. Each stays until it is dealt with or dismissed.
 */
export type InboxItem =
  | { kind: "question"; id: Id<"tasks">; title: string; text: string; at: number }
  | { kind: "task-failed"; id: Id<"tasks">; title: string; text: string; at: number }
  | { kind: "job-error"; id: Id<"jobs">; title: string; text: string; at: number; chatId?: Id<"conversations"> }
  | { kind: "job-result"; id: Id<"jobs">; title: string; text: string; at: number; chatId: Id<"conversations"> }
  | { kind: "watch"; id: Id<"monitors">; title: string; text: string; at: number; url: string };

export const getInbox = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<InboxItem[]> => {
    assertDashboardKey(args.key);
    const items: InboxItem[] = [];
    for (const task of await ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", "blocked")).collect()) {
      if (task.question) items.push({ kind: "question", id: task._id, title: task.title, text: task.question, at: task.updatedAt });
    }
    for (const task of await ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", "failed")).collect()) {
      if ((task.seenAt ?? 0) < task.updatedAt) items.push({ kind: "task-failed", id: task._id, title: task.title, text: task.error ?? "It stopped without saying why.", at: task.updatedAt });
    }
    for (const job of await ctx.db.query("jobs").collect()) {
      const ranAt = job.lastRunAt ?? 0;
      if (job.lastError && (job.seenAt ?? 0) < ranAt) {
        items.push({ kind: "job-error", id: job._id, title: job.name, text: job.lastError, at: ranAt, chatId: job.conversationId });
        continue;
      }
      const chat = job.conversationId ? await ctx.db.get(job.conversationId) : null;
      if (chat && job.lastResult && isUnseen(chat, job)) {
        items.push({ kind: "job-result", id: job._id, title: job.name, text: job.lastResult, at: chat.lastMessageAt, chatId: chat._id });
      }
    }
    for (const monitor of await ctx.db.query("monitors").collect()) {
      if (monitor.firedAt && (monitor.seenAt ?? 0) < monitor.firedAt) {
        items.push({ kind: "watch", id: monitor._id, title: monitor.title, text: monitor.lastObservation ?? "Its condition was met.", at: monitor.firedAt, url: monitor.url });
      }
    }
    return items.sort((a, b) => b.at - a.at);
  },
});

/** Dismiss items from Needs you. A question is answered in chat, not dismissed. */
export const dismissInbox = mutation({
  args: {
    key: vKey,
    items: v.array(v.object({
      kind: v.union(v.literal("task-failed"), v.literal("job-error"), v.literal("job-result"), v.literal("watch")),
      id: v.string(),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const now = Date.now();
    for (const item of args.items) {
      if (item.kind === "task-failed") {
        const id = ctx.db.normalizeId("tasks", item.id);
        if (id) await ctx.db.patch(id, { seenAt: now });
      } else if (item.kind === "watch") {
        const id = ctx.db.normalizeId("monitors", item.id);
        if (id) await ctx.db.patch(id, { seenAt: now });
      } else {
        const id = ctx.db.normalizeId("jobs", item.id);
        const job = id ? await ctx.db.get(id) : null;
        if (!job) continue;
        if (item.kind === "job-error") await ctx.db.patch(job._id, { seenAt: now });
        else if (job.conversationId && await ctx.db.get(job.conversationId)) await ctx.db.patch(job.conversationId, { seenAt: now });
      }
    }
    return null;
  },
});

// --- Compute -------------------------------------------------------------

export type ComputeView = {
  /** Approval requests go to Telegram only when the owner is there and has not turned it off. */
  telegramApprovals: { ownerOnTelegram: boolean; enabled: boolean };
  runners: Array<{
    id: string;
    name: string;
    platform?: string;
    workdir?: string;
    policy: Policy;
    online: boolean;
    lastSeenAt?: number;
    revoked: boolean;
  }>;
};

export const getCompute = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<ComputeView> => {
    assertDashboardKey(args.key);

    const install = await ctx.runQuery(internal.installation.get, {});
    const runners: Doc<"runners">[] = await ctx.runQuery(
      internal.runner.listRunners,
      {},
    );

    const cutoff = Date.now() - 90_000;

    return {
      telegramApprovals: {
        ownerOnTelegram: Boolean(install?.claimedAt) && install?.ownerChannel === "telegram",
        enabled: install?.telegramApprovals !== false,
      },
      runners: runners.map((r) => ({
        id: r._id,
        name: r.name,
        platform: r.platform,
        workdir: r.workdir,
        policy: policyOf(r),
        online: !r.revoked && (r.lastSeenAt ?? 0) > cutoff,
        lastSeenAt: r.lastSeenAt,
        revoked: r.revoked,
      })),
    };
  },
});

/** What a runner does before acting: ask the owner, have Codex review first, or trust it. */
export const setRunnerPolicy = mutation({
  args: { key: vKey, runnerId: v.string(), policy: vPolicy },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.runner.setPolicy, { runnerId: args.runnerId, policy: args.policy });
    return null;
  },
});

export const setTelegramApprovals = mutation({
  args: { key: vKey, enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.setTelegramApprovals, { enabled: args.enabled });
    return null;
  },
});

/** Cut a machine loose. The runner's next call fails and it stops getting work. */
export const revokeRunner = mutation({
  args: { key: vKey, runnerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.runner.revokeRunner, {
      runnerId: args.runnerId,
    });
    return null;
  },
});

// --- Connected accounts --------------------------------------------------

export const getInternetStatus = action({
  args: { key: vKey, recheck: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ReturnType<typeof diagnostics>> => {
    assertDashboardKey(args.key);
    if (args.recheck) recheckInternetConnections();
    const configured = Boolean(await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" }));
    return diagnostics(configured, Boolean(findBrowser()));
  },
});

export const getConnectors = action({
  args: { key: vKey },
  handler: async (
    ctx,
    args,
  ): Promise<{
    configured: boolean;
    connectors: Array<{
      slug: string;
      name: string;
      connected: boolean;
      status?: string;
      needsAuth: boolean;
    }>;
    error?: string;
  }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.connectors, {});
  },
});

/** Each connection, with the account it is signed in to. */
export const getConnectedAccounts = action({
  args: { key: vKey },
  handler: async (ctx, args): Promise<{ configured: boolean; accounts: ConnectedAccount[]; error?: string }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.accounts, {});
  },
});

/** Every app that can be connected, for Apps & skills → Connectors to search. */
export const getCatalog = action({
  args: { key: vKey },
  handler: async (ctx, args): Promise<{ apps: CatalogApp[]; error?: string }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.catalog, {});
  },
});

export const disconnectAccount = action({
  args: { key: vKey, accountId: v.string() },
  handler: async (ctx, args): Promise<{ error?: string }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.disconnect, { accountId: args.accountId });
  },
});

/** Returns a URL for the owner to open and finish OAuth in their browser. */
export const connectToolkit = action({
  args: { key: vKey, toolkit: v.string(), callbackUrl: v.optional(v.string()), accountId: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ redirectUrl?: string; status?: string; error?: string }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.authorize, {
      toolkit: args.toolkit,
      callbackUrl: args.callbackUrl,
      accountId: args.accountId,
    });
  },
});

/** Lets the owner see exactly which operations a connection exposes. */
export const searchActions = action({
  args: { key: vKey, query: v.string(), toolkits: v.optional(v.array(v.string())) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    actions: Array<{
      slug: string;
      description?: string;
      toolkit?: string;
      inputSchema?: unknown;
    }>;
    error?: string;
  }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.search, {
      query: args.query,
      toolkits: args.toolkits,
    });
  },
});

// --- Keys ----------------------------------------------------------------

export type SecretView = {
  name: string;
  label: string;
  hint: string;
  set: boolean;
  source: "dashboard" | "environment" | "none";
  preview?: string;
  updatedAt?: number;
};

/**
 * Never returns a key, only whether one exists, where it came from, and its
 * last four characters. Enough to tell two keys apart, not enough to use one.
 */
export const getKeys = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<SecretView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.secrets.status, {});
  },
});

export const setKey = mutation({
  args: { key: vKey, name: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.secrets.set, {
      name: args.name,
      value: args.value,
    });
    return null;
  },
});

export const clearKey = mutation({
  args: { key: vKey, name: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.secrets.clear, { name: args.name });
    return null;
  },
});

/** The owner's saved logins and secrets, without their values. See vault.ts. */
export const getVault = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<VaultEntry[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.vault.list, {});
  },
});

/** Add a login, or replace the one with the same name and username. */
export const saveToVault = mutation({
  args: { key: vKey, label: v.string(), url: v.optional(v.string()), username: v.optional(v.string()), value: v.string(), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, ...entry }): Promise<null> => {
    assertDashboardKey(key);
    await ctx.runMutation(internal.vault.save, { ...entry, by: "owner" });
    return null;
  },
});

export const removeFromVault = mutation({
  args: { key: vKey, id: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.vault.remove, { id: args.id });
    return null;
  },
});

/**
 * Whether the saved bot token works. Perry polls Telegram with it on its own
 * (server/telegram.ts), so there is nothing to register; this only asks
 * Telegram who the bot is, so a wrong token shows up here and not as silence.
 */
export const checkBot = action({
  args: { key: vKey },
  handler: async (ctx, args): Promise<{ ok: boolean; bot?: string; error?: string }> => {
    assertDashboardKey(args.key);
    const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
    if (!token) return { ok: false, error: "No bot token set." };
    try {
      const me = await fetch(`${(process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "")}/bot${token}/getMe`)
        .then((r) => r.json() as Promise<{ ok?: boolean; description?: string; result?: { username?: string } }>);
      return me.ok ? { ok: true, bot: me.result?.username } : { ok: false, error: me.description ?? "Telegram refused the token." };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
