import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/pet-on-screen/run.ts <outDir>
// The desktop pet's bubbles and panel near the edges of the screen, and a
// reply's bubble going by itself. A fresh Perry (production build, `pnpm build`
// first; its own PERRY_HOME and port), the real pet window (Electron, started
// directly, so no login entry), and a runner played by its calls, so replies
// land when the test says. No Codex. He is moved as a drag moves him
// (perryPet.moveTo, and a drag of CDP mouse events on his page), never to the
// bottom-right corner, where the owner's own pet stands; his page is
// photographed over DevTools, never the screen. No real mouse or keys.
//
// Ways it could fail:
//   1. Near the top of the screen, his bubble or panel is still drawn above
//      him, off the screen: at the very top, both must be wholly on the
//      screen, and below him.
//   2. Near the left edge, the bubble hangs off it: wholly on screen, reaching
//      over to his right, its point still over him.
//   3. The panel near an edge is off screen, or squeezed to nothing: wholly
//      on screen, and at least 400 points tall.
//   4. He is moved to make room: his body must stay where he was put, to the
//      point, at every spot.
//   5. Away from the edges, something changed: in the middle of the screen
//      his window is where it always was, and the bubble above him.
//   6. His window hangs off the screen: at every spot, all of it on screen.
//   7. A drag goes wrong once his window no longer starts at his spot: dragged
//      by the mouse from the top-left corner, he must land where the pointer
//      took him; dragged over the circle that hides him, it must say so (he
//      shrinks), from a spot where his window is shifted.
//   8. A finished reply's bubble stays forever: a short one must go by
//      itself within its time (8 s and 60 ms a letter), and not long before.
//   9. A long reply goes as soon as a short one: it must still be up after the
//      short one's time.
//  10. The pointer on it does not hold it: held for twice its time, still up;
//      let go, gone within what was left of its time.
//  11. What waits on the owner times out too: a computer's request and a late
//      to-do must stay up for longer than any reply's time.
//  12. The page throws.
//  13. The check itself is thrown by the owner using the computer: the real
//      mouse must never reach this pet's page (each pointer event it gets is
//      kept, and none may be at a point this script did not send).

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-on-screen/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pet-on-screen-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-pet-on-screen-"));
// Hotkeys no one else would have, so this pet never takes the owner's; and a first spot away from the bottom-right corner.
const TALK = "CommandOrControl+Alt+Shift+F11";
const LOOK = "CommandOrControl+Alt+Shift+F12";
// Ghost ("Let clicks through him"): his window takes nothing from the real mouse, only this script's DevTools events. Otherwise
// the owner's pointer, or his window moving under it, reaches the page, ends a hover and lets go of a drag mid-check.
writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 200, y: 120, hotkey: TALK, ghost: true }));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => {
  checks[name] = ok;
  if (note !== undefined) notes[name] = note;
  if (!ok) console.log(`FAILED: ${name} ${note === undefined ? "" : JSON.stringify(note)}`);
};

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS), PERRY_PET_HOTKEY: TALK,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const logs = { server: "", pet: "" };
const server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { logs.server += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { logs.server += chunk; });
let pet: ChildProcess | null = null;
const stop = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 5; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}

