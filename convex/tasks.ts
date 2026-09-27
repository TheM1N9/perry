import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { createThread } from "./lib/agent";
import { assertDashboardKey } from "./lib/auth";

/**
 * Background tasks (issue #102): work Perry takes on and carries out by
 * itself, one at a time, as Perplexity's Background Assistant, Claude Cowork
 * and Manus do with a to-do list.
 *
 * A task is queued (queue_task, or the Work page). When nothing else is
 * running, it runs in a chat of its own, a Codex turn at a time: it lays out
 * its plan (set_plan) and works, and ends with finish_task. A turn that ends
 * without finishing is followed by another, up to MAX_TURNS. Blocked on a
 * question, it asks the owner where the task was asked for (and their phone
 * when they are away, by notify.ts), and waits; their answer (resume_task, or
 * the Work page) puts it back in the queue with the answer. Done or failed,
 * the result goes back to the same place.
 */

/** Turns a task may take before it is stopped, so a task that never finishes cannot run forever. */
const MAX_TURNS = 6;

/** The owner's words and the task's, for a turn of it. */
function promptFor(task: Doc<"tasks">): string {
  const rules =
    `You are working on this by yourself: the owner is not in this chat and does not read your replies. Keep its plan current with set_plan (task id ${task._id}), ` +
    "and end by calling finish_task: done with the result (what you made and where), blocked with one clear question only if you truly " +
    "need the owner, or failed with why. Only finish_task reaches the owner; a reply alone leaves the task open. Do the work now; do not ask for permission to start.";
  if (task.answer) return `🧩 ${task.title}\n\nThe owner answered your question: "${task.answer}"\n\nCarry on with the task.\n\n${rules}`;
  if ((task.turns ?? 0) > 1) {
    return `🧩 ${task.title}\n\nYour last turn ended without calling finish_task, so the task is still open and the owner has seen nothing. ` +
      `If your last reply was the result, call finish_task now with outcome done and that result. Otherwise carry on where you left off; its plan shows what is done.\n\n${rules}`;
  }
  return `🧩 Background task: ${task.title}\n\n${task.prompt}\n\n${rules}`;
}

/** Queue a task. It starts when nothing else is running. */
export const queue = internalMutation({
  args: { title: v.string(), prompt: v.string(), goalId: v.optional(v.id("goals")), origin: v.optional(v.id("conversations")) },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("tasks", {
      title: args.title.trim().slice(0, 160),
      prompt: args.prompt.trim().slice(0, 12000),
      status: "queued",
      ...(args.goalId ? { goalId: args.goalId } : {}),
      ...(args.origin ? { origin: args.origin } : {}),
      plan: [],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.tasks.tick, {});
    return id;
  },
});

/**
 * Start the oldest queued task when none is running: every minute (crons.ts),
 * and whenever one is queued or finishes.
 */
export const tick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // A background task has turns from the moment it starts (its chat comes a moment later); a task opened by start_task in a chat is only tracked.
    const running = (await ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", "running")).collect()).filter((task) => task.turns);
    if (running.length) return null;
    const next = (await ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", "queued")).collect()).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return null;
    await ctx.db.patch(next._id, { status: "running", turns: (next.turns ?? 0) + 1, question: undefined, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.tasks.work, { id: next._id });
    return null;
  },
});

export const get = internalQuery({
  args: { id: v.id("tasks") },
  handler: async (ctx, args): Promise<Doc<"tasks"> | null> => await ctx.db.get(args.id),
});

/** The task's own chat, made on its first turn (and again if the owner deleted it). */
export const chatFor = internalMutation({
  args: { id: v.id("tasks"), threadId: v.string() },
  returns: v.union(v.null(), v.object({ externalId: v.string(), title: v.string() })),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) return null;
    const existing = task.conversationId ? await ctx.db.get(task.conversationId) : null;
    if (existing) return { externalId: existing.externalId, title: existing.title ?? task.title };
    const title = `🧩 ${task.title}`;
    const install = await ctx.db.query("installation").first();
    const conversationId = await ctx.db.insert("conversations", {
      channel: "web",
      externalId: `session:${args.threadId}`,
      threadId: args.threadId,
      title,
      taskId: task._id,
      access: install?.defaultAccess,
      lastMessageAt: Date.now(),
    });
    await ctx.db.patch(task._id, { conversationId });
    return { externalId: `session:${args.threadId}`, title };
  },
});

