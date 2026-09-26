"use client";

import { createContext, useContext } from "react";

/** The dashboard key this browser unlocked with, and how to lock again. */
export type Session = { dashboardKey: string; lock: () => void };

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession is used outside the unlocked dashboard.");
  return session;
}

/** Shorthand: most calls only need the key. */
export const useDashboardKey = () => useSession().dashboardKey;

export const KEY_STORAGE = "perry.dashboard.key";
export const ACTIVE_CHAT = "perry.activeChat";
