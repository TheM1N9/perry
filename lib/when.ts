import * as chrono from "chrono-node";

/**
 * A to-do as it is typed, "call Sam 2pm", read into what to do and when, so
 * it can be shown before it is added. The time is read by chrono-node, always
 * forward: a time already past today is tomorrow's. A day with no time
 * ("tomorrow") is 9 in the morning; "tonight" is 8. A repeat said with it
 * ("every day at 11", "weekdays 9:30", "every monday", "monthly") makes it a
 * repeating to-do, due first when the repeat first comes round.
 */
export function readTodo(text: string, now = new Date()): { title: string; dueAt?: number; repeat?: string; repeatName?: string } {
  const said = readRepeat(text);
  const read = readTime(said ? said.rest : text, now);
  if (!said) return read.title ? { title: read.title, ...(read.due ? { dueAt: read.due.getTime() } : {}) } : { title: text.trim() };
  if (!read.title) return { title: text.trim() };
  // Its time of day as said, 9 in the morning if none; its day or date, the one named, or the one said, or today's.
  const at = new Date(read.due ?? now);
  if (!read.due || !read.timed) at.setHours(9, 0, 0, 0);
  if (said.day !== undefined) at.setDate(at.getDate() + ((said.day - at.getDay() + 7) % 7));
  // In January, which has every date: this month may not have a 31st.
  if (said.date !== undefined) at.setMonth(0, said.date);
  const repeat = cronFor(said.repeat, at);
  return { title: read.title, dueAt: firstOf(said.repeat, at, now).getTime(), repeat, repeatName: describeSchedule(repeat) ?? REPEAT_NAMES[said.repeat] };
}

/** The time in a to-do, if any, and what is left of it without the time. */
function readTime(text: string, now: Date): { title: string; due?: Date; timed: boolean } {
  const [found] = chrono.casual.parse(text, now, { forwardDate: true });
  if (!found) return { title: text.trim(), timed: false };
  const due = found.start.date();
  const timed = found.start.isCertain("hour");
  if (!timed) {
    due.setHours(/\btonight\b/i.test(found.text) ? 20 : 9, 0, 0, 0);
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  }
  // What is left once the time is taken out, without the little words that led up to it.
  const title = `${text.slice(0, found.index)} ${text.slice(found.index + found.text.length)}`
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(at|on|by|for|from|until|due)$/i, "")
    .replace(/^(at|on|by)\s+/i, "")
    .trim();
  // Nothing but a time ("2pm") is not a to-do yet.
  return title ? { title, due, timed } : { title: "", timed };
}

