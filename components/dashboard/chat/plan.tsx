"use client";

import { ChevronRightIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleSlashIcon, ListChecksIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Doc } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Markdown } from "./markdown";

type PlanStep = Doc<"tasks">["plan"][number];
const STATES = { pending: "Pending", active: "In progress", done: "Done", skipped: "Skipped" };

export function PlanChecklist({ steps, active, children, className }: {
  steps: PlanStep[]; active: boolean; children?: ReactNode; className?: string;
}) {
  const done = steps.filter((step) => step.status === "done").length;
  return <Collapsible defaultOpen={active} className={cn("my-2 min-w-0", className)} data-chat-plan>
    <CollapsibleTrigger className="group flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-8">
      <ListChecksIcon className="size-4 shrink-0" aria-hidden />
      <span className="font-medium">Plan</span>
      {steps.length > 0 && <span className="nums text-xs" role="status" aria-label={`${done} of ${steps.length} steps done`}>{done}/{steps.length}</span>}
      <ChevronRightIcon className="ml-auto size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none" aria-hidden />
    </CollapsibleTrigger>
    <CollapsibleContent>
      {steps.length > 0 && <ol className="grid gap-1.5 border-l py-1 pl-3" aria-label="Plan steps">
        {steps.map((step, index) => {
          const Icon = step.status === "done" ? CircleCheckIcon : step.status === "active" ? CircleDotIcon : step.status === "skipped" ? CircleSlashIcon : CircleDashedIcon;
          return <li key={index} data-plan-step={step.status} className={cn("flex items-start gap-2 text-sm", step.status === "active" ? "text-foreground" : "text-muted-foreground")}>
            <Icon className={cn("mt-0.5 size-4 shrink-0", step.status === "done" && "text-success", step.status === "active" && "text-primary")} aria-hidden />
            <span className="sr-only">{STATES[step.status]}: </span>
            <span className={cn("min-w-0 [overflow-wrap:anywhere]", step.status === "skipped" && "line-through")}>{step.title}</span>
          </li>;
        })}
      </ol>}
      {children}
    </CollapsibleContent>
  </Collapsible>;
}

export function NativePlan({ text, active }: { text: string; active: boolean }) {
  const steps = text.split("\n").flatMap((line): PlanStep[] => {
    const match = /^\s*[-*]\s+\[([ xX~\-])\]\s+(.+)$/.exec(line);
    if (!match) return [];
    return [{ title: match[2], status: match[1].toLowerCase() === "x" ? "done" : match[1] === "~" ? "active" : match[1] === "-" ? "skipped" : "pending" }];
  });
  return <PlanChecklist steps={steps} active={active}>{steps.length === 0 && <div className="py-1 text-sm"><Markdown text={text} /></div>}</PlanChecklist>;
}
