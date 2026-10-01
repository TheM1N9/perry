import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/runner-follows-computer/run.ts <outDir>
// Jobs failed with "The Codex runner for this chat is offline" while chat
// worked: Perry's port moved from 3000 to 7377, the server paired this
// computer afresh under a new token, and every older chat stayed pinned to the
// runner that no longer checked in. A fresh Perry (production build, `pnpm
// build` first) on a spare port; runners are played by their check-ins, with
// no Codex, so turns are only queued, never run.
//
// Ways it could fail, written down before the checks:
//   1. A runner.json naming the old port makes the server pair a second
//      runner instead of keeping the token (the cause of the stranded chats).
//   2. The address is not put right, so the runner keeps failing to connect.
//   3. A chat pinned to a runner that went quiet still fails once the same
//      computer is back under a new token.
//   4. A chat moves to a different computer, whose disk has none of its
//      Codex threads.
//   5. A failed job run shows only the error in its chat, not its prompt.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/runner-follows-computer/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "runner-follows-computer-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-follow-"));
const runnerJson = join(home, "runner.json");
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
let serverLog = "";
const startServer = () => {
  const child = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { serverLog += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk; });
  return child;
};
const stop = (child: ChildProcess) => new Promise<void>((done) => {
  if (!child.pid || child.exitCode !== null) return done();
  child.once("exit", () => done());
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
});
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
const readConfig = () => existsSync(runnerJson) ? JSON.parse(readFileSync(runnerJson, "utf8")) as { url?: string; token?: string } : {};
/** A runner's check-in and Codex report, as the runner makes them: online, on this computer, signed in. */
const present = async (token: string, hostname: string) => {
  await call("runner:checkIn", { token, platform: "win32", hostname, workdir: home });
  await call("codex:reportAccount", { token, available: true, authMode: "chatgpt", planType: "plus" });
};
type Turn = { conversationId: string; prompt: string };
const queued = (token: string) => call<Turn[]>("codex:queuedTurns", { token });
type Job = { id: string; name: string; chatId?: string; lastError?: string; lastRunAt?: number };
const jobOf = async (id: string) => (await call<{ jobs: Job[] }>("jobs:listForDashboard", { key: KEY })).jobs.find((job) => job.id === id)!;
const messagesOf = async (chat: string) => (await call<{ page: Array<{ role: string; text: string }> }>("dashboard:getChatMessages", { key: KEY, id: chat, paginationOpts: { numItems: 20, cursor: null } })).page;
const health = () => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false);

let server = startServer();
try {
  // --- 1–2. The port moved: the same computer keeps its token --------------------------------
  await until(health, "the server to start", 90);
  await until(() => Boolean(readConfig().token), "the server to connect this computer", 30);
  const first = readConfig();
  await stop(server);
  writeFileSync(runnerJson, JSON.stringify({ ...first, url: "http://127.0.0.1:3000" }, null, 2));
  server = startServer();
  await until(health, "the server to start again", 90);
  await until(() => readConfig().url === BASE, "runner.json to name the new port", 30).catch(() => {});
  const second = readConfig();
  const runners = await call<Array<{ _id: string }>>("runner:listRunners");
  check("keepsTokenAfterPortMove", second.token === first.token && runners.length === 1, { runners: runners.length, sameToken: second.token === first.token });
  check("addressPutRight", second.url === BASE, { url: second.url });

  // --- 3–5. A chat on a runner that went quiet ----------------------------------------------
  const old = first.token!;
  await present(old, "HOST-A");
  const created = await call<{ id: string }>("jobs:create", { name: "Stranded job", prompt: "Report on the stranded job, briefly.", schedule: "0 3 1 1 *" });
  const job = created.id;
  await call("jobs:runNow", { key: KEY, id: job });
  await until(async () => (await queued(old)).some((turn) => turn.prompt.includes("stranded job")), "the first run to queue on the old runner", 30);
  const chat = (await jobOf(job)).chatId!;

  // The same computer connects again under a new token; another computer is online too.
  const again = "follow-e2e-same-computer-token";
  const other = "follow-e2e-other-computer-token";
  await call("runner:createToken", { name: "HOST-A", token: again });
  await call("runner:createToken", { name: "HOST-B", token: other });
  console.log("waiting 95s for the old runner to count as offline…");
  await sleep(95_000);

  // Only the other computer online: the chat must not move there, and the failure keeps the prompt.
  await present(other, "HOST-B");
  const before = (await jobOf(job)).lastRunAt;
  await call("jobs:runNow", { key: KEY, id: job });
  await until(async () => { const now = await jobOf(job); return now.lastRunAt !== before && Boolean(now.lastError); }, "the run with no runner to fail", 30);
  const failed = await jobOf(job);
  const otherTurns = await queued(other);
  check("staysOffOtherComputer", /offline/.test(failed.lastError ?? "") && !otherTurns.some((turn) => turn.conversationId === chat), { error: failed.lastError, otherTurns: otherTurns.length });
  const shown = await messagesOf(chat);
  // Two: the first run's prompt, still queued on the old runner, and the failed run's, kept with its error.
  const prompts = shown.filter((message) => message.role === "user" && message.text.includes("Report on the stranded job"));
  check("failedRunKeepsPrompt", prompts.length === 2, shown.map((message) => `${message.role}: ${message.text.slice(0, 60)}`));

  // The same computer, back under its new token: the chat follows it.
  await present(again, "HOST-A");
  await present(other, "HOST-B");
  await call("jobs:runNow", { key: KEY, id: job });
  await until(async () => (await queued(again)).some((turn) => turn.conversationId === chat), "the run to queue on the same computer's new runner", 30).catch(() => {});
  const moved = await queued(again);
  const after = await jobOf(job);
  check("followsSameComputer", moved.some((turn) => turn.conversationId === chat) && !after.lastError, { queuedOnNew: moved.length, error: after.lastError });
} catch (error) {
  notes.error = String(error);
} finally {
  await stop(server);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const passed = Object.keys(checks).length === 5 && Object.values(checks).every(Boolean);
const result = { ranAt: new Date().toISOString(), passed, checks, notes, serverLog: serverLog.split("\n").filter((line) => /perry|error/i.test(line)).slice(-30) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed, checks, notes }, null, 2));
process.exit(passed ? 0 : 1);
