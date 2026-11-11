import { CronDate } from "cron-parser";

/** Local midnight, including days shorter or longer than 24 hours. */
export function startOfDay(timezone: string, at = Date.now()): number {
  const date = new CronDate(at, timezone);
  date.setStartOfDay();
  return date.getTime();
}

export function previousDay(timezone: string, at: number): number {
  const date = new CronDate(at, timezone);
  date.subtractDay();
  return date.getTime();
}
