import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserIdentity } from "../../lib/browser-protocol";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, PATHS } from "../../runner/home";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Perry's own browser (issue #105): a Chrome (or Edge, or Chromium) with a
 * profile of its own in Perry's home, never the owner's, driven over the
 * DevTools protocol the way OpenClaw drives one. It runs headless in the
 * background, so it never takes over the screen, unlike Codex's computer use;
 * PERRY_BROWSER_HEADED=1 shows its window. Its cookies and sign-ins stay in
 * that profile.
 *
 * Chat-scoped tabs, kept between calls and turns so a task can go step by step. It
 * starts when first used and closes after IDLE_MS unused. What a page shows
 * is described with numbered elements (links, buttons, boxes) to act on by
 * number.
 */

const PROFILE = join(HOME, "browser");
type Control = {
  scope: string; ownerBusy: boolean; sessionApprovalEpoch: number; id: string; revision: number; epoch: number; controller: "agent" | "owner";
  root: Session | null; promise: Promise<Tab> | null; current: Tab | null; busy: boolean; private: boolean;
  loading: boolean; error: string | null; dialog: { type: string; message: string } | null;
  upload: number | null; downloads: Map<string, { id: string; name: string; state: string }>;
  connections: Map<string, Tab>;
  source: "perry" | "chrome"; ownedTargets: Set<string>;
};
type Lease = { control: Control; controller: "agent" | "owner" | "viewer"; revision: number; epoch: number; started: boolean; signal?: AbortSignal };
const states = (globalThis as typeof globalThis & { __perryBrowsers?: Map<string, Control>; __perryBrowserContext?: AsyncLocalStorage<Lease> });
const context = states.__perryBrowserContext ??= new AsyncLocalStorage<Lease>();
states.__perryBrowsers ??= new Map();
function control(scope = context.getStore()?.control.scope ?? "public-reader"): Control {
  let found = states.__perryBrowsers!.get(scope);
  if (!found) {
    let saved: { controller: "agent" | "owner"; private: boolean } = { controller: "agent", private: false };
    try { saved = z.object({ controller: z.enum(["agent", "owner"]), private: z.boolean() }).parse(JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(profileDirectory(scope), "perry-control.json"), "utf8"))); } catch {}
    found = { scope, ownerBusy: false, sessionApprovalEpoch: -1, id: randomUUID(), revision: 0, epoch: 0, controller: saved.controller, root: null, promise: null, current: null, busy: false, private: saved.private, loading: false, error: null, dialog: null, upload: null, downloads: new Map(), connections: new Map(), source: "perry", ownedTargets: new Set() };
    states.__perryBrowsers!.set(scope, found);
  }
  return found;
}
export function profileDirectory(scope: string) { return join(PROFILE, "chats", createHash("sha256").update(scope).digest("hex")); }
export function identity(scope?: string): BrowserIdentity | null {
  const state = control(scope);
  return state.current ? { sessionId: state.id, tabId: state.current.targetId, revision: state.revision } : null;
}
export function checkIdentity(expected: BrowserIdentity, scope?: string) {
  const actual = identity(scope);
  if (!actual || actual.sessionId !== expected.sessionId || actual.tabId !== expected.tabId || actual.revision !== expected.revision) throw new Error("The browser page changed. Look again before acting.");
}
function checkLease() {
  const lease = context.getStore();
  lease?.signal?.throwIfAborted();
  if (lease && lease.controller !== "viewer" && (lease.epoch !== lease.control.epoch || lease.controller !== lease.control.controller || (!lease.started && lease.revision !== lease.control.revision))) throw new Error("Browser control changed. Look again; the owner must explicitly resume Perry.");
}
/** One agent step at a time, including its approval wait. Takeover invalidates it immediately. */
export async function withAgentBrowser<T>(scope: string, expected: BrowserIdentity | undefined, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const state = control(scope);
  if (state.controller !== "agent") throw new Error("The owner has paused browser automation. Wait for explicit Resume Perry.");
  if (state.busy) throw new Error("Another browser action is still running. Wait for it to finish.");
  if (expected) checkIdentity(expected, scope);
  state.busy = true;
  const epoch = state.epoch;
  try { return await context.run({ control: state, controller: "agent", revision: state.revision, epoch, started: false, signal }, run); }
  finally {
    try {
      if (signal?.aborted && state.epoch === epoch && state.controller === "agent" && state.current) {
        const current = state.current;
        await withBrowserView(scope, async () => {
          try { await send(current, "Page.stopLoading", {}, AbortSignal.timeout(1_000)); }
          catch {
            // A sent CDP command cannot be unsent. Retire its host before a
            // new action can start, so a delayed stop cannot hit later work.
            if (state.current === current && state.epoch === epoch && state.controller === "agent") {
              closeBrowser();
              state.controller = "owner"; state.private = true;
              state.error = "The browser did not respond to Stop in time. Reopen it before continuing.";
              saveBrowserControl(scope);
            }
          }
        });
      }
    } finally { state.busy = false; }
  }
}
export async function withOwnerBrowser<T>(scope: string, run: () => Promise<T>): Promise<T> {
  const state = control(scope);
  if (state.ownerBusy) throw new Error("Another browser action is still running. Wait for it to finish.");
  state.ownerBusy = true;
  try { return await context.run({ control: state, controller: "owner", revision: state.revision, epoch: state.epoch, started: true }, run); }
  finally { state.ownerBusy = false; }
}
export async function withBrowserView<T>(scope: string, run: () => Promise<T>): Promise<T> {
  return await context.run({ control: control(scope), controller: "viewer", revision: 0, epoch: 0, started: true }, run);
}
export const browserControl = control;
export function saveBrowserControl(scope?: string) {
  const state = control(scope);
  const folder = profileDirectory(state.scope);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(/*turbopackIgnore: true*/ join(folder, "perry-control.json"), JSON.stringify({ controller: state.controller, private: state.private }), { mode: 0o600 });
}
export function assertBrowserLease() { checkLease(); }
export function importedSites() {
  try { return Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(join(profileDirectory(control().scope), "perry-imports.json"), "utf8")))); } catch { return []; }
}
export function needsSessionApproval() { return (control().source === "chrome" || importedSites().length > 0) && control().sessionApprovalEpoch !== control().epoch; }
export function approveSessionUse() { checkLease(); control().sessionApprovalEpoch = control().epoch; }

