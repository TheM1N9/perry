import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/engine-layer/run.ts <outDir>
// Issue: Perry's engine layer. The runner now drives Codex through an engine
// interface (runner/engine.ts, runner/engines/codex.ts), chats and turns carry
// an engine and a resume cursor, runners report engines, and Settings lists
// them. For Codex users nothing may change. A fresh Perry (production build,
// `pnpm build` first) on a spare port with a temp PERRY_HOME, the real runner
// and this machine's real signed-in Codex (PERRY_E2E_MODEL picks the model,
// gpt-6-luna by default), and headless Chrome for Settings. Nothing touches
// the owner's own Perry.
//
// Ways the refactor could break, written down before the checks:
//   1. A web reply no longer streams while it is written, or is not saved.
//   2. A message sent while a reply runs no longer steers it.
//   3. Stop no longer interrupts the engine, or the stopped reply is lost.
//   4. /compact no longer compacts the chat's session.
//   5. An approval no longer reaches the dashboard, or its answer never gets
//      back to Codex.
//   6. The reviewer (Auto) no longer runs, now that it is an engine's quick turn.
//   7. New chats are no longer named, for the same reason.
//   8. The chat's model and thinking level no longer reach Codex, or the run's
//      label changes shape.
//   9. A job's model is not the one its turns use.
//  10. Perry's MCP tools (remember) are no longer reachable from a Codex turn.
//  11. A chat from before engines (codexThreadId, no engine or resume) no
//      longer resumes its Codex thread, or loses it.
//  12. A runner from before engines (only codex* fields) no longer counts as
//      signed in, loses its models, or drops out of Settings.
//  13. Settings no longer lists the engines, or Codex's row lost its state.
//  14. Telegram's /model (the same command on WhatsApp here, as no bot token
//      is set) no longer lists the models, or not by engine.
//  15. The stdio MCP bridge does not round-trip tools/list and tools/call.
//  16. Picking another engine's model does not move the chat to that engine
//      with a fresh session seeded with its history, or its turn goes to a
//      runner without that engine.
//  17. The dashboard throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engine-layer/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "engine-layer-e2e-key";
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const NONCE = `e2e-${Date.now().toString(36)}`;
const home = mkdtempSync(join(tmpdir(), "perry-engine-layer-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
/** An email address, as the signed-in account shows one; never written into the artifact. */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

// --- Perry ----------------------------------------------------------------------
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
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

// The documents themselves, as Perry keeps them in SQLite: to read what no query shows, and to make
// old-shaped data. Through Node, as Bun has no node:sqlite; the server's connection sees each write.
const SQL = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
const statement = db.prepare(process.argv[2]); const params = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? statement.all(...params) : (statement.run(...params), [])));`;
function sql<T>(statement: string, params: Array<string | number> = []): T[] {
  const ran = spawnSync("node", ["-e", SQL, join(home, "perry.sqlite"), statement, JSON.stringify(params)], { encoding: "utf8", windowsHide: true });
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
const messagesOf = async (id: string) => (await call<{ page: Array<{ role: string; text: string; createdAt: number }> }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 30, cursor: null } }))
  .page.sort((a, b) => a.createdAt - b.createdAt);
const runsOf = (id: string) => call<Array<{ prompt: string; status: string; model?: string; startedAt: number }>>("dashboard:listRuns", { key: KEY, conversationId: id });
const conversation = (id: string) => call<Row>("conversations:getById", { id });
type Computer = { id: string; name: string; online: boolean; engines: Array<{ kind: string; label: string; installed: boolean; signedIn: boolean; version?: string; auth: { label?: string; plan?: string } }> };
const computers = () => call<Computer[]>("engines:list", { key: KEY });

/** The turn_context entries Codex wrote for a thread (model and effort as sent); null when its session file is not on this machine. */
function sessionTurns(threadId?: string): Array<{ model?: string; effort?: string }> | null {
  if (!threadId) return null;
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  if (!existsSync(root)) return null;
  const file = (readdirSync(root, { recursive: true }) as string[]).find((name) => name.endsWith(`${threadId}.jsonl`));
  if (!file) return null;
  return readFileSync(join(root, file), "utf8").split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.type === "turn_context" ? [{ model: entry.payload.model, effort: entry.payload.effort }] : [];
    } catch { return []; }
  });
}

/** Run the stdio bridge with this runner's token, send it these messages, and collect what it answers. */
function bridge(token: string, messages: object[]): Promise<Array<Record<string, any>>> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(REPO, "runner", "mcp-bridge.ts")], {
      env: { ...process.env, PERRY_MCP_URL: `${BASE}/api/backend/http/mcp`, PERRY_MCP_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk; });
    const timer = setTimeout(() => { child.kill(); fail(new Error(`the bridge did not finish: ${err}`)); }, 60_000);
    child.on("exit", () => {
      clearTimeout(timer);
      try { done(out.split("\n").filter(Boolean).map((line) => JSON.parse(line))); } catch (error) { fail(new Error(`the bridge wrote something that is not JSON-RPC: ${out.slice(0, 300)}`)); }
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  // Online, with Codex reported through the engine layer, signed in.
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "the runner to report Codex signed in", 120);
  const token = (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string }).token;
  const real = (await computers()).find((item) => item.online)!;
  const codexRow = real.engines.find((engine) => engine.kind === "codex")!;
  notes.codexStatus = codexRow;
  // Runners, scripts and older checks read Codex's state from the codex* fields; they are still written.
  const runnerDoc = rows("runners").find((row) => row.token === token)!;
  check("legacyRunnerFieldsKept", runnerDoc.codexAuthMode === "chatgpt" && runnerDoc.codexAvailable === true && (runnerDoc.codexModels?.length ?? 0) > 0 && Array.isArray(runnerDoc.engines),
    { codexAuthMode: runnerDoc.codexAuthMode, codexModels: runnerDoc.codexModels?.length, engines: runnerDoc.engines?.map((item: Row) => item.kind) });

  // --- 13. Settings lists the engines ------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  // The account's email is the owner's own: masked on the page before a screenshot, as in result.json.
  const shot = async (name: string) => {
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.replace(${EMAIL}, "owner@example.com"); return true; })()`);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  await send("Page.navigate", { url: `${BASE}/settings/engines` });
  await until(() => evaluate(`Boolean(document.querySelector('section[aria-label="Engines"]'))`), "Settings' Engines section", 30);
  await until(() => evaluate(`document.querySelector('section[aria-label="Engines"]').innerText.includes("Signed in")`), "Codex signed in on Settings", 30).catch(() => {});
  const settingsText = await evaluate(`document.querySelector('section[aria-label="Engines"]').innerText`) as string;
  await shot("settings-engines.png");
  notes.settingsText = settingsText;
  check("settingsListsEngines", settingsText.includes(real.name) && /Codex/.test(settingsText) && settingsText.includes("Signed in") && settingsText.includes("Sign out")
    && /ChatGPT/.test(settingsText), settingsText);

  // --- 1, 7, 8, 10. A web reply on the chat's model and level, with a tool call; the chat is named -----------
  const options = await call<{ models: Array<{ id: string; engine?: string; efforts?: string[] }>; engines: Array<{ kind: string }> }>("models:options", { key: KEY });
  const offered = options.models.find((model) => model.id === MODEL);
  if (!offered) throw new Error(`${MODEL} is not offered; set PERRY_E2E_MODEL to one of ${options.models.map((model) => model.id).join(", ")}`);
  const effort = offered.efforts?.includes("low") ? "low" : offered.efforts?.[0];
  check("modelsTaggedWithEngine", options.models.every((model) => model.engine === "codex") && options.engines.some((engine) => engine.kind === "codex"), options.engines);
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: MODEL });
  if (effort) await call("dashboard:setChatEffort", { key: KEY, id: chat, effort });
  const first = `Use your remember tool to save this exact note as a daily memory: "Engine layer check ${NONCE}: the remember tool works." Then count from one to twenty in words, one per line, and nothing else.`;
  await call("dashboard:sendChat", { key: KEY, id: chat, text: first });
  // Watched closely, as the dashboard does, to see the reply grow.
  const streamed: string[] = [];
  const watchUntil = Date.now() + 240_000;
  for (let running = true; running && Date.now() < watchUntil;) {
    const now = await getChat(chat);
    if (now.streaming && streamed.at(-1) !== now.streaming) streamed.push(now.streaming);
    running = now.isRunning || !(await messagesOf(chat)).some((message) => message.role === "assistant");
    await sleep(100);
  }
  const firstReply = (await messagesOf(chat)).filter((message) => message.role === "assistant").at(-1)?.text ?? "";
  check("replyStreams", streamed.length >= 2 && streamed.some((text) => text.length < firstReply.length), { snapshots: streamed.length, lengths: streamed.map((text) => text.length).slice(0, 12) });
  check("replySaved", /twenty/i.test(firstReply), firstReply.slice(0, 200));
  const memory = rows("memories").find((row) => String(row.text).includes(NONCE));
  check("mcpRememberCallable", Boolean(memory), memory?.text);
  const [firstRun] = await runsOf(chat);
  const firstTurn = turnsOf(chat)[0];
  const label = `codex/${MODEL}${effort ? ` · ${effort}` : ""} · full access`;
  check("runLabelShape", firstRun?.model === label && firstRun.status === "ok", { run: firstRun?.model, expected: label });
  const afterFirst = await conversation(chat);
  const session = sessionTurns(afterFirst.codexThreadId)?.at(-1);
  check("modelAndEffortSent", firstTurn?.engine === "codex" && firstTurn.requestedModel === MODEL && firstTurn.requestedEffort === effort
    && (session === null || session === undefined || (session.model === MODEL && session.effort === effort)),
    { turn: { engine: firstTurn?.engine, model: firstTurn?.requestedModel, effort: firstTurn?.requestedEffort }, codexSession: session ?? "session file not found" });
  check("resumeCursorRecorded", afterFirst.resume?.engine === "codex" && afterFirst.resume.cursor === afterFirst.codexThreadId && Boolean(afterFirst.codexThreadId),
    { resume: afterFirst.resume, codexThreadId: afterFirst.codexThreadId });
  await until(async () => (await getChat(chat)).title !== first.slice(0, 80), "the chat to be named", 90).catch(() => {});
  const title = (await getChat(chat)).title;
  check("chatNamed", title !== first.slice(0, 80) && title.length > 0 && title.length < 80, title);

  // --- 11. The chat as it was before engines: only its Codex thread ---------------------------------
  const thread = afterFirst.codexThreadId as string;
  edit("conversations", chat, "json_remove(doc, '$.engine', '$.resume')");
  const oldShaped = await conversation(chat);
  notes.oldShapedChat = { engine: oldShaped.engine ?? null, resume: oldShaped.resume ?? null, codexThreadId: oldShaped.codexThreadId };

  // --- 2, 3, 15. A long turn on that chat: the bridge, a steer, then stop ------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "Run this PowerShell command exactly, then say in one line that it finished: Start-Sleep -Seconds 40; Write-Output slept" });
  await until(async () => (await getChat(chat)).isRunning, "the long turn to start", 60);
  await until(() => turnsOf(chat).at(-1)?.codexTurnId !== undefined, "Codex to start the long turn", 90);
  const resumedTurn = turnsOf(chat).at(-1)!;
  // While it runs, the runner's token serves Perry's tools; over stdio through the bridge.
  const answers = await bridge(token, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine-layer-e2e", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { text: `Bridge check ${NONCE}: the stdio bridge reached Perry's tools.`, kind: "daily" } } },
  ]);
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const listed: string[] = byId.get(2)?.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
  const bridged = rows("memories").find((row) => String(row.text).startsWith(`Bridge check ${NONCE}`));
  check("bridgeRoundTrips", answers.length === 3 && byId.get(1)?.result?.serverInfo?.name === "assistant" && listed.includes("remember") && listed.includes("share_file")
    && !byId.get(3)?.result?.isError && Boolean(bridged),
    { answers: answers.length, tools: listed.length, call: JSON.stringify(byId.get(3)?.result ?? byId.get(3)?.error).slice(0, 200), stored: bridged?.text });
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "Also, when you reply, include the word pineapple." });
  await until(() => rows("codexSteers").some((steer) => steer.turnId === resumedTurn._id && steer.status !== "pending"), "the steer to be answered", 60);
  const steer = rows("codexSteers").find((item) => item.turnId === resumedTurn._id)!;
  check("steerApplied", steer.status === "applied" && steer.engine === "codex", { status: steer.status, error: steer.error, engine: steer.engine });
  await call("dashboard:stopChat", { key: KEY, id: chat });
  await until(async () => !(await getChat(chat)).isRunning, "the stopped turn to end", 90);
  const stopped = rows("codexTurns").find((turn) => turn._id === resumedTurn._id)!;
  const stoppedReply = (await messagesOf(chat)).filter((message) => message.role === "assistant").at(-1)?.text ?? "";
  // Stopped before its 40-second command could have finished.
  check("stopInterrupts", stopped.status === "done" && stopped.stopped === true && /_Stopped\._/.test(stoppedReply) && stopped.finishedAt - stopped.startedAt < 40_000,
    { status: stopped.status, stopped: stopped.stopped, error: stopped.error, ranMs: stopped.finishedAt - stopped.startedAt, reply: stoppedReply.slice(-80) });
  const afterResume = await conversation(chat);
  check("oldChatResumesItsThread", !resumedTurn.history && afterResume.codexThreadId === thread && !afterResume.engine,
    { history: Boolean(resumedTurn.history), threadBefore: thread, threadAfter: afterResume.codexThreadId });

  // --- 4. /compact ----------------------------------------------------------------------------------
  const compaction = await call<string | null>("dashboard:compactChat", { key: KEY, id: chat });
  const compacted = { status: "none", error: undefined as string | undefined };
  if (compaction) {
    await until(async () => {
      Object.assign(compacted, await call<{ status: string; error?: string }>("dashboard:getCompaction", { key: KEY, id: compaction }));
      return compacted.status === "done" || compacted.status === "error";
    }, "the compaction", 300);
  }
  check("compactWorks", Boolean(compaction) && compacted.status === "done", compacted);

  // --- 5, 6. Auto: the reviewer looks first; a risky command reaches the dashboard, and the answer gets back ---
  const autoChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: autoChat, model: MODEL });
  await call("dashboard:setChatAccess", { key: KEY, id: autoChat, access: "auto" });
  const target = `C:\\perry-engine-layer-${NONCE}`;
  await call("dashboard:sendChat", { key: KEY, id: autoChat, text: `Run this PowerShell command exactly, once, and then reply in one short line with what happened: Remove-Item -Recurse -Force ${target}` });
  type Pending = { id: string; title: string; chat?: { id: string } };
  let asked: Pending | undefined;
  await until(async () => {
    asked = (await call<Pending[]>("approvals:pending", { key: KEY })).find((item) => item.chat?.id === autoChat);
    return Boolean(asked) || !(await getChat(autoChat)).isRunning;
  }, "the approval to reach the dashboard", 240);
  if (asked) await call("approvals:decide", { key: KEY, id: asked.id, approved: false });
  await until(async () => !(await getChat(autoChat)).isRunning, "the Auto turn to finish", 240);
  const approval = rows("approvals").filter((row) => row.conversationId === autoChat).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  check("reviewerRuns", Boolean(approval?.review) && approval!.review.verdict !== "error" && Boolean(approval!.review.model),
    { verdict: approval?.review?.verdict, reason: approval?.review?.reason, model: approval?.review?.model });
  check("approvalReachesDashboard", Boolean(asked) && approval?.status === "declined" && approval.decidedBy === "dashboard" && /Remove-Item/.test(approval.title),
    { asked: asked?.title?.slice(0, 120), status: approval?.status, decidedBy: approval?.decidedBy });
  const autoReply = (await messagesOf(autoChat)).filter((message) => message.role === "assistant").at(-1)?.text ?? "";
  notes.autoReply = autoReply.slice(0, 300);

  // --- 9. A job's model ---------------------------------------------------------------------------------
  const job = await call<string>("jobs:saveFromDashboard", { key: KEY, name: "Engine check", prompt: "Reply with exactly: job-ok", schedule: "0 3 1 1 *" });
  await call("jobs:setModel", { key: KEY, id: job, model: MODEL, engine: "codex" });
  await call("jobs:runNow", { key: KEY, id: job });
  type JobRow = { id: string; lastResult?: string; lastError?: string; chatId?: string; model?: string; engine?: string };
  let ran: JobRow | undefined;
  await until(async () => { ran = (await call<{ jobs: JobRow[] }>("jobs:listForDashboard", { key: KEY })).jobs.find((item) => item.id === job); return Boolean(ran?.lastResult || ran?.lastError); }, "the job to run", 300);
  const jobTurn = ran?.chatId ? turnsOf(ran.chatId).at(-1) : undefined;
  const jobRun = ran?.chatId ? (await runsOf(ran.chatId))[0] : undefined;
  check("jobModelUsed", jobTurn?.requestedModel === MODEL && jobTurn.engine === "codex" && Boolean(jobRun?.model?.startsWith(`codex/${MODEL}`)) && /job-ok/.test(ran?.lastResult ?? ""),
    { turnModel: jobTurn?.requestedModel, run: jobRun?.model, result: ran?.lastResult, error: ran?.lastError, job: { model: ran?.model, engine: ran?.engine } });

  // --- 16. Another engine's model moves the chat there ---------------------------------------------------
  // A second runner on this same computer, played by its reports, with only Claude Code signed in.
  const claudeToken = `engine-layer-claude-${NONCE}`;
  await call("runner:createToken", { name: "Same computer, Claude", token: claudeToken });
  await call("runner:checkIn", { token: claudeToken, platform: platform(), hostname: hostname(), workdir: home });
  await call("engines:report", { token: claudeToken, engines: [{
    kind: "claude", installed: true, version: "0.0.0-e2e", signedIn: true, auth: { type: "subscription", label: "Claude" },
    models: [{ id: "claude-e2e", name: "Claude E2E", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" }],
  }] });
  const mixed = await call<{ models: Array<{ id: string; engine?: string }>; engines: Array<{ kind: string; label: string }> }>("models:options", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "claude-e2e", engine: "claude" });
  const switched = await conversation(chat);
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `Hello on another engine ${NONCE}` });
  let claudeTurn: Row | undefined;
  await until(async () => { claudeTurn = (await call<Row[]>("codex:queuedTurns", { token: claudeToken })).find((turn) => turn.conversationId === chat); return Boolean(claudeTurn); }, "the turn to queue on the Claude runner", 30).catch(() => {});
  const claimed = claudeTurn ? await call<Row | null>("codex:claimTurn", { token: claudeToken, id: claudeTurn._id }) : null;
  if (claimed) await call("codex:finishTurn", { token: claudeToken, id: claimed._id, response: `Claude says hello ${NONCE}`, model: "claude/claude-e2e · low · full access" });
  await until(async () => (await messagesOf(chat)).some((message) => message.text.includes(`Claude says hello ${NONCE}`)), "the other engine's reply to be saved", 30).catch(() => {});
  const realQueue = await call<Row[]>("codex:queuedTurns", { token });
  check("engineSwitchStartsFresh",
    mixed.engines.map((item) => item.kind).join(",") === "codex,claude" && mixed.models.some((model) => model.engine === "claude" && model.id === "claude-e2e")
    && switched.engine === "claude" && switched.model === "claude-e2e" && !switched.resume && !switched.codexThreadId
    && claimed?.engine === "claude" && !claimed.resumeCursor && Boolean(claimed.history?.includes("twenty")) && claimed.requestedModel === "claude-e2e"
    && !realQueue.some((turn) => turn.conversationId === chat),
    { engines: mixed.engines, chat: { engine: switched.engine, model: switched.model, resume: switched.resume ?? null, codexThreadId: switched.codexThreadId ?? null },
      turn: claimed ? { engine: claimed.engine, resumeCursor: claimed.resumeCursor ?? null, seededWithHistory: Boolean(claimed.history), model: claimed.requestedModel } : null });

  // --- 14. /model in a messaging chat --------------------------------------------------------------------
  const phone = "15550001111@s.whatsapp.net";
  const installation = rows("installation")[0];
  edit("installation", installation._id, "json_set(doc, '$.whatsappOwner', ?)", phone);
  await call("brain:handleTurn", { channel: "whatsapp", externalId: phone, text: "/model" });
  await until(() => rows("whatsappOutbox").some((row) => String(row.text ?? "").includes("models:")), "the /model reply", 30).catch(() => {});
  const listing = rows("whatsappOutbox").map((row) => String(row.text ?? "")).find((text) => text.includes("models:")) ?? "";
  check("messagingModelLists", listing.includes("Codex models:") && listing.includes(MODEL) && listing.includes("Claude Code models:") && listing.includes("claude-e2e"), listing);

  // --- 12. A runner from before engines --------------------------------------------------------------------
  const oldToken = `engine-layer-old-${NONCE}`;
  await call("runner:createToken", { name: "Runner from before engines", token: oldToken });
  await call("runner:checkIn", { token: oldToken, platform: "linux", hostname: "E2E-OLD-HOST", workdir: home });
  await call("codex:reportAccount", { token: oldToken, available: true, authMode: "chatgpt", planType: "plus", models: [{ id: "gpt-old-shape", name: "Old shape", isDefault: true }] });
  const oldRunner = rows("runners").find((row) => row.token === oldToken)!;
  edit("runners", oldRunner._id, "json_remove(doc, '$.engines')");
  const oldDoc = rows("runners").find((row) => row.token === oldToken)!;
  const listedOld = (await computers()).find((item) => item.id === oldRunner._id);
  let oldModels: string[] = [];
  for (let attempt = 0; attempt < 3 && !oldModels.includes("gpt-old-shape"); attempt++) {
    await call("runner:checkIn", { token: oldToken, platform: "linux", hostname: "E2E-OLD-HOST", workdir: home });
    oldModels = (await call<{ codex: Array<{ id: string }> }>("models:options", { key: KEY })).codex.map((model) => model.id);
  }
  const oldChat = await call<string>("dashboard:createChat", { key: KEY });
  edit("conversations", oldChat, "json_set(doc, '$.codexRunnerId', ?)", oldRunner._id);
  await call("dashboard:sendChat", { key: KEY, id: oldChat, text: `Hello, old runner ${NONCE}` });
  let oldTurn: Row | undefined;
  await until(async () => { oldTurn = (await call<Row[]>("codex:queuedTurns", { token: oldToken })).find((turn) => turn.conversationId === oldChat); return Boolean(oldTurn); }, "the turn to queue on the old runner", 30).catch(() => {});
  const oldClaim = oldTurn ? await call<Row | null>("codex:claimTurn", { token: oldToken, id: oldTurn._id }) : null;
  if (oldClaim) await call("codex:finishTurn", { token: oldToken, id: oldClaim._id, response: "Old runner reply." });
  check("oldRunnerStillWorks", !oldDoc.engines && oldDoc.codexAuthMode === "chatgpt"
    && listedOld?.engines.length === 1 && listedOld.engines[0].kind === "codex" && listedOld.engines[0].signedIn
    && oldModels.includes("gpt-old-shape") && oldClaim?.engine === "codex",
    { doc: { engines: oldDoc.engines ?? null, codexAuthMode: oldDoc.codexAuthMode, codexModels: oldDoc.codexModels }, settings: listedOld?.engines, models: oldModels, claimed: oldClaim?.engine ?? null });

  // Settings with every kind of computer: this one, another engine, and a runner from before engines.
  await send("Page.navigate", { url: `${BASE}/settings/engines` });
  await until(() => evaluate(`(document.querySelector('section[aria-label="Engines"]')?.innerText ?? "").includes("Claude Code")`), "Settings to show every engine", 30).catch(() => {});
  await shot("settings-engines-all.png");
  notes.settingsAll = await evaluate(`document.querySelector('section[aria-label="Engines"]').innerText`);

  check("noPageErrors", browser.errors.length === 0, browser.errors);
  check("runnerLogClean", !/Codex turn failed|turn failed:|could not report the engines/i.test(logs.runner), logs.runner.split("\n").filter((line) => /fail|error/i.test(line)).slice(-10));
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  await sleep(3_000);
  notes.runnerLog = logs.runner.split("\n").filter(Boolean).slice(-40);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), model: MODEL, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2).replace(EMAIL, "owner@example.com")}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
