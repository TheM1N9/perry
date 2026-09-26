import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/job-models/run.ts <outDir>
// Every turn names its Codex model, and each job (the heartbeat too) can have
// its own. A fresh PERRY_HOME, the production build (`pnpm build` first) on a
// free port, a stand-in Telegram, and the real runner and Codex as this
// machine has them: ~/.codex/config.toml may name a model the account cannot
// use (the Codex app wrote gpt-5.6-sol here), which is the case this is for.
//
// Ways it could fail:
//   1. A chat with no model picked runs on config.toml's model: a Telegram
//      message must get a real reply, run on the model Codex marks default.
//   2. A chat whose pick the account no longer offers breaks: it must fall
//      back to the default and reply.
//   3. A job's model is ignored: with the heartbeat set to another model on
//      the dashboard, its run must use that one; cleared, the default again.
//   4. The Work page does not offer it: each job row must have a model picker
//      showing the default by name, and picking there must save.
//   5. Any page throws: no uncaught errors in the browser.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/job-models/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "job-models-e2e-key";
const OWNER = "4242";
const home = mkdtempSync(join(tmpdir(), "perry-job-models-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

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
  TELEGRAM_BOT_TOKEN: "123456:job-models-e2e",
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
type Job = { id: string; name: string; builtin?: string; model?: string; lastResult?: string; lastError?: string };
type Run = { prompt: string; model?: string; status: string; error?: string; chatTitle: string };
const jobs = () => call<Job[]>("jobs:list");
const runs = () => call<Run[]>("dashboard:listRuns", { key: KEY });
const toOwner = (after: number) => telegram.sent.filter((message) => message.chat_id === OWNER && message.at > after);
/** The owner writes on Telegram; the reply once it has finished streaming. */
async function ask(text: string): Promise<{ reply: string; run?: Run }> {
  const at = Date.now();
  ownerSays(text);
  await until(async () => (await runs()).some((run) => run.prompt === text && run.status !== "running"), `the reply to "${text}"`, 240);
  await sleep(1_500);
  return { reply: toOwner(at).map((message) => message.text).join("\n"), run: (await runs()).find((run) => run.prompt === text) };
}
async function runHeartbeat(): Promise<Run | undefined> {
  const heartbeat = (await jobs()).find((job) => job.builtin === "heartbeat")!;
  const before = (await runs()).filter((run) => run.prompt.startsWith("⏰ Heartbeat")).length;
  await call("jobs:run", { id: heartbeat.id });
  await until(async () => (await runs()).filter((run) => run.prompt.startsWith("⏰ Heartbeat") && run.status !== "running").length > before, "the heartbeat to finish", 300);
  return (await runs()).find((run) => run.prompt.startsWith("⏰ Heartbeat"));
}

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  runner = start("runner");
  await until(async () => (await call<unknown[]>("models:list")).length > 0, "the runner to report the account's models", 120);
  await until(async () => Boolean((await jobs()).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  const models = await call<Array<{ id: string; name: string; isDefault: boolean }>>("models:list");
  const fallback = models.find((item) => item.isDefault) ?? models[0];
  const other = models.find((item) => item.id !== fallback.id)!;
  notes.models = models.map((item) => `${item.id}${item.isDefault ? " (default)" : ""}`);

  // 1. No model picked.
  const first = await ask("Reply with exactly the word pong.");
  notes.noPick = { reply: first.reply, model: first.run?.model, error: first.run?.error };
  checks.noPickRunsOnAccountDefault = /pong/i.test(first.reply) && !/That broke/.test(first.reply) && first.run?.model?.includes(`codex/${fallback.id}`) === true;

  // 2. A pick the account does not offer.
  const chat = await call<{ _id: string }>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER });
  await call("conversations:setModel", { id: chat._id, model: "gpt-5.6-sol" });
  const second = await ask("Reply with exactly the word ping.");
  notes.unofferedPick = { reply: second.reply, model: second.run?.model, error: second.run?.error };
  checks.unofferedPickFallsBack = /ping/i.test(second.reply) && !/That broke/.test(second.reply) && second.run?.model?.includes(`codex/${fallback.id}`) === true;

  // 3. The heartbeat on its own model, then back on the default.
  const heartbeat = (await jobs()).find((job) => job.builtin === "heartbeat")!;
  await call("jobs:setModel", { key: KEY, id: heartbeat.id, model: other.id });
  const onOther = await runHeartbeat();
  await call("jobs:setModel", { key: KEY, id: heartbeat.id });
  const onDefault = await runHeartbeat();
  notes.heartbeat = { onOther: { model: onOther?.model, status: onOther?.status, error: onOther?.error }, onDefault: { model: onDefault?.model, status: onDefault?.status, error: onDefault?.error } };
  checks.jobModelUsed = onOther?.model?.includes(`codex/${other.id}`) === true && onOther.status !== "error";
  checks.jobModelCleared = onDefault?.model?.includes(`codex/${fallback.id}`) === true && onDefault.status !== "error";

  // 4. The Work page.
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, ms = 20_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); tick(); })`);
  await send("Page.navigate", { url: `${BASE}/work?tab=schedules` });
  // The built-in jobs fold away; open them.
  await waitFor(`[...document.querySelectorAll("button")].some((b) => /^Built in/.test(b.innerText)) || !!document.querySelector('[aria-label="Model for Heartbeat"]')`, "the Schedules tab");
  await evaluate(`(() => { const toggle = [...document.querySelectorAll("button")].find((b) => /^Built in/.test(b.innerText)); if (toggle && !document.querySelector('[aria-label="Model for Heartbeat"]')) toggle.click(); return true; })()`);
  await waitFor(`!!document.querySelector('[aria-label="Model for Heartbeat"]')`, "the heartbeat's model picker");
  const shown = await evaluate(`document.querySelector('[aria-label="Model for Heartbeat"]').innerText.trim()`) as string;
  notes.pickerShows = shown;
  checks.pickerShowsDefaultByName = shown.includes("Default") && shown.includes(fallback.name);
  await evaluate(`document.querySelector('[aria-label="Model for Heartbeat"]').click(); true`);
  await waitFor(`[...document.querySelectorAll('[role="option"]')].some((o) => o.innerText.trim() === ${JSON.stringify(other.name)})`, "the model options");
  await evaluate(`[...document.querySelectorAll('[role="option"]')].find((o) => o.innerText.trim() === ${JSON.stringify(other.name)}).click(); true`);
  await until(async () => (await jobs()).find((job) => job.builtin === "heartbeat")?.model === other.id, "the pick to save", 20);
  await waitFor(`document.querySelector('[aria-label="Model for Heartbeat"]').innerText.includes(${JSON.stringify(other.name)})`, "the picker to show the pick");
  checks.pickingOnWorkPageSaves = true;
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "work-page.png"), Buffer.from(shot.data, "base64")));
  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  stub.close();
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, notes, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
