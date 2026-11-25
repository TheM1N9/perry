import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ENGINES } from "./engines";

/** A retry keeps its run; an applied steer receives the turn it actually joined. */
export async function turnForRun(ctx: QueryCtx, runId: Id<"runs">, conversationId?: Id<"conversations">) {
  const chatId = conversationId ?? (await ctx.db.get(runId))?.conversationId;
  if (!chatId) return null;
  const attempts = (await ctx.db.query("codexTurns").withIndex("by_run", q => q.eq("runId", runId))
    .order("desc").take(ENGINES.length + 4)).filter(turn => turn.conversationId === chatId);
  const own = attempts.find(turn => turn.finalizedAt === undefined && (turn.status === "queued" || turn.status === "running" || turn.retrying))
    ?? attempts.find(turn => turn.finalizedAt === undefined) ?? attempts[0];
  if (own) return own;
  const steer = await ctx.db.query("codexSteers").withIndex("by_run", q => q.eq("runId", runId)).first();
  if (!steer || steer.conversationId !== chatId) return null;
  const turnId = steer.status === "applied" ? steer.turnId : steer.status === "queued" ? steer.queuedTurnId : undefined;
  if (!turnId) return null;
  const joined = await ctx.db.get(turnId);
  return joined?.conversationId === chatId ? joined : null;
}
