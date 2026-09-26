"use client";

import type { ReactNode } from "react";
import { BackendClient } from "@/client/backend";
import { BackendProvider } from "@/client/react";
import { ToastProvider } from "./components/ui";

/** Perry's backend is this same server, under /api/backend. */
const backend = new BackendClient();

export function Providers({ children }: { children: ReactNode }) {
  return <BackendProvider client={backend}><ToastProvider>{children}</ToastProvider></BackendProvider>;
}
