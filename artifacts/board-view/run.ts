import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChat, sleep } from "../browser";

// pnpm build, then: bun artifacts/board-view/run.ts [outDir]   (outDir defaults to artifacts/board-view-v5)
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
//  12. The sidebar still has Needs you, Work or Pause all work, or lost the desktop pet; or Board's badge does not
//      count what Needs you counted.
//  13. The needs-you tab misses something Needs you showed (an approval, a question, a failure), or counts differently.
//  14. On the Board the sidebar stays full width (four columns), or unfolding it on hover pushes the board aside.
//  15. An old /work or /inbox address, or a #job-/#goal- anchor, lands nowhere, or not on its channel and thread.
//  16. Something Work could do is lost: making, changing or pausing a schedule; answering a task's question; a goal.
//  17. A done task's plan still shows a step in progress; the pane leaves a gap above its conversation; titles are
//      monospace; on a phone the tabs wrap or the state column eats the title's width.
//  18. Pause all work is gone, or pauses without asking.
//  19. Brain or Apps & skills can no longer be reached (they left the sidebar for the You menu and Settings).
//  20. The Board's numbers disagree (a tab, the nav, the badge); "all work" and "#tasks" read as the same thing.
//  21. Rows lose what helps: a queued task's place in line, a schedule's next run; paused looks like done; a done
//      task's plan shows a count that argues with it; on a wide screen a row's channel and age drift far from it.
//  22. Sub-agents a turn starts are hidden in one step: not rows of their own under the parent, not live (running,
//      done, failed), with no pane, no way back to the parent, or no activity on the parent's entry.

