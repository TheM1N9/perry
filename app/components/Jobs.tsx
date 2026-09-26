"use client";

import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { ActionButton, Empty, Loading, Section, Status, fullDate, useNow, ago } from "./ui";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A plain-English reading of the common cron shapes; anything else is shown as written. */
export function describeSchedule(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour)
    ? new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;
  if (/^\*\/\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every ${minute.slice(2)} minutes`;
  if (/^\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every hour at :${minute.padStart(2, "0")}`;
  if (/^\d+$/.test(minute) && /^\*\/\d+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every ${hour.slice(2)} hours`;
  if (/^\d+$/.test(minute) && /^\d+(,\d+)+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Daily at ${hour.split(",").map((h) => new Date(2000, 0, 1, Number(h), Number(minute)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })).join(", ")}`;
  }
  if (!at || month !== "*") return null;
  if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${at}`;
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Weekdays at ${at}`;
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) return `Every ${DAYS[Number(dayOfWeek)]} at ${at}`;
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `Monthly on day ${dayOfMonth} at ${at}`;
  return null;
}

/**
 * Scheduled jobs, the heartbeat among them. Each runs as a Codex turn and
 * sends its result to the owner; a job with nothing to say stays quiet.
 */
export function Jobs({ dashboardKey }: { dashboardKey: string }) {
  const data = useQuery(api.jobs.listForDashboard, { key: dashboardKey });
  const setEnabled = useMutation(api.jobs.setEnabled);
  const remove = useMutation(api.jobs.removeFromDashboard);
  const runNow = useMutation(api.jobs.runNow);
  const now = useNow();

  const description = "Prompts Perry runs on a schedule, like a morning briefing, or once, like a reminder. Ask for one in chat.";
  if (data === undefined) return <Section title="Scheduled" description={description}><Loading rows={2} /></Section>;
  const when = (ms: number) => fullDate(ms, data.timezone);
  type Job = (typeof data.jobs)[number];
  const yours = data.jobs.filter((job) => !job.builtin);
  // The heartbeat, daily summary and memory consolidation keep Perry running; they fold away so your own jobs lead.
  const builtins = data.jobs.filter((job) => job.builtin);
  const builtinFailures = builtins.filter((job) => job.enabled && job.lastError).length;

  const row = (job: Job) => {
    // A one-time job whose time has passed has run, or was paused past it; either way it is over.
    const over = job.runAt !== undefined && !job.enabled && job.runAt <= Date.now();
    const readable = job.schedule ? describeSchedule(job.schedule) : null;
    return (
      <div className="item" key={job.id}>
        <div className="item-main">
          <div className="item-title">{job.name}</div>
          <div className="item-meta">
            {job.runAt !== undefined
              ? <span>Once, {when(job.runAt)}</span>
              : <span title={job.schedule}>{readable ?? <code className="inline">{job.schedule}</code>}</span>}
            {job.enabled && job.runAt === undefined && <span title={when(job.nextRunAt)}>Next {ago(job.nextRunAt, now)}</span>}
            {job.lastRunAt ? <span title={when(job.lastRunAt)}>Last ran {ago(job.lastRunAt, now)}</span> : <span>Hasn&apos;t run yet</span>}
          </div>
          {job.lastError && <div className="item-callout danger"><strong>Last run failed.</strong> {job.lastError}</div>}
          {!job.lastError && job.lastResult && <div className="item-callout neutral">{job.lastResult}</div>}
        </div>
        <div className="item-side">
          <Status tone={job.enabled ? "success" : over ? "neutral" : "warning"}>{job.enabled ? "Active" : over ? "Done" : "Paused"}</Status>
          <div className="item-actions">
            <ActionButton variant="secondary" action={() => runNow({ key: dashboardKey, id: job.id })} success={`Running “${job.name}” now.`}>Run now</ActionButton>
            {!over && <ActionButton variant="ghost" action={() => setEnabled({ key: dashboardKey, id: job.id, enabled: !job.enabled })} success={job.enabled ? "Paused." : "Resumed."}>{job.enabled ? "Pause" : "Resume"}</ActionButton>}
            {!job.builtin && <ActionButton variant="ghost" className="btn-danger-ghost" action={() => remove({ key: dashboardKey, id: job.id })} success="Job deleted."
              confirm={{ title: `Delete “${job.name}”?`, body: "It won't run again. To bring it back, ask Perry to set it up again.", confirmLabel: "Delete job" }}>Delete</ActionButton>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Section title="Scheduled" count={yours.length} description={description} actions={<span className="tag" title="Jobs run in this timezone">{data.timezone}</span>}>
      {yours.length === 0 && <Empty icon="work" title="Nothing scheduled yet">Try asking in chat: “Every weekday at 8am, send me a summary of my calendar.”</Empty>}
      {yours.map(row)}
      {builtins.length > 0 && <details className="disclosure builtin-jobs">
        <summary>
          <span>Built in</span><span className="section-count">{builtins.length}</span>
          <span className="builtin-jobs-hint">Heartbeat, daily summary and memory upkeep</span>
          {builtinFailures > 0 && <Status tone="danger">{builtinFailures} failed</Status>}
        </summary>
        {builtins.map(row)}
      </details>}
    </Section>
  );
}
