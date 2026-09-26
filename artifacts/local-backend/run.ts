import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChat, sleep } from "../browser";

// bun artifacts/local-backend/run.ts <outDir> [convex-export.zip]
// Perry with no Convex anywhere: a fresh PERRY_HOME in a temp folder, the
// production build (`pnpm build` first) served by `next start` on port 3011,
// the real runner, the real Codex on this machine (one turn), and a stand-in
// Telegram Bot API (TELEGRAM_API_BASE) that records what Perry sends and
// hands it updates, so long polling and pairing are tested without Telegram.
// Everything it makes is in the temp folder, which is deleted at the end.
//
// Ways the move off Convex could fail, and what catches each:
//   1. The server does not start the backend: /api/backend/http/health must
//      answer, ~/.perry/perry.sqlite must exist, and a new install must be
//      pending onboarding.
//   2. This computer is not connected: runner.json must name the local server
//      with a token, and the runner must show online with Codex signed in.
//   3. The dashboard does not render, or does not stay live: the chat page
//      must render, and a memory added from outside (the CLI's admin call)
//      must appear on the Memory page without reloading it.
//   4. A chat turn does not flow: a message sent from the dashboard must
//      reach the runner and Codex and end with a reply saved in the chat (or,
//      if Codex's own quota is used up, with that error shown, recorded as such).
//   5. Telegram is not polled: with a bot token, the server must remove the
//      old webhook, take a pairing code sent as an update, claim the install,
//      and answer through sendMessage.
//   6. Nothing survives a restart: after the server stops and starts again,
//      the chat, its messages and the claim must still be there, and the
//      runner must not be paired again.
//   7. Data cannot come over from Convex: given an export, perry migrate's
//      import must bring its chats and messages in.
//   8. Any page throws: no uncaught errors in the browser.

