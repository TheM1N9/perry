import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { v } from "convex/values";
import { PATHS } from "../runner/home";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { APPROVAL_TTL_MS } from "./approvals";
import { ownerClock, timezoneOf } from "./jobs";
import { assertDashboardKey } from "./lib/auth";
import { standing, type UpdateRequest, type UpdateResult } from "./lib/checkout";
import { vUpdateBy } from "./schema";

/**
 * Perry keeping himself up to date. About once a day, and once soon after he
 * starts, he checks his checkout against the branch it follows
 * (lib/checkout.ts); an update found shows on the dashboard and the pet, one
 * click from being done. At night (NIGHT_HOUR, the owner's time) he does it
 * himself, when the owner has not turned that off and nothing is going on:
 * no reply being written or waiting to be, no approval unanswered.
 *
 * This server only decides. Updating stops it (the dashboard is rebuilt), and
 * whatever it started would be stopped with it, so the update is handed to
 * `perry run`, the process that runs this server and the runner and is
 * outside both: it finds update-request.json in Perry's folder, updates the
 * checkout, and starts them again, leaving update-result.json for the next
 * tick here to read (scripts/perry.ts, selfUpdate). Without `perry run`
 * (`pnpm dev`, a server started by hand) nothing would pick a request up, so
 * none is made, and the dashboard says why.
 */

/** The hour, on the owner's clock, Perry updates himself in. */
const NIGHT_HOUR = 4;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** `perry run` looks for a request every couple of seconds; one still there after this was never picked up. */
const PICKUP_MS = 90_000;
/** A request picked up this long ago that never said how it ended was cut off partway. */
const LOST_MS = 30 * 60_000;
/** The dashboard's server runs in the checkout: `perry run` starts it there. */
const REPO = process.cwd();

/** Whether this server runs under `perry run`, which does updates; it says so, with its PID, to the server it starts. */
function supervised(): boolean {
  const pid = Number(process.env.PERRY_SUPERVISOR);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const available = (row: Doc<"updates"> | null) => Boolean(row?.behind && !row.problem);

/** What Perry is in the middle of, if anything: an update would cut it off. */
async function busyWith(ctx: QueryCtx): Promise<string | undefined> {
  for (const runner of await ctx.db.query("runners").collect()) {
    for (const status of ["queued", "running"] as const) {
      if (await ctx.db.query("codexTurns").withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", status)).first()) return "a reply";
    }
  }
  // A web message not queued yet; the recovery sweep releases one that is stuck.
  if (await ctx.db.query("conversations").filter((q) => q.gt(q.field("pendingTurns"), 0)).first()) return "a reply";
  const recent = await ctx.db.query("runs").withIndex("by_started", (q) => q.gt("startedAt", Date.now() - HOUR_MS)).collect();
  if (recent.some((run) => run.status === "running")) return "a reply";
  for (const status of ["pending", "reviewing"] as const) {
    if (await ctx.db.query("approvals").withIndex("by_status", (q) => q.eq("status", status).gt("createdAt", Date.now() - APPROVAL_TTL_MS)).first()) return "an approval";
  }
  const pet = await ctx.db.query("petSetup").first();
  if (pet?.state === "working" && Date.now() - pet.startedAt < HOUR_MS) return "setting up the desktop pet";
  return undefined;
}

/** The hour and the day on the owner's clock. */
function ownerTime(timezone: string, at = Date.now()): { hour: number; day: string } {
  try {
    return { hour: Number(ownerClock(timezone, at).slice(0, 2)), day: new Date(at).toLocaleDateString("en-CA", { timeZone: timezone }) };
  } catch {
    return ownerTime("UTC", at);
  }
}

export type UpdateView = {
  /** Updates can run: Perry runs under `perry run` (perry start), which does them. */
  supervised: boolean;
  checkedAt?: number;
  /** How many changes there are to update to, and the newest; none while `problem` says why not. */
  behind: number;
  latest?: { sha: string; title: string };
  problem?: string;
  /** He updates himself at night. */
  auto: boolean;
  /** Waiting for Perry to finish what he is doing, or updating now. */
  state: "idle" | "waiting" | "updating";
  busy?: string;
  last?: NonNullable<Doc<"updates">["last"]>;
};

export const status = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<UpdateView> => {
    assertDashboardKey(args.key);
    const row = await ctx.db.query("updates").first();
    const install = await ctx.db.query("installation").first();
    const state = row?.requested ? "updating" : row?.wantedAt ? "waiting" : "idle";
    return {
      supervised: supervised(),
      checkedAt: row?.checkedAt,
      behind: row?.behind ?? 0,
      latest: row?.latest,
      problem: row?.problem,
      auto: install?.autoUpdate !== false,
      state,
      busy: state === "waiting" ? await busyWith(ctx) : undefined,
      last: row?.last,
    };
  },
});