/** One turn of the task, in its own chat. */
export const work = internalAction({
  args: { id: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task: Doc<"tasks"> | null = await ctx.runQuery(internal.tasks.get, { id: args.id });
    if (!task || task.status !== "running") return null;
    const existing = task.conversationId ? await ctx.runQuery(internal.conversations.getWebById, { id: task.conversationId }) : null;
    const threadId = existing?.threadId ?? await createThread(ctx, { userId: "web:dashboard", title: `🧩 ${task.title}` });
    const chat = await ctx.runMutation(internal.tasks.chatFor, { id: task._id, threadId });
    if (!chat) return null;
    await ctx.runMutation(internal.tasks.clearAnswer, { id: task._id });
    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, { channel: "web", externalId: chat.externalId, text: promptFor(task), title: chat.title });
    return null;
  },
});

export const clearAnswer = internalMutation({
  args: { id: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { answer: undefined });
    return null;
  },
});

/**
 * After each turn in a task's chat (codex.finalizeTurn), or when one could not
 * run (brain.handleTurn): carry on, or say how it ended where it was asked for.
 */
export const afterTurn = internalMutation({
  args: { id: v.id("tasks"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) return null;
    let status = task.status;
    if (status === "running" && args.error) {
      await ctx.db.patch(task._id, { status: "failed", error: `It could not run: ${args.error}`.slice(0, 2000), updatedAt: Date.now() });
      status = "failed";
    } else if (status === "running") {
      if ((task.turns ?? 0) < MAX_TURNS) {
        await ctx.db.patch(task._id, { turns: (task.turns ?? 0) + 1, updatedAt: Date.now() });
        await ctx.scheduler.runAfter(0, internal.tasks.work, { id: task._id });
        return null;
      }
      await ctx.db.patch(task._id, { status: "failed", error: `Stopped after ${MAX_TURNS} turns without finishing; its chat shows how far it got.`, updatedAt: Date.now() });
      status = "failed";
    }
    const fresh = (await ctx.db.get(task._id))!;
    const text = status === "blocked" ? `🧩 **${fresh.title}** needs you:\n\n${fresh.question ?? "It has a question."}\n\nAnswer here, or on the Work page, and it carries on.`
      : status === "done" ? `🧩 **${fresh.title}** is done.\n\n${fresh.result ?? ""}`.trim()
        : status === "failed" ? `🧩 **${fresh.title}** could not be finished.\n\n${fresh.error ?? ""}`.trim()
          : null;
    if (text) await ctx.scheduler.runAfter(0, internal.notify.deliver, { text, ...(fresh.origin ? { origin: fresh.origin } : {}) });
    // Whatever happened, the next task in line may start.
    await ctx.scheduler.runAfter(0, internal.tasks.tick, {});
    return null;
  },
});

/** The owner answered a blocked task's question: it goes back in the queue with the answer. False if it was not waiting. */
export const resume = internalMutation({
  args: { id: v.string(), answer: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("tasks", args.id);
    const task = id ? await ctx.db.get(id) : null;
    if (!task || task.status !== "blocked" || !args.answer.trim()) return false;
    await ctx.db.patch(task._id, { status: "queued", answer: args.answer.trim().slice(0, 4000), question: undefined, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.tasks.tick, {});
    return true;
  },
});

// --- The Work page -------------------------------------------------------------------

export const queueFromDashboard = mutation({
  args: { key: v.string(), title: v.string(), prompt: v.string(), goalId: v.optional(v.id("goals")) },
  returns: v.id("tasks"),
  handler: async (ctx, args): Promise<Id<"tasks">> => {
    assertDashboardKey(args.key);
    if (args.title.trim().length < 2) throw new Error("Give the task a short name.");
    if (args.prompt.trim().length < 10) throw new Error("Say what Perry should do, in a sentence or so.");
    return await ctx.runMutation(internal.tasks.queue, { title: args.title, prompt: args.prompt, ...(args.goalId ? { goalId: args.goalId } : {}) });
  },
});

export const answerFromDashboard = mutation({
  args: { key: v.string(), id: v.id("tasks"), answer: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    if (!(await ctx.runMutation(internal.tasks.resume, { id: args.id, answer: args.answer }))) throw new Error("That task is not waiting for an answer.");
    return null;
  },
});
