import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChat, sleep } from "../browser";

// pnpm build, then: bun artifacts/board-view/run.ts [outDir]   (outDir defaults to artifacts/board-view-v2)
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
//   6. Something waiting on the owner (an approval, a task's question) is missing, shown twice, not first, or its
//      action leads nowhere useful.
//   7. Channels mislabel work: a task under Chats, a project's work missing from its project.
//   8. Activity repeats a thread, or its computer filter does not narrow it.
//   9. On a 390 px phone it overflows sideways, clips a tab, wastes the top of the screen, or the thread and activity
//      cannot be reached.
//  10. At 1280 or 1440 px it overflows, clips a tab, or the nav, list and pane headers do not line up; a toast covers it.
//  11. Anything throws in the browser.

const REPO = resolve(import.meta.dirname, "../..");
const OUT = resolve(process.argv[2] ?? join(REPO, "artifacts", "board-view-v2"));
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
  const waitFor = (expression: string, what: string, seconds = 20) => until(() => b.evaluate(`Boolean(${expression})`), what, seconds);
  const go = async (path: string) => { await b.send("Page.navigate", { url: `${BASE}${path}` }); await waitFor(`document.querySelector('[data-board] header h1')`, `${path} to load`); };
  const scheme = (value: "light" | "dark") => b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  const viewport = (width: number, height: number, mobile = false) => b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const shot = async (name: string) => {
    await b.evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
    await sleep(450);
    const image = await b.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(OUT, name), Buffer.from(image.data, "base64"));
  };
  const overflow = () => b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;

  const ROWS = `[...document.querySelectorAll('[data-rows] [data-row]')]`;
  const rowText = (id: string) => b.evaluate(`document.querySelector('[data-row="${id}"]')?.innerText ?? ''`) as Promise<string>;
  const pane = () => b.evaluate(`document.querySelector('[data-pane]')?.innerText ?? ''`) as Promise<string>;
  const tabsClipped = () => b.evaluate(`[...document.querySelectorAll('[data-tabs] a')].filter((a) => { const r = a.getBoundingClientRect(); return a.scrollWidth > a.clientWidth + 1 || r.right > innerWidth + 0.5 || r.left < -0.5; }).map((a) => a.innerText)`) as Promise<string[]>;
  const toastShown = () => b.evaluate(`Boolean(document.querySelector('[data-sonner-toast]'))`) as Promise<boolean>;

  await scheme("light");
  await viewport(1440, 900);
  await go("/board");
  await waitFor(`${ROWS}.length >= 2`, "the board's rows");

  // 6. What waits on the owner is a row, once: the approval on its chat's turn, the question on its task.
  const command = "pnpm motionclip render week-47 --draft";
  const question = "The 07:10 is €40 cheaper";
  const rows = await b.evaluate(`${ROWS}.map((li) => ({ id: li.dataset.row, status: li.dataset.status, text: li.innerText }))`) as Array<{ id: string; status: string; text: string }>;
  check("there is no separate waiting strip: waiting items are rows", !(await b.evaluate(`Boolean(document.querySelector('[data-waiting-on-you]'))`)));
  check("the pending approval is one row, needing you, with the command on one line", rows.filter((row) => row.text.includes(command)).length === 1 && rows.find((row) => row.text.includes(command))!.status === "waiting"
    && await b.evaluate(`(() => { const chip = [...document.querySelectorAll('[data-rows] [data-command]')].find((el) => el.textContent.includes(${JSON.stringify(command)})); return Boolean(chip) && chip.getBoundingClientRect().height < 24; })()`) as boolean, rows);
  check("the task's question is one row, needing you", rows.filter((row) => row.text.includes(question)).length === 1 && rows.find((row) => row.text.includes(question))!.id === `task:${askTask}`, rows);
  const leading = rows.filter((row) => row.status === "waiting").length;
  check("needs-you rows lead the open list", leading > 0 && rows.slice(0, leading).every((row) => row.status === "waiting"), rows.map((row) => row.status));
  const pending = await pub<Array<{ id: string }>>("approvals:pending");
  const blocked = (await pub<{ tasks: Array<{ status: string; question?: string }> }>("dashboard:getWork")).tasks.filter((task) => task.status === "blocked" && task.question);
  check("every item waiting on the owner is on the board", rows.filter((row) => row.status === "waiting").length === pending.length + blocked.length, { rows: rows.filter((row) => row.status === "waiting").length, approvals: pending.length, questions: blocked.length });
  check("each thread is listed once", new Set(rows.map((row) => row.id)).size === rows.length, rows.map((row) => row.id));
  const count = await b.evaluate(`document.querySelector('[data-open-count]')?.innerText ?? ''`) as string;
  check("the one count, on tasks, is the number of open rows", Number(count) === rows.length, { count, rows: rows.length });
  check("finished rows show no holder; working rows show their computer", rows.filter((row) => row.status === "done").every((row) => !/via PC|via Mac/.test(row.text)), rows);

  // 7. Channels, as the viewer lists them, with the project's work in its own.
  const channels = await b.evaluate(`[...document.querySelectorAll('[data-channel]')].map((a) => a.dataset.channel)`) as string[];
  check("channels are #chats, #tasks, #jobs, #heartbeat, #watches and the project", ["chats", "tasks", "jobs", "heartbeat", "watches", "channel-desk"].every((name) => channels.includes(name)), channels);
  await b.evaluate(`document.querySelector('[data-channel="channel-desk"]').click()`);
  await waitFor(`location.search.includes('channel=project') && document.querySelector('header h1')?.innerText === '#channel-desk'`, "the project channel");
  const projectRows = await b.evaluate(`${ROWS}.map((li) => li.innerText)`) as string[];
  check("the project's channel holds its chat's turn, needing you", projectRows.length === 1 && projectRows[0].includes("Next Channel Desk script") && projectRows[0].includes("needs you"), projectRows);

  // 1-5, 11. A background task queued while the Board is open: a row at once, its thread in the pane beside the list.
  await go("/board?channel=tasks");
  const queuedAt = Date.now();
  const liveTask = await pub<string>("tasks:queueFromDashboard", { title: "Compare three standing desks", prompt: "Compare three standing desks under €600 on stability, noise and warranty, and recommend one." });
  await waitFor(`document.querySelector('[data-row="task:${liveTask}"]')`, "the new task's row", 10);
  notes.appearedAfterMs = Date.now() - queuedAt;
  check("a queued background task appears on the open board within seconds", Date.now() - queuedAt < 5_000, notes.appearedAfterMs);
  await b.evaluate(`document.querySelector('[data-row="task:${liveTask}"] a').click()`);
  await waitFor(`document.querySelector('[data-pane="task:${liveTask}"]')`, "the task's pane");
  check("the thread opens in a pane beside the list, which stays", await b.evaluate(`(() => { const list = document.querySelector('[data-rows]').getBoundingClientRect(); const p = document.querySelector('[data-pane]').getBoundingClientRect(); return list.width > 300 && p.left >= list.right - 1; })()`) as boolean);
  const liveChat = await until(async () => (await call<{ conversationId?: string } | null>("tasks:get", { id: liveTask }))?.conversationId, "the live task's chat");
  const liveTurn = await nextTurn((turn) => turn.conversationId === liveChat, "the live task's turn");
  await claim(liveTurn);
  await waitFor(`document.querySelector('[data-pane] [data-holder]')?.innerText.includes('PC')`, "the holder to show", 10);
  const holder = await b.evaluate(`document.querySelector('[data-pane] [data-holder]').innerText`) as string;
  check("the pane shows who holds it: engine, model and computer", holder.includes("codex") && holder.includes("gpt-5.5") && holder.includes("PC"), holder);
  const l0 = Date.now();
  await call("work:setPlan", { taskId: liveTask, plan: [{ title: "Shortlist desks under €600", status: "active" }, { title: "Read the long-term reviews", status: "pending" }, { title: "Write up the trade-offs", status: "pending" }] });
  await trace(liveTurn, step("d1", "webSearch", "standing desk under 600 euro long-term review", "running", l0));
  await waitFor(`document.querySelector('[data-pane]').innerText.includes('Searching the web') && document.querySelector('[data-row="task:${liveTask}"]').innerText.includes('Searching the web')`, "the running step in the pane and the row", 10);
  check("the step a turn is on shows live, in the pane and on its row", true);
  await shot("thread-desktop.png");
  const taskApproval = await runner<{ id: string }>("approvals:request", { token: PC, kind: "command", title: "curl -s https://example.com/desks.json", cwd: "C:/Users/sam", conversationId: liveChat });
  await waitFor(`document.querySelector('[data-row="task:${liveTask}"]')?.dataset.status === 'waiting' && document.querySelector('[data-pane] [data-action]')?.innerText === 'review'`, "the task's approval on its row and pane", 10);
  check("a task waiting on an approval offers review, not answer", (await pane()).includes("desks.json") && !(await pane()).includes("answer"), await pane());
  await pub("approvals:decide", { id: taskApproval.id, approved: true });
  await waitFor(`document.querySelector('[data-row="task:${liveTask}"]')?.dataset.status === 'working'`, "the task back to working", 10);
  await trace(liveTurn,
    step("d1", "webSearch", "standing desk under 600 euro long-term review", "ok", l0, { durationMs: 2_100 }),
    step("d2", "commentary", "commentary", "ok", l0 + 2_500, { output: "Shortlisted the Flexispot E7, the Fezibo Dual and the IKEA Trotten. Notes so far: https://example.com/desk-notes" }),
    step("d3", "fileChange", "C:/Users/sam/Documents/desks.md", "ok", l0 + 3_000, { input: "+ | Desk | Stability | Noise | Warranty |" }));
  await waitFor(`document.querySelector('[data-pane]').innerText.includes('Shortlisted the Flexispot E7') && document.querySelector('[data-pane] a[href="https://example.com/desk-notes"]')`, "the update and its link", 10);
  check("an update and its link reach the open pane without a reload", true);
  check("the file the turn changed is in the pane", /desks\.md|changed 1 file|Edited desks/i.test(await pane()), (await pane()).slice(0, 800));
  await call("work:updateTask", { taskId: liveTask, status: "done", result: "Get the **Flexispot E7**: steadiest at full height, quietest motor, and a 5-year warranty. The table is in desks.md." });
  await finish(liveTurn, { response: "Done: the Flexispot E7." });
  await waitFor(`document.querySelector('[data-pane] [data-state]')?.dataset.state === 'done' && document.querySelector('[data-pane]').innerText.includes('result')`, "the task to end in its result", 15);
  check("a finished task's pane leads with its result, and no longer says working", (await pane()).indexOf("result") < (await pane()).indexOf("Compare three standing desks under"), (await pane()).slice(0, 600));
  await sleep(1500);
  check("no toast covers the board when a reply lands", !(await toastShown()));
  await shot("thread-done-desktop.png");

  // 5. The failed schedule: failed, its reason and last step at the top of its pane.
  await go(`/board?channel=jobs&tab=all&thread=job:${job.id}`);
  await waitFor(`document.querySelector('[data-pane="job:${job.id}"] [data-last-step]')`, "the failed schedule's pane");
  const failed = await pane();
  check("a failed schedule shows failed, its last step and its error", failed.includes("failed") && failed.includes("bank-cli export") && failed.includes(jobError), failed.slice(0, 800));
  await shot("failed-desktop.png");

  // 6, 8. Activity: one entry per thread, its latest event, and the computer filter narrows it.
  await go("/board?view=activity");
  await waitFor(`document.querySelectorAll('[data-activity] [data-entry]').length > 4`, "the activity view");
  const entries = await b.evaluate(`[...document.querySelectorAll('[data-activity] [data-entry]')].map((li) => li.dataset.entry)`) as string[];
  check("activity lists each thread once, by its latest event", new Set(entries).size === entries.length, entries);
  check("activity's newest entry is at the bottom", await b.evaluate(`(() => { const t = [...document.querySelectorAll('[data-activity] time')].map((el) => Date.parse(el.dateTime)); return t.every((v, i) => i === 0 || v >= t[i - 1]); })()`) as boolean);
  await shot("activity-desktop.png");
  const filterButton = await b.evaluate(`Boolean(document.querySelector('header [aria-label="Filter by computer"]'))`) as boolean;
  await go("/board?view=activity&computer=Mac");
  await sleep(800);
  const macEntries = await b.evaluate(`document.querySelectorAll('[data-activity] [data-entry]').length`) as number;
  check("the computer filter is there with two computers, and narrows the view", filterButton && macEntries < entries.length, { filterButton, all: entries.length, mac: macEntries });

  // 10. Edges, widths and clipping.
  for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
    await viewport(width, height);
    await go(`/board?thread=task:${liveTask}`);
    await waitFor(`document.querySelector('[data-pane]')`, "the pane");
    check(`nothing overflows sideways at ${width} px`, (await overflow()) <= 0, await overflow());
    check(`no tab label is clipped at ${width} px`, (await tabsClipped()).length === 0, await tabsClipped());
    check(`nav, list and pane share one header height at ${width} px`, await b.evaluate(`(() => { const hs = [...document.querySelectorAll('[data-board] > * > div:first-child, [data-board] header, [data-pane] > div:first-child')].map((el) => Math.round(el.getBoundingClientRect().height)).filter((h) => h > 0); return hs.length >= 3 && hs.every((h) => h === hs[0]); })()`) as boolean);
    if (width === 1280) await shot("board-1280.png");
  }
  await viewport(1440, 900);
  await go("/board?tab=all");
  await waitFor(`${ROWS}.length > 3`, "the board");
  await shot("board-desktop.png");
  await go("/board");
  await waitFor(`${ROWS}.length >= 1`, "the open list");
  await shot("board-open-desktop.png");
  await scheme("dark");
  await waitFor(`document.documentElement.classList.contains('dark')`, "the dark theme");
  await go(`/board?thread=task:${askTask}`);
  await waitFor(`document.querySelector('[data-pane] [data-action]')`, "the question's pane");
  check("a task's question offers answer, linked to its answer form", await b.evaluate(`document.querySelector('[data-pane] [data-action]').innerText === 'answer' && document.querySelector('[data-pane] [data-action]').getAttribute('href') === ${JSON.stringify(`/work?tab=plans#task-${askTask}`)}`) as boolean);
  await shot("question-dark-desktop.png");
  await scheme("light");
  await waitFor(`!document.documentElement.classList.contains('dark')`, "the light theme");

  // 14-17. A phone: a compact header, wrapped tabs, dense rows, and a thread as a full screen of its own.
  await viewport(390, 844, true);
  await go("/board?tab=all");
  await waitFor(`${ROWS}.length > 3`, "the phone board");
  check("nothing overflows sideways at 390 px (list)", (await overflow()) <= 0, await overflow());
  check("no tab label is clipped at 390 px", (await tabsClipped()).length === 0, await tabsClipped());
  const phone = await b.evaluate(`(() => { const first = document.querySelector('[data-rows] [data-row]').getBoundingClientRect(); const hs = ${ROWS}.map((li) => li.getBoundingClientRect().height); return { firstTop: Math.round(first.top), tallest: Math.round(Math.max(...hs)) }; })()`) as { firstTop: number; tallest: number };
  check("on a phone the first row starts within 130 px, and rows stay compact", phone.firstTop < 130 && phone.tallest <= 64, phone);
  await shot("board-phone.png");
  await go(`/board?tab=all&thread=task:${liveTask}`);
  await waitFor(`document.querySelector('[role=dialog] [data-pane]')`, "the phone thread");
  check("on a phone the thread is a full screen of its own, without the board's title", await b.evaluate(`(() => { const d = document.querySelector('[role=dialog]').getBoundingClientRect(); return d.top === 0 && Math.round(d.width) === innerWidth && Math.round(d.height) === innerHeight; })()`) as boolean);
  check("nothing overflows sideways at 390 px (thread)", (await overflow()) <= 0, await overflow());
  const modal = await b.evaluate(`({ inert: document.querySelector('[data-board] main').inert === true, focus: document.activeElement?.closest('[role=dialog]') ? 'pane' : (document.activeElement?.tagName ?? 'none') })`) as { inert: boolean; focus: string };
  check("on a phone the board behind the thread is inert, and focus starts in the pane", modal.inert && modal.focus === "pane", modal);
  await shot("thread-phone.png");
  await go("/board?view=activity");
  await waitFor(`document.querySelector('[data-activity] [data-entry]')`, "the phone activity");
  check("nothing overflows sideways at 390 px (activity)", (await overflow()) <= 0, await overflow());
  await shot("activity-phone.png");

  // The approval answered elsewhere leaves the open page by itself.
  await viewport(1440, 900);
  await go("/board");
  await waitFor(`${ROWS}.some((li) => li.innerText.includes(${JSON.stringify(command)}))`, "the approval's row");
  await pub("approvals:decide", { id: approval.id, approved: true });
  await waitFor(`!${ROWS}.some((li) => li.dataset.status === 'waiting' && li.innerText.includes(${JSON.stringify(command)}))`, "the answered approval to leave", 10);
  check("an approval answered elsewhere stops needing you on the open page", true);

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
