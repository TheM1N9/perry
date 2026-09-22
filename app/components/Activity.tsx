"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type SessionId = Id<"conversations">;

function ago(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Run diagnostics, linked back to the session whose messages appear in Chat. */
export function Activity({
  dashboardKey,
  onOpenChat,
}: {
  dashboardKey: string;
  onOpenChat: (id: SessionId) => void;
}) {
  const [sessionId, setSessionId] = useState<SessionId | "">("");
  const [status, setStatus] = useState("all");
  const sessions = useQuery(api.dashboard.listActivitySessions, { key: dashboardKey });
  const runs = useQuery(api.dashboard.listRuns, {
    key: dashboardKey,
    conversationId: sessionId || undefined,
  });
  const visible = runs?.filter((run) => status === "all" || run.status === status) ?? [];
  const errors = visible.filter((run) => run.status === "error").length;
  const tokens = visible.reduce((total, run) => total + (run.totalTokens ?? 0), 0);

  return (
    <div className="activity-view">
      <div className="activity-summary">
        <div><strong>{visible.length}</strong><span>recent runs</span></div>
        <div><strong>{errors}</strong><span>errors</span></div>
        <div><strong>{tokens.toLocaleString()}</strong><span>tokens</span></div>
      </div>

      <div className="panel activity-panel">
        <div className="activity-toolbar">
          <div>
            <h3>Run activity</h3>
            <p className="hint">Execution details for each turn. Messages stay in Chat.</p>
          </div>
          <div className="activity-filters">
            <label>
              <span>Session</span>
              <select value={sessionId} onChange={(event) => setSessionId(event.target.value as SessionId | "")}>
                <option value="">All sessions</option>
                {sessions?.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title} · {session.channel} · {session.id.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="ok">Completed</option>
                <option value="running">Running</option>
                <option value="error">Errors</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
          </div>
        </div>

        {runs === undefined && <div className="empty">Loading activity…</div>}
        {runs && visible.length === 0 && <div className="empty">No runs match these filters.</div>}
        {visible.map((run) => (
          <article className="activity-run" key={run.id}>
            <div className="activity-run-top">
              <div className="activity-run-title">
                <strong>{run.chatTitle}</strong>
                <span className="activity-channel">{run.channel}</span>
              </div>
              <span className={run.status === "error" ? "badge err" : run.status === "ok" ? "badge on" : "badge"}>
                {run.status}
              </span>
            </div>
            <div className="activity-run-meta">
              <time dateTime={new Date(run.startedAt).toISOString()} title={new Date(run.startedAt).toLocaleString()}>
                {ago(run.startedAt)}
              </time>
              <span>{run.mode === "perry" ? "Perry" : "Agent P"}</span>
              {run.model && <span>{run.model}</span>}
              {typeof run.steps === "number" && <span>{run.steps} steps</span>}
              {typeof run.totalTokens === "number" && <span>{run.totalTokens.toLocaleString()} tokens</span>}
              {typeof run.durationMs === "number" && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
            </div>
            <div className="activity-identifiers">
              <span>Session ID <code title={run.sessionId}>{run.sessionId}</code></span>
              <span>Run ID <code title={run.id}>{run.id}</code></span>
              {run.threadId && <span>Thread ID <code title={run.threadId}>{run.threadId}</code></span>}
            </div>
            {run.toolCalls && run.toolCalls.length > 0 && (
              <div className="activity-tools">
                {run.toolCalls.map((tool, index) => <span key={`${tool}-${index}`}>{tool}</span>)}
              </div>
            )}
            {run.error && <div className="activity-error" role="alert">{run.error}</div>}
            <div className="activity-run-bottom">
              <details className="activity-prompt">
                <summary>View prompt</summary>
                <p>{run.prompt}</p>
              </details>
              {run.channel === "web" && (
                <button className="activity-open-chat" onClick={() => onOpenChat(run.sessionId)}>
                  Open chat
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
