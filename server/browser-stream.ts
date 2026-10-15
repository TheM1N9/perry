import * as browser from "../convex/lib/browser";
import type { BrowserIdentity, BrowserState } from "../lib/browser-protocol";
import { browserStatus } from "./browser-host";

/**
 * The owner's live view of a chat's browser, pushed as it changes: the page's
 * frames from Chrome's own screencast (each sent as soon as Chrome draws it,
 * rather than a screenshot asked for every second), and the browser's state
 * whenever its page, tab or controller moves. One screencast a chat, shared by
 * every panel watching it; it stops when the last one goes.
 *
 * Written as NDJSON lines: {"state": BrowserState} or {"frame": {image, identity, capturedAt}}.
 */

type Frame = { image: string; identity: BrowserIdentity; capturedAt: number };
type Watcher = { frame: (frame: Frame) => void; width: number };
type Cast = { watchers: Set<Watcher>; tabId: string | null; width: number; stop: (() => void) | null; seen: string };
const casts = ((globalThis as typeof globalThis & { __perryScreencasts?: Map<string, Cast> }).__perryScreencasts ??= new Map());

/** The frame's width: the widest panel watching, in device pixels, never more than the page itself. */
const widthOf = (cast: Cast) => Math.min(1280, Math.max(320, ...[...cast.watchers].map((watcher) => watcher.width)));

/** Starts, moves or stops the chat's screencast to follow its open tab and who is watching. */
async function follow(scope: string) {
  const cast = casts.get(scope);
  if (!cast) return;
  const current = browser.browserControl(scope).current?.targetId ?? null;
  const width = widthOf(cast);
  // Chrome sends a frame when the page is drawn again, and once on starting: a page that moved on (taken over, navigated)
  // but sits still would otherwise show no frame for its new identity, so the screencast starts over.
  const seen = JSON.stringify(browser.identity(scope));
  if (cast.watchers.size && current === cast.tabId && width === cast.width && seen === cast.seen && cast.stop) return;
  cast.seen = seen;
  cast.stop?.();
  cast.stop = null;
  cast.tabId = null;
  if (!cast.watchers.size) { casts.delete(scope); return; }
  if (!current) return;
  await browser.withBrowserView(scope, async () => {
    const watched = browser.hostWatch((method, params) => {
      if (method !== "Page.screencastFrame") return;
      void watched?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      const identity = browser.identity(scope);
      // A frame from a tab no longer shown is dropped, never drawn as the new one.
      if (!identity || identity.tabId !== watched?.tabId) return;
      const frame = { image: String(params.data), identity, capturedAt: Date.now() };
      for (const watcher of cast.watchers) watcher.frame(frame);
    });
    if (!watched) return;
    cast.tabId = watched.tabId;
    cast.width = width;
    cast.stop = () => { watched.stop(); void watched.send("Page.stopScreencast").catch(() => {}); };
    await watched.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: width, maxHeight: Math.round(width * 900 / 1280), everyNthFrame: 1 });
  }).catch(() => { cast.stop?.(); cast.stop = null; cast.tabId = null; });
}

export function streamBrowser(scope: string, importEnabled: boolean, width: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: Watcher | undefined;
  const end = () => {
    if (timer) clearTimeout(timer);
    const cast = casts.get(scope);
    if (cast && watcher) { cast.watchers.delete(watcher); void follow(scope); }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: object) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)); } catch { end(); } };
      watcher = { width, frame: (frame) => write({ frame }) };
      const cast = casts.get(scope) ?? { watchers: new Set(), tabId: null, width: 0, stop: null, seen: "" };
      casts.set(scope, cast);
      cast.watchers.add(watcher);
      // A new panel needs a first frame now, not at the page's next change.
      cast.seen = "";
      let last = "";
      let lastFull = 0;
      // Who controls the page and where it is are read every quarter second, from memory; the tabs (a DevTools call) once a second, or when those move.
      const tick = async () => {
        if (signal.aborted) return;
        try {
          const control = browser.browserControl(scope);
          const moved = () => JSON.stringify([browser.identity(scope), control.controller, control.loading, control.error, control.dialog, control.upload, control.private, control.downloads.size]);
          if (moved() !== last || Date.now() - lastFull > 1_000) {
            const state: BrowserState = await browserStatus(scope, importEnabled);
            last = moved();
            lastFull = Date.now();
            write({ state });
            await follow(scope);
          }
        } catch { /* The next tick tries again; the panel says when it hears nothing. */ }
        if (!signal.aborted) timer = setTimeout(() => void tick(), 250);
      };
      signal.addEventListener("abort", () => { end(); try { controller.close(); } catch {} }, { once: true });
      void tick();
    },
    cancel() { end(); },
  });
}
