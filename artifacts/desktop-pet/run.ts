import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EOL, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/desktop-pet/run.ts <outDir>
// Perry on the desktop, for real: `perry pet` installs and starts the pet's
// window against a fresh Perry (its own PERRY_HOME and port), with a stand-in
// Telegram and the real runner and Codex (PERRY_E2E_MODEL picks the model).
// The pet's page is driven over DevTools and photographed alone; the real
// screen is photographed once, over a window of this script's own, so nothing
// else on it is kept. With PERRY_E2E_DESKTOP=1 the real mouse is used too, over a test window
// of this script's own, to check what clicks pass through him.
//
// Ways it could fail:
//   1. `perry pet` does not start him, or not at login: the pet's page must
//      load unlocked, and the login entry must name Electron and pet/.
//   2. His window is not see-through, or not on top: the page's background
//      must be clear; on the real screen, another app's window must show
//      through the empty part, and one that puts itself on top of everything
//      after him must be under him again within 15 seconds.
//   3. What is due does not reach him: a to-do 12 minutes off must get a
//      heads-up, one 4 minutes off a live countdown, a late one a bubble with
//      Done and push-backs, most pressing first.
//   4. Done in his bubble does not tick it off, or the streak does not count it.
//   5. Later does not push it back ten minutes.
//   6. Typing "water the plants in 30 min" does not read the time: the preview
//      must show it, and Enter must add it due in half an hour. "stretch
//      every day at 11" must be kept as a daily repeat, and his row say so.
//   7. Dragging him does not move the window, he forgets where he was put,
//      or he can be dragged off the screen.
//  7b. There is no way to put him away by dragging: while dragged, a circle
//      must show at the bottom middle of the screen and say so when he is over
//      it (red on the real screen, not only in its page); dropped there he
//      must be gone from the screen, not moved, and
//      `perry pet` must bring him back where he was.
//   8. Perry, asked on Telegram, makes a job instead of a to-do, or the wrong
//      time; and the pet does not say that Perry added it.
//  8b. He is not a small Perry: his chat must be one of the dashboard's
//      chats, open first, and know what was said on Telegram; closed while
//      Perry works, he must say he is on it, then hold up the reply until it
//      is opened.
//  8d. Talking to him: the mic button must put what was said in the box and
//      not send it; the hotkey from anywhere must open him listening, and
//      tapped again (or held and let go) send it, and Perry must then do it
//      (the to-do, at the time said); Esc must stop him with nothing sent.
//  8c. A computer waiting for a yes is not put to you by him: his bubble must
//      show the command, his badge the count, and Approve must answer it.
//   9. The phone is nagged while the owner is at the computer with the pet,
//      or not nagged once away; the reminder has no buttons; Done on Telegram
//      does not tick it off or leaves the buttons on the card.
//  10. "Tomorrow" on Telegram does not keep its time of day.
//  11. Answering a reminder in words ("done") does not reach the right to-do.
//  12. End the day moves late things to now rather than tomorrow; the
//      dashboard's To-dos page does not show the same list.
//  12c. Keyboard shortcuts: a key without Ctrl, Alt or ⌘ must be refused,
//      and one another shortcut has; keys pressed in Settings must be saved,
//      shown, and work there and then, the old ones letting go; Talk to Perry's
//      new keys must move the pet's hotkey and start him listening; keys
//      another app holds must leave him on his old ones, and Settings say so.
//  13. Real clicks: a click on empty window must reach what is under him,
//      and a click on him must open the list and not pass through.
//  14. `perry pet off` leaves him running or starting at login.
//  14b. He never rests, or wakes too slowly: with nothing going on he must
//      nap within 45 seconds (hat off, Z's), and touched, wake at once and
//      stay awake (artifacts: perry-naps-and-wakes.gif).
//  15. The page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/desktop-pet/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "desktop-pet-e2e-key";
const OWNER = "4242";
const REAL_MOUSE = process.env.PERRY_E2E_DESKTOP === "1" && process.platform === "win32";
const home = mkdtempSync(join(tmpdir(), "perry-pet-"));
/** This Perry's pet's login entry: its own, named after its PERRY_HOME, never the owner's "Perry pet". */
const LOGIN_ENTRY = `Perry pet-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
/** What the stand-in microphone says, in Windows' own voice; kept apart from the other runs' model downloads. */
const SPOKEN = "Remind me to call Sam at five p.m. tomorrow.";
const MODELS = join(tmpdir(), "perry-e2e-models");
const SPOKEN_WAV = join(tmpdir(), `perry-e2e-spoken-${PORT}.wav`);
const VOICE = process.platform === "win32" && spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)",
  `$s.SetOutputToWaveFile('${SPOKEN_WAV}', $f)`,
  `$s.Speak('${SPOKEN}')`,
  "$s.Dispose()",
].join("; ")], { windowsHide: true }).status === 0 && existsSync(SPOKEN_WAV);

/** The real keyboard: Ctrl+Shift+Space tapped, or held down, or let go. */
function hotkey(how: "tap" | "down" | "up") {
  const down = "[K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0x20, 0, 0, [UIntPtr]::Zero)";
  const up = "[K]::keybd_event(0x20, 0, 2, [UIntPtr]::Zero); [K]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero); [K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)";
  keyboard(how === "tap" ? `${down}; Start-Sleep -Milliseconds 80; ${up}` : how === "down" ? down : up);
}
function pressKey(vk: number) {
  keyboard(`[K]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [K]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`);
}
function keyboard(script: string) {
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); }'; ${script}`,
  ], { windowsHide: true });
}
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

// --- A stand-in Telegram ------------------------------------------------------

