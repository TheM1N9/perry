"use client";

import Link from "next/link";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, MessageSquareIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import type { JobView } from "@/convex/jobs";
import { ago, fullDate, plural, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionButton, EmptyState, List, ListSkeleton, Page, StatusBadge, TabCount, attempt, useTab, type Tone } from "../common";

const TABS = ["schedules", "plans", "goals", "watches"] as const;
type Tab = (typeof TABS)[number];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A plain-English reading of the common cron shapes; anything else is shown as written. */
export function describeSchedule(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const clock = (h: string) => new Date(2000, 0, 1, Number(h), Number(minute)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? clock(hour) : null;
  if (/^\*\/\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every ${minute.slice(2)} minutes`;
  if (/^\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every hour at :${minute.padStart(2, "0")}`;
  if (/^\d+$/.test(minute) && /^\*\/\d+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every ${hour.slice(2)} hours`;
  if (/^\d+$/.test(minute) && /^\d+(,\d+)+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Daily at ${hour.split(",").map(clock).join(", ")}`;
  if (!at || month !== "*") return null;
  if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${at}`;
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Weekdays at ${at}`;
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) return `Every ${DAYS[Number(dayOfWeek)]} at ${at}`;
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `Monthly on day ${dayOfMonth} at ${at}`;
  return null;
}

/**
 * What runs without you: schedules, the plans Perry keeps as it works, your
 * goals, and the pages it watches. The agent writes plans through a tool, so
 * this is the truth rather than a summary it made on request.
 */
export function Work() {
  const { dashboardKey } = useSession();
  const [tab, setTab] = useTab(TABS, "schedules");
  const work = useQuery(api.dashboard.getWork, { key: dashboardKey });
  const jobs = useQuery(api.jobs.listForDashboard, { key: dashboardKey });
  const active = work?.tasks.filter((task) => task.status === "running" || task.status === "blocked" || task.status === "queued").length;

  return (
    <Page title="Work" description="What Perry does without you in the chat. Ask for any of it in a chat, and it shows up here." wide>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line" className="mb-5 w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0 [&>button]:pb-2.5">
          <TabsTrigger value="schedules"><TabCount count={jobs?.jobs.filter((job) => !job.builtin).length}>Schedules</TabCount></TabsTrigger>
          <TabsTrigger value="plans"><TabCount count={active}>Plans</TabCount></TabsTrigger>
          <TabsTrigger value="goals"><TabCount count={work?.goals.filter((goal) => goal.status === "active").length}>Goals</TabCount></TabsTrigger>
          <TabsTrigger value="watches"><TabCount count={work?.monitors.filter((monitor) => monitor.active).length}>Watches</TabCount></TabsTrigger>
        </TabsList>
        <TabsContent value="schedules"><Schedules /></TabsContent>
        <TabsContent value="plans">{work ? <Plans tasks={work.tasks} /> : <ListSkeleton />}</TabsContent>
        <TabsContent value="goals">{work ? <Goals goals={work.goals} /> : <ListSkeleton />}</TabsContent>
        <TabsContent value="watches">{work ? <Watches monitors={work.monitors} /> : <ListSkeleton />}</TabsContent>
      </Tabs>
    </Page>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn("flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:gap-4", className)}>{children}</li>;
}

/** A small menu for a row's quieter actions, so the one you want most stays a button. */
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={label} />}>
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A confirmation for a row menu's destructive item. */
function useConfirm() {
  const [asking, setAsking] = useState<{ title: string; body: string; label: string; run: () => Promise<unknown>; success: string } | null>(null);
  const dialog = (
    <AlertDialog open={asking !== null} onOpenChange={(open) => { if (!open) setAsking(null); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{asking?.title}</AlertDialogTitle>
          <AlertDialogDescription>{asking?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => { if (asking) void attempt(asking.run, { success: asking.success }); setAsking(null); }}>{asking?.label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { ask: setAsking, dialog };
}

function Schedules() {
  const { dashboardKey } = useSession();
  const data = useQuery(api.jobs.listForDashboard, { key: dashboardKey });
  const setEnabled = useMutation(api.jobs.setEnabled);
  const remove = useMutation(api.jobs.removeFromDashboard);
  const runNow = useMutation(api.jobs.runNow);
  const setModel = useMutation(api.jobs.setModel);
  const models = useQuery(api.models.options, { key: dashboardKey })?.codex;
  const now = useNow();
  const { ask, dialog } = useConfirm();

  if (data === undefined) return <ListSkeleton />;
  const when = (ms: number) => fullDate(ms, data.timezone);
  const yours = data.jobs.filter((job) => !job.builtin);
  // The heartbeat, daily summary and memory upkeep keep Perry running; they fold away so your own jobs lead.
  const builtins = data.jobs.filter((job) => job.builtin);
  const builtinFailures = builtins.filter((job) => job.enabled && job.lastError).length;

  const row = (job: JobView) => {
    // A one-time job whose time has passed has run, or was paused past it; either way it is over.
    const over = job.runAt !== undefined && !job.enabled && job.runAt <= now;
    const readable = job.schedule ? describeSchedule(job.schedule) : null;
    const tone: Tone = job.lastError ? "danger" : job.enabled ? "success" : "neutral";
    // Unset runs on the account's default; a pick the account no longer offers falls back to it too.
    const fallback = (models ?? []).find((item) => item.isDefault) ?? models?.[0];
    const modelItems = [
      { value: "default", label: fallback ? `Default (${fallback.name})` : "Codex default" },
      ...(models ?? []).map((item) => ({ value: item.id, label: item.name })),
      ...(job.model && models && !models.some((item) => item.id === job.model) ? [{ value: job.model, label: `${job.model} (not offered, uses default)` }] : []),
    ];
    return (
      <Row key={job.id}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{job.name}</h3>
            <StatusBadge tone={tone}>{job.lastError ? "Failed" : job.enabled ? "Active" : over ? "Done" : "Paused"}</StatusBadge>
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {job.runAt !== undefined
              ? <span>Once, {when(job.runAt)}</span>
              : <span title={job.schedule}>{readable ?? <code className="font-mono text-xs">{job.schedule}</code>}</span>}
            {job.enabled && job.runAt === undefined && <span title={when(job.nextRunAt)}>Next {ago(job.nextRunAt, now)}</span>}
            <span title={job.lastRunAt ? when(job.lastRunAt) : undefined}>{job.lastRunAt ? `Last ran ${ago(job.lastRunAt, now)}` : "Hasn't run yet"}</span>
          </p>
          {job.lastError && <p className="mt-2 text-sm text-pretty text-destructive">{job.lastError}</p>}
          {!job.lastError && job.lastResult && job.lastResult.trim() !== "NOTHING" && (
            <p className="mt-2 line-clamp-3 text-sm text-pretty whitespace-pre-line text-foreground/80">{job.lastResult}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.chatId && <Button variant="ghost" size="sm" render={<Link href={`/chat/${job.chatId}`} />}><MessageSquareIcon />Results</Button>}
          <Select items={modelItems} value={job.model ?? "default"} disabled={!models?.length}
            onValueChange={(value) => void attempt(() => setModel({ key: dashboardKey, id: job.id, model: !value || value === "default" ? undefined : value }), { success: "Model changed. It applies from the next run." })}>
            <SelectTrigger size="sm" aria-label={`Model for ${job.name}`} className="max-w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{modelItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          <ActionButton variant="outline" size="sm" action={() => runNow({ key: dashboardKey, id: job.id })} success={`Running “${job.name}” now.`}>
            <PlayIcon />Run now
          </ActionButton>
          <RowMenu label={`More for ${job.name}`}>
            {!over && (
              <DropdownMenuItem onClick={() => void attempt(() => setEnabled({ key: dashboardKey, id: job.id, enabled: !job.enabled }), { success: job.enabled ? "Paused." : "Resumed." })}>
                {job.enabled ? <PauseIcon /> : <PlayIcon />}{job.enabled ? "Pause" : "Resume"}
              </DropdownMenuItem>
            )}
            {!job.builtin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => ask({
                  title: `Delete “${job.name}”?`, body: "It won't run again. To bring it back, ask Perry to set it up again.", label: "Delete",
                  run: () => remove({ key: dashboardKey, id: job.id }), success: "Schedule deleted.",
                })}><Trash2Icon />Delete</DropdownMenuItem>
              </>
            )}
          </RowMenu>
        </div>
      </Row>
    );
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Prompts Perry runs on a schedule, like a morning briefing, or once, like a reminder. Times are in <span className="font-medium text-foreground">{data.timezone}</span>.
      </p>
      {yours.length === 0
        ? <EmptyState title="Nothing scheduled yet">Try asking in a chat: &ldquo;Every weekday at 8am, send me a summary of my calendar.&rdquo;</EmptyState>
        : <List label="Your schedules">{yours.map(row)}</List>}
      {builtins.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-4 transition-transform group-data-panel-open:rotate-90" />
            Built in <span className="nums font-normal">({builtins.length})</span>
            <span className="font-normal">· Heartbeat, daily summary and memory upkeep</span>
            {builtinFailures > 0 && <StatusBadge tone="danger">{builtinFailures} failed</StatusBadge>}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3"><List label="Built-in schedules">{builtins.map(row)}</List></CollapsibleContent>
        </Collapsible>
      )}
      {dialog}
    </div>
  );
}

const TASK: Record<Doc<"tasks">["status"], { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Working", tone: "info" },
  blocked: { label: "Needs you", tone: "warning" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function Plans({ tasks }: { tasks: Doc<"tasks">[] }) {
  const { dashboardKey } = useSession();
  const cancelTask = useMutation(api.dashboard.cancelTask);
  const now = useNow();
  if (!tasks.length) return <EmptyState title="No plans yet">Ask Perry for something that takes a few steps, and its plan shows up here as it works.</EmptyState>;
  // What needs you, then what is working, then the rest, newest first within each.
  const rank = { blocked: 0, running: 1, queued: 2, failed: 3, done: 4, cancelled: 5 } as const;
  const sorted = [...tasks].sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt);
  return (
    <List label="Plans">
      {sorted.map((task) => {
        const done = task.plan.filter((step) => step.status === "done").length;
        const live = task.status === "running" || task.status === "blocked";
        return (
          <Row key={task._id}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{task.title}</h3>
                <StatusBadge tone={TASK[task.status].tone} pulse={task.status === "running"}>{TASK[task.status].label}</StatusBadge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Updated {ago(task.updatedAt, now)}{task.plan.length > 0 && <span className="nums"> · {done} of {task.plan.length} steps</span>}
              </p>
              {task.plan.length > 0 && <Progress value={(done / task.plan.length) * 100} aria-label={`${task.title}: ${done} of ${task.plan.length} steps`} className="mt-3 max-w-md" />}
              {task.question && (
                <div className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-pretty">
                  <span className="font-medium text-warning">Needs you: </span>{task.question}
                </div>
              )}
              {task.plan.length > 0 && (
                <Collapsible defaultOpen={live} className="mt-3">
                  <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                    <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />Steps
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ol className="mt-2 space-y-1.5" aria-label="Plan">
                      {task.plan.map((step, index) => (
                        <li key={index} className="flex items-start gap-2.5 text-sm">
                          <span aria-hidden className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                            step.status === "done" && "border-primary bg-primary text-primary-foreground",
                            step.status === "active" && "border-primary",
                            step.status === "skipped" && "border-dashed")}>
                            {step.status === "done" && <CheckIcon className="size-2.5" strokeWidth={3} />}
                            {step.status === "active" && <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />}
                          </span>
                          <span className={cn(step.status === "skipped" && "text-muted-foreground line-through", step.status === "active" && "font-medium")}>
                            {step.title}<span className="sr-only"> ({step.status})</span>
                            {step.note && <span className="block text-muted-foreground">{step.note}</span>}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </CollapsibleContent>
                </Collapsible>
              )}
              {task.result && <p className="mt-3 text-sm text-pretty whitespace-pre-line text-foreground/80">{task.result}</p>}
              {task.error && <p className="mt-3 text-sm text-pretty text-destructive">{task.error}</p>}
            </div>
            {live && (
              <div className="shrink-0">
                <ActionButton variant="ghost" size="sm" className="text-destructive hover:text-destructive" action={() => cancelTask({ key: dashboardKey, taskId: task._id })} success="Plan cancelled."
                  confirm={{ title: "Cancel this plan?", body: `Perry stops working on “${task.title}”. What it already did stays done.`, label: "Cancel plan" }}>
                  Cancel
                </ActionButton>
              </div>
            )}
          </Row>
        );
      })}
    </List>
  );
}

function Goals({ goals }: { goals: Doc<"goals">[] }) {
  if (!goals.length) return <EmptyState title="No goals yet">Tell Perry about something you&apos;re working toward, and it tracks the milestones.</EmptyState>;
  const tone: Record<Doc<"goals">["status"], Tone> = { active: "info", paused: "neutral", done: "success" };
  return (
    <List label="Goals">
      {goals.map((goal) => {
        const reached = goal.milestones.filter((milestone) => milestone.done).length;
        return (
          <Row key={goal._id}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{goal.title}</h3>
                <StatusBadge tone={tone[goal.status]}>{goal.status[0].toUpperCase() + goal.status.slice(1)}</StatusBadge>
              </div>
              {goal.description && <p className="mt-1 text-sm text-pretty text-muted-foreground">{goal.description}</p>}
              {goal.milestones.length > 0 && (
                <>
                  <div className="mt-3 flex max-w-md items-center gap-3">
                    <Progress value={(reached / goal.milestones.length) * 100} aria-label={`${goal.title}: ${reached} of ${goal.milestones.length} milestones`} className="flex-1" />
                    <span className="nums text-xs text-muted-foreground">{reached}/{goal.milestones.length}</span>
                  </div>
                  <ul className="mt-3 space-y-1.5" aria-label="Milestones">
                    {goal.milestones.map((milestone, index) => (
                      <li key={index} className="flex items-center gap-2.5 text-sm">
                        <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center rounded-full border", milestone.done && "border-primary bg-primary text-primary-foreground")}>
                          {milestone.done && <CheckIcon className="size-2.5" strokeWidth={3} />}
                        </span>
                        <span className={cn(milestone.done && "text-muted-foreground")}>{milestone.title}<span className="sr-only"> ({milestone.done ? "done" : "not done"})</span></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Row>
        );
      })}
    </List>
  );
}

const CONDITION: Record<Doc<"monitors">["condition"], string> = { change: "When anything changes", contains: "When it contains", price_below: "When the price drops below" };
const every = (minutes: number) => minutes >= 60 && minutes % 60 === 0 ? `Every ${plural(minutes / 60, "hour")}` : `Every ${plural(minutes, "minute")}`;

function Watches({ monitors }: { monitors: Doc<"monitors">[] }) {
  const { dashboardKey } = useSession();
  const toggleMonitor = useMutation(api.dashboard.toggleMonitor);
  const deleteMonitor = useMutation(api.dashboard.deleteMonitor);
  const checkNow = useAction(api.dashboard.checkMonitorsNow);
  const now = useNow();
  const { ask, dialog } = useConfirm();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Pages Perry checks on an interval. A new watch records a baseline first and stays quiet until its condition is met.</p>
        {monitors.length > 0 && (
          <ActionButton variant="outline" size="sm" action={() => checkNow({ key: dashboardKey })} success="Checked every watch that was due.">
            <RefreshCwIcon />Check now
          </ActionButton>
        )}
      </div>
      {monitors.length === 0
        ? <EmptyState title="Nothing watched">Ask Perry to watch a page, for example: &ldquo;Tell me when this is back in stock.&rdquo;</EmptyState>
        : (
          <List label="Watches">
            {monitors.map((monitor) => (
              <Row key={monitor._id}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{monitor.title}</h3>
                    <StatusBadge tone={monitor.active ? "success" : "neutral"}>{monitor.active ? "Watching" : "Paused"}</StatusBadge>
                    {monitor.failures > 0 && <StatusBadge tone="warning">{plural(monitor.failures, "failed check")}</StatusBadge>}
                  </div>
                  <a href={monitor.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
                    <span className="truncate">{monitor.url}</span><ExternalLinkIcon className="size-3 shrink-0" />
                  </a>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <span>{CONDITION[monitor.condition]}{monitor.value ? ` “${monitor.value}”` : ""}</span>
                    <span>{every(monitor.intervalMinutes)}</span>
                    {monitor.lastCheckedAt && <span>Checked {ago(monitor.lastCheckedAt, now)}</span>}
                  </p>
                  {monitor.lastObservation && <p className="mt-2 text-sm text-pretty text-foreground/80">{monitor.lastObservation}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <ActionButton variant="outline" size="sm" action={() => toggleMonitor({ key: dashboardKey, monitorId: monitor._id })} success={monitor.active ? "Watch paused." : "Watch resumed."}>
                    {monitor.active ? <PauseIcon /> : <PlayIcon />}{monitor.active ? "Pause" : "Resume"}
                  </ActionButton>
                  <RowMenu label={`More for ${monitor.title}`}>
                    <DropdownMenuItem variant="destructive" onClick={() => ask({
                      title: `Stop watching “${monitor.title}”?`, body: "The watch and its history are deleted.", label: "Delete",
                      run: () => deleteMonitor({ key: dashboardKey, monitorId: monitor._id }), success: "Watch deleted.",
                    })}><Trash2Icon />Delete</DropdownMenuItem>
                  </RowMenu>
                </div>
              </Row>
            ))}
          </List>
        )}
      {dialog}
    </div>
  );
}
