import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/hold-to-talk/run.ts <outDir>
// Issue #154: hold the Talk keys, speak, let go, and what was said is sent.
// A fresh Perry (production build, `pnpm build` first; its own PERRY_HOME and
// port, no runner, so nothing reaches Codex) and a desktop pet of this run's
// own: Electron started straight on pet/, on keys nobody uses
// (Ctrl+Alt+Shift+F7), away from the corner where the owner's pet stands.
// No real key is pressed: the pet's key hook, its shortcut and Esc are
// stand-ins (PERRY_PET_FAKE_KEYS), driven from inside the pet's own process
// over Node's inspector, press by press, as Windows reports them; the
// microphone is a recording of Windows' own voice (PERRY_PET_FAKE_MIC), and
// Whisper really writes it down. What was said must reach the server as a
// message in the pet's chat.
//
// Ways it could fail, written down before the checks:
//   1. uiohook-napi does not load or start in the pet's Electron (a native
//      module built for another ABI, or not installed): holding silently off.
//   2. Held and let go, nothing is sent: the release is not heard (the key's
//      name maps to no uiohook key), the page stops without transcribing, or
//      transcribes into the box without sending.
//   3. Windows repeats the shortcut while the keys are held: each repeat is
//      taken as a press, and listening stops (or starts again) mid-hold; or
//      a repeat reported after the keys came up starts him listening again.
//   4. The shortcut is reported before the hook hears the key go down (or
//      after): the press counted twice, or not at all.
//   5. The modifiers are let go of first (Ctrl, Shift, then Space): the
//      release of the last key must still send.
//   6. A tap (shorter than a hold) sends at once instead of listening until
//      the next tap; or the next tap does not send.
//   7. Esc does not stop him, or what was heard is sent anyway.
//   8. The hook hears nothing (on Windows, an app run as administrator in
//      front): the shortcut alone must work as tap and tap again, however
//      often it repeats while held.
//   9. Held again while the last thing said is still being written down
//      (Whisper loading or working): the page's "done" for the first arrives
//      after the second started, his window thinks he is not listening, and
//      letting go does nothing.
//  10. Let go of before the microphone has opened (a slow device): the stop
//      is lost and he listens forever, out of step with his window.
//  11. Where holding cannot work (no hook), he only taps without saying so:
//      the pet and Settings → Keyboard shortcuts must say it; tapping must
//      still send.
//  12. The test's pet touches the owner's own pet, its keys, or its login entry.
//  13. The page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/hold-to-talk/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
if (process.platform !== "win32") throw new Error("This check runs the desktop pet on Windows.");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PET = join(REPO, "pet");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS = await freePort();
const INSPECT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "hold-to-talk-e2e-key";
/** Keys nobody uses, so the owner's own pet keeps Ctrl+Shift+Space. */
const TALK_KEYS = "CommandOrControl+Alt+Shift+F7";
const LOOK_KEYS = "CommandOrControl+Alt+Shift+F8";
/** Long enough for all of what the microphone says. */
const HOLD = 4_000;
/**
 * Where the run keeps its PERRY_HOME, recording and voice model: PERRY_E2E_DIR,
 * or else the system's temp folder (on a full C: drive, set it, and TEMP and
 * TMP for Chrome's profile, to a roomier one).
 */
const WORK = process.env.PERRY_E2E_DIR ?? tmpdir();
mkdirSync(WORK, { recursive: true });
const home = mkdtempSync(join(WORK, "perry-hold-"));
const MODELS = process.env.PERRY_MODELS_DIR ?? join(WORK, "perry-e2e-models");
const SPOKEN = "Remind me to water the plants at six.";
/** What Whisper makes of it ("water the plant said 6", as often as not). */
const HEARD = /remind me.*plant/i;
const SPOKEN_WAV = join(WORK,`perry-hold-spoken-${PORT}.wav`);
spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)",
  `$s.SetOutputToWaveFile('${SPOKEN_WAV}', $f)`,
  `$s.Speak('${SPOKEN}')`,
  "$s.Dispose()",
].join("; ")], { windowsHide: true });
if (!existsSync(SPOKEN_WAV)) throw new Error("Windows' voice could not make the recording.");

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

