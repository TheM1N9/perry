import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewInstructions } from "../../runner/review";
import { openChat, sleep } from "../browser";

// bun artifacts/gap-fixes/run.ts <outDir> [models dir to copy, so the sentence model is not downloaded again]
// The fixes from issues #91–#98, in a fresh PERRY_HOME: the production build
// (`pnpm build` first) on a free port, a stand-in Telegram that records every
// call and can tap buttons, the real runner and Codex (PERRY_E2E_MODEL picks
// the model), and headless Chrome for the Work page's forms and the chat list.
// Public test pages come from httpbin.org/base64, whose body is the page.
//
// Ways it could fail, written down before the checks:
//  Page watches (#91, #92)
//   1. A contains watch never speaks again once its text goes and comes back.
//   2. It speaks on every check while the text stays, or right after the
//      upgrade for a watch that had already fired.
//   3. The text going is not noticed.
//   4. A rupee price is not found, or misread (1,23,456 grouping), or compared
//      across currencies: a dollar figure against a rupee target.
//   5. A price watch speaks on every check while the price stays below.
//   6. The form takes a price that is not one, or a page that is not a URL.
//  Reviewer (#93)
//   7. On macOS or Linux it is still told about Windows and PowerShell; under
//      WSL it loses the Windows rules; on Windows it loses its own.
//  Memory (#94, #95)
//   8. A daily note is filed under the UTC date, not the owner's, and "today"
//      misses it.
//   9. The sentence model cannot load in the production server.
//  10. "What do I eat?" does not find "I'm vegetarian"; a question in English
//      does not find a note in Hindi.
//  11. Plain word search stops working.
//  12. An edited memory is found by its old meaning.
//  13. Unrelated memories come back for a question about nothing stored.
//  Approvals (#98)
//  14. With the owner away, a web chat's approval does not reach Telegram, or
//      comes without buttons, or a tap does not settle it.
//  15. With the owner at the computer, it goes to the phone anyway.
//  16. With no pet running, it never goes to the phone.
//  17. One from the Telegram chat is asked there twice.
//  Chat list (#96)
//  18. The Telegram chat is not listed, or not marked as Telegram.
//  19. It cannot be opened, or its history is missing.
//  20. Written in from the web: the web does not show the message while
//      waiting, the reply does not reach Telegram, the phone does not see what
//      was written, or the reply is not in the web history.
//  21. Deleting or branching it works, or the page offers them.
//  22. Search does not find its messages.
//  Work page (#97)
//  23. A schedule, goal or watch made on the page is not saved, or saved
//      differently from the agent's tool (cron, timezone, one-time).
//  24. Bad input is taken: a sentence for a cron schedule, a time passed.
//  25. Saving a paused schedule unchanged resumes it; a new time does not move
//      it; a built-in job's name can be changed.
//  26. Changing a goal loses its milestones' ticks.
//  27. Changing a watch's page does not start it over.
//  28. The forms do not render or save in the real page.

// Bun's SQLite, named at run time: the project's typecheck knows Node's types, not Bun's.
type Sqlite = { exec(sql: string): void; run(sql: string, params: unknown[]): void; query(sql: string): { get(): unknown }; close(): void };
const bunSqlite = "bun:sqlite";
const { Database } = await import(bunSqlite) as { Database: new (path: string) => Sqlite };

const [outDir, modelsFrom] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/gap-fixes/run.ts <outDir> [modelsDir]");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "gap-fixes-e2e-key";
const OWNER = "4242";
const home = mkdtempSync(join(tmpdir(), "perry-gaps-"));
if (modelsFrom && existsSync(modelsFrom)) cpSync(modelsFrom, join(home, "models"), { recursive: true });
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

// --- A stand-in Telegram ------------------------------------------------------

