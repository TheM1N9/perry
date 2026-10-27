"use client";

import {
  BrainIcon, EyeIcon, GlobeIcon, HammerIcon, HourglassIcon, ImageIcon, SearchIcon, SquarePenIcon, TerminalIcon, type LucideIcon,
} from "lucide-react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Work, WorkStep } from "@/convex/dashboard";
import { tickText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { StepDetail } from "./step-card";

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

/**
 * One step, one line: its kind's icon (red when it failed), what it did, or
 * while it runs what it is doing, and how long it took. A click opens what it
 * did (StepDetail).
 */
function StepLine({ step, state, unresponsive = false }: { step: WorkStep; state: StepState; unresponsive?: boolean }) {
  const Icon = state === "waiting" ? HourglassIcon : kindIcon(step);
  const why = state === "failed" ? (step.status === "declined" ? "Declined" : "Failed")
    : state === "stopped" ? "Stopped" : state === "waiting" ? (unresponsive ? "Waiting for your computer to reconnect" : "Waiting for your approval") : "";
  return (
    <TraceLine className="min-h-6" status={state === "running" ? "running" : state === "failed" ? "error" : undefined}>
      <TraceIcon><Icon className={cn("size-4", state === "failed" ? "text-destructive" : "text-muted-foreground")} /></TraceIcon>
      <TraceTitle>{state === "running" || state === "waiting" ? step.label : step.done}</TraceTitle>
      {why && <span className="sr-only">{`, ${why}`}</span>}
      {state === "running"
        ? <TraceDescription className="text-xs"><Ticking since={step.startedAt} /></TraceDescription>
        : step.durationMs !== undefined && <TraceDescription className="nums text-xs">{took(step.durationMs)}</TraceDescription>}
    </TraceLine>
  );
}

/**
 * Every step of a turn's runs, in the order it took them, read only while
 * shown (dashboard.getRunSteps), in a list that scrolls past 18rem. While the
 * turn runs the list grows, and stays at its end if it was there.
 */
function RunSteps({ runIds, live = false, held = false, unresponsive = false }: { runIds: Id<"runs">[]; live?: boolean; held?: boolean; unresponsive?: boolean }) {
  const { dashboardKey } = useSession();
  const steps = useQuery(api.dashboard.getRunSteps, { key: dashboardKey, runIds });
  const list = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const element = list.current;
    if (element && live && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [steps?.length, live]);
  if (steps === undefined) return <Skeleton className="my-1 h-3.5 w-2/3" role="status" aria-label="Loading the steps" />;
  return (
    <Trace data-work-steps>
      <ol ref={list} className="-mx-1 flex max-h-[min(18rem,50dvh)] min-w-0 flex-col overflow-y-auto px-1 py-0.5" aria-label="Steps"
        onScroll={(event) => { const element = event.currentTarget; atEnd.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 4; }}>
        {steps.map((step) => {
          const state = stepState(step, live, held || unresponsive);
          return (
            <TraceCollapsible key={step.id} render={<li />} data-step={step.label} data-status={state === "stopped" || state === "waiting" ? state : step.status} data-kind={step.kind}>
              <TraceCollapsibleTrigger><StepLine step={step} state={state} unresponsive={unresponsive} /></TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="mt-1 mb-2"><StepDetail id={step.id} /></TraceCollapsibleContent>
            </TraceCollapsible>
          );
        })}
      </ol>
    </Trace>
  );
}

/** What a finished turn's fold says: "Worked for 46s · Ran 2 commands and changed 3 files", or "You stopped after 12s". */
export function workLabel(work: Turn, state: "done" | "failed"): string {
  const time = took(Math.max(0, (work.finishedAt ?? work.startedAt) - work.startedAt));
  const what = work.summary || (work.stepCount ? `Took ${work.stepCount} ${work.stepCount === 1 ? "step" : "steps"}` : "");
  const lead = work.stopped ? `You stopped after ${time}` : state === "failed" ? `Failed after ${time}` : `Worked for ${time}`;
  return what ? `${lead} · ${what}` : lead;
}

/**
 * Which turns' folds the owner opened or closed, by the turn's first run: one
 * fold is drawn live while the turn runs and above its reply after, and the
 * owner's choice goes with it. Untouched, a fold is closed.
 */
const Folds = createContext<{ chosen: ReadonlyMap<string, boolean>; choose: (runId: string, open: boolean) => void } | null>(null);

export function WorkFolds({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const choose = useCallback((runId: string, open: boolean) => setChosen((was) => new Map(was).set(runId, open)), []);
  const value = useMemo(() => ({ chosen, choose }), [chosen, choose]);
  return <Folds.Provider value={value}>{children}</Folds.Provider>;
}

/** Whether a turn's fold is open, kept by the chat (WorkFolds) so it stays as the owner left it when the turn ends. */
function useFold(runId: string): [boolean, (open: boolean) => void] {
  const folds = useContext(Folds);
  const [own, setOwn] = useState(false);
  const open = folds ? folds.chosen.get(runId) ?? false : own;
  return [open, (next) => folds ? folds.choose(runId, next) : setOwn(next)];
}

/**
 * A finished turn's work, folded into one line above its reply: "Worked for
 * 46s · Ran 2 commands and changed 3 files", its steps a click away (read
 * from the server only once opened).
 */
export function WorkSummary({ work, state = "done" }: { work: Turn; state?: "done" | "failed" }) {
  const [open, setOpen] = useFold(work.runId);
  const line = (
    <TraceLine status={state === "failed" && !work.stopped ? "error" : undefined}>
      <TraceTitle className="nums">{workLabel(work, state)}</TraceTitle>
    </TraceLine>
  );
  const data = { "data-work": true, "data-work-state": state, "data-run": work.runId };
  return (
    <Trace className="mb-2">
      {work.stepCount > 0 ? (
        <TraceCollapsible open={open} onOpenChange={setOpen} {...data}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="mt-1.5"><RunSteps runIds={work.runIds} /></TraceCollapsibleContent>
        </TraceCollapsible>
      ) : <p {...data}>{line}</p>}
    </Trace>
  );
}

/**
 * A turn's work while it runs: "Working for 12s", its time kept by the
 * shared second, and under it the one step it is on, or the last it took,
 * read alone (getRunSteps with a limit of one). A click on either opens every
 * step, live. `waiting`: the turn holds on the owner's approval, so it is
 * not working; `unresponsive`: its computer stopped answering.
 */
export function LiveWork({ work, state }: { work: Turn; state: "working" | "waiting" | "unresponsive" }) {
  const { dashboardKey } = useSession();
  const [open, setOpen] = useFold(work.runId);
  const fold = useRef<HTMLDivElement>(null);
  // The step line goes as the list opens from it; the fold's own line takes the focus it had.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!open || !refocus.current) return;
    refocus.current = false;
    fold.current?.querySelector<HTMLElement>("[data-slot=trace-collapsible-trigger]")?.focus();
  }, [open]);
  const stepped = work.stepCount > 0;
  const latest = useQuery(api.dashboard.getRunSteps, stepped && !open ? { key: dashboardKey, runIds: work.runIds, limit: 1 } : "skip")?.at(-1);
  const held = state !== "working";
  const head = (
    <TraceLine className="min-h-6" status={state === "working" ? "running" : undefined}>
      <TraceIcon>{state === "working" ? <Spinner /> : <HourglassIcon className="size-3.5" />}</TraceIcon>
      <TraceTitle className="nums">
        {state === "unresponsive" ? "Computer unresponsive" : state === "waiting" ? "Waiting for your approval" : <>Working for <Ticking since={work.startedAt} /></>}
      </TraceTitle>
    </TraceLine>
  );
  // Both lines open the fold, so a click on either is the reader's, and the chat stops following (use-chat-scroll.ts).
  const data = { "data-work": true, "data-work-state": state, "data-run": work.runId };
  if (!stepped) return <Trace className="mb-2" {...data}><p>{head}</p></Trace>;
  return (
    <Trace ref={fold} className="mb-2 gap-0.5" {...data}>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="mt-1.5">
          <RunSteps runIds={work.runIds} live held={state === "waiting"} unresponsive={state === "unresponsive"} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {!open && latest && (
        <button type="button" aria-expanded={false} aria-label={`${latest.status === "running" ? latest.label : latest.done}. Show every step`}
          data-live-step={latest.label} data-status={latest.status} data-kind={latest.kind}
          onClick={(event) => { refocus.current = event.currentTarget === document.activeElement; setOpen(true); }}>
          <StepLine step={latest} state={stepState(latest, true, held)} unresponsive={state === "unresponsive"} />
        </button>
      )}
    </Trace>
  );
}
