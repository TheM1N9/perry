"use client";

import { useEffect, useState } from "react";
import { z } from "zod";

/**
 * What the chat panel keeps in this browser, in a few capped localStorage keys
 * rather than one key per chat: each holds the newest few dozen entries and
 * drops the oldest, so a dashboard used for months does not pile them up.
 */

/** The panel's surfaces, each at most once in its tabs. */
export const SURFACES = ["details", "files", "browser", "agents", "work"] as const;
export type SurfaceId = (typeof SURFACES)[number];

const CAP = 50;

const entries = z.record(z.string(), z.object({ at: z.number(), value: z.unknown() }));

function readMap(storage: string) {
  try { return entries.parse(JSON.parse(localStorage.getItem(storage) ?? "{}")); } catch { return {}; }
}

/** One entry of a capped key, or the schema's defaults. */
export function readCapped<T>(storage: string, id: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(readMap(storage)[id]?.value ?? {});
  return parsed.success ? parsed.data : schema.parse({});
}

/** Write one entry, keeping only the newest `CAP`. */
export function writeCapped(storage: string, id: string, value: unknown) {
  const map = readMap(storage);
  map[id] = { at: Date.now(), value };
  const kept = Object.entries(map).sort(([, a], [, b]) => b.at - a.at).slice(0, CAP);
  try { localStorage.setItem(storage, JSON.stringify(Object.fromEntries(kept))); } catch {}
}

/** The keys the floating workspace kept one of per chat, or per chat and scope; read once into nothing, and gone. */
let swept = false;
function sweepLegacy() {
  if (swept) return;
  swept = true;
  try {
    const old: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith("perry.workspace.")) old.push(key);
    }
    for (const key of old) localStorage.removeItem(key);
  } catch {}
}

/**
 * A chat's panel: open or not, its tabs and the one shown, its width when
 * docked (unset: the default), whether it is widened, and whose files it shows.
 */
const panelSchema = z.object({
  open: z.boolean().default(false),
  tabs: z.array(z.enum(SURFACES)).default([]),
  active: z.enum(SURFACES).nullable().default(null),
  width: z.number().optional(),
  wide: z.boolean().optional(),
  scope: z.enum(["chat", "project"]).default("chat"),
});
export type PanelState = z.infer<typeof panelSchema>;
const PANEL = "perry.panel";

/** Read in the browser only; the dashboard draws nothing before it has its key (shell.tsx), so there is no server render to match. */
const readPanel = (chatKey: string) => typeof window === "undefined" ? panelSchema.parse({}) : readCapped(PANEL, chatKey, panelSchema);

/**
 * The panel's state for one chat (or "new"), saved with each change. Read as the chat changes, in the same
 * render, so going from one chat with the panel open to another does not close it for a frame.
 */
export function usePanelState(chatKey: string) {
  const [state, setState] = useState(() => ({ key: chatKey, value: readPanel(chatKey) }));
  if (state.key !== chatKey) setState({ key: chatKey, value: readPanel(chatKey) });
  useEffect(sweepLegacy, []);
  const value = state.key === chatKey ? state.value : readPanel(chatKey);
  const update = (change: (current: PanelState) => PanelState) => setState((was) => {
    const next = change(was.key === chatKey ? was.value : readPanel(chatKey));
    writeCapped(PANEL, chatKey, next);
    return { key: chatKey, value: next };
  });
  return [value, update] as const;
}

/** How Files is shown for one chat or project: tree or gallery, the file open in it, and its open groups. */
export const filePrefs = z.object({
  mode: z.enum(["tree", "gallery"]).default("tree"), selected: z.string().optional(),
  expanded: z.record(z.string(), z.boolean()).default({}),
});
export type FilePrefs = z.infer<typeof filePrefs>;
export const FILES = "perry.files";

export function useFilePrefs(id: string) {
  const [state, setState] = useState(() => ({ id, value: readCapped(FILES, id, filePrefs) }));
  if (state.id !== id) setState({ id, value: readCapped(FILES, id, filePrefs) });
  const value = state.id === id ? state.value : readCapped(FILES, id, filePrefs);
  const update = (patch: Partial<FilePrefs>) => {
    const next = { ...value, ...patch };
    setState({ id, value: next });
    writeCapped(FILES, id, next);
  };
  return [value, update] as const;
}
