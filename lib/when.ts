import * as chrono from "chrono-node";

/**
 * A to-do as it is typed, "call Sam 2pm", read into what to do and when, so
 * the pet can show what it understood before it is added. The time is read
 * by chrono-node, always forward: a time already past today is tomorrow's.
 * A day with no time ("tomorrow") is 9 in the morning; "tonight" is 8.
 */
export function readTodo(text: string, now = new Date()): { title: string; dueAt?: number } {
  const [found] = chrono.casual.parse(text, now, { forwardDate: true });
  if (!found) return { title: text.trim() };
  const due = found.start.date();
  if (!found.start.isCertain("hour")) {
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
  return title ? { title, dueAt: due.getTime() } : { title: text.trim() };
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
