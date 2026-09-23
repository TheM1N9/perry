"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Activity } from "./components/Activity";
import { Chat } from "./components/Chat";
import { Computer } from "./components/Computer";
import { Connectors } from "./components/Connectors";
import { Keys } from "./components/Keys";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Memories } from "./components/Memories";
import { Settings } from "./components/Settings";
import { Work } from "./components/Work";

const STORAGE_KEY = "perry.dashboard.key";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "work", label: "Work" },
  { id: "computer", label: "Computer" },
  { id: "connectors", label: "Connectors" },
  { id: "memory", label: "Memory" },
  { id: "settings", label: "Settings" },
  { id: "activity", label: "Activity" },
  { id: "keys", label: "Keys" },
  { id: "setup", label: "Setup" },
] as const;

const SECTION_DESCRIPTIONS: Record<string, string> = {
  work: "Tasks, goals, and monitors Assistant is working on.",
  computer: "Your connected computer and local runner.",
  connectors: "Accounts and services Assistant can use with your permission.",
  memory: "Facts Assistant has saved for future conversations.",
  settings: "Configure the assistant, memory, and fallback engine.",
  activity: "A record of recent turns, tools, and errors.",
  keys: "Manage the credentials this installation uses.",
  setup: "Pair this installation with your chat account.",
};

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
      {status.engine === "codex" ? "codex · gateway backup" : `${status.gateway} gateway`}
    </div>
  );
}

/**
 * Shown until someone claims this install. Assistant answers nobody before that,
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
          This Assistant belongs to{" "}
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
        Message your bot with this code to claim Assistant. Whoever sends it first
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
      <h1 className="title">Assistant</h1>
      <p className="hint" style={{ marginTop: 8 }}>
        This install is yours alone, and the dashboard is behind one key.
        <code> pnpm run setup </code> prints it, and it is saved in .env.local.
      </p>
      <pre
        className="panel"
        style={{ fontSize: 12, color: "var(--dim)", margin: "0 0 16px" }}
      >
        pnpm run setup
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
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (status && tab === null) setTab(window.location.pathname.startsWith("/chat") ? "chat" : status.claimed ? "chat" : "setup");
  }, [status, tab]);

  useEffect(() => {
    const onBack = () => setTab(window.location.pathname.startsWith("/chat") ? "chat" : "setup");
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, []);

  const active = tab ?? (status?.claimed ? "chat" : "setup");
  const openChat = (id: Id<"conversations">) => {
    window.localStorage.setItem("perry.activeChat", id);
    window.history.pushState(null, "", `/chat/${encodeURIComponent(id)}`);
    setTab("chat");
  };

  if (active === "chat") {
    return <Chat dashboardKey={dashboardKey} onNavigate={(next) => { window.history.pushState(null, "", "/"); setTab(next); }} onLock={onLock} />;
  }

  return <div className="chat-workspace dashboard-workspace">
    {menuOpen && <button className="chat-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`chat-sidebar dashboard-sidebar ${menuOpen ? "open" : ""}`}>
      <div className="chat-brand"><span className="chat-brand-mark">A</span><span>Assistant</span><span className="chat-brand-sub">your space</span></div>
      <div className="dashboard-sidebar-heading">WORKSPACE</div>
      <nav className="dashboard-nav" aria-label="Workspace navigation">
        {TABS.map((item) => <button key={item.id} className={item.id === active ? "active" : ""} onClick={() => { setTab(item.id); setMenuOpen(false); }}>
          <span className="dashboard-nav-dot" />{item.label}<span className="dashboard-nav-arrow">›</span>
        </button>)}
      </nav>
      <div className="dashboard-sidebar-spacer" />
      <div className="dashboard-sidebar-footer"><StatusLine dashboardKey={dashboardKey} /><button onClick={onLock}>Lock dashboard</button></div>
    </aside>
    <main className="chat-main">
      <header className="chat-header dashboard-header">
        <div className="chat-header-left"><button className="chat-mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>☰</button><span>Workspace <span className="dashboard-header-slash">/</span> {TABS.find((item) => item.id === active)?.label}</span></div>
        <button className="dashboard-back-chat" onClick={() => setTab("chat")}>Open chat <span>↗</span></button>
      </header>
      <div className="dashboard-scroll"><div className="dashboard-content">
        <div className="dashboard-intro"><div className="chat-eyebrow">PERRY WORKSPACE</div><h1>{TABS.find((item) => item.id === active)?.label}</h1><p>{SECTION_DESCRIPTIONS[active]}</p></div>
        {active === "work" && <Work dashboardKey={dashboardKey} />}
        {active === "computer" && <Computer dashboardKey={dashboardKey} />}
        {active === "connectors" && <Connectors dashboardKey={dashboardKey} />}
        {active === "memory" && <Memories dashboardKey={dashboardKey} />}
        {active === "settings" && <Settings dashboardKey={dashboardKey} />}
        {active === "activity" && <Activity dashboardKey={dashboardKey} onOpenChat={openChat} />}
        {active === "keys" && <Keys dashboardKey={dashboardKey} />}
        {active === "setup" && <Pairing dashboardKey={dashboardKey} />}
      </div></div>
    </main>
  </div>;
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
