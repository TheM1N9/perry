import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/fewer-boxes/run.ts <outDir> [--before <checkout>]
// Issues #179 and #180: the boxes that did not earn their place gone (List,
// EmptyState and StatusBadge first, then the cards around one thing and the
// boxes in boxes), and the Save buttons replaced: notes save themselves,
// secrets keep a quiet Save inside their field, adding says what it adds,
// editing in place takes Enter and Esc, and no primary button sits greyed out.
// A fresh Perry: the production build (`pnpm build` first) on a free port, a
// PERRY_HOME in PERRY_E2E_HOMES (else the temp folder), no Telegram, no
// Composio, and no Codex or Claude: CODEX_HOME and CLAUDE_CONFIG_DIR point
// into the test's home, and the runner is played by its calls. The seed is
// artifacts/ui-consistency's (a reply with a checklist, a failed run, memories,
// to-dos, a schedule that ran, a failed update, an approval and a decided one,
// a skill, a project), plus a person, a login, a goal, a watch and a task with
// a question, so every changed screen has rows. Headless Chrome, light and
// dark; the pet's page in a plain tab at his window's 404×620, never the real
// pet. With --before <checkout>, the same seed and pictures from that
// checkout's build, and no checks.
//
// Ways it could fail, written down before the checks:
//   1. A List, EmptyState or card wrapper still draws a box: a border on three
//      or four sides, or a fill other than the page's, on a changed screen.
//      (What the issues keep is left out: composers, dialogs, menus, the
//      pet's panel and bubbles, message bubbles, code blocks and tables in
//      replies, attachments, inputs and segmented controls, the dashboard's
//      approval cards, the QR code, CommandLine, and status pills that are
//      allowed.)
//   2. A healthy row still wears a pill: a running schedule, an online
//      computer, a completed run, a set key, a watched page.
//   3. A pill is left on something that needs no look: one whose tone is not
//      a warning or a failure and that does not pulse.
//   4. An empty state is still a dashed box.
//   5. A text that should save itself does not: project instructions,
//      personality, the name, USER.md and a person's brief, typed and then left
//      alone (or left by Tab), never reach the server; or they do but "Saved"
//      never shows; or a Save button is still there.
//   6. Leaving the page right after typing loses the words: an in-app link
//      unmounts the field before the pause is over; closing the tab does not
//      ask while a save is still to go.
//   7. A failed save is silent, or cannot be tried again: the status must say
//      it failed and offer Try again, the words must stay in the field, and
//      Try again must save them once the server takes them.
//   8. Typing USER.md in a few pauses fills its history: each pause a version
//      of its own would push the real ones out.
//   9. A secret is stored half typed: a pause must not save a key; only its
//      Save (which shows only once something is typed) or Enter does, and
//      a cleared field has no Save at all.
//  10. Adding a login or a memory still says Save, shows its button while
//      there is nothing to add, or ignores Enter.
//  11. Editing a memory in place: Enter does not save, Esc does not cancel (or
//      saves anyway), or the buttons are filled ones.
//  12. A primary button sits greyed out at rest on a checked screen.
//  13. Anything throws or logs an error on a checked page, in either theme.
//  14. A picture proves nothing: a screen is shot before its seeded content
//      shows (each shot waits for its seeded words).

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: bun artifacts/fewer-boxes/run.ts <outDir> [--before <checkout>]");
const beforeAt = args.indexOf("--before");
const REPO = beforeAt >= 0 ? resolve(args[beforeAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BEFORE = beforeAt >= 0;
const OUT = resolve(outDir);
mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "fewer-boxes-e2e-key";
const homes = process.env.PERRY_E2E_HOMES ?? tmpdir();
mkdirSync(homes, { recursive: true });
const home = mkdtempSync(join(homes, "perry-fewer-boxes-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => {
  checks[name] = ok;
  if (note !== undefined) notes[name] = note;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && note !== undefined ? ` ${JSON.stringify(note).slice(0, 600)}` : ""}`);
};

mkdirSync(join(home, "skills", "weekly-review"), { recursive: true });
writeFileSync(join(home, "skills", "weekly-review", "SKILL.md"), "---\nname: weekly-review\ndescription: Writes the owner's weekly review the way they like it.\n---\n\nStart with what shipped, then what slipped.\n");

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  // Never the owner's accounts: no engine here has a sign-in.
  CODEX_HOME: join(home, "codex-home"), CLAUDE_CONFIG_DIR: join(home, "claude-home"),
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "GEMINI_API_KEY" || name === "ELECTRON_RUN_AS_NODE" || name === "PERRY_URL") delete env[name];
mkdirSync(env.CODEX_HOME!, { recursive: true });
mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

async function call<T>(path: string, callArgs: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args: callArgs }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<unknown> | unknown, what: string, seconds = 30) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}
/** Whether `test` comes true within `seconds`, without throwing. */
const soon = (test: () => Promise<unknown> | unknown, seconds = 8) => until(test, "", seconds).then(() => true, () => false);

type Browser = Awaited<ReturnType<typeof openChat>>;
let browser: Browser | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

const CHECKLIST_REPLY = `Here's the week, with what's done ticked:

- [x] Book the dentist
- [x] Send the invoice to Priya
- [ ] Renew the passport photos
- [ ] Call Sam about Saturday

| Day | Plan | Time |
| --- | --- | --- |
| Monday | Gym, then the design review | 07:30 |
| Wednesday | Dentist | 14:00 |
| Friday | Weekly review | 16:00 |

Want me to put the passport photos on your list?`;

type Persona = { user: string; name: string; personality: string };

try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  const runnerJson = join(home, "runner.json");
  await until(() => existsSync(runnerJson), "the server to connect this computer", 60);
  const token = (JSON.parse(readFileSync(runnerJson, "utf8")) as { token: string }).token;
  const workdir = join(home, "work", "a-long-folder-name-that-the-row-cuts-off", "and-one-more-level-for-good-measure");
  const online = async () => {
    await call("runner:checkIn", { token, platform: "win32", hostname: "E2E", workdir });
    await call("codex:reportAccount", { token, available: true, authMode: "chatgpt", planType: "plus" }).catch(() => {});
  };
  await online();
  heartbeat = setInterval(() => void online().catch(() => {}), 20_000);

  // --- The seed: artifacts/ui-consistency's, then what the other changed screens need ----------
  const project = await call<string>("projects:create", { key: KEY, name: "Kitchen renovation" });
  const chat = async (title: string) => {
    const id = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:renameChat", { key: KEY, id, title }).catch(() => {});
    return id;
  };
  const turn = async (id: string, text: string, finish: { response?: string; error?: string; spans?: object[] }) => {
    await call("dashboard:sendChat", { key: KEY, id, text });
    let queued: { _id: string } | undefined;
    await until(async () => { queued = (await call<Array<{ _id: string; conversationId: string }>>("codex:queuedTurns", { token })).find((item) => item.conversationId === id); return Boolean(queued); }, "the turn to queue", 30);
    await call("codex:claimTurn", { token, id: queued!._id });
    if (finish.spans) await call("codex:traceTurn", { token, id: queued!._id, spans: finish.spans, steps: 3, usage: { inputTokens: 18_204, cachedInputTokens: 12_000, outputTokens: 912 } });
    await call("codex:finishTurn", { token, id: queued!._id, ...(finish.response ? { response: finish.response, model: "gpt-6-luna" } : {}), ...(finish.error ? { error: finish.error } : {}) });
  };

  const planChat = await chat("Plan my week");
  const receiptsChat = await chat("Export last year's receipts");
  const memoryChat = await chat("Coffee order");
  const coffee = await call<{ id?: string }>("memories:add", { text: "Sam takes their coffee black, no sugar.", tags: [], source: "e2e", kind: "profile", origin: "owner" });
  await call("memories:add", { text: "In this chat, answers stay under three lines.", tags: [], source: "e2e", kind: "core", origin: "owner", conversationId: memoryChat });
  await call("memories:add", { text: "The kitchen tiles are the matte green ones from Porto.", tags: [], source: "e2e", kind: "core", origin: "owner", projectId: project });
  await call("memories:add", { text: "Prefers trains to flights for trips under six hours.", tags: [], source: "dreaming", kind: "core", origin: "owner" });
  await call("memories:add", { text: "Booked passport photos for Saturday at 11:00.", tags: [], source: "e2e", kind: "daily", origin: "owner" });

  const started = Date.now() - 40_000;
  await turn(planChat, "$weekly-review Plan my week, and tick off what's already done.", {
    response: `${CHECKLIST_REPLY}\nmemories: ${coffee.id}`,
    spans: [
      { callId: "c1", kind: "command", name: "Get-Content calendar.ics", status: "ok", startedAt: started, durationMs: 1_800, input: "Get-Content C:\\Users\\sam\\calendar.ics | Select-String 'DTSTART'", output: "DTSTART:20261002T083000" },
      { callId: "c2", kind: "fileChange", name: "notes/week.md", status: "ok", startedAt: started + 2_000, durationMs: 400, input: "notes/week.md", output: "Added the week's plan." },
    ],
  });
  await turn(receiptsChat, "Export last year's receipts from the bank.", { error: "The bank's export page asked for a one-time code, and none was available." });

  const today = new Date();
  const at = (days: number, hours: number, minutes = 0) => { const d = new Date(today); d.setDate(d.getDate() + days); d.setHours(hours, minutes, 0, 0); return d.getTime(); };
  await call("todos:add", { key: KEY, title: "Stretch", dueAt: at(1, 11), repeat: "0 11 * * *" });
  await call("todos:add", { key: KEY, title: "Water the plants", dueAt: Date.now() + 2 * 3_600_000 });
  await call("todos:add", { key: KEY, title: "Weekly review", dueAt: at(2, 16), repeat: "0 16 * * 5" });
  const done = await call<string>("todos:add", { key: KEY, title: "Send the invoice to Priya" });
  await call("todos:setDone", { key: KEY, id: done, done: true });

  const job = await call<{ id: string }>("jobs:create", { name: "Morning briefing", schedule: "0 8 * * 1-5", prompt: "Summarise my calendar and anything urgent in email." });
  await call("jobs:trigger", { id: job.id });
  await call("jobs:finished", { id: job.id, result: "Three meetings today; the 14:00 with Priya moved to 15:30." });

  await call("updates:finished", { result: {
    id: "e2e-update", by: "nightly", at: Date.now() - 3 * 3_600_000, ok: false, from: "6fb9d92", to: "429446f",
    error: "pnpm install could not reach the registry.", log: "step 1: ok\nstep 2: ERR_PNPM_META_FETCH_FAIL",
  } });

  await call("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\build-cache", cwd: join(workdir, "site"), conversationId: planChat });
  const old = await call<{ id: string }>("approvals:request", { token, kind: "command", title: "git push origin main --force-with-lease", cwd: workdir });
  await call("approvals:decide", { key: KEY, id: old.id, approved: false });

  // A person to brief, a login, a goal, a watch, and a task waiting on a question.
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: "15550001111@s.whatsapp.net", kind: "person", name: "Datta" }] });
  // Allowed, as the owner's yes makes him: People lists only who Perry talks with, or is asked about.
  const datta = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: "15550001111@s.whatsapp.net" });
  await call("contacts:decided", { contactId: datta._id, kind: "contact", approved: true });
  await call("dashboard:saveToVault", { key: KEY, label: "Netflix", url: "https://www.netflix.com/login", username: "sam@example.com", value: "e2e-not-a-password" });
  await call("dashboard:saveGoal", { key: KEY, title: "Run a half marathon by March", description: "", milestones: [{ title: "Run 5 km without stopping", done: true }, { title: "Run 10 km", done: false }] }).catch((error) => { notes.goalSeed = String(error); });
  await call("dashboard:saveMonitor", { key: KEY, title: "Headphones back in stock", url: "https://example.com/headphones", condition: "contains", value: "In stock", intervalMinutes: 60 }).catch((error) => { notes.watchSeed = String(error); });
  const task = await call<string>("tasks:queue", { title: "Compare three flats near work", prompt: "Find three flats near the office." });
  await sleep(1500);
  await call("work:updateTask", { taskId: task, status: "blocked", question: "Is ₹40,000 a month the most you'd pay, or is that with the deposit spread out?" }).catch((error) => { notes.taskSeed = String(error); });

  // --- The browser -------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errors = []; { const e = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ").slice(0, 300)); e(...a); }; }` });
  const errors: Array<{ page: string; error: string }> = [];
  const collectErrors = async (page: string) => { for (const error of (await evaluate(`window.__errors ?? []`).catch(() => [])) as string[]) errors.push({ page, error }); await evaluate(`window.__errors = []; true`).catch(() => {}); };
  const waitFor = (test: string, what: string, seconds = 20) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const go = async (path: string, words: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(`document.body.innerText.includes(${JSON.stringify(words)})`, `${path} to show "${words}"`, 30);
    await sleep(700);
  };
  let theme: "light" | "dark" = "light";
  const shot = async (name: string, full = true) => {
    // The whole page, not just what fits the window, so a picture shows every box or its absence.
    let clip: object | undefined;
    if (full) {
      const size = await evaluate(`(() => { const s = document.querySelector("main") ?? document.body; const scroller = [...document.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 40 && ["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.clientWidth > 600); return { height: Math.max(document.documentElement.scrollHeight, scroller ? scroller.scrollHeight + 48 : 0, s.scrollHeight) }; })()`) as { height: number };
      if (size.height > 800) clip = { x: 0, y: 0, width: 1280, height: Math.min(size.height, 4000), scale: 1 };
    }
    const image = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) }) as { data: string };
    writeFileSync(join(OUT, `${name}-${theme}${BEFORE ? "-before" : ""}.png`), Buffer.from(image.data, "base64"));
  };
  const size = (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const middle = (expression: string) => evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
  const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
  const click = async (expression: string) => {
    const point = await middle(expression);
    if (!point) throw new Error(`nothing to click: ${expression}`);
    await mouse("mouseMoved", point.x, point.y);
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseReleased", point.x, point.y);
    await sleep(250);
  };
  const KEYS = { Escape: 27, Enter: 13, Tab: 9 } as const;
  const press = async (name: keyof typeof KEYS) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: KEYS[name], ...(name === "Enter" ? { text: "\r" } : {}) });
    if (name === "Enter") await send("Input.dispatchKeyEvent", { type: "char", key: name, code: name, windowsVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: KEYS[name] });
    await sleep(200);
  };
  const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.innerText.trim().includes(${JSON.stringify(text)}))`;
  const typeText = async (text: string) => { await send("Input.insertText", { text }); await sleep(120); };
  const focus = (expression: string) => evaluate(`(() => { const el = ${expression}; el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); return true; })()`);
  /** A visible button whose words are exactly `words`, inside `scope`. */
  const buttonsNamed = (words: string, scope = "main") => evaluate(`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter((b) => b.offsetParent && b.innerText.trim() === ${JSON.stringify(words)}).length`) as Promise<number>;
  const status = (expression: string) => evaluate(`(() => { const el = ${expression}; return el ? { state: el.dataset.save, text: el.innerText.trim() } : null; })()`) as Promise<{ state: string; text: string } | null>;

  /**
   * Boxes on the page: elements drawing a border on three or four sides, or a fill other than the page's, at least
   * 28×20, outside what the issues keep. A pill is reported apart, with its tone, for the pill checks.
   */
  const BOXES = `(() => {
    const keep = [
      "button", "input", "textarea", "select", "kbd", "img", "video", "svg", "header", "nav", "[data-sidebar]", "[data-slot=sidebar]",
      "[role=dialog]", "[role=alertdialog]", "[role=menu]", "[role=listbox]", "[role=tooltip]", "[data-slot=tooltip-content]", "[data-sonner-toaster]",
      "[data-slot=input-group]", "[data-slot=select-trigger]", "[data-slot=toggle-group]", "[data-slot=tabs-list]", "[data-slot=radio-group-card]",
      "[data-slot=checkbox]", "[data-slot=switch]", "[data-slot=skeleton]", "[data-slot=progress]", "[data-slot=scroll-area-scrollbar]",
      "[data-slot=alert][role=alert]", "article:not([data-bare])", "article pre", ".prose-chat", "[data-command-line]", "ol[aria-label=Trace]",
      "[data-pill]", "[data-role=user] > div", "[data-pending] > div", "[data-composer]", "[data-slot=avatar]", "[data-slot=calendar]",
      "[data-slot=time-picker]", "[data-slot=tabs-list]",
    ].join(",");
    const page = getComputedStyle(document.body).backgroundColor;
    const clear = (c) => c === "transparent" || /rgba\\(\\d+, \\d+, \\d+, 0\\)/.test(c) || /\\/ 0\\)$/.test(c);
    const found = [];
    const root = document.querySelector("section[aria-label=Perry] [data-slot=tabs-content], section[aria-label=Perry]") ?? document.querySelector("main") ?? document.body;
    for (const el of root.querySelectorAll("*")) {
      if (el.closest(keep)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 28 || r.height < 20) continue;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none" && !clear(s["border" + side + "Color"])).length;
      const fill = !clear(s.backgroundColor) && s.backgroundColor !== page && el !== root;
      const dashed = ["Top", "Right", "Bottom", "Left"].some((side) => s["border" + side + "Style"] === "dashed" && parseFloat(s["border" + side + "Width"]) > 0);
      if (sides >= 3 || fill || dashed) found.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 90), text: el.innerText.trim().slice(0, 40), sides, fill: fill ? s.backgroundColor : null, dashed });
    }
    const pills = [...document.querySelectorAll("main [data-pill], section[aria-label=Perry] [data-pill]")].map((el) => ({ text: el.innerText.trim(), tone: el.dataset.status, pulse: Boolean(el.querySelector("[class*=animate-pulse]")) }));
    return { boxes: found, pills };
  })()`;
  /** Primary buttons greyed out (disabled, or faded) on the page at rest. */
  const GREYED = `(() => {
    const probe = document.createElement("div"); probe.className = "bg-primary"; document.body.append(probe);
    const primary = getComputedStyle(probe).backgroundColor; probe.remove();
    return [...document.querySelectorAll("button, a[data-slot=button]")].filter((b) => b.offsetParent && getComputedStyle(b).backgroundColor === primary
      && (b.disabled || b.getAttribute("aria-disabled") === "true" || Number(getComputedStyle(b).opacity) < 1)).map((b) => b.getAttribute("aria-label") || b.innerText.trim());
  })()`;
  const boxesFound: Record<string, unknown> = {};
  const badPills: Record<string, unknown> = {};
  const greyed: Record<string, unknown> = {};
  /** Measure a screen at rest: boxes, pills that should not be, and greyed-out primary buttons. */
  const measure = async (screen: string) => {
    if (BEFORE) return;
    await evaluate(`document.activeElement?.blur?.(); true`);
    const found = await evaluate(BOXES) as { boxes: unknown[]; pills: Array<{ text: string; tone: string; pulse: boolean }> };
    if (found.boxes.length) boxesFound[screen] = found.boxes;
    const wrong = found.pills.filter((pill) => !pill.pulse && pill.tone !== "warning" && pill.tone !== "danger");
    if (wrong.length) badPills[screen] = wrong;
    const grey = await evaluate(GREYED) as string[];
    if (grey.length) greyed[screen] = grey;
  };
  /** A row, by words in it, has no pill. */
  const noPillIn = (row: string) => evaluate(`(() => { const el = ${row}; return el ? !el.querySelector("[data-pill]") : null; })()`) as Promise<boolean | null>;

  for (const mode of ["light", "dark"] as const) {
    theme = mode;
    await scheme(mode);
    await size(1280, 800);

    // --- Chat: the failed reply's Alert, and the reply with its memory links -------------------
    await go(`/chat/${receiptsChat}`, "couldn't finish the last reply");
    await shot("chat-alert", false);
    await measure(`chat-${mode}`);
    await go(`/chat/${planChat}`, "Call Sam about Saturday");
    await shot("chat-reply", false);
    await measure(`chat-reply-${mode}`);
    await collectErrors(`chat-${mode}`);

    // --- Settings, each tab ----------------------------------------------------------------------
    for (const [tab, words] of [["general", "Quiet hours"], ["usage", "Your plans"], ["keys", "Logins and secrets"], ["people", "Talks with Perry"], ["shortcuts", "Keyboard shortcuts"], ["telegram", "Telegram"], ["whatsapp", "A separate number"]] as const) {
      await go(`/settings${tab === "general" ? "" : `?tab=${tab}`}`, words);
      await shot(`settings-${tab}`);
      await measure(`settings-${tab}-${mode}`);
      if (!BEFORE && mode === "light" && tab === "general") {
        check("healthyEngineHasNoPill", (await noPillIn(`document.querySelector('[aria-label^="Codex on"]')`)) === true);
      }
      if (!BEFORE && mode === "light" && tab === "keys") {
        check("setLoginRowsHaveNoPill", (await evaluate(`![...document.querySelectorAll('main [data-pill]')].some((p) => /Set|Not set/.test(p.innerText))`)) === true);
      }
      await collectErrors(`settings-${tab}-${mode}`);
    }

    // --- Memory, both tabs ---------------------------------------------------------------------------
    await go("/memory", "coffee black");
    await shot("memory");
    await measure(`memory-${mode}`);
    await go("/memory?tab=about", "USER.md");
    await shot("memory-about");
    await measure(`memory-about-${mode}`);
    await collectErrors(`memory-${mode}`);

    // --- Project ------------------------------------------------------------------------------------------
    await go(`/projects/${project}`, "matte green");
    await shot("project");
    await measure(`project-${mode}`);
    await collectErrors(`project-${mode}`);

    // --- Work, its tabs -----------------------------------------------------------------------------------
    await go("/work", "Morning briefing");
    await shot("work");
    await measure(`work-${mode}`);
    if (!BEFORE && mode === "light") {
      check("runningScheduleHasNoPill", (await noPillIn(byText("main li", "Morning briefing"))) === true);
      const counts = await evaluate(`[...document.querySelectorAll("[role=tab]")].some((tab) => [...tab.querySelectorAll("span")].some((s) => getComputedStyle(s).borderRadius !== "0px" && getComputedStyle(s).backgroundColor !== "rgba(0, 0, 0, 0)"))`);
      check("tabCountsArePlain", counts === false, counts);
    }
    for (const [tab, words] of [["plans", "Compare three flats"], ["goals", "half marathon"], ["watches", "Headphones"]] as const) {
      await go(`/work?tab=${tab}`, words).catch(() => {});
      await shot(`work-${tab}`);
      await measure(`work-${tab}-${mode}`);
      if (!BEFORE && mode === "light" && tab === "watches") check("watchedPageHasNoPill", (await noPillIn(byText("main li", "Headphones"))) === true);
      if (!BEFORE && mode === "light" && tab === "plans") {
        const question = await evaluate(`(() => { const row = ${byText("main li", "Compare three flats")}; if (!row) return null; const label = [...row.querySelectorAll("span")].find((s) => s.innerText.includes("Needs you")); const box = label?.closest("div"); return { label: Boolean(label), fill: box ? getComputedStyle(box).backgroundColor : null, answer: Boolean(row.querySelector('input[aria-label^="Answer for"]')), button: [...row.querySelectorAll("button")].some((b) => b.innerText.trim() === "Answer") }; })()`);
        check("taskQuestionIsALabelAndAnInlineForm", Boolean(question && (question as { label: boolean }).label && /rgba\(0, 0, 0, 0\)/.test(String((question as { fill: string }).fill)) && !(question as { button: boolean }).button), question);
      }
    }
    await collectErrors(`work-${mode}`);

    // --- To-dos -------------------------------------------------------------------------------------------
    await go("/todos", "Water the plants");
    await shot("todos");
    await measure(`todos-${mode}`);
    await collectErrors(`todos-${mode}`);

    // --- Activity, a run open ---------------------------------------------------------------------------
    await go("/activity", "Export last year's receipts");
    await click(byText("[data-slot=collapsible-trigger]", "Plan my week"));
    await waitFor(`document.body.innerText.includes("Get-Content calendar.ics")`, "the trace", 15).catch(() => {});
    await sleep(400);
    await shot("activity");
    await measure(`activity-${mode}`);
    if (!BEFORE && mode === "light") {
      check("completedRunHasNoPill", (await noPillIn(byText("main li", "Plan my week"))) === true);
      const open = await evaluate(`(() => { const row = ${byText("main li", "Plan my week")}; const panel = row.querySelector("[data-slot=collapsible-panel], [data-slot=collapsible-content]") ?? row.lastElementChild; const tools = row.querySelector("[data-tools]"); return { fill: getComputedStyle(panel.firstElementChild ?? panel).backgroundColor, tools: tools?.innerText ?? null, chips: row.querySelectorAll("code.rounded-md").length }; })()`) as { fill: string; tools: string | null; chips: number };
      check("expandedRunIsUnboxed", /rgba\(0, 0, 0, 0\)/.test(open.fill) && open.chips === 0 && open.tools !== null, open);
      const stats = await evaluate(`(() => { const dl = document.querySelector('dl[aria-label=Summary]'); const s = getComputedStyle(dl); return { border: s.borderTopWidth, fill: s.backgroundColor }; })()`) as { border: string; fill: string };
      check("summaryIsAPlainRow", stats.border === "0px" && /rgba\(0, 0, 0, 0\)/.test(stats.fill), stats);
    }
    await collectErrors(`activity-${mode}`);

    // --- Needs you, Computer, Skills -------------------------------------------------------------------
    await go("/inbox", "build-cache");
    await shot("inbox");
    await measure(`inbox-${mode}`);
    await go("/computer", "Recent requests");
    await shot("computer");
    await measure(`computer-${mode}`);
    if (!BEFORE && mode === "light") check("onlineComputerHasNoPill", (await noPillIn(`document.querySelector('ul[aria-label=Computers] li')`)) === true);
    await go("/skills", "weekly-review");
    await shot("skills");
    await measure(`skills-${mode}`);
    await collectErrors(`others-${mode}`);

    // --- Empty states: a project with nothing in it -----------------------------------------------------
    if (!BEFORE && mode === "light") {
      const empty = await call<string>("projects:create", { key: KEY, name: "Garden" });
      await go(`/projects/${empty}`, "No chats yet");
      const dashed = await evaluate(`[...document.querySelectorAll("main *")].filter((el) => getComputedStyle(el).borderTopStyle === "dashed" && el.getBoundingClientRect().width > 28).length`);
      const emptyBoxes = await evaluate(`[...document.querySelectorAll("[data-empty]")].map((el) => { const s = getComputedStyle(el); return s.borderTopWidth + " " + s.backgroundColor; })`) as string[];
      check("emptyStatesAreUnboxed", dashed === 0 && emptyBoxes.length >= 2 && emptyBoxes.every((item) => /^0px rgba\(0, 0, 0, 0\)$/.test(item)), { dashed, emptyBoxes });
      await shot("project-empty");
      await call("projects:remove", { key: KEY, id: empty });
    }

    // --- The pet's page, at his window's size ----------------------------------------------------------
    await size(404, 620);
    await evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(planChat)}); true`);
    await send("Page.navigate", { url: `${BASE}/pet#key=${encodeURIComponent(KEY)}` });
    await waitFor(`document.querySelector('button[aria-label^="Perry."]')`, "the pet", 30);
    await sleep(800);
    if (!(await evaluate(`Boolean(document.querySelector('section[aria-label="Perry"]'))`))) {
      await click(`document.querySelector('button[aria-label^="Perry."]')`);
      await waitFor(`document.querySelector('section[aria-label="Perry"]')`, "his panel");
      await sleep(600);
    }
    await waitFor(`document.querySelector('section[aria-label="Perry"]').innerText.includes("Call Sam about Saturday")`, "his chat", 15).catch(() => {});
    await shot("pet-chat", false);
    await measure(`pet-chat-${mode}`);
    await click(byText("[role=tab]", "Needs you"));
    await waitFor(`document.querySelector('section[aria-label="Perry"]').innerText.includes("build-cache")`, "what needs you", 15).catch(() => {});
    await sleep(400);
    await shot("pet-needs", false);
    await measure(`pet-needs-${mode}`);
    await click(byText("[role=tab]", "Chat"));
    await collectErrors(`pet-${mode}`);
  }

  if (!BEFORE) {
    theme = "light";
    await scheme("light");
    await size(1280, 800);

    // --- Autosave: project instructions, and the way out right after typing ------------------------
    await go(`/projects/${project}`, "matte green");
    const instructions = `document.querySelector("#project-instructions")`;
    const projectInstructions = async () => (await call<{ instructions: string }>("projects:get", { key: KEY, id: project })).instructions;
    await focus(instructions);
    await typeText("Warm, plain words. Quote prices in euros.");
    const saved = await soon(async () => (await projectInstructions()) === "Warm, plain words. Quote prices in euros.", 6);
    const shown = await status(`${instructions}.closest("[data-slot=field]").querySelector("[data-save]")`);
    check("instructionsSaveThemselves", saved && shown?.state === "saved" && shown.text === "Saved" && (await buttonsNamed("Save")) === 0, { saved, shown, value: await projectInstructions() });
    await shot("autosave-saved");
    // Typed, then away by a link at once, well inside the pause.
    await focus(instructions);
    await typeText(" Never more than 200 words.");
    await click(`document.querySelector('[data-sidebar] a[href="/todos"], a[href="/todos"]')`);
    const kept = await soon(async () => (await projectInstructions()).endsWith("Never more than 200 words."), 6);
    check("leavingRightAfterTypingKeepsTheWords", kept, await projectInstructions());
    // Closing the tab while a save is still to go: the page asks, and the save goes.
    await go(`/projects/${project}`, "matte green");
    await focus(instructions);
    await typeText(" Sign off as Perry.");
    const asked = await evaluate(`(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })()`);
    const went = await soon(async () => (await projectInstructions()).endsWith("Sign off as Perry."), 6);
    check("closingTheTabAsksAndSaves", asked === true && went, { asked, went });
    // A save the server never gets: the words stay, the status says so, and Try again saves them.
    await evaluate(`(() => { const real = window.fetch; window.__failSave = true; window.fetch = (url, init) => window.__failSave && String(init?.body ?? "").includes("projects:setInstructions") ? Promise.reject(new TypeError("Failed to fetch")) : real(url, init); return true; })()`);
    await focus(instructions);
    await typeText(" No emoji.");
    await evaluate(`document.activeElement.blur(); true`);
    await sleep(1500);
    const failed = await status(`${instructions}.closest("[data-slot=field]").querySelector("[data-save]")`);
    const stillThere = await evaluate(`${instructions}.value.endsWith("No emoji.")`);
    const notSaved = !(await projectInstructions()).endsWith("No emoji.");
    await shot("autosave-failed");
    await evaluate(`window.__failSave = false; true`);
    await click(byText("[data-save] button", "Try again"));
    const retried = await soon(async () => (await projectInstructions()).endsWith("No emoji."), 6);
    const after = await status(`${instructions}.closest("[data-slot=field]").querySelector("[data-save]")`);
    check("failedSaveSaysSoAndRetries", failed?.state === "error" && /Couldn't save/.test(failed.text) && /Try again/.test(failed.text) && stillThere === true && notSaved && retried && after?.state === "saved", { failed, stillThere, notSaved, retried, after });
    await collectErrors("autosave-project");

    // --- Autosave: name, personality and USER.md, and USER.md's history -------------------------------
    await go("/memory?tab=about", "USER.md");
    const persona = () => call<Persona>("dashboard:getPersona", { key: KEY });
    await focus(`document.querySelector("#identity-personality")`);
    await typeText("Dry wit, straight talk.");
    await press("Tab");
    const personality = await soon(async () => (await persona()).personality === "Dry wit, straight talk.", 6);
    await focus(`document.querySelector("#identity-name")`);
    await evaluate(`document.querySelector("#identity-name").select(); true`);
    await typeText("Pip");
    const named = await soon(async () => (await persona()).name === "Pip", 6);
    const identityStatus = await status(`document.querySelector("#identity-personality").closest("section").querySelector("[data-save]")`);
    check("nameAndPersonalitySaveThemselves", personality && named && identityStatus?.text === "Saved" && (await buttonsNamed("Save")) === 0, { personality, named, identityStatus, persona: await persona() });
    const before = (await call<unknown[]>("dashboard:personaHistory", { key: KEY, kind: "user" })).length;
    await click(byText("main button", "Write it"));
    await waitFor(`document.querySelector("#user-md")`, "the USER.md editor");
    await typeText("# About Sam\n\nWorks on design systems.");
    await soon(async () => (await persona()).user.includes("design systems"), 6);
    await typeText("\n\nGym before work, weekdays.");
    await soon(async () => (await persona()).user.includes("Gym before work"), 6);
    await typeText("\n\nCall him Sam.");
    const userSaved = await soon(async () => (await persona()).user.endsWith("Call him Sam."), 6);
    const userStatus = await status(`document.querySelector("#user-md").closest("section").querySelector("[data-save]")`);
    const versions = (await call<unknown[]>("dashboard:personaHistory", { key: KEY, kind: "user" })).length;
    await shot("autosave-user-md");
    check("userMdSavesItselfAsOneVersion", userSaved && userStatus?.text === "Saved" && versions === before + 1 && (await buttonsNamed("Save")) === 0, { userSaved, userStatus, before, versions });
    await press("Escape");
    const reading = await soon(() => evaluate(`!document.querySelector("#user-md") && document.querySelector('article[aria-label="USER.md"]')?.innerText.includes("Call him Sam.")`), 4);
    check("escapeLeavesTheEditorSaved", reading);
    await collectErrors("autosave-about");

    // --- Autosave: a person's brief -----------------------------------------------------------------
    await go("/settings?tab=people", "Talks with Perry");
    await click(byText("main li button", "Brief"));
    await waitFor(`document.querySelector('textarea[aria-label^="What Perry may share with Datta"]')`, "the brief");
    await typeText("He can know my gym times.");
    const brief = async () => (await call<Array<{ name: string; brief?: string }>>("contacts:listForDashboard", { key: KEY })).find((person) => person.name === "Datta")?.brief;
    const briefed = await soon(async () => (await brief()) === "He can know my gym times.", 6);
    const briefStatus = await status(`document.querySelector('textarea[aria-label^="What Perry may share with Datta"]').parentElement.querySelector("[data-save]")`);
    await shot("autosave-brief");
    check("briefSavesItself", briefed && briefStatus?.text === "Saved" && (await buttonsNamed("Save")) === 0, { briefed, briefStatus });
    await collectErrors("autosave-brief");

    // --- Secrets: never half typed; Enter, or the quiet Save inside the field --------------------------
    await go("/settings?tab=keys", "Logins and secrets");
    const gemini = async () => (await call<Array<{ name: string; set: boolean; preview?: string; source: string }>>("dashboard:getKeys", { key: KEY })).find((entry) => entry.name === "GEMINI_API_KEY");
    const field = `document.querySelector("#key-GEMINI_API_KEY")`;
    const inField = (words: string) => evaluate(`[...${field}.closest("[data-slot=input-group]").querySelectorAll("button")].some((b) => b.innerText.trim() === ${JSON.stringify(words)})`);
    const atRest = await inField("Save");
    await focus(field);
    await typeText("AIza-e2e-half");
    await sleep(2500);
    const half = await gemini();
    const offered = await inField("Save");
    await shot("secret-typed");
    await typeText("-and-the-rest-7Q2x");
    await press("Enter");
    const byEnter = await soon(async () => (await gemini())?.source === "dashboard", 6);
    const afterEnter = await gemini();
    const cleared = await evaluate(`${field}.value === ""`);
    await focus(field);
    await typeText("AIza-e2e-second-key-9Kd3");
    await click(`[...${field}.closest("[data-slot=input-group]").querySelectorAll("button")].find((b) => b.innerText.trim() === "Save")`);
    const byClick = await soon(async () => (await gemini())?.preview?.includes("9Kd3"), 6);
    check("secretsSaveOnlyWhenAsked", atRest === false && half?.source !== "dashboard" && offered === true && byEnter && Boolean(afterEnter?.preview?.includes("7Q2x")) && cleared === true && byClick,
      { atRest, half, offered, byEnter, afterEnter, cleared, byClick });

    // --- Add login: named for what it does, there only with something to add, and Enter adds ----------
    const vault = () => call<Array<{ label: string; username?: string }>>("dashboard:getVault", { key: KEY });
    await focus(`document.querySelector("#login-label")`);
    await typeText("Spotify");
    const withName = await buttonsNamed("Add login");
    await focus(`document.querySelector("#login-value")`);
    await typeText("e2e-spotify-secret");
    const withSecret = await buttonsNamed("Add login");
    await press("Enter");
    const added = await soon(async () => (await vault()).some((login) => login.label === "Spotify"), 6);
    check("addLoginByEnter", withName === 0 && withSecret === 1 && added && (await buttonsNamed("Save")) === 0, { withName, withSecret, added });
    await collectErrors("secrets");

    // --- Memory: Remember, and editing in place with Enter and Esc --------------------------------------
    await go("/memory", "coffee black");
    const memories = () => call<Array<{ id: string; text: string }>>("dashboard:listMemories", { key: KEY, query: "" });
    const empty = await buttonsNamed("Remember");
    await focus(`document.querySelector("#memory-text")`);
    await typeText("Sam's dentist is Dr. Rao on Linking Road.");
    const offeredRemember = await buttonsNamed("Remember");
    await press("Enter");
    const remembered = await soon(async () => (await memories()).some((memory) => memory.text === "Sam's dentist is Dr. Rao on Linking Road."), 6);
    check("rememberByEnter", empty === 0 && offeredRemember === 1 && remembered, { empty, offeredRemember, remembered });
    const row = byText("main li", "trains to flights");
    await click(`[...${row}.querySelectorAll("button")].find((b) => b.innerText.trim() === "Edit")`);
    await waitFor(`document.querySelector('textarea[id^="memory-edit-"]')`, "the memory editor");
    const editButtons = await evaluate(`[...document.querySelector('textarea[id^="memory-edit-"]').closest("form").querySelectorAll("button")].map((b) => ({ text: b.innerText.trim(), fill: getComputedStyle(b).backgroundColor }))`) as Array<{ text: string; fill: string }>;
    await typeText(" Even overnight.");
    await press("Enter");
    const edited = await soon(async () => (await memories()).some((memory) => memory.text.endsWith("under six hours. Even overnight.")), 6);
    await click(`[...${byText("main li", "Even overnight")}.querySelectorAll("button")].find((b) => b.innerText.trim() === "Edit")`);
    await waitFor(`document.querySelector('textarea[id^="memory-edit-"]')`, "the memory editor again");
    await typeText(" NOT THIS.");
    await press("Escape");
    await sleep(800);
    const escaped = await evaluate(`!document.querySelector('textarea[id^="memory-edit-"]')`);
    const unchanged = !(await memories()).some((memory) => memory.text.includes("NOT THIS"));
    check("editMemoryEnterAndEscape", edited && escaped === true && unchanged && editButtons.length >= 2 && editButtons.every((button) => /rgba\(0, 0, 0, 0\)/.test(button.fill)), { edited, escaped, unchanged, editButtons });
    await collectErrors("memory-edit");

    check("noBoxes", Object.keys(boxesFound).length === 0, boxesFound);
    check("onlyPillsThatWantALook", Object.keys(badPills).length === 0, badPills);
    check("noGreyedPrimaryButtons", Object.keys(greyed).length === 0, greyed);
    const exceptions = browser.errors;
    check("nothingThrows", exceptions.length === 0 && errors.length === 0, { exceptions, consoleErrors: errors });
  }
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
  console.error(error);
  if (browser) await browser.send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(OUT, `failure${BEFORE ? "-before" : ""}.png`), Buffer.from(image.data, "base64"))).catch(() => {});
} finally {
  if (heartbeat) clearInterval(heartbeat);
  browser?.close();
  if (process.platform === "win32" && server.pid) spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill();
  await sleep(1500);
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

if (!BEFORE) {
  const pass = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
  const result = { ranAt: new Date().toISOString(), pass, checks, notes, serverLog: pass ? undefined : log.slice(-4000) };
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}
process.exit(0);
