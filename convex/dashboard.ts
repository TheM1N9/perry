import { createThread, deleteMessages, deleteThread, listMessages, saveMessages, searchMessages } from "./lib/agent";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, mutation, query, type MutationCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { ABSOLUTE_PATH } from "./media";
import { defaultAccess, type Onboarding } from "./installation";
import { DEFAULT_NAME, readPersona, type Persona, type PersonaVersion } from "./persona";
import type { Access } from "./lib/commands";
import { policyOf, type Policy } from "./runner";
import { vAccess, vMemoryKind, vPolicy } from "./schema";
import { APPROVAL_TTL_MS } from "./approvals";
import { QUIET } from "./jobs";

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
  role: string;
  text: string;
  createdAt: number;
  attachments: Array<{ url: string; fileName: string; contentType: string }>;
};

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

/** What a chat is doing, for the dot beside it: waiting on the owner comes first. */
export type ChatStatus = "needs-approval" | "running" | "error" | "idle";

export type ChatSummary = {
  id: Id<"conversations">;
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
    const chats = await ctx.db.query("conversations")
      .withIndex("by_channel_last", (q) => q.eq("channel", WEB_CHANNEL))
      .order("desc")
      .collect();
    const asking = new Set((await ctx.db.query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending").gt("createdAt", Date.now() - APPROVAL_TTL_MS))
      .collect()).map((row) => row.conversationId));
    const jobs = new Map((await ctx.db.query("jobs").collect()).map((job) => [job._id, job]));
    const summaries = await Promise.all(chats.map(async (chat): Promise<ChatSummary> => {
      const running = (chat.pendingTurns ?? 0) > 0;
      const latestRun = running || asking.has(chat._id) ? null : await ctx.db.query("runs")
        .withIndex("by_conversation", (q) => q.eq("conversationId", chat._id))
        .order("desc")
        .first();
      return {
        id: chat._id,
        title: chat.title ?? "Untitled chat",
        lastMessageAt: chat.lastMessageAt,
        parentConversationId: chat.parentConversationId,
        branchedFromMessageId: chat.branchedFromMessageId,
        status: asking.has(chat._id) ? "needs-approval" : running ? "running" : latestRun?.status === "error" ? "error" : "idle",
        pinned: chat.pinnedAt !== undefined,
        jobId: chat.jobId,
        unseen: isUnseen(chat, chat.jobId ? jobs.get(chat.jobId) : undefined),
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
    webChat(await ctx.db.get(args.id));
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
    const chat = webChat(await ctx.db.get(args.id));
    if ((chat.seenAt ?? 0) < chat.lastMessageAt) await ctx.db.patch(args.id, { seenAt: Date.now() });
    return null;
  },
});

export const createChat = mutation({
  args: { key: vKey },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const threadId = await createThread(ctx, { userId: "web:dashboard", title: "New chat" });
    return await ctx.db.insert("conversations", {
      channel: WEB_CHANNEL,
      externalId: `session:${threadId}`,
      threadId,
      title: "New chat",
      access: await defaultAccess(ctx),
      lastMessageAt: Date.now(),
    });
  },
});

export const renameChat = mutation({
  args: { key: vKey, id: v.id("conversations"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.id));
    const title = args.title.trim().slice(0, 100);
    if (!title) throw new Error("Enter a chat name.");
    await ctx.db.patch(args.id, { title });
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
    for (const run of runs) {
      const spans = await ctx.db.query("runSpans").withIndex("by_run", (q) => q.eq("runId", run._id)).collect();
      for (const span of spans) await ctx.db.delete(span._id);
      await ctx.db.delete(run._id);
    }
    const attachments = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    for (const attachment of attachments) {
      // Local files stay where they are on the owner's machine; Convex cannot reach them.
      if (attachment.storageId) await ctx.storage.delete(attachment.storageId);
      await ctx.db.delete(attachment._id);
    }
    await ctx.runMutation(internal.codex.pruneOrphans, { conversationId: args.id });
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
    const [chats, messages] = await Promise.all([
      ctx.runQuery(internal.conversations.listWeb, {}),
      searchMessages(ctx, { userId: "web:dashboard", text: args.search.trim(), limit: 100 }),
    ]);
    const snippets = new Map<string, string>(messages.map((message) => [message.threadId, message.text ?? ""]));
    return chats.filter((chat) =>
      (chat.title ?? "").toLocaleLowerCase().includes(needle) || snippets.has(chat.threadId),
    ).slice(0, 30).map((chat) => ({
      id: chat._id,
      title: chat.title ?? "Untitled chat",
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
  ): Promise<{ model?: string; effort?: string; access: Access; title: string; isRunning: boolean; streaming?: string; lastError?: string }> => {
    assertDashboardKey(args.key);
    const conversation = webChat(await ctx.db.get(args.id));
    const isRunning = (conversation.pendingTurns ?? 0) > 0;
    const latestRun = await ctx.db.query("runs")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .order("desc")
      .first();
    const running = isRunning
      ? await ctx.db.query("codexTurns")
        .withIndex("by_conversation_status", (q) => q.eq("conversationId", args.id).eq("status", "running"))
        .first()
      : null;
    return {
      model: conversation.model,
      effort: conversation.effort,
      access: conversation.access ?? "supervised",
      title: conversation.title ?? "Untitled chat",
      isRunning,
      // The flush before /reset works quietly.
      streaming: running?.flush ? undefined : running?.partial,
      lastError: latestRun?.status === "error" ? latestRun.error : undefined,
    };
  },
});

export const getChatMessages = query({
  args: { key: vKey, id: v.id("conversations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const conversation = webChat(await ctx.db.get(args.id));
    const page = await listMessages(ctx, {
      threadId: conversation.threadId,
      excludeToolMessages: true,
      paginationOpts: args.paginationOpts,
    });
    const attachments = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    const attachmentMap = new Map<string, Array<{ url: string; fileName: string; contentType: string }>>();
    for (const attachment of attachments) {
      // Local media is served by the Next.js server on the owner's machine.
      const url = attachment.localPath
        ? `/api/media/${attachment._id}`
        : attachment.storageId ? await ctx.storage.getUrl(attachment.storageId) : null;
      if (!url) continue;
      const list = attachmentMap.get(attachment.messageKey) ?? [];
      list.push({ url, fileName: attachment.fileName, contentType: attachment.contentType });
      attachmentMap.set(attachment.messageKey, list);
    }
    // Earlier Codex turns could finish before their media was uploaded. When
    // recovered later, their saved assistant message has no attachment marker.
    const codexTurns = await ctx.db.query("codexTurns")
      .withIndex("by_conversation_status", (q) => q.eq("conversationId", args.id))
      .collect();
    return {
      ...page,
      page: page.page.map((doc): ChatMessage => {
        const raw = typeof doc.text === "string" ? doc.text : "";
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
          role: doc.message?.role ?? "assistant",
          text: (marker ? raw.slice(0, marker.index).trimEnd() : raw),
          createdAt: doc._creationTime,
          attachments: messageKey
            ? attachmentMap.get(messageKey) ?? []
            : recovered
              ? attachmentMap.get(`codex-${recovered._id}`) ?? []
              : doc.message?.role === "assistant" ? assistantMedia(raw) : [],
        };
      }).filter((message) => message.text.trim().length > 0 || message.attachments.length > 0),
    };
  },
});

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
  },
  returns: v.id("chatAttachments"),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.conversationId));
    if (!args.fileName.trim() || args.size <= 0 || args.size > 50 * 1024 * 1024) {
      throw new Error("Attachments must be between 1 byte and 50 MB.");
    }
    if (Boolean(args.storageId) === Boolean(args.localPath)) throw new Error("Attach either an upload or a local file.");
    if (args.localPath && !ABSOLUTE_PATH.test(args.localPath)) throw new Error("Local files need an absolute path.");
    const stored = args.storageId ? await ctx.storage.getMetadata(args.storageId) : null;
    if (args.storageId && !stored) throw new Error("Upload could not be found.");
    return await ctx.db.insert("chatAttachments", {
      conversationId: args.conversationId,
      messageKey: args.messageKey,
      storageId: args.storageId,
      localPath: args.localPath,
      fileName: args.fileName.trim().slice(0, 200),
      contentType: args.contentType || stored?.contentType || "application/octet-stream",
      size: args.size,
      createdAt: Date.now(),
    });
  },
});

