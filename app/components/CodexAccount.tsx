"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function CodexAccount({ dashboardKey }: { dashboardKey: string }) {
  const accounts = useQuery(api.codex.accounts, { key: dashboardKey });
  const engine = useQuery(api.codex.engine, { key: dashboardKey });
  const requestAuth = useMutation(api.codex.requestAuth);
  const setEngine = useMutation(api.codex.setEngine);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = async (runnerId: Id<"runners">, kind: "login" | "logout") => {
    setBusy(runnerId);
    setError(null);
    try {
      await requestAuth({ key: dashboardKey, runnerId, kind });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return <div className="panel">
    <div className="row" style={{ justifyContent: "space-between" }}>
      <h3>Codex subscription</h3>
      <span className="badge">local sign-in</span>
    </div>
    <p className="hint">
      Sign in to Codex on a connected machine using your ChatGPT account. The Codex CLI keeps credentials on that machine; Assistant stores only account status and the temporary device code.
    </p>
    <div style={{ display: "grid", gap: 8, margin: "14px 0" }}>
      <label className="item" style={{ display: "flex", gap: 10, cursor: "pointer" }}>
        <input type="radio" name="chat-engine" style={{ width: "auto" }} checked={engine === "codex"} onChange={() => void setEngine({ key: dashboardKey, engine: "codex" })} />
        <span><strong>Codex primary</strong><span className="item-meta" style={{ display: "block" }}>Use your ChatGPT subscription. If Codex is unavailable or a turn fails, retry through the configured gateway model.</span></span>
      </label>
      <label className="item" style={{ display: "flex", gap: 10, cursor: "pointer" }}>
        <input type="radio" name="chat-engine" style={{ width: "auto" }} checked={engine === "gateway"} onChange={() => void setEngine({ key: dashboardKey, engine: "gateway" })} />
        <span><strong>Gateway only</strong><span className="item-meta" style={{ display: "block" }}>Use the configured model for every turn.</span></span>
      </label>
    </div>
    {error && <p className="hint" role="alert" style={{ color: "var(--warn)" }}>{error}</p>}
    {accounts === undefined && <p className="hint">Checking connected machines…</p>}
    {accounts?.length === 0 && <p className="hint">Run <code>pnpm run connect</code> on the machine that will host Codex.</p>}
    {accounts?.map((account) => {
      const pending = account.requestStatus === "queued" || account.requestStatus === "running";
      const signedIn = account.authMode === "chatgpt";
      return <div className="item" key={account.id}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
          <div>
            <strong>{account.name}</strong>
            <div className="item-meta">
              {!account.online ? "Runner offline" : !account.available ? "Codex unavailable" : signedIn ? `ChatGPT${account.planType ? ` · ${account.planType}` : ""}` : account.authMode ? `Codex uses ${account.authMode}` : "Signed out"}
            </div>
          </div>
          <span className={signedIn && account.online ? "badge on" : "badge"}>{signedIn && account.online ? "connected" : "inactive"}</span>
        </div>
        {account.error && <p className="hint" role="alert">{account.error}</p>}
        {account.requestStatus === "queued" && <p className="hint">Waiting for the runner…</p>}
        {account.requestStatus === "running" && account.requestKind === "logout" && <p className="hint">Signing out…</p>}
        {account.requestStatus === "running" && account.requestKind === "login" && !account.userCode && <p className="hint">Starting Codex sign-in…</p>}
        {account.requestStatus === "running" && account.userCode && account.verificationUrl && <div style={{ margin: "14px 0" }}>
          <p className="hint">Open the link, sign in to ChatGPT, then enter this code:</p>
          <a href={account.verificationUrl} target="_blank" rel="noopener noreferrer">Open Codex sign-in ↗</a>
          <div style={{ fontSize: 25, fontWeight: 700, letterSpacing: "0.12em", marginTop: 10, userSelect: "all" }}>{account.userCode}</div>
        </div>}
        {account.requestStatus === "error" && account.requestError && <p className="hint" role="alert" style={{ color: "var(--warn)" }}>{account.requestError}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          {signedIn ? <button className="ghost danger" disabled={!account.online || !account.available || pending || busy === account.id} onClick={() => void request(account.id, "logout")}>Sign out of Codex</button> : <button className="primary" disabled={!account.online || !account.available || pending || busy === account.id} onClick={() => void request(account.id, "login")}>Connect ChatGPT account</button>}
        </div>
      </div>;
    })}
    <p className="hint" style={{ marginTop: 12 }}>Codex uses this runner&apos;s workspace and approval policy. Gateway backup retains Assistant&apos;s configured tools.</p>
  </div>;
}
