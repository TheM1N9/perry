import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";
import { FAKE_AGENT, redact } from "../engine-acp/harness";

// bun artifacts/pause/run.ts <outDir> <workDir>
//
// Pause Perry (issue #204), end to end: one switch that stops what runs and
// starts nothing new, from the dashboard, the pet and both phones, and that
// lets the owner choose what missed schedules to run once he is back. A fresh
// Perry from the production build (`pnpm build` first) on a spare port, with
// its own PERRY_HOME under <workDir>; the real runner, whose only engine is the
// fake ACP agent playing Grok Build (artifacts/engine-acp/fake-agent.ts, with
// LINGER for long turns), Codex and Claude Code given empty homes, so no real
// model turn runs; a stand-in Telegram Bot API and the stand-in WhatsApp
// driver (artifacts/whatsapp/fake-driver.mjs), so no real account is reached;
// headless Chrome (artifacts/browser.ts) for the dashboard and the pet.
//
// Ways it could fail, written down before the checks:
//   1. Pausing leaves a reply, a scheduled job's run or a background task running,
//      or one that was claimed a moment before the pause starts anyway.
//   2. A turn that was queued, or a message that joins a running reply, runs later,
//      on resume, by surprise.
//   3. Something still starts while paused: a due schedule, the heartbeat, a watch,
//      an event (a file landing in a watched folder), a background task's next turn,
//      a message from the web, or a chat's title.
//   4. A stopped background task fails, or carries on by itself on resume.
//   5. The pause declines or expires approvals that were waiting.
//   6. Phone messages go unanswered while paused, or get a turn; someone else is
//      told how to resume; the owner is not.
//   7. /pause or /resume does nothing from the web composer, Telegram or WhatsApp,
//      or the pet's Resume does nothing.
//   8. The paused state is lost when the server restarts, or never clears.
//   9. Resuming runs the missed schedules by itself; or they are not listed, on the
//      dashboard or the phone; or running one from the list does not run it, or
//      runs the others too.
//  10. The dashboard and the pet do not show it, in light or dark, or a page throws.

const [outArg, workArg] = process.argv.slice(2);
if (!outArg || !workArg) throw new Error("usage: bun artifacts/pause/run.ts <outDir> <workDir>");
const OUT = resolve(outArg);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
mkdirSync(OUT, { recursive: true });
const work = join(resolve(workArg), `run-${Date.now()}`);
const home = join(work, "home");
const fakeHome = join(work, "fake-grok");
const watched = join(work, "inbox-folder");
for (const dir of [home, fakeHome, watched, join(work, "codex-empty"), join(work, "claude-empty")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(fakeHome, "grok-signed-in"), "yes");

const free = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await free();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pause-e2e-key";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

const PAUSED_OWNER = "Perry is paused, so nothing runs. Send /resume to start again.";
const PAUSED_REPLY = "Perry is paused.";
const PAUSED_ERROR = "Perry is paused. Resume him to start this.";

// --- The stand-in WhatsApp -----------------------------------------------------------

const OWNER_WA = "919876543210@s.whatsapp.net";
const SAM = "15557770000@s.whatsapp.net";
type Sent = { jid: string; id: string; text?: string; at: number };
const wa = { commands: [] as object[], sent: [] as Sent[], connects: 0 };
const control = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const done = (value: unknown = true) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/next") {
      if (wa.commands.length) return done(wa.commands.splice(0));
      return void setTimeout(() => done(wa.commands.splice(0)), 400);
    }
    if (request.url === "/sent") wa.sent.push({ ...data, at: Date.now() });
    if (request.url === "/connect") wa.connects += 1;
    done();
  });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
let waId = 0;
const whatsapp = (jid: string, text: string, name: string) => wa.commands.push({
  event: "messages.upsert",
  data: { type: "notify", messages: [{ key: { id: `IN${Date.now()}${++waId}`, remoteJid: jid, fromMe: false }, pushName: name, message: { conversation: text } }] },
});
const waTo = (jid: string, after: number) => wa.sent.filter((message) => message.jid === jid && message.at > after && message.text).map((message) => message.text!);

// --- The stand-in Telegram -------------------------------------------------------------