type Sent = { chat_id: string; text: string; buttons: string[]; at: number };
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
    if (method === "sendMessage") {
      const buttons = (args.reply_markup?.inline_keyboard ?? []).flat().map((button: { callback_data: string }) => button.callback_data);
      telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), buttons, at: Date.now() });
      return reply({ message_id: telegram.sent.length });
    }
    if (method === "editMessageText") {
      const message = telegram.sent[Number(args.message_id) - 1];
      if (message) Object.assign(message, { text: String(args.text) });
      return reply(true);
    }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const from = { id: Number(OWNER), is_bot: false, first_name: "Mani" };
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from, text },
});
const ownerTaps = (data: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  callback_query: { id: `tap-${telegram.nextUpdate}`, from, data, message: { message_id: 1, chat: { id: Number(OWNER), type: "private" } } },
});
const toOwner = (after: number) => telegram.sent.filter((message) => message.chat_id === OWNER && message.at > after);

// --- Perry --------------------------------------------------------------------

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex",
  TELEGRAM_BOT_TOKEN: "123456:gaps-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
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
async function call<T>(path: string, args: object = {}, as: "admin" | "call" = "admin"): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${as}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(as === "admin" ? { "x-perry-key": KEY } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
/** The server's refusal, or null when it took it. */
const refusal = (path: string, args: object) => call(path, args).then(() => null, (error: Error) => error.message);
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
// httpbin takes standard base64 only; its slashes are escaped in the path.
const page = (html: string) => `https://httpbin.org/base64/${encodeURIComponent(Buffer.from(html).toString("base64"))}`;
type Monitor = { _id: string; title: string; url: string; condition: string; value?: string; lastObservation?: string; lastFingerprint?: string; met?: boolean; firedAt?: number; intervalMinutes: number };
const monitors = async () => (await call<{ monitors: Monitor[] }>("dashboard:getWork", { key: KEY })).monitors;
const monitor = async (id: string) => (await monitors()).find((item) => item._id === id)!;
/** Check one watch now, and say what it saw. */
async function checkWatch(id: string): Promise<string> {
  await call("work:markMonitorsDue", { monitorId: id });
  await call("web:checkMonitors", {});
  return (await monitor(id)).lastObservation ?? "";
}
type Job = { id: string; name: string; schedule?: string; runAt?: number; prompt: string; enabled: boolean; builtin?: string; nextRunAt: number };
const jobs = async () => (await call<{ jobs: Job[] }>("jobs:listForDashboard", { key: KEY })).jobs;
type Message = { role: string; text: string; pending?: boolean };
const messagesOf = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 30, cursor: null } })).page;

// --- 7. The reviewer's rules, for each kind of machine -------------------------

