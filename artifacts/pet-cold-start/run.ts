import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/pet-cold-start/run.ts <outDir>
// Writes result.json and windows.json (what Windows said about his windows, step by step). before-fix.json here is the
// same run on pet/main.js from before the fix: his window had seven page children by the time he showed.
// Issue #191: after the computer restarts, the desktop pet lets every click
// through him. At login he starts before Perry's server; this starts a test
// pet (the real pet/main.js in Electron, its own PERRY_HOME, port, hotkey and
// lock) while its Perry (a production build, `pnpm build` first) is not up,
// brings the server up some seconds later, and checks he then takes clicks;
// then the other ways his page is loaded again. Windows only. No real mouse or
// keys unless PERRY_E2E_DESKTOP=1; no model turns; the owner's pet, its lock,
// its login entry and ~/.perry are only looked at, before and after.
//
// How he takes clicks: his window lets every click through (Electron's
// setIgnoreMouseEvents) except while his page says the pointer is on him
// (pet:solid). Meanwhile Electron forwards the pointer's moves to the page from
// a low-level mouse hook, posting them to the child window Chromium made for
// the window's first page (it keeps only that one: legacy_window_ in
// shell/browser/native_window_views_win.cc). Real moves cannot be made here
// without moving the owner's pointer, so each step checks, through Windows
// itself (windows.ps1): that the window shown still has the page child it was
// made with (where the forwarded moves go); that a move posted to that child,
// as the hook posts it, reaches the page over him; and that a move over him on
// the page (DevTools) makes Windows hit-test his window there, and a move off
// him lets clicks through again.
//
// Ways it could fail:
//   1. A load that failed while the server was down (an error page, a retry)
//      gives his window a new page child; the hook's moves go to the old, gone
//      one, the page never hears the pointer come onto him, and he lets every
//      click through: the window shown must have only ever had one page child.
//   2. While the server is down, an empty or error window shows: no window of
//      his may be on screen until his page is there.
//   3. He never comes up once the server does (the retries stop): his window
//      must show his page within 60 s of the server answering.
//   4. His page's pointer tracking never starts (it loaded while the window was
//      hidden), or pet:solid does not reach the window: a move over him must
//      make Windows hit-test his window at his body, and a move off him must
//      let clicks through there again.
//   5. A move posted to his window's page child, as Electron's hook posts it,
//      does not reach his page.
//   6. A window is left behind, or two show: one window of his per pet, shown.
//   7. He is off the screen or under other windows: his window inside the
//      screen's work area, and always on top (WS_EX_TOPMOST).
//   8. The circle that hides him sits over him and takes the clicks: its window
//      must let every click through (WS_EX_TRANSPARENT), and a click at his body
//      land on him.
//   9. `--reload` (after `perry update`) does not load his page again (the
//      address differs only after #, which a browser takes as the same page),
//      or loads it into a window whose page child changed: it must be a new
//      page (a mark left on the old one gone), and 1, 4 and 5 hold.
//  10. `--reload` while Perry's server restarts (an update): he must stay on
//      screen as he was, then come back on the new page once it is up; 1, 4, 5.
//  11. His page reloads itself (DevTools' reload, as the page or Next.js may):
//      1, 4 and 5 must hold after.
//  12. His page's process crashes: back within 20 s; 1, 4 and 5.
//  13. Hidden (as a failed load hides him), then shown by `perry pet` or the
//      hotkey (a second start): 4 and 5 must hold; the hook is put back on show.
//  14. `perry update --restart` (--quit --restart): the new pet process takes
//      over (one pet process, a new one), and 1, 4 and 5 hold for it.
//  15. A stale "Let clicks through him" (ghost) from pet.json: with it set, a
//      move over him must leave clicks going through; without it (1-14), not.
//  16. The test touches the owner's pet: the owner's pet process, its login
//      entry "Perry pet" and ~/.perry/pet.json must be the same after as before.
//  17. PERRY_E2E_DESKTOP=1 only (moves the real pointer, over this test's own
//      windows, away from the owner's pet in the bottom-right corner): a real
//      click on him after the cold start opens his panel; one on the empty part
//      of his window reaches a test window under it; and after his process is
//      held busy for 1.5 s while the real pointer moves over his window (Windows
//      drops a low-level hook that does not answer in time), a real click on
//      him still opens his panel.
//  18. His page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-cold-start/run.ts <outDir>");
if (process.platform !== "win32") throw new Error("this check is for Windows, where the pet's pointer comes through a mouse hook");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PET_DIR = join(REPO, "pet");
const WINDOWS_PS1 = join(REPO, "artifacts", "pet-cold-start", "windows.ps1");
const REAL_MOUSE = process.env.PERRY_E2E_DESKTOP === "1";
/** The real mouse, for PERRY_E2E_DESKTOP=1 only (realClick): before the checks, which use it. */
const MOUSE = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class M { [DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i); }'; [M]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null; $w = [M]::GetSystemMetrics(0); $h = [M]::GetSystemMetrics(1)";
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS = await freePort();
const INSPECT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pet-cold-start-e2e-key";
/** How long Perry's server stays down after the pet starts, as at login. */
const DOWN_MS = 12_000;
const home = mkdtempSync(join(tmpdir(), "perry-pet-cold-start-"));
// A hotkey no one else has, and a spot in the bottom-left corner: away from the owner's pet (bottom right) and the circle (bottom middle).
const TALK = "CommandOrControl+Alt+Shift+F11";
const petJson = (extra: object = {}) => writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 0, y: 5000, hotkey: TALK, ...extra }));
petJson();

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => {
  checks[name] = ok;
  if (note !== undefined) notes[name] = note;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && note !== undefined ? ` ${JSON.stringify(note)}` : ""}`);
};
async function until<T>(test: () => Promise<T> | T, what: string, seconds = 60): Promise<NonNullable<T>> {
  for (let i = 0; i < seconds * 5; i++) {
    const value = await Promise.resolve().then(test).catch(() => undefined);
    if (value) return value as NonNullable<T>;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS), PERRY_PET_HOTKEY: TALK,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const logs = { server: "", pet: "" };
const stop = (child: ChildProcess | number | null | undefined) => {
  const pid = typeof child === "number" ? child : child?.pid;
  if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
};
const ps = (script: string) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout.trim();
const win32 = (...args: string[]) => JSON.parse(spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_PS1, ...args], { encoding: "utf8", windowsHide: true }).stdout || "null");

// --- The owner's pet, looked at only -------------------------------------------------------------------------
/** Electron processes that are a pet's main process, with their command lines. */
const petProcesses = () => JSON.parse(ps("ConvertTo-Json -Compress @(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { @{ pid = $_.ProcessId; cmd = $_.CommandLine } })") || "[]") as Array<{ pid: number; cmd: string }>;
const ownerState = () => {
  const ownPet = join(homedir(), ".perry", "pet.json");
  const loginEntry = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Perry pet"], { encoding: "utf8" }).stdout.trim();
  // The owner's pet is the one the login entry starts: Electron, then his folder.
  const ownerDir = loginEntry.match(/"([^"]+)"\s*$/)?.[1];
  return {
    // All but where he stands, which the owner changes by dragging him while this runs.
    petJson: existsSync(ownPet) ? createHash("sha256").update(JSON.stringify({ ...JSON.parse(readFileSync(ownPet, "utf8")), x: undefined, y: undefined })).digest("hex") : null,
    loginEntry,
    pets: ownerDir ? petProcesses().filter((item) => item.cmd.includes(ownerDir)).map((item) => item.pid).sort() : [],
  };
};
const ownerBefore = ownerState();
notes.ownerBefore = { ...ownerBefore, loginEntry: Boolean(ownerBefore.loginEntry) };

// --- Perry's server ----------------------------------------------------------------------------------------
let server: ChildProcess | null = null;
const startServer = () => {
  server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout?.on("data", (chunk: Buffer) => { logs.server += chunk; });
  server.stderr?.on("data", (chunk: Buffer) => { logs.server += chunk; });
};
const serverUp = () => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false);
const stopServer = async () => { stop(server); server = null; await until(async () => !(await serverUp()), "the server to stop", 20); };

// --- The pet: its process, and what Windows says about its windows -------------------------------------------
type Snap = { hwnd: number; title: string; visible: boolean; exstyle: number; rect: [number, number, number, number]; page: number[] };
const electron = spawnSync("node", ["-p", "require('electron')"], { cwd: PET_DIR, encoding: "utf8" }).stdout.trim();
let pet: ChildProcess | null = null;
let petPid = 0;
let watcher: ChildProcess | null = null;
/** Every change Windows reported in the pet's windows: when, and what. */
let history: Array<{ at: number; windows: Snap[] }> = [];
const timeline: Array<{ at: number; step: string } | { at: number; pid: number; windows: Array<Omit<Snap, "exstyle"> & { exstyle: string }> }> = [];
const mark = (step: string) => { timeline.push({ at: Date.now(), step }); console.log(`--- ${step}`); };
/** Windows' view of a pet process, every 30 ms, from as soon as it starts. */
function watch(pid: number) {
  stop(watcher);
  petPid = pid;
  history = [];
  watcher = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_PS1, "watch", String(pid), "30"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let buffer = "";
  watcher.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const seen = JSON.parse(line) as { at: number; windows: Snap[] };
      history.push(seen);
      timeline.push({ at: seen.at, pid, windows: seen.windows.map((w) => ({ ...w, exstyle: `0x${(w.exstyle >>> 0).toString(16)}` })) });
    }
  });
}
/** The circle that hides him (pet/main.js DISMISS_PAGE's title); his own window takes his page's title. */
const CIRCLE = "Perry: drop here to hide";
const latest = () => history.at(-1)?.windows ?? [];
const petWindows = () => latest().filter((w) => w.title !== CIRCLE);
const shown = () => petWindows().filter((w) => w.visible);
function launchPet(args: string[] = []) {
  const child = spawn(electron, [PET_DIR, ...args], { cwd: PET_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => { logs.pet += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs.pet += chunk; });
  return child;
}
/** Run as `perry pet`, `perry update` and the hotkey do: a second start, which tells the running pet and quits. */
const tellPet = (args: string[]) => spawnSync(electron, [PET_DIR, ...args], { cwd: PET_DIR, env, stdio: "ignore", timeout: 30_000 });

// --- His page, over DevTools ---------------------------------------------------------------------------------
type Tab = { send: (method: string, params?: object) => Promise<any>; evaluate: (expression: string) => Promise<any>; errors: string[]; url: string; close: () => void };
async function connect(url: string): Promise<Omit<Tab, "url">> {
  const ws = new WebSocket(url);
  await new Promise((done, fail) => { ws.addEventListener("open", done, { once: true }); ws.addEventListener("error", fail, { once: true }); });
  let id = 0;
  const waiting = new Map<number, (message: any) => void>();
  const errors: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  ws.addEventListener("close", () => { for (const done of waiting.values()) done({ error: { message: "closed" } }); waiting.clear(); });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((done, fail) => {
    if (ws.readyState !== WebSocket.OPEN) return fail(new Error(`${method}: closed`));
    const n = ++id;
    waiting.set(n, (message) => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Runtime.enable");
  return { send, evaluate, errors, close: () => ws.close() };
}
const pageErrors: string[] = [];
let tab: Tab | null = null;
/** His page as it is now: the newest of his windows' pages, with him on it. */
async function petTab(): Promise<Tab> {
  return until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json() as Array<{ id: string; url: string; type: string; webSocketDebuggerUrl: string }>;
    const pages = list.filter((item) => item.type === "page" && item.url.startsWith(`${BASE}/pet`));
    if (pages.length !== 1) return undefined;
    if (tab && tab.url === pages[0].webSocketDebuggerUrl) {
      if (await tab.evaluate("1").then(() => true, () => false)) return tab;
    }
    if (tab) { pageErrors.push(...tab.errors); tab.close(); }
    const fresh = { ...(await connect(pages[0].webSocketDebuggerUrl)), url: pages[0].webSocketDebuggerUrl };
    tab = fresh;
    return fresh;
  }, "his page", 60);
}
const himOnPage = async (t: Tab) => Boolean(await t.evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`));

