import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/follow-ups/run.ts <outDir>
// Perry follows up on what the owner left open, the way a friend asks how it
// went. A fresh PERRY_HOME, the production build (`pnpm build` first) on a free
// port, a stand-in Telegram Bot API, and the real runner and Codex (signed in
// with ChatGPT) for the part only a model can show. The transcript is kept in
// result.json; the temp folder is deleted at the end.
//
// Ways it could fail, checked without Codex:
//   1. The heartbeat and a briefing are not told what is open: their prompts
//      must list the open threads with ids; a one-time reminder and the daily
//      summary must not.
//   2. Threads are brought up again that should not be: one already asked
//      about, and one settled (superseded by its outcome), must not be listed.
//   3. The "asked: <id>" line reaches the owner, or does not stop a second
//      question: Telegram must get the message without it, the job's last
//      result must not keep it, and that thread must be tagged asked.
//   4. A proactive message is lost to the chat: it must be kept on the owner's
//      Telegram chat for the next turn, and saved in that chat's history.
// And with Codex:
//   5. The heartbeat does not ask: with a dentist call that has passed, it must
//      send one question about it, and mark it asked.
//   6. It asks about what has not happened: the interview next week must not
//      be marked asked.
//   7. The owner's answer is not understood: replying "It went fine, they
//      booked a filling for Tuesday" must get a reply about that, the turn
//      must be told what was sent (the kept messages are then cleared), and the
//      open note must be superseded by the outcome (which may itself stay open
//      when it brings something new, like the filling on Tuesday).
//   8. It asks twice: the next heartbeat must not ask about the dentist again.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/follow-ups/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "follow-ups-e2e-key";
const OWNER = "4242";
const home = mkdtempSync(join(tmpdir(), "perry-follow-ups-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

// --- A stand-in Telegram -------------------------------------------------------------

const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[], nextUpdate: 1 };
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
    if (method === "sendMessage") { telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), at: Date.now() }); return reply({ message_id: telegram.sent.length }); }
    // Replies stream: sent once, then edited into the full text.
    if (method === "editMessageText") { const message = telegram.sent[Number(args.message_id) - 1]; if (message) message.text = String(args.text); return reply(true); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false, first_name: "Owner" }, text },
});

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:follow-ups-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL") delete env[name];
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
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};

async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-perry-key": KEY },
    body: JSON.stringify({ path, args }),
  });
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
type Memory = { id: string; text: string; tags: string[] };
type Job = { id: string; name: string; builtin?: string; lastRunAt?: number; lastResult?: string; lastError?: string };
type Chat = { _id: string; threadId: string; unprompted?: Array<{ at: number; text: string }> };
const daily = () => call<Memory[]>("dashboard:listMemories", { key: KEY, query: "", kind: "daily" });
const remember = (text: string, tags: string[], supersedes?: string[]) =>
  call<{ id: string }>("memories:add", { text, tags, source: "e2e", kind: "daily", origin: "owner", ...(supersedes ? { supersedes } : {}) }).then((result) => result.id);
const jobs = () => call<Job[]>("jobs:list");
const ownerChat = () => call<Chat | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER });
const promptOf = async (name: string) => (await call<Array<{ prompt: string }>>("dashboard:listRuns", { key: KEY })).find((run) => run.prompt.includes(`⏰ ${name} (`))?.prompt ?? "";
const toOwner = (after: number) => telegram.sent.filter((message) => message.chat_id === OWNER && message.at > after);
/** Run a job now, as the scheduler does, and wait for its result to come back. */
async function runJob(job: Job, seconds = 300): Promise<Job> {
  const before = (await jobs()).find((item) => item.id === job.id)!;
  await call("jobs:run", { id: job.id });
  let done: Job | undefined;
  await until(async () => {
    done = (await jobs()).find((item) => item.id === job.id);
    return Boolean(done && (done.lastResult !== before.lastResult || done.lastError !== before.lastError) && (done.lastResult || done.lastError));
  }, `${job.name} to finish`, seconds);
  return done!;
}

