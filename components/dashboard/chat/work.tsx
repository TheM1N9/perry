"use client";

import { CheckIcon, HourglassIcon, MinusIcon, XIcon } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Work, WorkStep } from "@/convex/dashboard";
import { plural } from "@/lib/format";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { StepDetail } from "./step-card";

export type { Work };

/** A turn saves its reply just before it ends its runs (codex.ts, markFinalized); this is room to spare. */
export const SAVED_BEFORE_END_MS = 1_000;
/** How long a run that ended stays up waiting for its reply to reach the page; one that never comes (a quiet job) goes then. */
export const LANDING_MS = 5_000;

/**
 * Runs that went as one turn (a message sent while a reply works joins it as
 * a run of its own): one, from the first start to the last end, with all
 * their steps in the order they were taken.
 */
export function together(runs: Work[]): Work | undefined {
  if (runs.length < 2) return runs[0];
  // The first run names the turn (its runId keys the turn's fold, live and after), and the turn runs while any of its runs does.
  runs = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const ends = runs.map((run) => run.finishedAt);
  const status = runs.some((run) => run.status === "running") ? "running" : runs.find((run) => run.status !== "ok")?.status ?? "ok";
  return {
    ...runs[0]!,
    status,
    startedAt: Math.min(...runs.map((run) => run.startedAt)),
    finishedAt: ends.every((end) => end !== undefined) ? Math.max(...(ends as number[])) : undefined,
    steps: runs.flatMap((run) => run.steps).sort((a, b) => a.startedAt - b.startedAt),
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

/**
 * Each step of a run, in the order it took them: done, failed or declined,
 * and while the run goes, the one still running, with how long it has taken.
 * A step opens, by a click, to what it did (StepDetail). `held`: the turn
 * waits on the owner's approval, so the step still open waits too.
 */
export function WorkSteps({ steps, live = false, held = false, now = 0 }: { steps: WorkStep[]; live?: boolean; held?: boolean; now?: number }) {
  return (
    <Trace data-work-steps>
      <ol className="flex min-w-0 flex-col gap-1">
        {steps.map((step) => {
          // A step open while the turn waits on the owner waits with it; one a stopped run left open is over, and did not finish either.
          const waits = live && held && step.status === "running";
          const running = live && !held && step.status === "running";
          const stopped = !live && step.status === "running";
          const failed = step.status === "error" || step.status === "declined";
          const time = running ? took(now - step.startedAt) : step.durationMs !== undefined ? took(step.durationMs) : "";
          return (
            <TraceCollapsible key={step.id} render={<li />}
              data-step={step.label} data-status={stopped ? "stopped" : waits ? "waiting" : step.status} data-kind={step.kind}>
              <TraceCollapsibleTrigger>
                <TraceLine status={running ? "running" : failed ? "error" : undefined}>
                  {running
                    ? <TraceIcon><Spinner /></TraceIcon>
                    : waits
                      ? <TraceIcon aria-hidden={false}><HourglassIcon className="size-3.5" aria-label="Waiting for your approval" /></TraceIcon>
                      : failed
                        ? <TraceIcon aria-hidden={false}><XIcon className="size-3.5" aria-label={step.status === "declined" ? "Declined" : "Failed"} /></TraceIcon>
                        : stopped
                          ? <TraceIcon aria-hidden={false}><MinusIcon className="size-3.5" aria-label="Stopped" /></TraceIcon>
                          : <TraceIcon><CheckIcon className="size-3.5 text-primary" /></TraceIcon>}
                  <TraceTitle>{step.label}</TraceTitle>
                  {time && <TraceDescription className="nums text-xs">{time}</TraceDescription>}
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="mt-1 mb-2"><StepDetail id={step.id} /></TraceCollapsibleContent>
            </TraceCollapsible>
          );
        })}
      </ol>
    </Trace>
  );
}

/**
 * Where a turn's work stands. `waiting`: it holds on the owner's approval, so
 * it is not working; `failed`: it ended in an error, or was rejected.
 */
export type WorkState = "working" | "waiting" | "done" | "failed";

/** What a turn's fold says: "Working for 12s · 3 steps" while it runs, "Worked for 46s · 3 steps" after. */
export function workLabel(work: Work, state: WorkState, now: number): string {
  const steps = work.steps.length ? ` · ${plural(work.steps.length, "step")}` : "";
  if (state === "working") return `Working for ${took(Math.max(0, now - work.startedAt))}${steps}`;
  if (state === "waiting") return `Waiting for your approval${steps}`;
  const end = work.finishedAt ?? Math.max(work.startedAt, ...work.steps.map((step) => step.startedAt + (step.durationMs ?? 0)));
  return `${state === "failed" ? "Failed after" : "Worked for"} ${took(end - work.startedAt)}${steps || " · 0 steps"}`;
}

/**
 * Which turns' folds the owner opened or closed, by the turn's first run: one
 * fold is drawn live while the turn runs and above its reply after, and the
 * owner's choice goes with it. Untouched, a fold is open while its turn runs
 * (the steps join it as they come) and closed after.
 */
const Folds = createContext<{ chosen: ReadonlyMap<string, boolean>; choose: (runId: string, open: boolean) => void } | null>(null);

export function WorkFolds({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const choose = useCallback((runId: string, open: boolean) => setChosen((was) => new Map(was).set(runId, open)), []);
  const value = useMemo(() => ({ chosen, choose }), [chosen, choose]);
  return <Folds.Provider value={value}>{children}</Folds.Provider>;
}

/**
 * A turn's work, folded into one line, its steps a click away: "Working for
 * 12s · 3 steps" from the moment it starts, live, and the same fold, now
 * "Worked for 46s · 3 steps", above its reply after. The chat keeps whether
 * it is open by the turn (Work.runId), so it stays as the owner left it when
 * the turn ends and the fold moves above the reply.
 */
export function WorkSummary({ work, state = "done", now = 0 }: { work: Work; state?: WorkState; now?: number }) {
  const live = state === "working" || state === "waiting";
  const folds = useContext(Folds);
  const [own, setOwn] = useState<boolean | undefined>(undefined);
  const open = (folds ? folds.chosen.get(work.runId) : own) ?? live;
  const onOpenChange = (next: boolean) => folds ? folds.choose(work.runId, next) : setOwn(next);
  const label = workLabel(work, state, now);
  const line = (
    <TraceLine status={state === "working" ? "running" : undefined}>
      {state === "working" && <TraceIcon><Spinner /></TraceIcon>}
      <TraceTitle className="nums">{label}</TraceTitle>
    </TraceLine>
  );
  const data = { "data-work": true, "data-work-state": state, "data-run": work.runId };
  return (
    <Trace className="mb-2">
      {work.steps.length > 0 ? (
        <TraceCollapsible open={open} onOpenChange={onOpenChange} {...data}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="mt-1.5"><WorkSteps steps={work.steps} live={live} held={state === "waiting"} now={now} /></TraceCollapsibleContent>
        </TraceCollapsible>
      ) : <p {...data}>{line}</p>}
    </Trace>
  );
}
