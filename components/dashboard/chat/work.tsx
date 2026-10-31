"use client";

import {
  BrainIcon, EyeIcon, GlobeIcon, HammerIcon, HourglassIcon, ImageIcon, SearchIcon, SquarePenIcon, TerminalIcon, XIcon, type LucideIcon,
} from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { useInView } from "motion/react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Work, WorkStep } from "@/convex/dashboard";
import { tickText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkLogBlock, WorkLogButton, WorkLogDetails, WorkLogList } from "./work-log";
import { StepDetail } from "./step-card";
import { NativePlan } from "./plan";
import { Markdown } from "./markdown";
import { summarize } from "@/convex/lib/activity";

export type { Work };

/** A turn's runs as one: a message sent while a reply works joins it as a run of its own. `runIds` are all of them. */
export type Turn = Work & { runIds: Id<"runs">[] };

/** A turn saves its reply just before it ends its runs (codex.ts, markFinalized); this is room to spare. */
export const SAVED_BEFORE_END_MS = 1_000;
/** How long a run that ended stays up waiting for its reply to reach the page; one that never comes (a quiet job) goes then. */
export const LANDING_MS = 5_000;

/**
 * Runs that went as one turn: one, from the first start to the last end, with
 * the steps of all of them. Only one of a turn's runs takes steps (the
 * others are messages that joined it), so its summary stands for the turn.
 */
export function together(runs: Work[]): Turn | undefined {
  if (runs.length < 2) return runs[0] && { ...runs[0], runIds: [runs[0].runId] };
  // The first run names the turn (its runId keys the turn's fold, live and after), and the turn runs while any of its runs does.
  runs = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const ends = runs.map((run) => run.finishedAt);
  const status = runs.some((run) => run.status === "running") ? "running" : runs.find((run) => run.status !== "ok")?.status ?? "ok";
  const stepped = runs.filter((run) => run.stepCount > 0);
  return {
    ...runs[0]!,
    runIds: runs.map((run) => run.runId),
    status,
    startedAt: Math.min(...runs.map((run) => run.startedAt)),
    finishedAt: ends.every((end) => end !== undefined) ? Math.max(...(ends as number[])) : undefined,
    stepCount: stepped.reduce((sum, run) => sum + run.stepCount, 0),
    summary: stepped.length === 1 ? stepped[0]!.summary : undefined,
    stopped: runs.some((run) => run.stopped) ? true : undefined,
  };
}

