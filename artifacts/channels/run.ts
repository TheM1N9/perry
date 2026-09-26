import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/channels/run.ts <outDir>
// Perry answers where you are talking, and what it does in the background
// reports back to the conversation it was set up in; its own background work
// goes to the messaging channel you paired (Telegram). A fresh PERRY_HOME, the
// production build (`pnpm build` first) on a free port, a stand-in Telegram
// that records every call, and the real runner and Codex for what only the
// model can show (PERRY_E2E_MODEL picks the model; the account default else).
//
// Ways it could fail:
//   1. Perry does not know where it is: asked on the web and on Telegram which
//      app this is and where a job set up here would report, each must say.
//   2. Talking on the web reaches Telegram: an approval a web chat raises must
//      send Telegram nothing, while one from the Telegram chat is asked there,
//      with buttons, as HTML with the command in a code block.
//   3. Background work reports to the wrong place: a job Perry sets up from a
//      web chat (its create_job tool) must report into that chat and not to
//      Telegram; one set up on Telegram, and the heartbeat, go to Telegram.
//   4. The same for page watches: one set up in a web chat reports there, one
//      set up with no chat goes to Telegram.
//   5. Telegram messages are built badly: a report with a table and a list
//      must arrive as HTML, the job's name bold, the table a lined-up block,
//      the list bullets.
//   6. A report into a web chat goes unnoticed: the chat must show as unread,
//      and Perry's next turn there must know what it sent.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/channels/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "channels-e2e-key";
const OWNER = "4242";
const home = mkdtempSync(join(tmpdir(), "perry-channels-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

type Sent = { chat_id: string; text: string; html: boolean; buttons: boolean; at: number };
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
      telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), html: args.parse_mode === "HTML", buttons: Boolean(args.reply_markup?.inline_keyboard?.length), at: Date.now() });
      return reply({ message_id: telegram.sent.length });
    }
    // Replies stream: sent once, then edited into the full text.
    if (method === "editMessageText") {
      const message = telegram.sent[Number(args.message_id) - 1];
      if (message) Object.assign(message, { text: String(args.text), html: args.parse_mode === "HTML" });
      return reply(true);
    }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false, first_name: "Mani", username: "The_M1N9" }, text },
});

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:channels-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY") delete env[name];
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
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
const toOwner = (after: number) => telegram.sent.filter((message) => message.chat_id === OWNER && message.at > after);
type Message = { role: string; text: string };
const webMessages = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 30, cursor: null } })).page;
/** Say something in a web chat and wait for the whole reply. */
async function askWeb(id: string, text: string): Promise<string> {
  await call("dashboard:sendChat", { key: KEY, id, text });
  await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id })).isRunning, `the web reply to "${text}"`, 300);
  const page = await webMessages(id);
  return page.find((message) => message.role === "assistant")?.text ?? "";
}
/** Say something on Telegram and wait for the whole reply. */
async function askTelegram(text: string): Promise<string> {
  const at = Date.now();
  ownerSays(text);
  await until(async () => (await call<Array<{ prompt: string; status: string }>>("dashboard:listRuns", { key: KEY })).some((run) => run.prompt === text && run.status !== "running"), `the Telegram reply to "${text}"`, 300);
  // The run is marked done a moment before its message leaves: wait for the message itself.
  await until(() => toOwner(at).length > 0, `the Telegram message for "${text}"`, 30);
  await sleep(1_500);
  return toOwner(at).map((message) => message.text).join("\n");
}

