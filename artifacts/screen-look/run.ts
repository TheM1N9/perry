import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/screen-look/run.ts <outDir>
// Issue #101, first part: show Perry the screen. A fresh Perry (production
// build, `pnpm build` first), the real runner and Codex (PERRY_E2E_MODEL picks
// the model), headless Chrome for the pet's page, and on Windows the real
// desktop pet (Electron) for the picture itself.
//
// Ways it could fail, written down before the checks:
//   1. The Look hotkey never reaches the pet's window, or its picture never
//      reaches his chat: nothing to check before sending.
//   2. The preview cannot be switched between the window and the whole
//      screen, or taken away, or the eye button does not take a new one.
//   3. The picture is not sent with the message: lost on the way to the media
//      server (no key in the pet's page), not attached, or not given to Codex,
//      so Perry cannot say what is on it.
//   4. The chat does not show the picture that was sent.
//   5. Settings does not list the Look shortcut, or does not say whether the
//      pet has its keys, or that an older pet needs a restart.
//   6. The real picture is of the wrong window: Perry himself, an overlay on
//      top of everything (the owner's own pet is one), or anything but the
//      window in front; or it comes back empty.
//   7. The test's pet touches the owner's own pet or its login entry.
//   8. Asked about something on screen, Perry cannot look by himself: the
//      tool never reaches the pet, the pet never answers, or the picture
//      never reaches Codex. Or he looks without the owner being able to see
//      what he saw (not in the chat, nothing on the pet).
//   9. Turned off in Settings, he looks anyway.
//
// Pictures of the real screen hold whatever the owner has open, so none is
// kept or described: only whether it is of the window in front (read here
// from user32, apart from Perry) and that it is not empty.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/screen-look/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "screen-look-e2e-key";
const LOOK_KEYS = "CommandOrControl+Alt+Shift+Space";
const home = mkdtempSync(join(tmpdir(), "perry-look-"));
// Away from the bottom-right corner, where the owner's own pet may be standing.
writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 40, y: 60 }));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const entry = (name: string) => {
  const found = spawnSync("reg", ["query", RUN_KEY, "/v", name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "" : null;
};
/** Pets running on this computer that are not this checkout's: the owner's own. */
const otherPets = () => (spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notlike '*${REPO.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`],
{ encoding: "utf8", windowsHide: true }).stdout ?? "").trim().split(/\s+/).filter(Boolean).sort();
const desktop = process.platform === "win32";
const before = desktop ? { entry: entry("Perry pet"), pets: otherPets() } : null;

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  PERRY_BUN: process.execPath, PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS),
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  return spawn(command, args, { cwd: REPO, env, stdio: "ignore", windowsHide: true });
}
const stop = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
const perry = (...args: string[]) => {
  const ran = spawnSync(process.execPath, [join(REPO, "scripts", "perry.ts"), ...args], { cwd: REPO, env, encoding: "utf8", windowsHide: true, timeout: 600_000 });
  return `${ran.stdout ?? ""}${ran.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
};
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
type Message = { role: string; text: string; attachments: Array<{ url: string; fileName: string; contentType: string }> };
const messagesOf = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 30, cursor: null } })).page;
const idle = (id: string) => until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id })).isRunning
  && !(await call<Array<{ status: string }>>("dashboard:listRuns", { key: KEY, conversationId: id })).some((run) => run.status === "running"), "the chat to be idle", 400);

/** The window in front, as user32 says, and whether a window lets clicks through: read apart from Perry, to check him. */
function user32(handle?: number): { front: number; through: boolean } {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class T { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr h, int i); }'",
    `ConvertTo-Json -Compress @{ front = [T]::GetForegroundWindow().ToInt64(); through = ${handle ? `(([T]::GetWindowLong([IntPtr][long]${handle}, -20) -band 0x20) -ne 0)` : "$false"} }`,
  ].join("; ");
  return JSON.parse(spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout.trim());
}
/** The real pet's page, over the DevTools protocol. */
async function petTab() {
  const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const target = list.find((item) => item.url.startsWith(`${BASE}/pet`));
  if (!target) throw new Error("his page is not open");
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
  return { evaluate, close: () => ws.close() };
}
const petPage = () => fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`).then((r) => r.json() as Promise<Array<{ url: string }>>).then((list) => list.some((item) => item.url.startsWith(`${BASE}/pet`)), () => false);

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const png = async () => (await send("Page.captureScreenshot", { format: "png" })).data as string;
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from(await png(), "base64"));

  // Two pictures, made here, as his window would take them: a terminal with an error, and a whole desktop.
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 420, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `data:text/html,${encodeURIComponent(`<body style="margin:0;background:#1e1e1e;color:#e5e5e5;font:18px Consolas,monospace;padding:24px">
<div style="color:#8a8a8a">PS C:\\Users\\mani\\shop&gt; npm install</div><div style="color:#f14c4c;margin-top:14px">npm ERR! code ENOSPC</div>
<div style="color:#f14c4c">npm ERR! syscall write</div><div style="color:#f14c4c">npm ERR! ENOSPC: no space left on device, write</div></body>`)}` });
  await sleep(800);
  const terminal = `data:image/png;base64,${await png()}`;
  await send("Page.navigate", { url: `data:text/html,${encodeURIComponent(`<body style="margin:0;background:#2b6cb0;font:20px system-ui;padding:40px;color:#fff">Desktop<div style="margin-top:30px;background:#fff7c2;color:#333;width:260px;padding:16px">Groceries: mangoes, curd</div></body>`)}` });
  await sleep(800);
  const wholeScreen = `data:image/png;base64,${await png()}`;
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // --- 1–4. The pet's page, with a stand-in for his window ----------------------------------------------
  const taken = { window: { name: "Windows PowerShell", image: terminal }, screen: { name: "Whole screen", image: wholeScreen } };
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__look = { listeners: [], keys: [], calls: 0 };
    window.__taken = ${JSON.stringify(taken)};
    window.perryPet = {
      solid() {}, moveTo() {}, dragStart() {}, dragEnd() {}, onArmed: () => () => {}, idleSeconds: async () => 0, openDashboard() {},
      hotkey: async () => ({ hotkey: "CommandOrControl+Shift+Space", error: null }), setHotkey: async (keys) => ({ hotkey: keys, error: null }),
      onVoice: () => () => {}, onVoiceProgress: () => () => {}, transcribe: async () => ({ text: "" }), voiceDone() {},
      look: async () => { window.__look.calls++; return window.__taken; },
      onLook: (listener) => { window.__look.listeners.push(listener); return () => {}; },
      setLookHotkey: async (keys) => { window.__look.keys.push(keys); return { hotkey: keys, error: null }; },
    };` });
  await send("Page.navigate", { url: `${BASE}/pet#key=${encodeURIComponent(KEY)}` });
  await until(() => evaluate(`window.__look.listeners.length > 0 && window.__look.keys.length > 0`), "the pet page to listen for Look", 30).catch(() => {});
  check("petTakesTheLookKeys", await evaluate(`window.__look.keys.includes(${JSON.stringify(LOOK_KEYS)})`));
  // The Look hotkey, pressed anywhere: his window sends the picture to the page.
  await evaluate(`window.__look.listeners.forEach((listener) => listener(window.__taken)); true`);
  const preview = `document.querySelector('[aria-label="Picture of the screen to send"]')`;
  await until(() => evaluate(`Boolean(${preview})`), "the preview", 15).catch(() => {});
  const first = await evaluate(`(() => { const box = ${preview}; return box ? { text: box.innerText, pressed: [...box.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent) } : null; })()`) as { text: string; pressed: string[] } | null;
  await shot("pet-preview.png");
  check("hotkeyPictureWaitsInTheChat", Boolean(first?.text.includes("Windows PowerShell")) && first?.pressed[0] === "This window", first);
  await evaluate(`[...${preview}.querySelectorAll("button")].find((b) => b.textContent === "Whole screen").click(); true`);
  await sleep(300);
  const switched = await evaluate(`${preview}.innerText`) as string;
  await evaluate(`document.querySelector('[aria-label="Don\\'t send the picture"]').click(); true`);
  await sleep(300);
  const removed = !(await evaluate(`Boolean(${preview})`));
  await evaluate(`document.querySelector('[aria-label="Show Perry the screen"]').click(); true`);
  await until(() => evaluate(`Boolean(${preview})`), "the picture from the button", 10).catch(() => {});
  check("previewSwitchesRemovesAndRetakes", switched.includes("Whole screen") && removed && (await evaluate(`window.__look.calls`)) === 1 && Boolean(await evaluate(`Boolean(${preview})`)), { switched, removed });

  const box = `document.querySelector('textarea[aria-label="Message Perry"]')`;
  await evaluate(`(() => { const el = ${box}; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; setter.call(el, "What went wrong here, and what should I do? Two short lines."); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await evaluate(`document.querySelector('button[aria-label="Send"]').click(); true`);
  await until(() => evaluate(`Boolean(localStorage.getItem("perry.pet.chat"))`), "the pet's chat", 20).catch(() => {});
  const chat = await evaluate(`localStorage.getItem("perry.pet.chat")`) as string;
  await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to start", 60).catch(() => {});
  await idle(chat);
  const messages = await messagesOf(chat);
  const asked = messages.find((message) => message.role === "user");
  const answer = messages.find((message) => message.role === "assistant")?.text ?? "";
  check("pictureGoesWithTheMessage", asked?.attachments.length === 1 && asked.attachments[0].contentType === "image/png" && /^What went wrong/.test(asked.text), asked);
  check("perryReadsThePicture", /ENOSPC|no space|disk (is )?full|free (up )?(some )?space|storage/i.test(answer), answer);
  check("previewGoneOnceSent", !(await evaluate(`Boolean(${preview})`)));
  const served = asked?.attachments[0] ? await fetch(new URL(asked.attachments[0].url, BASE), { headers: { cookie: `perry_media=${encodeURIComponent(KEY)}` } }) : null;
  const shown = await evaluate(`[...document.querySelectorAll("img")].some((img) => img.alt.startsWith("screen-") && img.complete && img.naturalWidth > 0)`);
  await shot("pet-sent.png");
  check("chatShowsThePicture", Boolean(shown) && served?.status === 200 && served.headers.get("content-type") === "image/png", { shown, served: served?.status });

  // --- 8, 9. Perry looks by himself, in a chat, through the pet -----------------------------------------------
  // The whole screen now holds the terminal with its error.
  await evaluate(`window.__taken = { ...window.__taken, screen: { name: "Whole screen", image: window.__taken.window.image } }; true`);
  const model = process.env.PERRY_E2E_MODEL;
  const helpChat = await call<string>("dashboard:createChat", { key: KEY });
  if (model) await call("dashboard:setChatModel", { key: KEY, id: helpChat, model });
  const ask = async (text: string) => {
    await call("dashboard:sendChat", { key: KEY, id: helpChat, text });
    await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: helpChat })).isRunning, "the reply to start", 60).catch(() => {});
    await idle(helpChat);
    return (await messagesOf(helpChat)).find((message) => message.role === "assistant")?.text ?? "";
  };
  const callsBefore = await evaluate(`window.__look.calls`) as number;
  // The owner is on the web chat, the pet's panel shut: his bubble says when he looks, for a few seconds.
  await evaluate(`document.querySelector('button[aria-label="Close"]')?.click(); true`);
  let bubbleSeen = false;
  const watching = (async () => { for (let i = 0; i < 600 && !bubbleSeen; i++) { bubbleSeen = Boolean(await evaluate(`document.body.innerText.includes("I looked at your screen")`).catch(() => false)); if (bubbleSeen) await shot("pet-perry-looked.png"); else await sleep(500); } })();
  const looked = await ask("Something just broke in my terminal. Can you look at my screen and tell me what the error is? One line.");
  await Promise.race([watching, sleep(1_000)]);
  const shared = (await messagesOf(helpChat)).filter((message) => message.role === "assistant").flatMap((message) => message.attachments);
  check("perryLooksWhenNeeded", /ENOSPC|no space|disk (is )?full|out of (disk )?space/i.test(looked) && (await evaluate(`window.__look.calls`)) === callsBefore + 1, looked);
  check("whatHeSawIsInTheChat", shared.some((file) => file.contentType === "image/png"), shared);
  check("petSaysHeLooked", bubbleSeen);
  await call("screen:setSetting", { key: KEY, enabled: false });
  const offCalls = await evaluate(`window.__look.calls`) as number;
  const refused = await ask("Look at my screen once more and tell me what you see now.");
  check("offMeansNoLooking", (await evaluate(`window.__look.calls`)) === offCalls, refused);
  await call("screen:setSetting", { key: KEY, enabled: true });

  // --- 5. Settings ------------------------------------------------------------------------------------------
  await until(async () => (await call<{ pet: { keys: Record<string, { hotkey?: string }> } }>("dashboard:getShortcuts", { key: KEY })).pet.keys.look?.hotkey === LOOK_KEYS, "the pet to report its Look keys", 20).catch(() => {});
  await send("Page.navigate", { url: `${BASE}/settings/desktop-pet` });
  await until(() => evaluate(`document.body.innerText.includes("Show Perry the screen")`), "the shortcuts", 30).catch(() => {});
  await sleep(1_000);
  const rowOf = `[...document.querySelectorAll("li")].find((li) => li.innerText.includes("Show Perry the screen"))?.innerText ?? ""`;
  const working = await evaluate(rowOf) as string;
  const talk = await evaluate(`[...document.querySelectorAll("li")].find((li) => li.innerText.includes("Talk to Perry"))?.innerText ?? ""`) as string;
  await shot("settings-shortcuts.png");
  check("talkKeysStillReported", /Working in the desktop pet/.test(talk), talk);
  await call("todos:presence", { key: KEY, idleSeconds: 0, hotkey: "CommandOrControl+Shift+Space", keys: { look: { error: "restart" } } });
  await until(async () => /Restart the desktop pet/.test(await evaluate(rowOf)), "the restart note", 15).catch(() => {});
  const restart = await evaluate(rowOf) as string;
  check("settingsListsLookAndItsStanding", /Working in the desktop pet/.test(working) && /Restart the desktop pet/.test(restart), { working, restart });
  check("noPageErrors", browser.errors.length === 0, browser.errors);

  // --- 6, 7. The real pet takes the picture -----------------------------------------------------------------
  if (desktop) {
    notes.perryPet = perry("pet").trim().split(/\r?\n/).slice(-3);
    await until(petPage, "the real pet", 120);
    const pet = await petTab();
    try {
      await until(() => pet.evaluate(`Boolean(window.perryPet?.look)`), "his bridge", 30);
      const frontBefore = user32().front;
      const real = await pet.evaluate(`window.perryPet.look()`) as { window?: { id: string; name: string; image: string }; screen?: { name: string; image: string }; frontListed?: boolean; error?: string };
      const frontAfter = user32().front;
      const chosen = Number(real.window?.id.split(":")[1]);
      // The owner may switch windows meanwhile; then the check says so rather than failing.
      const steady = frontBefore === frontAfter;
      // Some windows in front cannot be pictured (Windows' own search panel, for one); then the topmost other one that takes clicks is.
      const isTheFront = real.window?.id === `window:${frontBefore}:0`;
      const clickThrough = Number.isFinite(chosen) ? user32(chosen).through : null;
      check("realPictureIsTheWindowInFront", !steady || (real.frontListed ? isTheFront : clickThrough === false) && (real.window?.image.length ?? 0) > 5_000,
        { error: real.error, steady, frontListed: real.frontListed, isTheFront, clickThrough });
      check("realScreenPicture", Boolean(real.screen?.image.startsWith("data:image/png") && real.screen.image.length > 20_000), { screenBytes: real.screen?.image.length });
      await until(async () => { const look = (await call<{ pet: { keys: Record<string, { hotkey?: string; error?: string }> } }>("dashboard:getShortcuts", { key: KEY })).pet.keys.look; return look?.hotkey === LOOK_KEYS || look?.error === "taken"; }, "the real pet's Look keys", 90).catch(() => {});
      const look = (await call<{ pet: { keys: Record<string, { hotkey?: string; error?: string }> } }>("dashboard:getShortcuts", { key: KEY })).pet.keys.look;
      check("realPetTakesTheLookKeys", look?.hotkey === LOOK_KEYS || look?.error === "taken", look);
    } finally {
      pet.close();
    }
    notes.perryPetOff = perry("pet", "off").trim().split(/\r?\n/).slice(-2);
    await until(async () => !(await petPage()), "the real pet to quit", 20).catch(() => {});
    check("ownersPetUntouched", entry("Perry pet") === before!.entry && JSON.stringify(otherPets()) === JSON.stringify(before!.pets)
      && entry(`Perry pet-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`) === null);
  }
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (desktop && !("ownersPetUntouched" in checks)) perry("pet", "off");
  stop(runner);
  stop(server);
  await sleep(2_000);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
