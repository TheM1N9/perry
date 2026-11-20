import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChat, sleep } from "../browser";

// pnpm build, then: bun artifacts/riff-v2/run.ts [outDir]   (round 3: artifacts/riff-v2/round3)
//   --before <repo>   capture only the old Riff from another built checkout, for before-after-desktop.png
// Riff v2: a production build on a free port with a fresh PERRY_HOME in a temp folder, a stand-in computer that
// answers the editing chat's turns through the runner's own endpoints, the browser's speech recognition replaced by
// a stand-in the check speaks through, and headless Chrome at 1440, 1280 and 390 px. Nothing touches an installed
// Perry. Deleted at the end, except result.json and the screenshots.
//
// Ways it could fail, written down before the checks:
//   1. Words being said do not show in the page, or show only after Perry has written them.
//   2. Words sent to Perry vanish before he has written them, or stay as ghost text after he has.
//   3. Android's zero-confidence "finals" each count, so a growing phrase lands two or three times; or a browser
//      that reports zero for real finals loses its words.
//   4. A typed instruction rewrites the document before the owner accepts it; Reject leaves anything changed.
//   5. Accept writes something other than the edit, or loses dictation that arrived while it waited.
//   6. An edit made on words the owner has since changed is applied anyway.
//   7. An accepted edit cannot be undone; History misses a change, or restoring one does not put it back.
//   8. The style picker misses a skill from the skills folder, or the style never reaches Perry; Thread's
//      post limit is not shown.
//   9. Save to Brain, or a hand-off, does nothing visible or loses the document.
//  10. The hotkey does not start and stop listening; Esc does not stop it.
//  11. On a 390 px phone the page overflows sideways, the dock leaves the screen, or a control is under 44 px.
//  12. At 1280 or 1440 px the title, body, meters and dock do not share one left edge.
//  13. Anything throws in the browser.
// Round 2:
//  14. The model picked in the dock is not the one the document's next run uses, or is lost on reload; a new
//      document does not start on the owner's default model.
//  15. Ghost text is too pale to read (heard words under 3:1, sent words under 4.5:1) or looks like settled text.
//  16. On a phone the dock covers the line being typed or the document's last line, with or without the keyboard.
//  17. The style picker offers skills that are not writing styles.
// Round 3:
//  18. The model picker opens a menu on top of a menu, or misses the thinking level.
//  19. The model chip is cut off on a 390 px phone.
//  20. While listening, the dock shows more than one status or more than one way to stop.
//  21. Riff is not in the sidebar Board v5 left (New chat, Board, To-dos, Riff, Meetings, Library).

