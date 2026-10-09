import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/memory-sources/run.ts <outDir>
// Issue #106, part one: memory you can trust. Which memories a reply used,
// shown under it, and old facts that may have changed checked rather than
// repeated. A fresh Perry (production build, `pnpm build` first), the real
// runner and Codex (PERRY_E2E_MODEL picks the model), a stand-in Telegram, and
// headless Chrome for the chat page.
//
// Ways it could fail, written down before the checks:
//   1. A reply shaped by a memory says nothing of it.
//   2. A reply that used no memory shows some anyway.
//   3. The line naming memories shows in the reply: in the web app, or on
//      the phone.
//   4. A named id
//      that is no memory breaks the page or shows. (Checked in finishTurn: ids are looked up.)
//   5. A fact noted long ago about something that changes (a job) is stated
//      as current, without a word of checking.
//   6. The page shows nothing under the reply, or its link does not open the
//      memory on the Memory page.

// Bun's SQLite, named at run time: the project's typecheck knows Node's types, not Bun's.
type Sqlite = { exec(sql: string): void; run(sql: string, params: unknown[]): void; close(): void };
const bunSqlite = "bun:sqlite";
const { Database } = await import(bunSqlite) as { Database: new (path: string) => Sqlite };

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/memory-sources/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "memory-sources-e2e-key";
const OWNER = "4242";
const home = mkdtempSync(join(tmpdir(), "perry-sources-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const telegram = { sent: [] as Array<{ text: string; at: number }>, pending: [] as object[], nextUpdate: 1 };
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
    if (method === "sendMessage") { telegram.sent.push({ text: String(args.text), at: Date.now() }); return reply({ message_id: telegram.sent.length }); }
    if (method === "editMessageText") { const message = telegram.sent[Number(args.message_id) - 1]; if (message) message.text = String(args.text); return reply(true); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false, first_name: "Mani" }, text },
});

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex",
  TELEGRAM_BOT_TOKEN: "123456:sources-e2e", TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  return spawn(command, args, { cwd: REPO, env, stdio: "ignore", windowsHide: true });
}
const stop = (child: ChildProcess | null) => { if (child?.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
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
type Message = { id: string; role: string; text: string; memories?: Array<{ id: string; text: string }> };
const messagesOf = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 20, cursor: null } })).page;
async function ask(chat: string, text: string): Promise<Message> {
  await call("dashboard:sendChat", { key: KEY, id: chat, text });
  await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to start", 60).catch(() => {});
  await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply", 400);
  return (await messagesOf(chat)).find((message) => message.role === "assistant")!;
}

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const model = process.env.PERRY_E2E_MODEL;

  await call("dashboard:addMemory", { key: KEY, text: "I'm vegetarian and don't eat eggs.", kind: "core" });
  await call("dashboard:addMemory", { key: KEY, text: "Works at Acme Corp as a product designer.", kind: "core" });
  const memories = await call<Array<{ id: string; text: string }>>("dashboard:listMemories", { key: KEY, kind: "core" });
  const veg = memories.find((memory) => memory.text.includes("vegetarian"))!;
  const job = memories.find((memory) => memory.text.includes("Acme"))!;
  // The job was noted two years ago.
  const db = new Database(join(home, "perry.sqlite"));
  try { db.exec("PRAGMA busy_timeout = 5000;"); db.run(`UPDATE "doc_memories" SET doc = json_set(doc, '$.createdAt', ?) WHERE _id = ?`, [Date.now() - 730 * 86_400_000, job.id]); } finally { db.close(); }

  const newChat = async () => { const id = await call<string>("dashboard:createChat", { key: KEY }); if (model) await call("dashboard:setChatModel", { key: KEY, id, model }); return id; };
  // --- 1, 3. A reply shaped by a memory -----------------------------------------------------
  const dinnerChat = await newChat();
  const dinner = await ask(dinnerChat, "Suggest one dinner for tonight, in one sentence.");
  notes.dinner = dinner;
  check("replyShowsItsMemory", Boolean(dinner.memories?.some((memory) => memory.id === veg.id)), dinner.memories);
  check("lineNotInReply", !/memories:/i.test(dinner.text), dinner.text);
  // --- 2. A reply that used none --------------------------------------------------------------
  const sumChat = await newChat();
  const sum = await ask(sumChat, "What is 17 times 3? Just the number.");
  check("noMemoryNoneShown", !sum.memories?.length && /51/.test(sum.text), sum);
  // --- 5. An old fact about something that changes ----------------------------------------
  const bioChat = await newChat();
  const bio = await ask(bioChat, "Write a one-line bio for my conference badge.");
  notes.bio = bio.text;
  check("oldFactChecked", /acme/i.test(bio.text) && /(still|confirm|current|is that right|up to date|\?)/i.test(bio.text), bio.text);
  // --- 3. On the phone ------------------------------------------------------------------------
  const at = Date.now();
  ownerSays("What should I eat tonight? One sentence.");
  await until(async () => Boolean(await call<{ _id: string } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER })), "the Telegram chat", 60);
  const phoneChat = (await call<{ _id: string }>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER }))._id;
  if (model) await call("dashboard:setChatModel", { key: KEY, id: phoneChat, model });
  await until(async () => (await messagesOf(phoneChat)).some((message) => message.role === "assistant"), "the Telegram reply", 400);
  await sleep(2_000);
  const phone = telegram.sent.filter((message) => message.at >= at).map((message) => message.text);
  const phoneSaved = (await messagesOf(phoneChat)).find((message) => message.role === "assistant");
  check("phoneNeverSeesTheLine", phone.length > 0 && !phone.some((text) => /memories:/i.test(text)), phone);
  notes.phoneSaved = phoneSaved;

  // --- 6. The page ----------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await send("Page.navigate", { url: `${BASE}/chat/${dinnerChat}` });
  await until(() => evaluate(`Boolean(document.querySelector("[data-memories]"))`), "the From memory line", 30).catch(() => {});
  const chip = await evaluate(`(() => { const box = document.querySelector("[data-memories]"); const link = box?.querySelector("a"); return box ? { text: box.textContent, href: link?.getAttribute("href") } : null; })()`) as { text: string; href: string } | null;
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "from-memory.png"), Buffer.from(shot.data, "base64"));
  await send("Page.navigate", { url: `${BASE}${chip?.href ?? "/memory"}` });
  await until(() => evaluate(`(document.querySelector('input[aria-label="Search memories"]')?.value ?? "").includes("vegetarian")`), "the Memory page, searching", 20).catch(() => {});
  await sleep(1_500);
  const found = await evaluate(`({ search: document.querySelector('input[aria-label="Search memories"]')?.value, shown: document.body.innerText.includes("I'm vegetarian and don't eat eggs.") })`) as { search?: string; shown: boolean };
  check("pageShowsAndLinks", Boolean(chip?.text.includes("vegetarian")) && found.shown && Boolean(found.search?.includes("vegetarian")), { chip, found });
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
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