function pageChanged(state: Control) { state.revision++; }
function beginAction() {
  checkLease();
  const lease = context.getStore();
  if (lease) lease.started = true;
}

const IDLE_MS = 10 * 60_000;
const TEXT_CAP = 12_000;
const ELEMENTS_CAP = 150;

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
/** A DevTools connection to one tab. */
type Session = { ws: WebSocket; next: number; pending: Map<number, Pending>; listeners: Set<(method: string, params: any) => void>; parent?: Session; sessionId?: string; children?: Map<string, Session> };
type Tab = Session & { targetId: string; child: ChildProcess | null; port: number; idle: ReturnType<typeof setTimeout> | null };

/** Kept on globalThis, so every tool call in this server process drives the same browser. */


/** A Chromium-family browser on this computer, or null. PERRY_BROWSER_PATH names one. */
export function findBrowser(): string | null {
  if (process.env.PERRY_BROWSER_PATH) return existsSync(process.env.PERRY_BROWSER_PATH) ? process.env.PERRY_BROWSER_PATH : null;
  const candidates = process.platform === "win32"
    ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).flatMap((root) => [
      join(root!, "Google", "Chrome", "Application", "chrome.exe"),
      join(root!, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root!, "Chromium", "Application", "chrome.exe"),
    ])
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].map((name) => spawnSync("which", [name], { encoding: "utf8" }).stdout?.trim()).filter(Boolean) as string[];
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function launch(): Promise<Tab> {
  const state = control();
  state.source = "perry";
  state.id = randomUUID();
  const profile = profileDirectory(state.scope);
  (await import("../../server/browser-import")).recoverNativeImport(profile);
  const path = await (await import("../../server/browser-runtime")).browserExecutable();
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  let extensions: string[] = [];
  try { extensions = z.array(z.string().regex(/^Default\/PerryExtensions\/[a-p]{32}\/[\d._]+$/)).parse(JSON.parse(readFileSync(join(profile, "perry-extensions.json"), "utf8"))).map(path => join(profile, path)); } catch {}
  const child = spawn(/*turbopackIgnore: true*/ path, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,900", ...(extensions.length ? [`--load-extension=${extensions.join(",")}`] : []), ...(process.env.PERRY_BROWSER_HEADED === "1" ? [] : ["--headless=new"]), "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]); } catch {}
  }
  if (!port) { child.kill(); throw new Error("Perry's browser did not start."); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ id: string; type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((target) => target.type === "page");
  if (!page) { child.kill(); throw new Error("Perry's browser opened no tab."); }
  const session = await connect(page.webSocketDebuggerUrl).catch((error) => { child.kill(); throw error; });
  const tab: Tab = Object.assign(session, { targetId: page.id, child, port, idle: null });
  const gone = () => {
    if (state.current?.child !== child) return;
    state.promise = null; state.current = null; state.revision++; state.epoch++; state.controller = "owner"; saveBrowserControl(state.scope); state.error = "Browser host disconnected. Reopen it; previous tabs were lost.";
    for (const session of state.connections.values()) { session.ws.close(); for (const waiting of session.pending.values()) waiting.reject(new Error("Perry's browser closed.")); }
    state.connections.clear(); state.root?.ws.close(); state.root = null;
  };

  child.on("exit", gone);
  state.current = tab; state.connections.set(tab.targetId, tab); state.error = null;
  await prepareTab(tab, state);
  const downloadDir = join(PATHS.files, "browser-downloads", createHash("sha256").update(state.scope).digest("hex"));
  mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
  const version = z.object({ webSocketDebuggerUrl: z.string() }).parse(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json());
  const root = state.root = await connect(version.webSocketDebuggerUrl);
  root.ws.addEventListener("close", gone);
  root.listeners.add((method, params) => {
    if (method === "Browser.downloadWillBegin") state.downloads.set(String(params.guid), { id: String(params.guid), name: String(params.suggestedFilename).slice(0, 200), state: "inProgress" });
    if (method === "Browser.downloadProgress") {
      const item = state.downloads.get(String(params.guid));
      if (item) {
        item.state = String(params.state);
        if (item.state === "completed") void withBrowserView(state.scope, async () => {
          const values = z.object({ cookies: z.array(z.object({ value: z.string() })) }).parse(await hostCommand("Storage.getCookies"));
          item.name = values.cookies.reduce((name, cookie) => cookie.value ? name.replaceAll(cookie.value, "[credential]") : name, item.name);
          await (await import("../../server/browser-files")).registerBrowserDownload(state.scope, item.id, item.name);
        }).catch(() => { state.error = "A browser download could not be registered. Refresh the browser view."; });
      }
    }
  });
  await send(root, "Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir, eventsEnabled: true });
  return tab;
}

async function prepareTab(tab: Tab, state: Control) {
  tab.listeners.add((method, params) => {
    if (method === "Page.frameNavigated" && !params.frame.parentId && state.current === tab) pageChanged(state);
    if (method === "Page.frameStartedLoading" && state.current === tab) state.loading = true;
    if (method === "Page.frameStoppedLoading" && state.current === tab) state.loading = false;
    if (method === "Page.javascriptDialogOpening" && state.current === tab) state.dialog = { type: String(params.type), message: String(params.message).slice(0, 500) };
    if (method === "Page.javascriptDialogClosed") state.dialog = null;
    if (method === "Page.fileChooserOpened") state.upload = Number(params.backendNodeId);

  });
  await send(tab, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send(tab, "Page.enable");
  await send(tab, "Runtime.enable");
  await send(tab, "Page.setInterceptFileChooserDialog", { enabled: true });
}
/** Trusted local host helpers. Never exposed as arbitrary CDP or credential tools. */
export async function hostCommand(method: string, params: object = {}): Promise<unknown> {
  const current = await tab(), state = control();
  if (state.source === "chrome" && method.startsWith("Target.")) {
    if (method === "Target.closeTarget" && !state.ownedTargets.has(String((params as { targetId?: string }).targetId))) throw new Error("That tab is not part of this chat.");
    const result = await send(state.root!, method, params);
    if (method === "Target.createTarget") state.ownedTargets.add(String(result.targetId));
    return result;
  }
  return await send(current, method === "Storage.getCookies" && state.source === "chrome" ? "Network.getCookies" : method, params);
}
/**
 * The open tab's events, for the owner's live view (server/browser-stream.ts):
 * `listener` hears each one and can answer on the same tab. Null when no tab is
 * open; it never opens one. Returns the tab watched and how to stop.
 */
export function hostWatch(listener: (method: string, params: any) => void): { tabId: string; send: (method: string, params?: object) => Promise<unknown>; stop: () => void } | null {
  const current = control().current;
  if (!current) return null;
  current.listeners.add(listener);
  return { tabId: current.targetId, send: (method, params = {}) => send(current, method, params), stop: () => { current.listeners.delete(listener); } };
}
export async function hostTargets() {
  const current = await tab();
  if (control().source === "chrome") {
    const result = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), title: z.string(), url: z.string() })) }).parse(await send(control().root!, "Target.getTargets"));
    return result.targetInfos.filter(target => target.type === "page" && control().ownedTargets.has(target.targetId)).map(target => ({ ...target, id: target.targetId, webSocketDebuggerUrl: undefined }));
  }
  return z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() })).parse(await (await fetch(`http://127.0.0.1:${current.port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((target) => target.type === "page");
}
export async function selectHostTab(id: string) {
  const state = control();
  const target = (await hostTargets()).find((target) => target.id === id);
  if (!target || (control().source !== "chrome" && !target.webSocketDebuggerUrl)) throw new Error("That tab closed. Refresh the browser view.");
  let current = state.connections.get(id);
  if (!current) {
    const base = await tab();
    if (state.source === "chrome") current = await attachChromeTab(state, id, base.port);
    else {
      current = Object.assign(await connect(target.webSocketDebuggerUrl!), { targetId: id, child: base.child, port: base.port, idle: null });
      await prepareTab(current, state);
    }
    state.connections.set(id, current);
  }
  if (state.current?.idle) clearTimeout(state.current.idle);
  state.current = current;
  await send(current, "Page.bringToFront");
}

async function connect(url: string, chrome = false): Promise<Session> {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error(chrome ? "Chrome connection timed out. Allow the connection in Chrome, then retry." : "The browser connection timed out. Refresh the view.")); }, 30_000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(chrome ? "Chrome connection failed. Check remote debugging and allow the connection in Chrome, then retry." : "The browser connection failed. Refresh the view.")); }, { once: true });
    ws.addEventListener("close", () => { clearTimeout(timer); reject(new Error(chrome ? "Chrome declined or closed the connection." : "The browser connection closed.")); }, { once: true });
  });
  const session: Session = { ws, next: 0, pending: new Map(), listeners: new Set() };
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; sessionId?: string; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (message.id !== undefined) {
      const waiting = session.pending.get(message.id);
      session.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error("Browser command failed. Refresh the page or sign in manually."));
      else waiting?.resolve(message.result);
    } else if (message.method) {
      for (const listener of (message.sessionId ? session.children?.get(message.sessionId)?.listeners ?? [] : session.listeners)) listener(message.method, message.params);
    }
  });
  ws.addEventListener("close", () => { for (const waiting of session.pending.values()) waiting.reject(new Error("Perry's browser closed.")); });
  return session;
}

function send(tab: Session, method: string, params: object = {}, signal = context.getStore()?.signal): Promise<any> {
  if (method === "Storage.getCookies" && control().source === "chrome") method = "Network.getCookies";
  return new Promise((resolve, reject) => {
    try { checkLease(); signal?.throwIfAborted(); } catch (error) { reject(error); return; }
    const transport = tab.parent ?? tab;
    const id = ++transport.next;
    const finish = (error?: unknown, value?: unknown) => {
      transport.pending.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal?.reason ?? new Error("Browser action cancelled."));
    const timer = setTimeout(() => finish(new Error("Browser command timed out. Refresh the view.")), 30_000);
    transport.pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) });
    signal?.addEventListener("abort", abort, { once: true });
    try { transport.ws.send(JSON.stringify({ id, method, params, ...(tab.sessionId ? { sessionId: tab.sessionId } : {}) })); }
    catch (error) { finish(error); }
  });
}

async function tab(): Promise<Tab> {
  checkLease();
  const state = control();
  state.promise ??= launch().catch((error) => { state.promise = null; throw error; });
  const launched = await state.promise;
  const current = state.current ?? launched;
  checkLease();
  if (current.idle) clearTimeout(current.idle);
  current.idle = setTimeout(() => { void withBrowserView(state.scope, async () => closeBrowser()); }, IDLE_MS);
  return current;
}

export function closeBrowser() {
  checkLease();
  const state = control();
  const current = state.promise;
  const root = state.root;
  const cleanup = state.source === "chrome" ? [...state.connections.values()].flatMap(open => [
    send(open, "Emulation.clearDeviceMetricsOverride").catch(() => {}),
    send(open, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {}),
  ]) : [];
  state.promise = null; state.current = null; state.revision++; state.epoch++;
  for (const open of state.connections.values()) { if (open.idle) clearTimeout(open.idle); if (state.source !== "chrome") open.ws.close(); }
  state.connections.clear(); state.root = null; state.ownedTargets.clear(); state.source = "perry";
  void Promise.allSettled(cleanup).then(() => root?.ws.close());
  void current?.then((open) => { open.child?.kill(); }, () => {});
}

async function attachChromeTab(state: Control, targetId: string, port: number): Promise<Tab> {
  const root = state.root!;
  const attached = z.object({ sessionId: z.string() }).parse(await send(root, "Target.attachToTarget", { targetId, flatten: true }));
  const tab: Tab = { ws: root.ws, parent: root, sessionId: attached.sessionId, next: 0, pending: root.pending, listeners: new Set(), targetId, child: null, port, idle: null };
  (root.children ??= new Map()).set(attached.sessionId, tab);
  state.connections.set(targetId, tab);
  await prepareTab(tab, state);
  return tab;
}

/** Chrome 144+ publishes this endpoint only after the owner enables its native bridge. */
export async function connectChrome(): Promise<void> {
  const state = control();
  if (state.current || state.promise) throw new Error("Disconnect the current browser before connecting Chrome.");
  const folder = process.env.PERRY_CHROME_USER_DATA_DIR ?? (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data")
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Google", "Chrome") : join(homedir(), ".config", "google-chrome"));
  let port: number, endpoint: string;
  try {
    const lines = readFileSync(join(folder, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
    port = z.coerce.number().int().min(1).max(65535).parse(lines[0]);
    endpoint = z.string().regex(/^\/devtools\/browser\/[a-zA-Z0-9-]+$/).parse(lines[1]);
  } catch { throw new Error("Enable remote debugging in chrome://inspect/#remote-debugging, then connect Chrome."); }
  const epoch = state.epoch;
  state.promise = (async () => {
    const root = await connect(`ws://127.0.0.1:${port}${endpoint}`, true);
    let created: string | undefined;
    try {
      if (state.epoch !== epoch) throw new Error("Browser control changed. Connect Chrome again.");
      const version = z.object({ product: z.string() }).parse(await send(root, "Browser.getVersion"));
      if (Number(/(?:Chrome|Chromium)\/(\d+)/.exec(version.product)?.[1] ?? 0) < 144) throw new Error("Update Chrome to version 144 or newer.");
      const target = z.object({ targetId: z.string() }).parse(await send(root, "Target.createTarget", { url: "about:blank" }));
      created = target.targetId;
      if (state.epoch !== epoch) throw new Error("Browser control changed. Connect Chrome again.");
      state.root = root; state.source = "chrome"; state.id = randomUUID(); state.ownedTargets.add(created);
      root.listeners.add((method, params) => {
        if (method === "Target.targetCreated" && params.targetInfo?.openerId && state.ownedTargets.has(params.targetInfo.openerId)) state.ownedTargets.add(params.targetInfo.targetId);
      });
      await send(root, "Target.setDiscoverTargets", { discover: true });
      const tab = await attachChromeTab(state, created, port);
      state.current = tab; state.error = null;
      root.ws.addEventListener("close", () => {
        if (state.root !== root) return;
        state.promise = null; state.current = null; state.root = null; state.connections.clear(); state.ownedTargets.clear(); state.epoch++; state.revision++; state.controller = "owner"; state.error = "Chrome disconnected. Connect again.";
      });
      return tab;
    } catch (error) {
      if (created) await send(root, "Target.closeTarget", { targetId: created }).catch(() => {});
      root.ws.close(); state.root = null; state.connections.clear(); state.ownedTargets.clear(); state.source = "perry";
      throw error;
    }
  })().catch(error => { state.promise = null; throw error; });
  await state.promise;
}