/** His page, over DevTools: what it shows, pictures of it, and mouse events that never reach the real pointer. */
async function petTab() {
  const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const target = list.find((item) => item.url.startsWith(`${BASE}/pet`));
  if (!target) throw new Error("his page is not open");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let id = 0;
  const waiting = new Map<number, (message: any) => void>();
  const errors: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((done, fail) => {
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

type Box = { left: number; top: number; right: number; bottom: number };
type Look = {
  screen: Box; window: Box; body: Box;
  bubble: Box | null; point: Box | null; panel: Box | null;
  words: string[];
};
/** Where things are, in screen points: the screen's usable part, his window, his body (untransformed), the bubble and its point, the panel. */
const LOOK_NOW = `(() => {
  const wx = window.screenX, wy = window.screenY;
  const at = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: wx + b.left, top: wy + b.top, right: wx + b.right, bottom: wy + b.bottom }; };
  const bubble = document.querySelector('main [role="status"]');
  return {
    screen: { left: screen.availLeft, top: screen.availTop, right: screen.availLeft + screen.availWidth, bottom: screen.availTop + screen.availHeight },
    window: { left: wx, top: wy, right: wx + innerWidth, bottom: wy + innerHeight },
    body: at(document.querySelector('button[aria-label^="Perry."]')?.closest('main > div')),
    bubble: at(bubble),
    point: at(bubble?.querySelector('span[aria-hidden]')),
    panel: at(document.querySelector('section[aria-label="Perry"]')),
    words: bubble ? [...bubble.querySelectorAll("p")].map((p) => p.textContent.trim()) : [],
  };
})()`;
const inside = (box: Box | null, area: Box, slack = 0.5) => Boolean(box) && box!.left >= area.left - slack && box!.top >= area.top - slack && box!.right <= area.right + slack && box!.bottom <= area.bottom + slack;
const near = (a: number, b: number, by = 1) => Math.abs(a - b) <= by;

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
let tab: Awaited<ReturnType<typeof petTab>> | null = null;
const maps: Array<{ name: string; look: Look; image: string }> = [];
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  const runnerJson = join(home, "runner.json");
  await until(() => existsSync(runnerJson), "the server to connect this computer", 30);
  const token = (JSON.parse(readFileSync(runnerJson, "utf8")) as { token: string }).token;
  const online = async () => {
    await call("runner:checkIn", { token, platform: "win32", hostname: "E2E", workdir: home });
    await call("codex:reportAccount", { token, available: true, authMode: "chatgpt", planType: "plus" });
  };
  await online();
  const heartbeat = setInterval(() => void online().catch(() => {}), 20_000);
  for (const [id, accelerator] of [["talk", TALK], ["look", LOOK]]) await call("dashboard:setShortcut", { key: KEY, id, accelerator }).catch((error) => { notes[`shortcut-${id}`] = String(error); });
  const own = await call<string>("dashboard:createChat", { key: KEY });

  // The pet, as `perry pet` starts it, but straight from Electron: no login entry.
  const electron = spawnSync("node", ["-e", "process.stdout.write('\\n' + require('electron'))"], { cwd: join(REPO, "pet"), encoding: "utf8" }).stdout.trim().split(/\r?\n/).pop()!;
  pet = spawn(electron, [join(REPO, "pet")], { cwd: join(REPO, "pet"), env, stdio: ["ignore", "pipe", "pipe"] });
  pet.stdout?.on("data", (chunk: Buffer) => { logs.pet += chunk; });
  pet.stderr?.on("data", (chunk: Buffer) => { logs.pet += chunk; });
  await until(() => fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`).then((r) => r.json() as Promise<Array<{ url: string }>>).then((list) => list.some((item) => item.url.startsWith(`${BASE}/pet`)), () => false), "his page", 60);
  tab = await petTab();
  // A first load before the server was ready is retried by the window (pet/main.js): wait for him.
  await until(() => tab!.evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`), "him on his page", 60);
  await tab.evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(own)}); true`);
  // His page loaded again goes into a new window (pet/main.js, issue #191): his page from there.
  await tab.send("Page.reload").catch(() => {});
  await sleep(4_000);
  tab.close();
  await until(async () => (await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json() as Array<{ url: string }>).filter((item) => item.url.startsWith(`${BASE}/pet`)).length === 1, "one page of his", 30);
  tab = await petTab();
  await until(() => tab!.evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`), "him on his page", 30);
  await sleep(2_000);
  const t = tab;
  const look = () => t.evaluate(LOOK_NOW) as Promise<Look>;
  const shot = async (name: string) => {
    const image = (await t.send("Page.captureScreenshot", { format: "png" })).data as string;
    writeFileSync(join(outDir, name), Buffer.from(image, "base64"));
    return image;
  };
  const spot = () => JSON.parse(readFileSync(join(home, "pet.json"), "utf8")) as { x: number; y: number };
  const moveTo = async (x: number, y: number) => { await t.evaluate(`window.perryPet.moveTo(${x}, ${y}); true`); await sleep(900); };
  // Every pointer event his page gets, where on the screen: any at a point this script never sent is the real mouse.
  await t.evaluate(`window.__pointer = []; for (const type of ["pointermove", "pointerdown", "pointerup", "pointerleave", "pointercancel", "lostpointercapture"]) window.addEventListener(type, (e) => { if (window.__pointer.length < 5000) window.__pointer.push([type, e.screenX, e.screenY, e.buttons, Date.now()]); }, true); true`);
  const sent: Array<[number, number]> = [];
  const stray = async () => {
    const got = await t.evaluate(`window.__pointer`) as Array<[string, number, number, number, number]>;
    return got.filter(([, x, y]) => !sent.some(([sx, sy]) => Math.abs(sx - x) <= 1 && Math.abs(sy - y) <= 1));
  };
  /** Mouse events on his page, at screen points; captured by him once pressed, as a real drag is. */
  const mouse = async (type: string, x: number, y: number, pressed = false) => {
    const [wx, wy] = await t.evaluate(`[window.screenX, window.screenY]`) as [number, number];
    sent.push([Math.round(x), Math.round(y)]);
    await t.send("Input.dispatchMouseEvent", { type, x: x - wx, y: y - wy, button: type === "mouseMoved" && !pressed ? "none" : "left", buttons: pressed || type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
  };
  const bodyMiddle = async () => { const { body } = await look(); return { x: (body.left + body.right) / 2, y: (body.top + body.bottom) / 2 }; };
  const clickHim = async () => { const at = await bodyMiddle(); await mouse("mouseMoved", at.x, at.y); await mouse("mousePressed", at.x, at.y); await mouse("mouseReleased", at.x, at.y); };
  const pointerAway = async () => { const { window: w } = await look(); await mouse("mouseMoved", w.left + 2, w.top + 2); };
  const first = await look();
  const screen = first.screen;
  notes.screen = screen;
  // His body, from his spot: the window's corner with him in it, 16 in from its right and 12 up from its bottom.
  const bodyAt = (x: number, y: number) => ({ right: x + 404 - 16, bottom: y + 620 - 12 });

  // --- 8–10. A reply goes by itself; longer for a longer one; not while the pointer is on it -----------------
  const ask = async (text: string) => {
    await call("dashboard:sendChat", { key: KEY, id: own, text });
    let turn: { _id: string } | undefined;
    await until(async () => { turn = (await call<Array<{ _id: string; conversationId: string }>>("codex:queuedTurns", { token })).find((item) => item.conversationId === own); return Boolean(turn); }, "the turn to queue", 30);
    await call("codex:claimTurn", { token, id: turn!._id });
    await sleep(2_500);
    return (response: string) => call("codex:finishTurn", { token, id: turn!._id, response });
  };
  const replyUp = async () => (await look()).words[0] === "Perry";
  /** A reply comes; from when its bubble shows, how long it stays (holding the pointer on it for `hold` ms first). */
  const replyLasts = async (response: string, hold = 0) => {
    const finish = await ask(`Tell me ${response.length} letters`);
    await finish(response);
    await until(replyUp, "the reply's bubble", 20);
    const shownAt = Date.now();
    await sleep(900);
    if (hold) {
      const { bubble } = await look();
      await mouse("mouseMoved", (bubble!.left + bubble!.right) / 2, (bubble!.top + bubble!.bottom) / 2);
      const holdFrom = Date.now();
      let goneAt: number | null = null;
      while (Date.now() - holdFrom < hold) {
        if (goneAt === null && !(await replyUp())) goneAt = Date.now();
        await sleep(500);
      }
      notes.holdWindow = { from: holdFrom, to: Date.now(), goneAt };
      const heldUp = await replyUp();
      await pointerAway();
      const letGo = Date.now();
      await until(async () => !(await replyUp()), "the reply to go", 60).catch(() => {});
      return { heldUp, lasted: Date.now() - shownAt, afterLetGo: Date.now() - letGo };
    }
    await until(async () => !(await replyUp()), "the reply to go", 60).catch(() => {});
    return { heldUp: true, lasted: Date.now() - shownAt, afterLetGo: 0 };
  };
  await moveTo(screen.left + (screen.right - screen.left) / 2 - 300, screen.top + (screen.bottom - screen.top) / 2 - 360);
  const short = "Sure, done.";
  const shortMs = 8_000 + short.length * 60;
  const shortRun = await replyLasts(short);
  check("shortReplyGoesByItself", shortRun.lasted <= shortMs + 2_500, { ...shortRun, due: shortMs });
  check("shortReplyNotTooSoon", shortRun.lasted >= shortMs - 1_500, { ...shortRun, due: shortMs });
  const long = "Here is the long answer you asked for, with the three things to check before Friday: the lease renewal, the car's service booking, and the note to the landlord about the heater, which is still making that noise at night.";
  const longMs = 8_000 + 141 * 60;
  const longRun = await replyLasts(long);
  check("longReplyStaysLonger", longRun.lasted > shortMs + 3_000 && longRun.lasted <= longMs + 2_500, { ...longRun, due: longMs });
  const heldRun = await replyLasts(long, 2 * longMs);
  check("pointerHoldsReply", heldRun.heldUp && heldRun.lasted > 2 * longMs, heldRun);
  check("letGoReplyGoes", heldRun.afterLetGo <= longMs + 2_500 && heldRun.afterLetGo >= longMs - 4_000, { ...heldRun, due: longMs });

  // --- 1–6. His bubble and panel at spots around the screen -------------------------------------------------
  const approval = await call<{ id: string; next: string }>("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\build-cache; pnpm install --frozen-lockfile", cwd: home, conversationId: own });
  notes.approval = approval;
  await until(async () => /wants to/.test((await look()).words[0] ?? ""), "the request's bubble", 20);
  const width = screen.right - screen.left;
  const height = screen.bottom - screen.top;
  // right: the bubble reaches over to his right (true), stays to his left as usual (false), or either, as its width decides.
  const spots: Array<{ name: string; x: number; y: number; below: boolean; right?: boolean }> = [
    { name: "middle", x: screen.left + width / 2 - 300, y: screen.top + height / 2 - 360, below: false, right: false },
    { name: "top-left", x: screen.left - 254, y: screen.top - 450, below: true, right: true },
    { name: "top-right", x: screen.right - 404, y: screen.top - 450, below: true, right: false },
    { name: "near-top", x: screen.left + width / 2 - 200, y: screen.top - 300, below: true, right: false },
    { name: "left", x: screen.left - 254, y: screen.top + height / 2 - 360, below: false, right: true },
    { name: "left-a-little", x: screen.left - 130, y: screen.top + height / 2 - 360, below: false },
    { name: "bottom-left", x: screen.left - 254, y: screen.bottom - 620, below: false, right: true },
  ];
  const at: Record<string, unknown> = {};
  for (const where of spots) {
    const x = Math.round(where.x);
    const y = Math.round(where.y);
    await moveTo(x, y);
    const withBubble = await look();
    const image = await shot(`${where.name}-bubble.png`);
    maps.push({ name: `${where.name}: a request`, look: withBubble, image });
    await clickHim();
    await until(async () => Boolean((await look()).panel), "his panel", 5).catch(() => {});
    await sleep(900);
    const withPanel = await look();
    const panelImage = await shot(`${where.name}-panel.png`);
    maps.push({ name: `${where.name}: his panel`, look: withPanel, image: panelImage });
    await clickHim();
    await until(async () => !(await look()).panel, "his panel to shut", 5).catch(() => {});
    await pointerAway();
    await sleep(600);
    const want = bodyAt(x, y);
    const { body, bubble, point, window: frame } = withBubble;
    const { panel } = withPanel;
    const pointX = point ? (point.left + point.right) / 2 : NaN;
    const result = {
      spot: spot(), asked: { x, y },
      heStays: near(body.right, want.right) && near(body.bottom, want.bottom) && near(withPanel.body.right, want.right) && near(withPanel.body.bottom, want.bottom),
      windowOnScreen: inside(frame, screen),
      bubbleOnScreen: inside(bubble, screen) && inside(point, screen),
      bubbleSide: bubble ? (where.below ? bubble.top >= body.bottom : bubble.bottom <= body.top) : false,
      bubbleReach: where.right === undefined ? undefined : bubble ? (where.right ? bubble.right > body.right : bubble.right <= body.right) : false,
      pointOverHim: pointX >= body.left && pointX <= body.right,
      panelOnScreen: inside(panel, screen),
      panelSide: panel ? (where.below ? panel.top >= withPanel.body.bottom : panel.bottom <= withPanel.body.top) : false,
      panelTall: panel ? panel.bottom - panel.top >= 400 : false,
      windowAtSpot: where.name === "middle" ? frame.left === x && frame.top === y : undefined,
      boxes: { body, bubble, point, panel: withPanel.panel, window: frame },
    };
    at[where.name] = result;
    for (const [name, ok] of Object.entries(result)) if (typeof ok === "boolean") check(`${where.name}:${name}`, ok, ok ? undefined : result.boxes);
  }
  notes.spots = at;

  // --- 7. Dragged by the mouse, from a spot where his window is shifted -----------------------------------------
  await moveTo(screen.left - 254, screen.top - 450);
  const from = spot();
  const grab = await bodyMiddle();
  await mouse("mouseMoved", grab.x, grab.y);
  await mouse("mousePressed", grab.x, grab.y);
  await mouse("mouseMoved", grab.x + 300, grab.y + 240, true);
  await sleep(300);
  await mouse("mouseReleased", grab.x + 300, grab.y + 240);
  await sleep(900);
  const dropped = spot();
  const afterDrag = await look();
  const wanted = bodyAt(from.x + 300, from.y + 240);
  check("dragLandsUnderPointer", dropped.x === from.x + 300 && dropped.y === from.y + 240 && near(afterDrag.body.right, wanted.right) && near(afterDrag.body.bottom, wanted.bottom), { from, dropped, body: afterDrag.body, wanted });
  // Over the circle at the bottom middle of the screen: he shrinks into it, as it arms. Then away, and let go: he stays.
  await moveTo(screen.left - 254, screen.top - 450);
  const start = await bodyMiddle();
  const circle = { x: Math.round(screen.left + (width - 220) / 2) + 110, y: screen.bottom - 220 - 8 + 110 };
  await mouse("mouseMoved", start.x, start.y);
  const dragFrom = Date.now();
  await mouse("mousePressed", start.x, start.y);
  await mouse("mouseMoved", start.x + 10, start.y + 10, true);
  await sleep(200);
  await mouse("mouseMoved", circle.x, circle.y, true);
  await sleep(900);
  const shrunk = await t.evaluate(`getComputedStyle(document.querySelector('button[aria-label^="Perry."]').parentElement).transform`) as string;
  await shot("over-the-circle.png");
  await mouse("mouseMoved", circle.x - 400, circle.y - 300, true);
  await sleep(700);
  const grown = await t.evaluate(`getComputedStyle(document.querySelector('button[aria-label^="Perry."]').parentElement).transform`) as string;
  await mouse("mouseReleased", circle.x - 400, circle.y - 300);
  notes.dragWindow = [dragFrom, Date.now()];
  await sleep(900);
  const scaleOf = (transform: string) => transform.startsWith("matrix(") ? Number(transform.slice(7).split(",")[0]) : 1;
  check("overTheCircleArms", near(scaleOf(shrunk), 0.5, 0.05) && near(scaleOf(grown), 1, 0.05), { shrunk, grown });
  check("stillShownAfterDrag", await t.evaluate(`document.visibilityState === "visible"`) as boolean);

  // --- 11. What waits on the owner does not go -------------------------------------------------------------------
  await moveTo(screen.left + width / 2 - 300, screen.top + height / 2 - 360);
  await sleep(longMs + 6_000);
  check("requestStaysUp", /wants to/.test((await look()).words[0] ?? ""), (await look()).words);
  await call("approvals:decide", { key: KEY, id: approval.id, approved: false });
  await call("todos:add", { key: KEY, title: "Call the landlord", dueAt: Date.now() - 2 * 60_000 });
  await until(async () => (await look()).words[0] === "Call the landlord", "the late to-do's bubble", 20);
  await sleep(longMs + 6_000);
  const late = await look();
  check("lateTodoStaysUp", late.words[0] === "Call the landlord" && /late/.test(late.words[1] ?? ""), late.words);
  await shot("late-stays.png");

  check("pageDidNotThrow", t.errors.length === 0, t.errors.slice(0, 5));
  const strays = await stray();
  check("realPointerKeptOut", strays.length === 0, { events: strays.length, first: strays.slice(0, 20) });
  clearInterval(heartbeat);

  // A map of the screen for each spot, with his window drawn where it was, for a person to look over.
  browser = await openChat(BASE, KEY);
  const scale = Math.min(0.3, 520 / width);
  const cards = maps.map(({ name, look: seen, image }) => {
    const left = (seen.window.left - screen.left) * scale;
    const top = (seen.window.top - screen.top) * scale;
    return `<figure><div class="screen" style="width:${width * scale}px;height:${height * scale}px"><img src="data:image/png;base64,${image}" style="left:${left}px;top:${top}px;width:${404 * scale}px;height:${620 * scale}px"><div class="frame" style="left:${left}px;top:${top}px;width:${404 * scale}px;height:${620 * scale}px"></div></div><figcaption>${name}</figcaption></figure>`;
  }).join("");
  const page = `<!doctype html><html><body style="margin:0;padding:16px;font:13px system-ui;background:#f4f4f5"><style>figure{display:inline-block;margin:0 16px 16px 0;vertical-align:top}.screen{position:relative;background:#3b4252;overflow:hidden;border-radius:4px}.screen img,.frame{position:absolute}.frame{outline:1px dashed #fbbf24}figcaption{margin-top:4px}</style><h3 style="margin:0 0 10px">Perry at each spot on a ${width} x ${height} screen (dashed: his window)</h3>${cards}</body></html>`;
  await browser.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(page).toString("base64")}` });
  await sleep(1_500);
  const size = await browser.evaluate(`[document.documentElement.scrollWidth, document.documentElement.scrollHeight]`) as [number, number];
  await browser.send("Emulation.setDeviceMetricsOverride", { width: Math.max(1280, size[0]), height: size[1], deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  writeFileSync(join(outDir, "on-screen.png"), Buffer.from((await browser.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
  console.log(notes.error);
} finally {
  tab?.close();
  browser?.close();
  stop(pet);
  stop(server);
  await sleep(1_500);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
const passed = failed.length === 0 && Object.keys(checks).length > 0;
const result = { ranAt: new Date().toISOString(), passed, checks, notes, serverErrors: logs.server.split("\n").filter((line) => /error/i.test(line)).slice(-20), petLog: logs.pet.split("\n").slice(-20) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(passed ? `all ${Object.keys(checks).length} checks passed` : `FAILED: ${failed.join(", ")}`);
process.exit(passed ? 0 : 1);
