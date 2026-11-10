// Disposable production-UI E2E bootstrap. Read failure-cases.md first.
// NODE CLI: --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs
// --import ./artifacts/batch-1/ui-server.mjs node_modules/next/dist/bin/next start -p 17483 -H 127.0.0.1
import fs from "node:fs";
import { resolve, relative, isAbsolute, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (process.env.PERRY_BATCH_UI !== "1" || resolve(process.cwd()) !== repo) throw new Error("Explicit batch UI opt-in and repository cwd required.");
const scratch = join(repo, ".batch-work/batch-1/coordinator/ui");
const home = resolve(process.env.PERRY_HOME ?? "");
const within = relative(scratch, home);
if (!within || isAbsolute(within) || within.startsWith("..") || resolve(scratch, within) !== home) throw new Error("A fresh batch-only UI home is required.");
if (fs.existsSync(home)) throw new Error("Refusing to reuse an existing UI fixture home.");
fs.mkdirSync(home, { recursive: true });
process.env.PERRY_DB = join(home, "fixture.sqlite");
process.env.DASHBOARD_KEY = "batch-ui-synthetic";
process.env.PERRY_CREDENTIAL_KEY = "22".repeat(32);
process.env.PERRY_PORT = "17483";
process.env.NEXT_TELEMETRY_DISABLED = "1";
// Block dotenv reads before Next's config loader. Never inspect file contents.
for (const method of ["statSync", "readFileSync"]) {
  const original = fs[method];
  fs[method] = function(path, ...args) {
    const file = typeof path === "string" ? resolve(path) : path instanceof URL ? fileURLToPath(path) : null;
    if (file && dirname(file).toLowerCase() === repo.toLowerCase() && /^\.env(?:\.|$)/.test(basename(file))) {
      const error = new Error("UI fixture excludes dotenv files"); error.code = "ENOENT"; throw error;
    }
    return original.call(this, path, ...args);
  };
}
// No child processes: no engines, scheduled tasks, model workers or OS services.
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[method] = () => { throw new Error("Child processes disabled in batch UI fixture"); };
}
syncBuiltinESMExports();
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Remote network disabled in batch UI fixture");
  return fetchOriginal(input, options);
};

const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"),
  import("../../server/modules.ts"), import("../../server/credential-encryption.ts"),
]);
const sql = new DatabaseSync(process.env.PERRY_DB);
initializeCredentialEncryption(sql, home);
const runtime = new Runtime(sql, schema, modules, { storageDir: join(home, "storage") });
await runtime.stop();
// The production singleton already supports reuse across Next module loads.
// Instrumentation sees started=true and never starts background side effects.
globalThis.__perry = { runtime, started: true };
const db = runtime.store;
const now = Date.now();
db.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: now, autoUpdate: false, wake: false });
const token = "batch-ui-fake-runner";
const runnerId = db.insert("runners", { name: "Fixture computer", token, createdAt: now, lastSeenAt: now, turnHeartbeats: true,
  engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: now }] });
const thread = db.insert("agentThreads", { userId: "web:dashboard", title: "Batch UI fixture" });
const conversationId = db.insert("conversations", { channel: "web", externalId: "batch-ui", threadId: thread, title: "Batch verification", engine: "codex", codexRunnerId: runnerId, pendingTurns: 1, lastMessageAt: now });
const oldRun = db.insert("runs", { conversationId, prompt: "Show a clear failure", status: "error", errorCode: "idle_timeout", error: "Synthetic timeout detail.", startedAt: now - 400_000, finishedAt: now - 300_000 });
const save = (role, text, runId, order) => db.insert("agentMessages", { threadId: thread, userId: "web:dashboard", order, runId, message: { role, content: text }, text });
save("user", "Show a clear failure", oldRun, 0);
save("assistant", "Partial answer preserved.", oldRun, 1);
const runId = db.insert("runs", { conversationId, prompt: "Continue the fixture", status: "running", startedAt: now - 200_000 });
const turnId = db.insert("codexTurns", { runnerId, conversationId, runId, engine: "codex", prompt: "Continue the fixture", instructions: "Fixture only", status: "running", createdAt: now - 200_000, startedAt: now - 200_000, lastHeartbeatAt: now - 120_000, partial: "Current partial answer is safe." });
db.insert("runSpans", { runId, callId: "fake-open-command", kind: "command", name: "Fixture unfinished command", status: "running", startedAt: now - 150_000, output: "Partial fixture output" });
const taskId = db.insert("tasks", { title: "Fixture research", prompt: "Compare the fixture inputs and preserve completed work.", origin: conversationId, status: "running", turns: 1,
  plan: [{ title: "Collected fixture inputs", status: "done" }, { title: "Write the fixture result", status: "active" }], createdAt: now, updatedAt: now });
const taskThread = db.insert("agentThreads", { userId: "web:dashboard" });
const taskChat = db.insert("conversations", { channel: "web", externalId: "batch-task", threadId: taskThread, taskId, engine: "codex", access: "supervised", pendingTurns: 1 });
db.patch(taskId, { conversationId: taskChat });
const taskRun = db.insert("runs", { conversationId: taskChat, prompt: "Compare fixture inputs", status: "running", startedAt: now });
const taskTurn = db.insert("codexTurns", { runnerId, conversationId: taskChat, runId: taskRun, engine: "codex", prompt: "Compare fixture inputs", instructions: "Fixture only", status: "running", createdAt: now, startedAt: now, lastHeartbeatAt: now });
const fixture = { home, conversationId, runId, turnId, taskId, taskChat, taskTurn, runnerId, token, url: `http://127.0.0.1:17483/chat/${conversationId}#key=batch-ui-synthetic`, schedulerStopped: true, backgroundStarted: false };
fs.writeFileSync(join(scratch, "fixture.json"), JSON.stringify(fixture, null, 2));
console.log(JSON.stringify({ fixture: join(scratch, "fixture.json"), url: fixture.url }));
process.once("exit", () => sql.close());
