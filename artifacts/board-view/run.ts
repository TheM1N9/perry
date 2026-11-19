import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChat, sleep } from "../browser";

// pnpm build, then: bun artifacts/board-view/run.ts [outDir]   (outDir defaults to artifacts/board-view)
// Issue #363, the Board: a production build on a free port with a fresh PERRY_HOME in a temp folder, two stand-in
// computers ("PC" with Codex, "Mac" with Claude Code) that answer through the runner's own endpoints (claim, trace,
// finish), and headless Chrome at desktop and phone widths. Nothing touches an installed Perry. Deleted at the end,
// except result.json and the screenshots.
//
// Ways it could fail, written down before the checks:
//   1. A background task queued while the Board is open never shows, or only after a reload.
//   2. The thread shows no holder, or the wrong one: not the engine, model and computer that claimed its turn.
//   3. Steps, updates, files and links the turn reports do not reach the open thread while it runs.
//   4. A finished task does not end in its result, or keeps saying it is working.
//   5. A failed schedule reads as fine, or hides the step it failed on and its error.
//   6. Something waiting on the owner (an approval, a task's question) is missing from "Waiting on you", or links
//      nowhere useful.
//   7. Channels mislabel work: a task under Chats, a project's work missing from its project.
//   8. The activity rail misses events, or its filters do not narrow it.
//   9. On a 390 px phone it overflows sideways, or the thread and activity cannot be reached.
//  10. Anything throws in the browser.

const REPO = resolve(import.meta.dirname, "../..");
const OUT = resolve(process.argv[2] ?? join(REPO, "artifacts", "board-view"));
mkdirSync(OUT, { recursive: true });
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "board-view-e2e-key";
const PC = "board-e2e-pc-token";
const MAC = "board-e2e-mac-token";
const home = mkdtempSync(join(tmpdir(), "perry-board-e2e-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail?: unknown) {
  checks[name] = ok;
  if (!ok && detail !== undefined) notes[name] = detail;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex", PERRY_WAKE_DISABLED: "1" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("NEXT_PUBLIC_CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log = (log + chunk).slice(-20_000); });
server.stderr?.on("data", (chunk: Buffer) => { log = (log + chunk).slice(-20_000); });

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