type Sent = { id: number; chat_id: string; text: string; buttons: string[]; at: number };
const telegram = { sent: [] as Sent[], pending: [] as object[], answered: [] as string[], nextUpdate: 1 };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 1, is_bot: true, username: "perry_e2e_bot" });
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    const buttons = (markup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> }) => (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
    if (method === "sendMessage") {
      const id = telegram.sent.length + 1;
      telegram.sent.push({ id, chat_id: String(args.chat_id), text: String(args.text), buttons: buttons(args.reply_markup), at: Date.now() });
      return reply({ message_id: id });
    }
    if (method === "editMessageText") {
      const message = telegram.sent[Number(args.message_id) - 1];
      if (message) Object.assign(message, { text: String(args.text), buttons: buttons(args.reply_markup) });
      return reply(true);
    }
    if (method === "answerCallbackQuery") telegram.answered.push(String(args.text ?? ""));
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const from = { id: Number(OWNER), is_bot: false, first_name: "Mani", username: "The_M1N9" };
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from, text },
});
const ownerTaps = (message: Sent, data: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  callback_query: { id: `tap-${telegram.nextUpdate}`, from, data, message: { message_id: message.id, chat: { id: Number(OWNER) } } },
});
const toOwner = (after: number) => telegram.sent.filter((message) => message.chat_id === OWNER && message.at > after);

