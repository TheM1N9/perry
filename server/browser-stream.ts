import * as browser from "../convex/lib/browser";
import type { BrowserIdentity, BrowserState } from "../lib/browser-protocol";
import { browserStatus } from "./browser-host";

/** Owner-only ephemeral NDJSON: one CDP screencast per chat, shared by its viewers. */
type Frame = { image: string; identity: BrowserIdentity; capturedAt: number };
type Watcher = { frame: (frame: Frame) => void; width: number };
type Cast = {
  watchers: Set<Watcher>; tabId: string | null; width: number;
  stop: (() => Promise<void>) | null; seen: string;
  following?: Promise<void>; again?: boolean;
};
const casts = ((globalThis as typeof globalThis & { __perryScreencasts?: Map<string, Cast> }).__perryScreencasts ??= new Map());
const identityKey = (identity: BrowserIdentity | null) => JSON.stringify(identity);
const widthOf = (cast: Cast) => Math.min(1280, Math.max(320, ...[...cast.watchers].map((watcher) => watcher.width)));

/** Serialize stop/start transitions, coalescing concurrent subscription changes. */
function follow(scope: string): Promise<void> {
  const cast = casts.get(scope);
  if (!cast) return Promise.resolve();
  cast.again = true;
  return cast.following ??= (async () => {
    while (cast.again) {
      cast.again = false;
      await updateCast(scope, cast);
    }
  })().finally(() => { cast.following = undefined; });
}

async function updateCast(scope: string, cast: Cast) {
  const current = browser.browserControl(scope).current?.targetId ?? null;
  const width = widthOf(cast);
  const seen = identityKey(browser.identity(scope));
  if (cast.watchers.size && current === cast.tabId && width === cast.width && seen === cast.seen && cast.stop) return;
  await cast.stop?.();
  cast.stop = null;
  cast.tabId = null;
  // Keep the cast registered until its stop completes, so a new viewer joins
  // this lifecycle rather than racing a second cast on the same CDP tab.
  if (!cast.watchers.size) { casts.delete(scope); return; }
  if (!current) return;
  await browser.withBrowserView(scope, async () => {
    if (!cast.watchers.size) { cast.again = true; return; }
    if (identityKey(browser.identity(scope)) !== seen) { cast.again = true; return; }
    let active = true;
    let watched: ReturnType<typeof browser.hostWatch> = null;
    watched = browser.hostWatch((method, params) => {
      if (method !== "Page.screencastFrame" || !watched) return;
      void watched.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      const identity = browser.identity(scope);
      // A capture belongs to its starting identity, never a later page. Even a
      // delayed event from the same tab must not be relabelled.
      if (!active || !identity || identityKey(identity) !== seen || identity.tabId !== watched.tabId) return;
      const frame = { image: String(params.data), identity, capturedAt: Date.now() };
      for (const watcher of cast.watchers) watcher.frame(frame);
    });
    if (!watched) return;
    const capture = watched;
    cast.seen = seen;
    cast.tabId = capture.tabId;
    cast.width = width;
    cast.stop = async () => {
      active = false;
      capture.stop();
      await capture.send("Page.stopScreencast").catch(() => {});
    };
    await capture.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: width, maxHeight: Math.round(width * 900 / 1280), everyNthFrame: 1 });
  }).catch(async () => { await cast.stop?.(); cast.stop = null; cast.tabId = null; });
}

export function streamBrowser(scope: string, importEnabled: boolean, width: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: Watcher | undefined;
  let ended = false;
  let pendingState: BrowserState | undefined;
  let pendingFrame: Frame | undefined;
  let announced = "";
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const end = () => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    pendingState = undefined;
    pendingFrame = undefined;
    const cast = casts.get(scope);
    if (cast && watcher) { cast.watchers.delete(watcher); void follow(scope); }
  };
  const abort = () => { end(); try { controller.close(); } catch {} };
  // ReadableStream owns the queue. While full, retain only the latest state
  // and frame; pull drains them in that order when the reader catches up.
  const flush = () => {
    if (ended) return;
    try {
      if (pendingState && (controller.desiredSize ?? 0) > 0) {
        const state = pendingState;
        pendingState = undefined;
        announced = identityKey(state.identity);
        controller.enqueue(encoder.encode(`${JSON.stringify({ state })}\n`));
      }
      if (pendingFrame && (controller.desiredSize ?? 0) > 0 && identityKey(pendingFrame.identity) === announced) {
        const frame = pendingFrame;
        pendingFrame = undefined;
        controller.enqueue(encoder.encode(`${JSON.stringify({ frame })}\n`));
      }
    } catch { abort(); }
  };
  return new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
      if (signal.aborted) { abort(); return; }
      watcher = { width, frame: (frame) => { if (!ended) { pendingFrame = frame; flush(); } } };
      const cast: Cast = casts.get(scope) ?? { watchers: new Set(), tabId: null, width: 0, stop: null, seen: "" };
      casts.set(scope, cast);
      cast.watchers.add(watcher);
      cast.seen = ""; // A new panel needs a first frame even on a static page.
      let last = "";
      let lastFull = 0;
      const tick = async () => {
        if (ended) return;
        try {
          const control = browser.browserControl(scope);
          const moved = () => JSON.stringify([browser.identity(scope), control.controller, control.loading, control.error, control.dialog, control.upload, control.private, control.downloads.size]);
          if (moved() !== last || Date.now() - lastFull > 1_000) {
            const state = await browserStatus(scope, importEnabled);
            if (ended) return;
            last = moved();
            lastFull = Date.now();
            pendingState = state;
            if (pendingFrame && identityKey(pendingFrame.identity) !== identityKey(state.identity)) pendingFrame = undefined;
            flush();
            await follow(scope);
          }
        } catch { /* The next tick retries a transient browser failure. */ }
        if (!ended) timer = setTimeout(() => void tick(), 250);
      };
      signal.addEventListener("abort", abort, { once: true });
      void tick();
    },
    pull() { flush(); },
    cancel() { end(); },
  });
}