/** "2:00 PM", "Tomorrow 9:00 AM", "Wed 3:30 PM", "Oct 4": short enough for a row. */
export function dueLabel(dueAt: number, now = Date.now()): string {
  const due = new Date(dueAt);
  const clock = due.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `Tomorrow ${clock}`;
  if (days === -1) return `Yesterday ${clock}`;
  if (days > 1 && days < 7) return `${due.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "4:12" to go, or "12 min" late: a countdown the pet can say. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

// --- Repeats -----------------------------------------------------------------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The repeats a to-do can be given in a click; anything else Perry sets in a chat, as a cron schedule. */
export const REPEATS = ["daily", "weekdays", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];
export const REPEAT_NAMES: Record<Repeat, string> = { daily: "Every day", weekdays: "Weekdays", weekly: "Every week", monthly: "Every month" };

/**
 * A repeat as the cron schedule the server keeps (in the owner's timezone,
 * which is this computer's): at `at`'s time of day, and weekly on its day of
 * the week, monthly on its day of the month.
 */
export function cronFor(repeat: Repeat, at: Date): string {
  const time = `${at.getMinutes()} ${at.getHours()}`;
  if (repeat === "daily") return `${time} * * *`;
  if (repeat === "weekdays") return `${time} * * 1-5`;
  if (repeat === "weekly") return `${time} * * ${at.getDay()}`;
  return `${time} ${at.getDate()} * *`;
}

/** Which of the click-able repeats a cron schedule is, if any. */
export function repeatOf(schedule: string | undefined): Repeat | null {
  const parts = schedule?.trim().split(/\s+/);
  if (!parts || parts.length !== 5 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || parts[3] !== "*") return null;
  const [, , dayOfMonth, , dayOfWeek] = parts;
  if (dayOfMonth === "*" && dayOfWeek === "*") return "daily";
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return "weekdays";
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) return "weekly";
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return "monthly";
  return null;
}

/** How a repeat reads on a to-do's row: "Daily", "Weekdays", "Mondays", "Monthly". */
export function repeatLabel(schedule: string): string {
  const repeat = repeatOf(schedule);
  if (repeat === "daily") return "Daily";
  if (repeat === "weekdays") return "Weekdays";
  if (repeat === "weekly") return `${DAYS[Number(schedule.trim().split(/\s+/)[4])]}s`;
  if (repeat === "monthly") return "Monthly";
  return "Repeats";
}

/** A plain-English reading of the common cron shapes; anything else is shown as written. */
export function describeSchedule(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const clock = (h: string) => new Date(2000, 0, 1, Number(h), Number(minute)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? clock(hour) : null;
  if (/^\*\/\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every ${minute.slice(2)} minutes`;
  if (/^\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every hour at :${minute.padStart(2, "0")}`;
  if (/^\d+$/.test(minute) && /^\*\/\d+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every ${hour.slice(2)} hours`;
  if (/^\d+$/.test(minute) && /^\d+(,\d+)+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Daily at ${hour.split(",").map(clock).join(", ")}`;
  if (!at || month !== "*") return null;
  if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${at}`;
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Weekdays at ${at}`;
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) return `Every ${DAYS[Number(dayOfWeek)]} at ${at}`;
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `Monthly on day ${dayOfMonth} at ${at}`;
  return null;
}

/** The first time a repeat comes round, at or after `from`. */
export function firstOf(repeat: Repeat, at: Date, from = new Date()): Date {
  const next = new Date(from);
  next.setHours(at.getHours(), at.getMinutes(), 0, 0);
  if (repeat === "monthly") {
    // Month by month until its date is still to come; a 31st skips the shorter months, as the schedule does.
    for (let month = 0; ; month++) {
      const on = new Date(from.getFullYear(), from.getMonth() + month, at.getDate(), at.getHours(), at.getMinutes());
      if (on.getDate() === at.getDate() && on.getTime() > from.getTime()) return on;
    }
  }
  // A day at a time until it is a day the repeat falls on, and still to come.
  const falls = (day: Date) => repeat === "daily" || (repeat === "weekdays" ? day.getDay() >= 1 && day.getDay() <= 5 : day.getDay() === at.getDay());
  while (next.getTime() <= from.getTime() || !falls(next)) next.setDate(next.getDate() + 1);
  return next;
}

/** How a repeat is said in a to-do as typed, and what it means. The day or date named goes with it. */
const SAID: Array<{ pattern: RegExp; repeat: Repeat; day?: (match: RegExpMatchArray) => number; date?: (match: RegExpMatchArray) => number | undefined }> = [
  { pattern: /\b(?:every ?day|each day|daily)\b/i, repeat: "daily" },
  { pattern: /\b(?:(?:on |every )?weekdays|every week ?day|every work ?day)\b/i, repeat: "weekdays" },
  { pattern: /\b(?:every|each|on) (sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?\b|\b(sun|mon|tues|wednes|thurs|fri|satur)days\b/i, repeat: "weekly",
    day: (match) => ["su", "mo", "tu", "we", "th", "fr", "sa"].indexOf((match[1] ?? match[2]).slice(0, 2).toLowerCase()) },
  { pattern: /\b(?:every week|each week|weekly)\b/i, repeat: "weekly" },
  { pattern: /\b(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th) (?:of )?(?:every|each) month\b|\b(?:every month|each month|monthly)(?: on the (\d{1,2})(?:st|nd|rd|th)?\b)?/i, repeat: "monthly",
    date: (match) => { const date = Number(match[1] ?? match[2]); return date >= 1 && date <= 31 ? date : undefined; } },
];

/** A repeat said in a to-do ("every day", "weekdays", "every monday", "monthly"), taken out of its text. */
export function readRepeat(text: string): { rest: string; repeat: Repeat; day?: number; date?: number } | null {
  for (const said of SAID) {
    const match = text.match(said.pattern);
    if (!match || match.index === undefined) continue;
    const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.replace(/\s+/g, " ").trim();
    const date = said.date?.(match);
    return { rest, repeat: said.repeat, ...(said.day ? { day: said.day(match) } : {}), ...(date ? { date } : {}) };
  }
  return null;
}
