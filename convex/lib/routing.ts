import { ENGINE_LABELS, ENGINES, type EngineKind } from "./engines";
import { modelsOf, type ModelOption } from "./commands";
import { resetsText, usedNow, type EngineUsage } from "./usage";

/**
 * How Perry picks the engine, model and thinking level for work, and where
 * work goes when an engine's plan runs out (issue #189). One rule, said in
 * every run's details:
 *
 *   1. What the work is, and how big, gives a tier:
 *        quick     chat names, reviews of an action, the heartbeat, a reminder (a one-time job)
 *        standard  a chat, a recurring job or one an event starts, the daily summary, a background task with a short brief
 *        deep      a background task with a long brief (LONG_BRIEF), the nightly memory consolidation
 *   2. The tier gives the model and thinking level on an engine:
 *        quick     its fastest model (one named mini, flash, fast, haiku, lite, luna…), at low
 *        standard  its default model, at its default level
 *        deep      its strongest model (one named opus, pro, heavy, max…), at high
 *   3. The engine is the work's own (the one picked for it, or the engine of its own a chat is on),
 *      else the owner's default engine (installation.defaultEngine), while that has room.
 *
 * The owner's pick wins over 1 and 2, and Perry's own (create_job, queue_task) over the tier's.
 * Routing steps in only for a plan's limit: when the engine has no room, the work moves to the
 * default engine if that has room, else to the signed-in engine with the most of its plan left,
 * and says why; work the owner said to keep on its engine (`stay`) waits for its reset instead.
 * Background work with nowhere to go waits for the earliest reset rather than failing. A chat
 * moves only when its engine's plan is used up: the owner is there, and the last of a plan is
 * theirs. An engine that is only signed out is not routed around: the work stays, and says so.
 * With no engine for the work and no default chosen there is nothing to route: Perry asks the
 * owner to choose (codex.enqueueTurn), and routing never picks a default for them.
 *
 * Pure, with no server imports: the server routes with it, and the dashboard explains it.
 */

export const TIERS = ["quick", "standard", "deep"] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (value: unknown): value is Tier => (TIERS as readonly unknown[]).includes(value);

/**
 * Past this share of any of its windows, an engine takes no more background
 * work (jobs, tasks, names, reviews): the last tenth of a plan is kept for the
 * owner's own chats, which matter more than anything Perry does by itself, and
 * one long task can spend several percent of a 5-hour window. Chats use an
 * engine until it is used up.
 */
export const BACKGROUND_CAP = 90;
/**
 * A limit an engine refused a turn for, with no window that says when it ends
 * (Grok and Antigravity report none), keeps work off it this long; then the
 * next piece of work tries it again, and a refusal starts another hour.
 */
export const HIT_HOLD_MS = 60 * 60_000;
/** A background task's brief this long or longer is deep work: a paragraph or more, with several things to deliver. */
export const LONG_BRIEF = 500;
/** Work that waits for a reset starts this long after it, so the engine's own clock has turned over too. */
export const RESET_MARGIN_MS = 15_000;

export type Work =
  | { kind: "chat" }
  | { kind: "job"; builtin?: "heartbeat" | "daily-summary" | "consolidate" | "brain-review"; once?: boolean; event?: boolean }
  | { kind: "task"; brief: number }
  | { kind: "title" }
  | { kind: "review" };

/** The tier for a piece of work, and why, as a phrase: "quick, for the heartbeat". */
export function tierOf(work: Work): { tier: Tier; why: string } {
  switch (work.kind) {
    case "title": return { tier: "quick", why: "naming a chat" };
    case "review": return { tier: "quick", why: "reviewing one action" };
    case "chat": return { tier: "standard", why: "a chat" };
    case "task": return work.brief >= LONG_BRIEF
      ? { tier: "deep", why: "a background task with a long brief" }
      : { tier: "standard", why: "a background task with a short brief" };
    case "job":
      if (work.builtin === "heartbeat") return { tier: "quick", why: "the heartbeat, a quick look over what is going on" };
      if (work.builtin === "daily-summary") return { tier: "standard", why: "the daily summary" };
      if (work.builtin === "consolidate") return { tier: "deep", why: "the nightly memory consolidation" };
      if (work.builtin === "brain-review") return { tier: "deep", why: "the weekly Brain review" };
      if (work.once) return { tier: "quick", why: "a reminder, run once" };
      return { tier: "standard", why: work.event ? "a job an event starts" : "a scheduled job" };
  }
}

