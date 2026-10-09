import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reachableAddresses } from "../../convex/lib/devices";
import type { PetDevicesView } from "../../convex/pet";
import { openChat, sleep } from "../browser";

// bun artifacts/pet-many-devices/run.ts <outDir>   (optional: PERRY_TEST_DIR=<folder for its Perry homes and the pet-only install>)
// Issue #155: the desktop pet on more than one computer, on this one Windows
// machine. A fresh Perry of its own (PERRY_HOME, port; `pnpm build` first),
// listening as Perry does, and reached by the second pet at this computer's
// network address, not 127.0.0.1. Two real Electron pets: one as on Perry's
// own computer (the dashboard key, as `perry pet` starts him), and one as on
// "another computer", installed by the real installer's pet-only mode
// (install.ps1 with PERRY_PET, a sparse clone of this branch into a folder of
// its own) with its own home, pet.json and login entry, and paired with a code
// made in Settings. Headless Chrome for the dashboard. No runner, Codex or
// Telegram. Safe beside the owner's own pet and Perry: that is checked, not assumed.
//
// Ways it could fail, written down before the checks:
//   1. The server cannot be reached at this computer's network address, or,
//      reached there, answers anyone without a key.
//   2. An unpaired client gets in: no key, a made-up pet key, or a pairing code
//      that is wrong, already used, or guessed at more than a few times.
//   3. Settings offers no way to add a computer, or shows a code without the
//      address and the line to paste there.
//   4. The pet-only install needs a whole Perry (Bun, Codex, the full
//      checkout), or pairs with the dashboard key, or keeps its key anywhere
//      but that computer's own pet.json, or starts at login under the owner's
//      own entry.
//   5. The paired pet's page does not load from Perry over the network with its
//      own key, or it loads with the dashboard key.
//   6. The pet's key opens more than his page: the keys, the device list,
//      pairing another computer, attaching a file from elsewhere on Perry's
//      computer, the admin route.
//   7. Presence counts one pet: away while the owner is at the other one, or
//      here when both have seen them gone.
//   8. Perry asks the wrong pet to look: not the one touched last; or a pet
//      answers a look asked of the other.
//   9. Removing the computer leaves its key working, its pet showing
//      everything, or the computer listed or counted as present.
//  10. The pet on Perry's own computer, with the dashboard key, stops working
//      as before: the owner's one-computer setup.
//  11. PERRY_HOST=127.0.0.1 still answers at the network address, or Settings
//      still offers to add a computer.
//  12. The check touches the owner's own pet, its login entry, or ~/.perry.
//  13. His page calls something his key may not (added to the page, not to
//      server/devices.ts): he is locked out on the other computer alone.
//  14. The owner's real mouse, moving over the test pets on their screen, clicks
//      or opens them mid-check: both run as ghosts, and that is checked.
//
// The pets really take pictures of the screen when Perry asks (8). Those are of
// whatever the owner has open, so they stay in this run's own Perry folder,
// which is deleted at the end: none is kept or described. The pictures here
// are of pages (the dashboard, and each pet's own page over DevTools), never
// of the screen.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-many-devices/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
if (process.platform !== "win32") throw new Error("This check runs the Windows installer and reads the registry; run it on Windows.");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRANCH = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS_A = await freePort();
const DEVTOOLS_B = await freePort();
const KEY = "pet-many-devices-e2e-key";
const LOCAL = `http://127.0.0.1:${PORT}`;
// This computer's address on its network, as another computer would use it; a loopback alias if it has none.
const lan = reachableAddresses().find((a) => !a.tailscale && a.address.startsWith("192.168.")) ?? reachableAddresses()[0];
const LAN_HOST = lan?.address ?? "127.0.0.2";
const LAN = `http://${LAN_HOST}:${PORT}`;

