"use client";

import { ThemeProvider } from "next-themes";
import { StarIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
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
    if (success && operation === "dashboard:sendChat") {
      try {
        const stored = Number(localStorage.getItem("perry.starPrompts") ?? 0);
        const count = (Number.isSafeInteger(stored) && stored >= 0 ? stored : 0) + 1;
        localStorage.setItem("perry.starPrompts", String(count));
        // Not in the desktop pet: his window lets clicks through everywhere but him, so its button could not be pressed.
        if (!("perryPet" in window) && ([5, 50, 250].includes(count) || count % 500 === 0)) toast("Enjoying Perry?", {
          id: "perry-github-star",
          description: "A star on GitHub helps others find us.",
          icon: <StarIcon className="size-4" aria-hidden />,
          duration: 8000,
          action: { label: "Star on GitHub", onClick: () => { window.open("https://github.com/TheM1N9/perry", "_blank", "noopener,noreferrer"); } },
        });
      } catch {}
    }
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
