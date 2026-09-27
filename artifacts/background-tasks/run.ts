import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/background-tasks/run.ts <outDir>
// Issue #102: background tasks Perry carries out by himself, one at a time.
// A fresh Perry (production build, `pnpm build` first) with a stand-in
// Telegram paired as the owner's app, the real runner and Codex
// (PERRY_E2E_MODEL picks the chat model), and headless Chrome for the Work page.
//
// Ways it could fail, written down before the checks:
//   1. A queued task never starts, or starts while another is running, so
//      two run at once.
//   2. A task runs but keeps no plan, or never finishes: its status stays
//      running.
//   3. The result is lost: it does not reach the phone (asked for on the Work
//      page) or the chat it was asked for in (queue_task).
//   4. A task that needs the owner guesses instead of asking; or its question
//      reaches no one; or the answer (Work page, or resume_task in a chat) does
//      not bring it back, or brings it back without the answer.
//   5. A task that never finishes runs forever instead of stopping after
//      MAX_TURNS, or stops without telling anyone.
//   6. The next task in line does not start when one ends.
//   7. The Work page cannot queue a task, does not say what is next in line,
//      has no way to answer a question, or no way to see the task's chat.
//   8. The task's own turns count as the owner writing, or show as a chat the
//      owner is reading.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/background-tasks/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "background-tasks-e2e-key";
const OWNER = "4242";
const home = mkdtempSync(join(tmpdir(), "perry-tasks-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

type Sent = { text: string; at: number };
const telegram = { sent: [] as Sent[], pending: [] as object[], nextUpdate: 1 };
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
    if ((method === "sendMessage" || method === "editMessageText") && String(args.chat_id) === OWNER) {
      telegram.sent.push({ text: String(args.text), at: Date.now() });
      return reply({ message_id: telegram.sent.length });
    }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false, first_name: "Mani" }, text },
});

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:tasks-e2e", TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  return spawn(command, args, { cwd: REPO, env, stdio: "ignore", windowsHide: true });
}
const stop = (child: ChildProcess | null) => { if (child?.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
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
type Task = { _id: string; title: string; status: string; plan: Array<{ text: string; status: string }>; result?: string; question?: string; error?: string; origin?: string; conversationId?: string; turns?: number };
type Message = { role: string; text: string };
const tasks = async () => (await call<{ tasks: Task[] }>("dashboard:getWork", { key: KEY })).tasks;
const task = async (id: string) => (await tasks()).find((item) => item._id === id);
const settled = (id: string, seconds = 400) => until(async () => ["done", "blocked", "failed", "cancelled"].includes((await task(id))?.status ?? ""), "the task to settle", seconds).catch(() => {});
const messagesOf = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 30, cursor: null } })).page;
const idle = (id: string) => until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id })).isRunning
  && !(await call<Array<{ status: string }>>("dashboard:listRuns", { key: KEY, conversationId: id })).some((run) => run.status === "running"), "the chat to be idle", 400);
async function ask(chat: string, text: string): Promise<string> {
  await call("dashboard:sendChat", { key: KEY, id: chat, text });
  await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to start", 60).catch(() => {});
  await idle(chat);
  return (await messagesOf(chat)).find((message) => message.role === "assistant")?.text ?? "";
}
const toPhone = (pattern: RegExp) => telegram.sent.filter((message) => pattern.test(message.text));

// Every half second, how many tasks run at once. The one the test stops by hand is left out.
const byHand = new Set<string>();
let sampling = true;
let mostAtOnce = 0;
const sampler = (async () => {
  while (sampling) {
    const now = await tasks().catch(() => [] as Task[]);
    mostAtOnce = Math.max(mostAtOnce, now.filter((item) => item.status === "running" && !byHand.has(item._id)).length);
    await sleep(500);
  }
})();

