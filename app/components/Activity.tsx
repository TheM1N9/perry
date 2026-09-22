"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

function ago(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Every turn Perry has taken, with what it cost and how it ended. This is the
 * view that makes a misbehaving agent debuggable instead of mysterious.
 */
export function Activity({ dashboardKey }: { dashboardKey: string }) {
  const runs = useQuery(api.dashboard.listRuns, { key: dashboardKey });

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Activity</h3>
        <span className="badge">{runs?.length ?? 0} runs</span>
      </div>
      <p className="hint">Newest first. Tools, tokens and failures, per turn.</p>

      {runs === undefined && <div className="empty">Loading.</div>}
      {runs?.length === 0 && <div className="empty">No turns yet.</div>}

      {runs?.map((run) => (
        <div className="item" key={run.id}>
          <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflowWrap: "anywhere" }}>{run.prompt}</div>
              <div className="item-meta">
                {ago(run.startedAt)}
                {" · "}
                {run.mode === "perry" ? "Perry" : "Agent P"}
                {run.model ? ` · ${run.model}` : ""}
                {typeof run.steps === "number" ? ` · ${run.steps} steps` : ""}
                {run.toolCalls && run.toolCalls.length > 0
                  ? ` · ${run.toolCalls.join(", ")}`
                  : ""}
                {typeof run.totalTokens === "number"
                  ? ` · ${run.totalTokens} tokens`
                  : ""}
                {typeof run.durationMs === "number"
                  ? ` · ${(run.durationMs / 1000).toFixed(1)}s`
                  : ""}
              </div>
              {run.error && (
                <div className="item-meta" style={{ color: "var(--danger)" }}>
                  {run.error}
                </div>
              )}
            </div>
            <span className={run.status === "error" ? "badge err" : "badge"}>
              {run.status}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