let server: ChildProcess | null = start("server");
let runner: ChildProcess | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  await until(async () => Boolean((await jobs()).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  const builtin = async (name: string) => (await jobs()).find((job) => job.builtin === name)!;

  // --- What the owner has left open -------------------------------------------------
  const dentist = await remember("The owner had a call with the dentist yesterday at 16:00 about a possible filling.", ["open"]);
  const interview = await remember("The owner has a job interview with Acme next Thursday at 10:00.", ["open"]);
  const flat = await remember("The owner is waiting to hear back about the flat on Elm Street.", ["open"]);
  const offer = await remember("The owner will decide about the Berlin offer by Friday.", ["open"]);
  await remember("The owner accepted the Berlin offer.", [], [offer]);
  const parcel = await remember("The owner is expecting a parcel from their sister.", ["open"]);

  // 3 and 4, with a briefing that asks about the parcel, naming it after the question as models do
  // (the flat, below, is named on a line of its own).
  const brief = await call<{ id: string }>("jobs:create", { name: "Morning brief", schedule: "0 7 * * *", prompt: "Brief me on my day." });
  const sentBefore = Date.now();
  await call("jobs:finished", { id: brief.id, result: `Good morning. Did your sister's parcel arrive? asked: ${parcel}` });
  await until(() => toOwner(sentBefore).some((message) => message.text.includes("parcel")), "the brief on Telegram", 30);
  const briefMessage = toOwner(sentBefore).find((message) => message.text.includes("parcel"))!;
  const briefJob = (await jobs()).find((job) => job.id === brief.id)!;
  checks.askedLineRemoved = !/asked:/i.test(briefMessage.text) && !/asked:/i.test(briefJob.lastResult ?? "");
  checks.askedThreadTagged = (await daily()).find((memory) => memory.id === parcel)?.tags.includes("asked") === true;
  const chatAfterBrief = await ownerChat();
  const history = chatAfterBrief ? await call<{ page: Array<{ text?: string }> }>("agentStore:listMessages", { threadId: chatAfterBrief.threadId, paginationOpts: { numItems: 10, cursor: null } }) : { page: [] };
  checks.proactiveKeptForNextTurn = chatAfterBrief?.unprompted?.some((message) => message.text.includes("parcel")) === true;
  checks.proactiveInChatHistory = history.page.some((message) => message.text?.includes("sister's parcel"));

  // 1 and 2: what each kind of job is told. No runner yet, so the turns stop at the queue; their prompts are kept.
  const reminder = await call<{ id: string }>("jobs:create", { name: "Call the bank", at: new Date(Date.now() + 86_400_000).toISOString(), prompt: "Remind me to call the bank." });
  await call("jobs:run", { id: brief.id });
  await call("jobs:run", { id: reminder.id });
  await call("jobs:run", { id: (await builtin("daily-summary")).id });
  await until(async () => Boolean(await promptOf("Morning brief")) && Boolean(await promptOf("Call the bank")) && Boolean(await promptOf("Daily summary")), "the three prompts", 30);
  const briefPrompt = await promptOf("Morning brief");
  notes.briefPrompt = briefPrompt;
  checks.briefToldOpenThreads = briefPrompt.includes("Threads the owner left open") && briefPrompt.includes(dentist) && briefPrompt.includes(interview) && briefPrompt.includes(flat);
  checks.settledAndAskedLeftOut = !briefPrompt.includes(offer) && !briefPrompt.includes(parcel);
  checks.othersNotTold = !(await promptOf("Call the bank")).includes("Threads the owner left open") && !(await promptOf("Daily summary")).includes("Threads the owner left open");
  // The flat was asked about in an earlier run; mark it so, as a reply would.
  await call("jobs:finished", { id: brief.id, result: `NOTHING\nasked: ${flat}` });

  // --- With Codex -------------------------------------------------------------------
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  // The chats use a model the account takes, as /model would set: Codex's own default comes from
  // ~/.codex/config.toml, which may name one a ChatGPT sign-in cannot use. PERRY_E2E_MODEL overrides.
  await until(async () => (await call<unknown[]>("models:list")).length > 0, "the runner's model list", 60);
  const models = await call<Array<{ id: string; isDefault: boolean }>>("models:list");
  const model = process.env.PERRY_E2E_MODEL ?? (models.find((item) => item.id === "gpt-5.5") ?? models.find((item) => !item.isDefault) ?? models[0]).id;
  notes.model = model;
  const heartbeatThread = await call<string>("agentStore:createThread", { userId: "web:dashboard", title: "⏰ Heartbeat" });
  const heartbeatChat = await call<{ externalId: string }>("jobs:chatFor", { id: (await builtin("heartbeat")).id, threadId: heartbeatThread });
  for (const chat of [await call<Chat>("conversations:getByExternalId", { channel: "web", externalId: heartbeatChat.externalId }), await ownerChat()]) {
    await call("conversations:setModel", { id: chat!._id, model });
  }

  // 5 and 6: the heartbeat asks about the dentist call, not the interview.
  const heartbeatAt = Date.now();
  const firstBeat = await runJob(await builtin("heartbeat"));
  notes.firstHeartbeat = firstBeat.lastResult ?? firstBeat.lastError;
  const heartbeatPrompt = await promptOf("Heartbeat");
  checks.heartbeatToldOpenThreads = heartbeatPrompt.includes(dentist) && !heartbeatPrompt.includes(flat);
  await until(() => toOwner(heartbeatAt).some((message) => message.text.startsWith("⏰ Heartbeat")), "the heartbeat on Telegram", 30).catch(() => {});
  const beat = toOwner(heartbeatAt).find((message) => message.text.startsWith("⏰ Heartbeat"));
  const threads = await daily();
  checks.heartbeatAsksAboutDentist = Boolean(beat && /dentist/i.test(beat.text) && beat.text.includes("?") && !/asked:/i.test(beat.text));
  checks.dentistMarkedAsked = threads.find((memory) => memory.id === dentist)?.tags.includes("asked") === true;
  checks.interviewNotAsked = threads.find((memory) => memory.id === interview)?.tags.includes("asked") !== true;

  // 7: the owner answers on Telegram, and Perry knows what the answer is to.
  const replyAt = Date.now();
  ownerSays("It went fine, they booked a filling for Tuesday.");
  await until(() => toOwner(replyAt).some((message) => !message.text.startsWith("⏰")), "Perry to answer the owner", 300);
  await until(async () => !(await ownerChat())?.unprompted?.length, "the kept messages to be cleared", 30).catch(() => {});
  await sleep(20_000); // the reply's memory write lands as the turn ends
  const answer = toOwner(replyAt).filter((message) => !message.text.startsWith("⏰")).map((message) => message.text).join("\n");
  const after = await daily();
  notes.answer = answer;
  notes.dailyAfterAnswer = after.map((memory) => `${memory.text} ${memory.tags.map((tag) => `#${tag}`).join(" ")}`);
  checks.answerUnderstood = /filling|tuesday|dentist/i.test(answer) && !/what went fine|which|what do you mean/i.test(answer);
  checks.keptMessagesCleared = !(await ownerChat())?.unprompted?.length;
  // The outcome may stay #open when it brings something new to follow up on, like the filling on Tuesday.
  checks.openNoteSuperseded = !after.some((memory) => memory.id === dentist) && after.some((memory) => /filling/i.test(memory.text) && /tuesday/i.test(memory.text));

  // 8: the next heartbeat leaves the dentist alone.
  const secondAt = Date.now();
  const secondBeat = await runJob(await builtin("heartbeat"));
  notes.secondHeartbeat = secondBeat.lastResult ?? secondBeat.lastError;
  await sleep(3_000);
  checks.noSecondQuestion = !(await promptOf("Heartbeat")).includes(dentist) && !toOwner(secondAt).some((message) => /dentist/i.test(message.text) && message.text.includes("?"));
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  stop(runner);
  stop(server);
  stub.close();
  await sleep(2_000);
  notes.telegram = telegram.sent.map(({ chat_id, text }) => ({ chat_id, text }));
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
