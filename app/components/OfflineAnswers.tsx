"use client";

import { useMutation, useQuery } from "@/client/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Notice, Section, Spinner, Status, errorText, fullDate, useToast } from "./ui";

/**
 * Whether a turn may be answered in Convex, on the ChatGPT subscription, when
 * no runner can take it. It needs the runner's ChatGPT token stored in the
 * deployment, so the page says so plainly and it stays off unless turned on.
 */
export function OfflineAnswers({ dashboardKey }: { dashboardKey: string }) {
  const status = useQuery(api.chatgpt.status, { key: dashboardKey });
  const setEnabled = useMutation(api.chatgpt.setEnabled);
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const toggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      await setEnabled({ key: dashboardKey, enabled });
      toast({ tone: "success", text: enabled ? "Perry will answer when your computer is offline." : "Turned off. Every stored token was deleted." });
    } catch (cause) {
      toast({ tone: "danger", text: `Couldn't change this setting: ${errorText(cause)}` });
    } finally {
      setSaving(false);
    }
  };

  const state = !status?.enabled ? <Status>Off</Status> : status.validUntil ? <Status tone="success">Ready</Status> : <Status tone="warning">Waiting for a token</Status>;

  return <Section title="When your computer is offline" actions={status && state}>
    <label className="toggle-row">
      <input type="checkbox" checked={status?.enabled ?? false} disabled={status === undefined || saving} onChange={(event) => void toggle(event.target.checked)} aria-describedby="offline-risk" />
      <span style={{ display: "grid", gap: 4 }}>
        <span style={{ fontWeight: 500, display: "inline-flex", gap: 8, alignItems: "center" }}>Answer without the computer {saving && <Spinner size={12} />}</span>
        <span className="item-text">Replies come from your ChatGPT subscription, with memory, earlier chats, connected accounts, jobs, tasks and page reading. There&apos;s no shell, files or images from your machine.</span>
      </span>
    </label>
    <div style={{ padding: "0 16px 16px" }}>
      <Notice tone="warning" title="What this stores">
        <span id="offline-risk">Each runner stores the ChatGPT access token its Codex holds in your Convex deployment until it expires. Anyone who can read that deployment&apos;s data could use your subscription until then. The refresh token stays on your machine, and turning this off deletes every stored token.</span>
      </Notice>
      {status?.enabled && (status.machines.length === 0
        ? <p className="field-hint">No valid token yet. A running runner signed in to ChatGPT shares one within a minute.</p>
        : <dl className="kv">{status.machines.map((machine) => <div key={machine.name} style={{ display: "contents" }}><dt>{machine.name}</dt><dd>Token valid until {fullDate(machine.expiresAt)}</dd></div>)}</dl>)}
    </div>
  </Section>;
}
