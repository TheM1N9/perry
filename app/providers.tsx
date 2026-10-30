"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { BackendClient } from "@/client/backend";
import { BackendProvider } from "@/client/react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { trackDashboardEvent } from "@/lib/analytics";

/** Perry's backend is this same server, under /api/backend. */
const backend = new BackendClient();
if (typeof window !== "undefined") {
  backend.onOperation = (operation, kind, success, durationMs) => {
    if (operation === "jobs:setTimezone") return;
    trackDashboardEvent("Feature used", { operation, kind, success, duration_ms: durationMs });
  };
  backend.onConnection = (connected) => trackDashboardEvent("Backend connection", { connected });
  window.addEventListener("pagehide", () => backend.suspend());
  window.addEventListener("pageshow", (event) => { if (event.persisted) backend.resume(); });
}

/** The theme follows the system until the owner picks one, which this browser remembers. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="perry.theme">
      <BackendProvider client={backend}>
        <TooltipProvider delay={400}>
          {children}
          <Toaster position="top-right" closeButton />
        </TooltipProvider>
      </BackendProvider>
    </ThemeProvider>
  );
}
