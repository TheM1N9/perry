import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const recent = internalQuery({
  args: { limit: v.optional(v.number()), conversationId: v.optional(v.id("conversations")) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 30, 100);
    const rows = args.conversationId
      ? await ctx.db.query("runs")
        .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId!))
        .order("desc")
        .take(limit)
      : await ctx.db.query("runs")
        .withIndex("by_started")
        .order("desc")
        .take(limit);
    const conversations = await Promise.all(rows.map((run) => ctx.db.get(run.conversationId)));

    return rows.map((r, index) => ({
      id: r._id as string,
      sessionId: r.conversationId,
      threadId: conversations[index]?.threadId,
      chatTitle: conversations[index]?.title ?? (conversations[index] ? "Untitled chat" : "Deleted chat"),
      channel: conversations[index]?.channel ?? "deleted",
      prompt: r.prompt,
      status: r.status as string,
      steps: r.steps,
      toolCalls: r.toolCalls,
      model: r.model,
      totalTokens: r.usage?.totalTokens,
      error: r.error,
      startedAt: r.startedAt,
      durationMs: r.finishedAt ? r.finishedAt - r.startedAt : undefined,
    }));
  },
});

export const start = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    prompt: v.string(),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("runs", {
      conversationId: args.conversationId,
      prompt: args.prompt.slice(0, 2000),
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const finish = internalMutation({
  args: {
    id: v.id("runs"),
    status: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("rejected"),
    ),
    steps: v.optional(v.number()),
    toolCalls: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    usage: v.optional(
      v.object({
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
        totalTokens: v.optional(v.number()),
      }),
    ),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, ...rest }) => {
    await ctx.db.patch(id, { ...rest, finishedAt: Date.now() });
    return null;
  },
});
