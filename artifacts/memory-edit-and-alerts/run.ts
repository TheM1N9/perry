import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/memory-edit-and-alerts/run.ts <outDir>
// Two promises from the landing page and the film, on a fresh PERRY_HOME with
// the production build (`pnpm build` first) on a free port and a stand-in
// Telegram Bot API. No runner and no Codex: what a briefing is told is read
// from its run's prompt, which is recorded before Codex is asked. It checks
// https://example.com once, for the page watch. The temp folder is deleted at
// the end.
//
// "Read, edit or wipe any of it": ways editing a memory could fail
//   1. There is no way to edit: the Memory page must offer Edit, and saving
//      must change the memory's words, with "Edited" shown after.
//   2. Editing changes what it should not: the memory keeps its kind, day and
//      first date, and becomes the owner's (origin owner).
//   3. Editing gets around the budget: a profile memory edited past its
//      layer's budget must be refused with the reason, and left as it was.
//   4. An empty edit is saved: it must be refused.
//
// "It's in your 7:00 brief": ways an alert could fail to reach the briefing
//   5. A page watch fires but leaves no trace: the owner must get it on
//      Telegram and a daily note "Alerted the owner at HH:MM" must be kept.
//   6. The heartbeat speaks up but leaves no trace: the same.
//   7. The briefing is not told: a recurring job of the owner's must be given
//      both alerts; one from before its last run must not be repeated.
//   8. Everything is told about alerts: a one-time reminder and the built-in
//      daily summary must not be.
//   9. Any page throws: no uncaught errors in the browser.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/memory-edit-and-alerts/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// A free port, so a server someone else left running is never the one tested.
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "memory-alerts-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-memory-alerts-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

// --- A stand-in Telegram, so the owner can be claimed and alerts delivered -----------

