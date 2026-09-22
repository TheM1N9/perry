"use client";

import { useQuery } from "convex/react";
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
      <span className={status.telegramClaimed ? undefined : "bad"}>
        telegram {status.telegramClaimed ? "claimed" : "unclaimed"}
      </span>
      {" · "}
      <span className={status.gatewayConfigured ? undefined : "bad"}>
        gateway {status.gatewayConfigured ? "ready" : "missing key"}
      </span>
    </div>
  );
}

function Gate({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");

  return (
    <div className="gate">
      <h1 className="title">Perry</h1>
      <p className="hint" style={{ marginTop: 8 }}>
        This dashboard is behind a single key, held on the deployment as
        DASHBOARD_KEY. Set one if you have not:
      </p>
      <pre
        className="panel"
        style={{ fontSize: 12, color: "var(--dim)", margin: "0 0 16px" }}
      >
        npx convex env set DASHBOARD_KEY &lt;long random string&gt;
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

export default function Home() {
  const [dashboardKey, setDashboardKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<TabId>("chat");

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
      <div className="shell">
        <div className="topbar">
          <h1 className="title">Perry</h1>
          <button className="ghost" onClick={forget}>
            Lock
          </button>
        </div>
        <StatusLine dashboardKey={dashboardKey} />

        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "chat" && <Chat dashboardKey={dashboardKey} />}
        {tab === "memory" && <Memories dashboardKey={dashboardKey} />}
        {tab === "settings" && <Settings dashboardKey={dashboardKey} />}
        {tab === "activity" && <Activity dashboardKey={dashboardKey} />}
      </div>
    </ErrorBoundary>
  );
}
