import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const vMode = v.union(v.literal("perry"), v.literal("agentP"));

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
