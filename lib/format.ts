"use client";

import { useEffect, useState } from "react";

/** A server error without the transport's prefixes and stack. */
export function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text
    .replace(/^\[CONVEX [^\]]*\]\s*/, "")
    .replace(/^\[Request ID: [^\]]*\]\s*/, "")
    .replace(/^Server Error\s*/, "")
    .replace(/^Uncaught Error:\s*/, "")
    .split("\n    at ")[0]
    .trim();
}

/** The current time, refreshed on an interval so relative times stay true. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000_000], ["month", 2_592_000_000], ["week", 604_800_000],
  ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000],
];

/** "5 min. ago", "in 2 hr.", "now". */
export function ago(timestamp: number, now = Date.now()): string {
  const diff = timestamp - now;
  if (Math.abs(diff) < 45_000) return "now";
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms || unit === "minute") return relative.format(Math.round(diff / ms), unit);
  }
  return "now";
}

export const fullDate = (timestamp: number, timeZone?: string) =>
  new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone });

export const timeOf = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Today, Yesterday, Previous 7 days, Previous 30 days, or the month: how a chat list groups by date. */
export function dayGroup(timestamp: number, now = Date.now()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (timestamp >= start.getTime()) return "Today";
  if (timestamp >= start.getTime() - day) return "Yesterday";
  if (timestamp >= start.getTime() - 7 * day) return "Previous 7 days";
  if (timestamp >= start.getTime() - 30 * day) return "Previous 30 days";
  return new Date(timestamp).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export const bytes = (size: number) =>
  size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * Copy text. The async clipboard needs a secure context, and the dashboard is
 * also opened over plain http from other devices, so there is a fallback.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return await navigator.clipboard.writeText(text);
  const focused = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  // An open modal makes the rest of the page inert, so the textarea goes inside it.
  (focused?.closest("[role=dialog]") ?? document.body).append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("The browser did not allow copying.");
  } finally {
    area.remove();
    focused?.focus();
  }
}
