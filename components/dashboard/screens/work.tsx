"use client";

import Link from "next/link";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, MessageSquareIcon, MoreHorizontalIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, RefreshCwIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import type { JobView } from "@/convex/jobs";
import { enginesOf, modelKey, modelsOf, parseModelKey } from "@/convex/lib/commands";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { ago, fullDate, plural, useNow } from "@/lib/format";
import { describeSchedule } from "@/lib/when";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionButton, EmptyState, List, ListSkeleton, Page, StatusBadge, TabCount, TextTip, attempt, useTab, type Tone } from "../common";
import { GoalDialog, ScheduleDialog, TaskDialog, WatchDialog, type Editing } from "./work-forms";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

const TABS = ["schedules", "plans", "goals", "watches"] as const;
type Tab = (typeof TABS)[number];

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
    <Page title="Work" wide>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line" className="mb-5 w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0 [&>button]:pb-2.5">
          <TabsTrigger value="schedules"><TabCount count={jobs?.jobs.filter((job) => !job.builtin).length}>Schedules</TabCount></TabsTrigger>
          <TabsTrigger value="plans"><TabCount count={active}>Plans</TabCount></TabsTrigger>
          <TabsTrigger value="goals"><TabCount count={work?.goals.filter((goal) => goal.status === "active").length}>Goals</TabCount></TabsTrigger>
          <TabsTrigger value="watches"><TabCount count={work?.monitors.filter((monitor) => monitor.active).length}>Watches</TabCount></TabsTrigger>
        </TabsList>
        <TabsContent value="schedules"><Schedules /></TabsContent>
        <TabsContent value="plans">{work ? <Plans tasks={work.tasks} goals={work.goals} /> : <ListSkeleton />}</TabsContent>
        <TabsContent value="goals">{work ? <Goals goals={work.goals} /> : <ListSkeleton />}</TabsContent>
        <TabsContent value="watches">{work ? <Watches monitors={work.monitors} /> : <ListSkeleton />}</TabsContent>
      </Tabs>
    </Page>
  );
}

