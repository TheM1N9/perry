import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/whatsapp-watchdog/run.ts <outDir>
// The WhatsApp watchdog reconnects a connection that has gone silent, not one
// where nobody happens to write. Baileys answers WhatsApp's keep-alive every 30
// seconds; the watchdog counted only messages and connection changes, so a real
// Perry reconnected every half hour, day and night. WhatsApp is stood in for by
// artifacts/whatsapp/fake-driver.mjs, whose { frame: true } is a keep-alive
// answer; the quiet limit is seconds here (PERRY_WHATSAPP_QUIET_MS). A fresh
// PERRY_HOME and the production build (`pnpm build` first); no runner is needed.
//
// Ways it could fail, written down before the checks:
//   1. Alive but with no messages (only keep-alive frames), it is reconnected anyway.
//   2. Gone silent (no frames either), it is never reconnected.
//   3. After a reconnect, what Perry has to send is not sent.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/whatsapp-watchdog/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const QUIET_MS = 6_000;
const free = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await free();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "whatsapp-watchdog-key";
const home = mkdtempSync(join(tmpdir(), "perry-whatsapp-watchdog-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
const OWNER = "919876543210@s.whatsapp.net";

const wa = { commands: [] as object[], sent: [] as Array<{ jid: string; text?: string; at: number }>, connects: [] as number[] };
const control = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const done = (value: unknown = true) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    switch (request.url) {
      case "/next":
        if (wa.commands.length) return done(wa.commands.splice(0));
        return void setTimeout(() => done(wa.commands.splice(0)), 300);
      case "/sent": wa.sent.push({ ...data, at: Date.now() }); return done();
      case "/connect": wa.connects.push(Date.now()); return done();
      default: return done();
    }
  });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const push = (...commands: object[]) => wa.commands.push(...commands);
const open = () => push({ user: { id: "15550001111:7@s.whatsapp.net", name: "Perry" } }, { event: "connection.update", data: { connection: "open" } });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  PERRY_WHATSAPP_DRIVER: join(REPO, "artifacts", "whatsapp", "fake-driver.mjs"),
  PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
  PERRY_WHATSAPP_QUIET_MS: String(QUIET_MS),
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY") delete env[name];
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

async function call<T>(path: string, args: object = {}, as: "admin" | "call" = "admin"): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${as}`, { method: "POST", headers: { "content-type": "application/json", ...(as === "admin" ? { "x-perry-key": KEY } : {}) }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}
const status = async () => (await call<{ status: string }>("whatsapp:status", { key: KEY }, "call")).status;
const reconnects = () => (log.match(/quiet for too long/g) ?? []).length;

try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("whatsapp:startLinking", { key: KEY, mode: "separate" }, "call");
  await until(() => wa.connects.length >= 1, "a connection", 30);
  open();
  await until(async () => (await status()) === "connected", "connected", 30);

  // --- 1. Alive, nobody writing: keep-alive answers only, for three times the quiet limit ---------------------------
  const aliveFor = QUIET_MS * 3;
  const connectsBefore = wa.connects.length;
  for (let at = 0; at < aliveFor; at += 1_000) { push({ frame: true }); await sleep(1_000); }
  check("aliveAndQuietStaysConnected", wa.connects.length === connectsBefore && reconnects() === 0 && (await status()) === "connected",
    { seconds: aliveFor / 1000, connects: wa.connects.length - connectsBefore, reconnects: reconnects() });

  // --- 2. Gone silent: no frames at all -------------------------------------------------------------------------------------
  const silentAt = Date.now();
  await until(() => wa.connects.length > connectsBefore, "a reconnect after going silent", 60).catch(() => {});
  check("silentIsReconnected", wa.connects.length > connectsBefore && reconnects() === 1,
    { secondsToReconnect: Math.round((wa.connects.at(-1)! - silentAt) / 1000), reconnects: reconnects() });

  // --- 3. After the reconnect, what waits is sent ---------------------------------------------------------------------------
  // A separate number sends only to its owner, who claims it with the pairing code.
  open();
  await until(async () => (await status()) === "connected", "connected again", 30);
  const { pairingCode } = await call<{ pairingCode?: string }>("whatsapp:status", { key: KEY }, "call");
  push({ event: "messages.upsert", data: { type: "notify", messages: [{ key: { id: `IN${Date.now()}`, remoteJid: OWNER, fromMe: false }, pushName: "Mani", message: { conversation: `my code is ${pairingCode}` } }] } });
  await until(() => wa.sent.some((message) => message.jid === OWNER), "the claim to be answered after the reconnect", 30).catch(() => {});
  check("sendsAfterReconnect", wa.sent.some((message) => message.jid === OWNER), { sent: wa.sent.map((message) => `${message.jid}: ${String(message.text).slice(0, 80)}`) });
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
}

if (server.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill("SIGTERM");
control.close();
await sleep(2_000);
notes.serverLog = log.split("\n").filter((line) => /WhatsApp/.test(line)).slice(-20);
try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
const passed = Object.values(checks).every(Boolean);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), quietMs: QUIET_MS, checks, notes, passed }, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed }, null, 2));
process.exit(passed ? 0 : 1);