// Perry's own computer (A), and the other computer (B): each its own Perry folder, B's pet in a folder of its own.
// PERRY_TEST_DIR puts them on a roomier drive (the pet-only install is most of 1 GB); the system's temp folder otherwise.
const scratch = process.env.PERRY_TEST_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const homeA = mkdtempSync(join(scratch, "perry-many-a-"));
const homeB = mkdtempSync(join(scratch, "perry-many-b-"));
const petParent = mkdtempSync(join(scratch, "perry-many-pet-"));
const petDir = join(petParent, "perry-pet");
// Away from the bottom-right corner, where the owner's own pet stands, and from each other; ghosts, so the
// owner's real mouse goes through them (14). The checks click with the page's own DOM, which ghosts still take.
writeFileSync(join(homeA, "pet.json"), JSON.stringify({ x: 40, y: 60, ghost: true }));
writeFileSync(join(homeB, "pet.json"), JSON.stringify({ x: 470, y: 60, ghost: true }));

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = { branch: BRANCH, lanAddress: lan ? LAN_HOST : "none: a loopback alias (127.0.0.2) stood in" };

// --- The owner's own pet and login entry, as they were ------------------------------

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const entry = (name: string) => {
  const found = spawnSync("reg", ["query", RUN_KEY, "/v", name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "" : null;
};
const ownerEntry = entry("Perry pet");
/** The owner's pet: Electron running the folder their "Perry pet" login entry names. */
const ownersPetDir = ownerEntry?.match(/"([^"]+)"\s*$/)?.[1] ?? null;
const electrons = () => (spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`],
{ encoding: "utf8", windowsHide: true }).stdout ?? "").trim().split(/\r?\n/).filter(Boolean).map((line) => ({ pid: line.split("|")[0], command: line.slice(line.indexOf("|") + 1) }));
const ownersPets = () => ownersPetDir ? electrons().filter((p) => p.command.includes(ownersPetDir) && !p.command.includes(REPO) && !p.command.includes(petParent)).map((p) => p.pid).sort() : [];
const before = { entry: ownerEntry, pets: ownersPets() };
notes.ownersBefore = { entry: ownerEntry ? "present" : "none", pets: before.pets.length };
const entryB = `Perry pet-${createHash("sha256").update(homeB).digest("hex").slice(0, 8)}`;

// --- Perry's server ---------------------------------------------------------------

const serverEnv: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: homeA, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex" };
for (const name of ["TELEGRAM_BOT_TOKEN", "ELECTRON_RUN_AS_NODE", "PERRY_HOST", "PERRY_URL", "COMPOSIO_API_KEY"]) delete serverEnv[name];
for (const name of Object.keys(serverEnv)) if (name.startsWith("CONVEX")) delete serverEnv[name];
let serverLog = "";
function startServer(extra: { host?: string } = {}): ChildProcess {
  const child = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT), ...(extra.host ? ["-H", extra.host] : [])],
    { cwd: REPO, env: { ...serverEnv, ...(extra.host ? { PERRY_HOST: extra.host } : {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { serverLog += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk; });
  return child;
}
const kill = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };

type Answer<T> = { status: number; value?: T; error?: string };
async function call<T>(base: string, path: string, args: object, route: "call" | "admin" = "call", adminKey?: string): Promise<Answer<T>> {
  const response = await fetch(`${base}/api/backend/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(adminKey ? { "x-perry-key": adminKey } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body = await response.json().catch(() => ({})) as { value?: T; error?: string };
  return { status: response.status, value: body.value, error: body.error };
}
const owner = async <T>(path: string, args: object = {}) => {
  const answer = await call<T>(LOCAL, path, { key: KEY, ...args });
  if (answer.error) throw new Error(`${path}: ${answer.error}`);
  return answer.value as T;
};
const internal = async <T>(path: string, args: object = {}) => {
  const answer = await call<T>(LOCAL, path, args, "admin", KEY);
  if (answer.error) throw new Error(`${path}: ${answer.error}`);
  return answer.value as T;
};
const devices = () => owner<PetDevicesView>("pet:devices");

async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 30) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}
async function check(name: string, test: () => Promise<boolean> | boolean, seconds = 20) {
  checks[name] = await until(test, name, seconds).then(() => true, () => false);
  if (!checks[name]) console.log(`FAILED: ${name}`);
}

// --- The pets' pages, over DevTools ---------------------------------------------------

