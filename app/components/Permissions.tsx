"use client";

import { useMutation, useQuery } from "@/client/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { ActionButton, Empty, Loading, RelativeTime, Section, Spinner, Status, errorText, useToast, type Tone } from "./ui";

const BY: Record<string, string> = {
  terminal: "you, in the terminal",
  dashboard: "you, in the dashboard",
  telegram: "you, on Telegram",
  timeout: "nobody, in time",
  rule: "a saved rule",
  reviewer: "the reviewer",
  trust: "the runner's trust policy",
};

const STATUS: Record<string, { tone: Tone; label: string }> = {
  approved: { tone: "success", label: "Approved" },
  auto: { tone: "success", label: "Allowed" },
  declined: { tone: "danger", label: "Declined" },
  expired: { tone: "warning", label: "Expired" },
};

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
  const toast = useToast();
  const [savingTelegram, setSavingTelegram] = useState(false);

  const toggleTelegram = async (enabled: boolean) => {
    setSavingTelegram(true);
    try {
      await setTelegram({ key: dashboardKey, enabled });
      toast({ tone: "success", text: enabled ? "Approval requests will also come to Telegram." : "Approval requests will stay in the dashboard and terminal." });
    } catch (cause) {
      toast({ tone: "danger", text: `Couldn't change this setting: ${errorText(cause)}` });
    } finally {
      setSavingTelegram(false);
    }
  };

  return (
    <>
      <Section title="Always allowed" count={rules?.length}
        description="Saved when you answer a request with Always allow. A matching request runs without asking. Declines are never remembered.">
        {telegram.ownerOnTelegram && <label className="toggle-row" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <input type="checkbox" checked={telegram.enabled} disabled={savingTelegram} onChange={(event) => void toggleTelegram(event.target.checked)} />
          <span style={{ display: "grid", gap: 2 }}>
            <span style={{ fontWeight: 500, display: "inline-flex", gap: 8, alignItems: "center" }}>Ask me on Telegram too {savingTelegram && <Spinner size={12} />}</span>
            <span className="item-text">Requests arrive with Approve, Decline and Always allow buttons.</span>
          </span>
        </label>}
        {rules === undefined && <Loading rows={2} />}
        {rules?.length === 0 && <Empty icon="check" title="No saved rules">Answer a request with Always allow and it shows up here.</Empty>}
        {rules?.map((rule) => (
          <div className="item permission-rule" key={rule.id}>
            <div className="item-main">
              {rule.command && <code className="approval-what" style={{ maxHeight: 120 }}>{rule.command}</code>}
              <div className="item-meta"><span>{rule.description}</span><span>{rule.runner}</span></div>
              <div className="item-meta">
                <span className="nums">Used {rule.uses} {rule.uses === 1 ? "time" : "times"}</span>
                {rule.lastUsedAt && <RelativeTime at={rule.lastUsedAt} prefix="last " />}
              </div>
            </div>
            <div className="item-side">
              <ActionButton variant="ghost" className="btn-danger-ghost" action={() => deleteRule({ key: dashboardKey, id: rule.id })} success="Rule deleted. Matching requests will ask again."
                confirm={{ title: "Delete this rule?", body: "Matching requests will ask for approval again.", confirmLabel: "Delete rule" }}>Delete</ActionButton>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Recent approvals" count={recent?.length} description="Everything a machine asked to do, and who let it or stopped it.">
        {recent === undefined && <Loading rows={2} />}
        {recent?.length === 0 && <Empty icon="check" title="No requests yet">When a machine asks before acting, the answer is recorded here.</Empty>}
        {recent?.map((item) => {
          const status = STATUS[item.status] ?? { tone: "neutral" as Tone, label: item.status };
          return <div className="item recent-approval" key={item.id}>
            <div className="item-main">
              <code className="approval-what" style={{ maxHeight: 120 }}>{item.title}</code>
              <div className="item-meta">
                <span>{item.runner}</span>
                <RelativeTime at={item.createdAt} />
                {item.decidedBy && <span>By {BY[item.decidedBy] ?? item.decidedBy}</span>}
              </div>
              {item.review && <div className="item-callout neutral">Reviewer: {item.review.verdict}. {item.review.reason}</div>}
            </div>
            <div className="item-side"><Status tone={status.tone}>{status.label}</Status></div>
          </div>;
        })}
      </Section>
    </>
  );
}
