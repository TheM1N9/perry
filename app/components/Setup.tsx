"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ActionButton, CopyButton, Loading, Notice, Section, Status, useNow } from "./ui";

function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Pairing. Perry answers nobody until someone claims it, so on a fresh install
 * this is the only thing worth looking at.
 */
export function Setup({ dashboardKey }: { dashboardKey: string }) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const startPairing = useMutation(api.dashboard.startPairing);
  const unclaim = useMutation(api.dashboard.unclaim);
  const now = useNow(1000);

  if (!status) return <Section title="Pairing"><Loading rows={2} /></Section>;

  if (status.claimed) {
    return <Section title="Pairing" actions={<Status tone="success">Paired</Status>}>
      <div className="item">
        <div className="item-main">
          <div className="item-title">Perry works for {status.ownerName ?? "you"}</div>
          <div className="item-text">Messages from anyone else are ignored. Unpair to move Perry to a different Telegram account.</div>
        </div>
        <div className="item-side">
          <ActionButton variant="secondary" className="danger" action={() => unclaim({ key: dashboardKey })} success="Perry is unpaired. Generate a code to pair again."
            confirm={{ title: "Unpair Perry?", body: `Perry will stop answering ${status.ownerName ?? "you"} until someone pairs it again with a new code.`, confirmLabel: "Unpair" }}>
            Unpair
          </ActionButton>
        </div>
      </div>
    </Section>;
  }

  const remaining = status.pairingExpiresAt !== undefined ? status.pairingExpiresAt - now : undefined;
  const live = Boolean(status.pairingCode) && (remaining === undefined || remaining > 0);

  return <>
    {!status.telegramConfigured && <Notice tone="warning" title="Telegram isn't set up yet">
      Add a bot token on the Keys page first, or the code has nowhere to go.
    </Notice>}
    <Section title="Pair with Telegram" description="Send the code to your Perry bot. Whoever sends it first owns this installation." actions={<Status tone="warning">Not paired</Status>}>
      <div className="section-pad" style={{ display: "grid", gap: 14, justifyItems: "start" }}>
        {live ? <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="code-display" translate="no" aria-label={`Pairing code ${status.pairingCode!.split("").join(" ")}`}>{status.pairingCode}</span>
            <CopyButton value={status.pairingCode!} label="Copy code" className="btn btn-secondary btn-sm" />
          </div>
          {remaining !== undefined && <p className="field-hint nums">Expires in {countdown(remaining)}</p>}
        </> : <p className="field-hint">{status.pairingCode ? "That code expired. Generate a new one." : "Generate a code, then send it to your bot."}</p>}
        <ActionButton variant={live ? "secondary" : "primary"} size="md" icon="refresh" action={() => startPairing({ key: dashboardKey })} pendingLabel="Generating…" success={live ? "New code ready. The old one no longer works." : undefined}>
          {live ? "New code" : "Generate code"}
        </ActionButton>
      </div>
    </Section>
  </>;
}
