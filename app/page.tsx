"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Activity } from "./components/Activity";
import { Chat } from "./components/Chat";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Memories } from "./components/Memories";
import { Settings } from "./components/Settings";

const STORAGE_KEY = "perry.dashboard.key";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "memory", label: "Memory" },
  { id: "settings", label: "Settings" },
  { id: "activity", label: "Activity" },
  { id: "setup", label: "Setup" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function StatusLine({ dashboardKey }: { dashboardKey: string }) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  if (!status) return <div className="statusline">&nbsp;</div>;

  return (
    <div className="statusline">
      {status.memories} memories
      {" · "}
      {status.conversations.length} conversation
      {status.conversations.length === 1 ? "" : "s"}
      {" · "}
      <span className={status.claimed ? undefined : "bad"}>
        {status.claimed
          ? `paired${status.ownerName ? ` with ${status.ownerName}` : ""}`
          : "unpaired"}
      </span>
      {" · "}
      {status.gateway} gateway
    </div>
  );
}

/**
 * Shown until someone claims this install. Perry answers nobody before that,
 * so this is the only thing worth looking at on a fresh deployment.
 */
function Pairing({ dashboardKey }: { dashboardKey: string }) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const startPairing = useMutation(api.dashboard.startPairing);
  const unclaim = useMutation(api.dashboard.unclaim);

  if (!status) return null;

  if (status.claimed) {
    return (
      <div className="panel">
        <h3>Paired</h3>
        <p className="hint">
          This Perry belongs to{" "}
          {status.ownerName ? <strong>{status.ownerName}</strong> : "you"}. Every
          other sender is ignored.
        </p>
        <button className="ghost danger" onClick={() => void unclaim({ key: dashboardKey })}>
          Unpair
        </button>
      </div>
    );
  }

  const expired =
    status.pairingExpiresAt !== undefined && Date.now() > status.pairingExpiresAt;

  return (
    <div className="panel">
      <h3>Not paired yet</h3>
      <p className="hint">
        Message your bot with this code to claim Perry. Whoever sends it first
        owns this install.
      </p>
      {status.pairingCode && !expired ? (
        <div
          style={{
            fontSize: 32,
            letterSpacing: "0.3em",
            color: "var(--accent)",
            padding: "12px 0 18px",
          }}
        >
          {status.pairingCode}
        </div>
      ) : (
        <p className="hint">
          {expired ? "That code expired." : "No code yet."}
        </p>
      )}
      <button className="primary" onClick={() => void startPairing({ key: dashboardKey })}>
        {status.pairingCode && !expired ? "New code" : "Generate code"}
      </button>
    </div>
  );
}

function Gate({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");

  return (
    <div className="gate">
      <h1 className="title">Perry</h1>
      <p className="hint" style={{ marginTop: 8 }}>
        This install is yours alone, and the dashboard is behind one key.
        <code> npm run setup </code> prints it, and it is saved in .env.local.
      </p>
      <pre
        className="panel"
        style={{ fontSize: 12, color: "var(--dim)", margin: "0 0 16px" }}
      >
        npm run setup
      </pre>
      <div className="composer">
        <input
          type="password"
          value={value}
          placeholder="Dashboard key"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
          }}
        />
        <button
          className="primary"
          disabled={value.trim().length === 0}
          onClick={() => onSubmit(value.trim())}
        >
          Open
        </button>
      </div>
    </div>
  );
}

/** Lands on Setup when nobody has claimed this install yet. */
function Shell({
  dashboardKey,
  onLock,
}: {
  dashboardKey: string;
  onLock: () => void;
}) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const [tab, setTab] = useState<TabId | null>(null);

  useEffect(() => {
    if (status && tab === null) setTab(status.claimed ? "chat" : "setup");
  }, [status, tab]);

  const active = tab ?? "chat";

  return (
    <div className="shell">
      <div className="topbar">
        <h1 className="title">Perry</h1>
        <button className="ghost" onClick={onLock}>
          Lock
        </button>
      </div>
      <StatusLine dashboardKey={dashboardKey} />

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === active ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === "chat" && <Chat dashboardKey={dashboardKey} />}
      {active === "memory" && <Memories dashboardKey={dashboardKey} />}
      {active === "settings" && <Settings dashboardKey={dashboardKey} />}
      {active === "activity" && <Activity dashboardKey={dashboardKey} />}
      {active === "setup" && <Pairing dashboardKey={dashboardKey} />}
    </div>
  );
}

export default function Home() {
  const [dashboardKey, setDashboardKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // localStorage is only available after mount, so the first paint is blank
  // rather than briefly wrong.
  useEffect(() => {
    setDashboardKey(window.localStorage.getItem(STORAGE_KEY));
    setReady(true);
  }, []);

  const remember = (key: string) => {
    window.localStorage.setItem(STORAGE_KEY, key);
    setDashboardKey(key);
  };

  const forget = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setDashboardKey(null);
  };

  if (!ready) return null;
  if (!dashboardKey) return <Gate onSubmit={remember} />;

  return (
    <ErrorBoundary onReset={forget}>
      <Shell dashboardKey={dashboardKey} onLock={forget} />
    </ErrorBoundary>
  );
}
