import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { vUsage } from "./schema";

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
      usage: r.usage,
      error: r.error,
      startedAt: r.startedAt,
      durationMs: r.finishedAt ? r.finishedAt - r.startedAt : undefined,
    }));
  },
});

/** A run's trace, in the order its spans started. */
export const spans = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("runSpans")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(500);
    return rows.sort((a, b) => a.startedAt - b.startedAt).map((span) => ({
      id: span._id as string,
      kind: span.kind,
      name: span.name,
      status: span.status,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      input: span.input,
      output: span.output,
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
    usage: v.optional(vUsage),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, ...rest }) => {
    await ctx.db.patch(id, { ...rest, finishedAt: Date.now() });
    return null;
  },
});
