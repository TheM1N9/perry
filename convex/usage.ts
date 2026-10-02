import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { ENGINE_LABELS, ENGINES, isEngine, RUNNABLE_ENGINES, type EngineKind } from "./lib/engines";
import { engineFor } from "./installation";
import { USAGE_REPORTS, type EngineUsage } from "./lib/usage";
import { isOnline, statusesOf } from "./engines";
import { authenticate } from "./runner";
import { vEngine, vLimitHit, vPlanLimits } from "./schema";

/**
 * How much of each engine's subscription is used and what is left, as the
 * engines report it (runner/index.ts reads them), and Perry's own share: the
 * tokens its replies, jobs and tasks used, from each run's usage.
 *
 * The limits are kept on the runner that read them, one entry per engine:
 * two computers signed in to the same account read the same limits, and the
 * newest read wins.
 */

const HOUR = 3_600_000;
/** How far back Perry's share is counted. */
const SHARE_MS = 7 * 24 * HOUR;
/** Runs read for it, at most: far more than a week of replies. */
const RUNS_READ = 5_000;

/** An engine's limits, or a limit it hit, or a turn that went through again after one. */
export const report = mutation({
  args: { token: v.string(), engine: vEngine, limits: v.optional(vPlanLimits), hit: v.optional(v.union(vLimitHit, v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const before: EngineUsage = runner.usage?.[args.engine] ?? {};
    const limits = args.limits ?? before.limits;
    // null: a turn went through, so the last hit is over.
    const hit = args.hit === null ? undefined : args.hit ? { at: args.hit.at, message: args.hit.message.slice(0, 500) } : before.hit;
    const next: EngineUsage = { ...(limits ? { limits } : {}), ...(hit ? { hit } : {}) };
    // A fresh reading counts as read even when nothing changed: the Usage page's refresh waits for it.
    const read = args.limits ? { usageReadAt: Date.now() } : {};
    if (JSON.stringify(next) === JSON.stringify(before)) {
      if (args.limits) await ctx.db.patch(runner._id, read);
      return null;
    }
    await ctx.db.patch(runner._id, { usage: { ...runner.usage, [args.engine]: next }, ...read });
    return null;
  },
});

/** A refresh asked again within this is the same one: the runner is already reading. */
const REFRESH_GAP_MS = 10_000;

/** From the Usage page: read every signed-in engine's plan limits now, not at the next five minutes. */
export const requestRefresh = mutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Perry isn't set up yet.");
    const now = Date.now();
    if (install.usageRefreshAt && now - install.usageRefreshAt < REFRESH_GAP_MS) return install.usageRefreshAt;
    await ctx.db.patch(install._id, { usageRefreshAt: now });
    return now;
  },
});

/** For a runner: when the owner last asked for a refresh, so it reads every engine's limits again. */
export const refreshAt = query({
  args: { token: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token);
    return (await ctx.db.query("installation").first())?.usageRefreshAt ?? null;
  },
});

/** The engine a finished run's label names ("claude/opus · high", "codex subscription", lib/commands.ts runLabel). */
const labelled = (run: Doc<"runs">): EngineKind | undefined => {
  const named = run.model?.match(/^(\w+)(?:\/| subscription)/)?.[1];
  return isEngine(named) ? named : undefined;
};

/** The engine a run was on: its label says, else its chat's (or the default it follows). None for a run refused for want of one. */
const engineOfRun = async (ctx: QueryCtx, run: Doc<"runs">, chat: Doc<"conversations"> | null): Promise<EngineKind | undefined> => labelled(run) ?? (chat ? await engineFor(ctx, chat) : undefined);

/** Each engine's usage, the newest read across the computers it is on. */
export function usageByEngine(runners: Doc<"runners">[]): Partial<Record<EngineKind, EngineUsage>> {
  const merged: Partial<Record<EngineKind, EngineUsage>> = {};
  for (const runner of runners) {
    for (const [kind, usage] of Object.entries(runner.usage ?? {})) {
      if (!isEngine(kind)) continue;
      const known = merged[kind];
      merged[kind] = {
        limits: (usage.limits?.at ?? 0) >= (known?.limits?.at ?? 0) ? usage.limits ?? known?.limits : known?.limits,
        hit: (usage.hit?.at ?? 0) >= (known?.hit?.at ?? 0) ? usage.hit ?? known?.hit : known?.hit,
      };
    }
  }
  return merged;
}

export const liveRunners = async (ctx: QueryCtx) => (await ctx.db.query("runners").order("desc").take(20)).filter((runner) => !runner.revoked);

/**
 * Perry's runs since `since` that used the plan, newest first, each with its
 * chat and engine: those that went through, and those that failed after
 * using tokens. One refused outright (a limit hit) used nothing.
 */
async function runsSince(ctx: QueryCtx, since: number) {
  const runs = (await ctx.db.query("runs").withIndex("by_started", (q) => q.gte("startedAt", since)).order("desc").take(RUNS_READ))
    .filter((run) => run.status === "ok" || run.status === "running" || (run.usage?.totalTokens ?? 0) > 0);
  const chats = new Map<Id<"conversations">, Doc<"conversations"> | null>();
  for (const run of runs) if (!chats.has(run.conversationId)) chats.set(run.conversationId, await ctx.db.get(run.conversationId));
  return (await Promise.all(runs.map(async (run) => {
    const chat = chats.get(run.conversationId) ?? null;
    return { run, chat, engine: await engineOfRun(ctx, run, chat), tokens: run.usage?.totalTokens ?? 0 };
  }))).filter((item): item is typeof item & { engine: EngineKind } => item.engine !== undefined);
}

/**
 * Each engine's limits, for the chat and the pet to warn by, and the engines
 * Perry ran on this week: the pet warns only about those.
 */