const OWNER_TG = 4242;
const TG_STRANGER = 5555;
const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[] };
let updateId = 0;
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    if (method === "getMe") return reply({ id: 999, is_bot: true, username: "perry_test_bot", first_name: "Perry" });
    if (method === "sendMessage" || method === "editMessageText") { telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), at: Date.now() }); return reply({ message_id: telegram.sent.length }); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const tg = (from: { id: number; name: string }, text: string) => telegram.pending.push({
  update_id: ++updateId,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: "private" }, from: { id: from.id, is_bot: false, first_name: from.name }, text },
});
const tgTo = (chat: number, after: number) => telegram.sent.filter((message) => message.chat_id === String(chat) && message.at > after).map((message) => message.text);

// --- Perry -------------------------------------------------------------------------------

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "grok",
  TELEGRAM_BOT_TOKEN: "123456:pause-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
  PERRY_WHATSAPP_DRIVER: join(REPO, "artifacts", "whatsapp", "fake-driver.mjs"),
  PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
  // The runner's engines: the fake agent as Grok Build; Codex and Claude Code with nothing signed in.
  PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`,
  FAKE_ACP_HOME: fakeHome,
  CODEX_HOME: join(work, "codex-empty"),
  CLAUDE_CONFIG_DIR: join(work, "claude-empty"),
  PERRY_ACP_IDLE_MS: "600000",
};
for (const name of Object.keys(env)) {
  if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE"
    || name === "OPENAI_API_KEY" || name === "ANTHROPIC_API_KEY" || name === "XAI_API_KEY" || name === "GEMINI_API_KEY") delete env[name];
}
const logs = { server: "", runner: "" };
const children: ChildProcess[] = [];
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child = spawn(command, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  children.push(child);
  return child;
}
function stop(child: ChildProcess | null) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}
async function call<T>(path: string, args: object = {}, as: "admin" | "call" = "admin"): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${as}`, { method: "POST", headers: { "content-type": "application/json", ...(as === "admin" ? { "x-perry-key": KEY } : {}) }, body: JSON.stringify({ path, args }) });
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
type Row = Record<string, any> & { _id: string };
function table(name: string): Row[] {
  const script = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); db.exec("PRAGMA busy_timeout = 5000");
