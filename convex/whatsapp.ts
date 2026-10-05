import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { chunkWhatsApp, toWhatsApp } from "./lib/whatsappFormat";
import { callsBy, whatsappHandle } from "./contacts";
import { readPersona } from "./persona";

// --- Calls (WhatsApp voice) ---

export const callOffer = internalMutation({
  args: { call: v.any() },
  returns: v.null(),
  handler: async (ctx, { call }: { call: any }) => {
    const id = call?.id ?? call?.callId ?? call?.key?.id;
    const from = call?.from ?? call?.caller ?? call?.peerJid;
    const to = call?.to ?? call?.recipient;
    if (!id) return null;
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_waCallId", (q: any) => q.eq("waCallId", String(id)))
      .first();
    if (existing) return null;
    const owner = await ctx.db.query("installation").first();
    let conversationId: Id<"conversations"> | undefined;
    if (from) {
      const bareFrom = bareJid(String(from));
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_channel_external", (q: any) => q.eq("channel", "whatsapp").eq("externalId", bare))
        .first();
      conversationId = conv?._id;
    }
    await ctx.db.insert("calls", {
      conversationId,
      channelId: "whatsapp",
      waCallId: String(id),
      status: "ringing",
      direction: "inbound",
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
      startedAt: Date.now(),
      hasTranscript: false,
    });
    return null;
  },
});

export const callAccept = internalMutation({
  args: { call: v.any() },
  returns: v.null(),
  handler: async (ctx, { call }: { call: any }) => {
    const id = call?.id ?? call?.callId;
    if (!id) return null;
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_waCallId", (q: any) => q.eq("waCallId", String(id)))
      .first();
    if (!existing) return null;
    if (existing.status === "active") return null;
    const now = Date.now();
    await ctx.db.patch(existing._id, { status: "active", answeredAt: now });
    return null;
  },
});

export const callUpdate = internalMutation({
  args: { call: v.any() },
  returns: v.null(),
  handler: async (_ctx, _args: { call: any }) => {
    return null;
  },
});

export const callTerminate = internalMutation({
  args: { call: v.any() },
  returns: v.null(),
  handler: async (ctx, { call }: { call: any }) => {
    const id = call?.id ?? call?.callId;
    const reason = call?.status ?? call?.duration ?? undefined;
    if (!id) return null;
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_waCallId", (q: any) => q.eq("waCallId", String(id)))
      .first();
    if (!existing) return null;
    if (existing.status === "ended" || existing.status === "failed") return null;
    const now = Date.now();
    const answered = existing.answeredAt;
    const started = existing.startedAt;
    let durationMs: number | undefined;
    if (answered) durationMs = Math.max(0, now - answered);
    else if (started) durationMs = Math.max(0, now - started);
    await ctx.db.patch(existing._id, { status: "ended", endedAt: now, endedReason: reason ? String(reason) : undefined, durationMs });
    return null;
  },
});