/** How long something took, the way a step says it: "<1s", "12s", "1m 5s". */
export function took(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function Spinner() {
  return <span className="size-3.5 shrink-0 rounded-full border-2 border-primary/25 border-t-primary motion-safe:animate-spin motion-reduce:animate-pulse" aria-hidden />;
}

/** A running time, written by the shared second (lib/format.ts, tickText), so nothing around it renders each second. */
function Ticking({ since, live = true, className }: { since: number; live?: boolean; className?: string }) {
  return <span className={cn("nums", className)} ref={tickText((now) => took(Math.max(0, now - since)), live)} />;
}

/** What kind of step it was, by its look: a terminal for a command, a pen for a change, an eye for reading. */
function kindIcon(step: Pick<WorkStep, "kind" | "pose">): LucideIcon {
  switch (step.kind) {
    case "command": return TerminalIcon;
    case "fileChange": return SquarePenIcon;
    case "webSearch": return GlobeIcon;
    case "imageGeneration": return ImageIcon;
    case "reasoning": return BrainIcon;
  }
  switch (step.pose) {
    case "reading": return EyeIcon;
    case "searching": return SearchIcon;
    case "remembering": case "thinking": return BrainIcon;
    case "typing": return SquarePenIcon;
    case "drawing": return ImageIcon;
    case "waiting": return HourglassIcon;
    default: return HammerIcon;
  }
}

/** Where a step stands in a turn's list: a step a stopped run left open is over, and did not finish either. */
type StepState = "running" | "waiting" | "done" | "failed" | "stopped";

function stepState(step: WorkStep, live: boolean, held: boolean): StepState {
  if (step.status === "error" || step.status === "declined") return "failed";
  if (step.status !== "running") return "done";
  return !live ? "stopped" : held ? "waiting" : "running";
}

function StepEntry({ step, live, held, unresponsive }: { step: WorkStep; live: boolean; held: boolean; unresponsive: boolean }) {
  const [open, setOpen] = useState(false);
  const state = stepState(step, live, held || unresponsive);
  const Icon = state === "waiting" ? HourglassIcon : kindIcon(step);
  const why = state === "failed" ? (step.status === "declined" ? "Declined" : "Failed")
    : state === "stopped" ? "Stopped" : state === "waiting" ? (unresponsive ? "Waiting for your computer to reconnect" : "Waiting for your approval") : "";
  const label = step.kind === "reasoning" ? state === "running" ? "Thinking" : "Thought" : state === "running" || state === "waiting" ? step.label : step.done;
  return <div data-step={step.label} data-status={state === "stopped" || state === "waiting" ? state : step.status} data-kind={step.kind}>
    <WorkLogButton aria-expanded={open} onClick={() => setOpen(!open)}
      icon={<Icon className={cn("size-4", state === "failed" ? "text-destructive" : "text-muted-foreground")} aria-hidden />}
      label={<span className={cn("block truncate", state === "running" && "shimmer motion-reduce:shimmer-none")}>{label}{why && <span className="sr-only">{`, ${why}`}</span>}</span>}
      trailing={state === "running" ? <Ticking since={step.startedAt} className="shrink-0 text-xs text-muted-foreground" /> : step.durationMs !== undefined ? <span className="nums shrink-0 text-xs text-muted-foreground">{took(step.durationMs)}</span> : undefined} />
    {open && <WorkLogDetails followLive={state === "running"}><StepDetail id={step.id} /></WorkLogDetails>}
  </div>;
}

/** T3's compact group stays the same disclosure as tools start and finish. */
function ToolGroup({ steps, live, held, unresponsive }: { steps: WorkStep[]; live: boolean; held: boolean; unresponsive: boolean }) {
  const [open, setOpen] = useState(false);
  const active = live ? [...steps].reverse().find((step) => step.status === "running") : undefined;
  const tools = steps.filter((step) => step.kind !== "reasoning");
  const summary = summarize(tools, { sentence: true }) || "Thought";
  const Icon = active ? kindIcon(active) : tools.length ? kindIcon(tools[0]) : BrainIcon;
  const label = active && !open ? active.kind === "reasoning" ? "Thinking" : active.label : summary;
  const failed = steps.some((step) => step.status === "error" || step.status === "declined");
  return <div className="min-w-0 text-muted-foreground" data-tool-group>
    <WorkLogButton aria-label={failed ? `${label}, tool call failed` : undefined} aria-expanded={open} onClick={() => setOpen(!open)} icon={<Icon className={cn("size-4", failed && "text-destructive")} aria-hidden />}
      label={<span className={cn("block truncate", active && !held && !unresponsive && "shimmer motion-reduce:shimmer-none")}>{label}</span>} />
    {open && <WorkLogDetails kind="panel"><WorkLogList><div data-work-steps>{steps.map((step) => <StepEntry key={step.id} step={step} live={live} held={held} unresponsive={unresponsive} />)}</div></WorkLogList></WorkLogDetails>}
  </div>;
}

function RunSteps({ runIds, live = false, held = false, unresponsive = false, omitText }: { runIds: Id<"runs">[]; live?: boolean; held?: boolean; unresponsive?: boolean; omitText?: string }) {
  const { dashboardKey } = useSession();
  const container = useRef<HTMLDivElement>(null);
  const visible = useInView(container, { margin: "600px 0px" });
  const fetched = useQuery(api.dashboard.getRunSteps, visible || live ? { key: dashboardKey, runIds } : "skip");
  const identity = runIds.join(":");
  const cached = useRef<{ identity: string; steps: WorkStep[] } | undefined>(undefined);
  if (fetched !== undefined) cached.current = { identity, steps: fetched };
  const steps = fetched ?? (cached.current?.identity === identity ? cached.current.steps : undefined);
  if (steps === undefined) return <div ref={container}><Skeleton className="my-2 h-4 w-2/3" role="status" aria-label="Loading activity" /></div>;
  const groups: Array<{ id: string; text: string } | { id: string; steps: WorkStep[] } | { id: string; plan: WorkStep }> = [];
  const latestPlan = [...steps].reverse().find((step) => step.kind === "plan")?.id;
  const omitted = omitText?.trim() ? [...steps].reverse().find((step) => step.kind === "commentary" && step.text?.trim() === omitText.trim())?.id : undefined;
  let previous: { id: string; steps: WorkStep[] } | undefined;
  for (const step of steps) {
    if (step.kind === "plan") {
      previous = undefined;
      if (step.id === latestPlan && step.text?.trim()) groups.push({ id: "native-plan", plan: step });
    } else if (step.kind === "commentary") {
      previous = undefined;
      const text = step.text?.trim();
      if (!text || step.id === omitted) continue;
      groups.push({ id: step.id, text });
    } else if (previous) {
      previous.steps.push(step);
    } else {
      previous = { id: step.id, steps: [step] };
      groups.push(previous);
    }
  }
  return <div ref={container} className="min-w-0 pt-2" data-work-timeline>
    {groups.map((group) => <Fragment key={group.id}>{"plan" in group
      ? <NativePlan text={group.plan.text ?? ""} active={live} /> : "text" in group
      ? <div className="py-2" data-commentary><Markdown text={group.text} /></div>
      : <WorkLogBlock><ToolGroup steps={group.steps} live={live} held={held} unresponsive={unresponsive} /></WorkLogBlock>}</Fragment>)}
  </div>;
}

export function workLabel(work: Turn, state: "done" | "failed"): string {
  const time = took(Math.max(0, (work.finishedAt ?? work.startedAt) - work.startedAt));
  return `Worked for ${time}`;
}

export function WorkSummary({ work, state = "done", omitText, children }: { work: Turn; state?: "done" | "failed"; omitText?: string; children?: ReactNode }) {
  return <div className="mb-4" data-work data-work-state={state} data-run={work.runId}>
    <p className="nums border-b border-border/60 px-1 pb-2 pt-1 text-sm leading-relaxed text-muted-foreground">{workLabel(work, state)}</p>
    <RunSteps runIds={work.runIds} omitText={omitText} />
    {children}
  </div>;
}

export function Interrupted({ detail }: { detail?: string }) {
  return <div role="status" className="flex items-center gap-3 py-3 text-sm text-destructive" data-run-interrupted>
    <span className="h-px min-w-4 flex-1 bg-border/60" aria-hidden />
    <span className="flex min-w-0 items-center gap-2"><XIcon className="size-4 shrink-0" aria-hidden /><span>Run interrupted{detail && <span className="text-destructive/80"> · {detail}</span>}</span></span>
    <span className="h-px min-w-4 flex-1 bg-border/60" aria-hidden />
  </div>;
}

export function LiveWork({ work, state, omitText, children }: { work: Turn; state: "working" | "waiting" | "unresponsive"; omitText?: string; children?: ReactNode }) {
  return <div className="mb-4" data-work data-work-state={state} data-run={work.runId}>
    <p className="nums border-b border-border/60 px-1 pb-2 pt-1 text-sm leading-relaxed text-muted-foreground">
      {state === "unresponsive" ? "Computer unresponsive" : state === "waiting" ? "Waiting for your approval" : <>Working for <Ticking since={work.startedAt} /></>}
    </p>
    <RunSteps runIds={work.runIds} live held={state === "waiting"} unresponsive={state === "unresponsive"} omitText={omitText} />
    {children}
  </div>;
}
