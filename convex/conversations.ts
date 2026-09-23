import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { vChannel } from "./schema";

/**
 * Rewind a web chat for a regenerate or an edit: its Codex thread has seen the
 * turns being replaced and cannot drop them, so the next turn starts a fresh
 * Codex thread seeded with the chat's remaining history.
 */
export const rewind = internalMutation({
  args: { id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.id);
    if (!chat) throw new Error("This chat was deleted.");
    if ((chat.pendingTurns ?? 0) > 0) throw new Error("Wait for the reply to finish, or stop it first.");
    await ctx.db.patch(args.id, {
      codexThreadId: undefined,
      pendingTurns: 1,
      lastMessageAt: Date.now(),
    });
    return null;
  },
});

export const attachmentIdsFor = internalQuery({
  args: { conversationId: v.id("conversations"), messageKey: v.string() },
  handler: async (ctx, args) => (await ctx.db.query("chatAttachments")
    .withIndex("by_message", (q) => q.eq("conversationId", args.conversationId).eq("messageKey", args.messageKey))
    .collect()).map((row) => row._id),
});

/** A chat's Codex model, set with /model. Unset means the Codex default. */
export const setModel = internalMutation({
  args: { id: v.id("conversations"), model: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { model: args.model });
    return null;
  },
});

export const getByExternalId = internalQuery({
  args: { channel: vChannel, externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_channel_external", (q) =>
        q.eq("channel", args.channel).eq("externalId", args.externalId),
      )
      .unique();
  },
});

/**
 * Create the conversation row for an already-created agent thread.
 *
 * Re-checks for an existing row first: two messages arriving at once would
 * otherwise each create a thread and the history would fork silently. The
 * loser's thread is left orphaned, which is cheap and harmless.
 */
export const create = internalMutation({
  args: {
    channel: vChannel,
    externalId: v.string(),
    threadId: v.string(),
    title: v.optional(v.string()),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_channel_external", (q) =>
        q.eq("channel", args.channel).eq("externalId", args.externalId),
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("conversations", {
      channel: args.channel,
      externalId: args.externalId,
      threadId: args.threadId,
      title: args.title,
      lastMessageAt: Date.now(),
    });
  },
});


export const touch = internalMutation({
  args: { id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { lastMessageAt: Date.now() });
    return null;
  },
});

export const finishWebTurn = internalMutation({
  args: { id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.id);
    if (chat?.channel === "web") {
      await ctx.db.patch(args.id, { pendingTurns: Math.max(0, (chat.pendingTurns ?? 0) - 1) });
    }
    return null;
  },
});

export const listWeb = internalQuery({
  args: {},
  handler: async (ctx): Promise<import("./_generated/dataModel").Doc<"conversations">[]> => await ctx.db.query("conversations")
    .withIndex("by_channel_last", (q) => q.eq("channel", "web"))
    .order("desc")
    .collect(),
});

export const getWebById = internalQuery({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.id);
    return chat?.channel === "web" ? chat : null;
  },
});

export const createBranch = internalMutation({
  args: {
    parentId: v.id("conversations"),
    threadId: v.string(),
    title: v.string(),
    messageId: v.string(),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentId);
    if (parent?.channel !== "web") throw new Error("Source chat was deleted.");
    return await ctx.db.insert("conversations", {
      channel: "web",
      externalId: `session:${args.threadId}`,
      threadId: args.threadId,
      model: parent.model,
      title: args.title,
      lastMessageAt: Date.now(),
      parentConversationId: parent._id,
      branchedFromMessageId: args.messageId,
    });
  },
});

export const attachmentsForConversation = internalQuery({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => await ctx.db.query("chatAttachments")
    .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
    .collect(),
});

export const copyAttachments = internalMutation({
  args: { sourceId: v.id("conversations"), targetId: v.id("conversations"), messageKeys: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const keys = new Set(args.messageKeys);
    const attachments = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.sourceId))
      .collect();
    for (const attachment of attachments) {
      if (!keys.has(attachment.messageKey)) continue;
      await ctx.db.insert("chatAttachments", {
        conversationId: args.targetId,
        messageKey: attachment.messageKey,
        storageId: attachment.storageId,
        localPath: attachment.localPath,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        size: attachment.size,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * Drop the conversation so the next message starts a fresh thread. Memories
 * survive on purpose: reset clears the conversation, not what Assistant knows.
 */
export const clearThread = internalMutation({
  args: { id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return null;
  },
});

export const stats = internalQuery({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.id);
    if (!conversation) return null;

    const runs = await ctx.db
      .query("runs")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .order("desc")
      .take(50);

    return {
      threadId: conversation.threadId,
      recentRuns: runs.length,
      lastError: runs.find((r) => r.status === "error")?.error,
    };
  },
});

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("conversations").order("desc").collect();
  },
});
