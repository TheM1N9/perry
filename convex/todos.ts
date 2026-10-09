import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { targetOf, type Target } from "./channels";
import { nextRun, ownerClock, timezoneOf } from "./jobs";
import { assertDashboardKey } from "./lib/auth";
import { editButtons } from "./lib/telegram";
import { followTodo, linkNotes, notesOf, onClock } from "./memories";

/**
 * The owner's to-do list, after Petodo: things they mean to do, each with a
 * time or without. The desktop pet (app/pet) keeps it on screen and speaks up
 * as each comes due; Perry adds and ticks things off from any chat.
 *
 * A reminder follows the owner. While the pet sees them at the computer, it is
 * the pet's to give; once they are away, or there is no pet, it goes to their
 * messaging app, with Done and Push back buttons on Telegram, and asks again a
 * few times until it is done. A to-do that repeats makes its next one when it
 * is ticked off.
 */

/** The pet checks in every minute; one that has not for this long is gone. */
const PET_GONE_MS = 150_000;
/** No keyboard or mouse for this long, and the owner has stepped away. */
const AWAY_MS = 3 * 60_000;
/** After the reminder at its time, how long until each further one on the phone. Then it stops asking. */
const NAG_AFTER_MS = [10, 20, 30].map((minutes) => minutes * 60_000);
/** A to-do more than this late is not chased on the phone any more; it stays on the list. */
const NAG_FOR_MS = 12 * 3_600_000;

export type TodoView = {
  id: Id<"todos">;
  title: string;
  dueAt?: number;
  repeat?: string;
  doneAt?: number;
  by: "owner" | "assistant";
  createdAt: number;
};

const view = (todo: Doc<"todos">): TodoView => ({
  id: todo._id,
  title: todo.title,
  dueAt: todo.dueAt,
  repeat: todo.repeat,
  doneAt: todo.doneAt,
  by: todo.by,
  createdAt: todo.createdAt,
});

/** Timed ones first, soonest first; then the rest, oldest first. */
const byDue = (a: Doc<"todos">, b: Doc<"todos">) =>
  (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt;

/** The owner's calendar day, like "2026-09-26". */
const dayOf = (at: number, timezone: string) => new Date(at).toLocaleDateString("en-CA", { timeZone: timezone });

/** Midnight at the end of the owner's today. */
const endOfToday = (timezone: string, now = Date.now()) => nextRun("0 0 * * *", timezone, now);

/** The same time of day, whole days on until it is past today, so a late one does not fire the moment it moves. */
function tomorrowsTime(at: number, timezone: string): number {
  const midnight = endOfToday(timezone);
  while (at < midnight) at += 86_400_000;
  return at;
}

async function open(ctx: QueryCtx): Promise<Doc<"todos">[]> {
  return (await ctx.db.query("todos").withIndex("by_done", (q) => q.eq("doneAt", undefined)).collect()).sort(byDue);
}

/**
 * Days in a row with at least one thing done, up to today. Today still to
 * come does not break it: a streak ends only with a whole day of nothing.
 */
async function streakOf(ctx: QueryCtx, timezone: string): Promise<number> {
  const done = await ctx.db.query("todos").withIndex("by_done", (q) => q.gt("doneAt", Date.now() - 400 * 86_400_000)).order("desc").collect();
  const days = new Set(done.map((todo) => dayOf(todo.doneAt!, timezone)));
  let streak = 0;
  let at = Date.now();
  if (!days.has(dayOf(at, timezone))) at -= 86_400_000;
  while (days.has(dayOf(at, timezone))) {
    streak++;
    at -= 86_400_000;
  }
  return streak;
}

function checkRepeat(repeat: string | undefined, timezone: string): string | undefined {
  if (!repeat?.trim()) return undefined;
  try {
    nextRun(repeat.trim(), timezone);
  } catch (error) {
    throw new Error(`That repeat is not a valid cron schedule: ${error instanceof Error ? error.message : String(error)}`);
  }
  return repeat.trim();
}

const cleanTitle = (title: string) => {
  const text = title.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!text) throw new Error("A to-do needs something to do.");
  return text;
};

