import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { OUTBOX_TTL_MS } from "./conversations";

export const MAX_QUEUED_PER_CHAT = 10;
export const QUEUE_FULL = "This chat already has 10 messages waiting. Remove a queued message or wait for a reply before sending another.";

/** Count durable waiting work, including reservations while actions prepare a send.
 * Call inside the admission mutation: Runtime serializes it with claims/removals.
 * A steer reserves a fallback slot until applied. Replacing a reservation never
 * requires an extra slot. Running/delivered turns do not occupy the queue.
 */
export async function waitingCount(ctx: QueryCtx, chat: Doc<"conversations">, replacing: { prompt?: string; steerId?: Id<"codexSteers">; turnId?: Id<"codexTurns"> } = {}) {
  const turns = await ctx.db.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", chat._id).eq("status", "queued")).collect();
  const held = await ctx.db.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", chat._id).eq("status", "error"))
    .filter(q => q.and(q.eq(q.field("retrying"), true), q.neq(q.field("waiting"), undefined))).collect();
  const steers = await ctx.db.query("codexSteers").withIndex("by_conversation_status", q => q.eq("conversationId", chat._id).eq("status", "pending")).collect();
  const outbox = (chat.outbox ?? []).filter(item => item.at > Date.now() - OUTBOX_TTL_MS);
  const replacesOutbox = replacing.prompt !== undefined && outbox.some(item => item.text === replacing.prompt);
  return [...turns, ...held].filter(item => item._id !== replacing.turnId).length + steers.filter(item => item._id !== replacing.steerId).length + outbox.length - Number(replacesOutbox);
}

export async function assertQueueRoom(ctx: MutationCtx, chat: Doc<"conversations">, replacing: { prompt?: string; steerId?: Id<"codexSteers">; turnId?: Id<"codexTurns"> } = {}) {
  if (await waitingCount(ctx, chat, replacing) >= MAX_QUEUED_PER_CHAT) {
    // Queue pressure is not an engine rate limit; routing must not retry it.
    throw new Error(QUEUE_FULL);
  }
}

/** Exactly one still-unclaimed turn. Claim and removal serialize in SQLite:
 * if claim won, this returns false and never requests a stop from the engine.
 * Pending steers are deliberately excluded: a runner may already have delivered
 * one before its acknowledgement reaches Perry.
 */
export const remove = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("codexTurns") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    assertDashboardKey(args.key);
    const chat = await ctx.db.get(args.conversationId);
    if (!chat || chat.contactId) throw new Error("Only messages in your own chat can be removed.");
    const turn = await ctx.db.get(args.id);
    if (!turn || turn.conversationId !== chat._id) return false;
    if (turn.status !== "queued" || turn.finalizedAt !== undefined || turn.finalizingAt !== undefined
      || turn.deliveredAt !== undefined || turn.savedAt !== undefined || turn.reportedAt !== undefined) return false;
    await ctx.db.patch(turn._id, { status: "done", stopped: true, waiting: undefined, finishedAt: Date.now(), error: "Removed from queue." });
    // Reuse the terminal transaction for run/span closure and pendingTurns. There
    // is nothing to save or send: the owner removed this unclaimed message.
    await ctx.runMutation(internal.codex.markFinalized, { id: turn._id });
    return true;
  },
});