const [outDir, exportZip] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/local-backend/run.ts <outDir> [convex-export.zip]");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(import.meta.dirname, "../..");
const PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "local-backend-e2e-key";
const BOT = "123456:local-backend-e2e";
const home = mkdtempSync(join(tmpdir(), "perry-local-e2e-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = { home };

// --- A stand-in for Telegram's Bot API ---------------------------------------------

const telegram = { webhookDeleted: false, sent: [] as Array<{ chat_id: unknown; text: unknown }>, pending: [] as object[], nextId: 1000 };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "deleteWebhook") { telegram.webhookDeleted = true; return reply(true); }
    if (method === "getMe") return reply({ id: 1, is_bot: true, username: "perry_e2e_bot" });
    if (method === "getUpdates") {
      // Long polling: answer at once when there is something, otherwise after a short wait.
      const answer = () => { const updates = telegram.pending.splice(0); reply(updates); };
      if (telegram.pending.length) return answer();
      return void setTimeout(answer, 1_000);
    }
    if (method === "sendMessage") { telegram.sent.push({ chat_id: args.chat_id, text: args.text }); return reply({ message_id: telegram.nextId++ }); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const stubPort = (stub.address() as { port: number }).port;

// --- The server and the runner, as `perry run` starts them ---------------------------

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home,
  PERRY_PORT: String(PORT),
  DASHBOARD_KEY: KEY,
  TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_API_BASE: `http://127.0.0.1:${stubPort}`,
  NODE_ENV: "production",
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL") delete env[name];

const logs: Record<string, string> = { server: "", runner: "" };
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child: ChildProcess = spawn(command, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  return child;
}
function stop(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
async function call<T>(path: string, args: object = {}, admin = false): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${admin ? "admin" : "call"}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { "x-perry-key": KEY } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
const healthy = () => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false);

let server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;

try {
  // 1. The backend starts with the server.
  await until(healthy, "the server to answer", 90);
  const install = await call<{ claimed: boolean; onboarding: string }>("installation:status", {}, true);
  checks.backendStarts = existsSync(join(home, "perry.sqlite")) && install.onboarding === "pending" && !install.claimed;
  notes.installAtStart = install;

  // 2. The runner is connected by the server, and comes online.
  const config = JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { url?: string; token?: string };
  checks.runnerPairedByServer = config.url === `http://127.0.0.1:${PORT}` && Boolean(config.token);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners", {}, true)).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 90);
  checks.runnerOnline = true;

  // 5. Telegram: the old webhook goes, a pairing code arrives as an update, and the install is claimed.
  await until(() => telegram.webhookDeleted, "the server to remove the webhook", 30);
  const { code } = await call<{ code: string }>("installation:startPairing", {}, true);
  telegram.pending.push({ update_id: 5001, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private" }, from: { id: 4242, is_bot: false, first_name: "Owner" }, text: code } });
  await until(async () => (await call<{ claimed: boolean }>("installation:status", {}, true)).claimed, "the pairing code to claim the install", 30);
  await until(() => telegram.sent.some((message) => String(message.chat_id) === "4242" && String(message.text).includes("Paired")), "Perry to answer on Telegram", 30);
  checks.telegramPollingClaims = true;
  notes.telegramSent = telegram.sent;

  // 3. The dashboard renders and stays live.
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, ms = 30_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 200); tick(); })`);
  checks.chatPageRenders = await evaluate(`!!document.querySelector('.chat-composer-box textarea')`);
  await send("Page.navigate", { url: `${BASE}/memory` });
  await waitFor(`document.querySelector(".page-head h1")?.innerText === "Memory"`, "the Memory page to render");
  await sleep(1500);
  await call("memories:add", { text: "The owner's local-backend test memory is a blue teapot.", tags: ["e2e"], source: "e2e", kind: "core", origin: "owner" }, true);
  await waitFor(`document.body.innerText.includes("blue teapot")`, "the new memory to appear without a reload", 15_000);
  checks.dashboardStaysLive = true;
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "memory-live.png"), Buffer.from(shot.data, "base64")));

  // 4. A chat turn, from the dashboard through the runner and Codex.
  const chatId = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: chatId, text: "Reply with exactly the word pong and nothing else." });
  await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chatId })).isRunning, "the turn to finish", 240);
  const chat = await call<{ lastError?: string }>("dashboard:getChat", { key: KEY, id: chatId });
  const page = await call<{ page: Array<{ role: string; text: string }> }>("dashboard:getChatMessages", { key: KEY, id: chatId, paginationOpts: { numItems: 10, cursor: null } });
  const reply = page.page.find((message) => message.role === "assistant")?.text ?? null;
  notes.turn = { reply, error: chat.lastError ?? null };
  checks.turnReachesCodex = Boolean(reply) || /usage limit/i.test(chat.lastError ?? "");
  checks.turnReplies = /pong/i.test(reply ?? "");
  await send("Page.navigate", { url: `${BASE}/chat/${chatId}` });
  await waitFor(`document.querySelectorAll('.chat-turn').length >= 1`, "the chat to render");
  await sleep(800);
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "chat.png"), Buffer.from(shot.data, "base64")));
  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
  browser.close();
  browser = null;

  // 6. A restart keeps everything, and does not pair the runner again.
  const tokenBefore = config.token;
  stop(server);
  await until(async () => !(await healthy()), "the server to stop", 30);
  server = start("server");
  await until(healthy, "the server to come back", 90);
  const after = JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token?: string };
  const messagesAfter = await call<{ page: unknown[] }>("dashboard:getChatMessages", { key: KEY, id: chatId, paginationOpts: { numItems: 10, cursor: null } });
  checks.survivesRestart = after.token === tokenBefore
    && messagesAfter.page.length === page.page.length
    && (await call<{ claimed: boolean }>("installation:status", {}, true)).claimed;

  // 7. Bringing data over from a Convex export, with the command itself: perry migrate --from <zip>.
  if (exportZip && existsSync(exportZip)) {
    const folder = join(home, "cli");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, ".env.local"), `DASHBOARD_KEY=${KEY}\n`);
    const migrated = spawnSync(process.execPath, [join(REPO, "scripts", "migrate.ts"), "--from", resolve(exportZip), "--replace"], { cwd: folder, env, encoding: "utf8" });
    const output = `${migrated.stdout}${migrated.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
    notes.imported = output.trim().split("\n").filter((line) => line.trim());
    const chats = await call<unknown[]>("dashboard:listChats", { key: KEY });
    // listChats has web chats only; the export may also hold Telegram ones.
    checks.importsConvexExport = migrated.status === 0 && /imported \d+ chats \(\d+ histories, [1-9]\d* messages\)/.test(output) && chats.length > 0;
  } else {
    notes.imported = "skipped: no export given";
  }
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (runner) stop(runner);
  stop(server);
  stub.close();
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replace(/token[^\n]*/gi, "token <hidden>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), platform: process.platform, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