// --- The pet's main process, over Node's inspector (only to hide his window, as a failed load does, and to hold it busy) --
async function mainProcess() {
  const list = await until(async () => (await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json()) as Array<{ webSocketDebuggerUrl: string }>, "the pet's inspector", 20);
  return connect(list[0].webSocketDebuggerUrl);
}

/**
 * Whether he takes clicks: Windows' own view of his window (1, 5, 6, 7), a move as the hook posts it reaching his
 * page (5), and a move over him on his page making Windows hit-test his window there, then not once off him (4).
 */
async function clickable(step: string, { ghost = false } = {}) {
  const t = await petTab();
  await until(() => himOnPage(t), `${step}: him on his page`, 60);
  await sleep(1_500);
  const windows = petWindows();
  const visible = windows.filter((w) => w.visible);
  check(`${step}:oneWindowShown`, windows.length === 1 && visible.length === 1, windows);
  const win = visible[0] ?? windows[0];
  if (!win) return;
  // 1. Every page child this window has had (none yet, the moment it is made, is not one): one, still there.
  const kids = new Set(history.flatMap((seen) => seen.windows.filter((w) => w.hwnd === win.hwnd && w.page.length).map((w) => w.page.join(","))));
  const firstSeen = history.find((seen) => seen.windows.some((w) => w.hwnd === win.hwnd));
  check(`${step}:pageChildKept`, kids.size === 1 && win.page.length === 1, { window: win.hwnd, pageChildren: [...kids], firstSeen: firstSeen?.at });
  const { x: wx, y: wy, scale, body, work } = await t.evaluate(`(() => {
    const r = document.querySelector('button[aria-label^="Perry."]').getBoundingClientRect();
    return { x: screenX, y: screenY, scale: devicePixelRatio, body: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, work: { left: screen.availLeft, top: screen.availTop, right: screen.availLeft + screen.availWidth, bottom: screen.availTop + screen.availHeight } };
  })()`) as { x: number; y: number; scale: number; body: { x: number; y: number }; work: { left: number; top: number; right: number; bottom: number } };
  const px = (n: number) => Math.round(n * scale);
  const [left, top, right, bottom] = win.rect;
  // 7. On the screen, and on top.
  check(`${step}:onScreenOnTop`, left >= px(work.left) - 1 && top >= px(work.top) - 1 && right <= px(work.right) + 1 && bottom <= px(work.bottom) + 1 && (win.exstyle & 0x8) !== 0, { rect: win.rect, work, exstyle: win.exstyle });
  const at = { x: px(wx + body.x), y: px(wy + body.y) };
  const onHim = Boolean(await t.evaluate(`Boolean(document.elementFromPoint(${body.x}, ${body.y})?.closest("[data-solid]"))`));
  // 5. A move posted to the page child, at his body, as Electron's hook posts it.
  await t.evaluate(`window.__moves = []; window.addEventListener("mousemove", (e) => window.__moves.push([e.clientX, e.clientY]), true); true`);
  win32("post", String(win.page[0]), String(0x200), String(px(body.x)), String(px(body.y)));
  await sleep(500);
  const moves = await t.evaluate("window.__moves") as Array<[number, number]>;
  check(`${step}:postedMoveReachesPage`, onHim && moves.some(([x, y]) => Math.abs(x - body.x) <= 2 && Math.abs(y - body.y) <= 2), { moves: moves.slice(0, 5), body, onHim });
  // 4. A move over him on his page: Windows hit-tests his window at his body (a click there is his); off him, not.
  // Up to three tries: something of the owner's that pops up over everything (a taskbar preview) can be there a moment.
  type Hit = { hwnd: number; title: string; pid: number };
  // The title of a window that is not the test pet's (the owner's own) stays out of the results.
  const hit = (x: number, y: number) => { const h = win32("hit", String(x), String(y)) as Hit; return latest().some((w) => w.hwnd === h.hwnd) ? h : { ...h, title: "(another window)" }; };
  const tries: Array<{ over: Hit; transparent: boolean; off: Hit }> = [];
  for (let i = 0; i < 3; i++) {
    await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: body.x, y: body.y, button: "none", buttons: 0 });
    await sleep(400);
    const over = hit(at.x, at.y);
    // WS_EX_TRANSPARENT on his window: Windows passes clicks through it.
    const transparent = ((petWindows().find((w) => w.hwnd === win.hwnd)?.exstyle ?? 0x20) & 0x20) !== 0;
    await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 6, button: "none", buttons: 0 });
    await sleep(400);
    const off = hit(at.x, at.y);
    tries.push({ over, transparent, off });
    const settled = ghost ? over.hwnd !== win.hwnd && transparent : over.hwnd === win.hwnd && !transparent;
    if (settled && off.hwnd !== win.hwnd) break;
    await sleep(1_000);
  }
  const last = tries.at(-1)!;
  if (ghost) {
    check(`${step}:ghostLetsClicksThrough`, last.over.hwnd !== win.hwnd && last.transparent && last.off.hwnd !== win.hwnd, { tries, at });
  } else {
    check(`${step}:takesClickOnHim`, last.over.hwnd === win.hwnd && !last.transparent, { tries, at, window: win.hwnd });
    check(`${step}:letsClickThroughOffHim`, last.off.hwnd !== win.hwnd, { tries, at });
  }
  return { window: win, at, scale, t };
}

