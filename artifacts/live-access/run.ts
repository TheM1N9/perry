import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";
import { describeAccess, pickAccess } from "../../convex/lib/commands";

// bun artifacts/live-access/run.ts <outDir>
// A chat's access (Ask, Auto, Full access) changed while its reply runs
// applies to that reply, from its next step. A fresh PERRY_HOME, the
// production build (`pnpm build` first) on a free port, the real runner, and
// the owner's own Codex and Claude Code (PERRY_E2E_ENGINES=codex skips Claude).
// The commands the engines run sleep, print a word, or fetch
// https://example.com.
//
// Ways it could fail:
//   1. Full access cannot be taken back: a reply started on Full access and
//      put on Ask while its first command runs still runs its second one
//      without asking. Checked on Codex, whose turn cannot change its own
//      policy, and on Claude Code, whose mode is switched mid-turn.
//   2. Ask cannot be let go of: a request waiting for the owner stays
//      waiting after the chat is put on Full access, and the reply never gets
//      what it asked for.
//   3. The reviewer outvotes the owner: a request being reviewed when the
//      chat is put on Ask runs on the reviewer's "clear" instead of asking.
//   4. Full access starts asking the owner: a reply on Full access and left
//      there must finish with nothing waiting for the owner.
//   5. /access (on Telegram and WhatsApp; the web composer shows the same)
//      still says the change waits for the next message.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/live-access/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "live-access-e2e-key";
const ENGINES = (process.env.PERRY_E2E_ENGINES ?? "codex,claude").split(",");
const home = mkdtempSync(join(tmpdir(), "perry-live-access-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY") delete env[name];
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
async function call<T>(path: string, args: object = {}, as: "admin" | "call" = "call"): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${as}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(as === "admin" ? { "x-perry-key": KEY } : {}) },
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
type Row = { id: string; status: string; decidedBy?: string; kind: string; title: string; conversationId?: string; createdAt: number };
/** A chat's approval requests, read from this test's own database (read-only; the server keeps writing). */
const approvalsFor = async (chat: string): Promise<Row[]> => {
  const script = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(join(home, "perry.sqlite"))}, { readOnly: true });
    const rows = db.prepare("SELECT _id, doc FROM doc_approvals WHERE json_extract(doc, '$.conversationId') = ?").all(${JSON.stringify(chat)});
    process.stdout.write(JSON.stringify(rows.map((row) => ({ id: row._id, ...JSON.parse(row.doc) }))));`;
  const { stdout } = await new Promise<{ stdout: string }>((done) => {
    const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
    child.on("close", () => done({ stdout: out }));
  });
  return (JSON.parse(stdout || "[]") as Row[]).sort((a, b) => a.createdAt - b.createdAt);
};
const shown = (rows: Row[]) => rows.map((row) => `${row.status}/${row.decidedBy ?? "-"}: ${row.title}`.slice(0, 200));
const pending = () => call<Array<{ id: string; title: string; chat?: { id: string } }>>("approvals:pending", { key: KEY });
const setAccess = (id: string, access: "supervised" | "auto" | "full") => call("dashboard:setChatAccess", { key: KEY, id, access });
const MODELS: Record<string, string | undefined> = { codex: process.env.PERRY_E2E_MODEL, claude: "haiku" };
const newChat = async (engine: string, access: "supervised" | "auto" | "full") => {
  const id = await call<string>("dashboard:createChat", { key: KEY });
  if (MODELS[engine]) await call("dashboard:setChatModel", { key: KEY, id, model: MODELS[engine], engine });
  await setAccess(id, access);
  return id;
};
const running = async (chat: string) => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning;
/** The chat's reply, waited for a little after the turn ends, as it is saved just after; or the chat's error. */
const replyOf = async (chat: string) => {
  const read = async () => (await call<{ page: Array<{ role: string; text: string }> }>("dashboard:getChatMessages", { key: KEY, id: chat, paginationOpts: { numItems: 10, cursor: null } }))
    .page.find((message) => message.role === "assistant")?.text ?? "";
  await until(async () => Boolean(await read()), "the reply to be saved", 20).catch(() => {});
  const error = (await call<{ lastError?: string }>("dashboard:getChat", { key: KEY, id: chat })).lastError;
  return (await read()) || (error ? `error: ${error}` : "");
};

const TWO_STEPS = "Using your shell tool, run these two PowerShell commands one after the other, as two separate tool calls, never combined or in the background. " +
  "First: Start-Sleep -Seconds 20; Write-Output step-one-done " +
  "Then, once it has finished: Write-Output step-two-ran | Out-File -FilePath step-two.txt; Get-Content step-two.txt " +
  "Reply with one line: what the second command printed, or the word declined if it was not allowed.";
const LOCAL = "Using your shell tool, run exactly this PowerShell command and reply with only what it prints: Write-Output full-ran | Out-File -FilePath full.txt; Get-Content full.txt";
const FETCH = "Using your shell tool, run exactly this PowerShell command and reply with only the number it prints: (Invoke-WebRequest -Uri https://example.com -UseBasicParsing).StatusCode";

const server = start("server");
let runner: ChildProcess | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners", {}, "admin")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online", 120);
  const token = (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string }).token;
  if (ENGINES.includes("claude")) {
    await until(async () => (await call<Array<{ engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY })).some((computer) => computer.engines.some((engine) => engine.kind === "claude" && engine.signedIn)), "Claude Code to be signed in", 120);
  }

  // 3 and 2, request by request, as the server decides.
  const reviewing = await newChat("codex", "auto");
  const inReview = await call<{ id: string; next: string }>("approvals:request", { token, kind: "command", title: "Write-Output e2e-review", cwd: home, conversationId: reviewing });
  await setAccess(reviewing, "supervised");
  const cleared = await call<boolean>("approvals:reviewed", { token, id: inReview.id, verdict: "clear", reason: "routine" });
  const afterReview = (await approvalsFor(reviewing)).find((row) => row.id === inReview.id);
  notes.reviewer = { next: inReview.next, cleared, row: afterReview && shown([afterReview]) };
  checks.reviewerDefersToAsk = inReview.next === "review" && cleared === false && afterReview?.status === "pending";
  await setAccess(reviewing, "full");
  const released = (await approvalsFor(reviewing)).find((row) => row.id === inReview.id);
  notes.released = released && shown([released]);
  checks.fullReleasesWaiting = released?.status === "auto" && released.decidedBy === "trust";

  // 5. What /access answers.
  const answers = [describeAccess("full"), pickAccess("ask").reply];
  notes.accessAnswers = answers;
  checks.accessSaysAtOnce = answers.every((answer) => /at once/.test(answer) && !/next message/.test(answer));

  for (const engine of ENGINES) {
    // 1. Full access, then Ask while the first command runs: the second must wait for the owner.
    const chat = await newChat(engine, "full");
    await call("dashboard:sendChat", { key: KEY, id: chat, text: TWO_STEPS });
    const startedAt = Date.now();
    // Codex asks this runner about each command even on Full access; Claude Code does not, so its first step is seen by time.
    await until(async () => (await approvalsFor(chat)).some((row) => /step-one/.test(row.title)) || (engine !== "codex" && Date.now() - startedAt > 12_000), `${engine}'s first command`, 180);
    await setAccess(chat, "supervised");
    const asked: string[] = [];
    await until(async () => {
      for (const row of (await pending()).filter((item) => item.chat?.id === chat)) {
        asked.push(row.title);
        await call("approvals:decide", { key: KEY, id: row.id, approved: false });
      }
      return !(await running(chat));
    }, `the ${engine} reply after the switch`, 400);
    const rows = await approvalsFor(chat);
    const reply = await replyOf(chat);
    notes[`${engine}FullThenAsk`] = { asked, reply, rows: shown(rows) };
    checks[`${engine}FullThenAskAsks`] = asked.some((title) => /step-two/.test(title)) && !/step-two-ran/.test(reply);

    // 2. Ask, a request waiting for the owner, then Full access: it runs, and the reply has what it fetched.
    const ask = await newChat(engine, "supervised");
    if (engine === "codex") await call("dashboard:setChatEffort", { key: KEY, id: ask, effort: "high" });
    await call("dashboard:sendChat", { key: KEY, id: ask, text: FETCH });
    await until(async () => (await pending()).some((item) => item.chat?.id === ask) || !(await running(ask)), `${engine} to ask`, 240);
    const waited = (await pending()).filter((item) => item.chat?.id === ask).map((item) => item.title);
    await setAccess(ask, "full");
    await until(async () => !(await running(ask)), `the ${engine} reply after Full access`, 300);
    const askRows = await approvalsFor(ask);
    const askReply = await replyOf(ask);
    notes[`${engine}AskThenFull`] = { waited, reply: askReply, rows: shown(askRows) };
    checks[`${engine}AskThenFullRuns`] = waited.length > 0 && /200/.test(askReply)
      && askRows.some((row) => row.status === "auto" && row.decidedBy === "trust") && !askRows.some((row) => row.status === "pending" || row.status === "declined");

    // 4. Full access left alone: nothing waits for the owner.
    const full = await newChat(engine, "full");
    await call("dashboard:sendChat", { key: KEY, id: full, text: LOCAL });
    let fullAsked = 0;
    await until(async () => {
      fullAsked += (await pending()).filter((item) => item.chat?.id === full).length;
      return !(await running(full));
    }, `the ${engine} Full access reply`, 300);
    const fullReply = await replyOf(full);
    const fullRows = await approvalsFor(full);
    notes[`${engine}Full`] = { reply: fullReply, rows: shown(fullRows) };
    checks[`${engine}FullNeverAsks`] = fullAsked === 0 && /full-ran/.test(fullReply) && fullRows.every((row) => row.status === "auto");
  }

  checks.runnerToldEngine = !ENGINES.includes("claude") || /on Ask now; the Claude Code turn follows it/.test(logs.runner);
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  stop(runner);
  stop(server);
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), engines: ENGINES, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