const REPO = resolve(import.meta.dirname, "../..");
const BEFORE = process.argv.includes("--before") ? resolve(process.argv[process.argv.indexOf("--before") + 1]) : null;
const OUT = resolve(process.argv.slice(2).find((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--before") ?? join(REPO, "artifacts", "riff-v2"));
const APP = BEFORE ?? REPO;
mkdirSync(OUT, { recursive: true });
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "riff-v2-e2e-key";
const PC = "riff-e2e-pc-token";
const home = mkdtempSync(join(tmpdir(), "perry-riff-e2e-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail?: unknown) {
  checks[name] = ok;
  if (!ok && detail !== undefined) notes[name] = detail;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}

// Skills in the temporary skills folder: two that read as styles, one that does not.
const skill = (folder: string, text: string) => { mkdirSync(join(home, "skills", folder), { recursive: true }); writeFileSync(join(home, "skills", folder, "SKILL.md"), text); };
skill("newsletter", "---\nname: newsletter\ndescription: A weekly letter to readers. Warm, specific, one idea per section.\nriff: true\n---\nWrite as a weekly newsletter.\n");
skill("launch-post", "---\nname: launch-post\ndescription: A launch post for X. Short posts, a hook first.\nriff: true\nriff-post-limit: 280\n---\nWrite a launch thread.\n");
skill("weekly-review", "---\nname: weekly-review\ndescription: Review the week from the journal and to-dos.\n---\nRead the journal.\n");

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex", PERRY_WAKE_DISABLED: "1" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("NEXT_PUBLIC_CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
let log = "";
let server: ChildProcess | null = null;
const startServer = () => {
  server = spawn("node", [join(APP, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout?.on("data", (chunk: Buffer) => { log = (log + chunk).slice(-20_000); });
  server.stderr?.on("data", (chunk: Buffer) => { log = (log + chunk).slice(-20_000); });
};
const stopServer = async () => {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill("SIGKILL");
  }
  server = null;
  await sleep(800);
};

async function call<T>(path: string, args: object = {}, admin = true): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${admin ? "admin" : "call"}`, {
    method: "POST", headers: { "content-type": "application/json", ...(admin ? { "x-perry-key": KEY } : {}) }, body: JSON.stringify({ path, args }),
  });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
const pub = <T>(path: string, args: object = {}) => call<T>(path, { key: KEY, ...args }, false);
const runner = <T>(path: string, args: object = {}) => call<T>(path, args, false);
async function until<T>(test: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string, seconds = 30): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch (error) { last = error; }
    await sleep(150);
  }
  throw new Error(`timed out: ${what}${last ? ` (${String(last)})` : ""}`);
}

// --- The stand-in computer ---------------------------------------------------------------------
type Turn = { _id: string; conversationId: string; prompt: string };
const running = new Set<string>();
const checkIn = () => runner("runner:checkIn", { token: PC, platform: "win32", hostname: "PC", activeTurnIds: [...running] });
let beating: ReturnType<typeof setInterval> | undefined;
const handled = new Set<string>();
async function nextTurn(want: (turn: Turn) => boolean, what: string, seconds = 60): Promise<Turn> {
  return until(async () => {
    const queued = await runner<Turn[]>("codex:queuedTurns", { token: PC });
    for (const turn of queued) {
      if (handled.has(turn._id)) continue;
      if (want(turn)) { handled.add(turn._id); return turn; }
    }
    // Turns the check did not ask for (a chat's name) are answered quietly, as an idle engine would.
    for (const turn of queued) {
      if (handled.has(turn._id) || turn.prompt.includes("Riff document editing session")) continue;
      handled.add(turn._id);
      if (await claim(turn)) await finish(turn, "NOTHING");
    }
    return undefined;
  }, what, seconds);
}
async function claim(turn: Turn) {
  const claimed = await runner<object | null>("codex:claimTurn", { token: PC, id: turn._id });
  if (claimed) running.add(turn._id);
  return claimed;
}
async function finish(turn: Turn, response = "Done.") {
  await runner("codex:finishTurn", { token: PC, id: turn._id, model: "gpt-5.5", response });
  running.delete(turn._id);
}
type NoteView = { id: string; title: string; content: string; revision: number; liveChatId?: string; riffStyle?: string; riffProposal?: { content: string; at: number; instruction?: string } };
const getNote = (id: string) => pub<NoteView>("notes:get", { id });
const write = (chat: string, id: string, mode: "append" | "replace_all", content: string, extra: object = {}) =>
  call<{ error?: string; note?: string }>("notes:updateForAgent", { chat, id, mode, content, ...extra });
const liveTurn = (chat: string, says: string) => nextTurn((turn) => turn.conversationId === chat && turn.prompt.includes(says), `Perry's turn for "${says}"`);

// --- The browser's speech service, replaced by one the check speaks through ---------------------
const SPEECH = `(() => {
  const state = window.__speech = { current: null, results: [], started: 0 };
  class Recognition {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = "en"; this.onstart = this.onend = this.onerror = this.onresult = null; }
    start() { state.current = this; state.results = []; state.started++; setTimeout(() => this.onstart && this.onstart(), 30); }
    stop() { setTimeout(() => { if (state.current === this) state.current = null; this.onend && this.onend(); }, 30); }
    abort() { if (state.current === this) state.current = null; }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = Recognition;
  // The on-screen keyboard, as browsers that resize only the visual viewport report it.
  const real = window.visualViewport;
  if (real) {
    const fake = new EventTarget();
    let keyboard = 0;
    for (const name of ["width", "offsetLeft", "offsetTop", "pageLeft", "pageTop", "scale"]) Object.defineProperty(fake, name, { get: () => real[name] });
    Object.defineProperty(fake, "height", { get: () => real.height - keyboard });
    real.addEventListener("resize", () => fake.dispatchEvent(new Event("resize")));
    real.addEventListener("scroll", () => fake.dispatchEvent(new Event("scroll")));
    Object.defineProperty(window, "visualViewport", { get: () => fake });
    state.keyboard = (height) => { keyboard = height; fake.dispatchEvent(new Event("resize")); return true; };
  }
  // say(text, final, confidence, fresh): replace the last result while it is not final, else add one (fresh adds one anyway).
  state.say = (text, final, confidence = 0.9, fresh = false) => {
    const r = state.current; if (!r) return false;
    const last = state.results[state.results.length - 1];
    const index = last && !last.isFinal && !fresh ? state.results.length - 1 : state.results.length;
    const result = Object.assign([{ transcript: text, confidence }], { isFinal: final });
    state.results[index] = result;
    r.onresult && r.onresult({ resultIndex: index, results: state.results });
    return true;
  };
})();`;

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  startServer();
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("installation:setOnboarding", { state: "done" });
  await call("installation:setDefaultEngine", { engine: "codex" });
  await call("runner:createToken", { name: "PC", token: PC });
  await runner("engines:report", { token: PC, engines: [
    { kind: "codex", installed: true, signedIn: true, auth: { type: "chatgpt", plan: "pro" }, models: [
      { id: "gpt-5.5", name: "GPT-5.5", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "gpt-5.5-mini", name: "GPT-5.5 mini", isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "low" },
    ] },
    ...(BEFORE ? [] : [{ kind: "claude", installed: true, signedIn: true, auth: { type: "subscription", plan: "max" }, models: [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "high" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ] }]),
  ] });
  await checkIn();
  beating = setInterval(() => void checkIn().catch(() => {}), 10_000);

  // --- Fixtures: documents of today, this week and earlier --------------------------------------
  const seed = async (title: string, content: string, style?: string) => {
    const id = await pub<string>("notes:createLive");
    const note = await getNote(id);
    await pub("notes:save", { id, title, content, expectedRevision: note.revision });
    if (style && !BEFORE) await pub("riff:setStyle", { id, style });
    return id;
  };
  const DAY = 86_400_000;
  const older = [
    { id: await seed("Packing list for Lisbon", "- Passport and the orange charger\n- Two shirts, one jacket\n- Book for the flight\n"), ago: 12 * DAY },
    { id: await seed("Call with Asha about the pet", "She wants the pet to stay quiet during calls, and to show the next meeting without being asked.\n"), ago: 9 * DAY },
    { id: await seed("Weekly review, 16 Nov", "Shipped the Board. Brain search is faster. The Riff list still feels like a notes list.\n"), ago: 3 * DAY },
    { id: await seed("What a Brain page is", "A Brain page is something you and Perry both keep. You write in it; he reads it before he answers.\n", "script"), ago: 2 * DAY },
  ];
  const thread = await seed("Why local-first agents", [
    "Your assistant should live on your computer, not in someone else's.",
    "---",
    "Local-first means your notes, your memory and your files stay in one SQLite file you can back up, read and delete.",
    "---",
    "It also means the agent can use the tools you already have: your browser, your terminal, your signed-in apps. No new accounts, no API keys to babysit, nothing to sync, and nothing that stops working when a company changes its pricing page overnight. That is the whole point of it, and the reason it is worth the setup.",
  ].join("\n\n"), "thread");
  const launch = await seed("Riff launch notes", [
    "Riff is a page you talk into. You speak, and Perry writes it down as clean text while you keep going.",
    "The old version had a panel beside the page with the transcript, unsent words, an instruction box and a link to a chat. People read the panel instead of talking.",
    "Now the page is the whole screen. One bar at the bottom holds the mic and a field to ask for a change, and anything Perry rewrites waits for you to accept it.",
  ].join("\n\n"));

  if (!BEFORE) {
    // Older documents are dated back, with the server stopped, so the list groups them.
    await stopServer();
    const dated = older.map((item) => [Date.now() - item.ago, item.id]);
    const script = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(join(home, "perry.sqlite"))});
      for (const [at, id] of ${JSON.stringify(dated)}) db.prepare("UPDATE doc_notes SET doc = json_set(doc, '$.updatedAt', ?) WHERE _id = ?").run(at, id); db.close();`;
    const dating = spawnSync("node", ["-e", script], { encoding: "utf8" });
    if (dating.status !== 0) throw new Error(`Couldn't date the older documents: ${dating.stderr}`);
    startServer();
    await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start again", 90);
    await checkIn();
  }

  // --- The browser ---------------------------------------------------------------------------------
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(BASE, KEY);
  const b = browser;
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: SPEECH });
  const waitFor = (expression: string, what: string, seconds = 20) => until(() => b.evaluate(`Boolean(${expression})`), what, seconds);
  const viewport = (width: number, height: number, mobile = false) => b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const settle = async () => {
    await b.evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach((button) => button.click()); true");
    await b.evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
    await sleep(500);
  };
  const capture = async (clip?: { x: number; y: number; width: number; height: number }) =>
    Buffer.from((await b.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }) as { data: string }).data, "base64");
  const shot = async (name: string) => { await settle(); const image = await capture(); writeFileSync(join(OUT, name), image); return image; };
  const overflow = () => b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;
  const click = (selector: string) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
  const clickText = (selector: string, text: string) => b.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.innerText.trim().startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
  const type = (selector: string, value: string) => b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus();
    const setter = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`) as Promise<boolean>;
  const text = (selector: string) => b.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`) as Promise<string>;
  const say = (words: string, final: boolean, confidence = 0.9, fresh = false) => b.evaluate(`window.__speech.say(${JSON.stringify(words)}, ${final}, ${confidence}, ${fresh})`) as Promise<boolean>;
  const key = (type: "keyDown" | "keyUp", code: string, keyName: string, modifiers = 0) => b.send("Input.dispatchKeyEvent", { type, code, key: keyName, modifiers, windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : keyName === "Escape" ? 27 : keyName === "Enter" ? 13 : 0 });
  const go = async (path: string, ready: string) => { await b.send("Page.navigate", { url: `${BASE}${path}` }); await waitFor(ready, `${path} to load`, 30); };

  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await viewport(1440, 900);

  if (BEFORE) {
    // The old Riff, mid-dictation, for the before-after picture.
    await go(`/live/${launch}`, "document.querySelector('[aria-label=\"Live editing\"]')");
    await clickText("button", "Start listening");
    await waitFor("window.__speech.current", "listening");
    await say("and the dock stays at the bottom so you never lose the mic", false);
    await sleep(300);
    await shot("before-desktop.png");
    check("captured the old Riff", true);
  } else {
    // --- Home ----------------------------------------------------------------------------------------
    await go("/live", "document.querySelector('[data-riff-list]')");
    const groups = await b.evaluate(`[...document.querySelectorAll('[data-riff-list] section > h2')].map((h) => h.innerText)`) as string[];
    check("the list groups documents by Today, This week and Earlier, newest first", JSON.stringify(groups) === JSON.stringify(["Today", "This week", "Earlier"]), groups);
    const first = await b.evaluate(`document.querySelector('[data-riff-list] li a span')?.innerText`);
    check("the most recent document is first", first === "Riff launch notes", first);
    const sidebar = await b.evaluate(`document.querySelector('[data-sidebar=sidebar]')?.innerText ?? ''`) as string;
    check("documents' editing chats stay out of the sidebar's chats", !sidebar.includes("Riff document"), sidebar.slice(0, 300));
    const nav = await b.evaluate(`[...document.querySelectorAll('[data-sidebar=content] [data-sidebar=menu-button]')].map((el) => (el.getAttribute('aria-label') ?? el.innerText).split(':')[0].split(String.fromCharCode(10)).pop().trim()).filter(Boolean)`) as string[];
    const want = ["New chat", "Board", "To-dos", "Riff", "Meetings", "Library"];
    check("Riff sits in Board v5's sidebar (New chat, Board, To-dos, Riff, Meetings, Library)", want.every((item) => nav.includes(item)) && !nav.includes("Needs you") && !nav.includes("Work") && nav.indexOf("Riff") === nav.indexOf("To-dos") + 1, nav);
    await shot("riff-home-desktop.png");

    // --- New document in one action --------------------------------------------------------------------
    await key("keyDown", "KeyN", "n"); await key("keyUp", "KeyN", "n");
    await waitFor("location.pathname.startsWith('/live/') && document.querySelector('[data-riff-dock]')", "N to open a new document");
    check("N on the list opens a new document", true);
    await waitFor("document.querySelector('[data-note-editor]')", "the editor");
    const emptyText = await b.evaluate(`[document.querySelector('[data-riff-ask]').placeholder, document.querySelector('[data-riff-title]').placeholder, document.querySelector('[data-note-editor] p')?.dataset.placeholder, document.querySelector('[data-riff-dock]').innerText.replace(/\\s+/g, ' ').trim(), document.querySelector('[data-riff-crumb]').innerText].join('|')`);
    check("an empty document asks for nothing but talking or typing", emptyText === "Ask for a change|Untitled|Start talking, or type|Alt+M GPT-5.5|Untitled", emptyText);
    check("a new document starts on the owner's default model", (await text("[data-riff-model]")) === "GPT-5.5", await text("[data-riff-model]"));
    await shot("doc-empty-desktop.png");
    const fresh = await b.evaluate("location.pathname.split('/').pop()") as string;

    // --- Dictation: ghost, then settled --------------------------------------------------------------------
    const doc = await getNote(launch);
    const chat = doc.liveChatId!;
    await go(`/live/${launch}`, "document.querySelector('[data-note-editor]') && document.querySelector('[data-riff-mic]')");
    await click("[data-riff-mic]");
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'listening'", "listening");
    await say("so the um the next thing is", false);
    await waitFor("document.querySelector('[data-riff-ghost] [data-part=heard]')", "words being heard to show");
    check("words being said show at once as ghost text", (await text("[data-riff-ghost]")).startsWith("So the next thing is"), await text("[data-riff-ghost]"));
    await say("so the um the next thing is that the history keeps every version", true);
    const first1 = await liveTurn(chat, "history keeps every version");
    await claim(first1);
    check("the style reaches Perry with the words", first1.prompt.includes(`style, "Notes"`), first1.prompt.slice(0, 400));
    await waitFor("document.querySelector('[data-riff-ghost] [data-part=settling]')", "sent words to keep showing while Perry writes");
    await say("and you can undo any edit Perry makes", false);
    await sleep(400);
    const ghost = await b.evaluate(`[...document.querySelectorAll('[data-riff-ghost] span')].map((s) => s.dataset.part + ':' + s.innerText.trim())`);
    check("sent words and words being heard both show until Perry writes", JSON.stringify(ghost).includes("settling:") && JSON.stringify(ghost).includes("heard:"), ghost);
    const gap = await b.evaluate(`Math.round(document.querySelector('[data-riff-ghost]').getBoundingClientRect().top - document.querySelector('[data-note-editor]').getBoundingClientRect().bottom)`) as number;
    check("ghost text sits right under the document's last line", gap >= 0 && gap <= 24, gap);
    const tones = await b.evaluate(`(() => {
      const paint = (el) => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 1, 1); g.fillStyle = getComputedStyle(document.querySelector("main")).backgroundColor; g.fillRect(0, 0, 1, 1); g.fillStyle = el ? getComputedStyle(el).color : "transparent"; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (el) => { const a = lum(paint(el)); const page = lum(paint(null)); return Math.round(((Math.max(a, page) + 0.05) / (Math.min(a, page) + 0.05)) * 10) / 10; };
      return { sent: ratio(document.querySelector('[data-riff-ghost] [data-part=settling]')), heard: ratio(document.querySelector('[data-riff-ghost] [data-part=heard]')), settled: ratio(document.querySelector('[data-note-editor] p')) };
    })()`) as { sent: number; heard: number; settled: number };
    notes.ghostContrast = tones;
    check("ghost text is readable (sent ≥ 4.5:1, heard ≥ 3:1) and lighter than settled text", tones.sent >= 4.5 && tones.heard >= 3 && tones.heard < tones.sent && tones.sent < tones.settled - 5, tones);
    await shot("doc-dictating-desktop.png");
    const dictating = readFileSync(join(OUT, "doc-dictating-desktop.png"));
    const afterSentence = "So the next thing is that History keeps every version.";
    const appended = await write(chat, launch, "append", afterSentence);
    check("Perry's dictation is written straight in", !appended.error && !appended.note, appended);
    await finish(first1);
    await waitFor(`document.querySelector('[data-note-editor]').innerText.includes(${JSON.stringify(afterSentence)}) && !document.querySelector('[data-riff-ghost] [data-part=settling]')`, "the sent words to settle");
    check("sent words settle into the document once Perry writes them", true);
    await say("and you can undo any edit Perry makes", true);
    const second = await liveTurn(chat, "undo any edit");
    await claim(second);
    await write(chat, launch, "append", "Any edit Perry makes can be undone.");
    await finish(second);
    await waitFor(`!document.querySelector('[data-riff-ghost]')`, "no ghost left");
    await key("keyDown", "Escape", "Escape"); await key("keyUp", "Escape", "Escape");
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'off'", "Esc to stop listening");
    check("Esc stops listening", true);

    // --- Android: zero-confidence finals ---------------------------------------------------------------
    await click("[data-riff-mic]");
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'listening'", "listening again");
    await say("android says", true, 0, true);
    await say("android says this", true, 0, true);
    await say("android says this once", true, 0.82, true);
    const android = await liveTurn(chat, "android says");
    check("a phrase Android repeats as it grows counts once", (android.prompt.match(/android says/g) ?? []).length === 1 && android.prompt.includes("android says this once"), android.prompt.split("New speech:")[1]);
    await claim(android); await finish(android, "Nothing to add.");
    await say("a browser with no confidence", true, 0, true);
    const zero = await liveTurn(chat, "a browser with no confidence");
    check("a final reported with no confidence still arrives, once", (zero.prompt.match(/no confidence/g) ?? []).length === 1);
    await claim(zero); await finish(zero, "Nothing to add.");
    await click("[data-riff-mic]");
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'off'", "stopped");
    await waitFor(`!document.querySelector('[data-riff-ghost]')`, "no ghost left");

    // --- An instruction: a diff to accept or reject ------------------------------------------------------
    const beforeEdit = (await getNote(launch)).content;
    await type("[data-riff-ask]", "Make the second paragraph a list");
    await b.evaluate("document.querySelector('[data-riff-ask]').form.requestSubmit(); true");
    const ask = await liveTurn(chat, "Make the second paragraph a list");
    check("a typed instruction goes to Perry as an instruction", ask.prompt.includes("Typed instruction:\nMake the second paragraph a list"));
    await claim(ask);
    const listed = beforeEdit.replace(
      "The old version had a panel beside the page with the transcript, unsent words, an instruction box and a link to a chat. People read the panel instead of talking.",
      "The old version had a panel beside the page with:\n\n- the transcript\n- unsent words\n- an instruction box\n- a link to a chat\n\nPeople read the panel instead of talking.",
    );
    const proposed = await write(chat, launch, "replace_all", listed, { expectedRevision: (await getNote(launch)).revision });
    await finish(ask, "Made it a list; it's waiting for you.");
    check("a rewrite is held for the owner, not written", Boolean(proposed.note?.includes("accept or reject")) && (await getNote(launch)).content === beforeEdit, proposed);
    await waitFor("document.querySelector('[data-riff-diff]') && document.querySelector('[data-riff-accept]')", "the diff and Accept");
    const diff = await b.evaluate(`({ del: [...document.querySelectorAll('[data-riff-diff] del')].map((n) => n.innerText).join('|'), ins: [...document.querySelectorAll('[data-riff-diff] ins')].map((n) => n.innerText).join('|') })`) as { del: string; ins: string };
    check("the diff strikes the paragraph and marks the list", diff.del.includes("People read the panel") && diff.ins.includes("the transcript"), diff);
    await shot("doc-diff-desktop.png");
    await click("[data-riff-reject]");
    await waitFor("!document.querySelector('[data-riff-diff]')", "Reject to drop the edit");
    check("Reject leaves the document as it was", (await getNote(launch)).content === beforeEdit);

    // Again, with dictation arriving while it waits, then Accept and Undo.
    await type("[data-riff-ask]", "Make the second paragraph a list");
    await b.evaluate("document.querySelector('[data-riff-ask]').form.requestSubmit(); true");
    const ask2 = await liveTurn(chat, "Make the second paragraph a list");
    await claim(ask2);
    await write(chat, launch, "replace_all", listed, { expectedRevision: (await getNote(launch)).revision });
    await finish(ask2);
    await write(chat, launch, "append", "Dictation that came in during review.");
    await waitFor("document.querySelector('[data-riff-accept]')", "Accept");
    await key("keyDown", "Enter", "Enter", 2); await key("keyUp", "Enter", "Enter", 2);
    await waitFor("!document.querySelector('[data-riff-diff]')", "Ctrl+Enter to accept");
    const accepted = (await getNote(launch)).content;
    check("Accept writes the edit and keeps dictation that came in meanwhile", accepted.includes("- the transcript") && accepted.trimEnd().endsWith("Dictation that came in during review."), accepted);
    await waitFor("[...document.querySelectorAll('[data-sonner-toast] button')].some((b) => b.innerText === 'Undo')", "the Undo toast");
    await b.evaluate("[...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.innerText === 'Undo').click(); true");
    await until(async () => !(await getNote(launch)).content.includes("- the transcript"), "Undo to put the paragraph back");
    check("Undo puts back the document from before the edit", (await getNote(launch)).content.includes("People read the panel instead of talking.") && !(await getNote(launch)).content.includes("- the transcript"));

    // An edit made on words the owner has since changed.
    await type("[data-riff-ask]", "Punchier intro");
    await b.evaluate("document.querySelector('[data-riff-ask]').form.requestSubmit(); true");
    const ask3 = await liveTurn(chat, "Punchier intro");
    await claim(ask3);
    const now3 = await getNote(launch);
    await write(chat, launch, "replace_all", now3.content.replace("Riff is a page you talk into.", "Riff: talk, and it's written."), { expectedRevision: now3.revision });
    await finish(ask3);
    await waitFor("document.querySelector('[data-riff-accept]')", "the punchier intro to review");
    const latest3 = await getNote(launch);
    await pub("notes:save", { id: launch, content: latest3.content.replace("while you keep going", "while you keep talking"), expectedRevision: latest3.revision });
    await click("[data-riff-accept]");
    await waitFor("document.querySelector('[data-riff-dock]').innerText.includes('The document changed since this edit')", "the changed-document row");
    check("an edit made on words since changed is not applied", !(await getNote(launch)).content.includes("Riff: talk"));
    await clickText("[data-riff-dock] button", "Discard");
    await waitFor("!document.querySelector('[data-riff-diff]')", "Discard");

    // --- History --------------------------------------------------------------------------------------
    await click("[data-riff-history-button]");
    await waitFor("document.querySelectorAll('[data-riff-history] li button').length >= 3", "History's versions");
    const kinds = await b.evaluate(`[...document.querySelectorAll('[data-riff-history] li button')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim())`) as string[];
    check("History keeps dictation, the accepted edit and the restore", kinds.some((k) => k.startsWith("Dictation")) && kinds.some((k) => k.includes("Make the second paragraph a list")) && kinds.some((k) => k.startsWith("Restored")), kinds);
    await b.evaluate(`[...document.querySelectorAll('[data-riff-history] li button')].find((n) => n.innerText.includes('Make the second paragraph a list')).click(); true`);
    await waitFor("document.querySelector('[data-riff-diff]') && document.querySelector('[data-riff-dock]').innerText.includes('Version from')", "a version's preview");
    await shot("doc-history-desktop.png");
    await clickText("[data-riff-dock] button", "Restore");
    await until(async () => (await getNote(launch)).content.includes("- the transcript"), "Restore");
    check("Restore puts a version back", true);

    // --- Styles -------------------------------------------------------------------------------------------
    await go(`/live/${thread}`, "document.querySelector('[data-note-editor]') && document.querySelector('[data-riff-meters]')");
    const meter = await text("[data-riff-meters]");
    check("Thread shows posts against its limit", /3 posts · 1 over 280/.test(meter), meter);
    await click("[data-riff-style-button]");
    await waitFor("document.querySelectorAll('[data-riff-styles] [data-style]').length >= 5", "the style list");
    const styles = await b.evaluate(`[...document.querySelectorAll('[data-riff-styles] [data-style]')].map((n) => n.dataset.style)`) as string[];
    check("the picker offers the core styles, then the skills folder's styles", JSON.stringify(styles.slice(0, 3)) === JSON.stringify(["notes", "script", "thread"]) && styles.includes("newsletter") && styles.includes("launch-post"), styles);
    check("a skill that is not a writing style stays out of the picker", !styles.includes("weekly-review"), styles);
    await shot("doc-style-picker-desktop.png");
    await b.evaluate(`document.querySelector('[data-riff-styles] [data-style=launch-post]').click(); true`);
    await until(async () => (await getNote(thread)).riffStyle === "launch-post", "the style to change");
    const threadChat = (await getNote(thread)).liveChatId!;
    await type("[data-riff-ask]", "Shorter last post");
    await b.evaluate("document.querySelector('[data-riff-ask]').form.requestSubmit(); true");
    const styled = await liveTurn(threadChat, "Shorter last post");
    check("a skill as style reaches Perry as $name", styled.prompt.includes("$launch-post"));
    await claim(styled); await finish(styled, "Nothing to change.");

    // --- The hotkey -------------------------------------------------------------------------------------------
    await key("keyDown", "KeyM", "m", 1);
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'listening'", "Alt+M to start listening");
    await sleep(600);
    await key("keyUp", "KeyM", "m", 1);
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'off'", "letting go of a held Alt+M to stop");
    await key("keyDown", "KeyM", "m", 1); await key("keyUp", "KeyM", "m", 1);
    await sleep(300);
    const tapped = await b.evaluate("document.querySelector('[data-riff-mic]').dataset.phase");
    await key("keyDown", "KeyM", "m", 1); await key("keyUp", "KeyM", "m", 1);
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'off'", "a second tap to stop");
    check("Alt+M: hold to talk, tap to keep listening", tapped === "listening");

    // --- Send ---------------------------------------------------------------------------------------------
    await go(`/live/${launch}`, "document.querySelector('[data-riff-send-button]')");
    await click("[data-riff-send-button]");
    await waitFor("document.querySelector('[role=menu]')", "the Send menu");
    await shot("doc-send-desktop.png");
    await clickText("[role=menuitem]", "Save to Brain");
    const brain = await until(async () => (await pub<Array<{ id: string; title: string }>>("notes:list")).find((n) => n.title === "Riff launch notes"), "the Brain page");
    check("Save to Brain makes a Brain page of it", Boolean(brain) && (await getNote(brain.id)).content.includes("History keeps every version"));
    await click("[data-riff-send-button]");
    await waitFor("document.querySelector('[role=menu]')", "the Send menu");
    await clickText("[role=menuitem]", "Send to someone");
    await waitFor("document.querySelector('[role=dialog] input')", "the Send to someone field");
    await type("[role=dialog] input", "Asha on WhatsApp");
    await b.evaluate("document.querySelector('[role=dialog] form').requestSubmit(); true");
    await waitFor("location.pathname.startsWith('/chat/')", "the hand-off chat");
    const handChat = await b.evaluate("location.pathname.split('/').pop()") as string;
    await waitFor("[...document.querySelectorAll('button[aria-label=\"Reply options\"]')].some((n) => n.innerText.trim() === 'Reply options')", "the chat composer's Reply options");
    check("the chat composer keeps its Reply options picker (shared with Riff)", true);
    const hand = await nextTurn((turn) => turn.conversationId === handChat, "the hand-off's turn");
    check("Send to someone asks Perry to send it through send_message", hand.prompt.includes("Asha on WhatsApp") && hand.prompt.includes("send_message") && hand.prompt.includes(launch), hand.prompt.slice(-400));
    await claim(hand); await finish(hand, "I'll ask you before sending.");

    // --- The model ----------------------------------------------------------------------------------------
    await go(`/live/${launch}`, "document.querySelector('[data-note-editor]') && document.querySelector('[data-riff-model]')");
    const openModels = async () => {
      await click("[data-riff-model-chip]");
      await waitFor("document.querySelectorAll('[data-riff-models] [data-model]').length >= 4", "the model menu");
    };
    await openModels();
    const offered = await b.evaluate(`[...document.querySelectorAll('[data-riff-models] [role=group]')].map((g) => g.innerText.replace(/\\s+/g, ' ').trim())`) as string[];
    check("the dock's model menu lists the models by engine", offered.length === 2 && offered[0].includes("GPT-5.5 mini") && offered[1].includes("Claude Opus 5.5"), offered);
    const layers = await b.evaluate(`({ surfaces: document.querySelectorAll('[data-riff-models]').length, nested: document.querySelectorAll('[role=listbox], [data-riff-models] [data-riff-models]').length, thinking: [...document.querySelectorAll('[data-riff-models] [role=radio]')].map((n) => n.innerText) })`) as { surfaces: number; nested: number; thinking: string[] };
    check("one surface: models and thinking together, no menu on a menu", layers.surfaces === 1 && layers.nested === 0 && JSON.stringify(layers.thinking) === JSON.stringify(["Default", "Low", "Medium", "High"]), layers);
    await shot("model-selector-desktop.png");
    await click('[data-riff-models] [data-model="claude/claude-opus-5-5"]');
    const picked = await until(async () => { const c = await pub<{ engine?: string; model?: string }>("dashboard:getChat", { id: chat }); return c.engine === "claude" && c.model === "claude-opus-5-5" ? c : null; }, "the model to be kept with the document");
    check("picking a model keeps it with the document", Boolean(picked));
    await waitFor("[...document.querySelectorAll('[data-riff-models] [role=radio]')].length === 4", "Opus's thinking levels");
    await click('[data-riff-models] [data-effort="low"]');
    await until(async () => (await pub<{ effort?: string }>("dashboard:getChat", { id: chat })).effort === "low", "the thinking level to be kept");
    await key("keyDown", "Escape", "Escape"); await key("keyUp", "Escape", "Escape");
    await sleep(300);
    await type("[data-riff-ask]", "Tighten the last line");
    await b.evaluate("document.querySelector('[data-riff-ask]').form.requestSubmit(); true");
    const onClaude = await nextTurn((turn) => turn.conversationId === chat && turn.prompt.includes("Tighten the last line"), "the edit's turn");
    const used = onClaude as Turn & { engine?: string; requestedModel?: string; requestedEffort?: string };
    check("the next edit runs on the picked model and thinking level", used.engine === "claude" && used.requestedModel === "claude-opus-5-5" && used.requestedEffort === "low", { engine: used.engine, model: used.requestedModel, effort: used.requestedEffort });
    await claim(onClaude); await finish(onClaude, "Nothing to change.");
    await go(`/live/${launch}`, "document.querySelector('[data-riff-model]')");
    await waitFor("document.querySelector('[data-riff-model]').innerText === 'Opus 5.5'", "the picked model, by its short name, after a reload");
    check("the picked model is still there after a reload", true);

    // --- 1280 px: one left edge -------------------------------------------------------------------------
    await viewport(1280, 800);
    await go(`/live/${launch}`, "document.querySelector('[data-note-editor]') && document.querySelector('[data-riff-meters]')");
    await settle();
    const edges = await b.evaluate(`(() => { const x = (s) => Math.round(document.querySelector(s).getBoundingClientRect().left); return { title: x('[data-riff-title]'), body: x('[data-note-editor]'), meters: x('[data-riff-meters]'), dock: x('[data-riff-dock] > div') }; })()`) as Record<string, number>;
    check("at 1280 px the title, body, meters and dock share one left edge", new Set(Object.values(edges)).size === 1 && (await overflow()) <= 0, edges);
    await shot("doc-1280-desktop.png");
    await viewport(1440, 900);

    // --- Phone ------------------------------------------------------------------------------------------
    await viewport(390, 844, true);
    await go("/live", "document.querySelector('[data-riff-list]')");
    check("the phone list does not overflow", (await overflow()) <= 0, await overflow());
    await shot("riff-home-phone.png");
    await go(`/live/${launch}`, "document.querySelector('[data-note-editor]') && document.querySelector('[data-riff-mic]')");
    await b.evaluate("document.querySelector('main').scrollIntoView(); window.scrollTo(0, document.body.scrollHeight); true");
    await click("[data-riff-mic]");
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'listening'", "listening on the phone");
    await say("on the phone the dock sits under your thumb", true);
    const phoneTurn = await liveTurn(chat, "under your thumb");
    await claim(phoneTurn);
    await say("and the page scrolls behind it", false);
    await sleep(400);
    const dock = await b.evaluate(`(() => { const r = document.querySelector('[data-riff-dock] > div').getBoundingClientRect(); const mic = document.querySelector('[data-riff-mic]').getBoundingClientRect(); return { bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), mic: Math.round(mic.height) }; })()`) as { bottom: number; left: number; right: number; mic: number };
    check("on a phone the dock stays on screen, full width, with a 44 px mic", dock.bottom <= 844 && dock.left >= 0 && dock.right <= 390 && dock.mic >= 44 && (await overflow()) <= 0, dock);
    const calm = await b.evaluate(`({ buttons: [...document.querySelectorAll('[data-riff-dock] button')].filter((n) => n.offsetParent).map((n) => n.getAttribute('aria-label') ?? n.innerText), placeholder: document.querySelector('[data-riff-ask]').placeholder })`) as { buttons: string[]; placeholder: string };
    check("while listening the phone dock shows one status and one way to stop", calm.buttons.length === 1 && calm.buttons[0] === "Stop listening" && calm.placeholder === "Listening…", calm);
    await shot("doc-dictating-phone.png");
    await write(chat, launch, "append", "On the phone the dock sits under your thumb.");
    await finish(phoneTurn);
    await click("[data-riff-mic]");
    await waitFor("document.querySelector('[data-riff-mic]').dataset.phase === 'off'", "stopped on the phone");
    await type("[data-riff-ask]", "Make the second paragraph a list");
    await b.evaluate("document.querySelector('[data-riff-ask]').form.requestSubmit(); true");
    const phoneAsk = await liveTurn(chat, "Make the second paragraph a list");
    await claim(phoneAsk);
    const phoneNow = await getNote(launch);
    await write(chat, launch, "replace_all", phoneNow.content.replace("- a link to a chat\n", "- a link to a chat\n- a Stop edits button\n"), { expectedRevision: phoneNow.revision });
    await finish(phoneAsk);
    await waitFor("document.querySelector('[data-riff-accept]')", "the phone diff");
    await b.evaluate("document.querySelector('[data-riff-diff] ins')?.scrollIntoView({ block: 'center' }); true");
    const buttons = await b.evaluate(`[...document.querySelectorAll('[data-riff-dock] button')].filter((n) => n.offsetParent).map((n) => Math.round(n.getBoundingClientRect().height))`) as number[];
    check("on a phone every dock control is at least 44 px tall", buttons.every((h) => h >= 44), buttons);
    await shot("doc-diff-phone.png");
    await click("[data-riff-reject]");
    await waitFor("!document.querySelector('[data-riff-diff]')", "the phone reject");
    await b.evaluate("window.scrollTo(0, document.documentElement.scrollHeight); true");
    await openModels();
    const pill = await b.evaluate(`(() => { const chip = document.querySelector('[data-riff-model-chip]'); const name = chip.querySelector('[data-riff-model]'); const r = chip.getBoundingClientRect(); const ask = document.querySelector('[data-riff-ask]').getBoundingClientRect(); return { text: name.innerText, height: Math.round(r.height), width: Math.round(r.width), clipped: name.scrollWidth > name.clientWidth + 1 || r.right > 390, ask: Math.round(ask.width), sheet: Boolean(document.querySelector('[data-riff-models][data-side=bottom]')) }; })()`) as { text: string; height: number; width: number; clipped: boolean; ask: number; sheet: boolean };
    check("on a phone the chip reads the short name in full, 44 px tall, leaving room to type; the menu is a bottom sheet", pill.text === "Opus 5.5" && !pill.clipped && pill.height >= 44 && pill.ask >= 120 && pill.sheet, pill);
    await shot("model-selector-phone.png");
    await key("keyDown", "Escape", "Escape"); await key("keyUp", "Escape", "Escape");
    await sleep(200);
    await key("keyDown", "Escape", "Escape"); await key("keyUp", "Escape", "Escape");
    await sleep(300);

    // Typing at the end of a long document: the line being typed and the last line stay above the dock.
    const clearOfDock = () => b.evaluate(`(() => {
      const dock = document.querySelector('[data-riff-dock] > div').getBoundingClientRect();
      const range = getSelection().rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : null;
      return { dockTop: Math.round(dock.top), dockBottom: Math.round(dock.bottom), caret: range ? Math.round(range.bottom) : null };
    })()`) as Promise<{ dockTop: number; dockBottom: number; caret: number | null }>;
    await b.evaluate(`(() => { const editor = document.querySelector('[data-note-editor]'); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); return true; })()`);
    const typeLine = async (words: string) => {
      await key("keyDown", "Enter", "Enter"); await key("keyUp", "Enter", "Enter");
      await b.send("Input.insertText", { text: words });
      await sleep(250);
    };
    for (let line = 1; line <= 4; line++) await typeLine(`Typed on the phone, line ${line}, to see the caret stay above the dock.`);
    const typing = await clearOfDock();
    check("on a phone the line being typed stays above the dock", typing.caret !== null && typing.caret <= typing.dockTop, typing);
    await b.evaluate("window.__speech.keyboard(300)");
    await sleep(400);
    for (let line = 5; line <= 7; line++) await typeLine(`With the keyboard open, line ${line}.`);
    const keyboard = await clearOfDock();
    check("with the keyboard open the dock sits above it and the line being typed above the dock", keyboard.dockBottom <= 844 - 300 && keyboard.caret !== null && keyboard.caret <= keyboard.dockTop, keyboard);
    await b.evaluate("document.activeElement.blur(); window.scrollTo(0, document.documentElement.scrollHeight); true");
    await sleep(300);
    const last = await b.evaluate(`(() => { const blocks = document.querySelectorAll('[data-note-editor] > *'); const end = blocks[blocks.length - 1].getBoundingClientRect(); return { last: Math.round(end.bottom), dockTop: Math.round(document.querySelector('[data-riff-dock] > div').getBoundingClientRect().top) }; })()`) as { last: number; dockTop: number };
    check("scrolled to the end, the document's last line clears the dock (keyboard open)", last.last <= last.dockTop, last);
    await b.evaluate("window.__speech.keyboard(0)");
    // What was typed is saved (leaving with unsaved words would ask first).
    await until(async () => (await getNote(launch)).content.includes("With the keyboard open, line 7."), "the typed lines to be saved");
    check("lines typed on the phone are saved", true);
    await viewport(1440, 900);

    // --- Before and after -----------------------------------------------------------------------------------
    let before: Buffer | null = null;
    try { before = readFileSync(join(OUT, "before-desktop.png")); } catch { try { before = readFileSync(join(REPO, "artifacts", "riff-v2", "before-desktop.png")); } catch {} }
    if (before) {
      const panel = (label: string, image: Buffer) => `<figure style="margin:0"><figcaption style="margin:0 0 8px">${label}</figcaption><img src="data:image/png;base64,${image.toString("base64")}" style="width:720px;border:1px solid #e5e5e5;border-radius:8px;display:block"></figure>`;
      await viewport(1600, 760);
      const leaving = b.send("Page.navigate", { url: "about:blank" });
      await sleep(1500);
      const dialog = await b.send("Page.handleJavaScriptDialog", { accept: true }).then(() => true, () => false);
      if (dialog) notes.leaveDialog = "a leave prompt was open and was accepted";
      await leaving;
      await b.evaluate(`document.body.innerHTML = ${JSON.stringify(`<div style="display:inline-flex;gap:24px;padding:24px;font:500 14px system-ui;color:#555;background:#fff">${panel("Before (v1)", before)}${panel("After", dictating)}</div>`)}; document.body.style.margin = 0; true`);
      await sleep(500);
      const size = await b.evaluate(`(() => { const r = document.body.firstElementChild.getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`) as { width: number; height: number };
      writeFileSync(join(OUT, "before-after-desktop.png"), await capture({ x: 0, y: 0, ...size }));
    }
    notes.freshDocument = fresh;
  }

  notes.browserErrors = browser.errors;
  check("no errors in the browser", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.error = String((error as Error).stack ?? error);
  notes.serverLog = log.slice(-4_000);
  console.error(error);
  if (browser) {
    try { const image = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string }; writeFileSync(join(OUT, "failure.png"), Buffer.from(image.data, "base64")); } catch {}
  }
} finally {
  if (beating) clearInterval(beating);
  browser?.close();
  await stopServer();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const passed = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean) && !notes.error;
writeFileSync(join(OUT, BEFORE ? "result-before.json" : "result.json"), `${JSON.stringify({ passed, checkedAt: new Date().toISOString(), platform: process.platform, checks, notes }, null, 2)}\n`);
console.log(passed ? "PASS" : "FAIL");
process.exit(passed ? 0 : 1);