export const limits = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ engines: Array<{ kind: EngineKind; usage: EngineUsage }>; used: EngineKind[] }> => {
    assertDashboardKey(args.key);
    const merged = usageByEngine(await liveRunners(ctx));
    // The latest runs are enough to say which engines are in use, and keep this light: it reruns as each reply streams.
    const recent = await ctx.db.query("runs").withIndex("by_started", (q) => q.gte("startedAt", Date.now() - SHARE_MS)).order("desc").take(200);
    const used = new Set<EngineKind>();
    for (const run of recent) {
      const engine = await engineOfRun(ctx, run, labelled(run) ? null : await ctx.db.get(run.conversationId));
      if (engine) used.add(engine);
    }
    return {
      engines: ENGINES.flatMap((kind) => merged[kind] ? [{ kind, usage: merged[kind] }] : []),
      used: [...used],
    };
  },
});

export type ShareItem = {
  id: Id<"conversations">;
  title: string;
  /** A chat with the owner, one with someone else, a schedule's, or a background task's. */
  kind: "chat" | "contact" | "job" | "task";
  channel: Doc<"conversations">["channel"] | "deleted";
  engines: EngineKind[];
  tokens: number;
  turns: number;
  lastAt: number;
};

export type EngineOverview = {
  kind: EngineKind;
  label: string;
  note: string;
  reportsLimits: boolean;
  tokens: "all" | "most" | "none";
  /** On a computer that is online. */
  installed: boolean;
  /** Signed in on one. */
  signedIn: boolean;
  plan?: string;
  usage?: EngineUsage;
  /** Perry's use of it: this week, and within each of its limit windows so far. */
  share: { week: { tokens: number; turns: number }; windows: Record<string, { tokens: number; turns: number; since: number }> };
};

/** Settings → Usage: each engine's limits beside Perry's share of them, and what used the most this week. */
export const overview = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ engines: EngineOverview[]; items: ShareItem[]; since: number; computers: number; readAt?: number; refreshAt?: number }> => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const runners = await liveRunners(ctx);
    const merged = usageByEngine(runners);
    const since = now - SHARE_MS;
    const runs = await runsSince(ctx, since);

    const statuses = runners.filter(isOnline).flatMap(statusesOf);
    // Every engine Perry drives is listed, set up or not, so what each can tell is plain before it is.
    const engines = RUNNABLE_ENGINES.flatMap((kind): EngineOverview[] => {
      const found = statuses.filter((status) => status.kind === kind);
      const usage = merged[kind];
      const mine = runs.filter((item) => item.engine === kind);
      const count = (from: number) => {
        const within = mine.filter((item) => item.run.startedAt >= from);
        return { tokens: within.reduce((sum, item) => sum + item.tokens, 0), turns: within.length };
      };
      const windows: EngineOverview["share"]["windows"] = {};
      for (const window of usage?.limits?.windows ?? []) {
        // A window's start is its reset less its length; one already reset has started again since.
        if (!window.minutes || !window.resetsAt) continue;
        const start = window.resetsAt > now ? window.resetsAt - window.minutes * 60_000 : window.resetsAt;
        windows[window.id] = { ...count(start), since: start };
      }
      const signedIn = found.find((status) => status.signedIn);
      return [{
        kind,
        label: ENGINE_LABELS[kind],
        note: USAGE_REPORTS[kind].note,
        reportsLimits: USAGE_REPORTS[kind].limits,
        tokens: USAGE_REPORTS[kind].tokens,
        installed: found.some((status) => status.installed),
        signedIn: Boolean(signedIn),
        plan: usage?.limits?.plan ?? signedIn?.auth.plan,
        usage,
        share: { week: count(since), windows },
      }];
    });

    const byChat = new Map<Id<"conversations">, { chat: Doc<"conversations"> | null; engines: Set<EngineKind>; tokens: number; turns: number; lastAt: number }>();
    for (const { run, chat, engine, tokens } of runs) {
      const item = byChat.get(run.conversationId) ?? { chat, engines: new Set<EngineKind>(), tokens: 0, turns: 0, lastAt: 0 };
      item.engines.add(engine);
      item.tokens += tokens;
      item.turns += 1;
      item.lastAt = Math.max(item.lastAt, run.startedAt);
      byChat.set(run.conversationId, item);
    }
    const top = [...byChat].sort(([, a], [, b]) => b.tokens - a.tokens || b.turns - a.turns).slice(0, 15);
    const items = await Promise.all(top.map(async ([id, item]): Promise<ShareItem> => {
      const chat = item.chat;
      const job = chat?.jobId ? await ctx.db.get(chat.jobId) : null;
      const task = chat?.taskId ? await ctx.db.get(chat.taskId) : null;
      const contact = chat?.contactId ? await ctx.db.get(chat.contactId) : null;
      return {
        id,
        title: job?.name ?? task?.title ?? (contact ? `Chat with ${contact.name}` : chat?.title) ?? (chat ? "Untitled chat" : "Deleted chat"),
        kind: chat?.jobId ? "job" : chat?.taskId ? "task" : chat?.contactId ? "contact" : "chat",
        channel: chat?.channel ?? "deleted",
        engines: [...item.engines],
        tokens: item.tokens,
        turns: item.turns,
        lastAt: item.lastAt,
      };
    }));
    // When any computer last read a plan, and when the owner last asked for it read again.
    const readAt = Math.max(0, ...runners.map((runner) => runner.usageReadAt ?? 0)) || undefined;
    const refreshAt = (await ctx.db.query("installation").first())?.usageRefreshAt;
    return { engines, items, since, computers: runners.length, ...(readAt ? { readAt } : {}), ...(refreshAt ? { refreshAt } : {}) };
  },
});
