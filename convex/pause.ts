import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { describeMissed, PAUSED_ERROR, type MissedRun } from "./lib/commands";
import { stopTurns } from "./codex";
import { vPauseSource } from "./schema";

/**
 * Pause Perry (issue #204): one switch that stops everything, as OpenDots'
 * global pause is checked by every run.
 *
 * The state is one field on the installation row, so it survives restarts.
 * Pausing stops what is running through the same path as /stop, and every
 * place where work starts asks `pausedAt` first: a turn being queued or
 * claimed (codex.ts), schedules, the heartbeat and events (jobs.ts), watches
 * (work.ts), background tasks (tasks.ts) and Perry's tools (mcp.ts). Approvals
 * are left as they are.
 *
 * Nothing that was due while paused runs by surprise on resume: each schedule
 * that missed a run keeps a note of it (jobs.missed), and the owner runs it or
 * lets it go, from the dashboard or the phone.
 */

type Reader = { db: QueryCtx["db"] };
type Source = Infer<typeof vPauseSource>;

/** When Perry was paused; unset while he runs. */
export async function pausedAt(ctx: Reader): Promise<number | undefined> {
  return (await ctx.db.query("installation").first())?.paused?.at;
}

/** For where work starts: refused while paused. */
export async function assertRunning(ctx: Reader): Promise<void> {
  if (await pausedAt(ctx)) throw new Error(PAUSED_ERROR);
}

/** A run of the job that did not happen while paused, added to those it already missed. */
export function missedPatch(job: Doc<"jobs">, extra: { stopped?: boolean; event?: string } = {}): Pick<Doc<"jobs">, "missed"> {
  const before = job.missed;
  const event = extra.event?.slice(0, 3000) ?? before?.event;
  return {
    missed: {
      at: before?.at ?? Date.now(),
      runs: (before?.runs ?? 0) + 1,
      ...(extra.stopped || before?.stopped ? { stopped: true } : {}),
      ...(event !== undefined ? { event } : {}),
    },
  };
}

/** A background task the pause stopped: it waits for the owner's word, so it never carries on by surprise. */
async function hold(ctx: MutationCtx, task: Doc<"tasks">) {
  if (task.status !== "running") return;
  await ctx.db.patch(task._id, {
    status: "blocked",
    question: "Perry was paused while this ran. Answer to carry on.",
    waiting: undefined,
    updatedAt: Date.now(),
  });
}

/** Pause: stop what runs, and hold what was about to. Whether it was running. */
async function pause(ctx: MutationCtx, by: Source): Promise<{ changed: boolean; stopped: number }> {
  const install = await ctx.db.query("installation").first();
  if (!install) throw new Error("Run perry setup first.");
  if (install.paused) return { changed: false, stopped: 0 };
  await ctx.db.patch(install._id, { paused: { at: Date.now(), by } });
  // Every chat with a turn running or queued is stopped, as /stop stops one: a running turn keeps what it wrote.
  const busy = new Set<Id<"conversations">>();
  for (const runner of await ctx.db.query("runners").collect()) {
    for (const status of ["running", "queued"] as const) {
      const turns = await ctx.db.query("codexTurns").withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", status)).collect();
      for (const turn of turns) busy.add(turn.conversationId);
    }
  }
  let stopped = 0;
  for (const id of busy) {
    const count = await stopTurns(ctx, id);
    stopped += count;
    const chat = count ? await ctx.db.get(id) : null;
    const job = chat?.jobId ? await ctx.db.get(chat.jobId) : null;
    if (job) await ctx.db.patch(job._id, missedPatch(job, { stopped: true }));
  }
  // Tasks between turns too (their next turn already scheduled), not just those whose turn was stopped.
  for (const task of await ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", "running")).collect()) {
    if (task.turns) await hold(ctx, task);
  }
  // A run waiting for an engine's reset is called off (jobs.run goes ahead only while it is waited for), and missed.
  for (const job of await ctx.db.query("jobs").collect()) {
    if (job.waiting) await ctx.db.patch(job._id, { waiting: undefined, ...missedPatch(job) });
  }
  return { changed: true, stopped };
}

/** Resume: nothing missed starts; queued background tasks go on in their turn. */
async function resume(ctx: MutationCtx): Promise<{ changed: boolean; missed: MissedRun<Id<"jobs">>[] }> {
  const install = await ctx.db.query("installation").first();
  if (!install?.paused) return { changed: false, missed: await missedRuns(ctx) };
  await ctx.db.patch(install._id, { paused: undefined });
  await ctx.scheduler.runAfter(0, internal.tasks.tick, {});
  return { changed: true, missed: await missedRuns(ctx) };
}

/** Schedules with runs missed while paused, the first missed first, worded for the owner's clock. */
async function missedRuns(ctx: Reader): Promise<MissedRun<Id<"jobs">>[]> {
  const timezone = (await ctx.db.query("installation").first())?.timezone ?? "UTC";
  const jobs = (await ctx.db.query("jobs").collect()).filter((job) => job.missed);
  return jobs.sort((a, b) => a.missed!.at - b.missed!.at).map((job) => ({
    id: job._id,
    name: job.name,
    at: job.missed!.at,
    when: new Date(job.missed!.at).toLocaleString("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit" }),
    runs: job.missed!.runs,
    ...(job.missed!.stopped ? { stopped: true } : {}),
  }));
}