/** Update now, from the dashboard or the pet; if Perry is busy, as soon as he isn't. */
export const update = mutation({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ waitingFor?: string }> => {
    assertDashboardKey(args.key);
    if (!supervised()) throw new Error("Perry updates himself when he runs in the background. Start him with perry start, or update him with perry update.");
    const row = await ctx.db.query("updates").first();
    if (!row || !available(row)) throw new Error(row?.problem ?? "There's nothing new to update to.");
    if (!row.requested && !row.wantedAt) await ctx.db.patch(row._id, { wantedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.updates.tick, {});
    return { waitingFor: await busyWith(ctx) };
  },
});

/** Look for an update now, rather than waiting for the day's check. */
export const check = action({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    await checkNow(ctx);
    return null;
  },
});

export const setAuto = mutation({
  args: { key: v.string(), on: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    await ctx.db.patch(install._id, { autoUpdate: args.on });
    return null;
  },
});

// --- The tick: checking, deciding, and reading back how an update went ------------------

export const plan = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ row: Doc<"updates"> | null; auto: boolean; timezone: string; busy?: string }> => {
    const install = await ctx.db.query("installation").first();
    return { row: await ctx.db.query("updates").first(), auto: install?.autoUpdate !== false, timezone: await timezoneOf(ctx), busy: await busyWith(ctx) };
  },
});

const vStanding = {
  head: v.optional(v.string()),
  behind: v.number(),
  latest: v.optional(v.object({ sha: v.string(), title: v.string() })),
  problem: v.optional(v.string()),
};

export const saveCheck = internalMutation({
  args: vStanding,
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("updates").first();
    const found = { ...args, checkedAt: Date.now(), ...(args.behind && !args.problem ? {} : { wantedAt: undefined }) };
    if (row) await ctx.db.patch(row._id, { head: undefined, latest: undefined, problem: undefined, ...found });
    else await ctx.db.insert("updates", found);
    return null;
  },
});

/** Hand an update to `perry run`: false when one already is. */
export const ask = internalMutation({
  args: { id: v.string(), at: v.number(), by: vUpdateBy, nightOf: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("updates").first();
    if (!row || row.requested) return false;
    await ctx.db.patch(row._id, { requested: { id: args.id, at: args.at, by: args.by }, wantedAt: undefined, ...(args.nightOf ? { nightOf: args.nightOf } : {}) });
    return true;
  },
});

const vResult = v.object({
  id: v.string(), by: vUpdateBy, at: v.number(), ok: v.boolean(),
  from: v.optional(v.string()), to: v.optional(v.string()), title: v.optional(v.string()),
  error: v.optional(v.string()), log: v.optional(v.string()),
});

export const finished = internalMutation({
  args: { result: vResult },
  returns: v.null(),
  handler: async (ctx, { result }) => {
    const row = await ctx.db.query("updates").first();
    const done = {
      last: result,
      ...(row?.requested?.id === result.id ? { requested: undefined } : {}),
      // On the new version now; the next check says whether there is more.
      ...(result.ok && result.to ? { head: result.to, behind: 0, latest: undefined } : {}),
    };
    if (row) await ctx.db.patch(row._id, done);
    else await ctx.db.insert("updates", done);
    return null;
  },
});