// --- The stand-in computers --------------------------------------------------------------------
type Turn = { _id: string; conversationId: string; prompt: string };
type Span = { callId: string; kind: string; name: string; status: "running" | "ok" | "error" | "declined"; startedAt: number; durationMs?: number; endedAt?: number; input?: string; output?: string };
const running = new Set<string>();
const checkIn = async () => {
  await runner("runner:checkIn", { token: PC, platform: "win32", hostname: "PC", activeTurnIds: [...running] });
  await runner("runner:checkIn", { token: MAC, platform: "darwin", hostname: "Mac", activeTurnIds: [] });
};
const model = (id: string, name: string) => ({ id, name, isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" });
let beating: ReturnType<typeof setInterval> | undefined;
/** Turns the test did not ask for (the heartbeat, a chat's name) are answered quietly, as an idle engine would. */
const handled = new Set<string>();
async function nextTurn(want: (turn: Turn) => boolean | Promise<boolean>, what: string, seconds = 60): Promise<Turn> {
  return until(async () => {
    const queued = await runner<Turn[]>("codex:queuedTurns", { token: PC });
    for (const turn of queued) {
      if (handled.has(turn._id)) continue;
      if (await want(turn)) { handled.add(turn._id); return turn; }
    }
    for (const turn of queued) {
      if (handled.has(turn._id)) continue;
      handled.add(turn._id);
      if (await claim(turn)) await finish(turn, { response: "NOTHING" });
    }
    return undefined;
  }, what, seconds);
}
async function claim(turn: Turn) {
  const claimed = await runner<object | null>("codex:claimTurn", { token: PC, id: turn._id });
  if (claimed) running.add(turn._id);
  return claimed;
}
const traced = new Map<string, Span[]>();
async function trace(turn: Turn, ...spans: Span[]) {
  const all = traced.get(turn._id) ?? [];
  for (const span of spans) { const at = all.findIndex((item) => item.callId === span.callId); if (at >= 0) all[at] = span; else all.push(span); }
  traced.set(turn._id, all);
  await runner("codex:traceTurn", { token: PC, id: turn._id, spans: all, steps: all.length });
}
async function finish(turn: Turn, end: { response?: string; error?: string }) {
  await runner("codex:finishTurn", { token: PC, id: turn._id, model: "gpt-5.5", ...end });
  running.delete(turn._id);
}
const step = (callId: string, kind: string, name: string, status: Span["status"], startedAt: number, extra: Partial<Span> = {}): Span =>
  ({ callId, kind, name, status, startedAt, ...(status !== "running" ? { durationMs: extra.durationMs ?? 1200, endedAt: startedAt + (extra.durationMs ?? 1200) } : {}), ...extra });

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("installation:setOnboarding", { state: "done" });
  await call("installation:setDefaultEngine", { engine: "codex" });
  await call("runner:createToken", { name: "PC", token: PC });
  await call("runner:createToken", { name: "Mac", token: MAC });
  await runner("engines:report", { token: PC, engines: [{ kind: "codex", installed: true, signedIn: true, auth: { type: "chatgpt", plan: "pro" }, models: [model("gpt-5.5", "GPT-5.5")] }] });
  await runner("engines:report", { token: MAC, engines: [{ kind: "claude", installed: true, signedIn: true, auth: { type: "subscription", plan: "max" }, models: [model("claude-opus-4-7", "Claude Opus 4.7")] }] });
  await checkIn();
  beating = setInterval(() => void checkIn().catch(() => {}), 10_000);

  // --- Fixture: a project chat whose turn is going on and waiting on an approval -------------------
  const project = await pub<string>("projects:create", { name: "Channel Desk" });
  const projectChat = await pub<string>("dashboard:createChat");
  await pub("projects:moveChat", { id: projectChat, projectId: project });
  await pub("dashboard:renameChat", { id: projectChat, title: "Next Channel Desk script" });
  await pub("dashboard:sendChat", { id: projectChat, text: "Draft the script for next week's Channel Desk video from the notes in the scripts folder, then render a rough cut." });
  const scriptTurn = await nextTurn((turn) => turn.conversationId === projectChat, "the project chat's turn");
  await claim(scriptTurn);
  const t0 = Date.now() - 95_000;
  await trace(scriptTurn,
    step("s1", "mcpToolCall", "brain_search", "ok", t0, { input: JSON.stringify({ query: "Channel Desk script notes" }) }),
    step("s2", "command", "ls scripts", "ok", t0 + 4_000, { output: "week-46.md\nweek-47-notes.md" }),
    step("s3", "commentary", "commentary", "ok", t0 + 9_000, { output: "Read the notes for week 47. Drafting the script around the three viewer questions." }),
    step("s4", "fileChange", "C:/Users/sam/channel-desk/scripts/week-47.md", "ok", t0 + 20_000, { input: "+ # Week 47\n+ Three questions from viewers" }),
    step("s5", "command", "pnpm motionclip render week-47 --draft", "running", t0 + 60_000));
  const approval = await runner<{ id: string }>("approvals:request", { token: PC, kind: "command", title: "pnpm motionclip render week-47 --draft", cwd: "C:/Users/sam/channel-desk", conversationId: projectChat });

  // --- Fixture: a schedule whose run fails on a step ----------------------------------------------
  const job = await call<{ id: string }>("jobs:create", { name: "Weekly invoices", schedule: "0 9 * * 1", prompt: "Download last week's invoices from the bank and file them in Documents/Invoices." });
  await pub("jobs:runNow", { id: job.id });
  const jobChat = await until(async () => (await pub<{ jobs: Array<{ id: string; chatId?: string }> }>("jobs:listForDashboard")).jobs.find((item) => item.id === job.id)?.chatId, "the schedule's chat");
  const jobTurn = await nextTurn((turn) => turn.conversationId === jobChat, "the schedule's turn");
  await claim(jobTurn);
  const j0 = Date.now() - 40_000;
  await trace(jobTurn,
    step("j1", "mcpToolCall", "read_page", "ok", j0, { input: JSON.stringify({ url: "https://bank.example.com/statements" }) }),
    step("j2", "command", "bank-cli export --week last", "error", j0 + 8_000, { durationMs: 3_400, output: "Error: the export page asked for a one-time code" }));
  const jobError = "The bank's export page asked for a one-time code, and none was available.";
  await finish(jobTurn, { error: jobError });
  await until(async () => (await pub<{ jobs: Array<{ id: string; lastError?: string }> }>("jobs:listForDashboard")).jobs.find((item) => item.id === job.id)?.lastError, "the schedule to record its failure", 30);

  // --- Fixture: a task stopped on a question, a watch that fired, a chat turn that finished ---------
  const askTask = await pub<string>("tasks:queueFromDashboard", { title: "Book the Lisbon flights", prompt: "Find flights to Lisbon for Thursday morning and book the best one under €200." });
  const askChat = await until(async () => (await call<{ conversationId?: string } | null>("tasks:get", { id: askTask }))?.conversationId, "the question task's chat");
  const askTurn = await nextTurn((turn) => turn.conversationId === askChat, "the question task's turn");
  await claim(askTurn);
  await call("work:setPlan", { taskId: askTask, plan: [{ title: "Find flights for Thursday morning", status: "done" }, { title: "Pick one", status: "active" }, { title: "Pay and save the confirmation", status: "pending" }] });
  await trace(askTurn, step("a1", "webSearch", "Lisbon flights Thursday morning", "ok", Date.now() - 30_000));
  await call("work:updateTask", { taskId: askTask, status: "blocked", question: "The 07:10 is €40 cheaper but lands at 09:05. Take it, or the 10:30?" });
  await finish(askTurn, { response: "I need you to pick a flight." });

  const watch = await call<string>("work:createMonitor", { title: "Leica Q3 back in stock", url: "https://example.com/leica-q3", condition: "contains", value: "In stock", intervalMinutes: 60 });
  await call("work:recordCheck", { id: watch, observation: "The page now says: In stock, ships in 2 days.", fired: true, failed: false });

  const giftChat = await pub<string>("dashboard:createChat");
  await pub("dashboard:renameChat", { id: giftChat, title: "Gift ideas for Maya" });
  await pub("dashboard:sendChat", { id: giftChat, text: "Maya turns 30 next week. Three gift ideas under €100?" });
  const giftTurn = await nextTurn((turn) => turn.conversationId === giftChat, "the gift chat's turn");
  await claim(giftTurn);
  await trace(giftTurn, step("g1", "mcpToolCall", "recall", "ok", Date.now() - 6_000), step("g2", "commentary", "commentary", "ok", Date.now() - 2_000, { output: "A pottery class for two, a film camera, or the ceramics book she mentioned in March." }));
  await finish(giftTurn, { response: "A pottery class for two, a film camera, or the ceramics book she mentioned in March." });

  // --- The Board, open in a real browser ----------------------------------------------------------
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(BASE, KEY);
  const b = browser;
  const text = () => b.evaluate("document.body.innerText") as Promise<string>;
  const has = (needle: string) => `document.body.innerText.includes(${JSON.stringify(needle)})`;
  const waitFor = (expression: string, what: string, seconds = 20) => until(() => b.evaluate(`Boolean(${expression})`), what, seconds);
  const go = async (path: string) => { await b.send("Page.navigate", { url: `${BASE}${path}` }); await waitFor(`document.querySelector('h1')?.innerText === 'Board'`, `${path} to load`); };
  const scheme = (value: "light" | "dark") => b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  const viewport = (width: number, height: number, mobile = false) => b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const shot = async (name: string) => {
    await b.evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
    await sleep(450);
    const image = await b.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(OUT, name), Buffer.from(image.data, "base64"));
  };
  const clickLink = (selector: string, needle: string) => b.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.innerText.includes(${JSON.stringify(needle)})); if (!el) return false; el.click(); return true; })()`);
  const overflow = () => b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;

  await scheme("light");
  await viewport(1440, 900);
  await go("/board");
  await waitFor(has("Weekly invoices"), "the board's threads");

  // 6. Waiting on you: the approval and the question, each linked to where it is answered.
  const waiting = await b.evaluate(`[...document.querySelectorAll('[data-waiting-on-you] a')].map((a) => ({ text: a.innerText, href: a.getAttribute('href') }))`) as Array<{ text: string; href: string }>;
  check("waiting on you lists the pending approval, linked to its chat", waiting.some((item) => item.text.includes("pnpm motionclip render week-47 --draft") && item.href === `/chat/${projectChat}`), waiting);
  check("waiting on you lists the task's question, linked to its answer form", waiting.some((item) => item.text.includes("The 07:10 is €40 cheaper") && item.href === `/work?tab=plans#task-${askTask}`), waiting);
  const pending = await pub<Array<{ id: string }>>("approvals:pending");
  const blocked = (await pub<{ tasks: Array<{ status: string; question?: string }> }>("dashboard:getWork")).tasks.filter((task) => task.status === "blocked" && task.question);
  check("every item waiting on the owner is in the strip", waiting.length === pending.length + blocked.length, { strip: waiting.length, approvals: pending.length, questions: blocked.length });

  // 7. Channels: the project's channel holds its chat; Tasks holds tasks only.
  const channels = await b.evaluate(`[...document.querySelectorAll('nav[aria-label=Channels] a')].map((a) => a.innerText.replace(/\\s+/g, ' ').trim())`) as string[];
  check("channels are All, Chats, Tasks, Jobs, Heartbeat, Watches and the project", ["All", "Chats", "Tasks", "Jobs", "Heartbeat", "Watches", "Channel Desk"].every((name) => channels.some((label) => label.startsWith(name))), channels);
  await clickLink("nav[aria-label=Channels] a", "Channel Desk");
  await waitFor(`location.search.includes('channel=project')`, "the project channel");
  const projectThreads = await b.evaluate(`[...document.querySelectorAll('[data-threads] [data-thread]')].map((li) => li.innerText)`) as string[];
  check("the project's channel holds its chat's turn, waiting on the owner", projectThreads.length === 1 && projectThreads[0].includes("Next Channel Desk script") && projectThreads[0].includes("Needs you") && projectThreads[0].includes("PC"), projectThreads);
  await shot("board-project-desktop.png");

  // 1-4. A background task queued while the Board is open: it appears, is claimed, works live and finishes.
  await go("/board?channel=tasks");
  const queuedAt = Date.now();
  const liveTask = await pub<string>("tasks:queueFromDashboard", { title: "Compare three standing desks", prompt: "Compare three standing desks under €600 on stability, noise and warranty, and recommend one." });
  await waitFor(`document.querySelector('[data-thread="task:${liveTask}"]')`, "the new task's thread", 10);
  notes.appearedAfterMs = Date.now() - queuedAt;
  check("a queued background task appears on the open board within seconds", Date.now() - queuedAt < 5_000, notes.appearedAfterMs);
  await b.evaluate(`document.querySelector('[data-thread="task:${liveTask}"] a').click()`);
  await waitFor(`document.querySelector('[data-thread-view="task:${liveTask}"]')`, "the task's thread to open");
  const liveChat = await until(async () => (await call<{ conversationId?: string } | null>("tasks:get", { id: liveTask }))?.conversationId, "the live task's chat");
  const liveTurn = await nextTurn((turn) => turn.conversationId === liveChat, "the live task's turn");
  await claim(liveTurn);
  await waitFor(`document.querySelector('[data-thread-view] [data-holder]')?.innerText.includes('PC') && ${has("Working")}`, "the holder and Working to show", 10);
  const holder = await b.evaluate(`document.querySelector('[data-thread-view] [data-holder]').innerText`) as string;
  check("the thread shows who holds it: engine, model and computer", holder.includes("Codex") && holder.includes("PC"), holder);
  const l0 = Date.now();
  await call("work:setPlan", { taskId: liveTask, plan: [{ title: "Shortlist desks under €600", status: "active" }, { title: "Read the long-term reviews", status: "pending" }, { title: "Write up the trade-offs", status: "pending" }] });
  await trace(liveTurn, step("d1", "webSearch", "standing desk under 600 euro long-term review", "running", l0));
  await waitFor(has("Searching the web"), "the running step to show live", 10);
  check("a step the turn is on shows in the open thread as it runs", true);
  await shot("thread-live-desktop.png");
  await trace(liveTurn,
    step("d1", "webSearch", "standing desk under 600 euro long-term review", "ok", l0, { durationMs: 2_100 }),
    step("d2", "commentary", "commentary", "ok", l0 + 2_500, { output: "Shortlisted the Flexispot E7, the Fezibo Dual and the IKEA Trotten. Notes so far: https://example.com/desk-notes" }),
    step("d3", "fileChange", "C:/Users/sam/Documents/desks.md", "ok", l0 + 3_000, { input: "+ | Desk | Stability | Noise | Warranty |" }));
  await call("work:setPlan", { taskId: liveTask, plan: [{ title: "Shortlist desks under €600", status: "done" }, { title: "Read the long-term reviews", status: "done" }, { title: "Write up the trade-offs", status: "active" }] });
  await waitFor(`${has("Shortlisted the Flexispot E7")} && document.querySelector('[data-thread-view] a[href="https://example.com/desk-notes"]')`, "the update and its link to show live", 10);
  check("an update and its link reach the open thread without a reload", true);
  const files = await b.evaluate(`document.querySelector('[data-thread-view]').innerText`) as string;
  check("the file the turn changed is in the thread", /desks\.md|changed 1 file|Edited desks/i.test(files), files.slice(0, 800));
  await call("work:updateTask", { taskId: liveTask, status: "done", result: "Get the **Flexispot E7**: steadiest at full height, quietest motor, and a 5-year warranty. The table is in desks.md." });
  await finish(liveTurn, { response: "Done: the Flexispot E7." });
  await waitFor(`document.querySelector('[data-thread-view] [data-feed-result]') && ${has("Flexispot E7")} && !document.querySelector('[data-thread-view] [data-pill]')`, "the task to end in its result", 15);
  check("a finished task ends in its result and no longer says it is working", true);
  await shot("thread-done-desktop.png");

  // 5. The failed schedule: Failed, the step it failed on, and its error.
  await go(`/board?channel=jobs&thread=job:${job.id}`);
  await waitFor(`document.querySelector('[data-thread-view="job:${job.id}"] [data-feed-error]')`, "the failed schedule's thread");
  const failed = await b.evaluate(`document.querySelector('[data-thread-view]').innerText`) as string;
  const lastStep = await b.evaluate(`document.querySelector('[data-thread-view] [data-feed-error] [data-last-step]')?.innerText ?? ''`) as string;
  check("a failed schedule shows Failed, its last step and its error, without opening anything", failed.includes("Failed") && lastStep.includes("bank-cli export") && failed.includes(jobError), { lastStep, text: failed.slice(0, 1200) });
  // Its steps open to the step that failed, as in the chat.
  await waitFor(`document.querySelector('[data-thread-view] [data-tool-group] button')`, "the schedule's steps");
  await b.evaluate(`document.querySelector('[data-thread-view] [data-tool-group] button').click()`);
  await waitFor(`document.querySelector('[data-thread-view] [data-tool-group] [data-status=error]')`, "the failed step in its steps", 10);
  check("the schedule's steps open to the failed step", true);
  await shot("job-failed-desktop.png");

  // 8. The rail: every kind of event, and its filters narrow it.
  await go("/board");
  await waitFor(`document.querySelectorAll('aside [data-event]').length > 5`, "the activity rail");
  const verbs = await b.evaluate(`[...new Set([...document.querySelectorAll('aside [data-event]')].map((li) => li.dataset.event))]`) as string[];
  check("the rail shows claims, updates, questions, approvals, results and failures", ["started", "asked", "approval", "finished", "failed", "fired", "queued"].every((verb) => verbs.includes(verb)), verbs);
  await b.evaluate(`document.querySelector('aside [aria-label=Status]').click()`);
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((el) => el.innerText.trim() === 'Failed')`, "the status options");
  await b.evaluate(`[...document.querySelectorAll('[role=option]')].find((el) => el.innerText.trim() === 'Failed').click()`);
  await waitFor(`[...document.querySelectorAll('aside [data-event]')].every((li) => li.innerText.includes('Weekly invoices'))`, "the rail to narrow to failed work");
  check("the rail's status filter narrows it", true);
  const machines = await b.evaluate(`Boolean(document.querySelector('aside [aria-label=Computer]'))`) as boolean;
  check("the rail can be narrowed by computer when there are several", machines);
  await b.evaluate(`document.querySelector('aside [aria-label=Status]').click()`);
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((el) => el.innerText.trim() === 'Every status')`, "the status options");
  await b.evaluate(`[...document.querySelectorAll('[role=option]')].find((el) => el.innerText.trim() === 'Every status').click()`);
  await sleep(300);
  await b.evaluate(`window.scrollTo(0, 0)`);
  check("nothing overflows sideways at 1440 px", (await overflow()) <= 0, await overflow());
  await shot("board-desktop.png");
  await scheme("dark");
  await waitFor(`document.documentElement.classList.contains('dark')`, "the dark theme");
  await shot("board-dark-desktop.png");
  await scheme("light");
  await waitFor(`!document.documentElement.classList.contains('dark')`, "the light theme");

  // 9. A phone: the board, a thread and the activity, nothing sideways.
  await viewport(390, 844, true);
  await go("/board");
  await waitFor(has("Waiting on you"), "the phone board");
  check("nothing overflows sideways at 390 px (board)", (await overflow()) <= 0, await overflow());
  await shot("board-phone.png");
  await go(`/board?thread=task:${liveTask}`);
  await waitFor(`document.querySelector('[data-thread-view] [data-feed-result]')`, "the thread on a phone");
  check("nothing overflows sideways at 390 px (thread)", (await overflow()) <= 0, await overflow());
  check("on a phone an open thread has the screen to itself", await b.evaluate(`!document.querySelector('[data-waiting-on-you]')?.offsetParent && document.querySelector('[data-thread-view]').getBoundingClientRect().top < 200`) as boolean);
  await shot("thread-phone.png");
  await go("/board?view=activity");
  await waitFor(`[...document.querySelectorAll('[data-activity]')].some((el) => el.offsetParent && el.querySelector('[data-event]'))`, "the activity on a phone");
  check("nothing overflows sideways at 390 px (activity)", (await overflow()) <= 0, await overflow());
  await shot("activity-phone.png");

  // The approval answered elsewhere leaves the strip by itself.
  await pub("approvals:decide", { id: approval.id, approved: true });
  await go("/board");
  await waitFor(`!document.querySelector('[data-waiting-on-you]')?.innerText.includes('pnpm motionclip render')`, "the answered approval to leave the strip");
  check("an approval answered elsewhere leaves Waiting on you", true);

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
  if (server.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill("SIGKILL");
  }
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const passed = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean) && !notes.error;
writeFileSync(join(OUT, "result.json"), `${JSON.stringify({ passed, checkedAt: new Date().toISOString(), platform: process.platform, checks, notes }, null, 2)}\n`);
console.log(passed ? "PASS" : "FAIL");
process.exit(passed ? 0 : 1);
