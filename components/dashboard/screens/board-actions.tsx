"use client";

import Link from "next/link";
import { CheckIcon, MoreHorizontalIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import type { BoardThread } from "@/convex/board";
import type { InboxItem } from "@/convex/dashboard";
import type { JobView } from "@/convex/jobs";
import { enginesOf, modelKey, parseModelKey, type ModelOption } from "@/convex/lib/commands";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { ago, fullDate, useNow } from "@/lib/format";
import { describeSchedule } from "@/lib/when";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ActionButton, attempt } from "../common";
import { ApprovalCard } from "../approval-card";
import { GoalDialog, ScheduleDialog, TaskDialog, WatchDialog, type Editing } from "./work-forms";

/*
 * Everything the Work page and Needs you could do, from the Board: making a task, schedule, goal or watch from its
 * channel's header; changing, pausing, running or deleting one from its thread; answering a task's question,
 * reviewing an approval and dismissing an update where they show. The forms are Work's own (work-forms.tsx).
 */

const MENU = "w-52 text-[13px]";

/** A thread's raw id: "job:abc" is "abc". */
const rawId = (thread: string) => thread.slice(thread.indexOf(":") + 1);

/** What Needs you lists that the Board shows on a thread: a failure, a schedule's news, a watch that fired. */
export type Notice = Exclude<InboxItem, { kind: "question" }>;
const NOTICE_THREAD: Partial<Record<InboxItem["kind"], string>> = { "task-failed": "task", "job-error": "job", "job-result": "job", watch: "watch" };
/** The thread a notice is about, if the Board has one for it. */
export const noticeThread = (item: InboxItem) => NOTICE_THREAD[item.kind] ? `${NOTICE_THREAD[item.kind]}:${item.id}` : undefined;

/** A question first, then a destructive action, as Work asked it. */
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

// --- A channel's header: make one, and the channel's settings ----------------------------------------------------

const NEW: Record<string, string> = { tasks: "new task", jobs: "new schedule", goals: "new goal", watches: "new watch" };

/** The header's actions for the open channel or tab. `compact`: the icon alone, for a narrow header. */
export function ChannelActions({ channel, needsYou, notices, compact }: { channel?: string; needsYou: boolean; notices: Notice[]; compact: boolean }) {
  const { dashboardKey } = useSession();
  const [making, setMaking] = useState<string | null>(null);
  const work = useQuery(api.dashboard.getWork, channel === "tasks" ? { key: dashboardKey } : "skip");
  const jobs = useQuery(api.jobs.listForDashboard, channel === "jobs" ? { key: dashboardKey } : "skip");
  const wake = useQuery(api.wake.get, channel === "jobs" ? { key: dashboardKey } : "skip");
  const setWake = useMutation(api.wake.set);
  const checkNow = useAction(api.dashboard.checkMonitorsNow);
  const dismiss = useMutation(api.dashboard.dismissInbox);
  const now = useNow();
  const label = channel ? NEW[channel] : undefined;

  const menu: ReactNode[] = [];
  if (channel === "jobs" && wake) {
    const status = !wake.enabled ? "What is due while it sleeps runs when it wakes." : wake.error ? wake.error
      : wake.at ? `Next wake ${ago(wake.at - 60_000, now)}, before ${wake.what ?? "the next job"}.` : "Nothing is due, so no wake is set.";
    menu.push(
      <DropdownMenuGroup key="wake">
        <DropdownMenuCheckboxItem checked={wake.enabled} data-wake
          onCheckedChange={(enabled) => void attempt(() => setWake({ key: dashboardKey, enabled: Boolean(enabled) }), { success: enabled ? "Perry wakes this computer for what is due." : "Perry no longer wakes this computer." })}>
          Wake this computer for them
        </DropdownMenuCheckboxItem>
        <DropdownMenuLabel className={cn("text-[12px] font-normal text-pretty", wake.enabled && wake.error ? "text-warning" : "text-muted-foreground")}>{status}</DropdownMenuLabel>
        {jobs && <DropdownMenuLabel className="text-[12px] font-normal text-muted-foreground">Times are in {jobs.timezone}</DropdownMenuLabel>}
      </DropdownMenuGroup>,
    );
  }
  if (channel === "watches") {
    menu.push(<DropdownMenuItem key="check" onClick={() => void attempt(() => checkNow({ key: dashboardKey }), { success: "Checked every watch that was due." })}><RefreshCwIcon />Check due watches now</DropdownMenuItem>);
  }
  if (needsYou && notices.length > 0) {
    menu.push(<DropdownMenuItem key="dismiss" onClick={() => void attempt(() => dismiss({ key: dashboardKey, items: notices.map(({ kind, id }) => ({ kind, id })) }), { success: "Cleared." })}><CheckIcon />Dismiss {notices.length === 1 ? "the update" : `all ${notices.length} updates`}</DropdownMenuItem>);
  }

  return (
    <>
      {menu.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Channel options" />}><MoreHorizontalIcon /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={cn(MENU, "w-64")}>{menu}</DropdownMenuContent>
        </DropdownMenu>
      )}
      {label && (
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[12px]" aria-label={label} onClick={() => setMaking(channel!)} data-new={channel}>
          <PlusIcon />{!compact && label}
        </Button>
      )}
      {making === "tasks" && <TaskDialog open goals={work?.goals ?? []} onClose={() => setMaking(null)} />}
      {making === "jobs" && jobs && <ScheduleDialog editing={{}} timezone={jobs.timezone} onClose={() => setMaking(null)} />}
      {making === "goals" && <GoalDialog editing={{}} onClose={() => setMaking(null)} />}
      {making === "watches" && <WatchDialog editing={{}} onClose={() => setMaking(null)} />}
    </>
  );
}