const telegram = { sent: [] as Array<{ chat_id: unknown; text: string }>, pending: [] as object[] };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    if (method === "sendMessage") { telegram.sent.push({ chat_id: args.chat_id, text: String(args.text) }); return reply({ message_id: telegram.sent.length }); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:memory-alerts-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

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
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
type Memory = { id: string; text: string; kind: string; day?: string; origin?: string; createdAt: number; editedAt?: number; tags: string[] };
const memories = (kind?: string) => call<Memory[]>("dashboard:listMemories", { key: KEY, query: "", ...(kind ? { kind } : {}) });
const runPrompts = async () => (await call<Array<{ prompt: string; chatTitle: string }>>("dashboard:listRuns", { key: KEY }));

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);

  // The owner, claimed on the stand-in Telegram, so alerts have somewhere to go.
  const { code } = await call<{ code: string }>("installation:startPairing", {}, true);
  telegram.pending.push({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 777, type: "private" }, from: { id: 777, is_bot: false, first_name: "Owner" }, text: code } });
  await until(async () => (await call<{ claimed: boolean }>("installation:status", {}, true)).claimed, "the owner to be claimed", 30);

  // --- Editing a memory -------------------------------------------------------------
  await call("memories:add", { text: "The owner's usual coffee is a flat white.", tags: [], source: "e2e", kind: "core", origin: "tool" }, true);
  const before = (await memories("core")).find((memory) => memory.text.includes("flat white"))!;
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, ms = 20_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); tick(); })`);
  const type = (selector: string, value: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const row = `[...document.querySelectorAll(".item")].find((item) => item.innerText.includes("flat white") || item.querySelector("textarea"))`;

  await send("Page.navigate", { url: `${BASE}/memory` });
  await waitFor(`!!(${row})`, "the memory on the Memory page");
  checks.editIsOffered = await evaluate(`[...(${row}).querySelectorAll("button")].some((b) => b.innerText.trim() === "Edit")`);
  await evaluate(`[...(${row}).querySelectorAll("button")].find((b) => b.innerText.trim() === "Edit").click(); true`);
  await waitFor(`!!document.querySelector(".item textarea")`, "the edit box");
  await type(".item textarea", "The owner's usual coffee is black, no sugar.");
  await evaluate(`[...document.querySelectorAll(".item button")].find((b) => b.innerText.trim() === "Save").click(); true`);
  await waitFor(`[...document.querySelectorAll(".item")].some((item) => item.innerText.includes("black, no sugar") && item.innerText.includes("Edited"))`, "the edited memory, marked Edited");
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "memory-edited.png"), Buffer.from(shot.data, "base64")));
  const after = (await memories("core")).find((memory) => memory.id === before.id);
  notes.edited = { before, after };
  checks.editChangesWords = after?.text === "The owner's usual coffee is black, no sugar." && Boolean(after?.editedAt);
  checks.editKeepsTheRest = after?.kind === before.kind && after?.day === before.day && after?.createdAt === before.createdAt && after?.origin === "owner";

  // Over the profile budget (4,000 characters), and empty: both refused, nothing changed.
  await call("memories:add", { text: "Prefers short replies.", tags: [], source: "e2e", kind: "profile", origin: "owner" }, true);
  const profile = (await memories("profile")).find((memory) => memory.text === "Prefers short replies.")!;
  const tooLong = await call<string | null>("dashboard:editMemory", { key: KEY, id: profile.id, text: `Prefers short replies. ${"x".repeat(4_100)}` });
  const empty = await call<string | null>("dashboard:editMemory", { key: KEY, id: profile.id, text: "  " });
  const unchanged = (await memories("profile")).find((memory) => memory.id === profile.id);
  notes.refused = { tooLong, empty };
  checks.editRespectsBudget = Boolean(tooLong && /budget/i.test(tooLong)) && unchanged?.text === "Prefers short replies.";
  checks.emptyEditRefused = Boolean(empty) && unchanged?.text === "Prefers short replies.";

  // --- Alerts, and the brief --------------------------------------------------------
  const brief = await call<{ id: string }>("jobs:create", { name: "Morning brief", schedule: "0 7 * * *", prompt: "Brief me on my day." }, true);
  const reminder = await call<{ id: string }>("jobs:create", { name: "Call Sam", at: new Date(Date.now() + 86_400_000).toISOString(), prompt: "Remind me to call Sam." }, true);
  // An alert from before the brief last ran, which it must not be told again.
  await call("memories:noteAlert", { text: "An old alert from before the last brief.", at: "06:00" }, true);
  await sleep(50);
  const lastBrief = Date.now();
  await sleep(50);

  // A page watch that fires on its first check.
  await call("work:createMonitor", { title: "E2E watch", url: "https://example.com", condition: "contains", value: "Example Domain", intervalMinutes: 1440 }, true);
  await call("dashboard:checkMonitorsNow", { key: KEY });
  // The heartbeat speaking up. The built-in jobs are made by the first minute's tick.
  const builtin = async (name: string) => (await call<Array<{ id: string; builtin?: string }>>("jobs:list", {}, true)).find((job) => job.builtin === name);
  await until(async () => Boolean(await builtin("heartbeat")), "the built-in jobs", 90);
  const heartbeat = (await builtin("heartbeat"))!;
  await call("jobs:finished", { id: heartbeat.id, result: "Your 6:40 flight moved to 7:25." }, true);

  await until(() => telegram.sent.some((message) => message.text.includes("E2E watch")) && telegram.sent.some((message) => message.text.includes("flight moved")), "both alerts on Telegram", 30);
  const alertNotes = (await memories("daily")).filter((memory) => memory.tags.includes("alert"));
  notes.alertNotes = alertNotes.map((memory) => memory.text);
  checks.watchAlertIsNoted = alertNotes.some((memory) => /^Alerted the owner at \d\d:\d\d: E2E watch: Found "Example Domain"/.test(memory.text));
  checks.heartbeatAlertIsNoted = alertNotes.some((memory) => /^Alerted the owner at \d\d:\d\d: Your 6:40 flight moved to 7:25\./.test(memory.text));

  // The brief, as the scheduler runs it: since its last run. The reminder and the daily summary, too.
  await call("jobs:run", { id: brief.id, since: lastBrief }, true);
  await call("jobs:run", { id: reminder.id }, true);
  const summary = (await builtin("daily-summary"))!;
  await call("jobs:run", { id: summary.id }, true);
  await until(async () => (await runPrompts()).filter((run) => /Morning brief|Call Sam|Daily summary/.test(run.prompt)).length >= 3, "the three runs", 30);
  const prompts = await runPrompts();
  const briefPrompt = prompts.find((run) => run.prompt.includes("Morning brief"))?.prompt ?? "";
  const reminderPrompt = prompts.find((run) => run.prompt.includes("Call Sam"))?.prompt ?? "";
  const summaryPrompt = prompts.find((run) => run.prompt.includes("Daily summary"))?.prompt ?? "";
  notes.briefPrompt = briefPrompt;
  checks.briefIsToldBothAlerts = briefPrompt.includes("Alerts you sent the owner since this job last ran") && briefPrompt.includes("E2E watch") && briefPrompt.includes("flight moved to 7:25");
  checks.briefNotToldOlderAlerts = !briefPrompt.includes("An old alert from before the last brief");
  checks.othersNotTold = !reminderPrompt.includes("Alerts you sent") && !summaryPrompt.includes("Alerts you sent") && reminderPrompt.length > 0 && summaryPrompt.length > 0;

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (server.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill("SIGTERM");
  stub.close();
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), log.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed }, null, 2));
if (existsSync(home)) console.log(`(could not remove ${home})`);
process.exit(result.passed ? 0 : 1);
