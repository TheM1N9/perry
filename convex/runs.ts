import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { vMode } from "./schema";

export const recent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("runs")
      .withIndex("by_started")
      .order("desc")
      .take(Math.min(args.limit ?? 30, 100));

    return rows.map((r) => ({
      id: r._id as string,
      mode: r.mode as string,
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
    mode: vMode,
    prompt: v.string(),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("runs", {
      conversationId: args.conversationId,
      mode: args.mode,
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
