import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, PATHS } from "../../runner/home";

/**
 * Perry's own browser (issue #105): a Chrome (or Edge, or Chromium) with a
 * profile of its own in Perry's home, never the owner's, driven over the
 * DevTools protocol the way OpenClaw drives one. It runs headless in the
 * background, so it never takes over the screen, unlike Codex's computer use;
 * PERRY_BROWSER_HEADED=1 shows its window. Its cookies and sign-ins stay in
 * that profile.
 *
 * One tab, kept between calls and turns so a task can go step by step. It
 * starts when first used and closes after IDLE_MS unused. What a page shows
 * is described with numbered elements (links, buttons, boxes) to act on by
 * number.
 */

const PROFILE = join(HOME, "browser");
const IDLE_MS = 10 * 60_000;
const TEXT_CAP = 12_000;
const ELEMENTS_CAP = 150;

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
/** A DevTools connection to one tab. */
type Session = { ws: WebSocket; next: number; pending: Map<number, Pending>; listeners: Set<(method: string, params: any) => void> };
type Tab = Session & { child: ChildProcess; port: number; idle: ReturnType<typeof setTimeout> | null };

/** Kept on globalThis, so every tool call in this server process drives the same browser. */
const box = globalThis as { __perryBrowser?: Promise<Tab> | null };

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
  const path = findBrowser();
  if (!path) throw new Error("There is no Chrome, Edge or Chromium on this computer for Perry's browser. Install Chrome, or set PERRY_BROWSER_PATH.");
  mkdirSync(PROFILE, { recursive: true });
  rmSync(join(PROFILE, "DevToolsActivePort"), { force: true });
  const child = spawn(path, [
    `--user-data-dir=${PROFILE}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,900", ...(process.env.PERRY_BROWSER_HEADED === "1" ? [] : ["--headless=new"]), "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try { port = Number(readFileSync(join(PROFILE, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]); } catch {}
  }
  if (!port) { child.kill(); throw new Error("Perry's browser did not start."); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((target) => target.type === "page");
  if (!page) { child.kill(); throw new Error("Perry's browser opened no tab."); }
  const session = await connect(page.webSocketDebuggerUrl).catch((error) => { child.kill(); throw error; });
  const tab: Tab = Object.assign(session, { child, port, idle: null });
  const gone = () => { box.__perryBrowser = null; for (const waiting of tab.pending.values()) waiting.reject(new Error("Perry's browser closed.")); };
  tab.ws.addEventListener("close", gone);
  child.on("exit", gone);
  await send(tab, "Page.enable");
  await send(tab, "Runtime.enable");
  return tab;
}

async function connect(url: string): Promise<Session> {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error("Could not reach Perry's browser.")), { once: true }); });
  const session: Session = { ws, next: 0, pending: new Map(), listeners: new Set() };
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (message.id !== undefined) {
      const waiting = session.pending.get(message.id);
      session.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    } else if (message.method) {
      for (const listener of session.listeners) listener(message.method, message.params);
    }
  });
  ws.addEventListener("close", () => { for (const waiting of session.pending.values()) waiting.reject(new Error("Perry's browser closed.")); });
  return session;
}

function send(tab: Session, method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++tab.next;
    tab.pending.set(id, { resolve, reject });
    tab.ws.send(JSON.stringify({ id, method, params }));
  });
}

async function tab(): Promise<Tab> {
  box.__perryBrowser ??= launch().catch((error) => { box.__perryBrowser = null; throw error; });
  const current = await box.__perryBrowser;
  if (current.idle) clearTimeout(current.idle);
  current.idle = setTimeout(() => closeBrowser(), IDLE_MS);
  return current;
}

export function closeBrowser() {
  const current = box.__perryBrowser;
  box.__perryBrowser = null;
  void current?.then((open) => { open.ws.close(); open.child.kill(); }, () => {});
}

async function evaluate<T>(open: Session, expression: string): Promise<T> {
  const result = await send(open, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value as T;
}

/** Wait for a page load that an action may have started, briefly when none comes. */
async function settle(open: Tab, maxMs = 15_000) {
  let loading = false;
  const done = new Promise<void>((resolve) => {
    const listener = (method: string) => {
      if (method === "Page.frameStartedLoading") loading = true;
      if (method === "Page.loadEventFired") { open.listeners.delete(listener); resolve(); }
    };
    open.listeners.add(listener);
    setTimeout(() => { if (!loading) { open.listeners.delete(listener); resolve(); } }, 900);
    setTimeout(() => { open.listeners.delete(listener); resolve(); }, maxMs);
  });
  await done;
  // A moment for what the page draws after it loads.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

export type Element = { ref: number; kind: string; label: string; href?: string };
export type Snapshot = { url: string; title: string; text: string; elements: Element[] };

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
  return await evaluate<Snapshot>(await tab(), SNAPSHOT);
}

export async function open(url: string): Promise<Snapshot> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Perry's browser opens http and https addresses only.");
  const current = await tab();
  await send(current, "Page.navigate", { url });
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
  return found;
}

export async function click(ref: number): Promise<Snapshot> {
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
  const current = await tab();
  await focus(current, ref);
  await send(current, "Input.insertText", { text });
  if (submit) await enter(current);
  await settle(current);
  return await snapshot();
}

/** Pick an option of a choice (a select) by its text or value. */
export async function choose(ref: number, option: string): Promise<Snapshot> {
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
  const current = await tab();
  await evaluate(current, "history.back(), true");
  await settle(current);
  return await snapshot();
}

/** Enter a saved login's name and password, typed straight into the page: they never pass through the agent. */
export async function signIn(login: { username?: string; value: string }, usernameRef: number | undefined, passwordRef: number, submit: boolean): Promise<Snapshot> {
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
export async function render(url: string, options: { guard: Guard; timeoutMs: number; maxChars: number; checking: (html: string) => boolean }): Promise<Rendered> {
  const { guard, timeoutMs, maxChars, checking } = options;
  const deadline = Date.now() + timeoutMs;
  const opened: { port?: number; id?: string; session?: Session } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Perry's browser did not finish loading it in ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  });
  const reading = (async (): Promise<Rendered> => {
    opened.port = (await tab()).port;
    const target = await (await fetch(`http://127.0.0.1:${opened.port}/json/new?about:blank`, { method: "PUT" })).json() as { id: string; webSocketDebuggerUrl: string };
    opened.id = target.id;
    const open = opened.session = await connect(target.webSocketDebuggerUrl);
    const main = (await send(open, "Page.getFrameTree") as { frameTree: { frame: { id: string } } }).frameTree.frame.id;
    let refused: Error | null = null;
    let status = 0;
    open.listeners.add((method, params) => {
      if (method === "Fetch.requestPaused") {
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
  })();
  reading.catch(() => {});
  try {
    return await Promise.race([reading, late]);
  } finally {
    clearTimeout(timer);
    opened.session?.ws.close();
    if (opened.id) await fetch(`http://127.0.0.1:${opened.port}/json/close/${opened.id}`).catch(() => {});
  }
}
