"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRightIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleSlashIcon, FileIcon, ListChecksIcon } from "lucide-react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkspaceWork } from "@/convex/workspace";
import { ago, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { filesId, ScopePicker, type Scope } from "./files";
import { filePrefs, FILES, readCapped, writeCapped } from "./store";

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "bg-muted-foreground/40" },
  running: { label: "Working", tone: "bg-primary motion-safe:animate-pulse" },
  waiting: { label: "Waiting on you", tone: "bg-warning" },
  done: { label: "Done", tone: "bg-success" },
  failed: { label: "Failed", tone: "bg-destructive" },
  cancelled: { label: "Cancelled", tone: "bg-muted-foreground/40" },
};

/**
 * The Work surface: the tasks and replies of this chat (or its project) as they go, from the
 * workspace's own read of them (convex/workspace.ts, work): what each is on, its plan, what it made.
 * Finished ones older than a day show only when asked for.
 */
export function WorkSurface({ conversationId, project, scope, onScope, onOpenFiles }: {
  conversationId: Id<"conversations">; project?: { id: Id<"projects">; name: string }; scope: Scope; onScope: (scope: Scope) => void;
  /** Opens Files on its preview of a file; unset while Files is off. */
  onOpenFiles?: () => void;
}) {
  const { dashboardKey: key } = useSession();
  const actual = project ? scope : "chat";
  const [history, setHistory] = useState(false);
  const work = useQuery(api.workspace.work, { key, conversationId, scope: actual, history });
  const now = useNow(30_000);
  const openFile = onOpenFiles && ((id: string) => {
    const where = filesId(actual, actual === "project" ? project?.id ?? conversationId : conversationId);
    writeCapped(FILES, where, { ...readCapped(FILES, where, filePrefs), selected: id });
    onOpenFiles();
  });
  return <div className="flex min-h-0 flex-1 flex-col" data-surface="work">
    <ScopePicker project={project} scope={actual} onScope={onScope} />
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-busy={!work}>
      {!work ? <p role="status" className="px-1 text-sm text-muted-foreground">Loading work…</p>
        : !work.length ? <div className="flex flex-col items-center px-4 py-12 text-center" data-work-empty>
          <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><ListChecksIcon className="size-5" /></span>
          <p className="mt-3 text-sm font-medium">Nothing here yet</p>
          <p className="mt-1 max-w-60 text-xs text-muted-foreground">Replies Perry works on, and tasks started from this chat, show up here as they go.</p>
        </div>
        : <ul className="space-y-1.5">{work.map((item) => <WorkItem key={item.id} item={item} now={now} onOpenFile={openFile} />)}</ul>}
      {work && <Button size="sm" variant="ghost" className="mt-3 text-muted-foreground" aria-pressed={history} onClick={() => setHistory(!history)}>{history ? "Show recent only" : "Show older work"}</Button>}
    </div>
  </div>;
}

function WorkItem({ item, now, onOpenFile }: { item: WorkspaceWork; now: number; onOpenFile?: (id: string) => void }) {
  const status = STATUS[item.status] ?? { label: item.status, tone: "bg-muted-foreground/40" };
  const detail = item.status === "failed" ? item.error : item.currentStep;
  const more = item.plan.length > 0 || item.outputs.length > 0;
  const href = item.taskId ? `/work#task-${item.taskId}` : item.runId ? `/chat/${item.conversationId}?run=${item.runId}` : null;
  const head = <>
    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", status.tone)} aria-hidden />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm">{item.title}</span>
      <span className="block truncate text-xs text-muted-foreground">{[status.label, detail, ago(item.updatedAt, now)].filter(Boolean).join(" · ")}</span>
    </span>
  </>;
  return <li className="rounded-lg ring-1 ring-foreground/10" data-work-item={item.status}>
    {more ? <Collapsible defaultOpen={item.status === "running" || item.status === "waiting"}>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50">
        {head}<ChevronRightIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2.5">
        {item.plan.length > 0 && <ol className="mt-1 space-y-1 border-l pl-3" aria-label="Plan">{item.plan.map((step, index) => {
          const Icon = step.status === "done" ? CircleCheckIcon : step.status === "active" ? CircleDotIcon : step.status === "skipped" ? CircleSlashIcon : CircleDashedIcon;
          return <li key={index} className={cn("flex items-start gap-2 text-xs", step.status === "active" ? "text-foreground" : "text-muted-foreground", step.status === "skipped" && "line-through")}>
            <Icon className={cn("mt-px size-3.5 shrink-0", step.status === "done" && "text-success", step.status === "active" && "text-primary")} aria-hidden /><span className="min-w-0">{step.title}</span>
          </li>;
        })}</ol>}
        {item.outputs.length > 0 && <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Made">
          {item.outputs.map((file) => onOpenFile
            ? <Button key={file.id} size="xs" variant="outline" className="max-w-full font-normal" onClick={() => onOpenFile(file.id)}><FileIcon /><span className="truncate">{file.name}</span></Button>
            : <span key={file.id} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"><FileIcon className="size-3 shrink-0" /><span className="truncate">{file.name}</span></span>)}
        </div>}
        {href && <Link href={href} className="link mt-2.5 inline-block text-xs">{item.taskId ? "Open the task" : "Show in the chat"}</Link>}
      </CollapsibleContent>
    </Collapsible> : href ? <Link href={href} className="flex items-start gap-2.5 rounded-lg px-3 py-2 hover:bg-muted/60">{head}</Link>
      : <div className="flex items-start gap-2.5 px-3 py-2">{head}</div>}
  </li>;
}
