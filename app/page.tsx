"use client";

import { useConvex, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "@/convex/_generated/api";
import { Activity } from "./components/Activity";
import { Chat } from "./components/Chat";
import { Computer } from "./components/Computer";
import { Connectors } from "./components/Connectors";
import { Keys } from "./components/Keys";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Memories } from "./components/Memories";
import { Profile } from "./components/Profile";
import { Settings } from "./components/Settings";
import { Setup } from "./components/Setup";
import { SECTIONS, Sidebar, linkClick, sectionPath, underProfile, type NavigationState, type SectionId } from "./components/Sidebar";
import { Tasks } from "./components/Tasks";
import { Command, Icon, SecretInput, Spinner, errorText } from "./components/ui";

const STORAGE_KEY = "perry.dashboard.key";

/** The section a path names, or null for the root, which depends on whether Perry is paired. */
function sectionFrom(pathname: string): SectionId | null {
  const first = pathname.split("/")[1] ?? "";
  if (!first) return null;
  return SECTIONS.find((section) => section.id === first)?.id ?? "chat";
}

function Gate({ onSubmit }: { onSubmit: (key: string) => void }) {
  const convex = useConvex();
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key) { setError("Paste your dashboard key to continue."); return; }
    setChecking(true);
    setError("");
    try {
      await convex.query(api.dashboard.getStatus, { key });
      onSubmit(key);
    } catch (cause) {
      const message = errorText(cause);
      setError(/dashboard key|DASHBOARD_KEY/i.test(message)
        ? "That key doesn't match this deployment. Copy it again from .env.local and try once more."
        : `Perry's server didn't answer: ${message}`);
    } finally {
      setChecking(false);
    }
  };

  return <main className="gate-page">
    <div className="gate">
      <span className="brand-mark" aria-hidden="true">P</span>
      <h1>Open Perry</h1>
      <p>Enter the dashboard key for this installation. It stays in this browser.</p>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="dashboard-key">Dashboard key</label>
          <SecretInput id="dashboard-key" name="dashboard-key" value={value} onChange={(next) => { setValue(next); setError(""); }} placeholder="Paste your key…" autoFocus invalid={Boolean(error)} describedBy={error ? "dashboard-key-error" : undefined} />
          {error && <p className="field-error" id="dashboard-key-error" role="alert">{error}</p>}
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={checking} aria-busy={checking || undefined}>
          {checking && <Spinner />}{checking ? "Checking…" : "Continue"}
        </button>
      </form>
      <div className="gate-help">
        <p>Don&apos;t have it? Setup prints the key and saves it as <code className="inline">DASHBOARD_KEY</code> in <code className="inline">.env.local</code>.</p>
        <Command>pnpm run setup</Command>
      </div>
    </div>
  </main>;
}

function Shell({ dashboardKey, onLock }: { dashboardKey: string; onLock: () => void }) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const [path, setPath] = useState(() => window.location.pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // `state` rides on the history entry, so the chat page can tell "New chat" from "back to my chats".
  const navigate = useCallback((section: SectionId, state?: NavigationState) => {
    const chatId = window.localStorage.getItem("perry.activeChat");
    const to = section === "chat" ? (chatId ? `/chat/${encodeURIComponent(chatId)}` : "/chat") : sectionPath(section);
    if (window.location.pathname !== to) window.history.pushState(state ?? null, "", to);
    setPath(to);
    document.querySelector<HTMLElement>(".workspace-scroll")?.scrollTo({ top: 0 });
  }, []);

  // The root opens Chat once Perry is paired, and Setup until then.
  const named = sectionFrom(path);
  const active: SectionId | null = named ?? (status ? (status.claimed ? "chat" : "setup") : null);
  useEffect(() => {
    if (!named && active) {
      const to = active === "chat" ? "/chat" : sectionPath(active);
      window.history.replaceState(null, "", to);
      setPath(to);
    }
  }, [named, active]);

  useEffect(() => {
    const section = SECTIONS.find((item) => item.id === active);
    document.title = section && section.id !== "chat" ? `${section.label} · Perry` : "Perry";
  }, [active]);

  if (!active) return null;

  if (active === "chat") {
    return <Chat dashboardKey={dashboardKey} onNavigate={navigate} onLock={onLock} />;
  }

  const section = SECTIONS.find((item) => item.id === active)!;
  const openChat = (id: string) => {
    window.localStorage.setItem("perry.activeChat", id);
    navigate("chat");
  };

  return <div className="app">
    <a className="skip-link" href="#content">Skip to content</a>
    <Sidebar dashboardKey={dashboardKey} current={active} onNavigate={navigate} onLock={onLock} open={menuOpen} onClose={closeMenu} />
    <main className="main" inert={menuOpen || undefined}>
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <span>Perry</span><span className="sep" aria-hidden="true">/</span>
            {underProfile(active) && <><a href={sectionPath("profile")} onClick={(event) => linkClick(event, () => navigate("profile"))}>Profile</a><span className="sep" aria-hidden="true">/</span></>}
            <strong aria-current="page">{section.label}</strong>
          </nav>
        </div>
      </header>
      <div className="workspace-scroll">
        <div className="workspace" id="content" tabIndex={-1}>
          <div className="page-head">
            <h1>{section.label}</h1>
            <p>{section.description}</p>
          </div>
          <ErrorBoundary key={active} inline onReset={onLock}>
            {active === "tasks" && <Tasks dashboardKey={dashboardKey} />}
            {active === "computer" && <Computer dashboardKey={dashboardKey} />}
            {active === "connectors" && <Connectors dashboardKey={dashboardKey} />}
            {active === "memory" && <Memories dashboardKey={dashboardKey} />}
            {active === "settings" && <Settings dashboardKey={dashboardKey} />}
            {active === "activity" && <Activity dashboardKey={dashboardKey} onOpenChat={openChat} />}
            {active === "keys" && <Keys dashboardKey={dashboardKey} />}
            {active === "setup" && <Setup dashboardKey={dashboardKey} />}
            {active === "profile" && <Profile dashboardKey={dashboardKey} onNavigate={navigate} />}
          </ErrorBoundary>
        </div>
      </div>
    </main>
  </div>;
}

export default function Home() {
  const [dashboardKey, setDashboardKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // localStorage is only available after mount, so the first paint is blank
  // rather than briefly wrong.
  useEffect(() => {
    // `perry open` passes the key in the fragment, which never reaches a server; it is kept and taken out of the address.
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("key");
    if (fromLink) {
      window.localStorage.setItem(STORAGE_KEY, fromLink);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    setDashboardKey(window.localStorage.getItem(STORAGE_KEY));
    setReady(true);
  }, []);

  // Scheduled jobs run in the owner's timezone, which only the browser knows.
  const setTimezone = useMutation(api.jobs.setTimezone);
  useEffect(() => {
    if (dashboardKey) void setTimezone({ key: dashboardKey, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
  }, [dashboardKey, setTimezone]);

  // Local chat media is served by this app's own server, which reads the key
  // from a cookie scoped to /api/media so it never appears in a media URL.
  useEffect(() => {
    document.cookie = dashboardKey
      ? `perry_media=${encodeURIComponent(dashboardKey)}; Path=/api/media; SameSite=Strict; Max-Age=31536000`
      : "perry_media=; Path=/api/media; SameSite=Strict; Max-Age=0";
  }, [dashboardKey]);

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

