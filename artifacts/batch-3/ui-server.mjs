// Disposable production-UI E2E bootstrap. Read failure-cases.md first.
// NODE CLI: --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs
// --import ./artifacts/batch-3/ui-server.mjs node_modules/next/dist/bin/next start -p 17483 -H 127.0.0.1
import fs from "node:fs";
import { resolve, relative, isAbsolute, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (process.env.PERRY_BATCH_UI !== "1" || resolve(process.cwd()) !== repo) throw new Error("Explicit batch UI opt-in and repository cwd required.");
const scratch = join(repo, ".batch-work/batch-3/coordinator/ui");
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

process.env.NODE_ENV = "production";
process.env.PERRY_UI_BUILD_ID = fs.readFileSync(join(repo, ".next/BUILD_ID"), "utf8").trim();
const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"),
  import("../../server/modules.ts"), import("../../server/credential-encryption.ts"),
]);
const buildId = process.env.PERRY_UI_BUILD_ID;
const sql = new DatabaseSync(":memory:");
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
const messageIds = [];
for (let i = 0; i < 200; i++) {
  const role = i % 2 ? "assistant" : "user";
  messageIds.push(db.insert("agentMessages", { threadId: thread, userId: "web:dashboard", order: i,
    message: { role, content: `Saved fixture message ${i + 1}` }, text: `Saved fixture message ${i + 1}` }));
}
const secondThread = db.insert("agentThreads", { userId: "web:dashboard", title: "Distinct second history" });
const secondChat = db.insert("conversations", { channel: "web", externalId: "batch-second", threadId: secondThread, title: "Second verification", engine: "codex", codexRunnerId: runnerId, lastMessageAt: now - 1000 });
for (let i = 0; i < 20; i++) db.insert("agentMessages", {threadId: secondThread, userId: "web:dashboard", order: i, message: {role: i % 2 ? "assistant" : "user", content: `Distinct second history ${i+1}`}, text: `Distinct second history ${i+1}`});
const runId = db.insert("runs", { conversationId, prompt: "Live fixture prompt", status: "running", startedAt: now });
const turnId = db.insert("codexTurns", { runnerId, conversationId, runId, engine: "codex", prompt: "Live fixture prompt", instructions: "Fixture only", status: "running", createdAt: now, startedAt: now, lastHeartbeatAt: now });
db.insert("runSpans", {runId, kind: "commandExecution", name: "command", callId: "fixture-command", status: "ok", startedAt: now - 1000, endedAt: now, durationMs: 1000, input: JSON.stringify({command: "fixture inspect"}), output: Array.from({length:40}, (_,i)=>`Synthetic tool result line ${i+1}`).join("\n")});
const queued = [];
for (let i = 0; i < 10; i++) {
  const runId = db.insert("runs", { conversationId, prompt: `Queued fixture ${i + 1}`, status: "running", startedAt: now + i + 1 });
  queued.push(db.insert("codexTurns", { runnerId, conversationId, runId, engine: "codex", prompt: `Queued fixture ${i + 1}`, instructions: "Fixture only", status: "queued", createdAt: now + i + 1 }));
}
db.patch(conversationId, { pendingTurns: 11 });
const fixture = { home, conversationId, secondChat, buildId, runId, turnId, runnerId, token, queued, messageIds,
  url: `http://127.0.0.1:17484/chat/${conversationId}#key=batch-ui-synthetic`,
  schedulerStopped: true, backgroundStarted: false, profileBuild: true, savedMessages: 200 };
fs.writeFileSync(join(scratch, "fixture.json"), JSON.stringify(fixture, null, 2));
console.log(JSON.stringify({ fixture: join(scratch, "fixture.json"), url: fixture.url }));

// A loopback proxy injects the profiling hook into HTML only. Product code and
// startup are unchanged. SSE is streamed without buffering. No browser download.
const { createServer, request } = await import("node:http");
const hook = fs.readFileSync(join(repo, "artifacts/batch-3/profile-hook.js"), "utf8");
const voiceHook = fs.readFileSync(join(repo, "artifacts/batch-3/257/browser-fixture.js"), "utf8");
let delay = 0; const calls = [];
const events = new Set();
const proxy = createServer(async (req, res) => {
  if (req.url?.startsWith("/__batch/version/")) {
    const mode = req.url.split("/").pop(); process.env.PERRY_UI_BUILD_ID = mode === "same" ? buildId : mode === "missing" ? "" : "fixture-next-build";
    runtime.events.emit("change", ["updates"]); res.end("ok"); return;
  }
  if (req.url === "/__batch/reconnect") { for (const socket of events) socket.destroy(); res.end("ok"); return; }
  if (req.url?.startsWith("/__batch/delay/")) { delay = Math.min(3000, Number(req.url.split("/").pop()) || 0); res.end("ok"); return; }
  if (req.url === "/__batch/calls") { res.setHeader("content-type","application/json"); res.end(JSON.stringify(calls)); return; }
  if (req.url === "/__batch/fixture") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(fixture)); return; }
  if (req.url === "/__batch/stream" && req.method === "POST") {
    try {
      let input = ""; for await (const chunk of req) { input += chunk; if (input.length > 1024) throw Error("Fixture payload limit"); }
      const { text = "Stream update from isolated fixture." } = JSON.parse(input || "{}");
      await runtime.runMutation("codex:streamTurn", { token, id: turnId, text });
      res.end("ok");
    } catch (error) { res.statusCode = 400; res.end(String(error)); }
    return;
  }
  let body;
  if (req.method === "POST" && req.url?.startsWith("/api/backend")) {
    body = []; for await (const chunk of req) body.push(chunk); body = Buffer.concat(body);
    let call; try { call = JSON.parse(body.toString()); } catch { /* Forward malformed input to backend validation. */ }
    if (typeof call?.path === "string") {
      calls.push({path:call.path, at:Date.now()}); if (calls.length > 500) calls.shift();
      if (delay && ["dashboard:getChat", "dashboard:getChatMessages"].includes(call.path)) await new Promise(r=>setTimeout(r,delay));
    }
  }
  const upstream = request({ hostname: "127.0.0.1", port: 17483, path: req.url, method: req.method,
    headers: { ...req.headers, host: "127.0.0.1:17483", "accept-encoding": "identity" } }, (incoming) => {
    if ((incoming.headers["content-type"] ?? "").includes("text/event-stream")) { events.add(res); res.on("close",()=>{events.delete(res); incoming.destroy();}); }
    const headers = { ...incoming.headers }; delete headers["content-length"];
    res.writeHead(incoming.statusCode ?? 500, headers);
    if ((incoming.headers["content-type"] ?? "").includes("text/html")) {
      let html = ""; incoming.setEncoding("utf8"); incoming.on("data", (part) => { html += part; });
      incoming.on("end", () => res.end(html.replace("<head>", `<head><script>${hook}</script>${req.url.startsWith("/pet") ? `<script>${voiceHook}</script>` : ""}`)));
    } else incoming.pipe(res);
  });
  upstream.on("error", (error) => { res.statusCode = 502; res.end(String(error)); });
  if (body) upstream.end(body); else req.pipe(upstream);
});
proxy.listen(17484, "127.0.0.1");
process.once("exit", () => sql.close());
