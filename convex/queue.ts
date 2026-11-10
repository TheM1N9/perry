import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { OUTBOX_TTL_MS } from "./conversations";
import type { EngineKind } from "./lib/engines";

export const MAX_QUEUED_PER_CHAT = 10;
export const QUEUE_FULL = "This chat already has 10 messages waiting. Remove a queued message or wait for a reply before sending another.";

/** Where a turn waits in its chat's queue: where the owner moved it, else when it was sent. Claims go lowest first. */
export const queuePosition = (turn: Pick<Doc<"codexTurns">, "queueOrder" | "createdAt">) => turn.queueOrder ?? turn.createdAt;

/** Lowest position first; equal positions keep the order they were made in. */
export const byQueuePosition = (a: Doc<"codexTurns">, b: Doc<"codexTurns">) => queuePosition(a) - queuePosition(b) || a._creationTime - b._creationTime;

/**
 * Whether the owner's words can join this running reply: not one being
 * stopped, not a compaction, which cannot be steered, and on the same engine.
 * A memory checkpoint or the flush before /reset is not a reply either.
 */
export function steerable(running: Doc<"codexTurns"> | null, engine: EngineKind): running is Doc<"codexTurns"> {
  return running !== null && running.status === "running" && !running.stopRequested && running.kind !== "compact"
    && !running.checkpoint && !running.flush && running.runnerId !== undefined && running.engine === engine;
}

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

/** The owner's still-unclaimed message: queued, and nothing has started finishing or delivering it. */
function unclaimed(turn: Doc<"codexTurns"> | null, chat: Doc<"conversations">): turn is Doc<"codexTurns"> {
  return turn !== null && turn.conversationId === chat._id && turn.status === "queued" && turn.finalizedAt === undefined && turn.finalizingAt === undefined
    && turn.deliveredAt === undefined && turn.savedAt === undefined && turn.reportedAt === undefined;
}

/** One the owner wrote: not a compaction, a memory checkpoint or flush, a prompt that is not theirs, or another engine's retry of a refused turn. */
const ownWords = (turn: Doc<"codexTurns">) => turn.kind !== "compact" && !turn.flush && !turn.checkpoint && !turn.hidden && !turn.retryOf;

async function ownChat(ctx: MutationCtx, args: { key: string; conversationId: Id<"conversations"> }, doing: string) {
  assertDashboardKey(args.key);
  const chat = await ctx.db.get(args.conversationId);
  if (!chat || chat.contactId) throw new Error(`Only messages in your own chat can be ${doing}.`);
  return chat;
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
    const chat = await ownChat(ctx, args, "removed");
    const turn = await ctx.db.get(args.id);
    if (!unclaimed(turn, chat)) return false;
    await ctx.db.patch(turn._id, { status: "done", stopped: true, waiting: undefined, finishedAt: Date.now(), error: "Removed from queue." });
    // Reuse the terminal transaction for run/span closure and pendingTurns. There
    // is nothing to save or send: the owner removed this unclaimed message.
    await ctx.runMutation(internal.codex.markFinalized, { id: turn._id });
    return true;
  },
});

/**
 * A queued message sent into the reply that is running, as if it had been
 * sent then (codex.enqueueTurn): it becomes a steer of that reply, which the
 * runner hands its engine, or which queues again in its place if the engine
 * will not take it. One still being prepared is marked to steer once it is.
 * False when it already started or left the queue; an error when nothing is
 * running that it could join.
 */
