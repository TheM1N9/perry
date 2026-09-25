import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Chat history: threads and their messages, in Perry's own tables.
 *
 * This used to be the @convex-dev/agent component, which Perry used only to
 * store messages, list them newest first, and search them by keyword. These
 * are those operations, called through lib/agent.ts with the same shapes.
 */

export type StoredMessage = Doc<"agentMessages">;
export type MessagePage = { page: StoredMessage[]; isDone: boolean; continueCursor: string };

export const createThread = internalMutation({
  args: { userId: v.optional(v.string()), title: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string> => await ctx.db.insert("agentThreads", { userId: args.userId, title: args.title }),
});

/** Newest first. The cursor is the order of the last message returned, so new messages never shift a page. */
export const listMessages = internalQuery({
  args: {
    threadId: v.string(),
    excludeToolMessages: v.optional(v.boolean()),
    paginationOpts: v.object({ numItems: v.number(), cursor: v.union(v.string(), v.null()) }),
  },
  handler: async (ctx, args): Promise<MessagePage> => {
    const threadId = ctx.db.normalizeId("agentThreads", args.threadId);
    if (!threadId) return { page: [], isDone: true, continueCursor: "" };
    const before = args.paginationOpts.cursor === null ? null : Number(args.paginationOpts.cursor);
    const wanted = Math.max(1, Math.floor(args.paginationOpts.numItems));
    const found = await ctx.db.query("agentMessages")
      .withIndex("by_thread_order", (q) => before === null || !Number.isFinite(before) ? q.eq("threadId", threadId) : q.eq("threadId", threadId).lt("order", before))
      .order("desc")
      .filter((q) => args.excludeToolMessages ? q.neq(q.field("message.role"), "tool") : true)
      .take(wanted + 1);
    const page = found.slice(0, wanted);
    return { page, isDone: found.length <= wanted, continueCursor: page.length ? String(page[page.length - 1].order) : args.paginationOpts.cursor ?? "" };
  },
});

export const saveMessages = internalMutation({
  args: {
    threadId: v.string(),
    userId: v.optional(v.string()),
    messages: v.array(v.object({ role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system"), v.literal("tool")), content: v.string() })),
    metadata: v.optional(v.array(v.object({ provider: v.optional(v.string()), model: v.optional(v.string()) }))),
  },
  handler: async (ctx, args): Promise<{ messages: Array<Id<"agentMessages">> }> => {
    const threadId = ctx.db.normalizeId("agentThreads", args.threadId);
    if (!threadId) throw new Error("That chat's history no longer exists.");
    const thread = await ctx.db.get(threadId);
    const last = await ctx.db.query("agentMessages").withIndex("by_thread_order", (q) => q.eq("threadId", threadId)).order("desc").first();
    let order = last ? last.order + 1 : 0;
    const ids: Array<Id<"agentMessages">> = [];
    for (const [index, message] of args.messages.entries()) {
      const meta = args.metadata?.[index] ?? {};
      ids.push(await ctx.db.insert("agentMessages", {
        threadId,
        userId: args.userId ?? thread?.userId,
        order: order++,
        message,
        text: message.content,
        ...(meta.provider ? { provider: meta.provider } : {}),
        ...(meta.model ? { model: meta.model } : {}),
      }));
    }
    return { messages: ids };
  },
});

/** Best match first, among the messages of one userId's chats. */
export const searchMessages = internalQuery({
  args: { userId: v.string(), text: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<StoredMessage[]> => {
    if (!args.text.trim()) return [];
    return await ctx.db.query("agentMessages")
      .withSearchIndex("search_text", (q) => q.search("text", args.text).eq("userId", args.userId))
      .take(Math.min(Math.max(args.limit ?? 10, 1), 1024));
  },
});

export const deleteThread = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const threadId = ctx.db.normalizeId("agentThreads", args.threadId);
    if (!threadId) return null;
    const messages = await ctx.db.query("agentMessages").withIndex("by_thread_order", (q) => q.eq("threadId", threadId)).collect();
    for (const message of messages) await ctx.db.delete(message._id);
    await ctx.db.delete(threadId);
    return null;
  },
});

export const deleteMessages = internalMutation({
  args: { messageIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const raw of args.messageIds) {
      const id = ctx.db.normalizeId("agentMessages", raw);
      if (id) await ctx.db.delete(id);
    }
    return null;
  },
});
