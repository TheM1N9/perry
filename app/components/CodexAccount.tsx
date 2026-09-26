"use client";

import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { ActionButton, Command, CopyButton, Empty, Icon, Loading, Notice, Section, Spinner, Status, type Tone } from "./ui";

export function CodexAccount({ dashboardKey }: { dashboardKey: string }) {
  const accounts = useQuery(api.codex.accounts, { key: dashboardKey });
  const requestAuth = useMutation(api.codex.requestAuth);

  return <Section title="Codex account" count={accounts?.length}
    description="Perry thinks with your ChatGPT subscription, through Codex on a connected machine. Credentials stay on that machine; Perry keeps only the account status.">
    {accounts === undefined && <Loading rows={1} label="Checking connected machines…" />}
    {accounts?.length === 0 && <Empty icon="computer" title="No machine connected" action={<div style={{ width: "min(360px, 100%)" }}><Command>pnpm run connect</Command></div>}>
      Run this on the machine that will host Codex, then sign in here.
    </Empty>}
    {accounts?.map((account) => {
      const pending = account.requestStatus === "queued" || account.requestStatus === "running";
      const signedIn = account.authMode === "chatgpt";
      const unavailable = !account.online ? "The runner on this machine is offline. Start it with pnpm run connect." : !account.available ? "Codex isn't installed or can't start on this machine." : null;
      const state: { tone: Tone; label: string } = !account.online ? { tone: "neutral", label: "Offline" }
        : !account.available ? { tone: "danger", label: "Codex unavailable" }
        : signedIn ? { tone: "success", label: "Signed in" }
        : { tone: "warning", label: "Signed out" };
      return <div className="item" key={account.id}>
        <div className="item-main">
          <div className="item-title">{account.name}</div>
          <div className="item-meta">
            {signedIn ? <span>ChatGPT{account.planType ? ` ${account.planType.charAt(0).toUpperCase()}${account.planType.slice(1)}` : ""}</span>
              : account.authMode ? <span>Codex is using {account.authMode}</span> : <span>Not signed in</span>}
          </div>
          {unavailable && <p className="field-hint">{unavailable}</p>}
          {account.error && <Notice tone="danger">{account.error}</Notice>}
          {account.requestStatus === "queued" && <p className="field-hint" role="status"><Spinner size={11} /> Waiting for the runner to pick this up…</p>}
          {account.requestStatus === "running" && account.requestKind === "logout" && <p className="field-hint" role="status"><Spinner size={11} /> Signing out…</p>}
          {account.requestStatus === "running" && account.requestKind === "login" && !account.userCode && <p className="field-hint" role="status"><Spinner size={11} /> Starting sign-in…</p>}
          {account.requestStatus === "running" && account.userCode && account.verificationUrl && <div className="readonly-block" style={{ display: "grid", gap: 10, marginTop: 6 }} role="status">
            <strong style={{ color: "var(--text)", fontWeight: 500 }}>Finish signing in</strong>
            <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
              <li>Copy this code.</li>
              <li>Open the sign-in page and sign in to ChatGPT.</li>
              <li>Enter the code. This page updates by itself when you&apos;re done.</li>
            </ol>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="code-display" style={{ fontSize: 22, letterSpacing: "0.15em" }} translate="no">{account.userCode}</span>
              <CopyButton value={account.userCode} label="Copy code" className="btn btn-secondary btn-sm" />
              <a className="btn btn-primary btn-sm" href={account.verificationUrl} target="_blank" rel="noopener noreferrer">Open sign-in page<Icon name="external" size={13} /></a>
            </div>
          </div>}
          {account.requestStatus === "error" && account.requestError && <Notice tone="danger" title="Sign-in didn't finish">{account.requestError}. Try again; each code works only for a few minutes.</Notice>}
        </div>
        <div className="item-side">
          <Status tone={state.tone}>{state.label}</Status>
          {signedIn
            ? <ActionButton variant="ghost" className="btn-danger-ghost" disabled={Boolean(unavailable) || pending} action={() => requestAuth({ key: dashboardKey, runnerId: account.id, kind: "logout" })}
                confirm={{ title: `Sign out of Codex on ${account.name}?`, body: "Perry can't answer through this machine until you sign in again.", confirmLabel: "Sign out" }}>Sign out</ActionButton>
            : <ActionButton variant="primary" disabled={Boolean(unavailable) || pending} action={() => requestAuth({ key: dashboardKey, runnerId: account.id, kind: "login" })} pendingLabel="Starting…">Sign in with ChatGPT</ActionButton>}
        </div>
      </div>;
    })}
  </Section>;
}
