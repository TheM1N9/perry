import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Liveness is independent of engine output, tool duration, and take_longer. */
export const UNRESPONSIVE_AFTER_MS = 90_000;
export const RUNNING_RECONNECT_MS = 15 * 60_000;
export const QUEUED_RECONNECT_MS = 10 * 60_000;

type Turn = Pick<Doc<"codexTurns">, "status" | "createdAt" | "startedAt"> & {
  lastHeartbeatAt?: number;
  unresponsiveAt?: number;
};
type Runner = { lastSeenAt?: number; revoked: boolean; turnHeartbeats?: boolean } | null;

export function lastLivenessAt(turn: Turn, runner: Runner): number {
  const start = turn.startedAt ?? turn.createdAt;
  // Once the runner explicitly reports this turn, unrelated machine check-ins
  // must never extend it. Older runners retain their machine-heartbeat fallback.
  return turn.status === "running" && runner?.turnHeartbeats
    ? Math.max(start, turn.lastHeartbeatAt ?? 0)
    : Math.max(start, turn.lastHeartbeatAt ?? 0, runner?.lastSeenAt ?? 0);
}

export function turnHealth(turn: Turn, runner: Runner, now: number) {
  const lastAliveAt = lastLivenessAt(turn, runner);
  const active = turn.status === "queued" || turn.status === "running";
  const responsive = Boolean(runner && !runner.revoked && now - lastAliveAt < UNRESPONSIVE_AFTER_MS);
  const grace = turn.status === "queued" ? QUEUED_RECONNECT_MS : RUNNING_RECONNECT_MS;
  return {
    lastAliveAt,
    unresponsive: active && !responsive,
    abandon: active && now - lastAliveAt >= grace,
  };
}

/** Called only after authenticating the runner and checking turn ownership. */
export async function recordTurnHeartbeat(ctx: MutationCtx, turn: Doc<"codexTurns"> & Turn, now: number) {
  if (turn.status !== "running" || turn.finalizedAt !== undefined) return;
  await ctx.db.patch(turn._id, {
    lastHeartbeatAt: Math.max(now, turn.lastHeartbeatAt ?? 0),
    unresponsiveAt: undefined,
  });
}

/** Reuse the existing check-in, never a second heartbeat timer or watcher. */
export async function heartbeatActiveTurns(ctx: MutationCtx, runner: Doc<"runners">, ids: Doc<"codexTurns">["_id"][] | undefined, now: number) {
  // Omission means an older runner. An explicit [] means it owns no live turns.
  if (ids === undefined) return;
  const running = await ctx.db.query("codexTurns")
    .withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", "running"))
    .collect();
  const active = new Set(ids);
  for (const turn of running) {
    if (active.has(turn._id)) await recordTurnHeartbeat(ctx, turn, now);
    // Upgrade an old turn omitted by a modern runner, freezing its last known
    // liveness before subsequent unrelated check-ins can prolong it forever.
    else if (!(runner as NonNullable<Runner>).turnHeartbeats || (turn as Turn).lastHeartbeatAt === undefined) {
      await ctx.db.patch(turn._id, { lastHeartbeatAt: lastLivenessAt(turn, runner) });
    }
  }
}
