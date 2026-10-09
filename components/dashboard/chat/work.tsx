"use client";

import { CheckIcon, ChevronRightIcon, HourglassIcon, MinusIcon, XIcon } from "lucide-react";
import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import type { Work, WorkStep } from "@/convex/dashboard";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
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
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(id)) next.add(id); return next; });
  return (
    <ol className="space-y-1" data-work-steps>
      {steps.map((step) => {
        // A step open while the turn waits on the owner waits with it; one a stopped run left open is over, and did not finish either.
        const waits = live && held && step.status === "running";
        const running = live && !held && step.status === "running";
        const stopped = !live && step.status === "running";
        const failed = step.status === "error" || step.status === "declined";
        const time = running ? took(now - step.startedAt) : step.durationMs !== undefined ? took(step.durationMs) : "";
        const opened = open.has(step.id);
        return (
          <li key={step.id} className="min-w-0 text-sm text-muted-foreground"
            data-step={step.label} data-status={stopped ? "stopped" : waits ? "waiting" : step.status} data-kind={step.kind}>
            <button type="button" aria-expanded={opened} onClick={() => toggle(step.id)}
              className="group/step flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
              {running
                ? <Spinner />
                : waits
                  ? <HourglassIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Waiting for your approval" />
                  : failed
                    ? <XIcon className="size-3.5 shrink-0 text-destructive" aria-label={step.status === "declined" ? "Declined" : "Failed"} />
                    : stopped
                      ? <MinusIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Stopped" />
                      : <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden />}
              <span className={cn("min-w-0 truncate", running && "shimmer")}>{step.label}</span>
              {time && <span className="nums shrink-0 text-xs text-muted-foreground/70">{time}</span>}
              <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 opacity-0 transition group-hover/step:opacity-100 group-focus-visible/step:opacity-100 motion-reduce:transition-none",
                opened && "rotate-90 opacity-100")} />
            </button>
            {opened && <div className="mt-1 mb-2 ml-5.5"><StepDetail id={step.id} /></div>}
          </li>
        );
      })}
    </ol>
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
  const id = useId();
  const live = state === "working" || state === "waiting";
  const folds = useContext(Folds);
  const [own, setOwn] = useState<boolean | undefined>(undefined);
  const open = (folds ? folds.chosen.get(work.runId) : own) ?? live;
  const onToggle = () => folds ? folds.choose(work.runId, !open) : setOwn(!open);
  const label = workLabel(work, state, now);
  const steps = work.steps.length > 0;
  return (
    <div className="mb-2" data-work data-work-state={state} data-run={work.runId}>
      {steps ? (
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}
          className="-ml-1 flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {state === "working" && <Spinner />}
          <span className={cn("nums", state === "working" && "shimmer")}>{label}</span>
          <ChevronRightIcon className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
        </button>
      ) : (
        <p className="-ml-1 flex items-center gap-1.5 px-1 py-0.5 text-sm text-muted-foreground">
          <span className="nums">{label}</span>
        </p>
      )}
      {steps && open && <div id={id} className="mt-1.5 ml-1 border-l pl-3"><WorkSteps steps={work.steps} live={live} held={state === "waiting"} now={now} /></div>}
    </div>
  );
}