async function evaluate<T>(open: Session, expression: string): Promise<T> {
  const result = await send(open, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error("Browser page evaluation failed. Refresh the page.");
  return result.result.value as T;
}

/** Wait for a page load that an action may have started, briefly when none comes. */
async function settle(open: Tab, maxMs = 15_000) {
  let loading = false;
  const signal = context.getStore()?.signal;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let listener: (method: string) => void = () => {};
  let abort: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted();
      abort = () => reject(signal?.reason);
      listener = (method: string) => {
        if (method === "Page.frameStartedLoading") loading = true;
        if (method === "Page.loadEventFired") resolve();
      };
      open.listeners.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
      quiet = setTimeout(() => { if (!loading) resolve(); }, 900);
      deadline = setTimeout(resolve, maxMs);
    });
  } finally {
    open.listeners.delete(listener);
    clearTimeout(quiet); clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
  }
  // A moment for what the page draws after it loads.
  await delay(400, undefined, { signal });
}

export type Element = { ref: number; kind: string; label: string; href?: string };
export type Snapshot = { url: string; title: string; text: string; elements: Element[]; identity?: BrowserIdentity };

const SNAPSHOT = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  document.querySelectorAll("[data-perry-ref]").forEach((el) => el.removeAttribute("data-perry-ref"));
  const found = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [contenteditable=true]')].filter(shown).slice(0, ${ELEMENTS_CAP});
  const elements = found.map((el, index) => {
    el.setAttribute("data-perry-ref", String(index + 1));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const label = (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || (type === "password" ? "" : el.value) || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("alt") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    const kind = tag === "a" ? "link" : tag === "input" ? (["submit", "button", "reset"].includes(type) ? "button" : type === "checkbox" || type === "radio" ? type : (type || "text") + " box") : tag === "textarea" ? "text box" : tag === "select" ? "choice" : el.getAttribute("role") || tag;
    return { ref: index + 1, kind, label, ...(tag === "a" ? { href: el.href.slice(0, 200) } : {}) };
  });
  const text = document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n") : "";
  return { url: location.href, title: document.title, text: text.slice(0, ${TEXT_CAP}), elements };
})()`;

export async function snapshot(): Promise<Snapshot> {
  const current = await tab();
  const state = control();
  const revision = state.revision;
  const result = await evaluate<Snapshot>(current, SNAPSHOT);
  // A hostile page can echo cookies into text. Redact all cookie values before a model/trace sees them.
  const stored = z.object({ cookies: z.array(z.object({ value: z.string() })) }).parse(await send(current, "Storage.getCookies"));
  const passwords = control().source === "perry" ? await (await import("../../server/browser-import-native")).ownPasswordValues(profileDirectory(control().scope)) : [];
  const scrub = (value: string) => [...stored.cookies.map(cookie => cookie.value), ...passwords].reduce((text, secret) => secret ? text.replaceAll(secret, "[browser credential]") : text, value);
  checkLease();
  if (state.current !== current || state.revision !== revision) throw new Error("The browser page changed. Look again before acting.");
  // Numbered refs belong to this observation, including when the URL did not change.
  state.revision++;
  const lease = context.getStore();
  if (lease) lease.revision = state.revision;
  return { url: scrub(result.url), title: scrub(result.title), text: scrub(result.text), elements: result.elements.map((element) => ({ ...element, label: scrub(element.label), ...(element.href ? { href: scrub(element.href) } : {}) })), identity: identity() ?? undefined };
}

export async function open(url: string): Promise<Snapshot> {
  beginAction();
  if (!/^https?:\/\//i.test(url)) throw new Error("Perry's browser opens http and https addresses only.");
  const current = await tab();
  const navigation = await send(current, "Page.navigate", { url });
  if (navigation.errorText) throw new Error(`Navigation failed (${navigation.errorText}).`);
  await settle(current, 30_000);
  return await snapshot();
}

/** What an element is, by its number from the last look: its label and kind, the page's address, and the form's button when it is a box. */
export async function describe(ref: number): Promise<{ kind: string; label: string; url: string; submitLabel?: string; search: boolean; password: boolean }> {
  const found = await evaluate<{ kind: string; label: string; url: string; submitLabel?: string; search: boolean; password: boolean } | null>(await tab(), `(() => {
    const el = document.querySelector('[data-perry-ref="${ref}"]');
    if (!el) return null;
    const form = el.form || el.closest("form");
    const button = form && form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    const type = (el.getAttribute("type") || "").toLowerCase();
    return {
      kind: el.tagName.toLowerCase(), url: location.href,
      label: (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("name") || "").trim().replace(/\\s+/g, " ").slice(0, 120),
      submitLabel: button ? (button.innerText || button.value || button.getAttribute("aria-label") || "").trim().slice(0, 80) : undefined,
      search: type === "search" || Boolean(el.closest("[role=search]")) || /^(q|query|search|s)$/i.test(el.getAttribute("name") || ""),
      password: type === "password",
    };
  })()`);
  if (!found) throw new Error(`There is no element ${ref} on this page any more; look at the page again for the current numbers.`);
  const stored = z.object({ cookies: z.array(z.object({ value: z.string() })) }).parse(await send(await tab(), "Storage.getCookies"));
  const scrub = (text: string) => stored.cookies.reduce((safe, cookie) => cookie.value ? safe.replaceAll(cookie.value, "[browser credential]") : safe, text);
  return { ...found, label: scrub(found.label), url: scrub(found.url), ...(found.submitLabel ? { submitLabel: scrub(found.submitLabel) } : {}) };
}

export async function click(ref: number): Promise<Snapshot> {
  beginAction();
  const current = await tab();
  const point = await evaluate<{ x: number; y: number } | null>(current, `(() => {
    const el = document.querySelector('[data-perry-ref="${ref}"]');
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!point) throw new Error(`There is no element ${ref} on this page any more; look at the page again for the current numbers.`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send(current, "Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
  await settle(current);
  return await snapshot();
}

async function focus(current: Tab, ref: number) {
  const ok = await evaluate<boolean>(current, `(() => {
    const el = document.querySelector('[data-perry-ref="${ref}"]');
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (typeof el.select === "function") el.select();
    else if (el.isContentEditable) document.execCommand("selectAll");
    return true;
  })()`);
  if (!ok) throw new Error(`There is no element ${ref} on this page any more; look at the page again for the current numbers.`);
}

async function enter(current: Tab) {
  for (const type of ["keyDown", "keyUp"]) {
    await send(current, "Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
  }
}

/** Type into a box, replacing what it held; with `submit`, press Enter after. */
export async function type(ref: number, text: string, submit: boolean): Promise<Snapshot> {
  beginAction();
  const current = await tab();
  await focus(current, ref);
  await send(current, "Input.insertText", { text });
  if (submit) await enter(current);
  await settle(current);
  return await snapshot();
}

/** Pick an option of a choice (a select) by its text or value. */
export async function choose(ref: number, option: string): Promise<Snapshot> {
  beginAction();
  const current = await tab();
  const picked = await evaluate<string | null>(current, `(() => {
    const el = document.querySelector('[data-perry-ref="${ref}"]');
    if (!el || el.tagName !== "SELECT") return null;
    const wanted = ${JSON.stringify(option)}.toLowerCase();
    const match = [...el.options].find((o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted) || [...el.options].find((o) => o.text.toLowerCase().includes(wanted));
    if (!match) return null;
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return match.text;
  })()`);
  if (!picked) throw new Error(`Element ${ref} is not a choice with an option "${option}".`);
  await settle(current);
  return await snapshot();
}

export async function back(): Promise<Snapshot> {
  beginAction();
  const current = await tab();
  await evaluate(current, "history.back(), true");
  await settle(current);
  return await snapshot();
}

/** Enter a saved login's name and password, typed straight into the page: they never pass through the agent. */
export async function signIn(login: { username?: string; value: string }, usernameRef: number | undefined, passwordRef: number, submit: boolean): Promise<Snapshot> {
  beginAction();
  control().private = true; saveBrowserControl();
  const current = await tab();
  if (usernameRef !== undefined && login.username) {
    await focus(current, usernameRef);
    await send(current, "Input.insertText", { text: login.username });
  }
  await focus(current, passwordRef);
  await send(current, "Input.insertText", { text: login.value });
  if (submit) await enter(current);
  await settle(current);
  return await snapshot();
}

/** A picture of the tab, saved in Perry's files folder; returns its path, for share_file. */
export async function screenshot(): Promise<string> {
  if (control().private) throw new Error("Capture is paused for private browsing. The owner can enable agent capture in the Browser panel.");
  const shot = await send(await tab(), "Page.captureScreenshot", { format: "png" }) as { data: string };
  mkdirSync(PATHS.files, { recursive: true });
  const path = join(PATHS.files, `browser-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  return path;
}

/** Pictures kept for the chat's steps; older ones are deleted, and their steps show none. */
const PREVIEWS_KEPT = 300;

/**
 * A small picture of the tab (half size, JPEG), for the step in the chat that
 * shows what the browser did. Saved in Perry's steps folder; returns its path.
 */
export async function preview(): Promise<string> {
  if (control().private) throw new Error("Agent capture is paused for private browsing.");
  const shot = await send(await tab(), "Page.captureScreenshot", { format: "jpeg", quality: 60, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 1280, height: 900, scale: 0.5 } }) as { data: string };
  mkdirSync(PATHS.steps, { recursive: true });
  const path = join(PATHS.steps, `browser-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}.jpg`);
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  const kept = readdirSync(PATHS.steps).filter((name) => name.startsWith("browser-")).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - PREVIEWS_KEPT))) rmSync(join(PATHS.steps, old), { force: true });
  return path;
}

/** Whether `url` is on the site a saved login is for: the same host, or one under it. */
export function onSite(url: string, site: string): boolean {
  try {
    const here = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const there = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.toLowerCase().replace(/^www\./, "");
    return here === there || here.endsWith(`.${there}`);
  } catch {
    return false;
  }
}

// --- Reading a page for read_page -------------------------------------------------------------------

/**
 * The checks read_page makes on its own fetches, made on every request the browser sends for it:
 * `request` before it goes (throwing refuses it), `address` on the address that answered.
 */
export type Guard = { request: (url: string) => Promise<void>; address: (url: string, ip: string) => void };
export type Rendered = { url: string; status: number; title: string; html: string };
/** How long a loaded page may keep drawing before it is read as it stands. */
const SETTLE_MS = 4_000;

/**
 * One page as the browser shows it, for read_page when a plain fetch was turned away (issue #158). It
 * gets a tab of its own, closed after, so a task going step by step in the browser's tab stays where
 * it was. The browser itself starts only now, the first time it is needed.
 *
 * Every request the page makes (the page, a redirect, a script's fetch) goes through `guard` before it
 * is sent, and an answer from an address that is not public spoils the read, so the browser reaches no
 * further than read_page's own fetch. A bot check that clears itself (a script that sets a cookie and
 * reloads) is waited out, up to `timeoutMs`; one that wants a person is still there at the end, which
 * the caller sees with `checking`. The HTML comes back for read_page to turn into text, the same way
 * as a fetched page, and is refused over `maxChars`.
 */
export async function render(url: string, options: { guard: Guard; timeoutMs: number; maxChars: number; checking: (html: string) => boolean; signal?: AbortSignal; isolated?: boolean }): Promise<Rendered> {
  const { guard, timeoutMs, maxChars, checking } = options;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  const opened: { port?: number; id?: string; session?: Session; control?: Session; context?: string } = {};
  const dispose = async () => {
    opened.session?.ws.close();
    if (opened.context && opened.control?.ws.readyState === WebSocket.OPEN) {
      // Detaching also disposes the isolated context, even if Chrome cannot answer the cleanup command.
      const timer = setTimeout(() => opened.control?.ws.close(), 1_000);
      try { await send(opened.control, "Target.disposeBrowserContext", { browserContextId: opened.context }).catch(() => {}); }
      finally { clearTimeout(timer); }
    } else if (opened.id) await fetch(`http://127.0.0.1:${opened.port}/json/close/${opened.id}`, { signal: AbortSignal.timeout(1_000) }).catch(() => {});
    opened.control?.ws.close();
  };
  let abort: () => void = () => {};
  const late = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  const reading = (async (): Promise<Rendered> => {
    try {
      opened.port = (await tab()).port;
      signal.throwIfAborted();
      let target: { id: string; webSocketDebuggerUrl: string };
      if (options.isolated) {
        const version = await (await fetch(`http://127.0.0.1:${opened.port}/json/version`, { signal })).json() as { webSocketDebuggerUrl: string };
        opened.control = await connect(version.webSocketDebuggerUrl);
        signal.throwIfAborted();
        const context = await send(opened.control, "Target.createBrowserContext", { disposeOnDetach: true }) as { browserContextId: string };
        opened.context = context.browserContextId;
        signal.throwIfAborted();
        const created = await send(opened.control, "Target.createTarget", { url: "about:blank", browserContextId: opened.context }) as { targetId: string };
        opened.id = created.targetId;
        signal.throwIfAborted();
        const targets = await (await fetch(`http://127.0.0.1:${opened.port}/json/list`, { signal })).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
        const found = targets.find((item) => item.id === created.targetId);
        if (!found) throw new Error("Perry's public browser tab did not open.");
        target = found;
      } else {
        target = await (await fetch(`http://127.0.0.1:${opened.port}/json/new?about:blank`, { method: "PUT", signal })).json() as { id: string; webSocketDebuggerUrl: string };
      }
      opened.id = target.id;
      signal.throwIfAborted();
      const open = opened.session = await connect(target.webSocketDebuggerUrl);
      signal.throwIfAborted();
      const main = (await send(open, "Page.getFrameTree") as { frameTree: { frame: { id: string } } }).frameTree.frame.id;
      let refused: Error | null = null;
      let status = 0;
      open.listeners.add((method, params) => {
        if (method === "Fetch.requestPaused") {
          if (options.isolated && !["GET", "HEAD"].includes(params.request.method)) {
            void send(open, "Fetch.failRequest", { requestId: params.requestId, errorReason: "AccessDenied" }).catch(() => {});
            return;
          }
          guard.request(params.request.url).then(
            () => send(open, "Fetch.continueRequest", { requestId: params.requestId }),
            (error: Error) => {
              if (params.resourceType === "Document" && params.frameId === main) refused ??= error;
              return send(open, "Fetch.failRequest", { requestId: params.requestId, errorReason: "AccessDenied" });
            },
          ).catch(() => {});
        }
        // A redirect's answer arrives with the request it leads to; every other answer on its own.
        const answer = method === "Network.requestWillBeSent" ? params.redirectResponse : method === "Network.responseReceived" ? params.response : undefined;
        if (answer?.remoteIPAddress) {
          try { guard.address(answer.url, answer.remoteIPAddress); } catch (error) { refused ??= error as Error; }
        }
        if (method === "Network.responseReceived" && params.type === "Document" && params.frameId === main) status = params.response.status;
      });
      await send(open, "Page.enable");
      await send(open, "Network.enable");
      // A service worker's own fetches would pass the checks by, so the page asks the network directly.
      await send(open, "Network.setBypassServiceWorker", { bypass: true });
      if (process.env.PERRY_BROWSER_HEADED !== "1") {
        // Headless Chrome calls itself HeadlessChrome, which bot checks turn away on sight. It is Chrome.
        const agent = await evaluate<string>(open, "navigator.userAgent");
        await send(open, "Network.setUserAgentOverride", { userAgent: agent.replace("HeadlessChrome", "Chrome"), acceptLanguage: "en-US,en;q=0.9" });
      }
      await send(open, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      const navigated = await send(open, "Page.navigate", { url }) as { errorText?: string };
      if (refused) throw refused;
      if (navigated.errorText) throw new Error(`Perry's browser could not open it either (${navigated.errorText}).`);

      // Until the page has loaded, is no longer a bot check, and its text has stopped growing; or, once it
      // is past a bot check and parsed, a few seconds more at most: a page with live prices never stops
      // drawing, and one full of ads may never finish loading.
      let chars = -1;
      let settled = Infinity;
      while (Date.now() < Math.min(deadline - 1_500, settled)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        signal.throwIfAborted();
        if (refused) throw refused;
        const seen = await evaluate<{ state: string; chars: number; html: string }>(open,
          "({ state: document.readyState, chars: document.body ? document.body.innerText.length : 0, html: document.documentElement.outerHTML.slice(0, 200000) })").catch(() => null);
        if (!seen || seen.state === "loading" || checking(seen.html)) { chars = -1; settled = Infinity; continue; }
        settled = Math.min(settled, Date.now() + SETTLE_MS);
        if (seen.state === "complete" && seen.chars > 0 && seen.chars === chars) break;
        chars = seen.chars;
      }
      if (refused) throw refused;
      const page = await evaluate<{ url: string; title: string; html: string | null }>(open,
        `({ url: location.href, title: document.title, html: document.documentElement.outerHTML.length > ${maxChars} ? null : document.documentElement.outerHTML })`);
      if (page.html === null) throw new Error("The page is over the 5 MB limit.");
      return { url: page.url, status, title: page.title, html: page.html };
    } finally { await dispose(); }
  })();
  reading.catch(() => {});
  try {
    return await Promise.race([reading, late]);
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) await dispose();
  }
}
