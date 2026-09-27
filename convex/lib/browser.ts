import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
type Tab = { child: ChildProcess; ws: WebSocket; next: number; pending: Map<number, Pending>; listeners: Set<(method: string, params: any) => void>; idle: ReturnType<typeof setTimeout> | null };

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
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error("Could not reach Perry's browser.")), { once: true }); });
  const tab: Tab = { child, ws, next: 0, pending: new Map(), listeners: new Set(), idle: null };
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (message.id !== undefined) {
      const waiting = tab.pending.get(message.id);
      tab.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    } else if (message.method) {
      for (const listener of tab.listeners) listener(message.method, message.params);
    }
  });
  const gone = () => { box.__perryBrowser = null; for (const waiting of tab.pending.values()) waiting.reject(new Error("Perry's browser closed.")); };
  ws.addEventListener("close", gone);
  child.on("exit", gone);
  await send(tab, "Page.enable");
  await send(tab, "Runtime.enable");
  return tab;
}

function send(tab: Tab, method: string, params: object = {}): Promise<any> {
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

async function evaluate<T>(open: Tab, expression: string): Promise<T> {
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
