"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Jobs } from "./Jobs";

function ago(ts?: number): string {
  if (!ts) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STEP_MARK: Record<string, string> = {
  done: "x",
  active: ">",
  pending: " ",
  skipped: "-",
};

/**
 * What Assistant is doing, borrowed wholesale from OpenMuse's idea that progress
 * belongs in a row rather than in the conversation.
 *
 * The agent writes the plan through a tool, so this view is the truth rather
 * than a summary it produced on request.
 */
export function Work({ dashboardKey }: { dashboardKey: string }) {
  const work = useQuery(api.dashboard.getWork, { key: dashboardKey });
  const toggleMonitor = useMutation(api.dashboard.toggleMonitor);
  const deleteMonitor = useMutation(api.dashboard.deleteMonitor);
  const cancelTask = useMutation(api.dashboard.cancelTask);
  const checkNow = useAction(api.dashboard.checkMonitorsNow);
  const [checking, setChecking] = useState(false);

  if (work === undefined) return <div className="panel empty">Loading.</div>;

  const runNow = async () => {
    setChecking(true);
    try {
      await checkNow({ key: dashboardKey });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Jobs dashboardKey={dashboardKey} />
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Tasks</h3>
          <span className="badge">{work.tasks.length}</span>
        </div>
        <p className="hint">
          Opened by Assistant for anything with more than a couple of steps.
        </p>

        {work.tasks.length === 0 && <div className="empty">Nothing yet.</div>}

        {work.tasks.map((task) => (
          <div className="item" key={task._id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{task.title}</strong>
                <div className="item-meta">
                  {ago(task.updatedAt)}
                  {task.plan.length > 0
                    ? ` · ${task.plan.filter((s) => s.status === "done").length}/${task.plan.length} steps`
                    : ""}
                </div>

                {task.plan.length > 0 && (
                  <pre
                    style={{
                      margin: "8px 0 0",
                      fontSize: 12,
                      color: "var(--dim)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {task.plan
                      .map((s) => `[${STEP_MARK[s.status] ?? " "}] ${s.title}`)
                      .join("\n")}
                  </pre>
                )}

                {task.question && (
                  <div className="item-meta" style={{ color: "var(--warn)" }}>
                    Needs you: {task.question}
                  </div>
                )}
                {task.result && <div className="item-meta">{task.result}</div>}
                {task.error && (
                  <div className="item-meta" style={{ color: "var(--danger)" }}>
                    {task.error}
                  </div>
                )}
              </div>

              <div style={{ textAlign: "right" }}>
                <span
                  className={
                    task.status === "failed" ? "badge err" : "badge"
                  }
                >
                  {task.status}
                </span>
                {(task.status === "running" || task.status === "blocked") && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      className="ghost danger"
                      onClick={() =>
                        void cancelTask({ key: dashboardKey, taskId: task._id })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Goals</h3>
          <span className="badge">{work.goals.length}</span>
        </div>
        <p className="hint">Outcomes with milestones. Slower than tasks.</p>

        {work.goals.length === 0 && <div className="empty">None yet.</div>}

        {work.goals.map((goal) => (
          <div className="item" key={goal._id}>
            <strong>{goal.title}</strong>
            <span className="badge" style={{ marginLeft: 8 }}>
              {goal.status}
            </span>
            {goal.description && <div className="item-meta">{goal.description}</div>}
            {goal.milestones.length > 0 && (
              <pre
                style={{
                  margin: "8px 0 0",
                  fontSize: 12,
                  color: "var(--dim)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {goal.milestones
                  .map((m) => `[${m.done ? "x" : " "}] ${m.title}`)
                  .join("\n")}
              </pre>
            )}
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Watches</h3>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge">{work.monitors.length}</span>
            <button className="ghost" disabled={checking} onClick={() => void runNow()}>
              {checking ? "Checking" : "Check now"}
            </button>
          </div>
        </div>
        <p className="hint">
          Checked every five minutes, each on its own interval. A new change
          watch records a baseline first and stays quiet.
        </p>

        {work.monitors.length === 0 && <div className="empty">Nothing watched.</div>}

        {work.monitors.map((monitor) => (
          <div className="item" key={monitor._id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{monitor.title}</strong>
                <div className="item-meta" style={{ overflowWrap: "anywhere" }}>
                  {monitor.url}
                </div>
                <div className="item-meta">
                  {monitor.condition}
                  {monitor.value ? ` "${monitor.value}"` : ""}
                  {" · every "}
                  {monitor.intervalMinutes}m
                  {" · checked "}
                  {ago(monitor.lastCheckedAt)}
                  {monitor.failures > 0 ? ` · ${monitor.failures} failures` : ""}
                </div>
                {monitor.lastObservation && (
                  <div className="item-meta">{monitor.lastObservation}</div>
                )}
              </div>

              <div style={{ textAlign: "right" }}>
                <span className={monitor.active ? "badge on" : "badge"}>
                  {monitor.active ? "on" : "paused"}
                </span>
                <div className="row" style={{ marginTop: 8, gap: 6 }}>
                  <button
                    className="ghost"
                    onClick={() =>
                      void toggleMonitor({
                        key: dashboardKey,
                        monitorId: monitor._id,
                      })
                    }
                  >
                    {monitor.active ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="ghost danger"
                    onClick={() =>
                      void deleteMonitor({
                        key: dashboardKey,
                        monitorId: monitor._id,
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
