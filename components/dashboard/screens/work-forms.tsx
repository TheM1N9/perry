"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useMutation } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import type { JobView } from "@/convex/jobs";
import { errorText, plural } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TimePicker } from "@/components/ui/time-picker";

/**
 * Making and changing schedules, goals and page watches on the Work page, so
 * none of them needs a chat. Each saves through the same checks as the tool
 * Perry uses for it, and the server's reason shows when it refuses.
 */

/** What a dialog is doing: closed, making a new one, or changing one. */
export type Editing<T> = { item?: T } | null;

function FormDialog({ open, onClose, title, description, saving, onSave, children }: {
  open: boolean; onClose: () => void; title: string; description?: string; saving: boolean; onSave: () => void; children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="contents" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
          <FieldGroup>{children}</FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Save, then close; on a refusal, say why and stay open. */
function useSave(onClose: () => void) {
  const [saving, setSaving] = useState(false);
  const save = async (run: () => Promise<unknown>, success: string) => {
    setSaving(true);
    try {
      await run();
      toast.success(success);
      onClose();
    } catch (cause) {
      toast.error(`Couldn't save it: ${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  };
  return { saving, save };
}

function Choice({ label, value, items, onChange, id }: { label: string; value: string; items: Array<{ value: string; label: string }>; onChange: (value: string) => void; id: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select items={items} value={value} onValueChange={(next) => { if (next) onChange(String(next)); }}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
}

// --- Schedules ---------------------------------------------------------------

type Repeat = "daily" | "weekdays" | "weekly" | "monthly" | "once" | "custom" | "folder" | "event";
const REPEATS: Array<{ value: Repeat; label: string }> = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "once", label: "Once" },
  { value: "custom", label: "Custom (cron)" },
  { value: "folder", label: "When a file lands in a folder" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ value: String(index), label }));
const MONTH_DAYS = Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: `Day ${index + 1}` }));

type When = { repeat: Repeat; time: string; weekday: string; monthDay: string; cron: string; once: string; folder: string };

const pad = (n: number) => String(n).padStart(2, "0");
/** A time as the form keeps it ("2026-10-02T14:30"), on this browser's clock. */
const localInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** The form's reading of a job's time: one of the simple shapes when it is one, else its cron as written. */
function readWhen(job?: JobView): When {
  const base: When = { repeat: "daily", time: "08:00", weekday: "1", monthDay: "1", cron: job?.schedule ?? "", once: localInput(Date.now() + 3_600_000), folder: "" };
  if (!job) return base;
  // An app's event is set up by Perry in a chat, and kept as it is here.
  if (job.trigger) return job.trigger.kind === "folder" ? { ...base, repeat: "folder", folder: job.trigger.path ?? "" } : { ...base, repeat: "event" };
  if (job.runAt !== undefined) return { ...base, repeat: "once", once: localInput(job.runAt) };
  const match = /^(\d{1,2}) (\d{1,2}) (\S+) \* (\S+)$/.exec(job.schedule?.trim() ?? "");
  if (!match) return { ...base, repeat: "custom" };
  const [, minute, hour, dayOfMonth, dayOfWeek] = match;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dayOfMonth === "*" && dayOfWeek === "*") return { ...base, repeat: "daily", time };
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return { ...base, repeat: "weekdays", time };
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) return { ...base, repeat: "weekly", time, weekday: dayOfWeek };
  if (/^([1-9]|1\d|2[0-8])$/.test(dayOfMonth) && dayOfWeek === "*") return { ...base, repeat: "monthly", time, monthDay: dayOfMonth };
  return { ...base, repeat: "custom" };
}

/** What the server is sent: a cron schedule, a one-time `at`, or a folder to watch. */
function writeWhen(when: When): { schedule?: string; at?: string; folder?: string } {
  if (when.repeat === "event") return {};
  if (when.repeat === "folder") return { folder: when.folder.trim() };
  if (when.repeat === "once") return { at: when.once ? new Date(when.once).toISOString() : undefined };
  if (when.repeat === "custom") return { schedule: when.cron.trim() };
  const [hour, minute] = when.time.split(":").map(Number);
  const at = `${minute || 0} ${hour || 0}`;
  if (when.repeat === "daily") return { schedule: `${at} * * *` };
  if (when.repeat === "weekdays") return { schedule: `${at} * * 1-5` };
  if (when.repeat === "weekly") return { schedule: `${at} * * ${when.weekday}` };
  return { schedule: `${at} ${when.monthDay} * *` };
}

export function ScheduleDialog({ editing, timezone, onClose }: { editing: Editing<JobView>; timezone: string; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const saveJob = useMutation(api.jobs.saveFromDashboard);
  const { saving, save } = useSave(onClose);
  const job = editing?.item;
  const builtin = Boolean(job?.builtin);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [when, setWhen] = useState<When>(readWhen());
  useEffect(() => {
    if (!editing) return;
    setName(editing.item?.name ?? "");
    setPrompt(editing.item?.prompt ?? "");
    setWhen(readWhen(editing.item));
  }, [editing]);
  const change = (patch: Partial<When>) => setWhen((current) => ({ ...current, ...patch }));
  // A built-in job's prompt comes from Perry's code; only when it runs is the owner's to change.
  // A job an event starts keeps its kind of event; a folder can move to another folder.
  const event = Boolean(job?.trigger);
  const repeats = builtin ? REPEATS.filter((item) => item.value !== "once" && item.value !== "folder")
    : job?.trigger?.kind === "folder" ? REPEATS.filter((item) => item.value === "folder")
      : job?.trigger ? [{ value: "event" as const, label: job.trigger.label }]
        : job ? REPEATS.filter((item) => item.value !== "folder") : REPEATS;

  return (
    <FormDialog open={editing !== null} onClose={onClose} saving={saving}
      title={job ? `Change “${job.name}”` : "New schedule"}
      description={builtin ? "A built-in schedule keeps its own prompt; you can change when it runs."
        : event ? "Perry runs the prompt each time the event happens, and sends you what it finds."
          : `Perry runs the prompt as a fresh turn at these times, in ${timezone}, or when a file lands in a folder, and sends you what it finds.`}
      onSave={() => void save(() => saveJob({ key: dashboardKey, ...(job ? { id: job.id } : {}), name, prompt, ...writeWhen(when) }), job ? "Schedule saved." : "Schedule made.")}>
      {!builtin && (
        <>
          <Field>
            <FieldLabel htmlFor="schedule-name">Name</FieldLabel>
            <Input id="schedule-name" value={name} maxLength={80} placeholder="Morning briefing" autoFocus onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-prompt">What Perry does</FieldLabel>
            <Textarea id="schedule-prompt" value={prompt} maxLength={4000} rows={4} placeholder="Summarise today's calendar and anything urgent in my inbox. If there is nothing, say nothing."
              onChange={(event) => setPrompt(event.target.value)} />
            <FieldDescription>Write it so it stands on its own. &ldquo;Only tell me if…&rdquo; makes a quiet run send nothing.</FieldDescription>
          </Field>
        </>
      )}
      <Choice id="schedule-repeat" label="When" value={when.repeat} items={repeats} onChange={(value) => change({ repeat: value as Repeat })} />
      {when.repeat === "weekly" && <Choice id="schedule-weekday" label="On" value={when.weekday} items={WEEKDAYS} onChange={(weekday) => change({ weekday })} />}
      {when.repeat === "monthly" && <Choice id="schedule-day" label="On" value={when.monthDay} items={MONTH_DAYS} onChange={(monthDay) => change({ monthDay })} />}
      {["daily", "weekdays", "weekly", "monthly"].includes(when.repeat) && (
        <Field>
          <FieldLabel htmlFor="schedule-time">At</FieldLabel>
          <TimePicker id="schedule-time" aria-label="At" value={when.time} onValueChange={(time) => change({ time })} />
        </Field>
      )}
      {when.repeat === "once" && (
        <Field>
          <FieldLabel htmlFor="schedule-once">Date and time</FieldLabel>
          <DatePicker id="schedule-once" time value={when.once ? new Date(when.once) : undefined} onValueChange={(at) => change({ once: localInput(at.getTime()) })} />
        </Field>
      )}
      {when.repeat === "folder" && (
        <Field>
          <FieldLabel htmlFor="schedule-folder">Folder</FieldLabel>
          <Input id="schedule-folder" value={when.folder} className="font-mono" placeholder="C:\Users\you\Downloads" required onChange={(event) => change({ folder: event.target.value })} />
          <FieldDescription>Its full path on this computer. Each new file there starts a run, with the file&apos;s path.</FieldDescription>
        </Field>
      )}
      {when.repeat === "event" && job?.trigger && (
        <FieldDescription>Perry set this up in a chat. To start it on something else, delete it and ask Perry for a new one.</FieldDescription>
      )}
      {when.repeat === "custom" && (
        <Field>
          <FieldLabel htmlFor="schedule-cron">Cron schedule</FieldLabel>
          <Input id="schedule-cron" value={when.cron} className="font-mono" placeholder="0 9 * * 1-5" required onChange={(event) => change({ cron: event.target.value })} />
          <FieldDescription>Minute, hour, day of the month, month, day of the week.</FieldDescription>
        </Field>
      )}
    </FormDialog>
  );
}

// --- Tasks -------------------------------------------------------------------

/** A background task handed to Perry: what to call it, what to do, and the goal it serves. */
export function TaskDialog({ open, goals, onClose }: { open: boolean; goals: Doc<"goals">[]; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const queue = useMutation(api.tasks.queueFromDashboard);
  const { saving, save } = useSave(onClose);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [goal, setGoal] = useState("none");
  useEffect(() => { if (open) { setTitle(""); setPrompt(""); setGoal("none"); } }, [open]);
  const items = [{ value: "none", label: "None" }, ...goals.filter((item) => item.status !== "done").map((item) => ({ value: item._id, label: item.title }))];
  return (
    <FormDialog open={open} onClose={onClose} saving={saving} title="New task"
      description="Perry works on it by himself when nothing else is running, and tells you the result, or asks if he gets stuck."
      onSave={() => void save(() => queue({ key: dashboardKey, title, prompt, ...(goal !== "none" ? { goalId: goal as Doc<"goals">["_id"] } : {}) }), "Queued. Perry starts when he is free.")}>
      <Field>
        <FieldLabel htmlFor="task-title">Task</FieldLabel>
        <Input id="task-title" value={title} maxLength={160} placeholder="Compare three flats near work" autoFocus required onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="task-prompt">What to do</FieldLabel>
        <Textarea id="task-prompt" value={prompt} rows={5} maxLength={12000} placeholder="Find three 2-bedroom flats within 5 km of my office, under ₹40,000 a month, and put a comparison in a note in your files folder."
          onChange={(event) => setPrompt(event.target.value)} />
        <FieldDescription>Everything he needs to do it without asking: what, where the result goes, what counts as done.</FieldDescription>
      </Field>
      {items.length > 1 && <Choice id="task-goal" label="For a goal" value={goal} items={items} onChange={setGoal} />}
    </FormDialog>
  );
}

// --- Goals -------------------------------------------------------------------

const GOAL_STATUS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "done", label: "Done" },
];

export function GoalDialog({ editing, onClose }: { editing: Editing<Doc<"goals">>; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const saveGoal = useMutation(api.dashboard.saveGoal);
  const { saving, save } = useSave(onClose);
  const goal = editing?.item;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [milestones, setMilestones] = useState("");
  const [status, setStatus] = useState<Doc<"goals">["status"]>("active");
  useEffect(() => {
    if (!editing) return;
    setTitle(editing.item?.title ?? "");
    setDescription(editing.item?.description ?? "");
    setMilestones((editing.item?.milestones ?? []).map((milestone) => milestone.title).join("\n"));
    setStatus(editing.item?.status ?? "active");
  }, [editing]);
  // A milestone kept by name keeps its tick.
  const done = new Set((goal?.milestones ?? []).filter((milestone) => milestone.done).map((milestone) => milestone.title.trim()));
  const list = milestones.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => ({ title: line, done: done.has(line) }));

  return (
    <FormDialog open={editing !== null} onClose={onClose} saving={saving}
      title={goal ? `Change “${goal.title}”` : "New goal"}
      description="Something you're working toward. Perry keeps it in mind, and ticks milestones off as you tell it."
      onSave={() => void save(() => saveGoal({ key: dashboardKey, ...(goal ? { id: goal._id, status } : {}), title, description, milestones: list }), goal ? "Goal saved." : "Goal made.")}>
      <Field>
        <FieldLabel htmlFor="goal-title">Goal</FieldLabel>
        <Input id="goal-title" value={title} maxLength={160} placeholder="Run a half marathon by March" autoFocus required onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="goal-description">Why, or what counts (optional)</FieldLabel>
        <Textarea id="goal-description" value={description} rows={2} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="goal-milestones">Milestones</FieldLabel>
        <Textarea id="goal-milestones" value={milestones} rows={5} placeholder={"Run 5 km without stopping\nRun 10 km\nSign up for the race"} onChange={(event) => setMilestones(event.target.value)} />
        <FieldDescription>One a line, up to 20.{list.length > 0 && ` ${plural(list.length, "milestone")}${done.size ? `, ${list.filter((item) => item.done).length} done` : ""}.`}</FieldDescription>
      </Field>
      {goal && <Choice id="goal-status" label="Status" value={status} items={GOAL_STATUS} onChange={(value) => setStatus(value as Doc<"goals">["status"])} />}
    </FormDialog>
  );
}

// --- Watches -----------------------------------------------------------------

const CONDITIONS = [
  { value: "change", label: "When anything changes" },
  { value: "contains", label: "When it contains some text" },
  { value: "price_below", label: "When the price drops below" },
];
const INTERVALS = [15, 30, 60, 180, 360, 720, 1440, 10080];
const every = (minutes: number) => minutes >= 60 && minutes % 60 === 0 ? `Every ${plural(minutes / 60, "hour")}` : `Every ${plural(minutes, "minute")}`;

export function WatchDialog({ editing, onClose }: { editing: Editing<Doc<"monitors">>; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const saveMonitor = useMutation(api.dashboard.saveMonitor);
  const { saving, save } = useSave(onClose);
  const watch = editing?.item;
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [condition, setCondition] = useState<Doc<"monitors">["condition"]>("change");
  const [value, setValue] = useState("");
  const [interval, setInterval] = useState("60");
  useEffect(() => {
    if (!editing) return;
    setTitle(editing.item?.title ?? "");
    setUrl(editing.item?.url ?? "");
    setCondition(editing.item?.condition ?? "change");
    setValue(editing.item?.value ?? "");
    setInterval(String(editing.item?.intervalMinutes ?? 60));
  }, [editing]);
  const intervals = [...new Set([...INTERVALS, Number(interval)])].sort((a, b) => a - b).map((minutes) => ({ value: String(minutes), label: every(minutes) }));

  return (
    <FormDialog open={editing !== null} onClose={onClose} saving={saving}
      title={watch ? `Change “${watch.title}”` : "Watch a page"}
      description="Perry checks a public page on an interval and tells you when the condition is met. A change of page or condition starts it over."
      onSave={() => void save(() => saveMonitor({
        key: dashboardKey, ...(watch ? { id: watch._id } : {}), title, url, condition, intervalMinutes: Number(interval),
        ...(condition === "change" ? {} : { value }),
      }), watch ? "Watch saved." : "Watching it.")}>
      <Field>
        <FieldLabel htmlFor="watch-url">Page</FieldLabel>
        <Input id="watch-url" type="url" value={url} placeholder="https://" autoFocus required onChange={(event) => setUrl(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="watch-title">Name</FieldLabel>
        <Input id="watch-title" value={title} maxLength={160} placeholder="Headphones back in stock" onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Choice id="watch-condition" label="Tell me" value={condition} items={CONDITIONS} onChange={(next) => setCondition(next as Doc<"monitors">["condition"])} />
      {condition !== "change" && (
        <Field>
          <FieldLabel htmlFor="watch-value">{condition === "contains" ? "Text to look for" : "Price"}</FieldLabel>
          <Input id="watch-value" value={value} maxLength={300} required placeholder={condition === "contains" ? "In stock" : "₹25,000"} onChange={(event) => setValue(event.target.value)} />
          {condition === "price_below" && <FieldDescription>With its currency as the page writes it (₹, $, €, £…). A plain number matches any currency.</FieldDescription>}
        </Field>
      )}
      <Choice id="watch-interval" label="How often" value={interval} items={intervals} onChange={setInterval} />
    </FormDialog>
  );
}