const server = start("server");
let runner: ChildProcess | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const model = process.env.PERRY_E2E_MODEL;
  const web = await call<string>("dashboard:createChat", { key: KEY });
  if (model) await call("dashboard:setChatModel", { key: KEY, id: web, model });

  // 1. Where am I?
  const question = "In one or two sentences: which app am I talking to you in right now, and if you set up a scheduled job from this conversation, where would its results reach me?";
  const onWeb = await askWeb(web, question);
  const onTelegram = await askTelegram(question);
  notes.whereAmI = { web: onWeb, telegram: onTelegram };
  checks.knowsItIsOnWeb = /web|dashboard/i.test(onWeb) && /(here|this (web )?chat|this conversation|dashboard)/i.test(onWeb);
  checks.knowsItIsOnTelegram = /telegram/i.test(onTelegram) && !/dashboard only/i.test(onTelegram);
  const telegramChat = (await call<{ _id: string } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER }))!._id;

  // 2. Approvals follow the conversation.
  const token = (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string }).token;
  let at = Date.now();
  await call("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\build-cache", cwd: "C:\\work\\site", conversationId: web }, "call");
  await sleep(4_000);
  checks.webApprovalStaysOnWeb = !toOwner(at).some((message) => message.buttons || message.text.includes("build-cache"));
  at = Date.now();
  await call("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\dist", cwd: "C:\\work\\site", conversationId: telegramChat }, "call");
  await until(() => toOwner(at).some((message) => message.buttons), "the Telegram approval", 20);
  const prompt = toOwner(at).find((message) => message.buttons)!;
  notes.telegramApproval = prompt.text;
  checks.telegramApprovalOnTelegram = prompt.html && /<b>.+wants to run<\/b>/.test(prompt.text) && prompt.text.includes("<pre>Remove-Item -Recurse .\\dist</pre>") && prompt.text.includes("<code>C:\\work\\site</code>");

  // 3. A job Perry sets up from the web chat reports there; one from Telegram goes to Telegram.
  // The owner has this chat open, as they would, so a report after this shows as unread.
  await call("dashboard:markChatSeen", { key: KEY, id: web }, "call");
  const made = await askWeb(web, "Set up a one-time job called Stretch Break for 30 minutes from now that tells me to stand up and stretch. Don't ask me to confirm, just create it.");
  notes.jobReply = made;
  await until(async () => Boolean((await call<Array<{ name: string }>>("jobs:list")).find((job) => /stretch/i.test(job.name))), "Perry to create the job", 30);
  const stretch = (await call<Array<{ id: string; name: string }>>("jobs:list")).find((job) => /stretch/i.test(job.name))!;
  at = Date.now();
  const report = "Time to stand up and stretch.\n\n| Stretch | Seconds |\n|---|---|\n| Neck rolls | 30 |\n| Hamstrings | 45 |\n\n- breathe out\n- hold still";
  await call("jobs:finished", { id: stretch.id, result: report });
  await until(async () => (await webMessages(web)).some((message) => message.text.includes("stand up and stretch")), "the job's report in the web chat", 20);
  await sleep(2_000);
  checks.webJobReportsToWebChat = toOwner(at).length === 0;
  const unread = (await call<Array<{ id: string; unseen: boolean }>>("dashboard:listChats", { key: KEY })).find((chat) => chat.id === web);
  notes.webChatUnread = unread?.unseen;

  const fromTelegram = await call<{ id: string }>("jobs:create", { name: "Water", at: new Date(Date.now() + 3_600_000).toISOString(), prompt: "Remind me to drink water.", origin: telegramChat });
  at = Date.now();
  await call("jobs:finished", { id: fromTelegram.id, result: report });
  await until(() => toOwner(at).some((message) => message.text.includes("Water")), "the Telegram job's report", 20);
  const formatted = toOwner(at).find((message) => message.text.includes("Water"))!;
  notes.telegramReport = formatted.text;
  checks.telegramJobReportsToTelegram = true;
  // 5. Built for Telegram.
  checks.telegramMessageBuilt = formatted.html && formatted.text.includes("<b>Water</b>") && /<pre>Stretch\s+Seconds\n─+\s+─+\nNeck rolls\s+30/.test(formatted.text) && formatted.text.includes("• breathe out");

  const heartbeat = (await call<Array<{ id: string; builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")!;
  at = Date.now();
  await call("jobs:finished", { id: heartbeat.id, result: "Your 3pm moved to 4pm." });
  await until(() => toOwner(at).some((message) => message.text.includes("3pm moved")), "the heartbeat on Telegram", 20).then(() => { checks.heartbeatToTelegram = true; }, () => { checks.heartbeatToTelegram = false; });

  // 4. Watches.
  at = Date.now();
  await call("work:createMonitor", { title: "Web watch", url: "https://example.com", condition: "contains", value: "Example Domain", intervalMinutes: 1440, origin: web });
  await call("work:createMonitor", { title: "Home watch", url: "https://example.com", condition: "contains", value: "Example Domain", intervalMinutes: 1440 });
  await call("dashboard:checkMonitorsNow", { key: KEY }, "call");
  await until(async () => (await webMessages(web)).some((message) => message.text.includes("Web watch")), "the web watch in the web chat", 30).catch(() => {});
  await sleep(2_000);
  checks.webWatchToWebChat = (await webMessages(web)).some((message) => message.text.includes("Web watch")) && !toOwner(at).some((message) => message.text.includes("Web watch"));
  checks.homeWatchToTelegram = toOwner(at).some((message) => message.text.includes("Home watch"));

  // 6. The web chat shows it, and the next turn there knows.
  checks.webChatUnread = unread?.unseen === true;
  const recall = await askWeb(web, "What did you last send me here without me asking? Answer in one short sentence.");
  notes.recall = recall;
  checks.nextTurnKnows = /watch|example|stretch/i.test(recall);
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  stop(runner);
  stop(server);
  stub.close();
  await sleep(2_000);
  notes.telegram = telegram.sent.map(({ chat_id, text, html, buttons }) => ({ chat_id, html, buttons, text: text.slice(0, 400) }));
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt, whereAmI: notes.whereAmI, recall: notes.recall }, null, 2));
process.exit(result.passed ? 0 : 1);