/** A tab's New button, and a line beside it when there is something it must say. */
function Intro({ children, action }: { children?: ReactNode; action: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-2xl text-sm text-muted-foreground">{children}</p>
      <div className="flex items-center gap-2">{action}</div>
    </div>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn("flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:gap-4", className)}>{children}</li>;
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
  const models = useQuery(api.models.options, { key: dashboardKey })?.models;
  const several = enginesOf(models ?? []).length > 1;
  const now = useNow();
  const { ask, dialog } = useConfirm();
  const [editing, setEditing] = useState<Editing<JobView>>(null);

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
    const state: { tone: Tone; label: string } | null = job.lastError ? { tone: "danger", label: "Failed" } : job.enabled ? null : { tone: "neutral", label: over ? "Done" : "Paused" };
    // Unset runs on the account's default; a pick the account no longer offers falls back to it too.
    // Each model is "<engine>/<id>", named with its engine once there is more than one.
    const fallback = modelsOf(models ?? [], "codex").find((item) => item.isDefault) ?? models?.[0];
    const picked = job.model ? modelKey(job.engine, job.model) : undefined;
    const modelItems = [
      { value: "default", label: fallback ? `Default (${fallback.name})` : "Default model" },
      ...(models ?? []).map((item) => ({ value: modelKey(item.engine ?? "codex", item.id), label: several ? `${item.name} · ${ENGINE_LABELS[item.engine ?? "codex"]}` : item.name })),
      ...(picked && models && !models.some((item) => modelKey(item.engine ?? "codex", item.id) === picked) ? [{ value: picked, label: `${job.model} (not offered, uses default)` }] : []),
    ];
    return (
      <Row key={job.id}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-medium">{job.name}</h3>
            {state && <StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {job.trigger
              ? <span className="inline-flex items-center gap-1"><ZapIcon className="size-3.5" aria-hidden />{job.trigger.label}</span>
              : job.runAt !== undefined
                ? <span>Once, {when(job.runAt)}</span>
                : readable
                  ? <TextTip tip={<code className="font-mono">{job.schedule}</code>}>{readable}</TextTip>
                  : <code className="font-mono text-xs">{job.schedule}</code>}
            {job.enabled && job.runAt === undefined && !job.trigger && <TextTip tip={when(job.nextRunAt)} spoken={when(job.nextRunAt)}>Next {ago(job.nextRunAt, now)}</TextTip>}
            {job.lastRunAt
              ? <TextTip tip={when(job.lastRunAt)} spoken={when(job.lastRunAt)}>Last ran {ago(job.lastRunAt, now)}</TextTip>
              : <span>Hasn&apos;t run yet</span>}
          </p>
          {job.lastError && <p className="mt-2 text-sm text-pretty text-destructive">{job.lastError}</p>}
          {!job.lastError && job.lastResult && job.lastResult.trim() !== "NOTHING" && (
            <p className="mt-2 line-clamp-3 text-sm text-pretty whitespace-pre-line text-foreground/80">{job.lastResult}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.chatId && <Button variant="ghost" size="sm" render={<Link href={`/chat/${job.chatId}`} />}><MessageSquareIcon />Results</Button>}
          <Select items={modelItems} value={picked ?? "default"} disabled={!models?.length}
            onValueChange={(value) => void attempt(() => setModel({ key: dashboardKey, id: job.id, ...(!value || value === "default" ? {} : { model: parseModelKey(value).id, engine: parseModelKey(value).engine }) }), { success: "Model changed. It applies from the next run." })}>
            <SelectTrigger size="sm" aria-label={`Model for ${job.name}`} className="max-w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{modelItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          <ActionButton variant="outline" size="sm" action={() => runNow({ key: dashboardKey, id: job.id })} success={`Running “${job.name}” now.`}>
            <PlayIcon />Run now
          </ActionButton>
          <RowMenu label={`More for ${job.name}`}>
            <DropdownMenuItem onClick={() => setEditing({ item: job })}><PencilIcon />Change</DropdownMenuItem>
            {!over && (
              <DropdownMenuItem onClick={() => void attempt(() => setEnabled({ key: dashboardKey, id: job.id, enabled: !job.enabled }), { success: job.enabled ? "Paused." : "Resumed." })}>
                {job.enabled ? <PauseIcon /> : <PlayIcon />}{job.enabled ? "Pause" : "Resume"}
              </DropdownMenuItem>
            )}
            {!job.builtin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => ask({
                  title: `Delete “${job.name}”?`, body: "It won't run again.", label: "Delete",
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
      <Intro action={<Button size="sm" onClick={() => setEditing({})}><PlusIcon />New schedule</Button>}>
        Times are in <span className="font-medium text-foreground">{data.timezone}</span>.
      </Intro>
      <Wake timezone={data.timezone} />
      {yours.length === 0
        ? <EmptyState title="Nothing scheduled yet" />
        : <List label="Your schedules">{yours.map(row)}</List>}
      {builtins.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-2 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronRightIcon className="size-4 transition-transform group-data-panel-open:rotate-90" />
            Built in <span className="nums font-normal">({builtins.length})</span>
            <span className="font-normal">· Heartbeat, daily summary and memory upkeep</span>
            {builtinFailures > 0 && <StatusBadge tone="danger">{builtinFailures} failed</StatusBadge>}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3"><List label="Built-in schedules">{builtins.map(row)}</List></CollapsibleContent>
        </Collapsible>
      )}
      {dialog}
      <ScheduleDialog editing={editing} timezone={data.timezone} onClose={() => setEditing(null)} />
    </div>
  );
}

/** Waking the computer for what is due (convex/wake.ts, server/wake.ts): on or off, and the timer set, or why none is. */
function Wake({ timezone }: { timezone: string }) {
  const { dashboardKey } = useSession();
  const wake = useQuery(api.wake.get, { key: dashboardKey });
  const set = useMutation(api.wake.set);
  const now = useNow();
  if (!wake) return null;
  const status = !wake.enabled ? "Off: what is due while it sleeps runs when it wakes."
    : wake.error ? wake.error
      : wake.at ? `Next: ${fullDate(wake.at - 60_000, timezone)}, a minute before ${wake.what ?? "the next job"} (${ago(wake.at, now)}).`
        : "Nothing is due, so no wake is set.";
  return (
    <div className="flex items-start gap-3">
      <Switch id="wake-computer" checked={wake.enabled} className="mt-0.5"
        onCheckedChange={(enabled) => void attempt(() => set({ key: dashboardKey, enabled }), { success: enabled ? "Perry wakes this computer for what is due." : "Perry no longer wakes this computer." })} />
      <div className="min-w-0 text-sm">
        <label htmlFor="wake-computer" className="font-medium">Wake this computer for them</label>
        <p className={cn("mt-0.5 text-pretty", wake.enabled && wake.error ? "text-warning" : "text-muted-foreground")} aria-live="polite">
          {status}{wake.enabled && wake.awake ? " Keeping it awake now, while Perry works." : ""}
        </p>
      </div>
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

function Plans({ tasks, goals }: { tasks: Doc<"tasks">[]; goals: Doc<"goals">[] }) {
  const { dashboardKey } = useSession();
  const cancelTask = useMutation(api.dashboard.cancelTask);
  const answerTask = useMutation(api.tasks.answerFromDashboard);
  const now = useNow();
  const [adding, setAdding] = useState<Editing<never>>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // What needs you, then what is working, then the line in order, then the rest newest first.
  const rank = { blocked: 0, running: 1, queued: 2, failed: 3, done: 4, cancelled: 5 } as const;
  const sorted = [...tasks].sort((a, b) => rank[a.status] - rank[b.status] || (a.status === "queued" ? a.createdAt - b.createdAt : b.updatedAt - a.updatedAt));
  // Queued tasks run oldest first, one at a time.
  const line = tasks.filter((task) => task.status === "queued").sort((a, b) => a.createdAt - b.createdAt).map((task) => task._id);
  const intro = (
    <Intro action={<Button size="sm" onClick={() => setAdding({})}><PlusIcon />New task</Button>} />
  );
  if (!tasks.length) return (
    <div className="space-y-4">
      {intro}
      <EmptyState title="No plans yet" />
      <TaskDialog open={adding !== null} goals={goals} onClose={() => setAdding(null)} />
    </div>
  );
  return (
    <div className="space-y-4">
      {intro}
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
                {task.status === "queued" && line.includes(task._id) && (
                  <p className="mt-1 text-sm text-muted-foreground">{line.indexOf(task._id) === 0 ? "Next in line" : `${line.indexOf(task._id) + 1} in line`}</p>
                )}
                {task.question && (
                  <div className="mt-3 text-sm text-pretty">
                    <p><span className="font-medium text-warning">Needs you: </span>{task.question}</p>
                    {task.status === "blocked" && task.conversationId && (
                      <form className="mt-2 max-w-md" onSubmit={(event) => {
                        event.preventDefault();
                        const answer = answers[task._id]?.trim();
                        if (answer) void attempt(() => answerTask({ key: dashboardKey, id: task._id, answer }), { success: "Answered. It carries on." }).then((ok) => { if (ok) setAnswers((all) => ({ ...all, [task._id]: "" })); });
                      }}>
                        <InputGroup>
                          <InputGroupInput aria-label={`Answer for ${task.title}`} placeholder="Your answer" value={answers[task._id] ?? ""}
                            onChange={(event) => setAnswers((all) => ({ ...all, [task._id]: event.target.value }))} />
                          {answers[task._id]?.trim() && (
                            <InputGroupAddon align="inline-end">
                              <InputGroupButton type="submit" size="xs" className="text-primary hover:text-primary">Answer</InputGroupButton>
                            </InputGroupAddon>
                          )}
                        </InputGroup>
                      </form>
                    )}
                  </div>
                )}
                {task.plan.length > 0 && (
                  <Collapsible defaultOpen={live} className="mt-3">
                    <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
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
              {(live || task.conversationId) && (
                <div className="flex shrink-0 items-center gap-1">
                  {task.conversationId && <Button variant="ghost" size="sm" render={<Link href={`/chat/${task.conversationId}`} />}><MessageSquareIcon />Its chat</Button>}
                  {live && <ActionButton variant="ghost" size="sm" className="text-destructive hover:text-destructive" action={() => cancelTask({ key: dashboardKey, taskId: task._id })} success="Plan cancelled."
                    confirm={{ title: "Cancel this plan?", body: `Perry stops working on “${task.title}”. What it already did stays done.`, label: "Cancel plan" }}>
                    Cancel
                  </ActionButton>}
                </div>
              )}
            </Row>
          );
        })}
      </List>
      <TaskDialog open={adding !== null} goals={goals} onClose={() => setAdding(null)} />
    </div>
  );
}

function Goals({ goals }: { goals: Doc<"goals">[] }) {
  const [editing, setEditing] = useState<Editing<Doc<"goals">>>(null);
  return (
    <div className="space-y-4">
      <Intro action={<Button size="sm" onClick={() => setEditing({})}><PlusIcon />New goal</Button>}>
        Perry keeps them in mind in every chat.
      </Intro>
      {!goals.length ? <EmptyState title="No goals yet" /> : (
        <List label="Goals">
          {goals.map((goal) => {
            const reached = goal.milestones.filter((milestone) => milestone.done).length;
            return (
              <Row key={goal._id}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="font-medium">{goal.title}</h3>
                    {goal.status !== "active" && <StatusBadge>{goal.status === "done" ? "Done" : "Paused"}</StatusBadge>}
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
                <div className="shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ item: goal })}><PencilIcon />Change</Button>
                </div>
              </Row>
            );
          })}
        </List>
      )}
      <GoalDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
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
  const [editing, setEditing] = useState<Editing<Doc<"monitors">>>(null);

  return (
    <div className="space-y-4">
      <Intro action={<>
        {monitors.length > 0 && (
          <ActionButton variant="outline" size="sm" action={() => checkNow({ key: dashboardKey })} success="Checked every watch that was due.">
            <RefreshCwIcon />Check now
          </ActionButton>
        )}
        <Button size="sm" onClick={() => setEditing({})}><PlusIcon />New watch</Button>
      </>} />
      {monitors.length === 0
        ? <EmptyState title="Nothing watched" />
        : (
          <List label="Watches">
            {monitors.map((monitor) => (
              <Row key={monitor._id}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="font-medium">{monitor.title}</h3>
                    {!monitor.active && <StatusBadge>Paused</StatusBadge>}
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
                    <DropdownMenuItem onClick={() => setEditing({ item: monitor })}><PencilIcon />Change</DropdownMenuItem>
                    <DropdownMenuSeparator />
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
      <WatchDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
