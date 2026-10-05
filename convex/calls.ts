import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

export const start = mutation({
  args: {
    conversationId: v.optional(v.id("conversations")),
    channelId: v.optional(v.string()),
    waCallId: v.optional(v.string()),
    direction: v.optional(v.union(v.literal("inbound"), v.literal("outbound"))),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const userId = args.userId ?? null;
    const now = Date.now();
    const id = await ctx.db.insert("calls", {
      conversationId: args.conversationId,
      channelId: args.channelId,
      waCallId: args.waCallId,
      status: "ringing",
      direction: args.direction ?? "inbound",
      from: args.from,
      to: args.to,
      startedAt: now,
      hasTranscript: false,
      userId,
    });
    return { id };
  },
});

export const answer = mutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call) return { error: "Call not found" };
    const now = Date.now();
    await ctx.db.patch(callId, {
      status: "active",
      answeredAt: now,
    });
    return { ok: true, answeredAt: now };
  },
});

export const end = mutation({
  args: {
    callId: v.id("calls"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { callId, reason }) => {
    const call = await ctx.db.get(callId);
    if (!call) return { error: "Call not found" };
    const now = Date.now();
    const started = call.startedAt;
    const answered = call.answeredAt;
    let durationMs: number | undefined;
    if (answered) durationMs = Math.max(0, now - answered);
    else if (started) durationMs = Math.max(0, now - started);
    await ctx.db.patch(callId, {
      status: "ended",
      endedAt: now,
      endedReason: reason,
      durationMs,
    });
    return { ok: true, endedAt: now, durationMs };
  },
});

export const fail = mutation({
  args: {
    callId: v.id("calls"),
    error: v.string(),
  },
  handler: async (ctx, { callId, error }) => {
    const call = await ctx.db.get(callId);
    if (!call) return { error: "Call not found" };
    const now = Date.now();
    await ctx.db.patch(callId, {
      status: "failed",
      endedAt: now,
      error,
    });
    return { ok: true };
  },
});

export const setTranscript = mutation({
  args: {
    callId: v.id("calls"),
    audioId: v.optional(v.id("_storage")),
    summary: v.optional(v.string()),
    hasTranscript: v.optional(v.boolean()),
  },
  handler: async (ctx, { callId, audioId, summary, hasTranscript = true }) => {
    const call = await ctx.db.get(callId);
    if (!call) return { error: "Call not found" };
    await ctx.db.patch(callId, {
      audioId,
      summary,
      hasTranscript,
    });
    return { ok: true };
  },
});

export const attachConversation = mutation({
  args: {
    callId: v.id("calls"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, { callId, conversationId }) => {
    const call = await ctx.db.get(callId);
    if (!call) return { error: "Call not found" };
    await ctx.db.patch(callId, { conversationId });
    return { ok: true };
  },
});

export const getByWaCallId = query({
  args: { waCallId: v.string() },
  handler: async (ctx, { waCallId }) => {
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_waCallId", (q) => q.eq("waCallId", waCallId))
      .collect();
    return calls[0] ?? null;
  },
});

export const getActiveForConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .filter((q) => q.or(q.eq(q.field("status"), "ringing"), q.eq(q.field("status"), "active")))
      .order("desc")
      .collect();
    return calls[0] ?? null;
  },
});

export const latestByConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(1);
    return calls[0] ?? null;
  },
});
