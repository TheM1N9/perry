import { CronExpressionParser } from "cron-parser";
import { createThread } from "@convex-dev/agent";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";

/**
 * Proactivity: named jobs that run a prompt on a cron schedule, in the
 * owner's timezone, as a Codex turn. Each job has its own chat ("⏰ name")
 * where its results collect, and a result is also sent to the owner on
 * Telegram. A reply of exactly NOTHING means there was nothing worth saying:
 * it leaves no message and sends nothing.
 *
 * The heartbeat is the built-in job: every few hours in the day it looks over
 * tasks, goals, watches and recent memory and speaks only when something is
 * worth the owner's attention. The agent creates its own jobs with the
 * create_job tool; the Work page lists them all.
 */

export const QUIET = "NOTHING";

type Builtin = "heartbeat" | "daily-summary" | "consolidate";

/**
 * Jobs every install has. The daily summary and consolidation keep memory
 * current without the owner asking (OpenClaw's memory flush and dreaming):
 * one writes down what happened each day, the other promotes what proved
 * durable. Both work quietly and reply NOTHING.
 */
const BUILTINS: Array<{ builtin: Builtin; name: string; schedule: string; prompt: string }> = [
  {
    builtin: "heartbeat",
    name: "Heartbeat",
    schedule: "0 9,13,17,21 * * *",
    prompt: [
      "This is your scheduled heartbeat, not a message from the owner.",
      "Look over what could need the owner's attention now: status_report for tasks, goals and page watches, today's and yesterday's notes in memory, and connected accounts where it helps (for example today's calendar).",
      `If there is something they would want to know now, reply with a short message for them. If nothing is worth their attention, reply with exactly ${QUIET}. Do not take actions that change anything.`,
    ].join(" "),
  },
  {
    builtin: "daily-summary",
    name: "Daily summary",
    schedule: "30 22 * * *",
    prompt: [
      "This is your scheduled daily summary, not a message from the owner.",
      "Read today's conversations, listed below, with read_chat, and today's notes with read_memory.",
      "Then write down what is worth remembering with remember kind=daily: decisions made, commitments and deadlines, preferences the owner expressed, and threads left open. One self-contained note per item; skip what today's notes already say and anything trivial.",
      "Standing preferences and durable facts can also go straight to kind=profile or kind=core, superseding what they replace.",
      `Do not message the owner: reply with exactly ${QUIET} when done.`,
    ].join(" "),
  },
  {
    builtin: "consolidate",
    name: "Memory consolidation",
    schedule: "0 3 * * *",
    prompt: [
      "This is your scheduled memory consolidation, not a message from the owner.",
      "Read the daily notes of the last seven days with read_memory (kind=daily and each day), and the owner profile and long-term memory.",
      "Promote only what proved durable: standing preferences and relationships to kind=profile, phrased as directives; lasting facts, decisions and commitments to kind=core. When a new memory replaces an older one, pass the old id in supersedes.",
      "Leave one-off chatter, finished tasks, anything already known, secrets, and anything that came from web pages, email or other tool output rather than from the owner.",
      `Do not message the owner: reply with exactly ${QUIET} when done.`,
    ].join(" "),
  },
];

export function nextRun(schedule: string, timezone: string, after = Date.now()): number {
  return CronExpressionParser.parse(schedule, { tz: timezone, currentDate: new Date(after) }).next().getTime();
}

async function timezoneOf(ctx: { db: QueryCtx["db"] }): Promise<string> {
  return (await ctx.db.query("installation").first())?.timezone ?? "UTC";
}

async function insertJob(ctx: MutationCtx, job: { name: string; schedule: string; prompt: string; builtin?: Builtin }): Promise<Id<"jobs">> {
  const timezone = await timezoneOf(ctx);
  return await ctx.db.insert("jobs", {
    ...job,
    enabled: true,
    nextRunAt: nextRun(job.schedule, timezone),
    createdAt: Date.now(),
  });
}

