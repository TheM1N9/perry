"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Scheduled jobs, the heartbeat among them. Each runs as a Codex turn and
 * sends its result to the owner; a job with nothing to say stays quiet.
 */
export function Jobs({ dashboardKey }: { dashboardKey: string }) {
  const data = useQuery(api.jobs.listForDashboard, { key: dashboardKey });
  const setEnabled = useMutation(api.jobs.setEnabled);
  const remove = useMutation(api.jobs.removeFromDashboard);
  const runNow = useMutation(api.jobs.runNow);
  if (data === undefined) return null;
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { timeZone: data.timezone, dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Scheduled jobs</h3>
        <span className="badge">{data.timezone}</span>
      </div>
      <p className="hint">
        Prompts the assistant runs on a schedule, like a morning briefing. Ask it in chat to set one up. The heartbeat checks in a few times a day and only speaks when something needs you.
      </p>
      {data.jobs.length === 0 && <div className="empty">No jobs yet.</div>}
      {data.jobs.map((job) => (
        <div className="item" key={job.id}>
          <div className="row" style={{ justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                {job.name}{" "}
                <span className={`badge ${job.enabled ? "on" : ""}`}>{job.enabled ? "on" : "paused"}</span>
              </div>
              <div className="item-meta">
                <code>{job.schedule}</code>
                {job.enabled ? ` · next ${when(job.nextRunAt)}` : ""}
                {job.lastRunAt ? ` · last ${when(job.lastRunAt)}` : ""}
              </div>
              {job.lastError && <div className="item-meta" style={{ color: "var(--warn)" }}>Last run failed: {job.lastError}</div>}
              {!job.lastError && job.lastResult && <div className="item-meta">Last result: {job.lastResult}</div>}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="ghost" onClick={() => void runNow({ key: dashboardKey, id: job.id })}>Run now</button>
              <button className="ghost" onClick={() => void setEnabled({ key: dashboardKey, id: job.id, enabled: !job.enabled })}>{job.enabled ? "Pause" : "Resume"}</button>
              {!job.builtin && <button className="ghost danger" onClick={() => void remove({ key: dashboardKey, id: job.id })}>Delete</button>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
