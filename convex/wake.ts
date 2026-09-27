import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";

/**
 * Waking the computer (issue #109): nothing runs while it sleeps, so the
 * server on it (server/wake.ts) sets the system's own wake timer for the next
 * scheduled job or to-do reminder, a minute ahead, and keeps the computer
 * awake while that comes due and while a turn runs. This file says what is
 * next and whether anything is running; the Work page shows how it went.
 */

/** A job an event starts has this for its next time (jobs.ts): never. */
const NEVER = 8.64e15;
/** Waking for something more than this far off waits for a later look; the timer is set again anyway when things change. */
const HORIZON_MS = 14 * 24 * 3_600_000;

export type WakeView = {
  /** Off when the owner turned it off on the Work page. */
  enabled: boolean;
  /** The timer set: when, and for what. */
  at?: number;
  what?: string;
  /** Why no timer could be set (no admin on a Mac, wake timers off in Windows' power plan). */
  error?: string;
  /** Kept awake right now, for a turn running or something about to be due. */
  awake?: boolean;
  checkedAt?: number;
};

/** The soonest job or to-do reminder still to come, while waking is on. */
export const next = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ at: number; what: string } | null> => {
    const install = await ctx.db.query("installation").first();
    if (install?.wake === false) return null;
    const now = Date.now();
    let soonest: { at: number; what: string } | null = null;
    const consider = (at: number, what: string) => {
      if (at > now && at < now + HORIZON_MS && at < NEVER && (!soonest || at < soonest.at)) soonest = { at, what };
    };
    for (const job of await ctx.db.query("jobs").collect()) if (job.enabled) consider(job.nextRunAt, job.name);
    const reminder = await ctx.db.query("todos").withIndex("by_next_nag", (q) => q.gt("nextNagAt", now)).first();
    if (reminder?.nextNagAt && !reminder.doneAt) consider(reminder.nextNagAt, `the reminder “${reminder.title}”`);
    return soonest;
  },
});

/** Whether any turn is waiting to run or running, on any runner. */
export const busy = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    for (const runner of await ctx.db.query("runners").collect()) {
      for (const status of ["queued", "running"] as const) {
        if (await ctx.db.query("codexTurns").withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", status)).first()) return true;
      }
    }
    return false;
  },
});

/** How setting the timer went, for the Work page; unchanged reports write nothing. */
export const report = internalMutation({
  args: { at: v.optional(v.number()), what: v.optional(v.string()), error: v.optional(v.string()), awake: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (!install) return null;
    const state = { ...(args.at ? { at: args.at } : {}), ...(args.what ? { what: args.what } : {}), ...(args.error ? { error: args.error } : {}), awake: args.awake };
    const was = install.wakeState;
    if (was && was.at === state.at && was.what === state.what && was.error === state.error && was.awake === state.awake) return null;
    await ctx.db.patch(install._id, { wakeState: { ...state, checkedAt: Date.now() } });
    return null;
  },
});

export const get = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<WakeView> => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    return { enabled: install?.wake !== false, ...install?.wakeState };
  },
});

export const set = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    await ctx.db.patch(install._id, { wake: args.enabled });
    return null;
  },
});