const QUICK_MODEL = /\b(mini|nano|flash|fast|haiku|lite|luna|small|spark|instant)\b/i;
const DEEP_MODEL = /\b(opus|pro|heavy|max|ultra)\b/i;

/** The tier's model on an engine: by name for quick and deep, else the engine's default. */
export function modelFor(models: ModelOption[], engine: EngineKind, tier: Tier): ModelOption | undefined {
  const offered = modelsOf(models, engine);
  const fallback = offered.find((model) => model.isDefault) ?? offered[0];
  const named = (pattern: RegExp, not?: RegExp) => offered.find((model) => pattern.test(`${model.id} ${model.name}`) && !not?.test(`${model.id} ${model.name}`));
  if (tier === "quick") return named(QUICK_MODEL) ?? fallback;
  if (tier === "deep") return named(DEEP_MODEL, QUICK_MODEL) ?? fallback;
  return fallback;
}

/** The tier's thinking level on a model: low, its default, or high, among those it takes. */
export function effortFor(model: ModelOption | undefined, tier: Tier): string | undefined {
  const efforts = model?.efforts ?? [];
  if (!efforts.length) return undefined;
  if (tier === "quick") return efforts.find((level) => level === "low") ?? efforts[0];
  if (tier === "deep") return efforts.includes("high") ? "high" : model?.defaultEffort ?? efforts.at(-1);
  return model?.defaultEffort ?? (efforts.includes("medium") ? "medium" : undefined);
}

/**
 * How much room an engine has for more work: none (out), not for background
 * work (low, past `cap`), or room. `until` is when that changes, when known;
 * `used` the fullest window's share, for ranking engines.
 */
export type Room = { state: "room" | "low" | "out"; used: number | null; until?: number; why?: string };

export function roomOf(engine: EngineKind, usage: EngineUsage | undefined, now: number, cap: number, timeZone?: string): Room {
  const label = ENGINE_LABELS[engine];
  const windows = usage?.limits?.windows ?? [];
  const fullest = [...windows].sort((a, b) => usedNow(b, now) - usedNow(a, now) || (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
  const used = fullest ? usedNow(fullest, now) : null;
  const resets = fullest ? resetsText(fullest, now, timeZone) : "";
  if (fullest && used !== null && used >= 100) {
    return { state: "out", used, until: fullest.resetsAt, why: `${label}'s ${fullest.label.toLowerCase()} limit is used up${resets ? ` and ${resets}` : ""}` };
  }
  // A hit is past once limits read after it show room, or after HIT_HOLD_MS when nothing says.
  const hit = usage?.hit;
  if (hit && now - hit.at < HIT_HOLD_MS && !(usage?.limits && usage.limits.at > hit.at)) {
    return { state: "out", used, until: hit.at + HIT_HOLD_MS, why: `${label} refused a reply for its plan's limit` };
  }
  if (fullest && used !== null && used >= cap) {
    return { state: "low", used, until: fullest.resetsAt, why: `${Math.round(used)}% of ${label}'s ${fullest.label.toLowerCase()} limit is used` };
  }
  return { state: "room", used };
}

/** The owner's pick for the work, which wins: a model, a thinking level, and whether it stays on its engine whatever its plan. */
export type OwnerPick = { engine?: EngineKind; model?: string; effort?: string; stay?: boolean };
/** Perry's own pick (create_job, update_job, queue_task): a tier, or a model and level. */
export type PerryPick = { tier?: Tier; engine?: EngineKind; model?: string; effort?: string };

/** Where the work was moved from, and why: what "keep it there" puts back. */
export type Moved = { engine: EngineKind; model?: string; why: string };

export type Choice = {
  engine: EngineKind;
  model?: string;
  effort?: string;
  tier: Tier;
  /** Who chose the model: the owner, Perry by its tools, or the tier's rule. */
  by: "owner" | "perry" | "auto";
  /** Said in the run's details. */
  why: string;
  movedFrom?: Moved;
  /** Nothing has room for this background work: it waits until then. */
  wait?: { until: number; why: string };
};

export type RouteInput = {
  work: Work;
  owner?: OwnerPick;
  perry?: PerryPick;
  /** The engine the work's chat is on, when it has one of its own. */
  current?: EngineKind;
  /** The owner's default engine (installation.defaultEngine): the work's engine when nothing else names one. */
  preferred?: EngineKind;
  /** What `current` is, in the run's details, when it is not simply where the work already was. */
  currentIs?: string;
  /** Signed in and recent enough on a computer that is online. */
  engines: EngineKind[];
  models: ModelOption[];
  usage: Partial<Record<EngineKind, EngineUsage>>;
  /** The owner is waiting on it (a chat): an engine is used until it is out, never left for its last tenth. */
  attended?: boolean;
  /** Engines that just refused this very turn for a limit. */
  avoid?: EngineKind[];
  now: number;
  timeZone?: string;
};

const clockAt = (at: number, timeZone?: string) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone });

