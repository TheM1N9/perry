import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/pet-open-in-tab/run.ts <outDir>
// The pet's "open in the dashboard" reuses a dashboard tab already open. A
// fresh Perry (production build, `pnpm build` first), the pet's page (/pet)
// and dashboard tabs in one headless Chrome: tabs in windows of their own are
// in view, a background tab is hidden. There is no Electron here, so the pet's
// new-tab fallback is its plain-browser one, window.open, recorded instead of
// opened. Nothing reaches the owner's desktop.
//
// Ways it could fail, written down before the checks:
//   1. No dashboard tab open: nothing opens at all (no fallback), or the
//      fallback opens without waiting for a tab to claim.
//   2. A tab is open: it goes there, and a new tab opens as well.
//   3. Two tabs open: both go there, or neither does.
//   4. A hidden tab wins over one in view.
//   5. Only a hidden tab open: it never takes it, and a new tab opens.
//   6. A request replays: a tab opened (or reloaded) later jumps to a page
//      asked for earlier, taken or never taken.
//   7. The tab lands on the wrong page: another path, or without its query.
//   8. The tab reloads the page instead of moving within the app.
//   9. A path that is not the dashboard's own (another site, a script) is
//      followed.
//  10. Two claims at once both win.
//  11. The functions answer without the dashboard key.
//  12. The panel's other links ("Open Perry") still always open a new tab.
//  13. A page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-open-in-tab/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pet-open-in-tab-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-pet-open-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
let serverLog = "";
const server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { serverLog += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk; });
const stop = (child: ChildProcess) => { if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
let chromeWs: WebSocket | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: chat, title: "Groceries for the week" }).catch(() => {});
  const chatPath = `/chat/${chat}`;

  // --- The pet's page, in the tab the helper opened ---------------------------------------------
  browser = await openChat(BASE, KEY);
  const pet = browser;
  await pet.evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(chat)}); true`);
  await pet.send("Page.navigate", { url: `${BASE}/pet` });
  await until(() => pet.evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`), "the pet's page", 30);
  // His new-tab fallback outside Electron is window.open: recorded, not opened.
  await pet.evaluate(`window.__opened = []; window.open = (url) => { window.__opened.push({ url: String(url), at: Date.now() }); return null; }; true`);
  const opened = () => pet.evaluate(`window.__opened`) as Promise<Array<{ url: string; at: number }>>;
  /** A real click (a user gesture, pointer events and all) in the middle of what the selector finds. */
  const click = async (selector: string) => {
    const box = await pet.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`) as { x: number; y: number } | null;
    if (!box) throw new Error(`nothing to click: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) await pet.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, pointerType: "mouse" });
  };
  await click('button[aria-label^="Perry."]');
  const ARROW = 'button[aria-label="Open this chat in Perry"]';
  await until(() => pet.evaluate(`Boolean(document.querySelector(${JSON.stringify(ARROW)}))`), "the pet's chat tab with its arrow", 15);
  await sleep(1_000);
  await pet.send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, "pet-chat-arrow.png"), Buffer.from(image.data, "base64")));

  // --- Dashboard tabs, driven through Chrome itself ---------------------------------------------
  const version = await (await fetch(`http://127.0.0.1:${pet.port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = chromeWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let nextId = 0;
  const waiting = new Map<number, (message: any) => void>();
  const tabErrors: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") tabErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  const cdp = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((done, fail) => {
    const id = ++nextId;
    waiting.set(id, (message) => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  type Tab = { name: string; evaluate: (expression: string) => Promise<any>; where: () => Promise<string>; goTo: (path: string) => Promise<void>; shot: (file: string) => Promise<void>; leave: () => Promise<void>; close: () => Promise<void> };
  // A background tab beside the pet's page, made now while his is the only window, so it stays hidden behind his;
  // it waits on a blank page, not the dashboard, until the checks want it.
  const { targetId: backgroundTarget } = await cdp("Target.createTarget", { url: "about:blank", background: true });
  /** A dashboard tab: in a window of its own (in view), or the background tab (hidden). */
  const openTab = async (name: string, path: string, how: "window" | "background"): Promise<Tab> => {
    const targetId: string = how === "background" ? backgroundTarget : (await cdp("Target.createTarget", { url: `${BASE}${path}`, newWindow: true })).targetId;
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    await cdp("Runtime.enable", {}, sessionId);
    if (how === "background") await cdp("Page.navigate", { url: `${BASE}${path}` }, sessionId);
    const evaluate = async (expression: string) => {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const ready = async () => {
      await until(() => evaluate(`Boolean(document.querySelector('a[href="/todos"]'))`), `${name} to load`, 30);
      // Survives a move within the app; a reload would lose it.
      // And each page the app moves to is written down, for the home ("/"), which goes straight on to the last chat.
      await evaluate(`window.__sameDocument = true; window.__pushed = []; const push = history.pushState.bind(history); history.pushState = (state, title, url) => { const to = new URL(String(url), location.href); window.__pushed.push(to.origin === location.origin ? to.pathname + to.search : to.href); return push(state, title, url); }; true`);
      await sleep(500);
    };
    await ready();
    return {
      name,
      evaluate,
      where: () => evaluate(`location.pathname + location.search`),
      goTo: async (to) => { await cdp("Page.navigate", { url: `${BASE}${to}` }, sessionId); await sleep(300); await ready(); },
      shot: async (file) => { const image = await cdp("Page.captureScreenshot", { format: "png" }, sessionId); writeFileSync(join(outDir, file), Buffer.from(image.data, "base64")); },
      leave: async () => { await cdp("Page.navigate", { url: "about:blank" }, sessionId); await sleep(500); },
      close: () => cdp("Target.closeTarget", { targetId }).then(() => {}),
    };
  };
  /** Where each tab is once things settle, after a click on the pet's arrow. */
  const clickAndSettle = async (selector = ARROW, ms = 3_500) => {
    const before = (await opened()).length;
    const at = Date.now();
    await click(selector);
    await sleep(ms);
    return { newTabs: (await opened()).slice(before), at };
  };

  // --- 1. No dashboard tab open: the fallback opens a new one, after waiting ---------------------
  let afterFallback: string;
  {
    const { newTabs, at } = await clickAndSettle(ARROW, 2_200);
    const waited = newTabs[0] ? newTabs[0].at - at : null;
    check("noTabOpensNewTab", newTabs.length === 1 && newTabs[0].url === chatPath && waited !== null && waited >= 1_400, { newTabs: newTabs.map((tab) => tab.url), waitedMs: waited });
    // --- 6. Nothing replays: a tab opened straight after (the pet took his own ask back) ...
    const early = await openTab("tab opened just after", "/todos", "window");
    notes.earlyTabOpenedMsAfterClick = Date.now() - at;
    await sleep(2_000);
    afterFallback = await early.where();
    await early.close();
  }
  // ... and one opened after an ask nobody took (the pet gone mid-wait).
  await call<string>("pet:askToOpen", { key: KEY, path: "/memory" });
  await sleep(6_000);
  const shown = await openTab("tab in view", "/todos", "window");
  await sleep(2_500);
  check("noReplayOnLaterTab", afterFallback === "/todos" && (await shown.where()) === "/todos", { afterFallback, afterUntaken: await shown.where() });

  // --- 2, 8. One tab in view: it goes there, within the app, and no new tab -------------------------
  {
    const { newTabs } = await clickAndSettle();
    const now = await shown.where();
    const sameDocument = await shown.evaluate(`window.__sameDocument === true`);
    if (now === chatPath) {
      await until(() => shown.evaluate(`document.body.innerText.includes("Groceries for the week")`), "the chat to show", 10).catch(() => {});
      await shown.shot("tab-reused.png");
    }
    check("oneTabReused", now === chatPath && newTabs.length === 0, { now, newTabs: newTabs.map((tab) => tab.url) });
    check("movedWithinApp", sameDocument === true, { sameDocument });
    // Reloaded, it stays: the ask was taken.
    await shown.goTo("/todos");
    await sleep(2_000);
    check("noReplayOnReload", (await shown.where()) === "/todos", await shown.where());
  }

  // --- 3. Two tabs in view: exactly one goes, three times over ----------------------------------
  {
    const other = await openTab("second tab in view", "/memory", "window");
    const rounds: Array<{ first: string; second: string; newTabs: number }> = [];
    for (let round = 0; round < 3; round++) {
      const { newTabs } = await clickAndSettle();
      const first = await shown.where();
      const second = await other.where();
      rounds.push({ first, second, newTabs: newTabs.length });
      if (first === chatPath) await shown.goTo("/todos");
      if (second === chatPath) await other.goTo("/memory");
    }
    check("twoTabsOneMoves", rounds.every((round) => [round.first, round.second].filter((where) => where === chatPath).length === 1 && round.newTabs === 0), rounds);
    await other.close();
  }

  // --- 4. A hidden tab and one in view: the one in view wins -------------------------------------
  const hidden = await openTab("hidden tab", "/memory", "background");
  {
    const visibility = { shown: await shown.evaluate(`document.visibilityState`), hidden: await hidden.evaluate(`document.visibilityState`) };
    const rounds: Array<{ shown: string; hidden: string; newTabs: number }> = [];
    for (let round = 0; round < 3; round++) {
      const { newTabs } = await clickAndSettle();
      rounds.push({ shown: await shown.where(), hidden: await hidden.where(), newTabs: newTabs.length });
      if (rounds.at(-1)!.shown === chatPath) await shown.goTo("/todos");
      if (rounds.at(-1)!.hidden === chatPath) await hidden.goTo("/memory");
    }
    check("visibleBeatsHidden", visibility.shown === "visible" && visibility.hidden === "hidden"
      && rounds.every((round) => round.shown === chatPath && round.hidden === "/memory" && round.newTabs === 0), { visibility, rounds });
  }

  // --- 12. The panel's "Open Perry" goes to the tab too ----------------------------------------
  {
    const { newTabs } = await clickAndSettle('button[aria-label="Open Perry"]');
    const pushed = await shown.evaluate(`window.__pushed`) as string[];
    check("openPerryReusesTab", pushed[0] === "/" && (await hidden.where()) === "/memory" && newTabs.length === 0, { pushed, hidden: await hidden.where(), newTabs: newTabs.map((tab) => tab.url) });
    await shown.goTo("/todos");
  }

  // --- 7, 9. The path, query and all; and only the dashboard's own ---------------------------------
  {
    await call<string>("pet:askToOpen", { key: KEY, path: "/settings/activity?status=error" });
    await until(async () => (await shown.where()) === "/settings/activity?status=error", "the activity log", 5).catch(() => {});
    const now = await shown.where();
    check("pathWithQueryKept", now === "/settings/activity?status=error" && (await hidden.where()) === "/memory", { now });
    await shown.goTo("/todos");
    const bad = ["//evil.example/x", "/\\evil.example", "javascript:alert(1)", "https://evil.example/", ""];
    const stored: string[] = [];
    for (const path of bad) {
      await call<string>("pet:askToOpen", { key: KEY, path });
      stored.push((await call<{ path: string }>("pet:openRequest", { key: KEY })).path);
    }
    await sleep(1_500);
    const origin = await shown.evaluate(`location.origin`);
    const pushed = await shown.evaluate(`window.__pushed`) as string[];
    check("onlyOwnPaths", stored.every((path) => path === "/") && origin === BASE && pushed.length > 0 && pushed.every((path) => path === "/" || path.startsWith("/chat")), { stored, origin, pushed });
    await shown.goTo("/todos");
  }

  // --- 5. Only a hidden tab: it takes it, after its wait, and no new tab ---------------------------
  // The tab in view leaves the dashboard (closing it could bring the hidden one into view).
  await shown.leave();
  {
    const visibility = await hidden.evaluate(`document.visibilityState`);
    const { newTabs } = await clickAndSettle();
    check("hiddenAloneStillTakes", visibility === "hidden" && (await hidden.where()) === chatPath && newTabs.length === 0, { visibility, hidden: await hidden.where(), newTabs: newTabs.map((tab) => tab.url) });
  }
  await shown.close();
  await hidden.close();

  // --- 10, 11. On the server: one claim wins; no key, no answer ------------------------------------
  {
    const request = await call<string>("pet:askToOpen", { key: KEY, path: "/todos" });
    const claims = await Promise.all([1, 2, 3, 4].map(() => call<boolean>("pet:claimOpen", { key: KEY, request })));
    check("firstClaimWins", claims.filter(Boolean).length === 1, claims);
    const refused = await Promise.all([
      call("pet:askToOpen", { key: "wrong", path: "/" }),
      call("pet:openRequest", { key: "wrong" }),
      call("pet:claimOpen", { key: "wrong", request }),
    ].map((attempt) => attempt.then(() => false, () => true)));
    check("keyRequired", refused.every(Boolean), refused);
  }

  check("pagesDidNotThrow", pet.errors.length === 0 && tabErrors.length === 0, [...pet.errors, ...tabErrors].slice(0, 5));
} catch (error) {
  notes.error = String(error);
} finally {
  chromeWs?.close();
  browser?.close();
  stop(server);
  await sleep(1_500);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const passed = Object.keys(checks).length === 14 && Object.values(checks).every(Boolean);
const result = { ranAt: new Date().toISOString(), passed, checks, notes, serverLog: serverLog.split("\n").filter((line) => /error/i.test(line)).slice(-20) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed, checks, notes }, null, 2));
process.exit(passed ? 0 : 1);