let checking: Promise<void> | null = null;
/** When this server last checked; the first tick after it starts checks, whatever the day's check said. */
let checkedAt = 0;

function checkNow(ctx: ActionCtx): Promise<void> {
  checking ??= standing(REPO)
    .then(async (found) => {
      checkedAt = Date.now();
      await ctx.runMutation(internal.updates.saveCheck, found);
    })
    .finally(() => { checking = null; });
  return checking;
}

/** What `perry run` left in update-result.json, if it is readable. */
function readResult(): UpdateResult | null {
  try {
    const result = JSON.parse(readFileSync(/*turbopackIgnore: true*/ PATHS.updateResult, "utf8")) as UpdateResult;
    if (typeof result.id !== "string" || typeof result.ok !== "boolean" || typeof result.at !== "number") return null;
    const text = (value: unknown, max: number) => typeof value === "string" && value ? value.slice(-max) : undefined;
    return {
      id: result.id, by: result.by === "nightly" ? "nightly" : "owner", at: result.at, ok: result.ok,
      from: text(result.from, 64), to: text(result.to, 64), title: text(result.title, 300), error: text(result.error, 1000), log: text(result.log, 6000),
    };
  } catch {
    return null;
  }
}

/** Every minute (crons.ts): how the last update went, the day's check, and whether to update now. */
export const tick = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    let plan = await ctx.runQuery(internal.updates.plan, {});
    const result = readResult();
    if (result && result.id !== plan.row?.last?.id) await ctx.runMutation(internal.updates.finished, { result });
    const requested = plan.row?.requested;
    if (requested && requested.id !== result?.id) {
      const waiting = existsSync(/*turbopackIgnore: true*/ PATHS.updateRequest);
      const failed = (error: string) => ctx.runMutation(internal.updates.finished, { result: { id: requested.id, by: requested.by, at: now, ok: false, error } });
      if (waiting && now - requested.at > PICKUP_MS) {
        rmSync(/*turbopackIgnore: true*/ PATHS.updateRequest, { force: true });
        await failed("Nothing picked the update up. Restart Perry once (perry stop, then perry start), or update him with perry update.");
      } else if (!waiting && now - requested.at > LOST_MS) {
        await failed("The update never said how it ended; Perry may have been stopped partway through. If anything looks wrong, run perry update.");
      }
    }
    plan = await ctx.runQuery(internal.updates.plan, {});

    const { hour, day } = ownerTime(plan.timezone, now);
    const night = plan.auto && hour === NIGHT_HOUR;
    const age = now - (plan.row?.checkedAt ?? 0);
    // At night the check is fresh, so an update is not missed, nor one done that is gone.
    if (!checkedAt || age > DAY_MS || (night && age > HOUR_MS)) {
      await checkNow(ctx);
      plan = await ctx.runQuery(internal.updates.plan, {});
    }

    const { row } = plan;
    if (!row || row.requested || !available(row) || !supervised()) return null;
    // Not the same failed update night after night: the owner has been told, and it is theirs now.
    const failedBefore = row.last && !row.last.ok && row.last.to === row.latest?.sha;
    const nightly = night && row.nightOf !== day && !failedBefore;
    if ((!row.wantedAt && !nightly) || plan.busy) return null;
    const request: UpdateRequest = { id: randomUUID(), at: Date.now(), by: row.wantedAt ? "owner" : "nightly" };
    if (!(await ctx.runMutation(internal.updates.ask, { ...request, ...(request.by === "nightly" ? { nightOf: day } : {}) }))) return null;
    try {
      writeFileSync(/*turbopackIgnore: true*/ PATHS.updateRequest, JSON.stringify(request));
    } catch (error) {
      await ctx.runMutation(internal.updates.finished, { result: { ...request, at: Date.now(), ok: false, error: `Couldn't hand the update over: ${error instanceof Error ? error.message : String(error)}` } });
    }
    return null;
  },
});
