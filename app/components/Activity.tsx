"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { RunView, SpanView } from "@/convex/dashboard";

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

function duration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const SPAN_KINDS: Record<SpanView["kind"], string> = {
  command: "shell",
  fileChange: "files",
  mcpToolCall: "tool",
  dynamicToolCall: "tool",
  webSearch: "search",
  imageGeneration: "image",
  reasoning: "thinking",
};

/**
 * What Codex did during a run, as a timeline from the moment the run started.
 * Loaded only while open. Span times come from the runner's clock and the
 * run's from Convex's, so a bar that would start before the run starts at it.
 */
function Trace({ dashboardKey, run }: { dashboardKey: string; run: RunView }) {
  const spans = useQuery(api.dashboard.runTrace, { key: dashboardKey, runId: run.id as Id<"runs"> });
  if (spans === undefined) return <div className="trace-empty">Loading trace…</div>;
  if (spans.length === 0) return <div className="trace-empty">Nothing was traced for this run.</div>;
  const origin = run.startedAt;
  const end = Math.max(
    run.durationMs !== undefined ? origin + run.durationMs : Date.now(),
    ...spans.map((span) => span.startedAt + (span.durationMs ?? Date.now() - span.startedAt)),
  );
  const total = Math.max(1, end - origin);
  const percent = (ms: number) => Math.min(100, Math.max(0, (ms / total) * 100));
  return (
    <ol className="trace">
      {spans.map((span) => {
        const left = percent(span.startedAt - origin);
        const width = Math.max(0.6, Math.min(100 - left, percent(span.durationMs ?? Date.now() - span.startedAt)));
        return (
          <li key={span.id} className={`trace-span ${span.status}`}>
            <div className="trace-row">
              <span className="trace-label" title={span.name}><em>{SPAN_KINDS[span.kind]}</em>{span.name}</span>
              <span className="trace-track"><span className="trace-bar" style={{ left: `${left}%`, width: `${width}%` }} /></span>
              <span className="trace-time">{span.status === "running" ? "running" : duration(span.durationMs ?? 0)}</span>
            </div>
            {(span.input || span.output) && (
              <details className="trace-io">
                <summary>{span.status === "ok" ? "Details" : `${span.status} · details`}</summary>
                {span.input && <><h5>Input</h5><pre>{span.input}</pre></>}
                {span.output && <><h5>Output</h5><pre>{span.output}</pre></>}
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function TraceDetails({ dashboardKey, run }: { dashboardKey: string; run: RunView }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="activity-trace" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Trace</summary>
      {open && <Trace dashboardKey={dashboardKey} run={run} />}
    </details>
  );
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
              <span>Assistant</span>
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
            {run.usage?.inputTokens !== undefined && (
              <div className="activity-tokens">
                Tokens {run.usage.inputTokens.toLocaleString()} in
                {" / "}{(run.usage.cachedInputTokens ?? 0).toLocaleString()} cached
                {" / "}{(run.usage.outputTokens ?? 0).toLocaleString()} out
                {run.usage.reasoningTokens ? ` (${run.usage.reasoningTokens.toLocaleString()} reasoning)` : ""}
              </div>
            )}
            {run.toolCalls && run.toolCalls.length > 0 && (
              <div className="activity-tools">
                {run.toolCalls.map((tool, index) => <span key={`${tool}-${index}`}>{tool}</span>)}
              </div>
            )}
            {run.error && <div className="activity-error" role="alert">{run.error}</div>}
            <TraceDetails dashboardKey={dashboardKey} run={run} />
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