export const steer = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("codexTurns") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const chat = await ownChat(ctx, args, "sent");
    const turn = await ctx.db.get(args.id);
    if (!unclaimed(turn, chat) || !ownWords(turn)) return false;
    const running = await ctx.db.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", chat._id).eq("status", "running")).first();
    if (!turn.engine || !steerable(running, turn.engine)) throw new Error("Nothing is running that this message could join. Send it now instead.");
    // Preparation decides on its own steerTarget (codex.enqueueTurn), and pendingSteers holds later steers back until it does.
    if (turn.preparing) {
      await ctx.db.patch(turn._id, { steerTarget: running._id });
      return true;
    }
    if (turn.outsideAt !== undefined && running.outsideAt === undefined) await ctx.db.patch(running._id, { outsideAt: turn.outsideAt });
    // The running turn already carries recalled memory; a steer takes only the message, as enqueueTurn's does.
    // The queued turn's pending count passes to the steer: the reply it joins ends both (codex.markFinalized), or it queues again.
    await ctx.db.insert("codexSteers", {
      turnId: running._id, runnerId: running.runnerId!, engine: turn.engine, conversationId: chat._id, runId: turn.runId,
      prompt: turn.prompt, history: turn.history, instructions: turn.instructions,
      requestedModel: turn.requestedModel, requestedEffort: turn.requestedEffort, access: turn.access, attachments: turn.attachments,
      status: "pending", createdAt: Date.now(),
    });
    await ctx.db.delete(turn._id);
    return true;
  },
});

/** A queued message moved to the front of its chat's queue: next to start, at once when nothing runs. */
export const sendNow = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("codexTurns") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const chat = await ownChat(ctx, args, "sent");
    const turn = await ctx.db.get(args.id);
    if (!unclaimed(turn, chat) || !ownWords(turn)) return false;
    const queued = await ctx.db.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", chat._id).eq("status", "queued")).collect();
    const front = Math.min(...queued.filter(other => other._id !== turn._id && other.finalizedAt === undefined).map(queuePosition));
    if (Number.isFinite(front) && front <= queuePosition(turn)) await ctx.db.patch(turn._id, { queueOrder: front - 1 });
    return true;
  },
});

/**
 * New words for a queued message, kept where it waits and with its files.
 * One still being prepared is refused: preparation writes its prompt last.
 */
export const edit = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("codexTurns"), text: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const chat = await ownChat(ctx, args, "edited");
    const turn = await ctx.db.get(args.id);
    if (!unclaimed(turn, chat) || !ownWords(turn)) return false;
    if (turn.preparing) throw new Error("This message is still being prepared. Try again in a moment.");
    const files = /\n?<!-- attachments:[^>]+ -->\s*$/.exec(turn.prompt)?.[0].trim();
    const text = args.text.trim();
    if (!text && !files) throw new Error("A message needs words or files. Remove it from the queue instead.");
    const prompt = [text, files].filter(Boolean).join("\n\n");
    await ctx.db.patch(turn._id, { prompt });
    // Activity lists the run by what it was asked (runs.start).
    await ctx.db.patch(turn.runId, { prompt: prompt.slice(0, 2000) });
    return true;
  },
});

/**
 * The chat's queued messages in a new order, the first to start first. They
 * swap the places they had among themselves, so nothing else in the queue
 * moves; one that started or left it meanwhile is left out.
 */
export const reorder = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), ids: v.array(v.id("codexTurns")) },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const chat = await ownChat(ctx, args, "moved");
    if (args.ids.length > MAX_QUEUED_PER_CHAT * 2 || new Set(args.ids).size !== args.ids.length) throw new Error("That is not this chat's queue.");
    const moving = (await Promise.all(args.ids.map((id) => ctx.db.get(id)))).filter((turn): turn is Doc<"codexTurns"> => unclaimed(turn, chat) && ownWords(turn));
    if (moving.length < 2) return false;
    const places = [...moving].sort(byQueuePosition).map(queuePosition);
    // Equal places (a retry made at the same moment) are pulled apart, so the order asked for is the order kept.
    for (let index = 1; index < places.length; index++) places[index] = Math.max(places[index]!, places[index - 1]! + 0.001);
    for (const [index, turn] of moving.entries()) {
      if (queuePosition(turn) !== places[index]) await ctx.db.patch(turn._id, { queueOrder: places[index] });
    }
    return true;
  },
});