async function insert(ctx: MutationCtx, todo: { title: string; dueAt?: number; repeat?: string; by: "owner" | "assistant" }): Promise<Id<"todos">> {
  const now = Date.now();
  const timezone = await timezoneOf(ctx);
  const repeat = checkRepeat(todo.repeat, timezone);
  // A repeating to-do with no time of its own starts at the schedule's next time.
  const dueAt = todo.dueAt ?? (repeat ? nextRun(repeat, timezone, now) : undefined);
  return await ctx.db.insert("todos", {
    title: cleanTitle(todo.title),
    ...(dueAt ? { dueAt, nextNagAt: dueAt } : {}),
    ...(repeat ? { repeat } : {}),
    by: todo.by,
    createdAt: now,
    updatedAt: now,
  });
}

// Each change below is followed by the notes that are the plan behind the to-do (memories.followTodo),
// whether it came from Perry, the dashboard, the pet or a button on a reminder.

/** Tick it off; one that repeats makes its next, at the schedule's next time after this one. */
async function complete(ctx: MutationCtx, todo: Doc<"todos">): Promise<Id<"todos"> | null> {
  if (todo.doneAt) return null;
  const now = Date.now();
  await ctx.db.patch(todo._id, { doneAt: now, nextNagAt: undefined, updatedAt: now });
  await followTodo(ctx, { ...todo, doneAt: now }, "done");
  if (!todo.repeat) return null;
  const timezone = await timezoneOf(ctx);
  const dueAt = nextRun(todo.repeat, timezone, Math.max(todo.dueAt ?? now, now));
  return await ctx.db.insert("todos", { title: todo.title, dueAt, nextNagAt: dueAt, repeat: todo.repeat, by: todo.by, createdAt: now, updatedAt: now });
}

/** Undone, it is as it was; a repeat's next one, already made, stays. */
async function reopen(ctx: MutationCtx, todo: Doc<"todos">) {
  if (!todo.doneAt) return;
  await ctx.db.patch(todo._id, { doneAt: undefined, nextNagAt: todo.dueAt && todo.dueAt > Date.now() ? todo.dueAt : undefined, updatedAt: Date.now() });
  await followTodo(ctx, { ...todo, doneAt: undefined }, "undone");
}

/** A new time starts its reminders afresh; none leaves it untimed. */
async function reschedule(ctx: MutationCtx, todo: Doc<"todos">, dueAt: number | undefined) {
  await ctx.db.patch(todo._id, { dueAt, nextNagAt: todo.doneAt ? undefined : dueAt, nagged: undefined, updatedAt: Date.now() });
  if (dueAt !== todo.dueAt) await followTodo(ctx, { ...todo, dueAt }, "moved");
}

async function drop(ctx: MutationCtx, todo: Doc<"todos">) {
  await followTodo(ctx, todo, "dropped");
  await ctx.db.delete(todo._id);
}

async function own(ctx: QueryCtx, raw: string): Promise<Doc<"todos"> | null> {
  const id = ctx.db.normalizeId("todos", raw);
  return id ? await ctx.db.get(id) : null;
}

// --- Reminders ------------------------------------------------------------

/**
 * The pets running now, one per computer that has one (Perry's own, and any
 * paired in Settings → Desktop pet): the one the owner touched last first.
 */
export async function runningPets(ctx: QueryCtx, now = Date.now()): Promise<Doc<"petPresence">[]> {
  const rows = await ctx.db.query("petPresence").collect();
  return rows.filter((row) => now - row.seenAt < PET_GONE_MS).sort((a, b) => b.activeAt - a.activeAt || b.seenAt - a.seenAt);
}

/**
 * Whether the owner is at a computer, as the pets last saw: here at any of
 * them, away only when every pet has seen them gone; "unknown" with no pet running.
 */
export async function presenceOf(ctx: QueryCtx, now = Date.now()): Promise<"here" | "away" | "unknown"> {
  const [latest] = await runningPets(ctx, now);
  if (!latest) return "unknown";
  return now - latest.activeAt < AWAY_MS ? "here" : "away";
}

