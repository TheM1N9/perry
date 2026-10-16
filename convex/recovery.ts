import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { FINALIZE_LEASE_MS, queueSteer } from "./codex";
import { turnHealth } from "./lib/turn-health";
import { settleRunSpans } from "./lib/settle-traces";

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
    const runners = await ctx.db.query("runners").collect();
    const runnerById = new Map(runners.map((runner) => [runner._id, runner]));
    // The most recent history is enough for routine finalize retries, but an
    // hours-old active turn must not fall behind 300 newer completed turns.
    if (!args.only) {
      const seen = new Set(turns.map((turn) => turn._id));
      for (const runnerId of [undefined, ...runners.map((runner) => runner._id)]) {
        for (const status of ["queued", "running"] as const) {
          const active = await ctx.db.query("codexTurns")
            .withIndex("by_runner_status", (q) => q.eq("runnerId", runnerId).eq("status", status)).collect();
          for (const turn of active) if (!seen.has(turn._id)) { turns.push(turn); seen.add(turn._id); }
        }
      }
    }

    // Chats whose turn this sweep already failed; finalizing that turn releases them.
    const handled = new Set<string>();
    for (const turn of turns) {
      // Repair legacy terminal traces too, without an older retry closing the
      // newer attempt that shares its run. The by_run index orders attempts.
      if (turn.status === "done" || turn.status === "error") {
        const latest = await ctx.db.query("codexTurns")
          .withIndex("by_run", (q) => q.eq("runId", turn.runId)).order("desc").first();
        if (latest?._id === turn._id) {
          await settleRunSpans(ctx, turn.runId, turn.finishedAt ?? now, turn.stopped ? "stopped" : "recovery");
        }
      }
      if (turn.finalizedAt) continue;
      if (turn.retrying) {
        // A routing retry owns the shared run until it gives up or its bounded
        // grace expires. Existing delivery evidence permanently rules out a
        // retry, even when an earlier finalizer's lease has since expired.
        const finalizationStarted = turn.finalizingAt !== undefined || turn.reportedAt !== undefined
          || turn.savedAt !== undefined || turn.deliveredAt !== undefined;
        if (!finalizationStarted && now - (turn.finishedAt ?? turn.createdAt) < FINALIZE_LEASE_MS) continue;
        // Claim finalization ownership in this transaction, before scheduling
        // its action: any late retryOn now sees retrying cleared and loses.
        await ctx.db.patch(turn._id, { retrying: undefined });
      }
      // Not while a finalize that started recently may still be delivering.
      if ((turn.status === "done" || turn.status === "error") && (turn.finishedAt ?? 0) < now - RETRY_FINALIZE_MS
        && (turn.finalizingAt ?? 0) < now - FINALIZE_LEASE_MS) {
        await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: turn._id });
        refinalized += 1;
        continue;
      }
      if (turn.status !== "queued" && turn.status !== "running") continue;
      const health = turnHealth(turn, turn.runnerId ? runnerById.get(turn.runnerId) ?? null : null, now);
      if (turn.status === "running") {
        const marked = (turn as typeof turn & { unresponsiveAt?: number }).unresponsiveAt;
        if (health.unresponsive && marked === undefined) {
          await ctx.db.patch(turn._id, { unresponsiveAt: now });
        } else if (!health.unresponsive && marked !== undefined) {
          await ctx.db.patch(turn._id, { unresponsiveAt: undefined });
        }
      }
      if (health.abandon) {
        // What it had written so far is kept, as when the owner stops a turn.
        await ctx.db.patch(turn._id, {
          status: "error",
          errorCode: "offline",
          response: turn.response ?? turn.partial,
          partial: undefined,
          error: turn.status === "queued"
            ? "The runner was offline, so this message was not answered. Start the runner and send it again."
            : "The runner stopped during this turn and did not come back. Start the runner and send the message again.",
          finishedAt: now,
        });
        await settleRunSpans(ctx, turn.runId, now, "recovery");
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
          await ctx.db.patch(run._id, { status: "error", error: "This turn was interrupted before Codex answered. Send the message again.", errorCode: "restarted", finishedAt: now });
          await settleRunSpans(ctx, run._id, now, "recovery");
        }
      }
      released += 1;
    }
    return { refinalized, abandoned, requeued, released };
  },
});
