"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const BY: Record<string, string> = {
  terminal: "you, in the terminal",
  dashboard: "you, in the dashboard",
  telegram: "you, on Telegram",
  timeout: "nobody, in time",
  rule: "a saved rule",
  reviewer: "the reviewer",
  trust: "the runner's trust policy",
};

function when(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : "never";
}

/**
 * What the owner has allowed for good, and how recent requests were settled:
 * by them, by a saved rule, by the reviewer, or by a trusting runner.
 */
export function Permissions({ dashboardKey, telegram }: {
  dashboardKey: string;
  telegram: { ownerOnTelegram: boolean; enabled: boolean };
}) {
  const rules = useQuery(api.approvals.rules, { key: dashboardKey });
  const recent = useQuery(api.approvals.recent, { key: dashboardKey });
  const deleteRule = useMutation(api.approvals.deleteRule);
  const setTelegram = useMutation(api.dashboard.setTelegramApprovals);

  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Always allowed</h3>
          <span className="badge">{rules?.length ?? 0}</span>
        </div>
        <p className="hint">
          Saved when you answer a request with Always allow. A matching request
          runs without asking. Declines are never remembered.
        </p>
        {telegram.ownerOnTelegram && (
          <label className="item-meta" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={telegram.enabled}
              onChange={(event) => void setTelegram({ key: dashboardKey, enabled: event.target.checked })}
            />
            Ask me on Telegram too, with Approve, Decline and Always allow buttons
          </label>
        )}
        {rules?.length === 0 && <div className="empty">Nothing yet.</div>}
        {rules?.map((rule) => (
          <div className="item permission-rule" key={rule.id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {rule.command && <code style={{ overflowWrap: "anywhere" }}>{rule.command}</code>}
                <div className="item-meta" style={{ overflowWrap: "anywhere" }}>
                  {rule.description} · {rule.runner}
                </div>
                <div className="item-meta">
                  used {rule.uses} {rule.uses === 1 ? "time" : "times"}, last {when(rule.lastUsedAt)}
                </div>
              </div>
              <button className="ghost danger" onClick={() => void deleteRule({ key: dashboardKey, id: rule.id })}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Recent approvals</h3>
          <span className="badge">{recent?.length ?? 0}</span>
        </div>
        <p className="hint">Everything a machine asked to do, and who let it or stopped it.</p>
        {recent?.length === 0 && <div className="empty">Nothing yet.</div>}
        {recent?.map((item) => (
          <div className="item recent-approval" key={item.id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <code style={{ overflowWrap: "anywhere" }}>{item.title}</code>
                <div className="item-meta">
                  {item.runner} · {when(item.createdAt)}
                  {item.decidedBy ? ` · by ${BY[item.decidedBy] ?? item.decidedBy}` : ""}
                </div>
                {item.review && (
                  <div className="item-meta">
                    Reviewer: {item.review.verdict}. {item.review.reason}
                  </div>
                )}
              </div>
              <span className={item.status === "declined" || item.status === "expired" ? "badge err" : "badge"}>
                {item.status === "auto" ? "allowed" : item.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