process.stdout.write(JSON.stringify(db.prepare('SELECT _id, doc FROM "doc_' + process.argv[2] + '"').all()));`;
  const ran = spawnSync("node", ["-e", script, join(home, "perry.sqlite"), name], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (ran.status !== 0) throw new Error(`sqlite: ${ran.stderr}`);
  return (JSON.parse(ran.stdout || "[]") as Array<{ _id: string; doc: string }>).map((row) => ({ _id: row._id, ...JSON.parse(row.doc) }));
}
const fakeLog = (): Array<Record<string, any>> => {
  const file = join(fakeHome, "log.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const turnsOf = (chat?: string) => table("codexTurns").filter((turn) => turn.conversationId === chat).sort((a, b) => a.createdAt - b.createdAt);
const lastTurn = (chat?: string) => turnsOf(chat).at(-1);
type Job = { id: string; name: string; builtin?: string; chatId?: string; enabled: boolean };
const jobs = () => call<Job[]>("jobs:list");
const jobNamed = async (name: string) => (await jobs()).find((job) => job.name === name)!;
type PauseView = { paused: { at: number; by: string } | null; missed: Array<{ id: string; name: string; runs: number; stopped?: boolean; when: string }> };
const pauseView = () => call<PauseView>("pause:status", { key: KEY });
type Pending = { id: string; kind: string; title: string };
const pending = () => call<Pending[]>("approvals:pending", { key: KEY });

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
let server: ChildProcess | null = null;
const pageErrors: Array<{ page: string; error: string }> = [];
try {
  server = start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  const { code } = await call<{ code: string }>("installation:startPairing");
  tg({ id: OWNER_TG, name: "Mani" }, code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "Telegram to be paired", 30);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  await call("jobs:setTimezone", { key: KEY, timezone: "Asia/Kolkata" });

  // Perry's own WhatsApp number, claimed by the owner.
  await call("whatsapp:startLinking", { key: KEY, mode: "separate" }, "call");
  await until(() => wa.connects >= 1, "WhatsApp to start");
  wa.commands.push({ user: { id: "15550001111:7@s.whatsapp.net", name: "Perry" } }, { event: "connection.update", data: { connection: "open" } });
  await until(async () => (await call<{ status: string }>("whatsapp:status", { key: KEY }, "call")).status === "connected", "WhatsApp connected");
  const { pairingCode } = await call<{ pairingCode?: string }>("whatsapp:status", { key: KEY }, "call");
  let at = Date.now();
  whatsapp(OWNER_WA, `my code: ${pairingCode}`, "Mani");
  await until(() => waTo(OWNER_WA, at).some((text) => text.startsWith("Paired.")), "the owner to claim WhatsApp", 30);

  start("runner");
  await until(async () => (await call<Array<{ online: boolean; engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY }))
    .some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with the fake Grok signed in", 120);
  const usable = (await call<Array<{ engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY })).flatMap((item) => item.engines.filter((engine) => engine.signedIn).map((engine) => engine.kind));
  check("onlyFakeEngines", usable.length > 0 && usable.every((kind) => kind === "grok"), usable);

  // A schedule an event starts: a file landing in a folder (server/triggers.ts).
  await call("jobs:saveFromDashboard", { key: KEY, name: "New file", prompt: "Say what file arrived, in one line.", folder: watched });
  // Sam writes before the pause: the owner is asked about him, and the pause must leave that alone.
  at = Date.now();
  whatsapp(SAM, "Hi, I'm Sam, Mani's brother. Are you his assistant?", "Sam");
  await until(async () => (await pending()).some((item) => item.kind === "contact" && item.title.includes("Sam")), "the owner to be asked about Sam", 30);
  const samAsk = (await pending()).find((item) => item.kind === "contact" && item.title.includes("Sam"))!;

  // --- 1-3. Pausing stops what runs. The fake engine runs one turn at a time, as Grok Build's ACP server is driven,
  // so each kind of work is paused on its own: a reply waiting on an approval, a scheduled job's run, a background
  // task, and last a long reply, paused from Telegram, which stays paused for the rest.
  const settled = (chat?: string) => { const turn = lastTurn(chat); return Boolean(turn && turn.status !== "running" && turn.status !== "queued"); };
  const ofTurn = (chat?: string) => { const turn = lastTurn(chat); return turn && { status: turn.status, stopped: turn.stopped, error: turn.error }; };
  const stoppedOk = (chat?: string) => { const turn = lastTurn(chat); return turn?.status === "done" && turn.stopped === true && !turn.error; };
  const cancels = () => fakeLog().filter((entry) => entry.method === "session/cancel").length;
  const set = (paused: boolean, from: "web" | "pet" = "web") => call("pause:set", { key: KEY, paused, from });

  // A reply waiting for the owner's yes to a command.
  const asking = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: asking, text: "RUN echo pause-test" });
  await until(async () => (await pending()).some((item) => item.kind === "command"), "the command's approval", 90);
  const commandAsk = (await pending()).find((item) => item.kind === "command")!;
  await set(true);
  await until(() => settled(asking), "the reply waiting on an approval to stop", 90);
  const commandAfter = table("approvals").find((row) => row._id === commandAsk.id)?.status;
  check("pauseStopsAReplyWaitingOnApproval", stoppedOk(asking), ofTurn(asking));
  await set(false);

  // A scheduled job's run, paused from the pet.
  await call("jobs:create", { name: "Long job", schedule: "0 0 1 1 *", prompt: "Count slowly. LINGER 300" });
  await call("jobs:trigger", { id: (await jobNamed("Long job")).id });
  await until(() => fakeLog().some((entry) => entry.lingering && String(entry.prompt).includes("Long job")), "the job to be under way", 90);
  const longJob = await jobNamed("Long job");
  let before = cancels();
  await set(true, "pet");
  await until(() => settled(longJob.chatId), "the job's run to stop", 90);
  check("pauseStopsAJob", stoppedOk(longJob.chatId) && cancels() > before && (await pauseView()).paused?.by === "pet", ofTurn(longJob.chatId));
  check("stoppedJobListedAsMissed", (await pauseView()).missed.some((item) => item.name === "Long job" && item.stopped), (await pauseView()).missed);
  await set(false);

  // A background task.
  const taskId = await call<string>("tasks:queue", { title: "Long task", prompt: "Work through it slowly. LINGER 300" });
  await until(() => fakeLog().some((entry) => entry.lingering && String(entry.prompt).includes("Long task")), "the task to be under way", 90);
  const taskChat = table("tasks").find((row) => row._id === taskId)?.conversationId;
  before = cancels();
  await set(true);
  await until(() => settled(taskChat), "the task's turn to stop", 90);
  await sleep(3_000);
  const task = table("tasks").find((row) => row._id === taskId)!;
  check("pauseStopsATask", stoppedOk(taskChat) && cancels() > before, ofTurn(taskChat));
  check("stoppedTaskWaitsForTheOwner", task.status === "blocked" && /paused/i.test(task.question ?? ""), { status: task.status, question: task.question });
  await set(false);

  // A long reply, paused with /pause on Telegram.
  const reply = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: reply, text: "LINGER 300 (a long reply)" });
  await until(() => fakeLog().some((entry) => entry.lingering && String(entry.prompt).includes("a long reply")), "the reply to be under way", 90);
  before = cancels();
  at = Date.now();
  tg({ id: OWNER_TG, name: "Mani" }, "/pause");
  await until(() => tgTo(OWNER_TG, at).some((text) => text.startsWith("Paused.")), "Telegram to confirm the pause", 30);
  const pausedAt = (await pauseView()).paused?.at ?? 0;
  notes.pauseReply = tgTo(OWNER_TG, at);
  await until(() => settled(reply), "the reply to stop", 90);
  check("pauseStopsAReply", stoppedOk(reply) && cancels() > before, ofTurn(reply));
  const viewAfterPause = await pauseView();
  check("pausedFromTelegram", viewAfterPause.paused?.by === "telegram" && tgTo(OWNER_TG, at).some((text) => text.includes("/resume")), { paused: viewAfterPause.paused, said: notes.pauseReply });

  // Approvals stay pending: Sam's, and the command's, through every pause and resume.
  const still = await pending();
  const commandRow = table("approvals").find((row) => row._id === commandAsk.id);
  check("approvalsStayPending", still.some((item) => item.id === samAsk.id) && commandAfter === "pending" && commandRow?.status === "pending",
    { pending: still.map((item) => ({ kind: item.kind, title: item.title.slice(0, 60) })), commandRightAfterPause: commandAfter, commandNow: commandRow?.status });

  // --- 4. Nothing starts while paused -------------------------------------------------------------------------------
  // A due schedule, and the heartbeat made due: both come due at the next minute's tick.
  await call("jobs:create", { name: "Every minute", schedule: "* * * * *", prompt: "Say hello." });
  // The built-in jobs are made by the minute's tick; one now makes sure (paused, it starts nothing).
  await call("jobs:tick");
  const heartbeat = (await jobs()).find((job) => job.builtin === "heartbeat");
  if (!heartbeat) throw new Error(`no heartbeat among ${JSON.stringify((await jobs()).map((job) => [job.name, job.builtin]))}`);
  await call("jobs:update", { id: heartbeat.id, schedule: "* * * * *" });
  // An event: a file lands in the watched folder.
  await sleep(2_000);
  writeFileSync(join(watched, "invoice-0420.pdf"), "not really a pdf");
  // A watch due now.
  await call("dashboard:saveMonitor", { key: KEY, title: "Example", url: "https://example.com/", condition: "change", intervalMinutes: 5 });
  const watch = table("monitors").find((row) => row.title === "Example")!;
  await call("web:checkMonitors");
  await until(async () => {
    const names = (await pauseView()).missed.map((item) => item.name);
    return ["Every minute", "Heartbeat", "New file"].every((name) => names.includes(name));
  }, "the schedule, the heartbeat and the event to be missed", 130);
  const missedWhilePaused = (await pauseView()).missed;
  const eventJob = table("jobs").find((row) => row.name === "New file");
  check("eventHeld", Boolean(eventJob?.missed?.event?.includes("invoice-0420.pdf")) && !eventJob?.conversationId, eventJob?.missed);
  check("watchHeld", table("monitors").find((row) => row._id === watch._id)?.lastCheckedAt === undefined);
  const webRefused = await call("dashboard:sendChat", { key: KEY, id: reply, text: "Are you there?" }).then(() => "sent", (error: Error) => error.message);
  check("webMessageRefused", webRefused.includes(PAUSED_ERROR), webRefused);
  const runNowRefused = await call("jobs:runNow", { key: KEY, id: heartbeat.id }).then(() => "ran", (error: Error) => error.message);
  check("runNowRefused", runNowRefused.includes(PAUSED_ERROR), runNowRefused);

  // --- 5. Phone messages while paused -------------------------------------------------------------------------------
  at = Date.now();
  tg({ id: OWNER_TG, name: "Mani" }, "hello, can you check my calendar?");
  whatsapp(OWNER_WA, "hey, are you there?", "Mani");
  tg({ id: TG_STRANGER, name: "Rando" }, "hi, who is this?");
  await until(() => tgTo(OWNER_TG, at).length > 0 && waTo(OWNER_WA, at).length > 0, "the owner's paused replies", 30);
  // Sam is allowed while paused: answering an approval still works, and he hears only that Perry is paused.
  await call("approvals:decide", { key: KEY, id: samAsk.id, approved: true });
  await until(() => waTo(SAM, at).length > 0, "Sam's paused reply", 30);
  whatsapp(SAM, "So can you help me with something?", "Sam");
  await until(() => waTo(SAM, at).length > 1, "Sam's second paused reply", 30);
  await sleep(4_000);
  const owner = { telegram: tgTo(OWNER_TG, at), whatsapp: waTo(OWNER_WA, at) };
  const sam = waTo(SAM, at);
  // The owner's Telegram also hears that the stranger wrote (an approval); only replies to what the owner sent count here.
  const answers = { telegram: owner.telegram.filter((text) => !text.includes("Rando")), whatsapp: owner.whatsapp };
  check("ownerToldHowToResume", answers.telegram.length === 1 && answers.whatsapp.length === 1 && [...answers.telegram, ...answers.whatsapp].every((text) => text === PAUSED_OWNER), owner);
  check("othersToldOnlyPaused", sam.length === 2 && sam.every((text) => text === PAUSED_REPLY), sam);
  check("strangerStillUnanswered", tgTo(TG_STRANGER, at).length === 0);

  // Nothing at all reached the engine while paused.
  const promptsWhilePaused = fakeLog().filter((entry) => entry.prompt !== undefined && entry.at > pausedAt);
  const startedWhilePaused = table("codexTurns").filter((turn) => turn.createdAt > pausedAt || (turn.startedAt ?? 0) > pausedAt);
  check("nothingStartsWhilePaused", promptsWhilePaused.length === 0 && startedWhilePaused.length === 0 && table("tasks").find((row) => row._id === taskId)?.status === "blocked",
    { prompts: promptsWhilePaused.map((entry) => String(entry.prompt).slice(0, 60)), turns: startedWhilePaused.map((turn) => ({ status: turn.status, prompt: String(turn.prompt).slice(0, 40) })), missed: missedWhilePaused });

  // --- 6. The dashboard and the pet show it -------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errors = []; { const e = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ").slice(0, 300)); e(...a); }; }` });
  const collect = async (page: string) => { for (const error of (await evaluate(`window.__errors ?? []`).catch(() => [])) as string[]) pageErrors.push({ page, error }); };
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const size = (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const shot = async (name: string) => {
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(OUT, name), Buffer.from(image.data, "base64"));
  };
  const go = async (path: string, test: string, what: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(test, what);
    await sleep(800);
  };
  const point = (expression: string) => evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
  const click = async (expression: string) => {
    const at = await point(expression);
    if (!at) throw new Error(`nothing to click: ${expression}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
    }
    await sleep(400);
  };
  const sidebarText = () => evaluate(`document.querySelector('[data-pause-notice]')?.innerText ?? ""`) as Promise<string>;
  for (const theme of ["light", "dark"] as const) {
    await scheme(theme);
    await go("/chat", `document.querySelector('[data-pause-notice="paused"]')`, "the sidebar to say Perry is paused");
    await shot(`dashboard-paused-${theme}.png`);
    await click(`document.querySelector('[data-account-line]')`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent.includes('Resume Perry'))`, "the account menu's Resume Perry");
    await shot(`account-menu-paused-${theme}.png`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await collect(`/chat (${theme})`);
  }
  const shown = { sidebar: await sidebarText(), accountLine: await evaluate(`document.querySelector('[data-account-line]')?.innerText`) };
  check("dashboardShowsPaused", shown.sidebar.includes("Perry is paused") && shown.sidebar.includes("Resume") && shown.accountLine === "Perry is paused", shown);
  await size(404, 620);
  for (const theme of ["light", "dark"] as const) {
    await scheme(theme);
    await go("/pet", `document.body.innerText.includes("I'm paused")`, "the pet to say he is paused");
    await shot(`pet-paused-${theme}.png`);
    await collect(`/pet (${theme})`);
  }
  const petText = await evaluate(`document.body.innerText`) as string;
  check("petShowsPaused", petText.includes("I'm paused") && petText.includes("Resume"), petText.slice(0, 200));
  await size(1280, 800);

  // --- 7. It survives a restart -------------------------------------------------------------------------------------
  stop(server);
  await sleep(3_000);
  server = start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start again", 120);
  const afterRestart = await pauseView();
  const refusedAfterRestart = await call("dashboard:sendChat", { key: KEY, id: reply, text: "Still there?" }).then(() => "sent", (error: Error) => error.message);
  await sleep(5_000);
  check("pauseSurvivesRestart", afterRestart.paused?.at === pausedAt && refusedAfterRestart.includes(PAUSED_ERROR) && fakeLog().filter((entry) => entry.prompt !== undefined && entry.at > pausedAt).length === 0, { paused: afterRestart.paused, refusedAfterRestart });

  // --- 8. /resume from the web composer: nothing missed runs by itself ---------------------------------------------------
  // The minute-by-minute ones go back to their own times first, so any run after the resume would be a surprise.
  await call("jobs:update", { id: heartbeat.id, schedule: "0 9,13,17,21 * * *" });
  await call("jobs:update", { id: (await jobNamed("Every minute")).id, enabled: false });
  const typeInto = (text: string) => evaluate(`(() => {
    const box = document.querySelector('textarea[aria-label^="Message"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const enter = async () => {
    await evaluate(`document.querySelector('textarea[aria-label^="Message"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
    await sleep(1_000);
  };
  await scheme("light");
  await go("/chat", `document.querySelector('textarea[aria-label^="Message"]')`, "the composer");
  const turnsBeforeResume = table("codexTurns").length;
  const tgBeforeResume = Date.now();
  await typeInto("/resume");
  await enter();
  await until(async () => (await pauseView()).paused === null, "the web /resume", 20);
  const resumedAt = Date.now();
  const composerSaid = await evaluate(`document.body.innerText.includes("Perry is back on.")`);
  // The owner's phone hears what was missed, and how to run it from there.
  await until(() => tgTo(OWNER_TG, tgBeforeResume).some((text) => text.includes("didn't run")), "the phone to hear what was missed", 30);
  const phoneList = tgTo(OWNER_TG, tgBeforeResume).find((text) => text.includes("didn't run"))!;
  check("resumedFromWeb", Boolean(composerSaid), { composerSaid });
  check("missedListedOnPhone", ["Long job", "Every minute", "Heartbeat", "New file"].every((name) => phoneList.includes(name)) && phoneList.includes("/run 1"), phoneList);
  // A minute and more: a tick of the schedules, and of the task queue.
  await sleep(70_000);
  const ranAfterResume = table("codexTurns").slice(turnsBeforeResume);
  const blockedTask = table("tasks").find((row) => row._id === taskId);
  check("resumeRunsNothingMissed", ranAfterResume.length === 0 && fakeLog().filter((entry) => entry.prompt !== undefined && entry.at > pausedAt).length === 0 && blockedTask?.status === "blocked",
    { turns: ranAfterResume.map((turn) => String(turn.prompt).slice(0, 60)), task: blockedTask?.status });
  for (const theme of ["light", "dark"] as const) {
    await scheme(theme);
    await go("/chat", `document.querySelector('[data-pause-notice="missed"]')`, "the sidebar to list what was missed");
    await shot(`dashboard-missed-${theme}.png`);
    await collect(`/chat missed (${theme})`);
  }
  const missedShown = await sidebarText();
  check("dashboardListsMissed", ["Long job", "Every minute", "Heartbeat", "New file"].every((name) => missedShown.includes(name)), missedShown);

  // --- 9. Running one from the list runs it, and only it --------------------------------------------------------------
  const everyMinute = await jobNamed("Every minute");
  await click(`[...document.querySelectorAll('[data-missed="Every minute"] button')].find((button) => button.textContent === 'Run')`);
  await until(() => { const turn = lastTurn(table("jobs").find((row) => row._id === everyMinute.id)?.conversationId); return turn?.status === "done"; }, "the missed schedule to run", 90);
  await sleep(5_000);
  const ranNow = table("codexTurns").slice(turnsBeforeResume);
  const leftOver = (await pauseView()).missed.map((item) => item.name);
  check("runningOneRunsOnlyIt", ranNow.length === 1 && String(ranNow[0].prompt).includes("Every minute") && !leftOver.includes("Every minute") && leftOver.includes("Long job"),
    { ran: ranNow.map((turn) => String(turn.prompt).slice(0, 60)), leftOver });
  // The rest let go from WhatsApp.
  at = Date.now();
  whatsapp(OWNER_WA, "/skip", "Mani");
  await until(() => waTo(OWNER_WA, at).length > 0, "WhatsApp's /skip", 30);
  check("skipFromPhone", (await pauseView()).missed.length === 0, waTo(OWNER_WA, at));

  // --- 10. /pause from the web composer; Resume on the pet; /pause and /resume on WhatsApp ----------------------------------------
  await go("/chat", `document.querySelector('textarea[aria-label^="Message"]')`, "the composer");
  await typeInto("/pause");
  await enter();
  await until(async () => (await pauseView()).paused?.by === "web", "the web /pause", 20);
  check("pausedFromWeb", true);
  await size(404, 620);
  await go("/pet", `document.body.innerText.includes("I'm paused")`, "the pet to say he is paused");
  await click(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Resume')`);
  await until(async () => (await pauseView()).paused === null, "the pet's Resume", 20);
  check("resumedFromPet", true);
  await collect("/pet resume");
  await size(1280, 800);
  at = Date.now();
  whatsapp(OWNER_WA, "/pause", "Mani");
  await until(async () => (await pauseView()).paused?.by === "whatsapp", "WhatsApp's /pause", 30);
  whatsapp(OWNER_WA, "/resume", "Mani");
  await until(async () => (await pauseView()).paused === null, "WhatsApp's /resume", 30);
  await until(() => waTo(OWNER_WA, at).length >= 2, "WhatsApp's replies", 30);
  const waReplies = waTo(OWNER_WA, at);
  check("pauseAndResumeFromWhatsApp", waReplies[0].startsWith("Paused.") && waReplies[1] === "Back on.", waReplies);

  // --- 11. Back on, things run again ---------------------------------------------------------------------------------
  const backOn = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: backOn, text: "Hello again" });
  await until(() => lastTurn(backOn)?.status === "done", "a reply after resuming", 90);
  await call("web:checkMonitors");
  check("runsAgainAfterResume", lastTurn(backOn)?.status === "done" && table("monitors").find((row) => row._id === watch._id)?.lastCheckedAt !== undefined);
  check("noPageErrors", browser.errors.length === 0 && pageErrors.length === 0, { exceptions: browser.errors, console: pageErrors });
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
  try {
    notes.debugRuns = table("runs").slice(-12).map((run) => ({ prompt: String(run.prompt).slice(0, 50), status: run.status, error: run.error }));
    notes.debugTurns = table("codexTurns").slice(-12).map((turn) => ({ prompt: String(turn.prompt).slice(0, 50), status: turn.status, stopped: turn.stopped, error: turn.error, engine: turn.engine }));
    notes.debugFake = fakeLog().slice(-20).map((entry) => JSON.stringify(entry).slice(0, 200));
    notes.debugTasks = table("tasks").map((task) => ({ status: task.status, error: task.error }));
  } catch (debugError) { notes.debugError = String(debugError); }
}

browser?.close();
for (const child of children.reverse()) stop(child);
control.close();
stub.close();
await sleep(3_000);
notes.serverLog = logs.server.split("\n").filter((line) => /error|paused/i.test(line)).slice(-20);
notes.runnerLog = logs.runner.split("\n").filter(Boolean).slice(-30);
try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
notes.workRemoved = !existsSync(work);
const result = { ranAt: new Date().toISOString(), engine: "fake Grok Build (artifacts/engine-acp/fake-agent.ts)", checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(OUT, "result.json"), `${redact(JSON.stringify(result, null, 2))}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
