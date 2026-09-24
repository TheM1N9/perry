"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Jobs } from "./Jobs";
import { ActionButton, Empty, Icon, Loading, RelativeTime, Section, Status, useNow, ago, type Tone } from "./ui";

const TASK_TONE: Record<string, Tone> = { queued: "neutral", running: "info", blocked: "warning", failed: "danger", done: "success", cancelled: "neutral" };
const TASK_LABEL: Record<string, string> = { running: "Running", blocked: "Needs you", failed: "Failed", done: "Done", cancelled: "Cancelled" };
const GOAL_TONE: Record<string, Tone> = { active: "info", done: "success", paused: "warning" };
const CONDITION: Record<string, string> = { change: "When anything changes", contains: "When it contains", price_below: "When the price drops below" };

const label = (status: string, labels: Record<string, string> = {}) => labels[status] ?? status.charAt(0).toUpperCase() + status.slice(1);

/**
 * What Perry is doing, borrowed wholesale from OpenMuse's idea that progress
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
  const now = useNow();

  return (
    <>
      <Jobs dashboardKey={dashboardKey} />

      <Section title="Tasks" count={work?.tasks.length} description="Perry opens a task for anything with more than a couple of steps, and keeps its plan here.">
        {work === undefined && <Loading rows={2} />}
        {work?.tasks.length === 0 && <Empty icon="work" title="No tasks yet">Ask Perry for something that takes a few steps, and its plan shows up here.</Empty>}
        {work?.tasks.map((task) => {
          const done = task.plan.filter((step) => step.status === "done").length;
          return <div className="item" key={task._id}>
            <div className="item-main">
              <div className="item-title">{task.title}</div>
              <div className="item-meta">
                <span>Updated {ago(task.updatedAt, now)}</span>
                {task.plan.length > 0 && <span className="nums">{done} of {task.plan.length} steps</span>}
              </div>
              {task.plan.length > 0 && <div className="progress" role="progressbar" aria-label="Task progress" aria-valuemin={0} aria-valuemax={task.plan.length} aria-valuenow={done}><span style={{ width: `${(done / task.plan.length) * 100}%` }} /></div>}
              {task.question && <div className="item-callout warning"><strong>Needs you:</strong> {task.question}</div>}
              {task.plan.length > 0 && <ol className="steps" aria-label="Plan">
                {task.plan.map((step, index) => <li key={index} className={step.status}>
                  <span className="step-mark" aria-hidden="true">{step.status === "done" && <Icon name="check" size={10} />}</span>
                  <span className="step-title">{step.title}<span className="sr-only"> ({step.status})</span></span>
                </li>)}
              </ol>}
              {task.result && <div className="item-callout neutral">{task.result}</div>}
              {task.error && <div className="item-callout danger"><strong>Failed:</strong> {task.error}</div>}
            </div>
            <div className="item-side">
              <Status tone={TASK_TONE[task.status] ?? "neutral"} pulse={task.status === "running"}>{label(task.status, TASK_LABEL)}</Status>
              {(task.status === "running" || task.status === "blocked") && <ActionButton variant="ghost" className="btn-danger-ghost" action={() => cancelTask({ key: dashboardKey, taskId: task._id })} success="Task cancelled."
                confirm={{ title: "Cancel this task?", body: `Perry will stop working on “${task.title}”. Anything it already did stays done.`, confirmLabel: "Cancel task" }}>Cancel</ActionButton>}
            </div>
          </div>;
        })}
      </Section>

      <Section title="Goals" count={work?.goals.length} description="Longer-running outcomes, broken into milestones.">
        {work === undefined && <Loading rows={2} />}
        {work?.goals.length === 0 && <Empty icon="check" title="No goals yet">Tell Perry about something you&apos;re working toward, and it can track the milestones.</Empty>}
        {work?.goals.map((goal) => {
          const reached = goal.milestones.filter((milestone) => milestone.done).length;
          return <div className="item" key={goal._id}>
            <div className="item-main">
              <div className="item-title">{goal.title}</div>
              {goal.description && <div className="item-text">{goal.description}</div>}
              {goal.milestones.length > 0 && <>
                <div className="item-meta"><span className="nums">{reached} of {goal.milestones.length} milestones</span></div>
                <ol className="steps" aria-label="Milestones">
                  {goal.milestones.map((milestone, index) => <li key={index} className={milestone.done ? "done" : ""}>
                    <span className="step-mark" aria-hidden="true">{milestone.done && <Icon name="check" size={10} />}</span>
                    <span className="step-title">{milestone.title}<span className="sr-only"> ({milestone.done ? "done" : "not done"})</span></span>
                  </li>)}
                </ol>
              </>}
            </div>
            <div className="item-side"><Status tone={GOAL_TONE[goal.status] ?? "neutral"}>{label(goal.status)}</Status></div>
          </div>;
        })}
      </Section>

      <Section title="Watches" count={work?.monitors.length}
        description="Pages Perry checks on an interval. A new watch records a baseline first and stays quiet until something changes."
        actions={work && work.monitors.length > 0 && <ActionButton variant="secondary" icon="refresh" action={() => checkNow({ key: dashboardKey })} pendingLabel="Checking…" success="Checked every watch that was due.">Check now</ActionButton>}>
        {work === undefined && <Loading rows={2} />}
        {work?.monitors.length === 0 && <Empty icon="eye" title="Nothing watched">Ask Perry to watch a page, for example: “Tell me when this product is back in stock.”</Empty>}
        {work?.monitors.map((monitor) => (
          <div className="item" key={monitor._id}>
            <div className="item-main">
              <div className="item-title">{monitor.title}</div>
              <a className="item-meta mono wrap-anywhere" href={monitor.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>{monitor.url}</a>
              <div className="item-meta">
                <span>{CONDITION[monitor.condition] ?? monitor.condition}{monitor.value ? ` “${monitor.value}”` : ""}</span>
                <span>Every {monitor.intervalMinutes >= 60 && monitor.intervalMinutes % 60 === 0 ? `${monitor.intervalMinutes / 60}h` : `${monitor.intervalMinutes}m`}</span>
                <RelativeTime at={monitor.lastCheckedAt} prefix="Checked " />
              </div>
              {monitor.failures > 0 && <div className="item-callout warning"><strong>{monitor.failures} failed {monitor.failures === 1 ? "check" : "checks"}.</strong> Perry keeps trying on schedule.</div>}
              {monitor.lastObservation && <div className="item-callout neutral">{monitor.lastObservation}</div>}
            </div>
            <div className="item-side">
              <Status tone={monitor.active ? "success" : "warning"}>{monitor.active ? "Watching" : "Paused"}</Status>
              <div className="item-actions">
                <ActionButton variant="ghost" action={() => toggleMonitor({ key: dashboardKey, monitorId: monitor._id })} success={monitor.active ? "Watch paused." : "Watch resumed."}>{monitor.active ? "Pause" : "Resume"}</ActionButton>
                <ActionButton variant="ghost" className="btn-danger-ghost" action={() => deleteMonitor({ key: dashboardKey, monitorId: monitor._id })} success="Watch deleted."
                  confirm={{ title: `Stop watching “${monitor.title}”?`, body: "The watch and its history will be deleted.", confirmLabel: "Delete watch" }}>Delete</ActionButton>
              </div>
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}
