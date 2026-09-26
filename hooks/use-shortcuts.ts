"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { describe, resolve, type Shortcuts } from "@/convex/lib/shortcuts";
import { useDashboardKey } from "@/lib/session";

/** Whether this computer is a Mac, where ⌘ stands in for Ctrl. Known only in the browser, so false on the first paint. */
export function useIsMac() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return mac;
}

/**
 * The keyboard shortcuts in force (Settings → Keyboard shortcuts), the
 * defaults until they load, and how each reads on this computer.
 */
export function useShortcuts(): { shortcuts: Shortcuts; mac: boolean; label: (id: keyof Shortcuts) => string } {
  const key = useDashboardKey();
  const saved = useQuery(api.dashboard.getShortcuts, { key });
  const mac = useIsMac();
  const shortcuts = saved?.shortcuts ?? resolve(undefined);
  return { shortcuts, mac, label: (id) => describe(shortcuts[id], mac) };
}