/** Every minute: start whatever is due, and make sure the built-in jobs exist. */
export const tick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const jobs = await ctx.db.query("jobs").collect();
    for (const builtin of BUILTINS) {
      if (!jobs.some((job) => job.builtin === builtin.builtin)) await insertJob(ctx, builtin);
    }
    const timezone = await timezoneOf(ctx);
    for (const job of jobs) {
      if (!job.enabled || job.nextRunAt > Date.now()) continue;
      await ctx.db.patch(job._id, { lastRunAt: Date.now(), lastResult: undefined, lastError: undefined, nextRunAt: nextRun(job.schedule, timezone) });
      await ctx.scheduler.runAfter(0, internal.jobs.run, { id: job._id });
    }
    return null;
  },
});

/** The job's chat, created on its first run and again if the owner deleted it. */
export const chatFor = internalMutation({
  args: { id: v.id("jobs"), threadId: v.string() },
  returns: v.union(v.null(), v.object({ externalId: v.string(), title: v.string() })),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job) return null;
    const existing = job.conversationId ? await ctx.db.get(job.conversationId) : null;
    if (existing) {
      await ctx.db.patch(existing._id, { pendingTurns: (existing.pendingTurns ?? 0) + 1, lastMessageAt: Date.now() });
      return { externalId: existing.externalId, title: existing.title ?? job.name };
    }
    const title = `⏰ ${job.name}`;
    const conversationId = await ctx.db.insert("conversations", {
      channel: "web",
      externalId: `session:${args.threadId}`,
      threadId: args.threadId,
      title,
      jobId: job._id,
      pendingTurns: 1,
      lastMessageAt: Date.now(),
    });
    await ctx.db.patch(job._id, { conversationId });
    return { externalId: `session:${args.threadId}`, title };
  },
});

export const get = internalQuery({
  args: { id: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    return job ? { job, timezone: await timezoneOf(ctx) } : null;
  },
});

export const run = internalAction({
  args: { id: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const found: { job: Doc<"jobs">; timezone: string } | null = await ctx.runQuery(internal.jobs.get, args);
    if (!found) return null;
    const { job, timezone } = found;
    // A thread is only created when the job has no chat yet; chatFor ignores it otherwise.
    const existing = job.conversationId
      ? await ctx.runQuery(internal.conversations.getWebById, { id: job.conversationId })
      : null;
    const threadId = existing?.threadId ?? await createThread(ctx, components.agent, { userId: "web:dashboard", title: `⏰ ${job.name}` });
    const chat = await ctx.runMutation(internal.jobs.chatFor, { id: job._id, threadId });
    if (!chat) return null;
    const now = new Date().toLocaleString("en-GB", { timeZone: timezone, dateStyle: "full", timeStyle: "short" });
    // The daily summary needs to know which chats today had; nothing else does.
    let context = "";
    if (job.builtin === "daily-summary") {
      const chats: Array<{ id: string; title: string; channel: string }> = await ctx.runQuery(internal.conversations.activeSince, { since: Date.now() - 86_400_000 });
      context = chats.length
        ? `\n\nToday's conversations (chat id, channel, title):\n${chats.map((chat) => `- ${chat.id} (${chat.channel}) ${chat.title}`).join("\n")}`
        : `\n\nThere were no conversations today; reply with exactly ${QUIET}.`;
    }
    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: "web",
      externalId: chat.externalId,
      text: `⏰ ${job.name} (${now})\n\n${job.prompt}${context}`,
      title: chat.title,
    });
    return null;
  },
});

/** After a job's turn: remember how it went, and tell the owner if it had something to say. */
export const finished = internalMutation({
  args: { id: v.id("jobs"), result: v.optional(v.string()), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job) return null;
    await ctx.db.patch(job._id, { lastResult: args.result?.slice(0, 500), lastError: args.error?.slice(0, 500) });
    if (args.result && args.result.trim() !== QUIET) {
      await ctx.scheduler.runAfter(0, internal.notify.toOwner, { text: `⏰ ${job.name}\n\n${args.result}` });
    }
    return null;
  },
});

