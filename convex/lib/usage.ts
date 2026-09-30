import { ENGINE_LABELS, type EngineKind } from "./engines";

/**
 * How much of the owner's subscription each engine has used and what is
 * left, as the engine itself reports it, and when Perry warns about it.
 *
 * Pure, with no server imports: the runner, the server, the dashboard and the
 * pet all read limits the same way.
 */

/** One of a plan's limits: a share of it used, over a window that starts again at `resetsAt`. */
export type PlanWindow = {
  /** Stable within an engine, such as "codex:primary" or "five_hour". */
  id: string;
  /** As the owner would say it: "5-hour", "Weekly", "Weekly (Opus)". */
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  resetsAt?: number;
  /** How long the window is, when the engine says. */
  minutes?: number;
};

/** An engine's limits, as it last reported them. */
export type PlanLimits = { windows: PlanWindow[]; plan?: string; at: number };

/** The engine refused a turn because a limit was hit ("You've hit your usage limit…"): when, and what it said. */
export type LimitHit = { at: number; message: string };

/** What the server keeps per engine on a runner: its limits, and the last limit it hit, until a turn goes through again. */
export type EngineUsage = { limits?: PlanLimits; hit?: LimitHit };

/** Past this share of a window, Perry warns before the limit is hit. */
export const WARN_PERCENT = 80;
/** How often the runner reads an engine's limits while nothing runs (runner/index.ts). */
export const LIMITS_EVERY_MS = 5 * 60_000;

/**
 * A turn that failed because the owner's plan is used up, by what its engine
 * said: Codex's "You've hit your usage limit", Claude Code's "usage limit
 * reached", Grok's "You've hit the rate limit for your plan" or "out of
 * credits". A passing overload ("try again in a moment") is not one.
 */
export const LIMIT_HIT = /hit your (?:\w+ )*(?:usage|rate) limit|usage limit (?:reached|exceeded)|(?:reached|exceeded) your (?:\w+ )*(?:usage|rate) limit|rate limit for your plan|out of (?:credits|messages)|usage balance exhausted|usage_limit_(?:reached|exceeded)|limit (?:will )?resets? (?:at|on)/i;

/** "5-hour", "Weekly", "Daily", from a window's length. */
export function windowLabel(minutes?: number | null): string {
  if (!minutes) return "Limit";
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes === 24 * 60) return "Daily";
  if (minutes === 30 * 24 * 60) return "Monthly";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** A window as it stands now: one whose reset has passed has started again, so nothing of it is known to be used. */
export const usedNow = (window: PlanWindow, now: number) => window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent;

export type LimitLevel = "ok" | "low" | "out";

/**
 * Where an engine stands: out (a window used up, or it refused a turn for its
 * limit since it last went through), low (a window past WARN_PERCENT), or ok.
 * `window` is the one that decides it: the fullest, and of two as full, the
 * one that resets last.
 */
export function standing(usage: EngineUsage | undefined, now: number): { level: LimitLevel; window?: PlanWindow; hit?: LimitHit } {
  const windows = usage?.limits?.windows ?? [];
  const fullest = [...windows].sort((a, b) => usedNow(b, now) - usedNow(a, now) || (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
  const used = fullest ? usedNow(fullest, now) : 0;
  // A hit is past once the limits read after it show every window with room again.
  const hit = usage?.hit && !(usage.limits && usage.limits.at > usage.hit.at && used < 100) ? usage.hit : undefined;
  if (used >= 100 || hit) return { level: "out", window: used >= 100 ? fullest : undefined, hit };
  if (used >= WARN_PERCENT) return { level: "low", window: fullest };
  return { level: "ok", window: fullest };
}

const clock = (at: number, now: number, timeZone?: string) => {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString() && at - now < 86_400_000;
  return new Date(at).toLocaleString(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit", timeZone }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
};

/** "resets at 3:40 PM", "resets Sat, Oct 4, 4:11 PM". */
export const resetsText = (window: PlanWindow, now: number, timeZone?: string) =>
  window.resetsAt && window.resetsAt > now ? `resets ${new Date(window.resetsAt).toDateString() === new Date(now).toDateString() ? "at " : ""}${clock(window.resetsAt, now, timeZone)}` : "";

/**
 * What Perry says about an engine near or at its limit, in the chat and on
 * the pet: null while there is room.
 */
export function limitWarning(engine: EngineKind, usage: EngineUsage | undefined, now: number, timeZone?: string): { level: Exclude<LimitLevel, "ok">; title: string; detail: string } | null {
  const { level, window, hit } = standing(usage, now);
  const label = ENGINE_LABELS[engine];
  if (level === "ok") return null;
  if (level === "out") {
    const until = window && resetsText(window, now, timeZone);
    return {
      level,
      title: window ? `${label}'s ${window.label.toLowerCase()} limit is used up` : `${label} hit its plan's limit`,
      detail: [
        until ? `It ${until}.` : hit ? `${label} said: “${hit.message.slice(0, 200)}”` : "",
        "Until then, replies on it fail: pick another engine's model to keep going.",
      ].filter(Boolean).join(" "),
    };
  }
  const until = window && resetsText(window, now, timeZone);
  return {
    level,
    title: `${label} is running low`,
    detail: `${Math.round(window!.usedPercent)}% of the ${window!.label.toLowerCase()} limit is used${until ? `; it ${until}` : ""}.`,
  };
}

/**
 * What each engine can tell about its plan, said plainly for the Usage page.
 * `limits`: it reports its plan's windows; `hits`: it only says when a limit
 * is hit; `tokens` whether its turns report the tokens they use.
 */
export const USAGE_REPORTS: Record<EngineKind, { limits: boolean; tokens: "all" | "most" | "none"; note: string }> = {
  codex: {
    limits: true, tokens: "all",
    note: "Codex reports your ChatGPT plan's limits: how much of the 5-hour and weekly windows is used, and when each resets. It counts all your Codex use, not only Perry's.",
  },
  claude: {
    limits: true, tokens: "most",
    note: "Claude Code reports your Claude plan's limits: the 5-hour window, the weekly one and any per-model weekly limit. It counts all your Claude use. Tokens a subagent uses are not in Perry's share.",
  },
  grok: {
    limits: false, tokens: "all",
    note: "Grok Build doesn't say how much of your plan is used or left. Perry shows the tokens its replies used, and says so here when Grok refuses a reply for your plan's limit.",
  },
  antigravity: {
    limits: false, tokens: "none",
    note: "Antigravity reports neither your plan's limits nor the tokens its replies use. Perry counts its replies, and says so here when it refuses one for a limit.",
  },
  cursor: {
    limits: false, tokens: "none",
    note: "Cursor isn't one of Perry's engines yet.",
  },
};