const atComputer = async (ctx: QueryCtx, now = Date.now()) => (await presenceOf(ctx, now)) === "here";

/** Every minute (crons.ts): chase what is due on the phone, unless the pet has the owner's attention. */
export const tick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db.query("todos").withIndex("by_next_nag", (q) => q.gt("nextNagAt", 0).lte("nextNagAt", now)).collect();
    if (!due.length) return null;
    const present = await atComputer(ctx, now);
    const phone = await targetOf(ctx);
    for (const todo of due) {
      if (todo.doneAt || !todo.dueAt || now - todo.dueAt > NAG_FOR_MS || !phone || phone.channel === "web") {
        await ctx.db.patch(todo._id, { nextNagAt: undefined });
        continue;
      }
      // The pet is showing it; look again in a minute, in case the owner walks away.
      if (present) {
        await ctx.db.patch(todo._id, { nextNagAt: now + 60_000 });
        continue;
      }
      const nagged = todo.nagged ?? 0;
      await ctx.db.patch(todo._id, { nagged: nagged + 1, nextNagAt: nagged < NAG_AFTER_MS.length ? now + NAG_AFTER_MS[nagged] : undefined });
      await ctx.scheduler.runAfter(0, internal.todos.remind, { id: todo._id });
    }
    return null;
  },
});

export const get = internalQuery({
  args: { id: v.id("todos") },
  handler: async (ctx, args) => {
    const todo = await ctx.db.get(args.id);
    return todo ? { todo, timezone: await timezoneOf(ctx) } : null;
  },
});

/** The words of a reminder: due now, or how late. */
function reminderText(todo: Doc<"todos">, timezone: string, now = Date.now()): string {
  const late = Math.round((now - todo.dueAt!) / 60_000);
  const when = late < 2 ? "due now" : `was due at ${ownerClock(timezone, todo.dueAt)}, ${late < 90 ? `${late} min` : `${Math.round(late / 60)} h`} ago`;
  return `⏰ ${todo.title}\n${when}`;
}

export const remind = internalAction({
  args: { id: v.id("todos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const found: { todo: Doc<"todos">; timezone: string } | null = await ctx.runQuery(internal.todos.get, { id: args.id });
    if (!found || found.todo.doneAt || !found.todo.dueAt) return null;
    const id = found.todo._id;
    // WhatsApp has no buttons: the owner answers in words, and Perry, told of this reminder, acts on it.
    const target: Target | null = await ctx.runQuery(internal.channels.target, {});
    const hint = target?.channel === "whatsapp" ? "\n\nTell me when it's done, or when to ask again." : "";
    await ctx.runAction(internal.notify.deliver, {
      // A reminder due now goes, quiet hours or not.
      from: { kind: "reminder", id: found.todo._id, name: found.todo.title },
      text: `${reminderText(found.todo, found.timezone)}${hint}`,
      buttons: [
        [{ text: "✓ Done", data: `td:${id}:d` }],
        [{ text: "Push back 10 min", data: `td:${id}:10` }, { text: "1 hour", data: `td:${id}:60` }, { text: "Tomorrow", data: `td:${id}:t` }],
      ],
    });
    return null;
  },
});

/** A tap on a reminder's button on Telegram. Returns what to tell the owner, and what the reminder now says. */
export const answerFromTelegram = internalMutation({
  args: { senderId: v.string(), data: v.string() },
  returns: v.object({ note: v.string(), card: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (!install?.claimedAt || install.ownerChannel !== "telegram" || install.ownerExternalId !== args.senderId) {
      return { note: "Only the owner can answer this." };
    }
    const match = /^td:([a-z0-9]+):(d|10|60|t)$/.exec(args.data);
    const todo = match ? await own(ctx, match[1]) : null;
    if (!match || !todo) return { note: "That to-do is gone." };
    if (todo.doneAt) return { note: "That's already done.", card: `✅ ${todo.title}` };
    if (match[2] === "d") {
      await complete(ctx, todo);
      return { note: "Done.", card: `✅ ${todo.title}` };
    }
    const timezone = await timezoneOf(ctx);
    // Tomorrow keeps its time of day; the others count from now.
    const dueAt = match[2] === "t" ? tomorrowsTime(todo.dueAt ?? Date.now(), timezone) : Date.now() + Number(match[2]) * 60_000;
    await reschedule(ctx, todo, dueAt);
    const when = dayOf(dueAt, timezone) === dayOf(Date.now(), timezone) ? ownerClock(timezone, dueAt) : `tomorrow at ${ownerClock(timezone, dueAt)}`;
    return { note: `I'll remind you ${when}.`, card: `⏰ ${todo.title}\npushed back to ${when}` };
  },
});

/** Rewrite the tapped reminder to what happened, without its buttons. Cosmetic, so a failure is only logged. */
export const settleCard = internalAction({
  args: { chatId: v.string(), messageId: v.number(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      await editButtons(token, args.chatId, args.messageId, args.text);
    } catch (error) {
      console.warn(`could not update a reminder: ${String(error)}`);
    }
    return null;
  },
});

// --- The desktop pet and the dashboard -----------------------------------

export type Board = { timezone: string; open: TodoView[]; doneToday: TodoView[]; streak: number };

export const board = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<Board> => {
    assertDashboardKey(args.key);
    const timezone = await timezoneOf(ctx);
    const today = dayOf(Date.now(), timezone);
    const recent = await ctx.db.query("todos").withIndex("by_done", (q) => q.gt("doneAt", Date.now() - 86_400_000)).order("desc").collect();
    return {
      timezone,
      open: (await open(ctx)).map(view),
      doneToday: recent.filter((todo) => dayOf(todo.doneAt!, timezone) === today).map(view),
      streak: await streakOf(ctx, timezone),
    };
  },
});