let main: Awaited<ReturnType<typeof mainProcess>> | null = null;
let catcherWindow: ChildProcess | null = null;
try {
  // --- 1-8. Cold start: the pet first, Perry's server only DOWN_MS later ---------------------------------------
  mark("pet starts; Perry's server is not up");
  pet = launchPet(REAL_MOUSE ? [`--inspect=${INSPECT}`] : []);
  watch(pet.pid!);
  const downFrom = Date.now();
  let shownWhileDown: Snap[] = [];
  while (Date.now() - downFrom < DOWN_MS) {
    shownWhileDown = shownWhileDown.length ? shownWhileDown : shown();
    await sleep(200);
  }
  check("nothingShownWhileServerDown", shownWhileDown.length === 0, shownWhileDown);
  mark("Perry's server starts");
  startServer();
  await until(serverUp, "the server to start", 90);
  const upAt = Date.now();
  mark("Perry's server answers");
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(() => shown().length > 0, "his window to show", 60).catch(() => {});
  check("showsOnceServerUp", shown().length > 0 && Date.now() - upAt < 60_000, { after: Date.now() - upAt });
  const cold = await clickable("coldStart");
  // 8. The circle that hides him: see-through to clicks, and not over him.
  const circle = latest().find((w) => w.title === CIRCLE);
  check("circleLetsClicksThrough", Boolean(circle) && ((circle!.exstyle & 0x20) !== 0), circle);

  // 17. Real clicks (PERRY_E2E_DESKTOP=1 only).
  if (REAL_MOUSE && cold) {
    main = await mainProcess();
    const [left, top, right, bottom] = cold.window.rect;
    const log = join(outDir, "..", `pet-cold-start-clicks-${PORT}.txt`);
    rmSync(log, { force: true });
    catcherWindow = catcher({ x: left, y: top, w: right - left, h: bottom - top }, log);
    await until(() => existsSync(log) && readFileSync(log, "utf8").includes("shown"), "the test window", 15);
    await sleep(500);
    const panelOpen = () => cold.t.evaluate(`Boolean(document.querySelector('section[aria-label="Perry"]'))`) as Promise<boolean>;
    realClick(cold.at.x, cold.at.y);
    check("realClickOnHimOpensPanel", await until(panelOpen, "his panel", 5).then(() => true, () => false));
    realClick(cold.at.x, cold.at.y);
    await sleep(800);
    realClick(left + 30, top + 40);
    await sleep(800);
    check("realClickOffHimPassesThrough", readFileSync(log, "utf8").includes("click"));
    // His process held busy while the real pointer moves over his window: Windows drops the hook that does not answer.
    const busy = main.evaluate(`(() => { const end = Date.now() + 1500; while (Date.now() < end) {} return true; })()`);
    for (let i = 0; i < 6; i++) { realMove(left + 40 + i * 20, top + 60 + i * 10); await sleep(200); }
    await busy;
    await sleep(800);
    if (await panelOpen()) { realClick(cold.at.x, cold.at.y); await sleep(600); }
    realClick(cold.at.x, cold.at.y);
    check("realClickAfterBusyOpensPanel", await until(panelOpen, "his panel", 5).then(() => true, () => false));
    realClick(cold.at.x, cold.at.y);
    stop(catcherWindow);
    catcherWindow = null;
    rmSync(log, { force: true });
  } else {
    notes.realMouse = "skipped: set PERRY_E2E_DESKTOP=1 on Windows to use the real mouse (it moves the owner's pointer)";
  }

  // --- 9. `--reload`, as `perry update` sends, with the server up -----------------------------------------------
  mark("--reload, server up");
  {
    const before = shown()[0]?.hwnd;
    const t = await petTab();
    await t.evaluate("window.__oldPage = true");
    tellPet(["--reload"]);
    await until(async () => shown().length === 1 && shown()[0].hwnd !== before, "a new window after --reload", 60).catch(() => {});
    const fresh = await petTab();
    await until(() => himOnPage(fresh), "him after --reload", 60);
    check("reload:newPage", (await fresh.evaluate("window.__oldPage === undefined")) === true);
    await clickable("reload");
  }

  // --- 10. `--reload` while the server restarts ---------------------------------------------------------------
  mark("--reload, server down");
  {
    const before = shown()[0]?.hwnd;
    await stopServer();
    tellPet(["--reload"]);
    await sleep(8_000);
    check("reloadWhileDown:staysAsHeWas", shown().length === 1 && shown()[0].hwnd === before, petWindows());
    mark("Perry's server starts again");
    startServer();
    await until(serverUp, "the server to start again", 90);
    await until(() => shown().length === 1 && shown()[0].hwnd !== before, "his new window once the server is back", 60).catch(() => {});
    check("reloadWhileDown:backOnNewPage", shown().length === 1 && shown()[0].hwnd !== before, petWindows());
    await clickable("reloadWhileDown");
  }

  // --- 11. His page reloads itself ------------------------------------------------------------------------------
  mark("the page reloads itself");
  {
    const t = await petTab();
    await t.send("Page.reload").catch(() => {});
    await sleep(6_000);
    await clickable("pageReload");
  }

  // --- 12. His page's process crashes ---------------------------------------------------------------------------
  mark("his page's process crashes");
  {
    const before = shown()[0]?.hwnd;
    const t = await petTab();
    void t.send("Page.crash").catch(() => {});
    await until(() => shown().length === 1 && shown()[0].hwnd !== before, "him back after the crash", 20).catch(() => {});
    check("crash:backWithin20s", shown().length === 1 && shown()[0].hwnd !== before, petWindows());
    await clickable("crash");
  }

  // --- 13. Hidden (as a failed load hides him), then shown by a second start --------------------------------------
  mark("hidden, then shown again");
  {
    // Hidden by Windows itself (SW_HIDE), as his window is while a load fails; no click on the owner's tray.
    ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class S { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }'; [S]::ShowWindow([IntPtr]${shown()[0]?.hwnd ?? 0}, 0) | Out-Null`);
    await until(() => shown().length === 0, "him hidden", 10).catch(() => {});
    check("hidden:gone", shown().length === 0, petWindows());
    tellPet([]);
    await until(() => shown().length === 1, "him shown again", 10).catch(() => {});
    await clickable("shownAgain");
  }

  // --- 14. `perry update --restart`: a new pet process takes over --------------------------------------------------
  mark("--quit --restart: a new pet takes over");
  {
    const oldPid = petPid;
    tellPet(["--quit", "--restart"]);
    const next = await until(() => petProcesses().find((item) => item.cmd.includes(PET_DIR) && item.pid !== oldPid && item.cmd.includes("--takeover")), "the new pet process", 30);
    watch(next.pid);
    await until(() => shown().length === 1, "the new pet's window", 60).catch(() => {});
    const mine = petProcesses().filter((item) => item.cmd.includes(PET_DIR));
    check("takeover:onePetProcess", mine.length === 1 && mine[0].pid === next.pid, mine);
    await clickable("takeover");
  }

  // --- 15. Ghost in pet.json: clicks go through even on him ----------------------------------------------------
  mark("ghost: started with Let clicks through him");
  {
    tellPet(["--quit"]);
    await until(() => !petProcesses().some((item) => item.cmd.includes(PET_DIR)), "the pet to quit", 20);
    petJson({ ghost: true });
    pet = launchPet();
    watch(pet.pid!);
    await until(() => shown().length === 1, "the ghost pet's window", 60).catch(() => {});
    await clickable("ghost", { ghost: true });
  }

  for (const t of [tab as Tab | null]) if (t) pageErrors.push(...t.errors);
  check("pageDidNotThrow", pageErrors.length === 0, pageErrors.slice(0, 5));
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
  console.log(notes.error);
} finally {
  (tab as Tab | null)?.close();
  main?.close();
  stop(catcherWindow);
  for (const item of petProcesses().filter((item) => item.cmd.includes(PET_DIR))) stop(item.pid);
  stop(pet);
  stop(watcher);
  stop(server);
  await sleep(1_500);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

// 16. The owner's pet, as it was.
const ownerAfter = ownerState();
check("ownerPetUntouched", JSON.stringify(ownerAfter) === JSON.stringify(ownerBefore), { before: { ...ownerBefore, loginEntry: Boolean(ownerBefore.loginEntry) }, after: { ...ownerAfter, loginEntry: Boolean(ownerAfter.loginEntry) } });

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
const passed = failed.length === 0 && Object.keys(checks).length > 0;
const result = {
  ranAt: new Date().toISOString(), passed, realMouse: REAL_MOUSE, serverDownMs: DOWN_MS, checks, notes,
  serverErrors: logs.server.split("\n").filter((line) => /error/i.test(line)).slice(-20), petLog: logs.pet.split("\n").filter(Boolean).slice(-20),
};
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
// What Windows said about his windows, step by step: handles, shown or not, extended style, and each window's page child.
writeFileSync(join(outDir, "windows.json"), `${JSON.stringify(timeline, null, 1)}\n`);
console.log(passed ? `all ${Object.keys(checks).length} checks passed` : `FAILED: ${failed.join(", ")}`);
process.exit(passed ? 0 : 1);

async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}

