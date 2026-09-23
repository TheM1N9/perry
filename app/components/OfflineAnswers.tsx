"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

/**
 * Whether a turn may be answered in Convex, on the ChatGPT subscription, when
 * no runner can take it. It needs the runner's ChatGPT token stored in the
 * deployment, so the page says so plainly and it stays off unless turned on.
 */
export function OfflineAnswers({ dashboardKey }: { dashboardKey: string }) {
  const status = useQuery(api.chatgpt.status, { key: dashboardKey });
  const setEnabled = useMutation(api.chatgpt.setEnabled);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (enabled: boolean) => {
    setError(null);
    try {
      await setEnabled({ key: dashboardKey, enabled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <div className="panel">
    <div className="row" style={{ justifyContent: "space-between" }}>
      <h3>When the computer is offline</h3>
      <span className={status?.enabled && status.validUntil ? "badge on" : "badge"}>{status?.enabled ? status.validUntil ? "ready" : "no token" : "off"}</span>
    </div>
    <label className="item" style={{ display: "flex", gap: 12, cursor: "pointer", borderTop: "none" }}>
      <input
        type="checkbox"
        style={{ width: "auto", marginTop: 4 }}
        checked={status?.enabled ?? false}
        disabled={status === undefined}
        onChange={(event) => void toggle(event.target.checked)}
      />
      <span>
        <strong>Answer without the computer when it&apos;s offline</strong>
        <div className="item-meta">
          Replies come from your ChatGPT subscription in Convex, with memory, earlier chats, connected accounts, jobs, tasks and page reading, but no shell, files or images from your machine.
        </div>
      </span>
    </label>
    <p className="hint" role="note">
      Risk: to do this, each runner stores the ChatGPT access token its Codex holds in your Convex deployment until it expires. Anyone who can read that deployment&apos;s data could use your ChatGPT subscription until then. The refresh token stays on your machine, and turning this off deletes every stored token.
    </p>
    {error && <p className="hint" role="alert" style={{ color: "var(--warn)" }}>{error}</p>}
    {status?.enabled && (status.machines.length === 0
      ? <p className="hint">No valid token yet. A running runner signed in to ChatGPT shares one within a minute.</p>
      : status.machines.map((machine) => <div className="item-meta" key={machine.name}>
        {machine.name}: token valid until {new Date(machine.expiresAt).toLocaleString()}
      </div>))}
  </div>;
}
