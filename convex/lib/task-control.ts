import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Stop invalidates work already preparing outside a transaction, even after a later resume. */
export function taskVersionMatches(task: Doc<"tasks">, version?: number): boolean {
  return (task.stopVersion ?? 0) === (version ?? 0);
}

/** Reuse the blocked/resume lifecycle; keep the chat and the engine's session. */
export async function holdTask(ctx: MutationCtx, task: Doc<"tasks">, question: string): Promise<boolean> {
  if (task.status !== "running" && task.status !== "queued") return false;
  await ctx.db.patch(task._id, {
    status: "blocked", question, stopVersion: (task.stopVersion ?? 0) + 1,
    waiting: undefined, recovery: undefined, reported: undefined, updatedAt: Date.now(),
  });
  return true;
}
