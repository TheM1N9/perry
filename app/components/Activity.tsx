"use client";

import { useQuery } from "@/client/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { RunView, SpanView } from "@/convex/dashboard";
import { CopyButton, Empty, Loading, Notice, RelativeTime, Section, Status, type Tone } from "./ui";

type SessionId = Id<"conversations">;
/** Runs shown at a time; the rest are a click away. */
const PAGE = 20;

function duration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const RUN_STATUS: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "Completed" },
  running: { tone: "info", label: "Running" },
  error: { tone: "danger", label: "Error" },
  rejected: { tone: "warning", label: "Rejected" },
};

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
 * What Codex did during a run, as a timeline from its first span to its last.
 * Loaded only while open. Span times come from the runner's clock, which can
 * be well off Convex's, so the run's own times are not mixed in.
 */
function Trace({ dashboardKey, run }: { dashboardKey: string; run: RunView }) {
  const spans = useQuery(api.dashboard.runTrace, { key: dashboardKey, runId: run.id as Id<"runs"> });
  if (spans === undefined) return <div className="trace-empty" role="status">Loading trace…</div>;
  if (spans.length === 0) return <div className="trace-empty">Nothing was traced for this run.</div>;
  const origin = Math.min(...spans.map((span) => span.startedAt));
  const end = Math.max(...spans.map((span) => span.startedAt + (span.durationMs ?? Date.now() - span.startedAt)));
  const total = Math.max(1, end - origin);
  const percent = (ms: number) => Math.min(100, Math.max(0, (ms / total) * 100));
  const statuses = new Set(spans.map((span) => span.status));
  return (
    <>
      <div className="trace-legend" aria-hidden="true">
        <span><i />Finished</span>
        {statuses.has("error") && <span className="error"><i />Failed</span>}
        {statuses.has("declined") && <span className="declined"><i />Declined</span>}
        {statuses.has("running") && <span className="running"><i />Running</span>}
        <span className="nums">Total {duration(total)}</span>
      </div>
      <ol className="trace" aria-label="Trace">
        {spans.map((span) => {
          const left = percent(span.startedAt - origin);
          const width = Math.max(0.6, Math.min(100 - left, percent(span.durationMs ?? Date.now() - span.startedAt)));
          return (
            <li key={span.id} className={`trace-span ${span.status}`}>
              <div className="trace-row">
                <span className="trace-label" title={span.name}><em>{SPAN_KINDS[span.kind]}</em>{span.name}</span>
                <span className="trace-track" aria-hidden="true"><span className="trace-bar" style={{ left: `${left}%`, width: `${width}%` }} /></span>
                <span className="trace-time">{span.status === "running" ? "running" : duration(span.durationMs ?? 0)}</span>
              </div>
              {span.status !== "ok" && span.status !== "running" && <span className="sr-only">{span.status}</span>}
              {(span.input || span.output) && (
                <details className="trace-io">
                  <summary>{span.status === "ok" ? "Details" : `${span.status.charAt(0).toUpperCase()}${span.status.slice(1)} · details`}</summary>
                  {span.input && <><h5>Input</h5><pre>{span.input}</pre></>}
                  {span.output && <><h5>Output</h5><pre>{span.output}</pre></>}
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function TraceDetails({ dashboardKey, run }: { dashboardKey: string; run: RunView }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="activity-trace disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Trace</summary>
      {open && <Trace dashboardKey={dashboardKey} run={run} />}
    </details>
  );
}

/** Filters live in the URL, so a filtered view survives a refresh and can be shared. */
function useParam(name: string, fallback: string) {
  const [value, setValue] = useState(() => new URLSearchParams(window.location.search).get(name) ?? fallback);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (value === fallback) url.searchParams.delete(name); else url.searchParams.set(name, value);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [name, value, fallback]);
  return [value, setValue] as const;
}

/** Run diagnostics, linked back to the session whose messages appear in Chat. */
export function Activity({
  dashboardKey,
  onOpenChat,
}: {
  dashboardKey: string;
  onOpenChat: (id: SessionId) => void;
}) {
  const [sessionId, setSessionId] = useParam("session", "");
  const [status, setStatus] = useParam("status", "all");
  const [shown, setShown] = useState(PAGE);
  const sessions = useQuery(api.dashboard.listActivitySessions, { key: dashboardKey });
  const runs = useQuery(api.dashboard.listRuns, {
    key: dashboardKey,
    conversationId: (sessionId || undefined) as SessionId | undefined,
  });
  useEffect(() => setShown(PAGE), [sessionId, status]);
  const visible = runs?.filter((run) => status === "all" || run.status === status) ?? [];
  const errors = visible.filter((run) => run.status === "error").length;
  const tokens = visible.reduce((total, run) => total + (run.totalTokens ?? 0), 0);
  const filtered = Boolean(sessionId) || status !== "all";

  return (
    <div className="activity-view">
      <div className="stat-grid" aria-label="Summary">
        <div className="stat"><span>Runs</span><strong>{runs === undefined ? "–" : visible.length.toLocaleString()}</strong></div>
        <div className="stat"><span>Errors</span><strong style={errors ? { color: "var(--red)" } : undefined}>{runs === undefined ? "–" : errors.toLocaleString()}</strong></div>
        <div className="stat"><span>Tokens</span><strong>{runs === undefined ? "–" : tokens.toLocaleString()}</strong></div>
      </div>

      <Section plain title="Runs" description="Execution details for each turn, newest first. The messages themselves stay in Chat.">
        <div className="activity-toolbar">
          <div className="activity-filters">
            <label>
              <span>Chat</span>
              <select className="select" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
                <option value="">All chats</option>
                {sessions?.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title} · {session.channel}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="ok">Completed</option>
                <option value="running">Running</option>
                <option value="error">Errors</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
          </div>
          {filtered && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSessionId(""); setStatus("all"); }}>Clear filters</button>}
        </div>

        <div className="section-body">
          {runs === undefined && <Loading rows={4} label="Loading activity…" />}
          {runs && visible.length === 0 && (filtered
            ? <Empty icon="activity" title="No runs match these filters" action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => { setSessionId(""); setStatus("all"); }}>Clear filters</button>} />
            : <Empty icon="activity" title="No runs yet">Every message Perry answers shows up here with its tools, tokens, and timing.</Empty>)}
          {visible.slice(0, shown).map((run) => {
            const state = RUN_STATUS[run.status] ?? { tone: "neutral" as Tone, label: run.status };
            return <article className="activity-run" key={run.id} aria-label={run.chatTitle}>
              <div className="activity-run-top">
                <div className="activity-run-title">
                  <strong>{run.chatTitle}</strong>
                  <span className="tag">{run.channel === "web" ? "Web" : run.channel === "telegram" ? "Telegram" : run.channel}</span>
                </div>
                <Status tone={state.tone} pulse={run.status === "running"}>{state.label}</Status>
              </div>
              <div className="item-meta">
                <RelativeTime at={run.startedAt} />
                {run.model && <span className="mono" style={{ fontSize: 12 }}>{run.model}</span>}
                {typeof run.steps === "number" && <span className="nums">{run.steps} {run.steps === 1 ? "step" : "steps"}</span>}
                {typeof run.durationMs === "number" && <span className="nums">{duration(run.durationMs)}</span>}
                {typeof run.totalTokens === "number" && <span className="nums">{run.totalTokens.toLocaleString()} tokens</span>}
              </div>
              {run.toolCalls && run.toolCalls.length > 0 && (
                <div className="activity-tools" aria-label="Tools used">
                  {run.toolCalls.map((tool, index) => <span className="tag mono" key={`${tool}-${index}`}>{tool}</span>)}
                </div>
              )}
              {run.error && <Notice tone="danger" title="This run failed" details={run.error}>{run.error.split("\n")[0].slice(0, 200)}</Notice>}
              <div className="activity-run-bottom">
                <TraceDetails dashboardKey={dashboardKey} run={run} />
                <details className="disclosure activity-prompt">
                  <summary>Prompt</summary>
                  <p className="activity-prompt-text">{run.prompt}</p>
                </details>
                <details className="disclosure">
                  <summary>Details</summary>
                  {run.usage?.inputTokens !== undefined && (
                    <div className="activity-tokens" style={{ marginTop: 8 }}>
                      Tokens: {run.usage.inputTokens.toLocaleString()} in
                      {" · "}{(run.usage.cachedInputTokens ?? 0).toLocaleString()} cached
                      {" · "}{(run.usage.outputTokens ?? 0).toLocaleString()} out
                      {run.usage.reasoningTokens ? ` (${run.usage.reasoningTokens.toLocaleString()} reasoning)` : ""}
                    </div>
                  )}
                  <dl className="activity-ids">
                    <div><dt>Session</dt><dd>{run.sessionId}</dd><CopyButton value={run.sessionId} iconOnly label="Copy session ID" /></div>
                    <div><dt>Run</dt><dd>{run.id}</dd><CopyButton value={run.id} iconOnly label="Copy run ID" /></div>
                    {run.threadId && <div><dt>Thread</dt><dd>{run.threadId}</dd><CopyButton value={run.threadId} iconOnly label="Copy thread ID" /></div>}
                  </dl>
                </details>
                {run.channel === "web" && (
                  <button type="button" className="btn btn-ghost btn-sm activity-open-chat" style={{ marginLeft: "auto" }} onClick={() => onOpenChat(run.sessionId)}>
                    Open chat
                  </button>
                )}
              </div>
            </article>;
          })}
          {visible.length > shown && <div className="activity-more">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, visible.length - shown)} more of {visible.length - shown}</button>
          </div>}
        </div>
      </Section>
    </div>
  );
}