/** A plain window of this script's own under the pet, which notes every click that reaches it (PERRY_E2E_DESKTOP=1 only). */
function catcher(box: { x: number; y: number; w: number; h: number }, log: string): ChildProcess {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class D { [DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }'",
    "[D]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null",
    "$f = New-Object System.Windows.Forms.Form; $f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false",
    `$f.Bounds = New-Object System.Drawing.Rectangle ${box.x}, ${box.y}, ${box.w}, ${box.h}`,
    "$f.BackColor = [System.Drawing.Color]::FromArgb(236, 240, 244)",
    "$l = New-Object System.Windows.Forms.Label; $l.Text = 'Test window: clicks that pass through the test pet land here'; $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point 12, 12; $f.Controls.Add($l)",
    `$f.Add_MouseDown({ param($s, $e) Add-Content -Path '${log}' -Value \"click $($e.X),$($e.Y)\" -Encoding ascii })`,
    `$f.Add_Shown({ Add-Content -Path '${log}' -Value 'shown' -Encoding ascii })`,
    "$t = New-Object System.Windows.Forms.Timer; $t.Interval = 60000; $t.Add_Tick({ $f.Close() }); $t.Start()",
    "[System.Windows.Forms.Application]::Run($f)",
  ].join("; ");
  return spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
}

/** The real pointer to a point of the screen (physical pixels; PERRY_E2E_DESKTOP=1 only). */
function realMove(x: number, y: number) {
  ps(`${MOUSE}; [M]::mouse_event(0x8001, [uint32](${x} * 65535 / ($w - 1)), [uint32](${y} * 65535 / ($h - 1)), 0, [IntPtr]::Zero)`);
}
/** The real mouse, moved the way a hand moves it, then pressed (PERRY_E2E_DESKTOP=1 only). */
function realClick(x: number, y: number) {
  ps([
    MOUSE,
    `foreach ($d in @(10, 5, 0)) { [M]::mouse_event(0x8001, [uint32]((${x} - $d) * 65535 / ($w - 1)), [uint32]((${y} - $d) * 65535 / ($h - 1)), 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 150 }`,
    "Start-Sleep -Milliseconds 300",
    "[M]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [M]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)",
  ].join("; "));
}