let server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const model = process.env.PERRY_E2E_MODEL;
  const newChat = async () => { const id = await call<string>("dashboard:createChat", { key: KEY }); if (model) await call("dashboard:setChatModel", { key: KEY, id, model }); return id; };

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  const go = async (path: string) => { await send("Page.navigate", { url: `${BASE}${path}` }); await sleep(2_500); };
  const clickText = (selector: string, text: string) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const type = (selector: string, value: string) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const text = () => evaluate(`document.body.innerText`) as Promise<string>;
  await go("/work?tab=plans");

  const wroteBefore = (await call<{ ownerWroteAt?: number } | null>("installation:get", {}))?.ownerWroteAt ?? 0;

  // --- 1, 2, 6, 7. Three in line: one runs, the others wait --------------------------------
  const sums = await call<string>("tasks:queueFromDashboard", { key: KEY, title: "Two sums", prompt: "Work out 17 × 23, and the square root of 1764. Lay out a plan of two steps with set_plan first, then finish with both numbers as the result." });
  const haiku = await call<string>("tasks:queueFromDashboard", { key: KEY, title: "A haiku about rain", prompt: "Write a haiku about monsoon rain in Bengaluru, and finish with the haiku as the result." });
  const stuck = await call<string>("tasks:queueFromDashboard", { key: KEY, title: "One that never ends", prompt: "Count the stars. (This one is stopped by the test.)" });
  await until(async () => (await task(sums))?.status === "running", "the first task to start", 30).catch(() => {});
  const early = { sums: await task(sums), haiku: await task(haiku), stuck: await task(stuck) };
  check("oneRunsTheRestWait", early.sums?.status === "running" && early.haiku?.status === "queued" && early.stuck?.status === "queued" && !early.haiku?.conversationId,
    { sums: early.sums?.status, haiku: early.haiku?.status, stuck: early.stuck?.status });
  await until(async () => (await text()).includes("Next in line"), "the line on the page", 20).catch(() => {});
  const page = await text();
  await shot("work-plans-in-line.png");
  check("pageShowsTheLine", page.includes("Next in line") && page.includes("2 in line"), page.slice(0, 600));

  // A task that never calls finish_task: the test puts it at its last turn, as if it had run five
  // turns already, and ends that turn. The model is not needed to fail at finishing.
  byHand.add(stuck);
  const bunSqlite = "bun:sqlite";
  const { Database } = await import(bunSqlite) as { Database: new (path: string) => { exec(sql: string): void; run(sql: string, params: unknown[]): void; close(): void } };
  const db = new Database(join(home, "perry.sqlite"));
  try { db.exec("PRAGMA busy_timeout = 5000;"); db.run(`UPDATE "doc_tasks" SET doc = json_set(doc, '$.status', 'running', '$.turns', 6) WHERE _id = ?`, [stuck]); } finally { db.close(); }
  await call("tasks:afterTurn", { id: stuck });
  await until(() => toPhone(/One that never ends/).length > 0, "word of the stopped task", 20).catch(() => {});
  const stopped = await task(stuck);
  check("stopsAfterMaxTurnsAndSays", stopped?.status === "failed" && /Stopped after 6 turns/.test(stopped.error ?? "") && toPhone(/One that never ends[\s\S]*could not be finished/).length === 1,
    { status: stopped?.status, error: stopped?.error, phone: toPhone(/One that never ends/).map((m) => m.text) });

  await settled(sums);
  const done = await task(sums);
  check("runsWithAPlanAndFinishes", done?.status === "done" && (done.plan?.length ?? 0) >= 1 && /391/.test(done.result ?? "") && /42/.test(done.result ?? ""),
    { status: done?.status, plan: done?.plan, result: done?.result, error: done?.error, turns: done?.turns });
  await until(() => toPhone(/Two sums[\s\S]*is done/).length > 0, "the result on the phone", 20).catch(() => {});
  check("resultReachesThePhone", toPhone(/Two sums[\s\S]*is done/).some((message) => /391/.test(message.text)), toPhone(/Two sums/).map((m) => m.text));
  const ownChat = done?.conversationId ? await call<{ taskId?: string; title?: string } | null>("conversations:getById", { id: done.conversationId }) : null;
  check("worksInAChatOfItsOwn", ownChat?.taskId === sums && /Two sums/.test(ownChat?.title ?? ""), ownChat);
  const wrote = (await call<{ ownerWroteAt?: number } | null>("installation:get", {}))?.ownerWroteAt ?? 0;
  check("taskTurnsAreNotTheOwnerWriting", wrote === wroteBefore, { wroteBefore, wrote });

  await settled(haiku);
  const poem = await task(haiku);
  check("nextInLineStarts", poem?.status === "done" && Boolean(poem.result?.trim()), { status: poem?.status, result: poem?.result, error: poem?.error });

  // --- 4, 7. Queued on the page; its question reaches the phone; answered on the page ---------
  await go("/work?tab=plans");
  await clickText("button", "New task");
  await until(() => evaluate(`Boolean(document.querySelector("#task-title"))`), "the task form", 20).catch(() => {});
  await type("#task-title", "Paint for the study");
  await type("#task-prompt", "Choose the wall paint colour for my study. You do not know which colour I like, and must not guess: first ask me with finish_task blocked, one short question. When I have answered, finish done, naming my colour and one accent colour that goes with it.");
  await shot("work-new-task.png");
  await clickText("button[type=submit]", "Save");
  await until(async () => (await tasks()).some((item) => item.title === "Paint for the study"), "the task from the form", 20).catch(() => {});
  const paint = (await tasks()).find((item) => item.title === "Paint for the study")?._id ?? "";
  check("pageQueuesATask", Boolean(paint));
  await settled(paint);
  const asking = await task(paint);
  await until(() => toPhone(/Paint for the study[\s\S]*needs you/).length > 0, "the question on the phone", 20).catch(() => {});
  check("asksInsteadOfGuessing", asking?.status === "blocked" && Boolean(asking.question) && toPhone(/Paint for the study[\s\S]*needs you/).length === 1,
    { status: asking?.status, question: asking?.question, result: asking?.result, phone: toPhone(/Paint/).map((m) => m.text) });
  await go("/work?tab=plans");
  const box = `input[aria-label="Answer for Paint for the study"]`;
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(box)}))`), "the answer box", 20).catch(() => {});
  const hasChatLink = await evaluate(`[...document.querySelectorAll("a")].some((a) => a.textContent.includes("Its chat") && a.getAttribute("href") === "/chat/${asking?.conversationId}")`);
  await type(box, "Sage green");
  await shot("work-answer.png");
  await clickText("button[type=submit]", "Answer");
  await until(async () => (await task(paint))?.status !== "blocked", "the answer to take", 20).catch(() => {});
  await sleep(1_000);
  await settled(paint);
  const painted = await task(paint);
  check("pageAnswerResumesIt", painted?.status === "done" && /sage/i.test(painted.result ?? ""), { status: painted?.status, result: painted?.result, turns: painted?.turns });
  check("pageLinksItsChat", Boolean(hasChatLink));

  // --- 3, 4. Asked for in a chat: the question and the result come back to that chat ----------
  const chat = await newChat();
  await ask(chat, "Queue a background task for me with queue_task, don't do it here: find out which restaurant I want for dinner on Saturday. The task doesn't know and must ask me with finish_task blocked; once I answer, it finishes done with the restaurant and a time. Just confirm it's queued.");
  const dinner = (await tasks()).find((item) => item.origin === chat);
  check("chatQueuesATask", Boolean(dinner) && dinner?.status !== "cancelled", dinner ? { title: dinner.title, status: dinner.status } : await tasks());
  if (dinner) await settled(dinner._id);
  const question = dinner ? await task(dinner._id) : undefined;
  await until(async () => (await messagesOf(chat)).some((message) => /needs you/.test(message.text)), "the question in the chat", 20).catch(() => {});
  check("questionComesBackToTheChat", question?.status === "blocked" && (await messagesOf(chat)).some((message) => /needs you/.test(message.text)) && !toPhone(new RegExp(dinner?.title ?? "^$")).length,
    { status: question?.status, question: question?.question });
  await ask(chat, "For that task's question: Toit in Indiranagar, at 8pm. Pass it on so it carries on.");
  if (dinner) { await until(async () => (await task(dinner._id))?.status !== "blocked", "resume_task", 30).catch(() => {}); await sleep(1_000); await settled(dinner._id); }
  const booked = dinner ? await task(dinner._id) : undefined;
  await until(async () => (await messagesOf(chat)).some((message) => /is done/.test(message.text)), "the result in the chat", 20).catch(() => {});
  check("chatAnswerResumesIt", booked?.status === "done" && /toit/i.test(booked.result ?? ""), { status: booked?.status, result: booked?.result });
  check("resultComesBackToTheChat", (await messagesOf(chat)).some((message) => /is done/.test(message.text) && /toit/i.test(message.text)));

  sampling = false;
  await sampler;
  check("neverTwoAtOnce", mostAtOnce === 1, { mostAtOnce });
  await go("/work?tab=plans");
  await shot("work-plans-done.png");
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  sampling = false;
  // Each task's own chat, for reading what it did.
  notes.taskChats = await Promise.all((await tasks().catch(() => [] as Task[])).filter((item) => item.conversationId).map(async (item) => ({
    title: item.title, turns: item.turns, messages: (await messagesOf(item.conversationId!).catch(() => [] as Message[])).reverse().map((message) => `${message.role}: ${message.text.slice(0, 400)}`),
  })));
  browser?.close();
  stop(runner);
  stop(server);
  stub.close();
  await sleep(2_000);
  notes.telegram = telegram.sent.map(({ text }) => text.slice(0, 300));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