/** Run a missed schedule now, once, as the owner asked; with the event that would have started it, for one an event starts. */
async function runMissed(ctx: MutationCtx, id: Id<"jobs">): Promise<boolean> {
  await assertRunning(ctx);
  const job = await ctx.db.get(id);
  if (!job?.missed) return false;
  const event = job.trigger ? job.missed.event : undefined;
  await ctx.db.patch(job._id, { missed: undefined, lastRunAt: Date.now(), lastResult: undefined, lastError: undefined });
  await ctx.scheduler.runAfter(0, internal.jobs.run, { id: job._id, ...(event !== undefined ? { event } : {}) });
  return true;
}

/** Let one missed schedule go, or all of them. How many. */
async function skipMissed(ctx: MutationCtx, id?: Id<"jobs">): Promise<number> {
  const jobs = id ? [await ctx.db.get(id)] : await ctx.db.query("jobs").collect();
  let skipped = 0;
  for (const job of jobs) {
    if (!job?.missed) continue;
    await ctx.db.patch(job._id, { missed: undefined });
    skipped += 1;
  }
  return skipped;
}

// --- For the server (brain.ts, jobs.ts, tasks.ts) ------------------------------

export const state = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"installation">["paused"] | null> => (await ctx.db.query("installation").first())?.paused ?? null,
});

export const pauseFrom = internalMutation({
  args: { by: vPauseSource },
  returns: v.object({ changed: v.boolean(), stopped: v.number() }),
  handler: async (ctx, args) => await pause(ctx, args.by),
});

const vMissedRun = v.object({ id: v.id("jobs"), name: v.string(), at: v.number(), when: v.string(), runs: v.number(), stopped: v.optional(v.boolean()) });

export const resumeFrom = internalMutation({
  args: {},
  returns: v.object({ changed: v.boolean(), missed: v.array(vMissedRun) }),
  handler: async (ctx) => await resume(ctx),
});

export const missed = internalQuery({
  args: {},
  returns: v.array(vMissedRun),
  handler: async (ctx) => await missedRuns(ctx),
});

/** /run 2 or /run all from the phone: how many started. */
export const runMissedFrom = internalMutation({
  args: { ids: v.array(v.id("jobs")) },
  returns: v.number(),
  handler: async (ctx, args) => {
    let ran = 0;
    for (const id of args.ids) if (await runMissed(ctx, id)) ran += 1;
    return ran;
  },
});

export const skipMissedFrom = internalMutation({
  args: { id: v.optional(v.id("jobs")) },
  returns: v.number(),
  handler: async (ctx, args) => await skipMissed(ctx, args.id),
});

/**
 * A job's or task's turn that reached the brain while paused (it was on its
 * way when the owner paused): the job missed a run, the task waits for them.
 */
export const held = internalMutation({
  args: { conversationId: v.id("conversations"), event: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.conversationId);
    const job = chat?.jobId ? await ctx.db.get(chat.jobId) : null;
    if (job) await ctx.db.patch(job._id, missedPatch(job, { ...(args.event !== undefined ? { event: args.event } : {}) }));
    const task = chat?.taskId ? await ctx.db.get(chat.taskId) : null;
    if (task) await hold(ctx, task);
    return null;
  },
});

/** A job's run that never started because Perry was paused (jobs.run). */
export const missedJob = internalMutation({
  args: { id: v.id("jobs"), event: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (job) await ctx.db.patch(job._id, { waiting: undefined, ...missedPatch(job, { ...(args.event !== undefined ? { event: args.event } : {}) }) });
    return null;
  },
});

/** A task's turn that was about to start when Perry was paused (tasks.work). */
export const holdTask = internalMutation({
  args: { id: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (task) await hold(ctx, task);
    return null;
  },
});

// --- For the dashboard and the desktop pet -----------------------------------

export type PauseView = { paused: { at: number; by: Source } | null; missed: MissedRun<Id<"jobs">>[] };

export const status = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<PauseView> => {
    assertDashboardKey(args.key);
    return { paused: (await ctx.db.query("installation").first())?.paused ?? null, missed: await missedRuns(ctx) };
  },
});

/**
 * The switch, from the dashboard or the pet. Resumed with schedules missed,
 * the phone hears which too, and how to run them from there.
 */
export const set = mutation({
  args: { key: v.string(), paused: v.boolean(), from: v.optional(v.union(v.literal("web"), v.literal("pet"))) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (args.paused) {
      await pause(ctx, args.from ?? "web");
      return null;
    }
    const resumed = await resume(ctx);
    if (resumed.changed && resumed.missed.length) {
      await ctx.scheduler.runAfter(0, internal.notify.deliver, { text: `Perry is back on.\n\n${describeMissed(resumed.missed)}` });
    }
    return null;
  },
});

export const runMissedNow = mutation({
  args: { key: v.string(), id: v.id("jobs") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await runMissed(ctx, args.id);
  },
});

export const skip = mutation({
  args: { key: v.string(), id: v.optional(v.id("jobs")) },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await skipMissed(ctx, args.id);
  },
});
