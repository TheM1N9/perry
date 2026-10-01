"use client";

import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { Work, WorkStep } from "@/convex/dashboard";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

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
 */
export function WorkSteps({ steps, live = false, now = 0 }: { steps: WorkStep[]; live?: boolean; now?: number }) {
  return (
    <ol className="space-y-1" data-work-steps>
      {steps.map((step, index) => {
        // A step a stopped run left open is over, not running.
        const running = live && step.status === "running";
        const failed = step.status === "error" || step.status === "declined";
        const time = running ? took(now - step.startedAt) : step.durationMs !== undefined ? took(step.durationMs) : "";
        return (
          <li key={`${step.startedAt}-${index}`} className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
            data-step={step.label} data-status={running ? "running" : step.status}>
            {running
              ? <Spinner />
              : failed
                ? <XIcon className="size-3.5 shrink-0 text-destructive" aria-label={step.status === "declined" ? "Declined" : "Failed"} />
                : <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden />}
            <span className={cn("min-w-0 truncate", running && "shimmer")}>{step.label}</span>
            {time && <span className="nums shrink-0 text-xs text-muted-foreground/70">{time}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** A finished run, folded into "Worked for 46s · 3 steps" above its reply, its steps a click away. */
export function WorkSummary({ work }: { work: Work }) {
  const [open, setOpen] = useState(false);
  const end = work.finishedAt ?? Math.max(...work.steps.map((step) => step.startedAt + (step.durationMs ?? 0)));
  return (
    <div className="mb-2" data-work>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
        className="-ml-1 flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span className="nums">Worked for {took(end - work.startedAt)} · {plural(work.steps.length, "step")}</span>
        <ChevronRightIcon className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
      </button>
      {open && <div className="mt-1.5 ml-1 border-l pl-3"><WorkSteps steps={work.steps} /></div>}
    </div>
  );
}