// --- Perry: the server, the runner, the CLI -------------------------------------

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:desktop-pet-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
  PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS),
  PERRY_MODELS_DIR: MODELS,
  ...(VOICE ? { PERRY_PET_FAKE_MIC: SPOKEN_WAV } : {}),
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY") delete env[name];
const logs = { server: "", runner: "" };
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child = spawn(command, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  return child;
}
const stop = (child: ChildProcess | null) => {
  if (!child?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};
const perry = (...args: string[]) => {
  const ran = spawnSync(process.execPath, [join(REPO, "scripts", "perry.ts"), ...args], { cwd: REPO, env, encoding: "utf8", windowsHide: true });
  return `${ran.stdout ?? ""}${ran.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
};
async function call<T>(path: string, args: object = {}, as: "admin" | "call" = "admin"): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${as}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(as === "admin" ? { "x-perry-key": KEY } : {}) },
    body: JSON.stringify({ path, args }),
  });
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
async function check(name: string, test: () => Promise<boolean> | boolean, seconds = 20) {
  checks[name] = await until(test, name, seconds).then(() => true, () => false);
  if (!checks[name]) console.log(`FAILED: ${name}`);
}

type Todo = { id: string; title: string; dueAt?: number; repeat?: string; doneAt?: number; by: string };
type Board = { timezone: string; open: Todo[]; doneToday: Todo[]; streak: number };
const board = () => call<Board>("todos:board", { key: KEY }, "call");
const find = async (title: RegExp) => { const now = await board(); return [...now.open, ...now.doneToday].find((todo) => title.test(todo.title)); };
const add = (title: string, dueAt?: number) => call<string>("todos:add", { key: KEY, title, ...(dueAt ? { dueAt } : {}) }, "call");
const minutes = (n: number) => n * 60_000;

// --- The pet's page, over DevTools ------------------------------------------------

type Cdp = { send: (method: string, params?: object) => Promise<any>; evaluate: (expression: string) => Promise<any>; errors: string[]; close: () => void };
async function attach(): Promise<Cdp> {
  let page: { webSocketDebuggerUrl: string } | undefined;
  await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    page = targets.find((target) => target.type === "page" && target.url.startsWith(`${BASE}/pet`));
    return Boolean(page);
  }, "the pet's page", 60);
  const ws = new WebSocket(page!.webSocketDebuggerUrl);
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

/**
 * What his window shows, see-through where it is: the page alone, so nothing
 * else on this computer's screen ends up in the artifact.
 */
async function photograph(pet: Cdp, name: string) {
  await pet.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot = await pet.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64"));
}

/** Part of the real screen, as a PNG, and the colours of some of its pixels (screen pixels, not points). */
function screenshot(box: { x: number; y: number; w: number; h: number }, file: string, points: Array<[number, number]>): string[] {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Dpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
    "[Dpi]::SetProcessDPIAware() | Out-Null",
    `$bmp = New-Object System.Drawing.Bitmap ${box.w}, ${box.h}`,
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    `$g.CopyFromScreen(${box.x}, ${box.y}, 0, 0, $bmp.Size)`,
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ...points.map(([x, y]) => `$c = $bmp.GetPixel(${x - box.x}, ${y - box.y}); "$($c.R),$($c.G),$($c.B)"`),
  ].join("; ");
  const output = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  // PowerShell writes a line per pixel, ending as Windows lines end.
  return output.trim().split(EOL).map((line) => line.trim());
}

/**
 * A plain window of this script's own over the corner he stands in, put on
 * top of everything (topmost) after him, the way another app might.
 */
function backdrop(box: { x: number; y: number; w: number; h: number }, log: string): ChildProcess {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class D { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
    "[D]::SetProcessDPIAware() | Out-Null",
    "$f = New-Object System.Windows.Forms.Form; $f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false; $f.TopMost = $true",
    `$f.Bounds = New-Object System.Drawing.Rectangle ${box.x}, ${box.y}, ${box.w}, ${box.h}`,
    "$f.BackColor = [System.Drawing.Color]::FromArgb(236, 240, 244)",
    "$l = New-Object System.Windows.Forms.Label; $l.Text = 'Another app, always on top'; $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point 12, 12; $f.Controls.Add($l)",
    `$f.Add_Shown({ Add-Content -Path '${log}' -Value 'shown' -Encoding ascii })`,
    "$t = New-Object System.Windows.Forms.Timer; $t.Interval = 60000; $t.Add_Tick({ $f.Close() }); $t.Start()",
    "[System.Windows.Forms.Application]::Run($f)",
  ].join("; ");
  return spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
}

/** The real mouse, moved the way a hand moves it (the pet's window only hears real input), then pressed. */
function realClick(x: number, y: number) {
  const script = [
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class M { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.IntPtr e); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i); }'",
    "[M]::SetProcessDPIAware() | Out-Null",
    "$w = [M]::GetSystemMetrics(0); $h = [M]::GetSystemMetrics(1)",
    `foreach ($d in @(10, 5, 0)) { [M]::mouse_event(0x8001, [uint32]((${x} - $d) * 65535 / ($w - 1)), [uint32]((${y} - $d) * 65535 / ($h - 1)), 0, [System.IntPtr]::Zero); Start-Sleep -Milliseconds 150 }`,
    "Start-Sleep -Milliseconds 300",
    "[M]::mouse_event(2, 0, 0, 0, [System.IntPtr]::Zero); Start-Sleep -Milliseconds 60; [M]::mouse_event(4, 0, 0, 0, [System.IntPtr]::Zero)",
  ].join("; ");
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}

/** A plain window of this script's own under the pet, which notes every click that reaches it. */
function catcher(box: { x: number; y: number; w: number; h: number }, log: string): ChildProcess {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class D { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
    "[D]::SetProcessDPIAware() | Out-Null",
    "$f = New-Object System.Windows.Forms.Form; $f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false",
    `$f.Bounds = New-Object System.Drawing.Rectangle ${box.x}, ${box.y}, ${box.w}, ${box.h}`,
    "$f.BackColor = [System.Drawing.Color]::FromArgb(236, 240, 244)",
    "$l = New-Object System.Windows.Forms.Label; $l.Text = 'Test window: clicks that pass through the pet land here'; $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point 12, 12; $f.Controls.Add($l)",
    `$f.Add_MouseDown({ param($s, $e) Add-Content -Path '${log}' -Value \"click $($e.X),$($e.Y)\" -Encoding ascii })`,
    `$f.Add_Shown({ $f.Activate(); Add-Content -Path '${log}' -Value 'shown' -Encoding ascii })`,
    "$t = New-Object System.Windows.Forms.Timer; $t.Interval = 60000; $t.Add_Tick({ $f.Close() }); $t.Start()",
    "[System.Windows.Forms.Application]::Run($f)",
  ].join("; ");
  return spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
}

/** A mouse press, move and release inside the page (not the real mouse). */
async function dispatch(pet: Cdp, type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) {
  await pet.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse" });
}
const petBox = (pet: Cdp) => pet.evaluate(`(() => { const r = document.querySelector('button[aria-label^="Perry."]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number }>;
const text = (pet: Cdp) => pet.evaluate("document.body.innerText") as Promise<string>;
const clickButton = (pet: Cdp, label: string) => pet.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`) as Promise<boolean>;
const panelOpen = (pet: Cdp) => pet.evaluate(`Boolean(document.querySelector('section[aria-label="Perry"]'))`) as Promise<boolean>;
const clickTab = (pet: Cdp, label: string) => pet.evaluate(`(() => { const tab = [...document.querySelectorAll('[role=tab]')].find((tab) => tab.innerText.trim().startsWith(${JSON.stringify(label)})); tab?.click(); return Boolean(tab); })()`) as Promise<boolean>;
async function pressEnter(pet: Cdp) {
  await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await pet.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

const server = start("server");
let runner: ChildProcess | null = null;
let pet: Cdp | null = null;
let catcherWindow: ChildProcess | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);

  // 1. `perry pet` starts him, unlocked, and at login.
  const started = perry("pet");
  notes.perryPet = started.trim();
  pet = await attach();
  await check("petStarted", async () => (await pet!.evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]')) && !document.body.innerText.includes("locked out")`)) === true, 30);
  if (process.platform === "win32") {
    const entry = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", LOGIN_ENTRY], { encoding: "utf8" }).stdout ?? "";
    notes.loginEntry = entry.trim().split(/\r?\n/).pop()?.trim();
    checks.startsAtLogin = /electron\.exe" "[^"]*[\\/]pet"/i.test(entry);
  }
  // 2. See-through.
  checks.seeThrough = (await pet.evaluate("getComputedStyle(document.body).backgroundColor + '|' + getComputedStyle(document.documentElement).backgroundColor")) === "rgba(0, 0, 0, 0)|rgba(0, 0, 0, 0)";
  // 2b. On the real screen: see-through over another app's window, and back on top of one that put itself above him.
  if (process.platform === "win32") {
    const window = await pet.evaluate("({ x: window.screenX, y: window.screenY, w: innerWidth, h: innerHeight, scale: devicePixelRatio })") as { x: number; y: number; w: number; h: number; scale: number };
    const px = (n: number) => Math.round(n * window.scale);
    const body = await petBox(pet);
    const box = { x: px(window.x - 120), y: px(window.y), w: px(window.w + 120), h: px(window.h) };
    const log = join(tmpdir(), `pet-backdrop-${PORT}.txt`);
    const other = backdrop(box, log);
    await until(() => existsSync(log), "the other window", 15);
    // He takes the top back within 15 seconds.
    await sleep(16_500);
    const [empty, him] = screenshot(box, join(outDir, "on-the-desktop.png"), [[px(window.x + 30), px(window.y + 40)], [px(window.x + body.x), px(window.y + body.y + 12)]]);
    notes.desktopPixels = { empty, him };
    checks.seeThroughOnScreen = empty === "236,240,244";
    checks.backOnTop = Boolean(him) && him !== "236,240,244";
    stop(other);
    rmSync(log, { force: true });
  }

  // The page tells the server this computer's timezone, as the dashboard does.
  await until(async () => (await board()).timezone !== "UTC" || Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC", "the timezone");
  notes.timezone = (await board()).timezone;

  // 3. Most pressing first: a heads-up, then a countdown, then something late.
  const now = Date.now();
  await add("Stretch", now + minutes(12));
  await check("headsUp", async () => /Psst: Stretch[\s\S]*in 1[12] min/.test(await text(pet!)));
  await add("Call Sam", now + minutes(4));
  await check("countdown", async () => /Call Sam\s+in 3:\d\d/.test(await text(pet!)));
  await photograph(pet, "countdown.png");
  await add("Pay rent", now - minutes(2));
  await check("late", async () => /Pay rent\s+2:\d\d late\s+Done\s+10 min\s+1 hour/.test(await text(pet!)));
  await photograph(pet, "late.png");

  // 4. Done, from his bubble; and the streak.
  await clickButton(pet, "Done");
  await check("doneFromBubble", async () => Boolean((await find(/Pay rent/))?.doneAt));
  await check("streak", async () => (await board()).streak === 1);
  await check("cheers", async () => (await text(pet!)).includes("Done!"), 5);
  // 5. Later on the countdown: ten minutes from now.
  await check("countdownAgain", async () => /Call Sam\s+in 3:\d\d/.test(await text(pet!)), 10);
  const beforeLater = Date.now();
  await clickButton(pet, "Later");
  await check("later", async () => { const sam = await find(/Call Sam/); return Boolean(sam?.dueAt && Math.abs(sam.dueAt - (beforeLater + minutes(10))) < 30_000); });

  // 6. Typed as said, read before it is added.
  const at = await petBox(pet);
  await dispatch(pet, "mousePressed", at.x, at.y);
  await dispatch(pet, "mouseReleased", at.x, at.y);
  await check("listOpens", () => panelOpen(pet!), 5);
  await clickTab(pet, "To-dos");
  await pet.evaluate(`document.querySelector('input[aria-label="Add a to-do"]').focus()`);
  await pet.send("Input.insertText", { text: "water the plants in 30 min" });
  const typedAt = Date.now();
  await check("previewShown", async () => /“water the plants”/.test(await text(pet!)), 5);
  notes.preview = await pet.evaluate(`document.querySelector('section[aria-label="Perry"] form')?.innerText ?? ""`);
  await photograph(pet, "list.png");
  await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await pet.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await check("quickAdd", async () => { const plants = await find(/^water the plants$/); return Boolean(plants?.dueAt && Math.abs(plants.dueAt - (typedAt + minutes(30))) < 90_000); });
  await pet.send("Input.insertText", { text: "stretch every day at 11" });
  await check("repeatPreviewShown", async () => /Every day at 11:00/.test(await text(pet!)), 5);
  await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await pet.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await check("repeatAddedInPet", async () => (await find(/^stretch$/))?.repeat === "0 11 * * *");
  await check("repeatShownInPet", async () => /stretch\s*Daily/.test(await text(pet!)), 5);
  notes.repeatInPet = (await board()).open.filter((todo) => /stretch/i.test(todo.title));
  await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  // 7. Dragged, he moves and remembers.
  const before = await pet.evaluate("({ x: window.screenX, y: window.screenY })") as { x: number; y: number };
  // One step of the drag: the page's own events stand still while the window moves under them, as a real pointer's do not.
  const drag = async (dx: number, dy: number) => {
    const grab = await petBox(pet!);
    await dispatch(pet!, "mousePressed", grab.x, grab.y);
    await dispatch(pet!, "mouseMoved", grab.x + dx, grab.y + dy);
    await dispatch(pet!, "mouseReleased", grab.x + dx, grab.y + dy);
    await sleep(1_200);
    return await pet!.evaluate("({ x: window.screenX, y: window.screenY })") as { x: number; y: number };
  };
  const after = await drag(-240, -150);
  notes.dragged = { before, after };
  checks.dragMoves = after.x === before.x - 240 && after.y === before.y - 150;
  const saved = existsSync(join(home, "pet.json")) ? JSON.parse(readFileSync(join(home, "pet.json"), "utf8")) as { x?: number; y?: number } : {};
  checks.dragRemembered = saved.x === after.x && saved.y === after.y;
  checks.draggingIsNotAClick = !(await panelOpen(pet));
  // Past the corner, he stops at the screen's edge.
  const cornered = await drag(400, 400);
  checks.keptOnScreen = cornered.x === before.x && cornered.y === before.y;

  // 7b. Dragged onto the circle at the bottom middle of the screen, he hides; `perry pet` brings him back where he was.
  {
    // Whether his window is on screen, as Windows lists visible windows (his page says it is visible either way).
    const petShowing = () => (spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", [
      "Add-Type -TypeDefinition 'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public class W { delegate bool Enum(IntPtr h, IntPtr l); [DllImport(\"user32.dll\")] static extern bool EnumWindows(Enum f, IntPtr l); [DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h); [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out int p); public static List<string> Visible(int[] pids) { var t = new List<string>(); EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (IsWindowVisible(h) && Array.IndexOf(pids, p) >= 0) { var s = new StringBuilder(256); GetWindowText(h, s, 256); t.Add(s.ToString()); } return true; }, IntPtr.Zero); return t; } }'",
      `$ours = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${REPO.replace(/'/g, "''")}*' } | ForEach-Object { [int]$_.ProcessId })`,
      "[W]::Visible($ours) | Where-Object { $_ -like 'Pet*Perry' }",
    ].join("; ")], { encoding: "utf8", windowsHide: true }).stdout ?? "").trim().length > 0;
    const place = await pet.evaluate(`(() => { const r = document.querySelector('button[aria-label^="Perry."]').getBoundingClientRect(); return { bx: r.x + r.width / 2, by: r.y + r.height / 2, sx: screenX, sy: screenY, aw: screen.availWidth, ah: screen.availHeight, al: screen.availLeft, at: screen.availTop, scale: devicePixelRatio }; })()`) as { bx: number; by: number; sx: number; sy: number; aw: number; ah: number; al: number; at: number; scale: number };
    const target = { x: place.al + place.aw / 2, y: place.at + place.ah - 8 - 110 };
    const dx = Math.round(target.x - (place.sx + place.bx));
    const dy = Math.round(target.y - (place.sy + place.by));
    // A plain window of this script's own behind where he is dropped, for the photo.
    const px = (n: number) => Math.round(n * place.scale);
    const box = { x: px(target.x - 260), y: px(target.y - 320), w: px(520), h: px(430) };
    const log = join(tmpdir(), `pet-backdrop-${PORT}-drop.txt`);
    const other = process.platform === "win32" ? backdrop(box, log) : null;
    if (other) await until(() => existsSync(log), "the other window", 15);
    await dispatch(pet, "mousePressed", place.bx, place.by);
    await dispatch(pet, "mouseMoved", place.bx + dx, place.by + dy);
    const circleLabel = async () => {
      const targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
      const circle = targets.find((item) => item.url.startsWith("data:text/html"));
      if (!circle) return null;
      const ws = new WebSocket(circle.webSocketDebuggerUrl);
      await new Promise((done) => ws.addEventListener("open", done, { once: true }));
      const value = await new Promise<string>((done) => {
        ws.addEventListener("message", (event) => done(JSON.parse(String(event.data)).result?.result?.value ?? ""), { once: true });
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "label.textContent", returnByValue: true } }));
      });
      ws.close();
      return value;
    };
    await check("circleShowsWhileDragged", async () => (await circleLabel()) !== null, 5);
    await check("overCircleArms", async () => (await circleLabel()) === "Let go to hide him", 5);
    if (other) {
      await sleep(600);
      // A point on the circle beside him, as the screen shows it: red while he is over it.
      const [ring] = screenshot(box, join(outDir, "drop-to-hide.png"), [[px(target.x + 48), px(target.y)]]);
      const [red, green, blue] = (ring ?? "").split(",").map(Number);
      notes.circlePixel = ring;
      checks.circleRedOnScreen = red > 180 && green < 90 && blue < 90;
    }
    await dispatch(pet, "mouseReleased", place.bx + dx, place.by + dy);
    await sleep(1_000);
    if (process.platform === "win32") checks.droppedHides = !petShowing();
    const saved = JSON.parse(readFileSync(join(home, "pet.json"), "utf8")) as { x?: number; y?: number };
    checks.hiddenWhereHeWas = saved.x === place.sx && saved.y === place.sy;
    stop(other);
    rmSync(log, { force: true });
    perry("pet");
    if (process.platform === "win32") await check("perryPetBringsHimBack", petShowing, 15);
    checks.backWhereHeWas = JSON.stringify(await pet.evaluate("({ x: screenX, y: screenY })")) === JSON.stringify({ x: place.sx, y: place.sy });
  }

  // 8. Asked on Telegram, Perry adds a to-do at that time, and the pet says so.
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const model = process.env.PERRY_E2E_MODEL;
  if (model) {
    const chat = await call<{ _id: string } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER });
    if (chat) await call("conversations:setModel", { id: chat._id, model });
  }
  const dentistAt = new Date(Date.now() + 3 * 3_600_000);
  dentistAt.setSeconds(0, 0);
  dentistAt.setMinutes(dentistAt.getMinutes() < 30 ? 0 : 30);
  // Which day, said as a person would: past midnight, "at 6 AM" alone was taken for tomorrow's.
  const day = dentistAt.toDateString() === new Date().toDateString() ? "today" : "tomorrow";
  const said = `Remind me to call the dentist ${day} at ${dentistAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  const askedAt = Date.now();
  ownerSays(said);
  await until(async () => (await call<Array<{ prompt: string; status: string }>>("dashboard:listRuns", { key: KEY }, "call")).some((run) => run.prompt === said && run.status !== "running"), "Perry's reply", 300);
  await until(() => toOwner(askedAt).length > 0, "the reply on Telegram", 30);
  notes.dentistReply = toOwner(askedAt).map((message) => message.text).join("\n");
  const dentist = await find(/dentist/i);
  notes.dentist = dentist && { title: dentist.title, due: dentist.dueAt && new Date(dentist.dueAt).toString(), by: dentist.by };
  checks.agentAddsTodo = Boolean(dentist && dentist.by === "assistant" && dentist.dueAt === dentistAt.getTime());
  checks.agentMadeNoJob = !(await call<Array<{ builtin?: string }>>("jobs:list")).some((job) => !job.builtin);
  await check("petSaysPerryAdded", async () => /Perry added “[^”]*dentist/i.test(await text(pet!)), 10);
  await photograph(pet, "perry-added.png");

  // 8b. A small Perry: his panel's chat is one of your chats, with everything Perry knows from the others.
  const openPanel = async () => {
    if (await panelOpen(pet!)) return;
    const body = await petBox(pet!);
    await dispatch(pet!, "mousePressed", body.x, body.y);
    await dispatch(pet!, "mouseReleased", body.x, body.y);
    await until(() => panelOpen(pet!), "his panel", 5);
  };
  // His panel shuts when his window loses the focus (anything else on this screen can take it), so each step opens it again.
  const ask = async (words: string) => {
    await openPanel();
    await clickTab(pet!, "Chat");
    await pet!.evaluate(`document.querySelector('textarea[aria-label="Message Perry"]').focus()`);
    await pet!.send("Input.insertText", { text: words });
    await pressEnter(pet!);
  };
  const answered = (words: string) => until(async () => (await call<Array<{ prompt: string; status: string }>>("dashboard:listRuns", { key: KEY }, "call")).some((run) => run.prompt === words && run.status !== "running"), `Perry's answer to "${words}"`, 300);
  await openPanel();
  await clickTab(pet, "Chat");
  checks.chatTabFirst = (await pet.evaluate(`document.querySelector('[role=tab][aria-selected=true]')?.innerText.trim()`)) === "Chat";
  const question = "What did I ask you to remind me about on Telegram today? Answer in one short line.";
  await ask(question);
  await answered(question);
  await openPanel();
  await clickTab(pet, "Chat");
  const petChatId = await pet.evaluate(`localStorage.getItem("perry.pet.chat")`) as string | null;
  await check("petChatKnowsTelegram", async () => /dentist/i.test(await pet!.evaluate(`document.querySelector('section[aria-label="Perry"]')?.innerText ?? ""`) as string), 20);
  notes.petChatAnswer = (await pet.evaluate(`[...document.querySelectorAll('section[aria-label="Perry"] .prose-chat')].pop()?.innerText ?? ""`) as string).trim();
  checks.petChatIsADashboardChat = Boolean(petChatId) && (await call<Array<{ id: string }>>("dashboard:listChats", { key: KEY }, "call")).some((chat) => chat.id === petChatId);
  await photograph(pet, "pet-chat.png");
  // Closed while he works: he says he is on it, then holds up the reply until it is read.
  const second = "Reply with just the word: pineapple";
  await ask(second);
  await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await check("workingBubble", async () => (await text(pet!)).includes("On it…"), 60);
  await answered(second);
  await check("replyBubble", async () => /^Perry\s+pineapple/im.test(await text(pet!)), 20);
  await photograph(pet, "reply.png");
  await pet.evaluate(`[...document.querySelectorAll('[role=status]')].find((bubble) => bubble.innerText.startsWith("Perry"))?.click()`);
  await check("replyOpensChat", async () => (await panelOpen(pet!)) && (await pet!.evaluate(`document.querySelector('[role=tab][aria-selected=true]')?.innerText.trim()`)) === "Chat", 5);
  await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  // 8d. Talking to him. The microphone is a recording of Windows' own voice saying SPOKEN (Chromium's fake
  // device), heard by Whisper on this computer; the first time, the model downloads.
  if (VOICE) {
    const draftNow = () => pet!.evaluate(`document.querySelector('textarea[aria-label="Message Perry"]')?.value ?? ""`) as Promise<string>;
    const listening = () => pet!.evaluate(`Boolean(document.querySelector('[aria-label="Listening"]'))`) as Promise<boolean>;
    const clearDraft = async () => {
      await pet!.evaluate(`document.querySelector('textarea[aria-label="Message Perry"]').focus()`);
      await pet!.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
      await pet!.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await pet!.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await pet!.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    };
    await openPanel();
    await clickTab(pet, "Chat");
    await pet.evaluate(`[...document.querySelectorAll('button')].find((b) => b.getAttribute("aria-label") === "New chat")?.click()`);
    // The mic button: what is said goes into the box, to check before sending.
    await pet.evaluate(`document.querySelector('button[aria-label="Talk"]').click()`);
    await check("micListens", listening, 10);
    await sleep(2_000);
    await photograph(pet, "listening.png");
    await sleep(4_500);
    const sentAt = Date.now();
    await clickButton(pet, "Send");
    let sawDownload = false;
    await check("micToText", async () => {
      sawDownload ||= /Getting his ears ready/.test(await text(pet!));
      return /call sam/i.test(await draftNow());
    }, 240);
    notes.micHeard = await draftNow();
    notes.micSeconds = Math.round((Date.now() - sentAt) / 100) / 10;
    notes.modelDownloadShown = sawDownload;
    checks.micDoesNotSend = !(await call<Array<{ prompt: string }>>("dashboard:listRuns", { key: KEY }, "call")).some((run) => /call sam/i.test(run.prompt));
    await clearDraft();

    if (REAL_MOUSE) {
      const runsAbout = async (pattern: RegExp) => (await call<Array<{ prompt: string; status: string }>>("dashboard:listRuns", { key: KEY }, "call")).filter((run) => pattern.test(run.prompt));
      await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await until(async () => !(await panelOpen(pet!)), "the panel to close", 5);
      // The hotkey from anywhere, tapped: he opens listening; tapped again, what was said goes to him at once.
      hotkey("tap");
      await check("hotkeyListens", async () => (await panelOpen(pet!)) && (await listening()), 10);
      await sleep(6_500);
      hotkey("tap");
      await check("hotkeySends", async () => (await runsAbout(/call sam/i)).length === 1, 60);
      notes.hotkeyPrompt = (await runsAbout(/call sam/i))[0]?.prompt;
      await until(async () => (await runsAbout(/call sam/i)).every((run) => run.status !== "running"), "Perry to act on it", 300);
      // Said, and done: the to-do is there, at the time said.
      const tomorrow5 = new Date();
      tomorrow5.setDate(tomorrow5.getDate() + 1);
      tomorrow5.setHours(17, 0, 0, 0);
      await check("hotkeyDoesIt", async () => {
        const sam = (await board()).open.find((todo) => /sam/i.test(todo.title) && todo.by === "assistant");
        return sam?.dueAt === tomorrow5.getTime();
      }, 20);
      notes.hotkeyTodo = (await board()).open.find((todo) => /sam/i.test(todo.title) && todo.by === "assistant");
      await sleep(1_500);
      await photograph(pet, "said-and-done.png");
      // Held while speaking, and let go: sent.
      hotkey("down");
      await check("holdListens", listening, 10);
      await sleep(6_500);
      hotkey("up");
      await check("holdToTalkSends", async () => (await runsAbout(/call sam/i)).length === 2, 60);
      await until(async () => (await runsAbout(/call sam/i)).every((run) => run.status !== "running"), "Perry's second answer", 300);
      // Esc, from anywhere, stops him listening, and nothing is sent.
      hotkey("tap");
      await until(listening, "listening again", 10);
      pressKey(0x1b);
      await check("escCancels", async () => !(await listening()), 5);
      await sleep(3_000);
      checks.escSendsNothing = (await runsAbout(/call sam/i)).length === 2;
    }
    // Put away, so his bubbles show again.
    await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await until(async () => !(await panelOpen(pet!)), "his panel to close", 5);
  }

  // 8c. A computer waiting on you: he asks, with the command, and your yes goes from his bubble.
  const token = (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string }).token;
  await call("approvals:request", { token, kind: "command", title: "git push origin main", cwd: "C:\\work\\site", conversationId: petChatId }, "call");
  await check("approvalBubble", async () => /wants to run a command\s+git push origin main/.test(await text(pet!)), 20);
  checks.approvalBadge = /1 waiting on you/.test(await pet.evaluate(`document.querySelector('button[aria-label^="Perry."]').getAttribute("aria-label")`) as string);
  await photograph(pet, "approval.png");
  await clickButton(pet, "Approve");
  await check("approvedFromPet", async () => (await call<unknown[]>("approvals:pending", { key: KEY }, "call")).length === 0, 10);

  // 9. The phone: quiet while the owner is at the computer with the pet, nagged once away; Done on the card.
  const binsId = await add("Take out the bins", Date.now() - minutes(1));
  await call("todos:presence", { key: KEY, idleSeconds: 0 }, "call");
  let since = Date.now();
  await call("todos:tick");
  await sleep(2_000);
  checks.quietWhileAtComputer = !toOwner(since).some((message) => message.text.includes("Take out the bins"));
  notes.binsWhileAtComputer = (await find(/Take out the bins/))?.dueAt;
  // Away: nothing touched for a quarter of an hour (the pet says so on its own within a minute; here, at once).
  // The pet had it, so it is looked at again in a minute; a new time has it due now.
  await call("todos:edit", { key: KEY, id: binsId, dueAt: Date.now() - minutes(1) }, "call");
  await call("todos:presence", { key: KEY, idleSeconds: 900 }, "call");
  since = Date.now();
  await call("todos:tick");
  await until(() => toOwner(since).some((message) => message.text.includes("Take out the bins")), "the bins reminder on Telegram", 15).catch(() => {});
  const bins = toOwner(since).find((message) => message.text.includes("Take out the bins"));
  notes.binsReminder = bins && { text: bins.text, buttons: bins.buttons };
  checks.nagsWhenAway = Boolean(bins);
  checks.reminderHasButtons = Boolean(bins && bins.buttons.join(" ") === `td:${binsId}:d td:${binsId}:10 td:${binsId}:60 td:${binsId}:t`);
  if (bins) {
    ownerTaps(bins, `td:${binsId}:d`);
    await check("doneOnTelegram", async () => Boolean((await find(/Take out the bins/))?.doneAt));
    await check("cardSettled", () => bins.text === "✅ Take out the bins" && bins.buttons.length === 0);
    checks.tapAnswered = telegram.answered.includes("Done.");
  }
  // 10. Tomorrow keeps the time of day.
  const plantsDue = (await find(/^water the plants$/))!.dueAt!;
  await call("todos:edit", { key: KEY, id: (await find(/^water the plants$/))!.id, dueAt: Date.now() - minutes(3) }, "call");
  const plantsLate = (await find(/^water the plants$/))!.dueAt!;
  since = Date.now();
  await call("todos:presence", { key: KEY, idleSeconds: 900 }, "call");
  await call("todos:tick");
  await until(() => toOwner(since).some((message) => message.text.includes("water the plants")), "the plants reminder", 15).catch(() => {});
  const plants = toOwner(since).find((message) => message.text.includes("water the plants"));
  if (plants) {
    ownerTaps(plants, plants.buttons.find((data) => data.endsWith(":t"))!);
    await check("tomorrowKeepsTime", async () => (await find(/^water the plants$/))!.dueAt === plantsLate + 86_400_000);
    notes.tomorrowCard = plants.text;
  } else checks.tomorrowKeepsTime = false;
  void plantsDue;

  // 11. Answered in words: "done" reaches the to-do the reminder named.
  await call("todos:edit", { key: KEY, id: dentist!.id, dueAt: Date.now() - minutes(1) }, "call");
  since = Date.now();
  await call("todos:presence", { key: KEY, idleSeconds: 900 }, "call");
  await call("todos:tick");
  await until(() => toOwner(since).some((message) => /dentist/i.test(message.text)), "the dentist reminder", 15).catch(() => {});
  const doneAt = Date.now();
  ownerSays("done");
  await until(async () => (await call<Array<{ prompt: string; status: string }>>("dashboard:listRuns", { key: KEY }, "call")).some((run) => run.prompt === "done" && run.status !== "running"), "Perry's reply to done", 300);
  await until(() => toOwner(doneAt).length > 0, "the reply on Telegram", 30).catch(() => {});
  notes.doneReply = toOwner(doneAt).map((message) => message.text).join("\n");
  checks.doneInWords = Boolean((await find(/dentist/i))?.doneAt);

  // 12. End the day: what is late moves to tomorrow, at its own time.
  const lateId = await add("Reply to Ana", Date.now() - minutes(90));
  const lateDue = (await find(/Reply to Ana/))!.dueAt!;
  await call("todos:endDay", { key: KEY, action: "move" }, "call");
  const moved = (await board()).open.find((todo) => todo.id === lateId)!;
  checks.endDayMovesToTomorrow = moved.dueAt === lateDue + 86_400_000 && moved.dueAt! > Date.now();

  // 12b. The dashboard's To-dos page: the same list, and Perry's marked as his.
  const dashboard = await openChat(BASE, KEY);
  try {
    await dashboard.send("Page.navigate", { url: `${BASE}/todos` });
    await check("dashboardPage", async () => {
      const page = await dashboard.evaluate(`document.querySelector("main")?.innerText ?? ""`) as string;
      return page.includes("Reply to Ana") && page.includes("Done today") && /Perry on your desktop[\s\S]*(On your desktop|Turn on)/.test(page);
    }, 30);
    checks.dashboardMarksPerrys = await dashboard.evaluate(`Boolean(document.querySelector('[aria-label="Perry added this"]'))`) || false;
    const shot = await dashboard.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, "todos-page.png"), Buffer.from(shot.data, "base64"));

    // 12c. Keyboard shortcuts, changed in Settings by pressing the keys.
    type ShortcutsView = { shortcuts: Record<string, string>; pet: { running: boolean; hotkey?: string; error?: string } };
    const shortcuts = () => call<ShortcutsView>("dashboard:getShortcuts", { key: KEY }, "call");
    const main = () => dashboard.evaluate(`document.querySelector("main")?.innerText ?? ""`) as Promise<string>;
    const press = async (key: string, code: string, vk: number, modifiers = 0) => {
      await dashboard.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers });
      await dashboard.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
    };
    const recorder = (label: string) => dashboard.evaluate(`document.querySelector('button[aria-label^=${JSON.stringify(`${label}:`)}]')?.click() ?? false`);
    const paletteOpen = () => dashboard.evaluate(`Boolean(document.querySelector('[role=dialog] input[placeholder^="Search chats"]'))`) as Promise<boolean>;
    await dashboard.send("Page.navigate", { url: `${BASE}/settings?tab=shortcuts` });
    await check("shortcutsPage", async () => /Talk to Perry[\s\S]*Search and commands[\s\S]*New chat/.test(await main()), 30);
    await check("petHotkeyShownWorking", async () => (await main()).includes("Working in the desktop pet"), 20);
    const settingsShot = await dashboard.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, "shortcuts.png"), Buffer.from(settingsShot.data, "base64"));
    // A plain letter is refused: it would go off while typing.
    await recorder("Search and commands");
    await press("j", "KeyJ", 74);
    await check("letterRefused", async () => (await main()).includes("so it doesn't go off while you type"), 5);
    // Ctrl+J, pressed, is Search from now on; Ctrl+K no longer is.
    await press("j", "KeyJ", 74, 2);
    await check("shortcutSaved", async () => (await shortcuts()).shortcuts.palette === "CommandOrControl+J", 10);
    await check("sidebarShowsIt", async () => (await dashboard.evaluate(`document.body.innerText`) as string).includes("Ctrl+J"), 10);
    await press("k", "KeyK", 75, 2);
    await sleep(700);
    checks.oldKeysLetGo = !(await paletteOpen());
    await press("j", "KeyJ", 74, 2);
    await check("newKeysWork", paletteOpen, 5);
    await press("Escape", "Escape", 27);
    // Two shortcuts cannot share keys.
    checks.clashRefused = await call("dashboard:setShortcut", { key: KEY, id: "newChat", accelerator: "CommandOrControl+J" }, "call").then(() => false, (error: Error) => /already the shortcut for Search/.test(error.message));
    await call("dashboard:setShortcut", { key: KEY, id: "palette", accelerator: null }, "call");
    checks.resetToDefault = (await shortcuts()).shortcuts.palette === "CommandOrControl+K";

    // Talk to Perry: new keys move the pet's hotkey, and they start him listening.
    await call("dashboard:setShortcut", { key: KEY, id: "talk", accelerator: "CommandOrControl+Alt+Shift+Y" }, "call");
    await check("petTakesNewHotkey", async () => (await shortcuts()).pet.hotkey === "CommandOrControl+Alt+Shift+Y", 15);
    await check("settingsSaysWorking", async () => (await main()).includes("Working in the desktop pet"), 10);
    if (REAL_MOUSE) {
      keyboard("[K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0x59, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [K]::keybd_event(0x59, 0, 2, [UIntPtr]::Zero); [K]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero); [K]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); [K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)");
      await check("newHotkeyListens", () => pet!.evaluate(`Boolean(document.querySelector('[aria-label="Listening"]'))`) as Promise<boolean>, 10);
      pressKey(0x1b);
      await until(async () => !(await pet!.evaluate(`Boolean(document.querySelector('[aria-label="Listening"]'))`)), "him to stop listening", 5);
      await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    }
    // Keys another app holds: he keeps the ones he has, and Settings says why.
    if (process.platform === "win32") {
      const holder = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class H { [DllImport(\"user32.dll\")] public static extern bool RegisterHotKey(IntPtr w, int id, uint mods, uint vk); }'; " +
        "if ([H]::RegisterHotKey([IntPtr]::Zero, 7, 7, 0x78)) { 'held' } else { 'not held' }; Start-Sleep -Seconds 40"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let held = "";
      holder.stdout?.on("data", (chunk: Buffer) => { held += chunk; });
      await until(() => held.includes("held"), "another app to hold Ctrl+Alt+Shift+F9", 15);
      notes.otherAppHolds = held.trim();
      await call("dashboard:setShortcut", { key: KEY, id: "talk", accelerator: "CommandOrControl+Alt+Shift+F9" }, "call");
      await check("takenReported", async () => { const view = await shortcuts(); return view.pet.error === "taken" && view.pet.hotkey === "CommandOrControl+Alt+Shift+Y"; }, 15);
      await check("settingsSaysTaken", async () => /Another app on this computer already uses Ctrl\+Alt\+Shift\+F9\. He's still on Ctrl\+Alt\+Shift\+Y/.test(await main()), 10);
      const takenShot = await dashboard.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, "shortcut-taken.png"), Buffer.from(takenShot.data, "base64"));
      stop(holder);
    }
    await call("dashboard:setShortcut", { key: KEY, id: "talk", accelerator: null }, "call");
    await check("backToDefaultHotkey", async () => (await shortcuts()).pet.hotkey === "CommandOrControl+Shift+Space", 15);
    checks.noDashboardErrors = dashboard.errors.length === 0;
  } finally {
    dashboard.close();
  }

  // 13. Real clicks, through him and on him.
  if (REAL_MOUSE) {
    const window = await pet.evaluate("({ x: window.screenX, y: window.screenY, w: innerWidth, h: innerHeight, scale: devicePixelRatio })") as { x: number; y: number; w: number; h: number; scale: number };
    const px = (n: number) => Math.round(n * window.scale);
    const log = join(outDir, "..", `pet-clicks-${PORT}.txt`);
    catcherWindow = catcher({ x: px(window.x), y: px(window.y), w: px(window.w), h: px(window.h) }, log);
    await until(() => existsSync(log) && readFileSync(log, "utf8").includes("shown"), "the test window", 15);
    realClick(px(window.x + 30), px(window.y + 40));
    await sleep(800);
    checks.clickPassesThrough = readFileSync(log, "utf8").includes("click");
    const body = await petBox(pet);
    const clicks = readFileSync(log, "utf8").split("click").length;
    realClick(px(window.x + body.x), px(window.y + body.y));
    await check("realClickOpensList", () => panelOpen(pet!), 5);
    checks.clickOnHimStays = readFileSync(log, "utf8").split("click").length === clicks;
    stop(catcherWindow);
    rmSync(log, { force: true });
  } else {
    notes.realMouse = "skipped: set PERRY_E2E_DESKTOP=1 on Windows to use the real mouse";
  }

  // 14b. Off duty, as in the show: with nothing going on he naps with his hat off; touched, it goes back on.
  {
    const napping = async () => (await pet!.evaluate(`document.querySelector('button[aria-label^="Perry."]').dataset.state`)) === "asleep";
    await pet.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await check("napsWhenNothingHappens", napping, 45);
    const at = await petBox(pet);
    await dispatch(pet, "mousePressed", at.x, at.y);
    await dispatch(pet, "mouseMoved", at.x + 5, at.y);
    await dispatch(pet, "mouseReleased", at.x + 5, at.y);
    await check("wakesWhenTouched", async () => !(await napping()), 2);
    await sleep(3_000);
    checks.staysAwakeAfterwards = !(await napping());
  }

  // 15. No errors in his page.
  checks.noPageErrors = pet.errors.length === 0;
  notes.pageErrors = pet.errors;

  // 14. Off: gone, and not at login.
  pet.close();
  pet = null;
  notes.perryPetOff = perry("pet", "off").trim();
  await check("petQuits", async () => !(await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`).then(() => true, () => false)), 15);
  if (process.platform === "win32") {
    checks.notAtLogin = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", LOGIN_ENTRY], { encoding: "utf8" }).status !== 0;
  }
  notes.board = await board();
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
} finally {
  pet?.close();
  stop(catcherWindow);
  // Never leave him running or starting at login on this machine.
  if (Object.keys(checks).length && !("petQuits" in checks)) perry("pet", "off");
  stop(runner);
  stop(server);
  stub.close();
  const result = { ranAt: new Date().toISOString(), realMouse: REAL_MOUSE, voice: VOICE, checks, notes, telegram: telegram.sent.map(({ text, buttons }) => ({ text, buttons })), logTail: logs.server.split("\n").slice(-20) };
  // Windows can hold the file a moment (an editor, a scanner); a few tries, so a run is not lost at its last step.
  for (let attempt = 1; ; attempt++) {
    try { writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2)); break; }
    catch (error) { if (attempt === 5) throw error; await sleep(1_000); }
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  console.log(failed.length ? `FAILED: ${failed.join(", ")}` : `all ${Object.keys(checks).length} checks passed`);
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  rmSync(SPOKEN_WAV, { force: true });
  process.exit(failed.length ? 1 : 0);
}
