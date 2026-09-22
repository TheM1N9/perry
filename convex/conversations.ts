import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { DEFAULT_MODE } from "./modes";
import { vChannel, vMode } from "./schema";

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
      mode: DEFAULT_MODE,
      title: args.title,
      lastMessageAt: Date.now(),
    });
  },
});

export const setMode = internalMutation({
  args: { id: v.id("conversations"), mode: vMode },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { mode: args.mode });
    return null;
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

/**
 * Drop the conversation so the next message starts a fresh thread. Memories
 * survive on purpose: reset clears the conversation, not what Perry knows.
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
      mode: conversation.mode,
      threadId: conversation.threadId,
      recentRuns: runs.length,
      lastError: runs.find((r) => r.status === "error")?.error,
    };
  },
});

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("conversations").order("desc").take(50);
  },
});