async function pageOf(devtools: number, prefix: string) {
  const list = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const target = list.find((item) => item.url.startsWith(prefix));
  if (!target) throw new Error(`no page at ${prefix}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let id = 0;
  const waiting = new Map<number, (message: any) => void>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
  });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((done, fail) => {
    const n = ++id;
    waiting.set(n, (message) => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  return { url: target.url, send, evaluate, close: () => ws.close() };
}
const pageOpen = (devtools: number, prefix: string) => fetch(`http://127.0.0.1:${devtools}/json/list`).then((r) => r.json() as Promise<Array<{ url: string }>>)
  .then((list) => list.some((item) => item.url.startsWith(prefix)), () => false);
async function petShot(devtools: number, prefix: string, name: string) {
  const page = await pageOf(devtools, prefix);
  try { writeFileSync(join(outDir, name), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64")); } finally { page.close(); }
}
const petText = async (devtools: number, prefix: string) => {
  const page = await pageOf(devtools, prefix);
  try { return String(await page.evaluate(`document.body.innerText`) ?? ""); } finally { page.close(); }
};
// 14. Real pointer events (isTrusted: the owner's mouse, not the checks' own DOM clicks) reaching a pet's page, counted from when it opens.
// Counted in his loaded page (installed while it still loads, it would go with that document), which it tells apart by its timeOrigin.
const countRealPointer = async (devtools: number, prefix: string) => {
  const page = await pageOf(devtools, prefix);
  try {
    return Number(await page.evaluate(`new Promise((done) => { const start = () => { if (window.__realPointer === undefined) { window.__realPointer = 0;
      for (const type of ["pointerover", "pointermove", "pointerdown", "pointerup", "wheel", "contextmenu"]) addEventListener(type, (e) => { if (e.isTrusted) window.__realPointer++; }, true); }
      done(performance.timeOrigin); };
      document.readyState === "complete" ? start() : addEventListener("load", start, { once: true }); })`));
  } finally { page.close(); }
};
/** How many, and whether the page is still the one counted in (a reload would lose the count). */
const realPointer = async (devtools: number, prefix: string, counted: number) => {
  const page = await pageOf(devtools, prefix);
  try {
    const [count, origin] = await page.evaluate(`[window.__realPointer ?? null, performance.timeOrigin]`) as [number | null, number];
    return { count, samePage: origin === counted };
  } finally { page.close(); }
};

// Pet A: as `perry pet` starts him on Perry's own computer, with the dashboard key; launched directly, so no login entry.
const electron = createRequire(join(REPO, "pet", "package.json"))("electron") as string;
let petA: ChildProcess | null = null;
const petAEnv: NodeJS.ProcessEnv = { ...serverEnv, PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS_A) };
// Pet B: the other computer. No dashboard key, no port, nothing of Perry's own: only what the installer and its pairing give it.
const petBEnv: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: homeB, PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS_B), PERRY_PET_NAME: "Laptop (test)" };
for (const name of ["DASHBOARD_KEY", "PERRY_PORT", "PERRY_URL", "PERRY_HOST", "ELECTRON_RUN_AS_NODE"]) delete petBEnv[name];

let server: ChildProcess | null = startServer();
let dashboard: Awaited<ReturnType<typeof openChat>> | null = null;
let tokenB = "";
try {
  await until(() => fetch(`${LOCAL}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);

  // 1. Reached at the network address; nothing there without a key.
  await check("reachableOnNetwork", () => fetch(`${LAN}/api/backend/http/health`).then((r) => r.ok, () => false), 10);
  const noKey = await call(LAN, "todos:board", { key: "" });
  checks.noKeyRefused = Boolean(noKey.error && /dashboard key/i.test(noKey.error) && noKey.value === undefined);
  // 2. A made-up pet key, and a code with none open.
  const madeUp = await call(LAN, "todos:board", { key: "pet_madeUpKeyThatWasNeverPaired" });
  checks.madeUpPetKeyRefused = madeUp.status === 403 && /removed from Perry/.test(madeUp.error ?? "");
  const noCode = await call<{ error?: string }>(LAN, "pet:redeem", { code: "ABCD-EFGH", name: "intruder" });
  checks.codeWithNoneOpenRefused = Boolean(noCode.value?.error && !("key" in (noCode.value ?? {})));
  notes.unpaired = { noKey: noKey.error, madeUp: { status: madeUp.status, error: madeUp.error }, noCode: noCode.value };

  // 10. The pet on Perry's own computer, with the dashboard key, as before.
  petA = spawn(electron, [join(REPO, "pet")], { cwd: join(REPO, "pet"), env: petAEnv, stdio: "ignore", windowsHide: false });
  await check("petAPageOpen", () => pageOpen(DEVTOOLS_A, `${LOCAL}/pet`), 60);
  await check("petAChecksIn", async () => (await owner<{ running: boolean }>("pet:status")).running, 30);
  const countedA = await countRealPointer(DEVTOOLS_A, `${LOCAL}/pet`);
  const pageA = await pageOf(DEVTOOLS_A, `${LOCAL}/pet`);
  checks.petAUsesDashboardKey = await pageA.evaluate(`localStorage.getItem("perry.dashboard.key")`) === KEY;
  pageA.close();

  // 3. Settings: Add a computer, the code, the address to use, and the line to paste.
  dashboard = await openChat(LOCAL, KEY);
  const page = () => dashboard!.evaluate(`document.querySelector("main")?.innerText ?? ""`) as Promise<string>;
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await dashboard!.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const click = (selector: string, text: string) => dashboard!.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.innerText.trim() === ${JSON.stringify(text)}); b?.click(); return Boolean(b); })()`) as Promise<boolean>;
  const scrollTo = (text: string) => dashboard!.evaluate(`[...document.querySelectorAll("h3")].find((h) => h.innerText.includes(${JSON.stringify(text)}))?.scrollIntoView({ block: "start" }); true`);
  await dashboard.send("Page.navigate", { url: `${LOCAL}/settings/desktop-pet` });
  await check("addComputerOffered", async () => /On your other computers[\s\S]*Add a computer/.test(await page()), 30);
  await click("main button", "Add a computer");
  await check("codeShown", () => dashboard!.evaluate(`Boolean(document.querySelector("[data-pairing-code]"))`), 10);
  const code = await dashboard.evaluate(`document.querySelector("[data-pairing-code]").innerText.trim()`) as string;
  checks.codeLooksRight = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);
  // The address this computer's network gives it, picked as the owner would for a laptop on the same network.
  await dashboard.evaluate(`[...document.querySelectorAll('[aria-label="Perry\\'s address"] button')].find((b) => b.innerText.startsWith(${JSON.stringify(LAN_HOST)}))?.click(); true`);
  await sleep(300);
  const lines = await dashboard.evaluate(`[...document.querySelectorAll("main code")].map((c) => c.innerText)`) as string[];
  const windowsLine = lines.find((line) => line.includes("install.ps1")) ?? "";
  const unixLine = lines.find((line) => line.includes("install.sh")) ?? "";
  notes.linesShown = [windowsLine, unixLine];
  checks.lineHasAddressAndCode = windowsLine.includes(`Set-Item Env:PERRY_PET '${LAN} ${code}'`) && unixLine.includes(`PERRY_PET='${LAN} ${code}'`);
  await scrollTo("On your other computers");
  await shot("settings-add-a-computer.png");

  // 2. A wrong code counts against the open one, and does not close it at once.
  const wrong = await call<{ error?: string }>(LAN, "pet:redeem", { code: "ZZZZ-ZZZZ", name: "intruder" });
  checks.wrongCodeRefused = Boolean(wrong.value?.error);
  checks.openAfterOneWrong = (await devices()).pairing !== null;

  // 4. The other computer: the real installer, pet-only, from this branch; it pairs with the code, at the network address.
  const install = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(REPO, "install.ps1")], {
    cwd: petParent, encoding: "utf8", windowsHide: true, timeout: 20 * 60_000,
    env: { ...petBEnv, PERRY_PET: `${LAN} ${code}`, PERRY_DIR: petDir, PERRY_REPO: pathToFileURL(REPO).href, PERRY_BRANCH: BRANCH },
  });
  const installed = `${install.stdout ?? ""}${install.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  writeFileSync(join(outDir, "install-pet-only.txt"), installed.replaceAll(code, "XXXX-XXXX"));
  checks.installerPaired = install.status === 0 && /Paired, as Laptop \(test\)/.test(installed);
  checks.installerNeedsNoBunOrCodex = !/bun|codex/i.test(installed.split(/\r?\n/).find((line) => /node v/.test(line)) ?? "bun");
  checks.onlyThePetFolder = existsSync(join(petDir, "pet", "main.js")) && existsSync(join(petDir, "pet", "node_modules", "electron"))
    && !existsSync(join(petDir, "convex")) && !existsSync(join(petDir, "app")) && !existsSync(join(petDir, "node_modules"));
  const configB = JSON.parse(readFileSync(join(homeB, "pet.json"), "utf8")) as { server?: string; token?: string; x?: number; ghost?: boolean };
  tokenB = configB.token ?? "";
  checks.keptInItsOwnPetJson = configB.server === LAN && tokenB.startsWith("pet_") && tokenB !== KEY && configB.x === 470;
  notes.configB = { server: configB.server, token: tokenB ? `${tokenB.slice(0, 8)}…` : null };
  const loginB = entry(entryB);
  checks.itsOwnLoginEntry = Boolean(loginB?.includes(join(petDir, "pet")));
  checks.ownersEntryUntouched = entry("Perry pet") === before.entry;
  // The code works once.
  const again = await call<{ error?: string }>(LAN, "pet:redeem", { code, name: "again" });
  checks.codeWorksOnce = Boolean(again.value?.error);

  // 5. His page, from Perry over the network, with the computer's own key.
  await check("petBPageOpen", () => pageOpen(DEVTOOLS_B, `${LAN}/pet`), 90);
  notes.petBGhost = configB.ghost === true;
  // The page keeps the key from its #key= once it has loaded, so this waits for that.
  const keyOfB = async () => { const b = await pageOf(DEVTOOLS_B, `${LAN}/pet`); try { return String(await b.evaluate(`localStorage.getItem("perry.dashboard.key")`)); } finally { b.close(); } };
  await check("petBUsesItsOwnKey", async () => await keyOfB() === tokenB, 30);
  const heldB = await keyOfB().catch(() => "");
  notes.petBKey = heldB === tokenB ? "its own" : heldB === KEY ? "the dashboard key" : heldB ? "another" : "none";
  await check("petBShowsHim", async () => {
    const b = await pageOf(DEVTOOLS_B, `${LAN}/pet`);
    try {
      return await b.evaluate(`!/locked out|went wrong/i.test(document.body.innerText) && Boolean(document.querySelector('button[aria-label^="Perry. Click to open him"]'))`);
    } finally { b.close(); }
  }, 30);
  const countedB = await countRealPointer(DEVTOOLS_B, `${LAN}/pet`);
  const deviceB = async () => (await devices()).devices.find((d) => d.name === "Laptop (test)");
  await check("bothListedAndRunning", async () => {
    const view = await devices();
    return view.devices.length === 2 && view.devices[0].running && Boolean(view.devices[1]?.running) && view.devices[1].platform === "win32";
  }, 60);
  const idB = (await deviceB())!.id!;
  // His panel open, to see his chats over the network.
  const openB = await pageOf(DEVTOOLS_B, `${LAN}/pet`);
  await openB.evaluate(`document.querySelector('button[aria-label^="Perry. Click to open him"]')?.click(); true`);
  await sleep(1500);
  openB.close();
  await petShot(DEVTOOLS_B, `${LAN}/pet`, "pet-b-on-the-other-computer.png");

  // 6. What the key opens, and what it does not.
  const asB = (path: string, args: object = {}) => call(LAN, path, { key: tokenB, ...args });
  const scope = {
    board: await asB("todos:board"),
    keys: await asB("dashboard:getKeys"),
    devices: await asB("pet:devices"),
    pair: await asB("pet:pair"),
    status: await asB("pet:status"),
    attachElsewhere: await asB("dashboard:registerAttachment", { conversationId: "x", messageKey: "m", localPath: "C:\\Windows\\win.ini", fileName: "win.ini", contentType: "text/plain", size: 10 }),
    admin: await call(LAN, "todos:board", { key: tokenB }, "admin", tokenB),
  };
  notes.scope = Object.fromEntries(Object.entries(scope).map(([name, answer]) => [name, { status: answer.status, error: answer.error }]));
  checks.keyOpensHisPage = scope.board.status === 200 && !scope.board.error;
  checks.keyDoesNotOpenTheRest = [scope.keys, scope.devices, scope.pair, scope.status, scope.attachElsewhere, scope.admin].every((answer) => answer.status === 403);
  // His pictures go to Perry's uploads, as the pet on Perry's computer sends them.
  const media = await fetch(`${LAN}/api/media`, { method: "POST", headers: { cookie: `perry_media=${encodeURIComponent(tokenB)}`, "x-file-name": "shot.png" }, body: new Uint8Array([137, 80, 78, 71]) });
  const saved = await media.json() as { path?: string };
  checks.mediaWithItsKey = media.status === 200 && Boolean(saved.path?.startsWith(join(homeA, "uploads") + sep));

  // 7. Presence: here while the owner is at either; away only when both have seen them gone.
  // Each pet also reports the real idle time once a minute; a report landing between these calls is tried again.
  const report = async (key: string, idleSeconds: number) => { const answer = await call(key === KEY ? LOCAL : LAN, "todos:presence", { key, idleSeconds }); if (answer.error) throw new Error(answer.error); };
  const atA = async () => { await report(KEY, 0); await report(tokenB, 900); };
  const atB = async () => { await report(KEY, 900); await report(tokenB, 0); };
  const atNeither = async () => { await report(KEY, 900); await report(tokenB, 900); };
  const settle = async (set: () => Promise<void>, test: (view: PetDevicesView) => boolean) => {
    for (let i = 0; i < 3; i++) { await set(); if (test(await devices())) return true; await sleep(500); }
    return false;
  };
  checks.hereAtA = await settle(atA, (view) => view.presence === "here" && view.devices[0].current && !view.devices[1].current);
  checks.hereAtBWithAIdle = await settle(atB, (view) => view.presence === "here" && view.devices[1].current && !view.devices[0].current);
  checks.awayOnlyWhenBothIdle = await settle(atNeither, (view) => view.presence === "away");
  await dashboard.send("Page.navigate", { url: `${LOCAL}/settings/desktop-pet` });
  await until(async () => /Laptop \(test\)/.test(await page()), "the list", 20).catch(() => {});
  await atNeither();
  await check("awaySaidInSettings", async () => { await atNeither(); return /away from all of them/.test(await page()); }, 15);
  await atB();
  await check("youAreHereInSettings", async () => {
    await atB();
    return dashboard!.evaluate(`document.querySelector('[data-pet-device="Laptop (test)"]')?.innerText.includes("You're here") ?? false`) as Promise<boolean>;
  }, 15);
  await scrollTo("On your other computers");
  await shot("settings-two-computers.png");

  // 8. Looking at the screen: the pet touched last is asked, and only it can answer.
  const chat = await owner<string>("dashboard:createChat");
  // A pet's own once-a-minute report landing between setting who is where and asking is tried again, and counted.
  const tries: Record<string, number> = {};
  const look = async (name: string, at: () => Promise<void>, expected: string | null) => {
    let last = { id: "", device: null as string | null };
    for (tries[name] = 1; tries[name] <= 3; tries[name]++) {
      await at();
      const asked = await internal<{ id?: string; error?: string }>("screen:ask", { conversationId: chat, which: "screen", why: "E2E: which pet is asked" });
      if (!asked.id) throw new Error(asked.error);
      const row = await internal<{ device?: string }>("screen:get", { id: asked.id });
      last = { id: asked.id, device: row.device ?? null };
      if (last.device === expected) break;
      await sleep(3000);
    }
    notes.lookTries = tries;
    return last;
  };
  const lookB = await look("atB", atB, idB);
  checks.lookAsksB = lookB.device === idB;
  // A cannot answer B's ask: the pet on Perry's computer, with the dashboard key, answering for it changes nothing.
  await call(LOCAL, "screen:fulfil", { key: KEY, id: lookB.id, error: "answered by the wrong pet" });
  await check("lookDoneByB", async () => {
    const row = await internal<{ status: string; path?: string; error?: string }>("screen:get", { id: lookB.id });
    notes.lookB = { status: row.status, error: row.error, inUploads: row.path?.startsWith(join(homeA, "uploads") + sep) };
    return row.status === "done" && Boolean(row.path?.startsWith(join(homeA, "uploads") + sep));
  }, 40);
  await check("bSaysItLooked", async () => /I looked at your screen/.test(await petText(DEVTOOLS_B, `${LAN}/pet`)), 10);
  await petShot(DEVTOOLS_B, `${LAN}/pet`, "pet-b-looked.png");
  const lookA = await look("atA", atA, null);
  checks.lookAsksA = lookA.device === null;
  // And B cannot answer A's.
  await call(LAN, "screen:fulfil", { key: tokenB, id: lookA.id, error: "answered by the wrong pet" });
  await check("lookDoneByA", async () => (await internal<{ status: string }>("screen:get", { id: lookA.id })).status === "done", 40);
  await check("aSaysItLooked", async () => /I looked at your screen/.test(await petText(DEVTOOLS_A, `${LOCAL}/pet`)), 10);
  await petShot(DEVTOOLS_A, `${LOCAL}/pet`, "pet-a-looked.png");

  // 2 again: guessing at a code closes it.
  const guessed = await owner<{ code: string }>("pet:pair");
  for (let i = 0; i < 10; i++) await call(LAN, "pet:redeem", { code: `WRNG-${String(i).padStart(4, "2")}`, name: "guess" });
  const afterGuesses = await call<{ error?: string; key?: string }>(LAN, "pet:redeem", { code: guessed.code, name: "guess" });
  checks.guessingClosesTheCode = Boolean(afterGuesses.value?.error) && (await devices()).pairing === null && (await devices()).devices.length === 2;

  // 9. Removed from Settings: the key stops at once, he says he is locked out, and he is no longer listed or counted.
  await dashboard.send("Page.navigate", { url: `${LOCAL}/settings/desktop-pet` });
  await until(async () => /Laptop \(test\)/.test(await page()), "the list", 20);
  await dashboard.evaluate(`[...document.querySelector('[data-pet-device="Laptop (test)"]').querySelectorAll("button")].find((b) => b.innerText.trim() === "Remove").click(); true`);
  await until(() => dashboard!.evaluate(`Boolean(document.querySelector("[role=alertdialog]"))`), "the confirmation", 10);
  await dashboard.evaluate(`[...document.querySelectorAll("[role=alertdialog] button")].find((b) => b.innerText.trim() === "Remove").click(); true`);
  await check("removedFromList", async () => !(await deviceB()) && !/Laptop \(test\)/.test(await page()), 15);
  const afterRemoval = await call(LAN, "todos:board", { key: tokenB });
  checks.keyStopsAtOnce = afterRemoval.status === 403 && /removed from Perry/.test(afterRemoval.error ?? "");
  checks.notCountedAfterRemoval = await settle(async () => { await report(KEY, 900); }, (view) => view.presence === "away" && view.devices.length === 1);
  await scrollTo("On your other computers");
  await shot("settings-removed.png");
  // He hears it at his next check-in, a minute at most.
  await check("petBLockedOut", async () => /locked out/i.test(await petText(DEVTOOLS_B, `${LAN}/pet`)) && /removed from Perry/.test(await petText(DEVTOOLS_B, `${LAN}/pet`)), 90);
  await petShot(DEVTOOLS_B, `${LAN}/pet`, "pet-b-locked-out.png");

  // 10 again: the pet on Perry's computer carries on.
  checks.petAStillWorks = (await owner<{ running: boolean }>("pet:status")).running && !/locked out/i.test(await petText(DEVTOOLS_A, `${LOCAL}/pet`));
  // 14. Neither test pet took the owner's real mouse, all the while.
  const pointer = { a: await realPointer(DEVTOOLS_A, `${LOCAL}/pet`, countedA), b: await realPointer(DEVTOOLS_B, `${LAN}/pet`, countedB) };
  notes.realPointer = pointer;
  checks.noRealPointerOnPets = [pointer.a, pointer.b].every(({ count, samePage }) => samePage && count === 0);
  // 13. The only calls refused to his key (server/devices.ts logs each) were the ones made here to see them refused.
  const refused = [...new Set([...serverLog.matchAll(/refused the desktop pet on Laptop \(test\): it cannot call (\S+)/g)].map((m) => m[1]))].sort();
  notes.refusedToPetB = refused;
  checks.pageCallsOnlyWhatItsKeyMay = JSON.stringify(refused) === JSON.stringify(["dashboard:getKeys", "pet:devices", "pet:pair", "pet:status"]);
  checks.noDashboardErrors = dashboard.errors.length === 0;
  notes.dashboardErrors = dashboard.errors;

  // 11. PERRY_HOST=127.0.0.1: this computer alone.
  kill(server);
  await until(() => fetch(`${LOCAL}/api/backend/http/health`).then(() => false, () => true), "the server to stop", 20);
  server = startServer({ host: "127.0.0.1" });
  await until(() => fetch(`${LOCAL}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start again", 90);
  checks.loopbackOnlyNotOnNetwork = LAN_HOST.startsWith("127.") ? true : await fetch(`${LAN}/api/backend/http/health`, { signal: AbortSignal.timeout(5000) }).then(() => false, () => true);
  const closed = await devices();
  checks.loopbackOnlySaid = closed.loopbackOnly && closed.addresses.length === 0;
  await dashboard.send("Page.navigate", { url: `${LOCAL}/settings/desktop-pet` });
  await check("addComputerDisabled", () => dashboard!.evaluate(`(() => { const b = [...document.querySelectorAll("main button")].find((b) => b.innerText.trim() === "Add a computer"); return Boolean(b?.disabled) && document.querySelector("main").innerText.includes("Perry listens on this computer alone"); })()`), 30);
  await scrollTo("On your other computers");
  await shot("settings-this-computer-alone.png");

  // 4 again: stopped on the other computer, and no longer at its login.
  const off = spawnSync("node", [join(petDir, "pet", "connect.js"), "off"], { env: petBEnv, encoding: "utf8", windowsHide: true });
  notes.off = off.stdout?.trim();
  await check("petBQuits", async () => !(await pageOpen(DEVTOOLS_B, "http")), 20);
  checks.itsLoginEntryGone = entry(entryB) === null;

  // 12. The owner's own, as they were.
  checks.ownersEntryUntouchedAtEnd = entry("Perry pet") === before.entry;
  checks.ownersPetUntouched = JSON.stringify(ownersPets()) === JSON.stringify(before.pets);
  // Nothing here ever ran with the owner's ~/.perry: every pet and server had a PERRY_HOME of this run's own.
  checks.neverTheOwnersHome = ![homeA, homeB].some((home) => resolve(home) === resolve(process.env.USERPROFILE!, ".perry"));
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
  console.log(notes.error);
} finally {
  dashboard?.close();
  // Never leave a test pet running or starting at login.
  if (existsSync(join(petDir, "pet", "connect.js"))) spawnSync("node", [join(petDir, "pet", "connect.js"), "off"], { env: petBEnv, stdio: "ignore", windowsHide: true });
  spawnSync("reg", ["delete", RUN_KEY, "/v", entryB, "/f"], { stdio: "ignore" });
  spawnSync(electron, [join(REPO, "pet"), "--quit"], { env: { ...petAEnv, PERRY_PET_DEVTOOLS_PORT: "" }, stdio: "ignore", timeout: 15_000 });
  kill(petA);
  kill(server);
  const result = { ranAt: new Date().toISOString(), checks, notes, serverLogTail: serverLog.split("\n").filter((line) => !line.includes(KEY) && !(tokenB && line.includes(tokenB))).slice(-15) };
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  console.log(failed.length ? `FAILED: ${failed.join(", ")}` : `all ${Object.keys(checks).length} checks passed`);
  await sleep(1500);
  // The pictures the pets took of the real screen go with these.
  for (const dir of [homeA, homeB, petParent]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failed.length ? 1 : 0);
}
