import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { FINALIZE_LEASE_MS, queueSteer } from "./codex";

/**
 * Durable turns. The runner keeps finished Codex results on disk and delivers
 * them after a restart; this sweep covers what can go wrong on the Convex side
 * and with a runner that never comes back, so no chat is left waiting forever:
 *
 * - a finished turn whose finalizing failed is finalized again (finalizeTurn
 *   records each step, so a retry never saves or sends anything twice);
 * - a queued turn whose runner stayed offline fails with a clear error;
 * - a running turn whose runner died and did not return fails the same way;
 * - a message sent into a reply that ended without taking it (the sweep
 *   failed that turn, say) is queued as a turn of its own;
 * - a chat still marked busy with no turn behind it is released, and its run
 *   is closed.
 */

const RETRY_FINALIZE_MS = 60_000;
const QUEUED_OFFLINE_MS = 10 * 60_000;
const RUNNING_OFFLINE_MS = 15 * 60_000;
const RUNNER_ONLINE_MS = 90_000;
const STUCK_CHAT_MS = 5 * 60_000;

export const sweep = internalMutation({
  // A test looks at one chat (`only`) as it will be later (`now`).
  args: { now: v.optional(v.number()), only: v.optional(v.id("conversations")) },
  returns: v.object({ refinalized: v.number(), abandoned: v.number(), requeued: v.number(), released: v.number() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    let refinalized = 0;
    let abandoned = 0;
    let requeued = 0;
    let released = 0;
    const turns = args.only
      ? await ctx.db.query("codexTurns").withIndex("by_conversation_status", (q) => q.eq("conversationId", args.only!)).collect()
      : await ctx.db.query("codexTurns").order("desc").take(300);
    const runnerOnline = new Map<string, boolean>();
    const online = async (id: (typeof turns)[number]["runnerId"]) => {
      if (!id) return false;
      if (!runnerOnline.has(id)) {
        const runner = await ctx.db.get(id);
        runnerOnline.set(id, Boolean(runner && !runner.revoked && (runner.lastSeenAt ?? 0) > now - RUNNER_ONLINE_MS));
      }
      return runnerOnline.get(id)!;
    };

    // Chats whose turn this sweep already failed; finalizing that turn releases them.
    const handled = new Set<string>();
    for (const turn of turns) {
      if (turn.finalizedAt) continue;
      // Not while a finalize that started recently may still be delivering.
      if ((turn.status === "done" || turn.status === "error") && (turn.finishedAt ?? 0) < now - RETRY_FINALIZE_MS
        && (turn.finalizingAt ?? 0) < now - FINALIZE_LEASE_MS) {
        await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: turn._id });
        refinalized += 1;
        continue;
      }
      const stale = turn.status === "queued"
        ? turn.createdAt < now - QUEUED_OFFLINE_MS
        : turn.status === "running" && (turn.startedAt ?? turn.createdAt) < now - RUNNING_OFFLINE_MS;
      if (stale && !(await online(turn.runnerId))) {
        // What it had written so far is kept, as when the owner stops a turn.
        await ctx.db.patch(turn._id, {
          status: "error",
          response: turn.response ?? turn.partial,
          partial: undefined,
          error: turn.status === "queued"
            ? "The runner was offline, so this message was not answered. Start the runner and send it again."
            : "The runner stopped during this turn and did not come back. Start the runner and send the message again.",
          finishedAt: now,
        });
        await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: turn._id });
        abandoned += 1;
        handled.add(turn.conversationId);
      }
    }

    // Steers whose reply is no longer running. finishTurn queues its own, so
    // these are left by turns this sweep failed, or whose chat is gone.
    const steers = await ctx.db.query("codexSteers").withIndex("by_status", (q) => q.eq("status", "pending")).take(100);
    for (const steer of steers) {
      if (args.only && steer.conversationId !== args.only) continue;
      const turn = await ctx.db.get(steer.turnId);
      if (turn?.status === "running") continue;
      if (!turn || !(await ctx.db.get(steer.conversationId))) await ctx.db.delete(steer._id);
      else await queueSteer(ctx, steer, { error: "The reply ended before this message could join it." });
      requeued += 1;
    }

    // A chat marked busy with nothing queued or running behind it.
    const chats = args.only ? [await ctx.db.get(args.only)].filter((chat) => chat !== null) : await ctx.db.query("conversations").collect();
    for (const chat of chats) {
      if (!chat.pendingTurns || chat.lastMessageAt > now - STUCK_CHAT_MS || handled.has(chat._id)) continue;
      const active = await ctx.db.query("codexTurns")
        .withIndex("by_conversation_status", (q) => q.eq("conversationId", chat._id).eq("status", "queued"))
        .first() ?? await ctx.db.query("codexTurns")
        .withIndex("by_conversation_status", (q) => q.eq("conversationId", chat._id).eq("status", "running"))
        .first();
      const unfinalized = turns.some((turn) => turn.conversationId === chat._id && !turn.finalizedAt && turn.status !== "queued" && turn.status !== "running");
      if (active || unfinalized) continue;
      await ctx.db.patch(chat._id, { pendingTurns: 0 });
      const runs = await ctx.db.query("runs")
        .withIndex("by_conversation", (q) => q.eq("conversationId", chat._id))
        .order("desc")
        .take(5);
      for (const run of runs) {
        if (run.status === "running" && run.startedAt < now - STUCK_CHAT_MS) {
          await ctx.db.patch(run._id, { status: "error", error: "This turn was interrupted before Codex answered. Send the message again.", finishedAt: now });
        }
      }
      released += 1;
    }
    return { refinalized, abandoned, requeued, released };
  },
});
