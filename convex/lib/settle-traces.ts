import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Safe fallback text only: raw engine errors may contain credentials. */
const REASONS = {
  ended: "The turn ended before this step finished.",
  failed: "The turn failed before this step finished.",
  stopped: "The turn was stopped before this step finished.",
  timeout: "The turn timed out before this step finished.",
  restarted: "The runner restarted before this step finished.",
  recovery: "The turn was interrupted before this step finished.",
} as const;

export type TraceSettlementReason = keyof typeof REASONS;

/**
 * Close persisted open steps in the caller's terminal-turn transaction. A turn
 * ending does not prove any unfinished tool succeeded, even on a successful
 * reply. Keep the existing status vocabulary: interrupted steps are errors.
 *
 * Only running rows change. Repeated settlement (including recovery after
 * finalization) preserves completed steps, their outputs and original timing.
 * Call before scheduling final delivery; runner drain is only best effort.
 */
export async function settleRunSpans(
  ctx: Pick<MutationCtx, "db">,
  runId: Id<"runs">,
  endedAt: number,
  reason: TraceSettlementReason = "ended",
): Promise<number> {
  if (!Number.isFinite(endedAt)) throw new Error("Trace settlement requires a finite end time.");
  const spans = await ctx.db.query("runSpans")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();
  let settled = 0;
  for (const span of spans) {
    if (span.status !== "running") continue;
    // A runner's clock may be ahead of the server's. Never record a negative
    // duration or an end before the recorded start.
    const end = Math.max(span.startedAt, endedAt);
    const patch = {
      status: "error" as const,
      endedAt: end,
      durationMs: end - span.startedAt,
      ...(!span.output ? { output: REASONS[reason] } : {}),
    };
    await ctx.db.patch(span._id, patch);
    settled += 1;
  }
  return settled;
}
