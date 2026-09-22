import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Tasks, goals, monitors and command receipts: the things that outlive a single
 * message.
 *
 * Chat is a bad place to keep state. Ask an agent what it is doing and it will
 * cheerfully reconstruct a plausible answer from context. These tables are the
 * alternative: the plan is a row it has to write to, so progress is something
 * you can read rather than something it claims.
 */

const vPlanStep = v.object({
  title: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("active"),
    v.literal("done"),
    v.literal("skipped"),
  ),
  note: v.optional(v.string()),
});

const vTaskStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("blocked"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("cancelled"),
);

// --- Tasks ---------------------------------------------------------------

export const createTask = internalMutation({
  args: {
    title: v.string(),
    prompt: v.string(),
    goalId: v.optional(v.id("goals")),
  },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("tasks", {
      title: args.title.slice(0, 160),
      prompt: args.prompt.slice(0, 12000),
      status: "running",
      goalId: args.goalId,
      plan: [],
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Tool-facing ids arrive as plain strings, because that is what a model can
 * produce. normalizeId turns a wrong one into null instead of an exception.
 */
export const setPlan = internalMutation({
  args: { taskId: v.string(), plan: v.array(vPlanStep) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("tasks", args.taskId);
    if (!id) return null;
    await ctx.db.patch(id, {
      plan: args.plan.slice(0, 40),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const updateTask = internalMutation({
  args: {
    taskId: v.string(),
    status: v.optional(vTaskStatus),
    question: v.optional(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { taskId, ...rest }) => {
    const id = ctx.db.normalizeId("tasks", taskId);
    if (!id) return null;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(id, patch);
    return null;
  },
});

export const getTask = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args): Promise<Doc<"tasks"> | null> => {
    const id = ctx.db.normalizeId("tasks", args.taskId);
    return id ? await ctx.db.get(id) : null;
  },
});

export const listTasks = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<"tasks">[]> => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_updated")
      .order("desc")
      .take(Math.min(args.limit ?? 20, 100));
  },
});

// --- Goals ---------------------------------------------------------------

export const createGoal = internalMutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    milestones: v.array(v.string()),
  },
  returns: v.id("goals"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("goals", {
      title: args.title.slice(0, 160),
      description: args.description,
      status: "active",
      milestones: args.milestones
        .slice(0, 20)
        .map((title) => ({ title: title.slice(0, 200), done: false })),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateGoal = internalMutation({
  args: {
    id: v.id("goals"),
    status: v.optional(
      v.union(v.literal("active"), v.literal("paused"), v.literal("done")),
    ),
    completeMilestones: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.id);
    if (!goal) return null;

    const done = new Set(
      (args.completeMilestones ?? []).map((t) => t.trim().toLowerCase()),
    );

    await ctx.db.patch(args.id, {
      status: args.status ?? goal.status,
      milestones: goal.milestones.map((m) =>
        done.has(m.title.trim().toLowerCase()) ? { ...m, done: true } : m,
      ),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const listGoals = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"goals">[]> => {
    return await ctx.db.query("goals").order("desc").take(50);
  },
});

// --- Monitors ------------------------------------------------------------

export const createMonitor = internalMutation({
  args: {
    title: v.string(),
    url: v.string(),
    condition: v.union(
      v.literal("change"),
      v.literal("contains"),
      v.literal("price_below"),
    ),
    value: v.optional(v.string()),
    intervalMinutes: v.number(),
  },
  returns: v.id("monitors"),
  handler: async (ctx, args) => {
    const interval = Math.min(Math.max(Math.floor(args.intervalMinutes), 5), 10080);
    return await ctx.db.insert("monitors", {
      title: args.title.slice(0, 160),
      url: args.url,
      condition: args.condition,
      value: args.value,
      intervalMinutes: interval,
      active: true,
      nextCheckAt: Date.now(),
      failures: 0,
      createdAt: Date.now(),
    });
  },
});

export const listMonitors = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"monitors">[]> => {
    return await ctx.db.query("monitors").order("desc").take(50);
  },
});

/** Monitors whose next check is in the past. The cron drains this. */
export const dueMonitors = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"monitors">[]> => {
    const now = Date.now();
    const due = await ctx.db
      .query("monitors")
      .withIndex("by_next_check", (q) => q.lte("nextCheckAt", now))
      .take(10);
    return due.filter((m) => m.active);
  },
});

export const recordCheck = internalMutation({
  args: {
    id: v.id("monitors"),
    fingerprint: v.optional(v.string()),
    observation: v.optional(v.string()),
    fired: v.boolean(),
    failed: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.id);
    if (!monitor) return null;

    const failures = args.failed ? monitor.failures + 1 : 0;

    await ctx.db.patch(args.id, {
      lastFingerprint: args.fingerprint ?? monitor.lastFingerprint,
      lastObservation: args.observation ?? monitor.lastObservation,
      lastCheckedAt: Date.now(),
      nextCheckAt: Date.now() + monitor.intervalMinutes * 60_000,
      failures,
      // Ten failures in a row means the page is gone or blocking us. Stop
      // rather than hammering it forever.
      active: failures < 10 && monitor.active,
      ...(args.fired ? { firedAt: Date.now() } : {}),
    });
    return null;
  },
});

export const deleteMonitor = internalMutation({
  args: { monitorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("monitors", args.monitorId);
    if (id) await ctx.db.delete(id);
    return null;
  },
});

export const toggleMonitor = internalMutation({
  args: { monitorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("monitors", args.monitorId);
    if (!id) return null;
    const monitor = await ctx.db.get(id);
    if (!monitor) return null;
    await ctx.db.patch(id, {
      active: !monitor.active,
      failures: 0,
      nextCheckAt: Date.now(),
    });
    return null;
  },
});

export const setMonitorActive = internalMutation({
  args: { id: v.id("monitors"), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { active: args.active });
    return null;
  },
});

// --- Command receipts ----------------------------------------------------

export const findReceipt = internalQuery({
  args: { operationId: v.string() },
  handler: async (ctx, args): Promise<Doc<"receipts"> | null> => {
    return await ctx.db
      .query("receipts")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
  },
});

export const startReceipt = internalMutation({
  args: { operationId: v.string(), command: v.string() },
  returns: v.id("receipts"),
  handler: async (ctx, args): Promise<Id<"receipts">> => {
    return await ctx.db.insert("receipts", {
      operationId: args.operationId,
      command: args.command.slice(0, 4000),
      startedAt: Date.now(),
    });
  },
});

export const finishReceipt = internalMutation({
  args: {
    id: v.id("receipts"),
    exitCode: v.optional(v.number()),
    output: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, ...rest }) => {
    await ctx.db.patch(id, { ...rest, finishedAt: Date.now() });
    return null;
  },
});

// --- Snapshot ------------------------------------------------------------

/** Everything the agent is allowed to know about its own workload. */
export const snapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [tasks, goals, monitors] = await Promise.all([
      ctx.db.query("tasks").withIndex("by_updated").order("desc").take(10),
      ctx.db.query("goals").order("desc").take(10),
      ctx.db.query("monitors").order("desc").take(10),
    ]);

    return {
      tasks: tasks.map((t) => ({
        id: t._id,
        title: t.title,
        status: t.status,
        plan: t.plan,
        question: t.question,
        result: t.result,
      })),
      goals: goals.map((g) => ({
        id: g._id,
        title: g.title,
        status: g.status,
        milestones: g.milestones,
      })),
      monitors: monitors.map((m) => ({
        id: m._id,
        title: m.title,
        url: m.url,
        condition: m.condition,
        value: m.value,
        active: m.active,
        lastObservation: m.lastObservation,
        lastCheckedAt: m.lastCheckedAt,
      })),
    };
  },
});