const rules = {
  windows: reviewInstructions("win32", false),
  macos: reviewInstructions("darwin", false),
  linux: reviewInstructions("linux", false),
  wsl: reviewInstructions("linux", true),
};
for (const [name, text] of Object.entries(rules)) writeFileSync(join(outDir, `reviewer-${name}.txt`), text);
check("reviewerWindows", /Windows computer/.test(rules.windows) && /Remove-Item/.test(rules.windows) && /HKLM/.test(rules.windows) && /-EncodedCommand/.test(rules.windows));
check("reviewerMacos", /macOS computer/.test(rules.macos) && /launchctl/.test(rules.macos) && /Keychain/.test(rules.macos) && !/Windows|PowerShell|Remove-Item|HKLM/.test(rules.macos));
check("reviewerLinux", /Linux computer/.test(rules.linux) && /systemctl/.test(rules.linux) && /sudo/.test(rules.linux) && !/Windows|Remove-Item|HKLM|Keychain/.test(rules.linux));
check("reviewerWsl", /WSL/.test(rules.wsl) && /systemctl/.test(rules.wsl) && /Remove-Item/.test(rules.wsl) && /\/mnt/.test(rules.wsl));

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const token = (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string }).token;
  // Perry's own database, opened only for the moment of each change, so the server is never kept waiting on a lock.
  const withDb = <T>(use: (db: Sqlite) => T): T => {
    const db = new Database(join(home, "perry.sqlite"));
    try { db.exec("PRAGMA busy_timeout = 5000;"); return use(db); } finally { db.close(); }
  };
  const patchDoc = (table: string, id: string, path: string, value: unknown) =>
    withDb((db) => db.run(`UPDATE "doc_${table}" SET doc = json_set(doc, ?, json(?)) WHERE _id = ?`, [path, JSON.stringify(value), id]));

  // --- 8. A daily note on the owner's calendar ---------------------------------
  const utcDay = new Date().toISOString().slice(0, 10);
  const zone = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find((name) => new Date().toLocaleDateString("en-CA", { timeZone: name }) !== utcDay)!;
  const theirDay = new Date().toLocaleDateString("en-CA", { timeZone: zone });
  await call("jobs:setTimezone", { key: KEY, timezone: zone });
  await call("dashboard:addMemory", { key: KEY, text: "Went to the dentist; the filling is fine.", kind: "daily" });
  const today = await call<Array<{ text: string; day?: string }>>("memories:read", { kind: "daily" });
  const note = today.find((memory) => memory.text.includes("dentist"));
  check("dailyNoteOnOwnersDay", note?.day === theirDay && theirDay !== utcDay, { zone, utcDay, theirDay, filedAs: note?.day });
  await call("jobs:setTimezone", { key: KEY, timezone: "Asia/Kolkata" });

  // --- 9–13. Search by meaning --------------------------------------------------
  for (const text of ["I'm vegetarian and don't eat eggs.", "Sister Ananya's birthday is on 12 March.", "मुझे सुबह जल्दी उठना पसंद है", "Car insurance renews in November.", "My favourite colour is blue."]) {
    await call("dashboard:addMemory", { key: KEY, text, kind: "core" });
  }
  const started = Date.now();
  await call("memories:embedMissing", {});
  notes.modelLoadMs = Date.now() - started;
  type Recalled = { id: string; text: string; score: number };
  const recall = (query: string) => call<Recalled[]>("memories:recall", { query, limit: 5 });
  const eat = await recall("what do I eat?");
  const wake = await recall("do I wake up early?");
  check("modelLoadsInServer", eat.length > 0 && !/could not make memory vectors/.test(logs.server), { serverErrors: logs.server.match(/could not make memory vectors.*$/m)?.[0] });
  check("meaningFindsVegetarian", eat[0]?.text.includes("vegetarian") === true, eat.map((memory) => memory.text));
  check("meaningCrossesLanguages", wake[0]?.text.includes("सुबह") === true, wake.map((memory) => memory.text));
  const words = await recall("insurance");
  check("wordsStillWork", words[0]?.text.includes("insurance") === true, words.map((memory) => memory.text));
  const nothing = await recall("quantum chromodynamics lecture notes");
  check("unrelatedStayOut", nothing.length <= 1, nothing.map((memory) => memory.text));
  const colour = (await call<Array<{ id: string; text: string }>>("dashboard:listMemories", { key: KEY, kind: "core" })).find((memory) => memory.text.includes("colour"))!;
  await call("dashboard:editMemory", { key: KEY, id: colour.id, text: "My favourite colour is green." });
  await call("memories:embedMissing", {});
  const liked = await recall("which colour do I like");
  check("editedMemoryFoundByNewMeaning", liked[0]?.text.includes("green") === true, liked.map((memory) => memory.text));

  // --- 1–6, 27. Page watches ---------------------------------------------------
  const inStock = page("<html><body><h1>Headphones</h1><p>In stock</p><p>Price: ₹24,999</p></body></html>");
  const soldOut = page("<html><body><h1>Headphones</h1><p>Sold out</p></body></html>");
  const dollars = page("<html><body><h1>Headphones</h1><p>Price: $20</p></body></html>");
  const lakh = page("<html><body><h1>Laptop</h1><p>Now ₹1,23,456 only</p></body></html>");
  await call("dashboard:saveMonitor", { key: KEY, title: "Headphones in stock", url: inStock, condition: "contains", value: "In stock", intervalMinutes: 60 });
  const stockId = (await monitors()).find((item) => item.title === "Headphones in stock")!._id;
  let at = Date.now();
  const firstSeen = await checkWatch(stockId);
  await until(() => toOwner(at).some((message) => message.text.includes("Headphones in stock")), "the first in-stock alert", 20).catch(() => {});
  const alerts = () => telegram.sent.filter((message) => message.text.includes("Headphones in stock")).length;
  const afterFirst = alerts();
  const still = await checkWatch(stockId);
  patchDoc("monitors", stockId, "$.url", soldOut);
  const gone = await checkWatch(stockId);
  patchDoc("monitors", stockId, "$.url", inStock);
  at = Date.now();
  const back = await checkWatch(stockId);
  await until(() => toOwner(at).some((message) => message.text.includes("Headphones in stock")), "the back-in-stock alert", 20).catch(() => {});
  check("containsFiresFirstTime", afterFirst === 1 && /Found/.test(firstSeen), firstSeen);
  check("containsQuietWhileThere", /Still there/.test(still));
  check("containsNoticesGone", /Gone from the page/.test(gone), gone);
  check("containsFiresWhenBack", alerts() === 2 && /Found/.test(back), { back, alerts: alerts() });

  // A watch that fired before this version, with no `met` recorded: nothing new on upgrade.
  await call("work:createMonitor", { title: "Old stock watch", url: inStock, condition: "contains", value: "In stock", intervalMinutes: 60 });
  const oldId = (await monitors()).find((item) => item.title === "Old stock watch")!._id;
  patchDoc("monitors", oldId, "$.firedAt", Date.now() - 86_400_000);
  const oldSeen = await checkWatch(oldId);
  await sleep(1_500);
  check("upgradeSendsNothing", !telegram.sent.some((message) => message.text.includes("Old stock watch")), oldSeen);

  await call("dashboard:saveMonitor", { key: KEY, title: "Headphones under 25k", url: inStock, condition: "price_below", value: "₹25,000", intervalMinutes: 60 });
  const priceId = (await monitors()).find((item) => item.title === "Headphones under 25k")!._id;
  const priceSeen = await checkWatch(priceId);
  const priceAgain = await checkWatch(priceId);
  await sleep(1_500);
  check("rupeePriceFires", /₹24,999, below ₹25,000/.test(priceSeen), priceSeen);
  check("priceQuietWhileBelow", /still below/.test(priceAgain) && telegram.sent.filter((message) => message.text.includes("Headphones under 25k")).length === 1, priceAgain);
  await call("dashboard:saveMonitor", { key: KEY, title: "Dollar page", url: dollars, condition: "price_below", value: "₹25,000", intervalMinutes: 60 });
  const dollarSeen = await checkWatch((await monitors()).find((item) => item.title === "Dollar page")!._id);
  check("noCrossCurrency", /No price in INR/.test(dollarSeen), dollarSeen);
  await call("dashboard:saveMonitor", { key: KEY, title: "Laptop", url: lakh, condition: "price_below", value: "200000", intervalMinutes: 60 });
  const lakhSeen = await checkWatch((await monitors()).find((item) => item.title === "Laptop")!._id);
  check("lakhGroupingRead", /₹1,23,456/.test(lakhSeen), lakhSeen);
  const badPrice = await refusal("dashboard:saveMonitor", { key: KEY, title: "x", url: inStock, condition: "price_below", value: "cheap", intervalMinutes: 60 });
  const badUrl = await refusal("dashboard:saveMonitor", { key: KEY, title: "x", url: "not a page", condition: "change", intervalMinutes: 60 });
  check("formRefusesBadWatch", Boolean(badPrice && badUrl), { badPrice, badUrl });
  // Changing the watch's condition starts it over.
  await call("dashboard:saveMonitor", { key: KEY, id: stockId, title: "Headphones page", url: inStock, condition: "change", intervalMinutes: 30 });
  const restarted = await monitor(stockId);
  const baseline = await checkWatch(stockId);
  check("changedWatchStartsOver", restarted.met === undefined && restarted.lastFingerprint === undefined && restarted.intervalMinutes === 30 && /Baseline/.test(baseline), baseline);

  // --- 14–17. Approvals follow the owner ---------------------------------------
  const web = await call<string>("dashboard:createChat", { key: KEY });
  await call("todos:presence", { key: KEY, idleSeconds: 600 }, "call");
  at = Date.now();
  const away = await call<{ id: string; next: string }>("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\away-cache", cwd: "C:\\work", conversationId: web }, "call");
  await until(() => toOwner(at).some((message) => message.text.includes("away-cache") && message.buttons.length > 0), "the away approval on Telegram", 20).catch(() => {});
  const asked = toOwner(at).find((message) => message.text.includes("away-cache"));
  ownerTaps(`ap:${away.id}:y`);
  await until(async () => (await call<{ status: string } | null>("approvals:view", { id: away.id }))?.status === "approved", "the tap to approve it", 20).catch(() => {});
  const settled = await call<{ status: string; decidedBy?: string } | null>("approvals:view", { id: away.id });
  check("awayApprovalOnPhone", Boolean(asked?.buttons.includes(`ap:${away.id}:y`)), asked?.text.slice(0, 300));
  check("tapSettlesIt", settled?.status === "approved" && settled.decidedBy === "telegram", settled);

  await call("todos:presence", { key: KEY, idleSeconds: 0 }, "call");
  at = Date.now();
  const here = await call<{ id: string }>("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\here-cache", cwd: "C:\\work", conversationId: web }, "call");
  await sleep(8_000);
  check("hereStaysOnComputer", !toOwner(at).some((message) => message.text.includes("here-cache")));
  // The pet stops checking in: nobody can say where the owner is, so after a wait it goes to the phone.
  const pet = withDb((db) => db.query(`SELECT _id FROM "doc_petPresence" LIMIT 1`).get()) as { _id: string };
  patchDoc("petPresence", pet._id, "$.seenAt", Date.now() - 600_000);
  await until(() => toOwner(at).some((message) => message.text.includes("here-cache")), "the approval once no pet can say", 200).catch(() => {});
  check("noPetGoesToPhoneAfterWait", toOwner(at).some((message) => message.text.includes("here-cache")), { waitedMs: Date.now() - at });
  await call("approvals:settleFromDashboard", { key: KEY, id: here.id, approved: false }).catch(() => {});

  // --- 18–22. The Telegram chat in the web app ---------------------------------
  const model = process.env.PERRY_E2E_MODEL;
  at = Date.now();
  ownerSays("Hi Perry. Reply with just the word ready.");
  await until(async () => Boolean(await call<{ _id: string } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER })), "the Telegram chat", 60);
  const telegramChat = (await call<{ _id: string }>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER }))._id;
  if (model) await call("dashboard:setChatModel", { key: KEY, id: telegramChat, model });
  await until(() => toOwner(at).some((message) => /ready/i.test(message.text)), "Perry's Telegram reply", 300);
  const asked17 = Date.now();
  await call("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\phone-cache", cwd: "C:\\work", conversationId: telegramChat }, "call");
  await sleep(6_000);
  check("telegramApprovalAskedOnce", toOwner(asked17).filter((message) => message.text.includes("phone-cache")).length === 1);

  const listed = await call<Array<{ id: string; channel: string; title: string }>>("dashboard:listChats", { key: KEY });
  const row = listed.find((chat) => chat.id === telegramChat);
  check("telegramChatListed", row?.channel === "telegram", row);
  const opened = await call<{ channel: string }>("dashboard:getChat", { key: KEY, id: telegramChat });
  const history = await messagesOf(telegramChat);
  check("telegramChatOpens", opened.channel === "telegram" && history.some((message) => message.role === "user" && message.text.includes("ready")) && history.some((message) => message.role === "assistant"));

  at = Date.now();
  await call("dashboard:sendChat", { key: KEY, id: telegramChat, text: "What is 2 + 2? Reply with just the number." });
  const waiting = await messagesOf(telegramChat);
  check("webShowsItWhileWaiting", waiting.some((message) => message.pending && message.text.includes("2 + 2")));
  await until(() => toOwner(at).some((message) => message.text.trim() === "4" || /^\D*4\D*$/.test(message.text.trim())), "the reply on Telegram", 300).catch(() => {});
  const phone = toOwner(at).map((message) => message.text);
  check("phoneSeesWhatWasWritten", phone.some((text) => text.includes("You, in the web app") && text.includes("2 + 2")), phone);
  check("replyReachesTelegram", phone.some((text) => /^\D*4\D*$/.test(text.trim())));
  await until(async () => (await messagesOf(telegramChat)).some((message) => message.role === "assistant" && /\b4\b/.test(message.text)), "the reply in the web history", 30).catch(() => {});
  const after = await messagesOf(telegramChat);
  check("replyInWebHistory", after.some((message) => message.role === "user" && !message.pending && message.text.includes("2 + 2")) && after.some((message) => message.role === "assistant" && /\b4\b/.test(message.text)));
  const noDelete = await refusal("dashboard:deleteChat", { key: KEY, id: telegramChat });
  const lastId = (after.find((message) => message.role === "assistant") as Message & { id: string }).id;
  const noBranch = await refusal("dashboard:branchChat", { key: KEY, id: telegramChat, messageId: lastId });
  check("webOnlyActionsRefused", Boolean(noDelete && noBranch), { noDelete, noBranch });
  const found = await call<Array<{ id: string }>>("dashboard:searchChats", { key: KEY, search: "2 + 2" });
  check("searchFindsTelegramChat", found.some((chat) => chat.id === telegramChat));

  // --- 23–26. Schedules and goals through the server -----------------------------
  const madeId = await call<string>("jobs:saveFromDashboard", { key: KEY, name: "Morning brief", prompt: "Summarise my day ahead in three bullets.", schedule: "30 7 * * 1-5" });
  let made = (await jobs()).find((job) => job.id === madeId)!;
  const hourThere = Number(new Date(made.nextRunAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).replace(":", "."));
  check("scheduleSavedLikeTheTool", made.schedule === "30 7 * * 1-5" && made.enabled && hourThere === 7.3, { schedule: made.schedule, next: new Date(made.nextRunAt).toISOString() });
  const badCron = await refusal("jobs:saveFromDashboard", { key: KEY, name: "Bad", prompt: "Do something useful for me.", schedule: "every morning" });
  const past = await refusal("jobs:saveFromDashboard", { key: KEY, name: "Late", prompt: "Do something useful for me.", at: new Date(Date.now() - 3_600_000).toISOString() });
  check("badScheduleRefused", Boolean(badCron && past), { badCron, past });
  await call("jobs:setEnabled", { key: KEY, id: madeId, enabled: false });
  await call("jobs:saveFromDashboard", { key: KEY, id: madeId, name: "Morning brief", prompt: "Summarise my day ahead in five bullets.", schedule: "30 7 * * 1-5" });
  made = (await jobs()).find((job) => job.id === madeId)!;
  const stayedPaused = !made.enabled && made.prompt.includes("five");
  const before = made.nextRunAt;
  await call("jobs:saveFromDashboard", { key: KEY, id: madeId, name: "Morning brief", prompt: made.prompt, schedule: "0 9 * * *" });
  made = (await jobs()).find((job) => job.id === madeId)!;
  check("pausedStaysPausedNewTimeMoves", stayedPaused && made.enabled && made.schedule === "0 9 * * *" && made.nextRunAt !== before);
  const heartbeat = (await jobs()).find((job) => job.builtin === "heartbeat")!;
  await call("jobs:saveFromDashboard", { key: KEY, id: heartbeat.id, name: "Renamed", prompt: "Something else entirely here.", schedule: heartbeat.schedule });
  const heartbeatAfter = (await jobs()).find((job) => job.id === heartbeat.id)!;
  check("builtinKeepsItsName", heartbeatAfter.name === heartbeat.name && heartbeatAfter.prompt === heartbeat.prompt);
  const onceAt = new Date(Date.now() + 2 * 3_600_000);
  const onceId = await call<string>("jobs:saveFromDashboard", { key: KEY, name: "Call the bank", prompt: "Remind me to call the bank about the card.", at: onceAt.toISOString() });
  check("oneTimeSaved", Math.abs(((await jobs()).find((job) => job.id === onceId)!.runAt ?? 0) - onceAt.getTime()) < 1000);

  // --- 26, 28. The forms, in the real page -------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  const go = async (path: string) => { await send("Page.navigate", { url: `${BASE}${path}` }); await sleep(2_500); };
  const clickText = (selector: string, text: string) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const type = (selector: string, value: string) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const waitFor = (expression: string, what: string) => until(() => evaluate(expression), what, 20);

  // The Telegram chat in the sidebar, and open.
  await go(`/chat/${telegramChat}`);
  await waitFor(`document.body.innerText.includes("Your Telegram chat")`, "the Telegram chat's note");
  const marked = await evaluate(`Boolean(document.querySelector('[data-sidebar="sidebar"] [aria-label="Telegram"], nav [aria-label="Telegram"], [aria-label="Telegram"]'))`);
  await evaluate(`document.querySelector('button[aria-label="Chat options"]')?.click(); true`);
  await sleep(600);
  const menu = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`) as string[];
  await shot("telegram-chat.png");
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  check("pageMarksTelegramChat", Boolean(marked) && !menu.includes("Delete") && menu.includes("Rename"), { menu });

  // A schedule, made with the form's defaults (every day at 8).
  await go("/work?tab=schedules");
  await clickText("button", "New schedule");
  await waitFor(`Boolean(document.querySelector("#schedule-name"))`, "the schedule form");
  await type("#schedule-name", "Evening wind-down");
  await type("#schedule-prompt", "Tell me what is left on my to-do list for today.");
  await shot("work-new-schedule.png");
  await clickText("button[type=submit]", "Save");
  await until(async () => (await jobs()).some((job) => job.name === "Evening wind-down"), "the schedule from the form", 20).catch(() => {});
  const fromForm = (await jobs()).find((job) => job.name === "Evening wind-down");
  check("scheduleFormSaves", fromForm?.schedule === "0 8 * * *", fromForm);

  // A goal, then a milestone ticked by Perry, then the goal changed in the form: the tick stays.
  await go("/work?tab=goals");
  await clickText("button", "New goal");
  await waitFor(`Boolean(document.querySelector("#goal-title"))`, "the goal form");
  await type("#goal-title", "Run a half marathon");
  await type("#goal-milestones", "Run 5 km\nRun 10 km");
  await clickText("button[type=submit]", "Save");
  type Goal = { _id: string; title: string; milestones: Array<{ title: string; done: boolean }> };
  await until(async () => (await call<{ goals: Goal[] }>("dashboard:getWork", { key: KEY })).goals.some((goal) => goal.title === "Run a half marathon"), "the goal from the form", 20);
  const goal = (await call<{ goals: Goal[] }>("dashboard:getWork", { key: KEY })).goals.find((item) => item.title === "Run a half marathon")!;
  await call("work:updateGoal", { id: goal._id, completeMilestones: ["Run 5 km"] });
  await sleep(1_000);
  await clickText("button", "Change");
  await waitFor(`document.querySelector("#goal-milestones")?.value.includes("Run 10 km")`, "the goal's form, filled in");
  await type("#goal-milestones", "Run 5 km\nRun 10 km\nSign up for the race");
  await shot("work-change-goal.png");
  await clickText("button[type=submit]", "Save");
  await until(async () => (await call<{ goals: Goal[] }>("dashboard:getWork", { key: KEY })).goals.find((item) => item._id === goal._id)!.milestones.length === 3, "the changed goal", 20).catch(() => {});
  const changed = (await call<{ goals: Goal[] }>("dashboard:getWork", { key: KEY })).goals.find((item) => item._id === goal._id)!;
  check("goalKeepsTicks", changed.milestones.length === 3 && changed.milestones[0].done && !changed.milestones[1].done, changed.milestones);

  // A watch, from the form.
  await go("/work?tab=watches");
  await clickText("button", "New watch");
  await waitFor(`Boolean(document.querySelector("#watch-url"))`, "the watch form");
  await type("#watch-url", "https://example.com/");
  await type("#watch-title", "Example page");
  await shot("work-new-watch.png");
  await clickText("button[type=submit]", "Save");
  await until(async () => (await monitors()).some((item) => item.title === "Example page"), "the watch from the form", 20).catch(() => {});
  const watchFromForm = (await monitors()).find((item) => item.title === "Example page");
  check("watchFormSaves", watchFromForm?.condition === "change" && watchFromForm.intervalMinutes === 60, watchFromForm);
  notes.pageErrors = browser.errors;
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  stub.close();
  await sleep(2_000);
  notes.telegram = telegram.sent.map(({ chat_id, text, buttons }) => ({ chat_id, buttons: buttons.length, text: text.slice(0, 300) }));
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