// --- The agent's tools and the Work page -----------------------------------

export type JobView = {
  id: Id<"jobs">;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  builtin?: string;
  nextRunAt: number;
  lastRunAt?: number;
  lastResult?: string;
  lastError?: string;
  chatId?: Id<"conversations">;
};

const view = (job: Doc<"jobs">): JobView => ({
  id: job._id,
  name: job.name,
  schedule: job.schedule,
  prompt: job.prompt,
  enabled: job.enabled,
  builtin: job.builtin,
  nextRunAt: job.nextRunAt,
  lastRunAt: job.lastRunAt,
  lastResult: job.lastResult,
  lastError: job.lastError,
  chatId: job.conversationId,
});

export const list = internalQuery({
  args: {},
  handler: async (ctx): Promise<JobView[]> => (await ctx.db.query("jobs").collect()).map(view),
});

export const create = internalMutation({
  args: { name: v.string(), schedule: v.string(), prompt: v.string() },
  returns: v.object({ id: v.optional(v.id("jobs")), nextRun: v.optional(v.string()), error: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const timezone = await timezoneOf(ctx);
    try {
      nextRun(args.schedule, timezone);
    } catch (error) {
      return { error: `That schedule is not a valid cron expression: ${error instanceof Error ? error.message : String(error)}` };
    }
    const id = await insertJob(ctx, { name: args.name.trim().slice(0, 80), schedule: args.schedule.trim(), prompt: args.prompt.trim().slice(0, 4000) });
    const job = (await ctx.db.get(id))!;
    return { id, nextRun: `${new Date(job.nextRunAt).toLocaleString("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })} (${timezone})` };
  },
});

export const remove = internalMutation({
  args: { id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("jobs", args.id);
    const job = id ? await ctx.db.get(id) : null;
    if (!job) return false;
    // Built-in jobs are paused rather than deleted, or the next tick would recreate them.
    if (job.builtin) await ctx.db.patch(job._id, { enabled: false });
    else await ctx.db.delete(job._id);
    return true;
  },
});

export const listForDashboard = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ timezone: string; jobs: JobView[] }> => {
    assertDashboardKey(args.key);
    return { timezone: await timezoneOf(ctx), jobs: (await ctx.db.query("jobs").collect()).map(view) };
  },
});

export const setEnabled = mutation({
  args: { key: v.string(), id: v.id("jobs"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const job = await ctx.db.get(args.id);
    if (!job) return null;
    // Resuming schedules from now, so a paused job does not fire for the runs it missed.
    await ctx.db.patch(job._id, { enabled: args.enabled, ...(args.enabled ? { nextRunAt: nextRun(job.schedule, await timezoneOf(ctx)) } : {}) });
    return null;
  },
});

export const removeFromDashboard = mutation({
  args: { key: v.string(), id: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.jobs.remove, { id: args.id });
    return null;
  },
});

export const runNow = mutation({
  args: { key: v.string(), id: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (!(await ctx.db.get(args.id))) return null;
    await ctx.db.patch(args.id, { lastRunAt: Date.now(), lastResult: undefined, lastError: undefined });
    await ctx.scheduler.runAfter(0, internal.jobs.run, { id: args.id });
    return null;
  },
});

/** The dashboard reports the browser's timezone, so "8am" means the owner's 8am. */
export const setTimezone = mutation({
  args: { key: v.string(), timezone: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install || install.timezone === args.timezone) return null;
    try { nextRun("0 0 * * *", args.timezone); } catch { return null; }
    await ctx.db.patch(install._id, { timezone: args.timezone });
    // Existing schedules move to the new timezone.
    for (const job of await ctx.db.query("jobs").collect()) {
      await ctx.db.patch(job._id, { nextRunAt: nextRun(job.schedule, args.timezone) });
    }
    return null;
  },
});