export const add = mutation({
  args: { key: v.string(), title: v.string(), dueAt: v.optional(v.number()), repeat: v.optional(v.string()) },
  returns: v.id("todos"),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await insert(ctx, { title: args.title, dueAt: args.dueAt, repeat: args.repeat, by: "owner" });
  },
});

async function mine(ctx: QueryCtx, key: string, id: Id<"todos">): Promise<Doc<"todos">> {
  assertDashboardKey(key);
  const todo = await ctx.db.get(id);
  if (!todo) throw new Error("That to-do no longer exists.");
  return todo;
}

export const setDone = mutation({
  args: { key: v.string(), id: v.id("todos"), done: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const todo = await mine(ctx, args.key, args.id);
    if (args.done) await complete(ctx, todo);
    else await reopen(ctx, todo);
    return null;
  },
});

/** Push it back by some minutes from now, as the pet's Later does. */
export const pushBack = mutation({
  args: { key: v.string(), id: v.id("todos"), minutes: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const todo = await mine(ctx, args.key, args.id);
    await reschedule(ctx, todo, Date.now() + Math.max(1, args.minutes) * 60_000);
    return null;
  },
});

export const edit = mutation({
  args: { key: v.string(), id: v.id("todos"), title: v.optional(v.string()), dueAt: v.optional(v.union(v.number(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const todo = await mine(ctx, args.key, args.id);
    if (args.title !== undefined) await ctx.db.patch(todo._id, { title: cleanTitle(args.title), updatedAt: Date.now() });
    if (args.dueAt !== undefined) await reschedule(ctx, todo, args.dueAt ?? undefined);
    return null;
  },
});

/** Make it repeat on a cron schedule, or stop; one with no time yet starts at the schedule's next. */
export const setRepeat = mutation({
  args: { key: v.string(), id: v.id("todos"), repeat: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const todo = await mine(ctx, args.key, args.id);
    const timezone = await timezoneOf(ctx);
    const repeat = checkRepeat(args.repeat ?? undefined, timezone);
    await ctx.db.patch(todo._id, { repeat, updatedAt: Date.now() });
    if (repeat && !todo.dueAt) await reschedule(ctx, todo, nextRun(repeat, timezone));
    return null;
  },
});

export const remove = mutation({
  args: { key: v.string(), id: v.id("todos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const todo = await mine(ctx, args.key, args.id);
    await drop(ctx, todo);
    return null;
  },
});

/**
 * End the day, as Petodo does: what is left of today (due today, or already
 * late) moves to tomorrow at the same time of day, or is cleared. What has no
 * time is not today's, and stays.
 */
export const endDay = mutation({
  args: { key: v.string(), action: v.union(v.literal("move"), v.literal("clear")) },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const timezone = await timezoneOf(ctx);
    const midnight = endOfToday(timezone);
    const left = (await open(ctx)).filter((todo) => todo.dueAt !== undefined && todo.dueAt < midnight);
    for (const todo of left) {
      if (args.action === "clear") {
        await drop(ctx, todo);
        continue;
      }
      await reschedule(ctx, todo, tomorrowsTime(todo.dueAt!, timezone));
    }
    return left.length;
  },
});

/**
 * Each pet checks in every minute, saying how long since the owner last
 * touched its computer, whether its Talk hotkey (and its others, `keys`)
 * are its own, and why holding the Talk keys does not work, where it does not.
 * `device` is a pet on another computer, set by the server from its key
 * (server/devices.ts); none is the pet on Perry's own computer.
 */
export const presence = mutation({
  args: {
    key: v.string(), idleSeconds: v.number(), hotkey: v.optional(v.string()), hotkeyError: v.optional(v.string()), hotkeyHold: v.optional(v.string()),
    keys: v.optional(v.record(v.string(), v.object({ hotkey: v.optional(v.string()), error: v.optional(v.string()) }))),
    device: v.optional(v.id("petDevices")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const row = { seenAt: now, activeAt: now - Math.max(0, args.idleSeconds) * 1000, hotkey: args.hotkey, hotkeyError: args.hotkeyError, hotkeyHold: args.hotkeyHold, keys: args.keys };
    const existing = (await ctx.db.query("petPresence").collect()).find((pet) => pet.device === args.device);
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("petPresence", { ...row, device: args.device });
    return null;
  },
});

// --- The agent's tools (tools.ts) ------------------------------------------

type AgentTodo = { id: string; title: string; due?: string; repeat?: string; done?: string; addedBy: string };

const forAgent = (todo: Doc<"todos">, timezone: string): AgentTodo => {
  const local = (at: number) => new Date(at).toLocaleString("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  return {
    id: todo._id,
    title: todo.title,
    ...(todo.dueAt ? { due: local(todo.dueAt) } : {}),
    ...(todo.repeat ? { repeat: todo.repeat } : {}),
    ...(todo.doneAt ? { done: local(todo.doneAt) } : {}),
    addedBy: todo.by,
  };
};

/** An ISO time from the agent, as a moment; the past is refused, so a wrong date is noticed. */
function parseAt(at: string): number {
  const dueAt = Date.parse(at);
  if (Number.isNaN(dueAt)) throw new Error(`That is not an ISO 8601 date and time: ${at}`);
  if (dueAt < Date.now() - 60_000) throw new Error(`${at} has already passed.`);
  return dueAt;
}

/** What the agent hears of the notes behind a to-do, so it does not write the change down a second time. */
async function linkedFor(ctx: QueryCtx, id: Id<"todos">): Promise<{ linkedNotes?: string[]; note?: string }> {
  const notes = await notesOf(ctx, id);
  return notes.length
    ? { linkedNotes: notes.map((note) => note._id), note: "These notes in memory are the plan behind it and follow it: they already say what changed, so do not remember the change again." }
    : {};
}

export const addFromAgent = internalMutation({
  args: { title: v.string(), at: v.optional(v.string()), repeat: v.optional(v.string()), noteIds: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<{ added?: AgentTodo; linkedNotes?: string[]; note?: string; error?: string }> => {
    try {
      const id = await insert(ctx, { title: args.title, dueAt: args.at ? parseAt(args.at) : undefined, repeat: args.repeat, by: "assistant" });
      await linkNotes(ctx, id, args.noteIds ?? []);
      return { added: forAgent((await ctx.db.get(id))!, await timezoneOf(ctx)), ...await linkedFor(ctx, id) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});

export const listForAgent = internalQuery({
  args: { includeDone: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ open: AgentTodo[]; doneThisWeek?: AgentTodo[]; streakDays: number }> => {
    const timezone = await timezoneOf(ctx);
    const done = args.includeDone
      ? await ctx.db.query("todos").withIndex("by_done", (q) => q.gt("doneAt", Date.now() - 7 * 86_400_000)).order("desc").collect()
      : null;
    return {
      open: (await open(ctx)).map((todo) => forAgent(todo, timezone)),
      ...(done ? { doneThisWeek: done.map((todo) => forAgent(todo, timezone)) } : {}),
      streakDays: await streakOf(ctx, timezone),
    };
  },
});

export const updateFromAgent = internalMutation({
  args: {
    id: v.string(),
    title: v.optional(v.string()),
    at: v.optional(v.string()),
    noTime: v.optional(v.boolean()),
    repeat: v.optional(v.string()),
    done: v.optional(v.boolean()),
    /** Notes in memory that are the plan behind it, linked first so they follow this very change. */
    noteIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ updated?: AgentTodo; next?: AgentTodo; linkedNotes?: string[]; note?: string; error?: string }> => {
    const todo = await own(ctx, args.id);
    if (!todo) return { error: "There is no to-do with that id; list_todos shows them." };
    const timezone = await timezoneOf(ctx);
    try {
      await linkNotes(ctx, todo._id, args.noteIds ?? []);
      if (args.title) await ctx.db.patch(todo._id, { title: cleanTitle(args.title), updatedAt: Date.now() });
      if (args.repeat !== undefined) await ctx.db.patch(todo._id, { repeat: checkRepeat(args.repeat, timezone), updatedAt: Date.now() });
      if (args.at || args.noTime) await reschedule(ctx, (await ctx.db.get(todo._id))!, args.at ? parseAt(args.at) : undefined);
      let next: Id<"todos"> | null = null;
      if (args.done === true) next = await complete(ctx, (await ctx.db.get(todo._id))!);
      if (args.done === false) await reopen(ctx, (await ctx.db.get(todo._id))!);
      const nextTodo = next ? await ctx.db.get(next) : null;
      return { updated: forAgent((await ctx.db.get(todo._id))!, timezone), ...(nextTodo ? { next: forAgent(nextTodo, timezone) } : {}), ...await linkedFor(ctx, todo._id) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});

export const removeFromAgent = internalMutation({
  args: { id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const todo = await own(ctx, args.id);
    if (!todo) return false;
    await drop(ctx, todo);
    return true;
  },
});

// --- The heartbeat (jobs.run) -------------------------------------------------

/**
 * The to-do list as it stands, for a heartbeat or briefing weighing what the
 * owner left open: what is still to do, and what was ticked off in the last
 * three days, in words on the owner's clock. waiting: due later, or done,
 * so a thread about it has nothing to ask yet, or any more.
 */
export const forFollowUps = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ title: string; state: string; waiting: boolean }>> => {
    const timezone = await timezoneOf(ctx);
    const now = Date.now();
    const done = await ctx.db.query("todos").withIndex("by_done", (q) => q.gt("doneAt", now - 3 * 86_400_000)).order("desc").take(20);
    return [
      ...(await open(ctx)).slice(0, 40).map((todo) => ({
        title: todo.title,
        state: !todo.dueAt ? "no set time" : todo.dueAt > now ? `due ${onClock(todo.dueAt, timezone)}, still to come` : `was due ${onClock(todo.dueAt, timezone)}, not ticked off`,
        waiting: (todo.dueAt ?? 0) > now,
      })),
      ...done.map((todo) => ({ title: todo.title, state: `done, ticked off ${onClock(todo.doneAt!, timezone)}`, waiting: true })),
    ];
  },
});
