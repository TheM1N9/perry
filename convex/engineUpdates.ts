import { v, type Infer } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isOnline, statusesOf } from "./engines";
import { assertDashboardKey } from "./lib/auth";
import { CLI_PACKAGES, ENGINE_LABELS, updateOf, type EngineKind } from "./lib/engines";
import { authenticate } from "./runner";
import { vEngine, vEngineUpdateStatus } from "./schema";

/**
 * Updating an engine's CLI from Settings, on the computer it is on. The owner
 * asks here; that computer's runner picks the request up, the way it does a
 * sign-in, and runs the command that fits how the CLI was installed there
 * (runner/versions.ts, updatePlan). It never runs one while a reply is
 * running on that engine there, and starts none on it until it is done; one
 * that would need admin rights is not run at all, and the owner is shown the
 * command instead. Afterwards the runner looks at the engine again, so a CLI
 * that was too old for Perry takes replies again at once.
 *
 * The runner works the command out itself, from where the CLI is on that
 * computer. The one kept here is only for Settings to show: nothing written
 * to this table is ever run.
 *
 * Antigravity has none: Perry downloads the one version it pins, and a newer
 * one comes with an update to Perry itself.
 */

type EngineUpdateStatus = Infer<typeof vEngineUpdateStatus>;

/** Still to finish: while one is, no other is asked for on that engine there. */
const OPEN: EngineUpdateStatus[] = ["queued", "waiting", "running"];
/** What the runner sends of what the command printed: its end, which says how it went. */
const OUTPUT_MAX = 6_000;

const rowsOf = (ctx: QueryCtx, runnerId: Id<"runners">, engine?: EngineKind) => ctx.db.query("engineUpdates")
  .withIndex("by_runner_engine", (q) => engine ? q.eq("runnerId", runnerId).eq("engine", engine) : q.eq("runnerId", runnerId))
  .collect();

// --- Dashboard side ---------------------------------------------------------

/** Update an engine's CLI on a computer. Its runner picks this up; Settings shows how it goes. */
export const request = mutation({
  args: { key: v.string(), runnerId: v.id("runners"), engine: vEngine },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const runner = await ctx.db.get(args.runnerId);
    const label = ENGINE_LABELS[args.engine];
    if (!runner || runner.revoked) throw new Error("That computer isn't connected to Perry.");
    if (!CLI_PACKAGES[args.engine]) throw new Error(`${label} comes with Perry, which downloads the version it works with. A newer one comes with an update to Perry.`);
    if (!isOnline(runner)) throw new Error(`Start Perry on ${runner.name} to update ${label} there.`);
    const status = statusesOf(runner).find((item) => item.kind === args.engine);
    if (!status?.installed && !status?.version) throw new Error(`${label} isn't installed on ${runner.name}.`);
    const update = updateOf(status);
    if (!update) throw new Error(`${label} on ${runner.name} is up to date.`);
    const rows = await rowsOf(ctx, runner._id, args.engine);
    if (rows.some((row) => OPEN.includes(row.status))) throw new Error(`${label} is already being updated on ${runner.name}.`);
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.insert("engineUpdates", {
      runnerId: runner._id, engine: args.engine, status: "queued", command: update.command, from: update.version, requestedAt: Date.now(),
    });
    return null;
  },
});

// --- Runner side ------------------------------------------------------------

/** Updates the owner asked of this runner, waiting for it. */
export const queued = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Array<{ id: Id<"engineUpdates">; engine: EngineKind }>> => {
    const runner = await authenticate(ctx, args.token);
    return (await rowsOf(ctx, runner._id)).filter((row) => row.status === "queued").map((row) => ({ id: row._id, engine: row.engine }));
  },
});

/**
 * A runner that restarted mid update cannot say how it went: that one failed,
 * to be looked at and tried again. One that was still waiting is taken up again.
 */
export const recover = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    for (const row of await rowsOf(ctx, runner._id)) {
      if (row.status === "waiting") await ctx.db.patch(row._id, { status: "queued", waitingFor: undefined });
      if (row.status === "running") {
        await ctx.db.patch(row._id, {
          status: "error", finishedAt: Date.now(),
          error: `Perry restarted on this computer during the update. ${ENGINE_LABELS[row.engine]}'s version above is what it has now; try again if it is still old.`,
        });
      }
    }
    return null;
  },
});

/** Take an update on: from now, this runner starts no new reply on that engine until it is done. */
export const claim = mutation({
  args: { token: v.string(), id: v.id("engineUpdates") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row || row.runnerId !== runner._id || row.status !== "queued") return false;
    await ctx.db.patch(row._id, { status: "waiting" });
    return true;
  },
});

/** How the update is going: waiting for replies, running with what it printed so far, then how it ended. */
export const progress = mutation({
  args: {
    token: v.string(),
    id: v.id("engineUpdates"),
    status: v.union(v.literal("waiting"), v.literal("running"), v.literal("done"), v.literal("error"), v.literal("elevate")),
    waitingFor: v.optional(v.string()),
    command: v.optional(v.string()),
    output: v.optional(v.string()),
    to: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row || row.runnerId !== runner._id || !OPEN.includes(row.status) || row.status === "queued") return null;
    const finished = !OPEN.includes(args.status);
    await ctx.db.patch(row._id, {
      status: args.status,
      waitingFor: args.status === "waiting" ? args.waitingFor?.slice(0, 200) : undefined,
      ...(args.command ? { command: args.command.slice(0, 300) } : {}),
      ...(args.output !== undefined ? { output: args.output.slice(-OUTPUT_MAX) } : {}),
      ...(args.to ? { to: args.to.slice(0, 50) } : {}),
      ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      ...(args.status === "running" && !row.startedAt ? { startedAt: Date.now() } : {}),
      ...(finished ? { finishedAt: Date.now() } : {}),
    });
    return null;
  },
});
