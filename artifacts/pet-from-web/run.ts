import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Board } from "../../convex/todos";
import { openChat, sleep } from "../browser";

// bun artifacts/pet-from-web/run.ts <outDir>
// Turning the desktop pet on and off from the dashboard (Settings → Desktop
// pet), and `perry pet` in a terminal, against a fresh Perry of its own
// (PERRY_HOME, port): the real server, the real `perry pet`, the real Electron.
// No runner, Codex or Telegram. Windows (the login entry is read from the
// registry). Safe beside the owner's own pet: that is checked, not assumed.
//
// Ways it could fail:
//   1. The dashboard offers no way to turn him on, or says he is on when not.
//   2. Turn on does nothing, or nothing shows while it works: the step it is
//      on must show, and then "On your desktop", with his page open.
//   3. It starts him at login under the owner's own entry, or answers for or
//      quits the owner's own pet: a Perry with its own PERRY_HOME must have
//      its own entry and its own pet, and the owner's must be left as it was.
//   4. Turn off leaves him running, or starting at login, or the dashboard
//      saying he is on.
//   5. A failure is swallowed: when `perry pet` cannot even start, the page
//      must say so, and offer to try again.
//   6. In a terminal, `perry pet` says nothing of its steps, or claims he is
//      on the screen before he is; its step lines for the dashboard leak into
//      a terminal's output.
//   7. The pages throw.
//   8. A repeat typed into a to-do ("every day at 11") is not read, or read
//      but not kept; its row does not say how it repeats; its menu does not
//      change it; ticked off, no next one is made, or not on a day it
//      falls on; "Doesn't repeat" leaves it repeating.
//   9. His theme picked in Settings is not saved in his pet.json, loses where
//      he stands, or does not reach him until he restarts: his page must go
//      dark and light while he runs.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-from-web/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
if (process.platform !== "win32") throw new Error("This check reads the Windows registry; run it on Windows.");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pet-from-web-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-pet-web-"));
// Away from the bottom-right corner, where the owner's own pet may be standing.
writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 40, y: 60 }));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const ownEntry = `Perry pet-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
const entry = (name: string) => {
  const found = spawnSync("reg", ["query", RUN_KEY, "/v", name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "" : null;
};
/** Pets running on this computer that are not this checkout's: the owner's own. */
const otherPets = () => (spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notlike '*${REPO.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`],
{ encoding: "utf8", windowsHide: true }).stdout ?? "").trim().split(/\s+/).filter(Boolean).sort();
const before = { entry: entry("Perry pet"), pets: otherPets() };
notes.ownersPetBefore = before;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  PERRY_BUN: process.execPath, PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS),
};
delete env.TELEGRAM_BOT_TOKEN;
delete env.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "COMPOSIO_API_KEY") delete env[name];
const logs: Record<string, string> = {};
function server(name: string, extra: Record<string, string> = {}): ChildProcess {
  logs[name] = "";
  const child = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(extra.PERRY_PORT ?? PORT)],
    { cwd: REPO, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  return child;
}
const stop = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
async function call<T>(base: string, path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${base}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 30) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}
const ownersPets: Array<{ at: string; step: string; pets: string[] }> = [];
async function check(name: string, test: () => Promise<boolean> | boolean, seconds = 20) {
  checks[name] = await until(test, name, seconds).then(() => true, () => false);
  if (!checks[name]) console.log(`FAILED: ${name}`);
  ownersPets.push({ at: new Date().toISOString(), step: name, pets: otherPets() });
}
const petPage = () => fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`).then((r) => r.json() as Promise<Array<{ url: string }>>).then((list) => list.some((item) => item.url.startsWith(`${BASE}/pet`)), () => false);
/** His page, over the DevTools protocol: what it shows, and pictures of it (not of the screen). */
async function petTab() {
  const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const target = list.find((item) => item.url.startsWith(`${BASE}/pet`));
  if (!target) throw new Error("his page is not open");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const waiting = new Map<number, (message: any) => void>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
  });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  return { send, evaluate, close: () => ws.close() };
}
type Tab = { send: (method: string, params?: object) => Promise<any>; evaluate: (expression: string) => Promise<any> };
/** A click on what `element` finds, as a mouse gives it: menus open on the press. */
async function clickOn(tab: Tab, element: string): Promise<boolean> {
  const box = await tab.evaluate(`(() => { const e = ${element}; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`) as { x: number; y: number } | null;
  if (!box) return false;
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  return true;
}
const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim() === ${JSON.stringify(text)})`;
const config = () => JSON.parse(readFileSync(join(home, "pet.json"), "utf8")) as { x?: number; y?: number; theme?: string };
const perry = (...args: string[]) => {
  const ran = spawnSync(process.execPath, [join(REPO, "scripts", "perry.ts"), ...args], { cwd: REPO, env, encoding: "utf8", windowsHide: true });
  return `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
};

const main = server("server");
let dashboard: Awaited<ReturnType<typeof openChat>> | null = null;
let broken: ChildProcess | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  dashboard = await openChat(BASE, KEY);
  const page = () => dashboard!.evaluate(`document.querySelector("main")?.innerText ?? ""`) as Promise<string>;
  const button = (label: string) => dashboard!.evaluate(`(() => { const b = [...document.querySelectorAll("main button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`) as Promise<boolean>;
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await dashboard!.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // 1. Offered, and not claimed to be on.
  await dashboard.send("Page.navigate", { url: `${BASE}/settings?tab=general` });
  await check("offeredInSettings", async () => /Desktop pet[\s\S]*Not on your desktop[\s\S]*Turn on/.test(await page()), 30);
  await shot("settings-off.png");

  // 2. Turned on: each step shows, then he is on the desktop, his page open.
  const steps = new Set<string>();
  await button("Turn on");
  const watching = (async () => { for (let i = 0; i < 400 && !checks.onFromWeb; i++) { const text = await page().catch(() => ""); const step = text.match(/(Installing[^\n]*|Getting Electron ready…|Starting him…)/)?.[1]; if (step) steps.add(step); await sleep(150); } })();
  await check("onFromWeb", async () => (await page()).includes("On your desktop"), 180);
  await watching;
  notes.stepsShown = [...steps];
  checks.stepsShown = steps.has("Starting him…");
  checks.petPageOpen = await petPage();
  await shot("settings-on.png");

  // 3. His own login entry; the owner's own entry and pet as they were.
  notes.ownEntry = entry(ownEntry);
  checks.ownLoginEntry = Boolean(notes.ownEntry && (notes.ownEntry as string).includes(join(REPO, "pet")));
  checks.ownersEntryUntouched = entry("Perry pet") === before.entry;
  checks.ownersPetUntouched = JSON.stringify(otherPets()) === JSON.stringify(before.pets);

  // 8. Repeats, from the To-dos page: typed, kept, shown, changed from the row's menu, made again when done, stopped.
  await dashboard.send("Page.navigate", { url: `${BASE}/todos` });
  await until(() => dashboard!.evaluate(`Boolean(document.querySelector('input[aria-label="Add a to-do"]'))`), "the to-dos page", 30);
  await dashboard.evaluate(`document.querySelector('input[aria-label="Add a to-do"]').focus()`);
  await dashboard.send("Input.insertText", { text: "Stretch every day at 11" });
  await check("repeatPreviewed", async () => /Every day at 11:00/.test(await page()), 10);
  await dashboard.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await dashboard.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  const stretch = async () => (await call<Board>(BASE, "todos:board", { key: KEY })).open.find((todo) => todo.title === "Stretch");
  await check("repeatAdded", async () => (await stretch())?.repeat === "0 11 * * *");
  const first = await stretch();
  const at11 = new Date();
  at11.setHours(11, 0, 0, 0);
  if (at11.getTime() <= Date.now()) at11.setDate(at11.getDate() + 1);
  notes.firstStretch = first && { ...first, due: first.dueAt && new Date(first.dueAt).toString() };
  checks.repeatFirstIsNext11 = first?.dueAt === at11.getTime();
  await check("repeatShownOnRow", async () => /Stretch\s*Daily/.test(await page()), 10);
  await clickOn(dashboard, `document.querySelector('[aria-label^="Repeats daily"]')`);
  await check("repeatMenuOpens", () => dashboard!.evaluate(`Boolean(${byText("[role=menuitemradio]", "Weekdays")})`), 10);
  await shot("todos-repeat-menu.png");
  await clickOn(dashboard, byText("[role=menuitemradio]", "Weekdays"));
  await check("repeatChanged", async () => (await stretch())?.repeat === "0 11 * * 1-5");
  await check("repeatShowsWeekdays", async () => /Stretch\s*Weekdays/.test(await page()), 10);
  await dashboard.evaluate(`document.querySelector('[aria-label="Done: “Stretch”"]').click()`);
  await check("repeatMadeAgain", async () => {
    const next = await stretch();
    if (!next?.dueAt || !first?.dueAt || next.id === first.id) return false;
    const due = new Date(next.dueAt);
    notes.nextStretch = { ...next, due: due.toString() };
    return next.repeat === "0 11 * * 1-5" && next.dueAt > first.dueAt && due.getDay() >= 1 && due.getDay() <= 5 && due.getHours() === 11 && due.getMinutes() === 0;
  });
  await shot("todos-repeat.png");
  await clickOn(dashboard, `document.querySelector('[aria-label^="Repeats weekdays"]')`);
  await until(() => dashboard!.evaluate(`Boolean(${byText("[role=menuitemradio]", "Doesn’t repeat")})`), "the repeat menu", 10).catch(() => {});
  await clickOn(dashboard, byText("[role=menuitemradio]", "Doesn’t repeat"));
  await check("repeatStopped", async () => { const next = await stretch(); return Boolean(next && next.repeat === undefined); });

  // 9. His theme, from Settings: kept in his pet.json beside where he stands, and he changes while he runs.
  await dashboard.send("Page.navigate", { url: `${BASE}/settings?tab=general` });
  await until(async () => (await page()).includes("On your desktop"), "settings", 30);
  const pick = (label: string) => dashboard!.evaluate(`(() => { const b = ${byText('[role=radiogroup][aria-label="Pet theme"] [role=radio]', label)}; b?.click(); return Boolean(b); })()`);
  const pet = await petTab();
  try {
    const dark = () => pet.evaluate(`document.documentElement.classList.contains("dark")`) as Promise<boolean>;
    const petShot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await pet.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    // His panel open on his to-dos, to see the theme on.
    await clickOn(pet, `document.querySelector('button[aria-label^="Perry. Click to open him"]')`);
    await until(() => pet.evaluate(`Boolean(document.querySelector('section[aria-label="Perry"]'))`), "his panel", 10);
    await pet.evaluate(`${byText("[role=tab]", "To-dos")}?.click()`);
    checks.themePicked = await pick("Dark");
    await check("themeSaved", () => { const saved = config(); return saved.theme === "dark" && saved.x !== undefined && saved.y !== undefined; });
    await check("petGoesDark", () => dark(), 10);
    await sleep(500);
    await petShot("pet-dark.png");
    await pick("Light");
    await check("petGoesLight", async () => config().theme === "light" && !(await dark()), 10);
    await sleep(500);
    await petShot("pet-light.png");
    await pick("System");
    await check("themeBackToSystem", () => config().theme === "system");
    checks.settingsShowsPicked = await dashboard.evaluate(`${byText('[role=radiogroup][aria-label="Pet theme"] [role=radio]', "System")}?.getAttribute("aria-checked") === "true"`) as boolean;
    await shot("settings-pet-theme.png");
  } finally {
    pet.close();
  }

  // 4. Turned off: gone, not at login, and said so.
  await button("Turn off");
  await check("offFromWeb", async () => (await page()).includes("Not on your desktop"), 60);
  await check("petQuits", async () => !(await petPage()), 20);
  checks.ownEntryGone = entry(ownEntry) === null;
  checks.ownersEntryStillUntouched = entry("Perry pet") === before.entry;
  checks.ownersPetStillRunning = JSON.stringify(otherPets()) === JSON.stringify(before.pets);
  await dashboard.send("Page.navigate", { url: `${BASE}/todos` });
  await check("offeredOnTodos", async () => /Perry on your desktop[\s\S]*Not on your desktop[\s\S]*Turn on/.test(await page()), 30);
  checks.noPageErrors = dashboard.errors.length === 0;
  notes.pageErrors = dashboard.errors;

  // 6. In a terminal: each step said, and only a pet that has shown up said to be on the screen; no ::step lines.
  // ora colours its marks; the words are what is checked.
  const said = perry("pet").replace(/\x1b\[[0-9;]*m/g, "");
  writeFileSync(join(outDir, "perry-pet.txt"), said);
  checks.terminalSaysSteps = /✔ Electron ready/.test(said) && /✔ on your screen/.test(said);
  checks.terminalHasNoStepLines = !said.includes("::step");
  checks.terminalPetUp = await petPage();
  const off = perry("pet", "off");
  writeFileSync(join(outDir, "perry-pet-off.txt"), off.replace(/\x1b\[[0-9;]*m/g, ""));
  await check("terminalOff", async () => !(await petPage()), 20);

  // 5. When it cannot even start, the page says why, and offers to try again.
  const brokenPort = await freePort();
  broken = server("broken", { PERRY_PORT: String(brokenPort), PERRY_BUN: join(home, "no-bun-here.exe"), PERRY_HOME: mkdtempSync(join(tmpdir(), "perry-pet-web-broken-")) });
  const brokenBase = `http://127.0.0.1:${brokenPort}`;
  await until(() => fetch(`${brokenBase}/api/backend/http/health`).then((r) => r.ok, () => false), "the second server to start", 90);
  await call(brokenBase, "pet:turnOn", { key: KEY });
  const failed = await call<{ setup: { state: string; error?: string } | null }>(brokenBase, "pet:status", { key: KEY });
  notes.failure = failed.setup;
  checks.failureSaid = failed.setup?.state === "failed" && /Could not run perry/.test(failed.setup.error ?? "");
  // Another port is another origin, not yet unlocked in this browser: the key goes in the fragment, as `perry open` does.
  await dashboard.send("Page.navigate", { url: `${brokenBase}/settings?tab=general#key=${encodeURIComponent(KEY)}` });
  await check("failureOnPage", async () => /Could not run perry[\s\S]*Try again/.test(await page()), 30);
  await shot("settings-failed.png");

  checks.ownersEntryUntouchedAtEnd = entry("Perry pet") === before.entry;
  checks.ownersPetUntouchedAtEnd = JSON.stringify(otherPets()) === JSON.stringify(before.pets);
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
} finally {
  dashboard?.close();
  // Never leave this checkout's pet running or starting at login.
  perry("pet", "off");
  stop(broken);
  stop(main);
  const result = { ranAt: new Date().toISOString(), checks, notes, ownersPets, logTail: logs.server?.split("\n").slice(-15) };
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  console.log(failed.length ? `FAILED: ${failed.join(", ")}` : `all ${Object.keys(checks).length} checks passed`);
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  process.exit(failed.length ? 1 : 0);
}