// --- The owner's own pet, as it is before, to check it is as it was after ------------------------------------

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const entry = (name: string) => {
  const found = spawnSync("reg", ["query", RUN_KEY, "/v", name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "" : null;
};
/** Pets not run from a worktree: the owner's own (other sessions' test pets come and go meanwhile). */
const ownersPets = () => (spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'worktrees' } | ForEach-Object { $_.ProcessId }`],
{ encoding: "utf8", windowsHide: true }).stdout ?? "").trim().split(/\s+/).filter(Boolean).sort();
const before = { entry: entry("Perry pet"), pets: ownersPets() };

// --- Perry --------------------------------------------------------------------------------------------------------

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const stop = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 30) {
  for (let i = 0; i < seconds * 5; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}
async function check(name: string, test: () => Promise<boolean> | boolean, seconds = 20, note?: () => Promise<unknown> | unknown) {
  checks[name] = await until(test, name, seconds).then(() => true, () => false);
  if (note) notes[name] = await Promise.resolve().then(note).catch((error) => String(error));
  console.log(`${checks[name] ? "ok  " : "FAIL"} ${name}`);
}
/** Everything the owner has said to Perry, in any chat but a schedule's (whose prompt is written as the owner's), oldest first. */
async function said(): Promise<string[]> {
  const chats = await call<Array<{ id: string; jobId?: string }>>("dashboard:listChats", { key: KEY });
  const all: Array<{ text: string; createdAt: number }> = [];
  for (const chat of chats.filter((item) => !item.jobId)) {
    const { page } = await call<{ page: Array<{ role: string; text: string; createdAt: number }> }>("dashboard:getChatMessages", { key: KEY, id: chat.id, paginationOpts: { numItems: 50, cursor: null } });
    all.push(...page.filter((message) => message.role === "user"));
  }
  return all.sort((a, b) => a.createdAt - b.createdAt).map((message) => message.text);
}
type Talk = { hotkey?: string; error?: string; hold?: string };
const talkStanding = async () => (await call<{ pet: { running: boolean; keys: Record<string, Talk> } }>("dashboard:getShortcuts", { key: KEY })).pet.keys.talk ?? {};

// --- DevTools: the pet's page, and his window's own process (Node's inspector) ------------------------------

type Cdp = { send: (method: string, params?: object) => Promise<any>; evaluate: (expression: string) => Promise<any>; errors: string[]; close: () => void };
async function connect(port: number, pick: (target: { type: string; url: string }) => boolean, what: string): Promise<Cdp> {
  let url = "";
  await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    url = targets.find(pick)?.webSocketDebuggerUrl ?? "";
    return Boolean(url);
  }, what, 90);
  const ws = new WebSocket(url);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let nextId = 0;
  const waiting = new Map<number, (message: any) => void>();
  const errors: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++nextId;
    waiting.set(id, (message) => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable");
  return { send, evaluate, errors, close: () => ws.close() };
}

/** The test's own pet: Electron on pet/, with stand-in keys (`fakeKeys`: "1", or "off" for no hook) and microphone. */
function startPet(fakeKeys: string): ChildProcess {
  writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 40, y: 60, hotkey: TALK_KEYS }));
  const electron = createRequire(join(PET, "package.json"))("electron") as string;
  return spawn(electron, [`--inspect=${INSPECT}`, PET], {
    cwd: PET, stdio: "ignore", windowsHide: false,
    env: { ...env, PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS), PERRY_MODELS_DIR: MODELS, PERRY_PET_FAKE_MIC: SPOKEN_WAV, PERRY_PET_FAKE_KEYS: fakeKeys },
  });
}

let page: Cdp | null = null;
let main: Cdp | null = null;
const listening = () => page!.evaluate(`Boolean(document.querySelector('[aria-label="Listening"]'))`) as Promise<boolean>;
const idle = async () => !(await page!.evaluate(`Boolean(document.querySelector('[aria-label="Listening"]')) || /Writing it down…|Getting his ears ready/.test(document.body.innerText)`));
const text = () => page!.evaluate("document.body.innerText") as Promise<string>;
async function photograph(name: string) {
  await page!.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot = await page!.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64"));
}
/**
 * Keys, pressed inside his window's process as the stand-in hook and shortcut
 * report them: `k.down(name)`, `k.up(name)`, `k.shortcut()`, `k.escape()`,
 * `wait(ms)`, and `repeat(ms, alsoShortcut)`, Windows repeating the held
 * hotkey's last key (KEY, F7 here) every 33 ms (with the shortcut too while
 * its modifiers are down).
 */
function keys(script: string) {
  return main!.evaluate(`(async () => {
    const k = globalThis.perryFakeKeys;
    const KEY = ${JSON.stringify(TALK_KEYS.split("+").pop())};
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const repeat = async (ms, alsoShortcut = true) => { const end = Date.now() + ms; while (Date.now() < end) { k.down(KEY); if (alsoShortcut) k.shortcut(); await wait(33); } };
    ${script}
    return true;
  })()`);
}
/** Whether he starts listening again in the next `ms`, as a repeat reported late would make him. */
async function listensAgainWithin(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await listening()) return true;
    await sleep(100);
  }
  return false;
}
const heldDown = "k.down('Ctrl'); k.down('Alt'); k.down('Shift'); await wait(30);";
const modsUp = "k.up('Shift'); k.up('Alt'); k.up('Ctrl');";
const tap = `${heldDown} k.down(KEY); k.shortcut(); await wait(80); k.up(KEY); ${modsUp}`;

const server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: "ignore", windowsHide: true });
let pet: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("dashboard:setShortcut", { key: KEY, id: "talk", accelerator: TALK_KEYS });
  await call("dashboard:setShortcut", { key: KEY, id: "look", accelerator: LOOK_KEYS });

  // 1. The real uiohook-napi, in the pet's own Electron: it loads and its hook starts (for a moment, hearing nothing it keeps).
  const probe = join(home, "hook-probe.cjs");
  writeFileSync(probe, `const { app } = require("electron");
app.whenReady().then(() => {
  try {
    const { uIOhook } = require(${JSON.stringify(join(PET, "node_modules", "uiohook-napi"))});
    uIOhook.start();
    setTimeout(() => { uIOhook.stop(); app.exit(0); }, 300);
  } catch (error) { console.error(error); app.exit(3); }
});`);
  const electron = createRequire(join(PET, "package.json"))("electron") as string;
  const probed = spawnSync(electron, [probe], { env, timeout: 30_000, windowsHide: true });
  checks.hookStartsInThePetsElectron = probed.status === 0;
  notes.hookStartsInThePetsElectron = { exit: probed.status, electron: electron.split(/[\\/]/).slice(-4).join("/") };

  // --- With the key hook -----------------------------------------------------------------------------------------
  pet = startPet("1");
  page = await connect(DEVTOOLS, (target) => target.type === "page" && target.url.startsWith(`${BASE}/pet`), "the pet's page");
  main = await connect(INSPECT, () => true, "his window's process");
  await until(() => main!.evaluate("Boolean(globalThis.perryFakeKeys)"), "the stand-in keys", 30);
  await check("petHoldsTheTestKeysAndCanHold", async () => { const talk = await talkStanding(); return talk.hotkey === TALK_KEYS && !talk.error && !talk.hold; }, 30, talkStanding);

  // 2, 3. Held (the key repeating, the shortcut with it), let go, a repeat reported late: sent, and he does not start again.
  let count = (await said()).length;
  void keys(`${heldDown} k.down(KEY); k.shortcut(); await wait(500); await repeat(${HOLD - 500}); k.up(KEY); k.shortcut(); await wait(40); ${modsUp}`);
  await check("holdListens", listening, 5);
  await sleep(HOLD / 2);
  await photograph("held.png");
  checks.stillListeningWhileRepeating = await listening();
  await until(async () => !(await listening()), "him to stop listening", 10).catch(() => {});
  checks.lateRepeatDoesNotStartAgain = !(await listensAgainWithin(2_000));
  await check("holdSends", async () => (await said()).length === count + 1, 60, async () => (await said()).at(-1));
  checks.holdSendsWhatWasSaid = HEARD.test((await said()).at(-1) ?? "");
  await photograph("sent.png");

  // 4, 5. The shortcut reported before the key goes down; Ctrl, Alt and Shift let go of before F7.
  await until(idle, "him to be done", 30);
  count = (await said()).length;
  void keys(`${heldDown} k.shortcut(); await wait(20); k.down(KEY); await wait(500); await repeat(${HOLD - 900}); ${modsUp} await repeat(400, false); k.up(KEY);`);
  await check("shortcutFirstListens", listening, 5);
  await sleep(HOLD + 500);
  await check("modifiersFirstThenKeySends", async () => (await said()).length === count + 1 && HEARD.test((await said()).at(-1) ?? ""), 60);

  // 6. A tap listens until the next tap, which sends.
  await until(idle, "him to be done", 30);
  count = (await said()).length;
  await keys(tap);
  await check("tapListens", listening, 5);
  await sleep(HOLD);
  checks.tapKeepsListening = await listening();
  await keys(tap);
  await check("secondTapSends", async () => (await said()).length === count + 1, 60);

  // 7. Esc stops him, and nothing is sent.
  await until(idle, "him to be done", 30);
  count = (await said()).length;
  await keys(tap);
  await until(listening, "listening", 5).catch(() => {});
  await sleep(1_500);
  await keys("k.escape();");
  await check("escStops", async () => !(await listening()), 5);
  await sleep(6_000);
  checks.escSendsNothing = (await said()).length === count;
  await keys(tap);
  await check("afterEscAPressListens", listening, 5);
  await keys("k.escape();");
  await until(async () => !(await listening()), "him to stop", 5).catch(() => {});

  // 8. The hook hears nothing: the shortcut alone, repeating while held, is a tap; the next press sends.
  await until(idle, "him to be done", 30);
  count = (await said()).length;
  void keys(`k.shortcut(); await wait(500); const end = Date.now() + ${HOLD - 500}; while (Date.now() < end) { k.shortcut(); await wait(33); }`);
  await check("unheardPressListens", listening, 5);
  await sleep(HOLD + 800);
  checks.unheardRepeatsKeepListening = await listening();
  await keys("k.shortcut();");
  await check("unheardSecondPressSends", async () => (await said()).length === count + 1, 60);

  // 9. Held again at once, while the last thing said is written down: both are sent, and letting go of the second sends it.
  await until(idle, "him to be done", 30);
  count = (await said()).length;
  const hold = `${heldDown} k.down(KEY); k.shortcut(); await wait(500); await repeat(${HOLD - 500}); k.up(KEY); ${modsUp}`;
  await keys(hold);
  await sleep(150);
  void keys(hold);
  await check("heldAgainWhileWritingListens", listening, 5);
  await sleep(HOLD + 500);
  await check("bothAreSent", async () => (await said()).length === count + 2, 90, async () => (await said()).slice(-2));
  checks.notLeftListening = !(await listening());

  // 10. Let go of before the microphone opens (it takes 1.5 s here): he stops once it opens, and the next press starts him again.
  await until(idle, "him to be done", 30);
  await page.evaluate(`(() => { const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__realGum = real;
    navigator.mediaDevices.getUserMedia = async (constraints) => { await new Promise((done) => setTimeout(done, 1500)); return real(constraints); }; return true; })()`);
  await keys(`${heldDown} k.down(KEY); k.shortcut(); await wait(500); await repeat(200); k.up(KEY); ${modsUp}`);
  await sleep(3_000);
  checks.releasedBeforeTheMicOpensDoesNotListenOn = !(await listening());
  await page.evaluate(`(() => { navigator.mediaDevices.getUserMedia = window.__realGum; return true; })()`);
  await until(idle, "him to be done", 30).catch(() => {});
  await keys(tap);
  await check("andTheNextPressStartsAgain", listening, 5);
  await keys("k.escape();");
  await until(async () => !(await listening()), "him to stop", 5).catch(() => {});
  checks.noPageErrors = page.errors.length === 0;
  notes.pageErrors = page.errors;

  // Settings says it works, holding and all.
  browser = await openChat(BASE, KEY);
  const settingsTalk = async () => {
    await browser!.send("Page.navigate", { url: `${BASE}/settings/desktop-pet` });
    await until(() => browser!.evaluate(`document.body.innerText.includes("Talk to Perry")`), "the shortcuts", 30).catch(() => {});
    await sleep(1_500);
    return await browser!.evaluate(`[...document.querySelectorAll("li")].find((li) => li.innerText.includes("Talk to Perry"))?.innerText ?? ""`) as string;
  };
  const working = await settingsTalk();
  checks.settingsSaysWorking = /Working in the desktop pet\./.test(working) && !/by tapping/.test(working);
  notes.settingsSaysWorking = working;

  // --- 11. Without the key hook -----------------------------------------------------------------------------------
  page.close();
  main.close();
  stop(pet);
  await sleep(1_500);
  pet = startPet("off");
  page = await connect(DEVTOOLS, (target) => target.type === "page" && target.url.startsWith(`${BASE}/pet`), "the pet's page, again");
  main = await connect(INSPECT, () => true, "his window's process, again");
  await until(() => main!.evaluate("Boolean(globalThis.perryFakeKeys)"), "the stand-in keys", 30);
  await check("petReportsTapOnly", async () => (await talkStanding()).hold === "off", 30, talkStanding);
  const tapOnly = await settingsTalk();
  const shot = await browser.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "settings-tap-only.png"), Buffer.from(shot.data, "base64"));
  checks.settingsSaysTapOnly = /by tapping/.test(tapOnly) && /Holding them doesn't work on this computer/.test(tapOnly);
  notes.settingsSaysTapOnly = tapOnly;
  count = (await said()).length;
  await keys("k.shortcut();");
  await check("tapOnlyListens", listening, 5);
  const hint = await text();
  checks.petSaysTapOnly = /Press Ctrl\+Alt\+Shift\+F7 again to send/.test(hint) && /Holding them doesn't work/.test(hint);
  notes.petSaysTapOnly = hint.split("\n").find((line) => line.startsWith("Listening.")) ?? hint.slice(-300);
  await photograph("tap-only.png");
  await sleep(HOLD);
  await keys("k.shortcut();");
  await check("tapOnlySends", async () => (await said()).length === count + 1, 60);
  checks.noPageErrorsTapOnly = page.errors.length === 0;
  notes.said = await said();
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  page?.close();
  main?.close();
  stop(pet);
  stop(server);
  await sleep(2_000);
  const after = ownersPets();
  checks.ownersPetUntouched = entry("Perry pet") === before.entry && before.pets.every((pid) => after.includes(pid));
  notes.ownersPetUntouched = { before: before.pets, after };
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  rmSync(SPOKEN_WAV, { force: true });
}

const result = { ranAt: new Date().toISOString(), spoken: SPOKEN, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed: result.passed, failed: Object.keys(checks).filter((name) => !checks[name]), stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