// --- A thread's own: its facts and what can be done with it ------------------------------------------------------

type Action = { label: string; href?: string; run?: () => Promise<unknown>; success?: string; external?: boolean };

/**
 * A thread's actions, under its state: one primary, the rest in a menu, as the viewer has them; and above them,
 * what a kind adds (a schedule's timing and model, a watch's page). An approval waiting on it is answered here.
 */
export function ThreadActions({ thread, question, approval, notice, fields }: {
  thread: BoardThread; question?: string; approval?: string; notice?: Notice;
  /** The pane's own key/value rows, which a kind's go after. */
  fields: ReactNode;
}) {
  const { dashboardKey } = useSession();
  const id = rawId(thread.id);
  const isTask = thread.kind === "task";
  const isJob = thread.kind === "job" || thread.kind === "heartbeat";
  const needWork = isTask || thread.kind === "goal" || thread.kind === "watch";
  const work = useQuery(api.dashboard.getWork, needWork ? { key: dashboardKey } : "skip");
  const jobs = useQuery(api.jobs.listForDashboard, isJob ? { key: dashboardKey } : "skip");
  const models = useQuery(api.models.options, isJob ? { key: dashboardKey } : "skip")?.models;
  const preferred = useQuery(api.dashboard.getDefaultEngine, isJob ? { key: dashboardKey } : "skip");
  const approvals = useQuery(api.approvals.pending, approval ? { key: dashboardKey } : "skip");
  const now = useNow(1_000);
  const { ask, dialog } = useConfirm();
  const [editing, setEditing] = useState(false);

  const cancelTask = useMutation(api.dashboard.cancelTask);
  const snooze = useMutation(api.taskDecisions.snoozeFromDashboard);
  const runNow = useMutation(api.jobs.runNow);
  const setEnabled = useMutation(api.jobs.setEnabled);
  const removeJob = useMutation(api.jobs.removeFromDashboard);
  const setModel = useMutation(api.jobs.setModel);
  const keepOn = useMutation(api.jobs.keepOn);
  const toggleMonitor = useMutation(api.dashboard.toggleMonitor);
  const deleteMonitor = useMutation(api.dashboard.deleteMonitor);
  const dismiss = useMutation(api.dashboard.dismissInbox);

  const task = isTask ? work?.tasks.find((item) => item._id === id) : undefined;
  const goal = thread.kind === "goal" ? work?.goals.find((item) => item._id === id) : undefined;
  const monitor = thread.kind === "watch" ? work?.monitors.find((item) => item._id === id) : undefined;
  const job = isJob ? jobs?.jobs.find((item) => item.id === id) : undefined;
  const pending = approval ? approvals?.find((item) => item.id === rawId(approval) && item.expiresAt > now) : undefined;
  const chat: Action | undefined = thread.chatId ? { label: "open chat", href: `/chat/${thread.chatId}` } : undefined;

  let primary: Action | undefined;
  const more: Action[] = [];
  const extra: ReactNode[] = [];
  if (isTask) {
    const cancellable = task && (task.status === "running" || task.status === "blocked" || Boolean(task.initiative && task.status === "queued"));
    primary = chat;
    if (task?.status === "blocked" && task.decision) {
      const version = task.decision.version;
      more.push({ label: "remind me in a day", run: () => snooze({ key: dashboardKey, id: task._id, version, until: Date.now() + 86_400_000 }), success: "Snoozed for a day." });
    }
    if (cancellable) {
      more.push({
        label: "cancel task",
        run: async () => ask({ title: "Cancel this task?", body: `Perry stops working on “${thread.title}”. What it already did stays done.`, label: "Cancel task", run: () => cancelTask({ key: dashboardKey, taskId: task._id }), success: "Task cancelled." }),
      });
    }
  } else if (isJob && job) {
    primary = { label: "run now", run: () => runNow({ key: dashboardKey, id: job.id }), success: `Running “${job.name}” now.` };
    more.push({ label: "change", run: async () => setEditing(true) });
    more.push({ label: job.enabled ? "pause" : "resume", run: () => setEnabled({ key: dashboardKey, id: job.id, enabled: !job.enabled }), success: job.enabled ? "Paused." : "Resumed." });
    if (chat) more.push(chat);
    if (!job.builtin) {
      more.push({
        label: "delete", run: async () => ask({ title: `Delete “${job.name}”?`, body: "It won't run again.", label: "Delete", run: () => removeJob({ key: dashboardKey, id: job.id }), success: "Schedule deleted." }),
      });
    }
  } else if (thread.kind === "watch" && monitor) {
    primary = { label: "open page", href: monitor.url, external: true };
    more.push({ label: "change", run: async () => setEditing(true) });
    more.push({ label: monitor.active ? "pause" : "resume", run: () => toggleMonitor({ key: dashboardKey, monitorId: monitor._id }), success: monitor.active ? "Watch paused." : "Watch resumed." });
    more.push({
      label: "delete", run: async () => ask({ title: `Stop watching “${monitor.title}”?`, body: "The watch and its history are deleted.", label: "Delete", run: () => deleteMonitor({ key: dashboardKey, monitorId: monitor._id }), success: "Watch deleted." }),
    });
  } else if (thread.kind === "goal" && goal) {
    primary = { label: "change", run: async () => setEditing(true) };
  } else {
    primary = chat;
  }
  if (primary && chat && primary !== chat && !more.includes(chat)) more.unshift(chat);
  if (notice) more.push({ label: "dismiss update", run: () => dismiss({ key: dashboardKey, items: [{ kind: notice.kind, id: notice.id }] }), success: "Dismissed." });

  const kindFields: ReactNode[] = [];
  if (job) kindFields.push(...jobFields(job, jobs!.timezone, now, { models: models ?? [], preferred, dashboardKey, setModel, keepOn }));
  if (monitor) kindFields.push(<Row key="page" label="page"><a href={monitor.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] underline-offset-2 hover:underline">{monitor.url}</a></Row>);
  if (monitor?.lastCheckedAt) kindFields.push(<Row key="checked" label="checked"><span>{ago(monitor.lastCheckedAt, now)}, then every {every(monitor.intervalMinutes)}</span></Row>);
  if (notice) kindFields.push(<Row key="notice" label="for you"><span className="whitespace-pre-wrap">{notice.text}</span></Row>);

  return (
    <>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
        {question && <Row label="question"><span className="whitespace-pre-wrap text-[13px]">{question}</span></Row>}
        {fields}
        {kindFields}
      </dl>
      {/* An approval is answered where it is read; one that has expired since says so. */}
      {approval && (pending
        ? <div className="rounded-lg border border-warning/35 py-1 text-[13px] [&_pre]:px-2.5 [&_pre]:py-2 [&_pre]:text-[13px] [&_pre]:[overflow-wrap:normal]" data-approval-card><ApprovalCard approval={pending} now={now} showChat={false} bare /></div>
        : approvals && <p className="text-[12px] text-muted-foreground">That approval was answered or has expired.</p>)}
      {question && task?.status === "blocked" && <Answer task={task} />}
      {extra}
      {(primary || more.length > 0) && (
        <div className="flex items-center gap-1.5">
          {primary && !question && !pending && <Act action={primary} primary />}
          {primary && (question || pending) && <Act action={primary} />}
          {more.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="secondary" size="icon-sm" aria-label="More" data-more />}><MoreHorizontalIcon /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={MENU}>
                {more.map((item, index) => [
                  item.label === "delete" || item.label === "cancel task" ? <DropdownMenuSeparator key={`sep-${index}`} /> : null,
                  <MenuAct key={item.label} action={item} />,
                ])}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {dialog}
      {editing && job && <ScheduleDialog editing={{ item: job }} timezone={jobs!.timezone} onClose={() => setEditing(false)} />}
      {editing && monitor && <WatchDialog editing={{ item: monitor }} onClose={() => setEditing(false)} />}
      {editing && goal && <GoalDialog editing={{ item: goal } as Editing<Doc<"goals">>} onClose={() => setEditing(false)} />}
    </>
  );
}

const MENU_ICON: Record<string, ReactNode> = {
  change: <PencilIcon />, pause: <PauseIcon />, resume: <PlayIcon />, delete: <Trash2Icon />, "cancel task": <XIcon />, "dismiss update": <CheckIcon />,
};

function MenuAct({ action }: { action: Action }) {
  const destructive = action.label === "delete" || action.label === "cancel task";
  if (action.href) {
    return <DropdownMenuItem render={action.external ? <a href={action.href} target="_blank" rel="noopener noreferrer" /> : <Link href={action.href} />}>{action.label}</DropdownMenuItem>;
  }
  return (
    <DropdownMenuItem variant={destructive ? "destructive" : "default"} onClick={() => void attempt(action.run!, action.success ? { success: action.success } : {})}>
      {MENU_ICON[action.label]}{action.label}
    </DropdownMenuItem>
  );
}

function Act({ action, primary = false }: { action: Action; primary?: boolean }) {
  const variant = primary ? "default" : "outline";
  if (action.href) {
    return <Button size="sm" variant={variant} data-action render={action.external ? <a href={action.href} target="_blank" rel="noopener noreferrer" /> : <Link href={action.href} />}>{action.label}</Button>;
  }
  return <ActionButton size="sm" variant={variant} data-action action={action.run!} {...(action.success ? { success: action.success } : {})}>{action.label}</ActionButton>;
}

/** A task's question, answered in place, as Work had it: it goes back to work with the answer. */
function Answer({ task }: { task: Doc<"tasks"> }) {
  const { dashboardKey } = useSession();
  const answerTask = useMutation(api.tasks.answerFromDashboard);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  return (
    <form data-answer onSubmit={(event) => {
      event.preventDefault();
      const text = answer.trim();
      if (!text || sending) return;
      setSending(true);
      void attempt(() => answerTask({ key: dashboardKey, id: task._id, answer: text, decisionVersion: task.decision?.version }), { success: "Answered. It carries on." })
        .then((ok) => { if (ok) setAnswer(""); setSending(false); });
    }}>
      <InputGroup className="h-9">
        <InputGroupInput aria-label={`Answer for ${task.title}`} placeholder="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} className="text-[13px]" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="submit" size="xs" className="text-primary hover:text-primary" disabled={!answer.trim() || sending} aria-busy={sending || undefined}>answer</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd></>;
}

const every = (minutes: number) => minutes >= 60 && minutes % 60 === 0 ? (minutes === 60 ? "hour" : `${minutes / 60} hours`) : `${minutes} minutes`;

/** A schedule's own rows: when it runs, its model (changed here, as on Work), and where its last run went. */
function jobFields(job: JobView, timezone: string, now: number, { models, preferred, dashboardKey, setModel, keepOn }: {
  models: ModelOption[]; preferred: unknown; dashboardKey: string;
  setModel: (args: { key: string; id: Id<"jobs">; model?: string; engine?: NonNullable<Doc<"jobs">["engine"]> }) => Promise<unknown>;
  keepOn: (args: { key: string; id: Id<"jobs"> }) => Promise<unknown>;
}): ReactNode[] {
  const readable = job.trigger ? job.trigger.label : job.runAt !== undefined ? `Once, ${fullDate(job.runAt, timezone)}` : job.schedule ? describeSchedule(job.schedule) ?? job.schedule : "";
  const several = enginesOf(models).length > 1;
  const picked = job.model && job.engine ? modelKey(job.engine, job.model) : undefined;
  const items = [
    { value: "default", label: preferred === null ? "Automatic (no engine chosen)" : "Automatic" },
    ...models.map((item) => ({ value: modelKey(item.engine, item.id), label: several ? `${item.name} · ${ENGINE_LABELS[item.engine]}` : item.name })),
    ...(picked && !models.some((item) => modelKey(item.engine, item.id) === picked) ? [{ value: picked, label: `${job.model} (not offered, uses default)` }] : []),
  ];
  const moved = job.route?.movedFrom;
  return [
    <Row key="when" label="runs">
      <span>{readable}{job.enabled && job.runAt === undefined && !job.trigger && <span className="text-muted-foreground"> · next {ago(job.nextRunAt, now)}</span>}{!job.enabled && <span className="text-muted-foreground"> · paused</span>}</span>
    </Row>,
    <Row key="model" label="model">
      <Select items={items} value={picked ?? "default"} disabled={!models.length}
        onValueChange={(value) => void attempt(() => setModel({ key: dashboardKey, id: job.id, ...(!value || value === "default" ? {} : { model: parseModelKey(value).id, engine: parseModelKey(value).engine }) }),
          { success: !value || value === "default" ? "Perry picks its model from the next run." : "Model changed. It applies from the next run." })}>
        <SelectTrigger size="sm" aria-label={`Model for ${job.name}`} className="-my-1 h-6 max-w-56 text-[12px]" data-job-model><SelectValue /></SelectTrigger>
        <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </Row>,
    ...(job.waiting ? [<Row key="waiting" label="waiting"><span className="text-warning">{job.waiting.why}</span></Row>] : []),
    ...(moved && !job.stay && !job.waiting ? [
      <Row key="moved" label="moved">
        <span className="text-warning">To {ENGINE_LABELS[job.route!.engine]}: {moved.why}. </span>
        <button type="button" className="underline underline-offset-2" onClick={() => void attempt(() => keepOn({ key: dashboardKey, id: job.id }), { success: `It stays on ${ENGINE_LABELS[moved.engine]} now.` })}>Keep on {ENGINE_LABELS[moved.engine]}</button>
      </Row>,
    ] : []),
  ];
}