/**
 * The engine, model and thinking level for a piece of work, and why; or how
 * long it waits. Null when nothing names an engine for it and the owner has
 * chosen no default: Perry asks rather than picking one.
 */
export function route(input: RouteInput): Choice | null {
  const { work, owner, perry, models, usage, now, timeZone } = input;
  const given = perry?.tier;
  const { tier, why: kind } = given ? { tier: given, why: "Perry's pick" } : tierOf(work);
  const cap = input.attended ? 100 : BACKGROUND_CAP;
  const avoid = new Set(input.avoid ?? []);
  const usable = input.engines.filter((engine) => !avoid.has(engine));
  const rooms = new Map(ENGINES.map((engine) => [engine, roomOf(engine, usage[engine], now, cap, timeZone)]));
  const room = (engine: EngineKind) => rooms.get(engine)!;
  const home = owner?.engine ?? perry?.engine ?? input.current ?? input.preferred;
  if (!home) return null;
  const whyNot = (engine: EngineKind) => avoid.has(engine) ? `${ENGINE_LABELS[engine]} refused it for its plan's limit`
    : !input.engines.includes(engine) ? `${ENGINE_LABELS[engine]} isn't signed in on a computer that is online`
      : room(engine).why ?? `${ENGINE_LABELS[engine]} has no room`;

  const pick = (engine: EngineKind): Pick<Choice, "model" | "effort" | "by"> & { said: string } => {
    const offered = modelsOf(models, engine);
    const listed = (id?: string) => id && (!offered.length || offered.some((model) => model.id === id)) ? id : undefined;
    const ownerModel = owner?.engine === engine ? listed(owner.model) : undefined;
    const perryModel = !ownerModel && (perry?.engine ?? engine) === engine ? listed(perry?.model) : undefined;
    const chosen = ownerModel ?? perryModel;
    const model = chosen ? offered.find((item) => item.id === chosen) : modelFor(models, engine, tier);
    const takes = (level?: string) => level && (!model?.efforts?.length || model.efforts.includes(level)) ? level : undefined;
    const ownerEffort = owner?.engine === undefined || owner.engine === engine ? takes(owner?.effort) : undefined;
    const perryEffort = !ownerEffort ? takes(perry?.effort) : undefined;
    const effort = ownerEffort ?? perryEffort ?? effortFor(model, tier);
    const by = ownerModel || ownerEffort ? "owner" : perryModel || perryEffort || given ? "perry" : "auto";
    const name = chosen ?? model?.id;
    const said = by === "owner" ? `Your pick: ${[name, effort].filter(Boolean).join(" at ")}`
      : by === "perry" ? `Perry's pick${given ? ` (${tier})` : ""}: ${[name, effort].filter(Boolean).join(" at ")}`
        : `${tier[0].toUpperCase()}${tier.slice(1)} tier, for ${kind}: ${[name, effort].filter(Boolean).join(" at ")}`;
    return { model: chosen ?? model?.id, effort, by, said };
  };

  const choose = (engine: EngineKind, where: string, movedFrom?: Moved): Choice => {
    const { said, ...rest } = pick(engine);
    return { engine, tier, ...rest, why: `${said}. ${where}`, ...(movedFrom ? { movedFrom } : {}) };
  };

  const where = owner?.engine === home ? "as picked" : perry?.engine === home ? "as Perry picked"
    : home === input.preferred ? "your default engine" : input.currentIs ?? "where it already was";
  // Its own engine, or the default, while that has room.
  if (usable.includes(home) && room(home).state === "room") {
    return choose(home, `On ${ENGINE_LABELS[home]}, ${where}, which has room.`);
  }
  // Routing is for a plan's limit only: work is not moved for an engine that is only signed out. It stays, and says so.
  if (!input.engines.includes(home)) return choose(home, `On ${ENGINE_LABELS[home]}, ${where}.`);
  if (owner?.stay && !input.attended) {
    // Refused just now, before its plan says so, it is given the hour a refusal holds an engine.
    const held = room(home).state === "room" ? now + HIT_HOLD_MS : room(home).until ?? now + HIT_HOLD_MS;
    const until = Math.max(now, held) + RESET_MARGIN_MS;
    const choice = choose(home, `Kept on ${ENGINE_LABELS[home]}, as you asked.`);
    return { ...choice, wait: { until, why: `${whyNot(home)}, and you asked to keep it there: it waits until ${clockAt(until, timeZone)}.` } };
  }
  // Elsewhere: the default engine when it has room, else the signed-in engine with the most of its plan left.
  const first = (engine: EngineKind) => engine === input.preferred ? 0 : 1;
  const roomy = usable.filter((engine) => room(engine).state === "room")
    .sort((a, b) => first(a) - first(b) || (room(a).used ?? 50) - (room(b).used ?? 50) || ENGINES.indexOf(a) - ENGINES.indexOf(b));
  if (roomy.length) {
    const to = roomy[0];
    const moved: Moved = { engine: home, ...(pick(home).model ? { model: pick(home).model } : {}), why: whyNot(home) };
    const there = to === input.preferred ? "your default engine" : "the signed-in engine with the most of its plan left";
    return choose(to, `Moved from ${ENGINE_LABELS[home]} to ${ENGINE_LABELS[to]}, ${there}: ${moved.why}.`, moved);
  }
  // Nowhere has room. A chat stays where it is, and its engine has the last word (a chat refused by it is not
  // moved to one that is out too).
  if (input.attended) return choose(home, `Every engine is at its plan's limit, so it stays on ${ENGINE_LABELS[home]}.`);
  // Other work waits for the first engine to have room again: one that just refused it, after the hour a refusal holds.
  const soonest = input.engines.map((engine) => ({
    engine,
    until: avoid.has(engine) && room(engine).state === "room" ? now + HIT_HOLD_MS : room(engine).until ?? now + HIT_HOLD_MS,
  })).sort((a, b) => a.until - b.until)[0];
  const until = Math.max(now, soonest.until) + RESET_MARGIN_MS;
  const choice = choose(soonest.engine, `Waited for ${ENGINE_LABELS[soonest.engine]}.`);
  return {
    ...choice,
    // What refused it is said already, by whoever tells of it (jobs.recoverJob, tasks.recoverTask): the others are why it waits.
    wait: { until, why: `No engine has room: ${(usable.length ? usable : input.engines).map(whyNot).join("; ")}. It runs at ${clockAt(until, timeZone)}, when ${ENGINE_LABELS[soonest.engine]} has room again.` },
  };
}