export const sendChat = mutation({
  args: {
    key: vKey,
    id: v.id("conversations"),
    text: v.string(),
    attachmentIds: v.optional(v.array(v.id("chatAttachments"))),
    messageKey: v.optional(v.string()),
    /** The Codex model picked in the composer. Unset keeps the chat's current one. */
    model: v.optional(v.string()),
    /** Picked in the composer before the chat existed; "" is the model's default. Unset keeps the chat's. */
    effort: v.optional(v.string()),
    access: v.optional(vAccess),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);

    const text = args.text.trim();
    const attachmentIds = args.attachmentIds ?? [];
    if (text.length === 0 && attachmentIds.length === 0) return null;
    const chat = webChat(await ctx.db.get(args.id));
    const messageKey = args.messageKey?.trim() || crypto.randomUUID();
    const attachments = await Promise.all(attachmentIds.map((id) => ctx.db.get(id)));
    if (attachments.some((attachment) => !attachment || attachment.conversationId !== args.id || attachment.messageKey !== messageKey)) {
      throw new Error("One of the attachments is no longer available.");
    }
    const prompt = attachmentIds.length > 0
      ? `${text}\n\n<!-- attachments: ${messageKey} -->`.trim()
      : text;
    await ctx.db.patch(args.id, {
      lastMessageAt: Date.now(),
      title: chat.title === "New chat" ? (text || "Attached files").slice(0, 80) : chat.title,
      pendingTurns: (chat.pendingTurns ?? 0) + 1,
      ...(args.model !== undefined ? { model: args.model.trim() || undefined } : {}),
      ...(args.effort !== undefined ? { effort: args.effort.trim() || undefined } : {}),
      ...(args.access !== undefined ? { access: args.access } : {}),
    });

    // Sent while a reply is running, this joins that reply (see codex.enqueueTurn).
    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: WEB_CHANNEL,
      externalId: chat.externalId,
      text: prompt,
      title: chat.title,
      attachmentIds,
    });
    return null;
  },
});

