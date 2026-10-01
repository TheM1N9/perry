import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCESSES } from "../../convex/lib/commands";
import { ClaudeEngine } from "../../runner/engines/claude";
import { openChat, sleep } from "../browser";

// bun artifacts/engine-claude/run.ts <outDir>
// Issue: the Claude Code engine (runner/engines/claude.ts). Perry drives the
// owner's own, unmodified `claude` through the Claude Agent SDK, on the login
// the owner made themselves, beside Codex on the same computer. A fresh Perry
// (production build, `pnpm build` first) on a spare port with a temp
// PERRY_HOME, the REAL runner with this machine's REAL signed-in Claude Code
// (a Max plan) and REAL Codex (gpt-6-luna), and headless Chrome for Settings.
// A second runner, with an empty CLAUDE_CONFIG_DIR and CODEX_HOME, plays a
// computer where neither is signed in. Real turns are few and short, on haiku:
// it is the owner's own subscription. Nothing touches the owner's own Perry,
// their ~/.claude settings or their Claude login.
//
// Ways it could fail, written down before the checks:
//   1. Status is wrong: Claude Code missing or signed out when it is signed in,
//      the wrong version, or no account label and plan for Settings.
//   2. Not signed in is not handled: an error instead of "signed out", no
//      `claude auth login` to run, or a Sign out that signs the owner out of
//      their terminal's Claude Code.
//   3. The model list is empty before a session has run, is not replaced by
//      the session's own list afterwards, or the models are not tagged with
//      their engine next to Codex's.
//   4. A web reply does not stream, or is not saved.
//   5. Resume loses the context: the second turn starts a new session, is sent
//      the history again, or does not know what the first said.
//   6. Perry's MCP tools (remember) are never called over HTTP MCP.
//   7. Supervised: the approval never reaches the dashboard, or declining it
//      does not stop the tool.
//   8. Full access still asks, or does not run the command.
//   9. Auto: Claude's reviewer quick turn never runs.
//  10. Stop does not interrupt Claude Code, or the stopped reply is lost.
//  11. A message sent mid-turn is neither joined to the turn nor queued, or is
//      marked applied without Claude having read it.
//  12. /compact fails, or loses the session.
//  13. The quick turn never names a Claude chat.
//  14. Switching a chat Codex -> Claude -> Codex loses the history, hands one
//      engine the other's cursor, or reaches the wrong engine.
//  15. Usage is not recorded on the run.
//  16. The Windows declaration is wrong: a sandbox claimed where Claude Code
//      has none.
//  17. Perry reads Claude's credentials: its code names the credentials file or
//      token variables, passes --bare, or a token shows up in Perry's database
//      or logs.
//  18. Codex and Claude cannot both be signed in on one runner: one hides the
//      other in Settings, in the models, or in /model.
//  19. The dashboard throws, or the runner logs a failed turn.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engine-claude/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "engine-claude-e2e-key";
const CLAUDE_MODEL = "haiku";
const CODEX_MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const NONCE = `e2e-${Date.now().toString(36)}`;
// Plain facts to recall: a random-looking token would be taken for a secret and moved to Keys.
const PETS = ["Pickles", "Marmalade", "Biscuit", "Waffles", "Noodle", "Pepper", "Clementine", "Juniper"];
const CAT = PETS[Math.floor(Math.random() * PETS.length)];
const DOG = PETS.filter((name) => name !== CAT)[Math.floor(Math.random() * (PETS.length - 1))];
const home = mkdtempSync(join(tmpdir(), "perry-engine-claude-"));
const offHome = mkdtempSync(join(tmpdir(), "perry-engine-claude-off-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
/** An email address, as the signed-in account shows one; never written into the artifact. */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

// --- Perry ----------------------------------------------------------------------
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const logs = { server: "", runner: "", off: "" };
function start(name: keyof typeof logs, extra: Record<string, string> = {}): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child = spawn(command, args, { cwd: REPO, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

// The documents themselves, as Perry keeps them in SQLite. Through Node, as Bun has no node:sqlite.
const SQL = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
const statement = db.prepare(process.argv[2]); const params = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? statement.all(...params) : (statement.run(...params), [])));`;
function sql<T>(statement: string, params: Array<string | number> = []): T[] {
  const ran = spawnSync("node", ["-e", SQL, join(home, "perry.sqlite"), statement, JSON.stringify(params)], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (ran.status !== 0) throw new Error(`sqlite: ${ran.stderr}`);
  return JSON.parse(ran.stdout || "[]");
}
type Row = Record<string, any> & { _id: string };
const rows = (table: string): Row[] => sql<{ _id: string; doc: string }>(`SELECT _id, doc FROM "doc_${table}"`)
  .map((row) => ({ _id: row._id, ...JSON.parse(row.doc) }));
const edit = (table: string, id: string, change: string, ...params: Array<string | number>) =>
  sql(`UPDATE "doc_${table}" SET doc = ${change} WHERE _id = ?`, [...params, id]);
const turnsOf = (chat: string) => rows("codexTurns").filter((turn) => turn.conversationId === chat).sort((a, b) => a.createdAt - b.createdAt);

type Chat = { isRunning: boolean; streaming?: string; lastError?: string; engine: string; model?: string; title: string };
const getChat = (id: string) => call<Chat>("dashboard:getChat", { key: KEY, id });
const messagesOf = async (id: string) => (await call<{ page: Array<{ role: string; text: string; createdAt: number }> }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 40, cursor: null } }))
  .page.sort((a, b) => a.createdAt - b.createdAt);
const lastReply = async (id: string) => (await messagesOf(id)).filter((message) => message.role === "assistant").at(-1)?.text ?? "";
const conversation = (id: string) => call<Row>("conversations:getById", { id });
type EngineRow = { kind: string; label: string; installed: boolean; signedIn: boolean; version?: string; message?: string; error?: string; auth: { type?: string; label?: string; plan?: string; email?: string }; request?: { kind: string; status: string; error?: string; interaction?: Record<string, string> } };
type Computer = { id: string; name: string; online: boolean; engines: EngineRow[] };
const computers = () => call<Computer[]>("engines:list", { key: KEY });
type Options = { models: Array<{ id: string; name: string; engine?: string; efforts?: string[] }>; engines: Array<{ kind: string; label: string }> };
const modelOptions = () => call<Options>("models:options", { key: KEY });
/** Send a message and wait for the chat to finish answering it. */
async function ask(chat: string, text: string, seconds = 240) {
  const before = (await messagesOf(chat)).filter((message) => message.role === "assistant").length;
  await call("dashboard:sendChat", { key: KEY, id: chat, text });
  await until(async () => !(await getChat(chat)).isRunning && (await messagesOf(chat)).filter((message) => message.role === "assistant").length > before, `a reply in ${chat}`, seconds);
  return await lastReply(chat);
}
const newChat = async (access: "supervised" | "auto" | "full", model = CLAUDE_MODEL, engine = "claude") => {
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model, engine });
  await call("dashboard:setChatAccess", { key: KEY, id: chat, access });
  return chat;
};
const spansOf = (runId?: string) => rows("runSpans").filter((span) => span.runId === runId);
const claudeStatus = () => spawnSync(process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "claude", process.platform === "win32" ? ["/d", "/s", "/c", "claude auth status --json"] : ["auth", "status", "--json"], { encoding: "utf8", windowsHide: true });

const server = start("server");
let runner: ChildProcess | null = null;
let offRunner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
const workspace = join(home, "workspace");
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  // --- 1, 18. Both engines on one runner, signed in ------------------------------------------------
  await until(async () => (await computers()).some((item) => item.online
    && item.engines.some((engine) => engine.kind === "claude" && engine.signedIn) && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)),
  "the runner to report Codex and Claude Code signed in", 150);
  const config = JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { url: string; token: string };
  const real = (await computers()).find((item) => item.online)!;
  const claudeRow = real.engines.find((engine) => engine.kind === "claude")!;
  const cli = spawnSync(process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "claude", process.platform === "win32" ? ["/d", "/s", "/c", "claude --version"] : ["--version"], { encoding: "utf8", windowsHide: true });
  const cliVersion = cli.stdout.trim().split(/\s+/)[0];
  notes.claudeStatus = claudeRow;
  check("statusReported", claudeRow.installed && claudeRow.signedIn && claudeRow.version === cliVersion && claudeRow.auth.label === "Claude"
    && Boolean(claudeRow.auth.plan) && Boolean(claudeRow.auth.email) && /own Claude subscription/.test(claudeRow.message ?? ""),
  { version: claudeRow.version, cli: cliVersion, auth: claudeRow.auth, message: claudeRow.message });

  // --- 3. Models before any Claude session: the seed list, beside Codex's -----------------------------
  const seeded = await modelOptions();
  const claudeSeed = seeded.models.filter((model) => model.engine === "claude").map((model) => model.id);
  check("modelListSeeded", ["default", "sonnet", "opus", "haiku"].every((id) => claudeSeed.includes(id))
    && seeded.models.some((model) => model.engine === "codex" && model.id === CODEX_MODEL) && seeded.engines.map((item) => item.kind).join(",") === "codex,claude",
  { claude: claudeSeed, engines: seeded.engines });

  // --- 4, 6, 8, 13, 15. A full-access Claude chat: remember, mkdir, a streamed count --------------------
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await newChat("full");
  const fullDir = `perry-claude-full-${NONCE}`;
  const first = `My cat is called ${CAT}. Please save this note to your memory with your remember tool, as a daily memory: "Claude engine check ${NONCE}". Then make a folder called ${fullDir} in the current folder. Then count from one to forty in words, one per line.`;
  await call("dashboard:sendChat", { key: KEY, id: chat, text: first });
  const streamed: string[] = [];
  for (let running = true, stopAt = Date.now() + 240_000; running && Date.now() < stopAt;) {
    const now = await getChat(chat);
    if (now.streaming && streamed.at(-1) !== now.streaming) streamed.push(now.streaming);
    running = now.isRunning || !(await messagesOf(chat)).some((message) => message.role === "assistant");
    await sleep(100);
  }
  const firstReply = await lastReply(chat);
  check("replyStreams", streamed.length >= 2 && streamed.some((text) => text.length < firstReply.length), { snapshots: streamed.length, lengths: streamed.map((text) => text.length).slice(0, 12) });
  check("replySaved", /forty/i.test(firstReply), firstReply.slice(-200));
  const firstTurn = turnsOf(chat)[0];
  const firstRun = rows("runs").find((run) => run._id === firstTurn?.runId);
  const memory = rows("memories").find((row) => String(row.text).includes(NONCE));
  const rememberSpan = spansOf(firstTurn?.runId).find((span) => span.kind === "mcpToolCall" && /remember/.test(span.name));
  check("mcpRememberCalled", Boolean(memory) && rememberSpan?.status === "ok", { memory: memory?.text, span: rememberSpan && { name: rememberSpan.name, status: rememberSpan.status } });
  const commandSpans = spansOf(firstTurn?.runId).filter((span) => span.kind === "command");
  check("fullAccessRunsWithoutAsking", existsSync(join(workspace, fullDir)) && !rows("approvals").some((row) => row.conversationId === chat),
    { folder: existsSync(join(workspace, fullDir)), approvals: rows("approvals").filter((row) => row.conversationId === chat).length, commands: commandSpans.map((span) => `${span.name} (${span.status})`) });
  check("runLabelShape", firstRun?.model === `claude/${CLAUDE_MODEL} · full access` && firstRun.status === "ok", { run: firstRun?.model, status: firstRun?.status });
  check("usageRecorded", (firstRun?.usage?.inputTokens ?? 0) > 0 && (firstRun?.usage?.outputTokens ?? 0) > 0, firstRun?.usage);
  const afterFirst = await conversation(chat);
  const cursor = afterFirst.resume?.cursor as string | undefined;
  check("resumeCursorRecorded", afterFirst.engine === "claude" && afterFirst.resume?.engine === "claude" && /^[0-9a-f-]{36}$/.test(cursor ?? "") && !afterFirst.codexThreadId && firstTurn?.engine === "claude",
    { engine: afterFirst.engine, resume: afterFirst.resume, codexThreadId: afterFirst.codexThreadId ?? null });
  await until(async () => (await getChat(chat)).title !== first.slice(0, 80), "the chat to be named", 90).catch(() => {});
  const title = (await getChat(chat)).title;
  const namedLine = logs.runner.split("\n").find((line) => line.includes(`named a chat "${title}"`)) ?? "";
  check("quickTurnNamesChat", title !== first.slice(0, 80) && title.length > 0 && title.length < 80 && /\(haiku\)/.test(namedLine), { title, log: namedLine.trim() });

  // --- 5. Resume keeps the context ---------------------------------------------------------------------
  const recall = await ask(chat, "What is my cat called? Reply with just the name.");
  const secondTurn = turnsOf(chat)[1];
  const sameSession = (await conversation(chat)).resume?.cursor === cursor;
  check("resumeKeepsContext", recall.toLowerCase().includes(CAT.toLowerCase()) && !secondTurn?.history && sameSession,
    { reply: recall.slice(0, 120), sameSession, historySent: Boolean(secondTurn?.history) });

  // --- 3. The session's own model list replaces the seed at the next report ------------------------------
  let sessionModels: string[] = [];
  await until(async () => {
    sessionModels = (await modelOptions()).models.filter((model) => model.engine === "claude").map((model) => model.id);
    return existsSync(join(home, "claude-models.json")) && sessionModels.join() !== claudeSeed.join();
  }, "the session's model list to be reported", 90).catch(() => {});
  const saved = existsSync(join(home, "claude-models.json")) ? JSON.parse(readFileSync(join(home, "claude-models.json"), "utf8")) as Array<{ id: string; efforts?: string[] }> : [];
  check("modelListFromSession", saved.length > 0 && sessionModels.join() === saved.map((model) => model.id).join() && sessionModels.includes("haiku")
    && saved.some((model) => (model.efforts?.length ?? 0) > 0), { reported: sessionModels, efforts: saved.map((model) => `${model.id}: ${model.efforts?.join("/") ?? "-"}`) });

  // --- 11. A message sent mid-turn joins it ---------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "Run this exact command and wait for it to finish: ping -n 8 127.0.0.1 . Then reply with one short line saying it finished." });
  await until(() => turnsOf(chat).at(-1)?.codexTurnId !== undefined && turnsOf(chat).at(-1)?.status === "running", "the ping turn to start", 90);
  const steeredTurn = turnsOf(chat).at(-1)!;
  await until(() => spansOf(steeredTurn.runId).some((span) => span.kind === "command"), "the ping to start", 60).catch(() => {});
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "Also end your reply with the word pineapple." });
  await until(async () => !(await getChat(chat)).isRunning && rows("codexSteers").some((steer) => steer.turnId === steeredTurn._id && steer.status !== "pending"), "the steered turn to end", 180);
  const steer = rows("codexSteers").find((item) => item.turnId === steeredTurn._id)!;
  const steerReply = await lastReply(chat);
  check("steerJoinsTurn", steer.status === "applied" && steer.engine === "claude" && /pineapple/i.test(steerReply) && turnsOf(chat).length === 3,
    { status: steer.status, error: steer.error, reply: steerReply.slice(-160), turns: turnsOf(chat).length });

  // --- 10. Stop interrupts --------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "Run this exact command in the foreground and wait for it to finish: ping -n 60 127.0.0.1" });
  await until(() => turnsOf(chat).at(-1)?.status === "running" && turnsOf(chat).length === 4, "the long turn to start", 90);
  const longTurn = turnsOf(chat).at(-1)!;
  await until(() => spansOf(longTurn.runId).some((span) => span.kind === "command" && span.status === "running"), "the ping to run", 90).catch(() => {});
  const pingRunning = spansOf(longTurn.runId).some((span) => span.kind === "command" && span.status === "running");
  await sleep(2_000);
  await call("dashboard:stopChat", { key: KEY, id: chat });
  await until(async () => !(await getChat(chat)).isRunning, "the stopped turn to end", 90);
  const stopped = rows("codexTurns").find((turn) => turn._id === longTurn._id)!;
  const stoppedReply = await lastReply(chat);
  check("stopInterrupts", pingRunning && stopped.status === "done" && stopped.stopped === true && /_Stopped\._/.test(stoppedReply) && stopped.finishedAt - stopped.startedAt < 60_000,
    { pingRunning, status: stopped.status, stopped: stopped.stopped, error: stopped.error, ranMs: stopped.finishedAt - stopped.startedAt, reply: stoppedReply.slice(-80) });

  // --- 12. /compact ---------------------------------------------------------------------------------------
  const compaction = await call<string | null>("dashboard:compactChat", { key: KEY, id: chat });
  const compacted = { status: "none", error: undefined as string | undefined };
  if (compaction) {
    await until(async () => {
      Object.assign(compacted, await call<{ status: string; error?: string }>("dashboard:getCompaction", { key: KEY, id: compaction }));
      return compacted.status === "done" || compacted.status === "error";
    }, "the compaction", 300);
  }
  const compactTurn = rows("codexTurns").find((turn) => turn._id === compaction);
  check("compactWorks", compacted.status === "done" && compactTurn?.requestedModel === CLAUDE_MODEL && (await conversation(chat)).resume?.cursor === cursor,
    { ...compacted, model: compactTurn?.requestedModel, sameSession: (await conversation(chat)).resume?.cursor === cursor });

  // --- 7. Supervised: the approval reaches the dashboard, and a decline stops the tool -------------------------
  const askChat = await newChat("supervised");
  const askDir = `perry-claude-ask-${NONCE}`;
  await call("dashboard:sendChat", { key: KEY, id: askChat, text: `Create a folder named ${askDir} in the current directory with mkdir. If you are not allowed to, say so in one short line and stop.` });
  type Pending = { id: string; title: string; chat?: { id: string } };
  let asked: Pending | undefined;
  await until(async () => {
    asked = (await call<Pending[]>("approvals:pending", { key: KEY })).find((item) => item.chat?.id === askChat);
    return Boolean(asked) || !(await getChat(askChat)).isRunning;
  }, "the approval to reach the dashboard", 180);
  if (asked) await call("approvals:decide", { key: KEY, id: asked.id, approved: false });
  await until(async () => !(await getChat(askChat)).isRunning, "the supervised turn to finish", 180);
  const askApproval = rows("approvals").filter((row) => row.conversationId === askChat).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const askTurn = turnsOf(askChat)[0];
  const declinedSpan = spansOf(askTurn?.runId).find((span) => span.kind === "command");
  check("supervisedApprovalReachesDashboard", Boolean(asked) && asked!.title.includes(askDir) && askApproval?.status === "declined" && askApproval.decidedBy === "dashboard",
    { asked: asked?.title, status: askApproval?.status, decidedBy: askApproval?.decidedBy });
  check("declineStopsTool", !existsSync(join(workspace, askDir)) && declinedSpan?.status === "declined",
    { folder: existsSync(join(workspace, askDir)), span: declinedSpan && { name: declinedSpan.name, status: declinedSpan.status }, reply: (await lastReply(askChat)).slice(0, 200) });

  // --- 9. Auto: Claude's own quick turn reviews the command first ------------------------------------------
  const autoChat = await newChat("auto");
  // A harmless write outside the working folder: the reviewer's rules call that caution, so the owner is asked.
  const outside = join(home, `outside-${NONCE}`);
  await call("dashboard:sendChat", { key: KEY, id: autoChat, text: `Please make a new folder at ${outside} with New-Item, then reply in one short line with what happened.` });
  let reviewed: Pending | undefined;
  await until(async () => {
    reviewed = (await call<Pending[]>("approvals:pending", { key: KEY })).find((item) => item.chat?.id === autoChat);
    return Boolean(reviewed) || !(await getChat(autoChat)).isRunning;
  }, "the reviewed request", 180);
  if (reviewed) await call("approvals:decide", { key: KEY, id: reviewed.id, approved: false });
  await until(async () => !(await getChat(autoChat)).isRunning, "the auto turn to finish", 180);
  const autoApproval = rows("approvals").filter((row) => row.conversationId === autoChat).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  // Cleared, it ran unasked; cautioned, the owner declined it and it did not run.
  const reviewHeld = autoApproval?.review?.verdict === "caution" ? autoApproval.status === "declined" && !existsSync(outside)
    : autoApproval?.review?.verdict === "clear" && existsSync(outside);
  check("autoReviewedByClaude", autoApproval?.review?.model === CLAUDE_MODEL && reviewHeld,
    { folder: existsSync(outside), reply: (await lastReply(autoChat)).slice(0, 160), verdict: autoApproval?.review?.verdict, reason: autoApproval?.review?.reason, model: autoApproval?.review?.model, status: autoApproval?.status, title: autoApproval?.title });

  // --- 14. Codex -> Claude -> Codex on one chat --------------------------------------------------------------
  // Chat A has been Claude's from the start; this one starts on Codex.
  const hop = await newChat("full", CODEX_MODEL, "codex");
  const hopSecret = DOG.toLowerCase();
  const onCodex = await ask(hop, `My dog is called ${DOG}. Reply with just: noted.`);
  const codexBefore = await conversation(hop);
  await call("dashboard:setChatModel", { key: KEY, id: hop, model: CLAUDE_MODEL, engine: "claude" });
  const movedToClaude = await conversation(hop);
  const onClaude = await ask(hop, "What is my dog called? Reply with just the name.");
  const claudeTurn = turnsOf(hop).at(-1)!;
  const claudeAfter = await conversation(hop);
  await call("dashboard:setChatModel", { key: KEY, id: hop, model: CODEX_MODEL, engine: "codex" });
  const backOnCodex = await ask(hop, "What is my dog called again? Reply with just the name.");
  const codexTurn = turnsOf(hop).at(-1)!;
  const codexAfter = await conversation(hop);
  const hopRuns = rows("runs").filter((run) => run.conversationId === hop).sort((a, b) => a.startedAt - b.startedAt).map((run) => run.model);
  check("switchCodexClaudeCodex",
    /noted/i.test(onCodex) && codexBefore.resume?.engine === "codex" && Boolean(codexBefore.codexThreadId)
    && movedToClaude.engine === "claude" && !movedToClaude.resume && !movedToClaude.codexThreadId
    && claudeTurn.engine === "claude" && Boolean(claudeTurn.history?.includes(DOG)) && onClaude.toLowerCase().includes(hopSecret)
    && claudeAfter.resume?.engine === "claude" && claudeAfter.resume.cursor !== codexBefore.codexThreadId
    && codexTurn.engine === "codex" && Boolean(codexTurn.history?.includes(DOG)) && backOnCodex.toLowerCase().includes(hopSecret)
    && codexAfter.resume?.engine === "codex" && codexAfter.resume.cursor !== claudeAfter.resume.cursor && codexAfter.codexThreadId === codexAfter.resume.cursor
    && hopRuns[0]?.startsWith(`codex/${CODEX_MODEL}`) && hopRuns[1]?.startsWith(`claude/${CLAUDE_MODEL}`) && hopRuns[2]?.startsWith(`codex/${CODEX_MODEL}`),
  { replies: [onCodex, onClaude, backOnCodex].map((text) => text.slice(0, 80)), runs: hopRuns,
    cursors: { codex: codexBefore.resume, claude: claudeAfter.resume, codexAgain: codexAfter.resume },
    historySeeded: { claude: Boolean(claudeTurn.history), codex: Boolean(codexTurn.history) } });

  // --- 18. /model in a messaging chat lists both engines' models -------------------------------------------------
  const phone = "15550001111@s.whatsapp.net";
  const installation = rows("installation")[0];
  edit("installation", installation._id, "json_set(doc, '$.whatsappOwner', ?)", phone);
  await call("brain:handleTurn", { channel: "whatsapp", externalId: phone, text: "/model" });
  await until(() => rows("whatsappOutbox").some((row) => String(row.text ?? "").includes("models:")), "the /model reply", 30).catch(() => {});
  const listing = rows("whatsappOutbox").map((row) => String(row.text ?? "")).find((text) => text.includes("models:")) ?? "";
  const grouped = await modelOptions();
  check("bothEnginesListed", listing.includes("Codex models:") && listing.includes(CODEX_MODEL) && listing.includes("Claude Code models:") && listing.includes("haiku")
    && grouped.engines.map((item) => item.kind).join(",") === "codex,claude" && grouped.models.every((model) => model.engine === "codex" || model.engine === "claude"),
  listing);

  // --- 2. A computer where Claude Code is not signed in: an empty CLAUDE_CONFIG_DIR, never the owner's -------------
  const offToken = `engine-claude-off-${NONCE}`;
  await call("runner:createToken", { name: "Signed-out computer", token: offToken });
  const offDir = join(offHome, "workspace");
  mkdirSync(offDir, { recursive: true });
  writeFileSync(join(offHome, "runner.json"), JSON.stringify({ url: config.url, token: offToken, name: "Signed-out computer", dir: offDir }));
  const emptyClaude = join(offHome, "claude-config");
  const emptyCodex = join(offHome, "codex-home");
  mkdirSync(emptyClaude, { recursive: true });
  mkdirSync(emptyCodex, { recursive: true });
  offRunner = start("off", { PERRY_HOME: offHome, CLAUDE_CONFIG_DIR: emptyClaude, CODEX_HOME: emptyCodex });
  let off: Computer | undefined;
  await until(async () => {
    off = (await computers()).find((item) => item.name === "Signed-out computer" && item.online && item.engines.some((engine) => engine.kind === "claude"));
    return Boolean(off);
  }, "the signed-out computer to report", 120);
  const offClaude = off!.engines.find((engine) => engine.kind === "claude")!;
  // Asked to sign out, Perry leaves it to the owner's terminal; tried where it can do no harm.
  await call("engines:requestAuth", { key: KEY, runnerId: off!.id, engine: "claude", kind: "logout" });
  await until(async () => (await computers()).find((item) => item.id === off!.id)?.engines.find((engine) => engine.kind === "claude")?.request?.status === "error", "the sign-out to be refused", 60).catch(() => {});
  const refused = (await computers()).find((item) => item.id === off!.id)?.engines.find((engine) => engine.kind === "claude")?.request;

  // --- Settings: both engines on this computer, and the terminal sign-in on the other ----------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = async (name: string) => {
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.replace(${EMAIL}, "owner@example.com"); return true; })()`);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  // Tall enough for the Engines section of three rows and the sign-in steps, set before the page lays out.
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1150, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/settings/engines` });
  await until(() => evaluate(`(document.querySelector('section[aria-label="Engines"]')?.innerText ?? "").includes("Signed-out computer")`), "Settings' Engines section", 30);
  const offRowSelector = `[aria-label="Claude Code on Signed-out computer"]`;
  await evaluate(`(() => { const button = [...document.querySelector('${offRowSelector}').querySelectorAll("button")].find((item) => /Sign in with Claude/.test(item.innerText)); button?.click(); return Boolean(button); })()`);
  // The runner takes the request and says what to do: the steps box with the command.
  await until(() => evaluate(`(document.querySelector('${offRowSelector}')?.innerText ?? "").includes("Finish signing in")`), "the terminal sign-in steps to show", 60).catch(() => {});
  await sleep(500);
  const offRowText = await evaluate(`document.querySelector('${offRowSelector}')?.innerText ?? ""`) as string;
  const realRowText = await evaluate(`document.querySelector('[aria-label="Claude Code on ${real.name}"]')?.innerText ?? ""`) as string;
  const settingsText = await evaluate(`document.querySelector('section[aria-label="Engines"]').innerText`) as string;
  await shot("settings-engines.png");
  notes.settingsText = settingsText.replace(EMAIL, "owner@example.com");
  const stillSignedIn = JSON.parse(claudeStatus().stdout || "{}") as { loggedIn?: boolean };
  check("signedOutHandled", offClaude.installed && !offClaude.signedIn && !offClaude.auth.type && /claude auth login/.test(offClaude.message ?? "")
    && /Signed out/.test(offRowText) && /Finish signing in[\s\S]*Run this in a terminal[\s\S]*claude auth login/.test(offRowText)
    && refused?.status === "error" && /claude auth logout/.test(refused.error ?? "") && stillSignedIn.loggedIn === true,
  { status: { signedIn: offClaude.signedIn, auth: offClaude.auth, message: offClaude.message }, row: offRowText, logout: refused, ownerStillSignedIn: stillSignedIn.loggedIn });
  check("settingsShowsBoth", /Codex/.test(settingsText) && /Claude Code/.test(settingsText) && /Claude Max/.test(realRowText) && /Signed in/.test(realRowText)
    && /own Claude subscription/.test(realRowText) && (settingsText.match(/Signed in/g) ?? []).length >= 2, realRowText.replace(EMAIL, "owner@example.com"));

  // --- 16. What the engine declares --------------------------------------------------------------------------------
  const declared = new ClaudeEngine().capabilities;
  notes.capabilities = declared;
  check("windowsNoSandboxDeclared", declared.sandbox.win32 === undefined && ACCESSES.every((level) => declared.sandbox.darwin?.includes(level) && declared.sandbox.linux?.includes(level))
    && declared.approvals && declared.steer === "native" && declared.compaction.type === "slash-command" && process.platform === "win32" && Boolean(asked), declared.sandbox);

  // --- 17. Claude's credentials never reach Perry ---------------------------------------------------------------
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "node_modules" && name !== "_generated") walk(path); }
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) sources.push(path);
    }
  };
  for (const dir of ["runner", "convex", "server", "lib", "app", "components", "client", "scripts"]) if (existsSync(join(REPO, dir))) walk(join(REPO, dir));
  const forbidden = /\.credentials\.json|CLAUDE_CODE_OAUTH_TOKEN|claudeAiOauth|oauthAccount|["'`]--bare["'`]|getCredentials|security find-generic-password.*claude/i;
  const offending = sources.filter((path) => forbidden.test(readFileSync(path, "utf8"))).map((path) => path.slice(REPO.length + 1));
  const tables = sql<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'doc_%'`).map((row) => row.name);
  const token = /sk-ant-[\w-]{10,}|claudeAiOauth|refreshToken|accessToken"\s*:\s*"sk-/;
  const leakedTables = tables.filter((table) => sql<{ doc: string }>(`SELECT doc FROM "${table}"`).some((row) => token.test(row.doc)));
  const leakedLogs = Object.entries(logs).filter(([, text]) => token.test(text)).map(([name]) => name);
  check("credentialsNeverRead", offending.length === 0 && leakedTables.length === 0 && leakedLogs.length === 0,
    { sourcesScanned: sources.length, offending, tablesScanned: tables.length, leakedTables, leakedLogs });

  check("noPageErrors", browser.errors.length === 0, browser.errors);
  check("runnerLogClean", !/turn failed:|could not report the engines|did not start/i.test(logs.runner), logs.runner.split("\n").filter((line) => /fail|error/i.test(line)).slice(-10));
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(offRunner);
  stop(runner);
  stop(server);
  await sleep(3_000);
  notes.runnerLog = logs.runner.split("\n").filter(Boolean).slice(-50);
  for (const dir of [home, offHome]) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {} }
}

const result = { ranAt: new Date().toISOString(), models: { claude: CLAUDE_MODEL, codex: CODEX_MODEL }, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2).replace(EMAIL, "owner@example.com")}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