/**
 * A turn in a chat with someone else (issue #200): routed as an owner's chat
 * is, but only among the engines that can be locked down for it
 * (`lockable`: no shell, files or computer, only Perry's guest tools). The
 * owner's default engine while it is one of them and has room, else the
 * lockable signed-in engine with the most of its plan left; an engine that
 * runs out moves the chat to another lockable one. With none signed in, or
 * none with room, there is no turn: `none` says why, for the owner.
 */
export type GuestInput = Omit<RouteInput, "work" | "attended" | "perry" | "current" | "currentIs"> & {
  /** Engines whose runner can lock them down for this chat. */
  lockable: EngineKind[];
};

export function routeGuest(input: GuestInput): Choice | { none: string } {
  const { lockable, now, timeZone } = input;
  const label = (engine: EngineKind) => ENGINE_LABELS[engine];
  const list = (engines: EngineKind[]) => engines.map(label).join(", ") || "none";
  const usable = input.engines.filter((engine) => lockable.includes(engine));
  const avoid = new Set(input.avoid ?? []);
  const room = (engine: EngineKind) => roomOf(engine, input.usage[engine], now, 100, timeZone);
  const open = usable.filter((engine) => !avoid.has(engine));
  const notLocked = input.preferred && !lockable.includes(input.preferred) ? `${label(input.preferred)}, your default engine, can't be locked down. ` : "";
  if (!open.length) {
    const why = !input.engines.length ? "No engine is signed in on a computer that is online"
      : !usable.length ? `None of the signed-in engines (${list(input.engines)}) can be locked down: no shell, files or computer. Only ${list(lockable)} can`
        : `${list(usable)} refused it for a plan's limit`;
    return { none: `${notLocked}${why}.` };
  }
  const among = (engine?: EngineKind) => engine && usable.includes(engine) ? engine : undefined;
  const preferred = among(input.preferred);
  // Without the default among them, the lockable engine with the most of its plan left is where it starts.
  const roomiest = [...open].sort((a, b) => (room(a).state === "out" ? 1 : 0) - (room(b).state === "out" ? 1 : 0)
    || (room(a).used ?? 50) - (room(b).used ?? 50) || ENGINES.indexOf(a) - ENGINES.indexOf(b))[0];
  const owner = input.owner?.engine && usable.includes(input.owner.engine) ? input.owner : input.owner?.effort ? { effort: input.owner.effort } : undefined;
  // It follows the default as a phone chat does: the engine it was last moved to is not kept.
  const current = preferred ? undefined : roomiest;
  const choice = route({
    ...input, work: { kind: "chat" }, attended: true, engines: usable, owner, current, preferred,
    currentIs: "the one that can be locked down with the most of its plan left",
  });
  if (!choice) return { none: `${notLocked}No engine that can be locked down is signed in.` };
  // Every lockable engine is used up: a turn there would only be refused.
  const left = room(choice.engine);
  if (left.state === "out" || avoid.has(choice.engine)) return { none: `${notLocked}${left.why ?? `${label(choice.engine)} refused it for its plan's limit`}, and no other engine that can be locked down has room.` };
  // Lockable engines passed over for their plan, which the move (if any) does not say already.
  const passed = usable.filter((engine) => engine !== choice.engine && engine !== choice.movedFrom?.engine && (avoid.has(engine) || room(engine).state === "out"))
    .map((engine) => avoid.has(engine) ? `${label(engine)} refused it for its plan's limit` : room(engine).why);
  const why = `Chats with other people run only where they can be locked down (no shell, files or computer): ${list(usable)}. ${notLocked}${choice.why}${passed.length ? ` ${passed.join("; ")}.` : ""}`;
  return { ...choice, why };
}

/** The rule in a few lines, for the agent's list_engines and the run's details. */
export const ROUTING_RULE = [
  "Tiers: quick (chat names, reviews, the heartbeat, reminders) runs an engine's fastest model at low; standard (chats, recurring and event jobs, the daily summary, short background tasks) its default model at its default level; deep (background tasks with a long brief, memory consolidation) its strongest at high.",
  `The engine is the work's own (a model picked for it, or its chat's engine), else the owner's default engine, while it has room. Background work leaves an engine at ${BACKGROUND_CAP}% of any window for the default engine if that has room, else the signed-in engine with the most of its plan left, and waits for the first reset when every engine is past it. A chat moves only when its engine is used up. With no default engine chosen, Perry asks the owner to choose one rather than picking.`,
  "The owner's pick wins over Perry's, and Perry's over the tier's.",
  "Chats with other people run only on engines that can be locked down (no shell, files or computer), routed the same way among them.",
].join(" ");

/** What a run was given, in a few words: "Grok Build · grok-fake-heavy at high". */
export const routeLabel = (route: { engine: EngineKind; model?: string; effort?: string }) =>
  `${ENGINE_LABELS[route.engine]}${route.model ? ` · ${[route.model, route.effort].filter(Boolean).join(" at ")}` : ""}`;

/** Who picked what a run was given, as its details say it. */
export const PICKED_BY: Record<"owner" | "perry" | "auto", string> = { owner: "Your pick", perry: "Perry's pick", auto: "Picked by the kind of work" };