/**
 * Regenerate a reply, or edit a message you sent. Given an assistant reply,
 * the message you sent before it is sent again as it was; given one of your
 * messages and new text, that is sent instead. Either way the message and
 * everything after it are removed first, attachments are kept, and Codex
 * starts from a fresh thread seeded with the history that remains.
 */
export const rewindChat = action({
  args: { key: vKey, id: v.id("conversations"), messageId: v.string(), text: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const chat = await ctx.runQuery(internal.conversations.getWebById, { id: args.id });
    if (!chat) throw new Error("This chat was deleted.");

    // Newest first, until the target message and the message you sent at or before it.
    const newest: Array<{ _id: string; order: number; message?: { role: string }; text?: string }> = [];
    let cursor: string | null = null;
    let target: (typeof newest)[number] | undefined;
    let sent: (typeof newest)[number] | undefined;
    while (!sent) {
      const page = await listMessages(ctx, { threadId: chat.threadId, paginationOpts: { cursor, numItems: 100 } });
      for (const message of page.page) {
        newest.push(message);
        if (message._id === args.messageId) target = message;
        if (target && message.message?.role === "user") { sent = message; break; }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (!target || !sent) throw new Error("That message is no longer in this chat.");
    if (args.text !== undefined && target.message?.role !== "user") throw new Error("Only your own messages can be edited.");

    const raw = typeof sent.text === "string" ? sent.text : "";
    const marker = raw.match(/\n?<!-- attachments:([^>]+) -->\s*$/);
    const messageKey = marker?.[1]?.trim();
    const original = marker ? raw.slice(0, marker.index).trimEnd() : raw;
    const text = (args.text ?? original).trim();
    const attachmentIds = messageKey
      ? await ctx.runQuery(internal.conversations.attachmentIdsFor, { conversationId: chat._id, messageKey })
      : [];
    if (!text && attachmentIds.length === 0) throw new Error("The message is empty.");

    await ctx.runMutation(internal.conversations.rewind, { id: chat._id });
    const replaced = newest.filter((message) => message.order >= sent!.order).map((message) => message._id);
    for (let start = 0; start < replaced.length; start += 100) {
      await deleteMessages(ctx, replaced.slice(start, start + 100));
    }
    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: WEB_CHANNEL,
      externalId: chat.externalId,
      text: messageKey ? `${text}\n\n<!-- attachments: ${messageKey} -->`.trim() : text,
      title: chat.title,
      attachmentIds,
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
    webChat(await ctx.db.get(args.id));
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

/** /compact: summarise the chat's Codex thread. Null when there is nothing to compact yet. */
export const compactChat = mutation({
  args: { key: vKey, id: v.id("conversations") },
  returns: v.union(v.null(), v.id("codexTurns")),
  handler: async (ctx, args): Promise<Id<"codexTurns"> | null> => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.id));
    return await ctx.runMutation(internal.codex.requestCompact, { conversationId: args.id });
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

/** Pick this chat's Codex model. Unset means the Codex default. */
export const setChatModel = mutation({
  args: { key: vKey, id: v.id("conversations"), model: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, { model: args.model?.trim() || undefined });
    return null;
  },
});

/** Pick this chat's thinking level. Unset means the model's default. */
export const setChatEffort = mutation({
  args: { key: vKey, id: v.id("conversations"), effort: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, { effort: args.effort?.trim().toLowerCase() || undefined });
    return null;
  },
});

/** Supervised or Full access for this chat, from its next turn. */
export const setChatAccess = mutation({
  args: { key: vKey, id: v.id("conversations"), access: vAccess },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, { access: args.access });
    return null;
  },
});

/** The access new chats start with, for Settings and the composer of a chat not yet sent. */
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

// --- Memories ------------------------------------------------------------

export type MemoryView = {
  id: string;
  text: string;
  tags: string[];
  source: string;
  kind: "profile" | "core" | "daily";
  day?: string;
  origin?: "owner" | "tool" | "job";
  createdAt: number;
  editedAt?: number;
};

export const listMemories = query({
  args: { key: vKey, query: v.optional(v.string()), kind: v.optional(vMemoryKind) },
  handler: async (ctx, args): Promise<MemoryView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.memories.search, {
      query: args.query ?? "",
      limit: 25,
      kind: args.kind,
    });
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

    const result: { error?: string } = await ctx.runMutation(internal.memories.add, {
      text,
      tags: args.tags ?? [],
      source: "dashboard",
      kind: args.kind,
      origin: "owner",
    });
    return result.error ?? null;
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
    channel: "telegram" | "web";
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
    ownerName?: string;
    pairingCode?: string;
    pairingExpiresAt?: number;
    telegramConfigured: boolean;
    onboarding: Onboarding;
    assistantName: string;
  }> => {
    assertDashboardKey(args.key);

    const memories: number = await ctx.runQuery(internal.memories.count, {});
    const conversations = await ctx.runQuery(internal.conversations.list, {});
    const install = await ctx.runQuery(internal.installation.status, {});
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
      ownerName: install.ownerName,
      pairingCode: install.pairingCode,
      pairingExpiresAt: install.pairingExpiresAt,
      telegramConfigured: Boolean(telegramToken),
      onboarding: install.onboarding,
      assistantName: (await readPersona(ctx)).name,
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
  const id = await ctx.db.insert("conversations", {
    channel: WEB_CHANNEL,
    externalId: `session:${threadId}`,
    threadId,
    title: options.title,
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

export const saveUserMd = mutation({
  args: { key: vKey, text: v.string() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.persona.writeUser, { text: args.text, by: "owner" });
  },
});

export const saveIdentity = mutation({
  args: { key: vKey, name: v.string(), personality: v.string() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.persona.writeIdentity, { name: args.name, personality: args.personality, by: "owner" });
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

/** Returns a URL for the owner to open and finish OAuth in their browser. */
export const connectToolkit = action({
  args: { key: vKey, toolkit: v.string(), callbackUrl: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ redirectUrl?: string; status?: string; error?: string }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.authorize, {
      toolkit: args.toolkit,
      callbackUrl: args.callbackUrl,
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