const REPO = resolve(import.meta.dirname, "../..");
const OUT = resolve(process.argv[2] ?? join(REPO, "artifacts", "board-view-v5"));
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
type Span = { callId: string; kind: string; name: string; status: "running" | "ok" | "error" | "declined"; startedAt: number; durationMs?: number; endedAt?: number; input?: string; output?: string; agent?: string };
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
  // A wrong dashboard key is refused as one (401, which the gate words as a key that does not match), and an unknown
  // function is not found (404): neither is a server failure, in the production build too.
  const refused = await fetch(`${BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "dashboard:getStatus", args: { key: "not-the-key" } }) });
  const refusedBody = await refused.json() as { error?: string };
  check("a wrong dashboard key is refused as a wrong key, not a server failure", refused.status === 401 && /dashboard key/i.test(refusedBody.error ?? ""), { status: refused.status, body: refusedBody });
  const unknown = await fetch(`${BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "nothing:here", args: { key: KEY } }) });
  check("an unknown function is not found, not a server failure", unknown.status === 404, unknown.status);
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

  const goal = await pub<string>("dashboard:saveGoal", { title: "Run a half marathon in May", description: "From 5 km to 21 km in sixteen weeks.", status: "active",
    milestones: [{ title: "Run 10 km without stopping", done: true }, { title: "Sign up for the race", done: false }, { title: "Long run of 18 km", done: false }] });

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
  // A toast from an action just taken ("Schedule made.") is gone before a picture is taken.
  const settle = async () => {
    await b.evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach((button) => button.click()); true");
    await b.evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
    await sleep(450);
  };
  const capture = async (clip?: { x: number; y: number; width: number; height: number }) =>
    Buffer.from((await b.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }) as { data: string }).data, "base64");
  const shot = async (name: string) => { await settle(); writeFileSync(join(OUT, name), await capture()); };
  const overflow = () => b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;
  const click = (selector: string) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
  const clickText = (selector: string, text: string) => b.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.innerText.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
  const type = (selector: string, value: string) => b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus();
    const setter = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`) as Promise<boolean>;
  /** The labels of the app sidebar's own items, top to bottom, as a person reads them. */
  // The header's name and the pet's sleeping "z"s are not items; each item reads as its label says.
  const sidebarItems = () => b.evaluate(`[...document.querySelectorAll('[data-sidebar=content] [data-sidebar=menu-button], [data-sidebar=footer] [data-sidebar=menu-button]')].map((el) => (el.getAttribute('aria-label') ?? el.innerText).split(':')[0].split(String.fromCharCode(10)).pop().trim()).filter(Boolean)`) as Promise<string[]>;
  const sidebarWidth = () => b.evaluate(`Math.round(document.querySelector('[data-slot=sidebar-container]').getBoundingClientRect().width)`) as Promise<number>;
  const gapWidth = () => b.evaluate(`Math.round(document.querySelector('[data-slot=sidebar-gap]').getBoundingClientRect().width)`) as Promise<number>;

  const ROWS = `[...document.querySelectorAll('[data-rows] [data-row]')]`;
  const pane = () => b.evaluate(`document.querySelector('[data-pane]')?.innerText ?? ''`) as Promise<string>;
  const command = "pnpm motionclip render week-47 --draft";
  const question = "The 07:10 is €40 cheaper";

  await scheme("light");
  await viewport(1440, 900);

  // --- 12, 13. The sidebar: Board holds Needs you and Work; Pause left; the pet stays ------------------------------
  await b.send("Page.navigate", { url: `${BASE}/chat` });
  await waitFor(`document.querySelector('[data-sidebar=sidebar]') && document.querySelector('[data-needs-you-count]')`, "the sidebar and its count");
  const items = await sidebarItems();
  notes.sidebar = items;
  const main = ["New chat", "Search", "Board", "To-dos", "Riff", "Meetings", "Library"];
  check("the sidebar reads New chat, Board, To-dos, Riff, Meetings, Library", JSON.stringify(items.slice(0, main.length)) === JSON.stringify(main), items);
  check("Brain and Apps & skills have left the sidebar", !items.includes("Brain") && !items.includes("Apps & skills"), items);
  check("Needs you, Work and Pause all work are gone from the sidebar", !items.some((item) => /^(Needs you|Work|Pause all work)$/.test(item)), items);
  check("the desktop pet stays in the sidebar, above the account", items.includes("Desktop pet") && await b.evaluate(`Boolean(document.querySelector('[data-account-row]')) && document.querySelector('[data-sidebar=footer]').innerText.includes('Desktop pet')`) as boolean, items);
  const badge = Number(await b.evaluate(`document.querySelector('[data-needs-you-count]')?.innerText ?? '0'`));
  const pending = await pub<Array<{ id: string }>>("approvals:pending");
  const inbox = await pub<Array<{ kind: string }>>("dashboard:getInbox");
  check("Board's badge counts what Needs you counted", badge > 0 && badge === pending.length + inbox.length, { badge, approvals: pending.length, inbox: inbox.length });
  const expandedWidth = await sidebarWidth();
  await settle();
  const afterSidebar = await capture({ x: 0, y: 0, width: expandedWidth, height: 900 });

  // --- 19. Brain and Apps & skills: in the You menu, and in Settings --------------------------------------------
  await click(`[aria-label="Account options"]`);
  await waitFor(`document.querySelector('[data-you-brain]') && document.querySelector('[data-you-apps]')`, "the You menu");
  await shot("you-menu-open.png");
  check("the You menu has Brain and Apps & skills", true);
  await click(`[data-you-brain]`);
  await waitFor(`location.pathname === '/brain'`, "Brain from the You menu");
  check("Brain opens from the You menu, on its own page", true);
  await b.send("Page.navigate", { url: `${BASE}/settings/general` });
  await waitFor(`document.querySelector('[data-settings-elsewhere]')`, "Settings' list");
  const elsewhere = await b.evaluate(`[...document.querySelectorAll('[data-settings-elsewhere] a')].map((a) => a.getAttribute('href'))`) as string[];
  check("Settings lists Brain and Apps & skills, linking to their pages", elsewhere.includes("/brain") && elsewhere.includes("/apps/connectors"), elsewhere);
  await shot("settings-with-brain-apps.png");

  // --- 14. On the Board the sidebar is a rail of icons, unfolding over the board without moving it ---------------
  await go("/board");
  await waitFor(`${ROWS}.length >= 2`, "the board's rows");
  await sleep(400);
  const rail = { container: await sidebarWidth(), gap: await gapWidth() };
  check("on the Board the sidebar folds to an icon rail", rail.container <= 56 && rail.gap <= 56, rail);
  const boardLeft = await b.evaluate(`Math.round(document.querySelector('[data-board]').getBoundingClientRect().left)`) as number;
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 300 });
  await waitFor(`document.querySelector('[data-slot=sidebar-container]').getBoundingClientRect().width > 200`, "the rail to unfold on hover", 5);
  await sleep(300);
  const peeked = { container: await sidebarWidth(), boardLeft: await b.evaluate(`Math.round(document.querySelector('[data-board]').getBoundingClientRect().left)`) as number };
  check("hovering the rail unfolds it over the board, which does not move", peeked.container > 200 && peeked.boardLeft === boardLeft, { boardLeft, peeked });
  await shot("rail-peek-desktop.png");
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 });
  await waitFor(`document.querySelector('[data-slot=sidebar-container]').getBoundingClientRect().width < 60`, "the rail to fold again", 5);

  // --- 6. What waits on the owner: the needs-you tab is what Needs you was ----------------------------------------
  const rows = await b.evaluate(`${ROWS}.map((li) => ({ id: li.dataset.row, status: li.dataset.status, text: li.innerText }))`) as Array<{ id: string; status: string; text: string }>;
  check("the pending approval is one row, needing you", rows.filter((row) => row.text.includes(command)).length === 1 && rows.find((row) => row.text.includes(command))!.status === "waiting", rows);
  check("the task's question is one row, needing you", rows.filter((row) => row.text.includes(question)).length === 1 && rows.find((row) => row.text.includes(question))!.id === `task:${askTask}`, rows);
  check("each thread is listed once", new Set(rows.map((row) => row.id)).size === rows.length, rows.map((row) => row.id));
  await go("/board?tab=needs+you");
  await waitFor(`${ROWS}.length >= 3`, "the needs-you tab");
  const needs = await b.evaluate(`${ROWS}.map((li) => li.dataset.row)`) as string[];
  const tabCount = Number(await b.evaluate(`document.querySelector('[data-needs-you-tab]')?.innerText ?? '0'`));
  check("the needs-you tab holds the approval, the question and the failed schedule, and counts them", needs.includes(`task:${askTask}`) && needs.includes(`job:${job.id}`) && needs.some((id) => id.startsWith("run:")) && tabCount === needs.length, { needs, tabCount });
  check("the needs-you tab's count is the sidebar badge's", tabCount === badge, { tabCount, badge });
  check("the Board shows no other count beside it", !(await b.evaluate(`Boolean(document.querySelector('[data-open-count]'))`)) && await b.evaluate(`document.querySelector('nav[aria-label="Views and channels"]').innerText.split('\\n').every((line) => !/\\d/.test(line))`) as boolean);
  check("the view of everything reads \"all work\", apart from #tasks", await b.evaluate(`document.querySelector('[data-board] header h1').innerText === 'all work' && [...document.querySelectorAll('nav[aria-label="Views and channels"] a')].some((a) => a.innerText.trim() === 'all work')`) as boolean);
  await shot("needs-you-desktop.png");

  // --- 15. Old addresses land on the Board -----------------------------------------------------------------------
  await b.send("Page.navigate", { url: `${BASE}/work?tab=schedules#job-${job.id}` });
  await waitFor(`location.pathname === '/board' && document.querySelector('[data-pane="job:${job.id}"]')`, "/work#job- to open its schedule on the Board");
  check("/work#job-… opens that schedule's thread in #jobs", await b.evaluate(`new URLSearchParams(location.search).get('channel') === 'jobs'`) as boolean);
  await b.send("Page.navigate", { url: `${BASE}/work?tab=goals` });
  await waitFor(`location.pathname === '/board' && new URLSearchParams(location.search).get('channel') === 'goals'`, "/work?tab=goals to land on #goals");
  check("/work?tab=goals lands on #goals", true);
  await b.send("Page.navigate", { url: `${BASE}/inbox` });
  await waitFor(`location.pathname === '/board' && new URLSearchParams(location.search).get('tab') === 'needs you'`, "/inbox to land on the needs-you tab");
  check("/inbox lands on the Board's needs-you tab", true);

  // --- 6. Answered on the Board: an approval in its pane, a task's question in place ------------------------------
  await go(`/board?thread=${encodeURIComponent(rows.find((row) => row.text.includes(command))!.id)}`);
  await waitFor(`document.querySelector('[data-pane] [data-approval-card]')`, "the approval card in its pane");
  await shot("approval-desktop.png");
  check("an approval is reviewed in its thread's pane, with its own buttons", await b.evaluate(`[...document.querySelectorAll('[data-pane] [data-approval-card] button')].some((el) => /^Allow once$/.test(el.innerText.trim()))`) as boolean);
  await go(`/board?channel=tasks&tab=needs+you&thread=task:${askTask}`);
  await waitFor(`document.querySelector('[data-pane] [data-answer] input')`, "the answer box");
  await shot("question-desktop.png");
  await type(`[data-pane] [data-answer] input`, "Take the 10:30.");
  await click(`[data-pane] [data-answer] button[type=submit]`);
  await until(async () => (await call<{ status: string } | null>("tasks:get", { id: askTask }))?.status !== "blocked", "the answer to set the task going", 10);
  check("a task's question is answered from its pane, as Work did", true);

  // --- 1-5. A background task queued while the Board is open -------------------------------------------------------
  await go("/board?channel=tasks");
  const queuedAt = Date.now();
  const liveTask = await pub<string>("tasks:queueFromDashboard", { title: "Compare three standing desks", prompt: "Compare three standing desks under €600 on stability, noise and warranty, and recommend one." });
  await waitFor(`document.querySelector('[data-row="task:${liveTask}"]')`, "the new task's row", 10);
  check("a queued background task appears on the open board within seconds", Date.now() - queuedAt < 5_000, Date.now() - queuedAt);
  await b.evaluate(`document.querySelector('[data-row="task:${liveTask}"] a').click()`);
  await waitFor(`document.querySelector('[data-pane="task:${liveTask}"]')`, "the task's pane");
  const liveChat = await until(async () => (await call<{ conversationId?: string } | null>("tasks:get", { id: liveTask }))?.conversationId, "the live task's chat");
  // The answered task takes a turn too: answer it as an idle engine would, so the live task's is next.
  const liveTurn = await nextTurn((turn) => turn.conversationId === liveChat, "the live task's turn", 90);
  await claim(liveTurn);
  await waitFor(`document.querySelector('[data-pane] [data-holder]')?.innerText.includes('PC')`, "the holder to show", 10);
  const holder = await b.evaluate(`document.querySelector('[data-pane] [data-holder]').innerText`) as string;
  check("the pane shows who holds it: engine, model and computer", holder.includes("codex") && holder.includes("gpt-5.5") && holder.includes("PC"), holder);
  const l0 = Date.now();
  await call("work:setPlan", { taskId: liveTask, plan: [{ title: "Shortlist desks under €600", status: "active" }, { title: "Read the long-term reviews", status: "pending" }, { title: "Write up the trade-offs", status: "pending" }] });
  await trace(liveTurn, step("d1", "webSearch", "standing desk under 600 euro long-term review", "running", l0));
  await waitFor(`document.querySelector('[data-pane]').innerText.includes('Searching the web') && document.querySelector('[data-row="task:${liveTask}"]').innerText.includes('Searching the web')`, "the running step in the pane and the row", 10);
  check("the step a turn is on shows live, in the pane and on its row", true);
  check("a running task has its composer at the foot of its conversation", await b.evaluate(`Boolean(document.querySelector('[data-pane] [data-composer] input'))`) as boolean);
  // b. The conversation flows right under the state block: no empty gap between them.
  const gap = await b.evaluate(`(() => { const block = document.querySelector('[data-pane] [data-task-block]').getBoundingClientRect(); const talk = document.querySelector('[data-pane] [data-conversation]').getBoundingClientRect(); return Math.round(talk.top - block.bottom); })()`) as number;
  check("the conversation starts right under the state block", gap >= 0 && gap <= 4, gap);
  // f. Perry's type for titles and text, monospace for ids, channels, times and computers.
  const fonts = await b.evaluate(`(() => { const f = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily; return { title: f('[data-pane] [data-title]'), row: f('[data-row] a > span:nth-child(2)'), holder: f('[data-pane] [data-holder] .font-mono'), age: f('[data-row] [data-age]') }; })()`) as Record<string, string>;
  check("titles and text use Perry's own type; holder and ages are monospace", !/mono/i.test(fonts.title) && !/mono/i.test(fonts.row) && /mono/i.test(fonts.holder) && /mono/i.test(fonts.age), fonts);
  await shot("thread-desktop.png");
  await trace(liveTurn,
    step("d1", "webSearch", "standing desk under 600 euro long-term review", "ok", l0, { durationMs: 2_100 }),
    step("d2", "commentary", "commentary", "ok", l0 + 2_500, { output: "Shortlisted the Flexispot E7, the Fezibo Dual and the IKEA Trotten. Notes so far: https://example.com/desk-notes" }),
    step("d3", "fileChange", "C:/Users/sam/Documents/desks.md", "ok", l0 + 3_000, { input: "+ | Desk | Stability | Noise | Warranty |" }));
  await waitFor(`document.querySelector('[data-pane]').innerText.includes('Shortlisted the Flexispot E7') && document.querySelector('[data-pane] a[href="https://example.com/desk-notes"]')`, "the update and its link", 10);
  check("an update and its link reach the open pane without a reload", true);
  // e. It finishes without ticking its plan off: the plan says so, and no step reads as under way.
  await call("work:updateTask", { taskId: liveTask, status: "done", result: "Get the **Flexispot E7**: steadiest at full height, quietest motor, and a 5-year warranty. The table is in desks.md." });
  await finish(liveTurn, { response: "Done: the Flexispot E7." });
  await waitFor(`document.querySelector('[data-pane] [data-state]')?.dataset.state === 'done'`, "the task to end", 15);
  const plan = await b.evaluate(`[...document.querySelectorAll('[data-pane] [data-plan] li')].map((li) => li.dataset.step)`) as string[];
  check("a finished task's plan shows no step in progress", plan.length === 3 && !plan.includes("active") && plan[0] === "unfinished", plan);
  const planLabel = await b.evaluate(`[...document.querySelectorAll('[data-pane] dt')].map((dt) => dt.innerText.trim()).find((text) => text.startsWith('plan'))`) as string;
  check("a done task's plan carries no count to argue with it", planLabel === "plan", planLabel);
  await shot("thread-done-desktop.png");

  // --- 16. #jobs: a schedule made, changed and paused from the Board, as Work did --------------------------------
  await go("/board?channel=jobs&tab=all");
  await waitFor(`document.querySelector('[data-new=jobs]')`, "the new-schedule button");
  await click(`[data-new=jobs]`);
  await waitFor(`document.querySelector('#schedule-name')`, "the schedule form");
  await type("#schedule-name", "Morning briefing");
  await type("#schedule-prompt", "Summarise today's calendar and anything urgent in my inbox. If there is nothing, say nothing.");
  await shot("jobs-new-desktop.png");
  await clickText("[role=dialog] button", "Create");
  const briefing = await until(async () => (await pub<{ jobs: Array<{ id: string; name: string; enabled: boolean }> }>("jobs:listForDashboard")).jobs.find((item) => item.name === "Morning briefing"), "the schedule to be made", 10);
  check("a schedule is made from #jobs's header", true);
  await waitFor(`document.querySelector('[data-row="job:${briefing.id}"] [data-next-run]')`, "its next run on its row");
  check("a schedule's row says when it runs next", /^next \d+[smhd]$/.test(await b.evaluate(`document.querySelector('[data-row="job:${briefing.id}"] [data-next-run]').innerText`) as string));
  check("inside a channel, rows do not repeat its name", !(await b.evaluate(`document.querySelector('[data-row="job:${briefing.id}"]').innerText`) as string).includes("#jobs"));
  await waitFor(`document.querySelector('[data-row="job:${briefing.id}"]')`, "its row");
  await b.evaluate(`document.querySelector('[data-row="job:${briefing.id}"] a').click()`);
  await waitFor(`document.querySelector('[data-pane="job:${briefing.id}"] [data-more]') && document.querySelector('[data-pane] [data-job-model]')`, "its pane, with its model");
  await click(`[data-pane] [data-more]`);
  await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((el) => el.innerText.trim() === 'pause')`, "its menu");
  await shot("jobs-desktop.png");
  await clickText("[role=menuitem]", "pause");
  await until(async () => (await pub<{ jobs: Array<{ id: string; enabled: boolean }> }>("jobs:listForDashboard")).jobs.find((item) => item.id === briefing.id)?.enabled === false, "the schedule to pause", 10);
  check("a schedule is paused from its pane", true);
  await waitFor(`document.querySelector('[data-row="job:${briefing.id}"] [data-state] svg')?.getAttribute('class').includes('circle-minus')`, "the paused glyph");
  check("paused has its own glyph, not done's", await b.evaluate(`!document.querySelector('[data-row="job:${briefing.id}"] [data-state] svg').getAttribute('class').includes('circle-check')`) as boolean);
  await waitFor(`document.querySelector('[data-pane] [data-more]')`, "the pane after pausing");
  await click(`[data-pane] [data-more]`);
  await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((el) => el.innerText.trim() === 'change')`, "its menu again");
  await clickText("[role=menuitem]", "change");
  await waitFor(`document.querySelector('#schedule-name')?.value === 'Morning briefing'`, "the change form, filled in");
  check("a schedule's change form opens from its pane, filled in", true);
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('#schedule-name')`, "the form to close");
  await go(`/board?channel=jobs&tab=all&thread=job:${job.id}`);
  await waitFor(`document.querySelector('[data-pane="job:${job.id}"] [data-last-step]')`, "the failed schedule's pane");
  const failed = await pane();
  check("a failed schedule shows failed, its last step and its error", failed.includes("failed") && failed.includes("bank-cli export") && failed.includes(jobError), failed.slice(0, 600));
  // Its row leads with the failure: when it failed, not when it runs next; the next run is in its pane.
  const failedRow = await b.evaluate(`(() => { const row = document.querySelector('[data-row="job:${job.id}"]'); return { next: Boolean(row.querySelector('[data-next-run]')), age: row.querySelector('[data-age]').innerText, line: row.querySelector('[data-line]')?.innerText ?? '' }; })()`) as { next: boolean; age: string; line: string };
  check("a failed schedule's row shows the failure and when, not its next run", !failedRow.next && /^\d+[smhd]$/.test(failedRow.age.trim()) && failedRow.line.includes("one-time code"), failedRow);
  check("a failed schedule's next run is in its pane", /next in|next /.test(failed), failed.slice(0, 400));
  check("a failed schedule's pane says its error once", failed.split(jobError).length === 2, failed.slice(0, 600));
  await shot("failed-schedule-desktop.png");

  // --- 17. #goals: Work's goals, changed from their pane --------------------------------------------------------
  await go("/board?channel=goals");
  await waitFor(`document.querySelector('[data-row="goal:${goal}"]')`, "the goal's row");
  await b.evaluate(`document.querySelector('[data-row="goal:${goal}"] a').click()`);
  await waitFor(`document.querySelector('[data-pane="goal:${goal}"] [data-plan]')`, "the goal's pane");
  check("a goal shows its milestones and offers change", (await pane()).includes("milestones 1/3") && await b.evaluate(`document.querySelector('[data-pane] [data-action]')?.innerText === 'change'`) as boolean, (await pane()).slice(0, 400));
  await shot("goals-desktop.png");

  // --- 18. Pause all work, from the Board's header, with its question first ---------------------------------------
  const pauseShown = await b.evaluate(`Boolean(document.querySelector('header [data-pause=running]'))`) as boolean;
  check("Pause all work is in the Board's header while something runs", pauseShown);
  await click(`header [data-pause=running]`);
  await waitFor(`[...document.querySelectorAll('[role=alertdialog] h2, [role=alertdialog] [data-slot=alert-dialog-title]')].some((el) => el.innerText.includes('Pause all work?'))`, "the pause question");
  check("pausing asks first", true);
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('[role=alertdialog]')`, "the question to close");
  check("nothing paused when the question is declined", !(await pub<{ paused: boolean }>("pause:status")).paused);

  // --- 22. Sub-agents: a turn that starts three at once, each a row under it, live, with a pane of its own ----------
  const offsite = await pub<string>("dashboard:createChat");
  await pub("dashboard:renameChat", { id: offsite, title: "Plan the team offsite" });
  await pub("dashboard:sendChat", { id: offsite, text: "Plan a two-day team offsite near Lisbon in March: venue, travel and an agenda. Split the research." });
  const offsiteTurn = await nextTurn((turn) => turn.conversationId === offsite, "the offsite chat's turn", 90);
  await claim(offsiteTurn);
  const a0 = Date.now() - 20_000;
  const AGENTS = [
    { id: "codex:agent-venues", title: "Find venues near Lisbon", prompt: "Find three venues within an hour of Lisbon for 12 people in March, with prices." },
    { id: "codex:agent-travel", title: "Compare travel options", prompt: "Compare flights and trains to Lisbon for a team of 12 from London and Berlin." },
    { id: "codex:agent-agenda", title: "Draft a two-day agenda", prompt: "Draft a two-day agenda: planning in the mornings, one team activity each afternoon." },
  ];
  // The venues agent's own steps, tagged with it as the runner tags a sub-agent's (runSpans.agent).
  const venueSteps = (done: boolean) => [
    step("v1", "webSearch", "venues near Lisbon for 12 people in March", "ok", a0 + 1_000, { agent: AGENTS[0].id }),
    step("v2", "command", "curl -s https://quinta.example/prices", done ? "ok" : "running", a0 + 4_000, { agent: AGENTS[0].id, ...(done ? { output: "March: €4,800 for two days" } : {}) }),
    ...(done ? [step("v3", "fileChange", "C:/Users/sam/offsite/venues.md", "ok", a0 + 9_000, { agent: AGENTS[0].id, input: "+ | Venue | Price | Distance |" })] : []),
  ];
  const agentSpans = [...AGENTS.map((agent, index) => step(`ag${index}`, "dynamicToolCall", `Agent: ${agent.title}`, "running", a0 + index * 300)), ...venueSteps(false)];
  let agentClock = Date.now();
  const report = (agents: Array<{ id: string; title: string; prompt: string; status: "running" | "done" | "failed"; text?: string }>, spans = agentSpans) =>
    runner("codex:traceTurn", { token: PC, id: offsiteTurn._id, spans, steps: spans.length, agents: agents.map((agent) => ({ ...agent, model: "gpt-5.5-mini", updatedAt: ++agentClock })) });
  await report(AGENTS.map((agent) => ({ ...agent, status: "running" })));
  await report([
    { ...AGENTS[0], status: "running", text: "Shortlisted Quinta da Arrábida and Palácio de Seteais; checking March prices." },
    { ...AGENTS[1], status: "running", text: "London: TAP and easyJet direct. Berlin: one stop via Frankfurt." },
    { ...AGENTS[2], status: "running", text: "Day one: goals for the quarter, then a cooking class in Alfama." },
  ]);
  await go("/board?channel=chats");
  const parentRow = `document.querySelector('[data-agents="3"]')?.closest('[data-row]')`;
  await waitFor(`${parentRow} && document.querySelectorAll('[data-agent-rows] [data-agent]').length === 3`, "the parent row with its three agents, open while they run", 15);
  const kids = await b.evaluate(`[...document.querySelectorAll('[data-agent-rows] [data-agent]')].map((li) => ({ id: li.dataset.row, status: li.dataset.status, text: li.innerText }))`) as Array<{ id: string; status: string; text: string }>;
  check("a turn's three sub-agents are three rows under it, all running", kids.length === 3 && kids.every((kid) => kid.status === "working" && kid.id.startsWith("agent:")), kids);
  check("the parent says how many agents run, at a glance", (await b.evaluate(`document.querySelector('[data-agents-toggle]').innerText`) as string).includes("3 agents · 3 running"));
  check("a running sub-agent shows its model, computer and what it is doing", kids.every((kid) => kid.text.includes("gpt-5.5-mini via PC")) && kids.some((kid) => kid.text.includes("TAP and easyJet")), kids);
  check("a sub-agent that reports its steps shows the one it is on", kids.some((kid) => kid.text.includes("Find venues") && kid.text.includes("Running curl")), kids);
  check("sub-agents are not rows of their own at the top level", !(await b.evaluate(`[...document.querySelectorAll('[data-rows] > li')].some((li) => li.dataset.row?.startsWith('agent:'))`)));
  await shot("board-subagents-desktop.png");
  const venue = kids.find((kid) => kid.text.includes("Find venues"))!.id;
  await b.evaluate(`document.querySelector('[data-row="${venue}"] a').click()`);
  await waitFor(`document.querySelector('[data-pane="${venue}"] [data-parent-link]')`, "the sub-agent's pane");
  check("a sub-agent opens to its own pane: its ask, live output and a link back to its parent",
    (await pane()).includes("Find three venues within an hour") && (await pane()).includes("Quinta da Arrábida")
      && await b.evaluate(`document.querySelector('[data-pane] [data-parent-link]').innerText === 'Plan the team offsite'`) as boolean, (await pane()).slice(0, 500));
  await waitFor(`document.querySelector('[data-pane] [data-agent-steps]')?.innerText.includes('Running curl')`, "the sub-agent's own steps, live", 10);
  // Grouped as a turn's are, the group's line is the step it is on; opened, every step it took.
  await click(`[data-pane] [data-agent-steps] [data-tool-group] button`);
  await waitFor(`document.querySelector('[data-pane] [data-agent-steps]').innerText.includes('Searched the web')`, "the sub-agent's earlier step", 10);
  check("a sub-agent's pane shows its own steps, live", true);
  await shot("subagent-thread-desktop.png");
  await click(`[data-pane] [data-agent-steps] [data-tool-group] button`);
  // Two finish and one fails: the rows follow, without a reload.
  await report([
    { ...AGENTS[0], status: "done", text: "Quinta da Arrábida: €4,800 for two days, 40 min from Lisbon, rooms for 12.\n\nPalácio de Seteais: €6,200, in Sintra." },
    { ...AGENTS[1], status: "done", text: "Fly: London on TAP (2h 40m), Berlin via Frankfurt (5h). About €3,100 return for 12." },
    { ...AGENTS[2], status: "failed", text: "Day one drafted.\nThe calendar connection timed out before day two could be checked." },
  ], [...AGENTS.map((agent, index) => step(`ag${index}`, "dynamicToolCall", `Agent: ${agent.title}`, index === 2 ? "error" : "ok", a0 + index * 300, { durationMs: 15_000 })), ...venueSteps(true)]);
  await waitFor(`(() => { const s = [...document.querySelectorAll('[data-agent-rows] [data-agent]')].map((li) => li.dataset.status).sort().join(','); return s === 'done,done,failed'; })()`, "two agents done and one failed", 15);
  check("sub-agents go from running to done, and one that fails shows failed", true);
  check("the parent's count says one failed", (await b.evaluate(`document.querySelector('[data-agents-toggle]').innerText`) as string).includes("1 failed"));
  check("the open sub-agent's pane shows it done with its answer", await b.evaluate(`document.querySelector('[data-pane] [data-state]')?.dataset.state === 'done' && document.querySelector('[data-pane]').innerText.includes('€4,800')`) as boolean);
  // Its steps, finished, include the file it changed, which opens from its step.
  await waitFor(`/changed 1 file/i.test(document.querySelector('[data-pane] [data-agent-steps]')?.innerText ?? '')`, "the sub-agent's file change", 10);
  await click(`[data-pane] [data-agent-steps] [data-tool-group] button`);
  await waitFor(`document.querySelector('[data-pane] [data-agent-steps]').innerText.includes('venues.md')`, "the changed file under the sub-agent", 10);
  check("a sub-agent's changed file is under that sub-agent", true);
  await shot("subagent-thread-done-desktop.png");
  const offsiteRun = await b.evaluate(`document.querySelector('[data-agents="3"]').closest('[data-row]').dataset.row`) as string;
  await go(`/board?thread=${encodeURIComponent(offsiteRun)}`);
  await waitFor(`document.querySelectorAll('[data-pane] [data-pane-agents] li').length === 3`, "the parent's pane listing its agents");
  check("the parent's pane lists its sub-agents with how each stands", true);
  await waitFor(`document.querySelector('[data-pane] [data-feed] [data-work-timeline]')`, "the parent's own timeline");
  await b.evaluate(`document.querySelectorAll('[data-pane] [data-feed] [data-tool-group] button').forEach((button) => button.click())`);
  await sleep(600);
  const parentFeed = await b.evaluate(`document.querySelector('[data-pane] [data-feed]').innerText`) as string;
  check("a sub-agent's steps and file are not in its parent's timeline", !/curl -s|venues\.md|for 12 people/.test(parentFeed) && /Agent/.test(parentFeed), parentFeed.slice(0, 600));
  await go("/board?view=activity");
  await waitFor(`document.querySelector('[data-activity] [data-entry="${offsiteRun}"]')`, "the parent's activity entry");
  const told = await b.evaluate(`document.querySelector('[data-activity] [data-entry="${offsiteRun}"]').innerText`) as string;
  check("activity tells a sub-agent's end on its parent's entry", /agent .+ (finished|failed)/.test(told) && told.includes("Plan the team offsite"), told);
  const agentEvents = (await pub<{ events: Array<{ thread?: string; agent?: { id: string }; verb: string }> }>("board:get")).events.filter((event) => event.agent);
  check("each sub-agent's start and end are events attributed to its parent", agentEvents.length > 0 && agentEvents.every((event) => event.thread === offsiteRun), agentEvents);
  await viewport(390, 844, true);
  await go("/board?channel=chats");
  await waitFor(`document.querySelector('[data-agents-toggle]')`, "the parent on a phone");
  // Over now, they are folded under the parent; opened by its toggle.
  await click(`[data-agents-toggle]`);
  await waitFor(`document.querySelectorAll('[data-agent-rows] [data-agent]').length === 3`, "the agents opened on a phone");
  check("on a phone the sub-agents open under their parent, nothing sideways", (await overflow()) <= 0, await overflow());
  await shot("board-subagents-phone.png");
  await go(`/board?thread=${encodeURIComponent(venue)}`);
  await waitFor(`document.querySelector('[role=dialog] [data-pane] [data-parent-link]')`, "the sub-agent on a phone");
  await shot("subagent-thread-phone.png");
  await viewport(1440, 900);
  await finish(offsiteTurn, { response: "Here is the plan: Quinta da Arrábida, TAP from London, and a day-one agenda; day two needs your calendar." });

  // --- 9, 10. Widths ------------------------------------------------------------------------------------------------
  await go(`/board?thread=task:${liveTask}`);
  await waitFor(`document.querySelector('[data-pane]')`, "the pane");
  check("nothing overflows sideways at 1440 px", (await overflow()) <= 0, await overflow());
  const columns = await b.evaluate(`[...document.querySelectorAll('[data-slot=sidebar-gap], [data-board] > *')].map((el) => Math.round(el.getBoundingClientRect().width)).filter((w) => w > 0)`) as number[];
  check("with a thread open at 1440, the rail, board nav, list and pane fit with the list widest", columns[0] <= 56 && columns.length === 4 && columns[2] === Math.max(...columns), columns);
  await go("/board?tab=all");
  await waitFor(`${ROWS}.length > 3`, "the board");
  const rowsWidth = await b.evaluate(`Math.round(document.querySelector('[data-rows]').getBoundingClientRect().width)`) as number;
  check("at 1440 the rows keep to a readable width, not the whole screen", rowsWidth <= 864, rowsWidth);
  await shot("board-desktop.png");
  await viewport(1280, 800);
  await go("/board?tab=all");
  await waitFor(`${ROWS}.length > 3`, "the board at 1280");
  check("nothing overflows sideways at 1280 px", (await overflow()) <= 0, await overflow());
  await shot("board-1280.png");
  await viewport(1440, 900);
  await scheme("dark");
  await waitFor(`document.documentElement.classList.contains('dark')`, "the dark theme");
  await go(`/board?thread=task:${liveTask}`);
  await waitFor(`document.querySelector('[data-pane] [data-plan]')`, "the pane in dark");
  await shot("thread-dark-desktop.png");
  await scheme("light");
  await waitFor(`!document.documentElement.classList.contains('dark')`, "the light theme");

  // --- 19. A phone: one line of tabs, the glyph alone for a state, the thread on its own --------------------------
  await viewport(390, 844, true);
  await go("/board?tab=all");
  await waitFor(`${ROWS}.length > 3`, "the phone board");
  check("nothing overflows sideways at 390 px (list)", (await overflow()) <= 0, await overflow());
  const tabs = await b.evaluate(`(() => { const links = [...document.querySelectorAll('[data-tabs] a')]; const tops = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top))); const nav = document.querySelector('[data-tabs]'); return { lines: tops.size, scrolls: nav.scrollWidth > nav.clientWidth, inset: parseFloat(getComputedStyle(nav).paddingLeft) }; })()`) as { lines: number; scrolls: boolean; inset: number };
  check("on a phone the tabs are one line that scrolls, inset like the rows", tabs.lines === 1 && tabs.scrolls && tabs.inset === 16, tabs);
  check("on a phone the chosen tab is scrolled into view", await b.evaluate(`(() => { const nav = document.querySelector('[data-tabs]').getBoundingClientRect(); const a = document.querySelector('[data-tabs] [aria-current=page]').getBoundingClientRect(); return a.left >= nav.left + 15 && a.right <= nav.right - 15; })()`) as boolean);
  const states = await b.evaluate(`(() => { const row = document.querySelector('[data-rows] [data-row] a'); const state = row.querySelector('[data-state]').getBoundingClientRect(); const title = row.children[1].getBoundingClientRect(); return { state: Math.round(state.width), title: Math.round(title.width), row: Math.round(row.getBoundingClientRect().width), word: row.querySelector('[data-state] span').innerText }; })()`) as { state: number; title: number; row: number; word: string };
  check("on a phone a row's state is its glyph (its word kept for screen readers) and the title has the width", states.state <= 20 && states.title / states.row > 0.6 && states.word.length > 0, states);
  await shot("board-phone.png");
  await go(`/board?channel=jobs&tab=all&thread=job:${job.id}`);
  await waitFor(`document.querySelector('[role=dialog] [data-pane] [data-last-step]')`, "the failed schedule on a phone");
  check("nothing overflows sideways at 390 px (failed schedule)", (await overflow()) <= 0, await overflow());
  await shot("failed-schedule-phone.png");
  await go(`/board?tab=all&thread=task:${liveTask}`);
  await waitFor(`document.querySelector('[role=dialog] [data-pane]')`, "the phone thread");
  check("nothing overflows sideways at 390 px (thread)", (await overflow()) <= 0, await overflow());
  await shot("thread-phone.png");
  await viewport(1440, 900);

  // --- The sidebar, v2 and now, side by side ----------------------------------------------------------------------
  const before = readFileSync(join(REPO, "artifacts", "board-view-v2", "thread-done-desktop.png")).toString("base64");
  const after = afterSidebar.toString("base64");
  const panel = (label: string, image: string) => `<figure style="margin:0"><figcaption>${label}</figcaption><div style="width:256px;height:900px;background:url(data:image/png;base64,${image}) 0 0 no-repeat;border:1px solid #e5e5e5;border-radius:8px"></div></figure>`;
  await viewport(1440, 1000);
  await b.send("Page.navigate", { url: "about:blank" });
  await b.evaluate(`document.body.innerHTML = ${JSON.stringify(`<div style="display:inline-flex;gap:32px;padding:24px;font:500 14px system-ui;color:#555;background:#fff">${panel("before (v2)", before)}${panel("after (v4)", after)}</div>`)}; document.body.style.margin = 0; true`);
  await sleep(300);
  const size = await b.evaluate(`(() => { const r = document.body.firstElementChild.getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`) as { width: number; height: number };
  writeFileSync(join(OUT, "sidebar-before-after.png"), await capture({ x: 0, y: 0, ...size }));

  // The approval answered elsewhere leaves the open page by itself.
  await viewport(1440, 900);
  await go("/board");
  await waitFor(`${ROWS}.some((li) => li.innerText.includes(${JSON.stringify(command)}))`, "the approval's row");
  await pub("approvals:decide", { id: approval.id, approved: true });
  await waitFor(`!${ROWS}.some((li) => li.dataset.status === 'waiting' && li.innerText.includes(${JSON.stringify(command)}))`, "the answered approval to leave", 10);
  check("an approval answered elsewhere stops needing you on the open page", true);

  // --- 21. A queued task's place in line: with Perry paused nothing starts, so two queued tasks keep their places.
  await pub("pause:set", { paused: true, from: "web" });
  const first = await pub<string>("tasks:queueFromDashboard", { title: "Renew the passport photos", prompt: "Find a photo booth nearby and book a slot this week." });
  const second = await pub<string>("tasks:queueFromDashboard", { title: "Export last year's receipts", prompt: "Download last year's statements and file the receipts." });
  await go("/board?channel=tasks&tab=queued");
  await waitFor(`document.querySelector('[data-row="task:${second}"] [data-in-line]')`, "the queued tasks' places");
  const places = await b.evaluate(`[${JSON.stringify(first)}, ${JSON.stringify(second)}].map((id) => document.querySelector('[data-row="task:' + id + '"] [data-in-line]')?.innerText)`) as string[];
  check("queued tasks say their place in line: next, then 2 in line", places[0] === "next" && places[1] === "2 in line", places);
  await pub("pause:set", { paused: false, from: "web" });

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
