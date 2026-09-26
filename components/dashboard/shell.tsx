"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { KEY_STORAGE, SessionContext, useSession, type Session } from "@/lib/session";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette, PaletteContext } from "./command-palette";
import { Gate } from "./gate";
import { PageErrorBoundary } from "./page-error";

/**
 * Every page but the gate: the key this browser keeps, the sidebar, and ⌘K.
 * The key is read after mount, since only the browser has it, so the first
 * paint is blank rather than briefly the wrong screen.
 */
export function DashboardShell({ children }: { children: ReactNode }) {
  const [dashboardKey, setDashboardKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // `perry open` passes the key in the fragment, which never reaches a server; it is kept and taken out of the address.
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("key");
    if (fromLink) {
      window.localStorage.setItem(KEY_STORAGE, fromLink);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    setDashboardKey(window.localStorage.getItem(KEY_STORAGE));
    setReady(true);
  }, []);

  // Local chat media is served by this app's own server, which reads the key
  // from a cookie scoped to /api/media so it never appears in a media URL.
  useEffect(() => {
    if (!ready) return;
    document.cookie = dashboardKey
      ? `perry_media=${encodeURIComponent(dashboardKey)}; Path=/api/media; SameSite=Strict; Max-Age=31536000`
      : "perry_media=; Path=/api/media; SameSite=Strict; Max-Age=0";
  }, [ready, dashboardKey]);

  const lock = useCallback(() => {
    window.localStorage.removeItem(KEY_STORAGE);
    setDashboardKey(null);
  }, []);
  const session = useMemo<Session | null>(() => dashboardKey ? { dashboardKey, lock } : null, [dashboardKey, lock]);

  if (!ready) return null;
  if (!session) {
    return <Gate onUnlock={(key) => { window.localStorage.setItem(KEY_STORAGE, key); setDashboardKey(key); }} />;
  }
  return (
    <SessionContext.Provider value={session}>
      <Unlocked>{children}</Unlocked>
    </SessionContext.Provider>
  );
}

function Unlocked({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Scheduled jobs run in the owner's timezone, which only the browser knows.
  const setTimezone = useMutation(api.jobs.setTimezone);
  const { dashboardKey, lock } = useSession();
  useEffect(() => {
    void setTimezone({ key: dashboardKey, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
  }, [dashboardKey, setTimezone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
        // ⌘⇧O, as in other chat apps; ⌘N belongs to the browser.
        event.preventDefault();
        router.push("/chat");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const palette = useMemo(() => ({ open: () => setPaletteOpen(true) }), []);

  // The welcome page is full screen, before anything else.
  if (pathname === "/welcome") return <PageErrorBoundary onLock={lock}>{children}</PageErrorBoundary>;

  return (
    <PaletteContext.Provider value={palette}>
      <SidebarProvider>
        <a href="#content" className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring">
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <PageErrorBoundary onLock={lock}>{children}</PageErrorBoundary>
        </SidebarInset>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </SidebarProvider>
    </PaletteContext.Provider>
  );
}
