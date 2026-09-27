import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/unprompted-rules/run.ts <outDir>
// Issue #107: rules for what Perry says on his own. A fresh Perry (production
// build, `pnpm build` first) with a stand-in Telegram, paired as the owner's
// home app. No runner or Codex: job results are finished as a run would.
//
// Ways it could fail, written down before the checks:
//   1. In quiet hours a job's result still reaches the phone, or is lost
//      instead of waiting.
//   2. A reminder that is due waits for quiet hours to end.
//   3. A report for a web chat waits, though it buzzes nothing.
//   4. When quiet hours end, what waited does not go, goes one by one, or
//      goes twice.
//   5. Past the day's limit, more still reach the phone; or reminders use up
//      the limit.
//   6. Three unanswered messages from one schedule bring no offer to pause it,
//      or bring it again and again.
//   7. The owner writing does not count as an answer.
//   8. The next turn is not told of the offer, so "yes, pause it" means nothing.
//   9. Settings do not save, take nonsense, or do not render.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/unprompted-rules/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "unprompted-rules-e2e-key";
const OWNER = "4242";
const TZ = "Asia/Kolkata";
const home = mkdtempSync(join(tmpdir(), "perry-manners-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

type Sent = { text: string; buttons: number; at: number };
const telegram = { sent: [] as Sent[], pending: [] as object[], nextUpdate: 1 };
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
    if (method === "sendMessage" && String(args.chat_id) === OWNER) {
      telegram.sent.push({ text: String(args.text), buttons: (args.reply_markup?.inline_keyboard ?? []).flat().length, at: Date.now() });
      return reply({ message_id: telegram.sent.length });
    }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false, first_name: "Mani" }, text },
});
const since = (at: number) => telegram.sent.filter((message) => message.at >= at);

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:manners-e2e", TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
let serverLog = "";
const server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { serverLog += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk; });
const stop = (child: ChildProcess) => { if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
const refusal = (path: string, args: object) => call(path, args).then(() => null, (error: Error) => error.message);
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
/** A time on the owner's clock, some minutes from now, as HH:MM. */
const clock = (minutes: number) => new Date(Date.now() + minutes * 60_000).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const makeJob = async (name: string, origin?: string) => (await call<{ id: string }>("jobs:create", { name, prompt: `Report on ${name}, briefly.`, schedule: "0 3 1 1 *", ...(origin ? { origin } : {}) })).id;
/** A job's run finished with this result, as a real run would report it. */
const finish = async (id: string, result: string) => { await call("jobs:finished", { id, result }); };
const waiting = async () => (await call<{ waiting: number }>("dashboard:getManners", { key: KEY })).waiting;

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  await call("jobs:setTimezone", { key: KEY, timezone: TZ });
  const brief = await makeJob("Morning brief");
  const prices = await makeJob("Price check");
  const web = await call<string>("dashboard:createChat", { key: KEY });
  const webJob = await makeJob("Web report", web);

  // --- 9. Settings refuse nonsense -------------------------------------------------------
  const badClock = await refusal("dashboard:setManners", { key: KEY, quietHours: { start: "25:00", end: "07:00" } });
  const badLimit = await refusal("dashboard:setManners", { key: KEY, dailyLimit: 0 });
  check("settingsRefuseNonsense", Boolean(badClock && badLimit), { badClock, badLimit });

  // --- 1–4. Quiet hours ---------------------------------------------------------------------
  await call("dashboard:setManners", { key: KEY, quietHours: { start: clock(-60), end: clock(60) } });
  let at = Date.now();
  await finish(brief, "Three meetings today; the first at 10.");
  await finish(prices, "The laptop is down to ₹58,000.");
  await finish(webJob, "Here is the web report.");
  await sleep(3_000);
  check("quietHoldsPhoneMessages", !since(at).some((message) => /meetings|laptop/.test(message.text)) && (await waiting()) === 2, { sent: since(at).map((m) => m.text), waiting: await waiting() });
  const webMessages = (await call<{ page: Array<{ role: string; text: string }> }>("dashboard:getChatMessages", { key: KEY, id: web, paginationOpts: { numItems: 10, cursor: null } })).page;
  check("webChatNeverWaits", webMessages.some((message) => message.text.includes("web report")));
  const todoId = await call<string>("todos:add", { key: KEY, title: "Take the medicine", dueAt: Date.now() - 1_000 });
  await call("todos:remind", { id: todoId });
  await until(() => since(at).some((message) => message.text.includes("Take the medicine")), "the reminder", 15).catch(() => {});
  check("reminderGoesInQuietHours", since(at).some((message) => message.text.includes("Take the medicine") && message.buttons > 0));
  await call("dashboard:setManners", { key: KEY });
  at = Date.now();
  await call("notify:releaseHeld", {});
  await sleep(1_500);
  const released = since(at).filter((message) => /meetings|laptop/.test(message.text));
  check("quietEndReleasesAsOne", released.length === 1 && /meetings/.test(released[0].text) && /laptop/.test(released[0].text) && /2 messages waited for your quiet hours to end/.test(released[0].text), released.map((m) => m.text));
  await call("notify:releaseHeld", {});
  await sleep(1_000);
  check("releasedOnlyOnce", since(at).filter((message) => /meetings|laptop/.test(message.text)).length === 1 && (await waiting()) === 0);

  // --- 5. The day's limit -----------------------------------------------------------------
  const today = since(0).filter((message) => !message.text.includes("Take the medicine") && !message.text.startsWith("Paired")).length;
  await call("dashboard:setManners", { key: KEY, dailyLimit: today + 2 });
  at = Date.now();
  const one = await makeJob("One");
  const two = await makeJob("Two");
  const three = await makeJob("Three");
  await finish(one, "First of the day's news.");
  await finish(two, "Second of the day's news.");
  await finish(three, "Third of the day's news.");
  await sleep(3_000);
  const newsSent = since(at).filter((message) => /of the day's news/.test(message.text));
  check("limitHoldsTheRest", newsSent.length === 2 && (await waiting()) === 1, { sent: newsSent.map((m) => m.text), waiting: await waiting() });
  await call("dashboard:setManners", { key: KEY });
  await call("notify:releaseHeld", {});
  await sleep(1_000);

  // --- 6–8. Ignored ------------------------------------------------------------------------
  const noisy = await makeJob("Stock ticker");
  at = Date.now();
  for (const n of [1, 2, 3, 4]) { await finish(noisy, `Ticker update ${n}.`); await sleep(800); }
  await sleep(2_000);
  const offers = () => telegram.sent.filter((message) => /without hearing back/.test(message.text) && message.text.includes("Stock ticker"));
  check("offersToPauseAfterThree", offers().length === 1 && since(at).findIndex((m) => /without hearing back/.test(m.text)) === 3, since(at).map((m) => m.text.slice(0, 60)));
  const chat = await call<{ unprompted?: Array<{ text: string }> } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER });
  check("nextTurnKnowsTheOffer", Boolean(chat?.unprompted?.some((item) => /Should I pause that schedule/.test(item.text))));
  ownerSays("thanks, keep it for now");
  await until(async () => ((await call<{ ownerWroteAt?: number } | null>("installation:get", {}))?.ownerWroteAt ?? 0) > at, "the owner's message to count", 20).catch(() => {});
  at = Date.now();
  for (const n of [5, 6]) { await finish(noisy, `Ticker update ${n}.`); await sleep(800); }
  await sleep(2_000);
  check("writingCountsAsAnAnswer", offers().length === 1 && since(at).filter((m) => /Ticker update/.test(m.text)).length === 2);

  // --- 9. The page --------------------------------------------------------------------------
  await call("dashboard:setManners", { key: KEY, quietHours: { start: "22:00", end: "07:00" }, dailyLimit: 5 });
  browser = await openChat(BASE, KEY);
  await browser.send("Page.navigate", { url: `${BASE}/settings` });
  await until(() => browser!.evaluate(`document.body.innerText.includes("Messages Perry sends on his own")`), "the Settings section", 30).catch(() => {});
  await sleep(1_500);
  const shown = await browser.evaluate(`({ quietFrom: document.querySelector('input[aria-label="Quiet from"]')?.value, quietTo: document.querySelector('input[aria-label="Quiet until"]')?.value, limit: document.querySelector('[aria-label="Daily limit"]')?.textContent })`) as { quietFrom?: string; quietTo?: string; limit?: string };
  const shot = await browser.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "settings-manners.png"), Buffer.from(shot.data, "base64"));
  check("settingsShowWhatIsSaved", shown.quietFrom === "22:00" && shown.quietTo === "07:00" && /5 a day/.test(shown.limit ?? ""), shown);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(server);
  stub.close();
  await sleep(2_000);
  notes.telegram = telegram.sent.map(({ text, buttons }) => ({ buttons, text: text.slice(0, 200) }));
  writeFileSync(join(outDir, "server.log"), serverLog.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
