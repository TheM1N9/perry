import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/whatsapp/run.ts <outDir>
// Perry on WhatsApp, both ways: a separate number the owner claims with the
// pairing code, and the owner's own number, talking in "Message yourself".
// WhatsApp itself is stood in for by fake-driver.mjs (PERRY_WHATSAPP_DRIVER),
// which this drives: everything above Baileys runs for real, with the real
// runner and Codex (PERRY_E2E_MODEL picks the model). Linking a real phone is
// the one thing this cannot do. A fresh PERRY_HOME, the production build
// (`pnpm build` first) on a free port, and a stand-in Telegram too.
//
// Ways it could fail:
//   1. Linking shows nothing: the dashboard must show a QR, and with a phone
//      number, the code to type on it.
//   2. A stranger is answered: a message from anyone but the owner must get
//      nothing back and start nothing.
//   3. A separate number cannot be claimed: the pairing code, sent from the
//      owner's WhatsApp, must make them the owner, and say so.
//   4. The owner is not answered well: "typing…" first, then a reply in
//      WhatsApp's formatting (no ** left), and Perry must know it is WhatsApp.
//   5. Approvals: one raised on WhatsApp must be asked there, numbered, and
//      "1" must approve it, with nothing on Telegram.
//   6. Reports: a job set up on WhatsApp reports there, formatted; with
//      WhatsApp chosen, the heartbeat goes there, and back to Telegram after.
//   7. A voice note does not reach the turn: it must be attached to it.
//   8. Logged out from the phone: the dashboard must say so, the saved
//      session go, and nothing keep reconnecting.
//   9. Self mode: only the owner's "Message yourself" chat is answered, with
//      replies marked 🤖, and an echo of Perry's own reply starts nothing.
//  10. Unlinking from the dashboard does not log out.
//  11. The WhatsApp tab throws or does not show the link: no page errors.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/whatsapp/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const free = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await free();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "whatsapp-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-whatsapp-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const PERRY = "15550001111@s.whatsapp.net";
const OWNER = "919876543210@s.whatsapp.net";
const STRANGER = "15559990000@s.whatsapp.net";

// --- The stand-in WhatsApp's control server --------------------------------------

type Sent = { jid: string; id: string; text?: string; file?: string; at: number };
const wa = { commands: [] as object[], sent: [] as Sent[], presence: [] as Array<{ presence: string; jid: string; at: number }>, connects: 0, logouts: 0, codeRequested: [] as string[] };
const control = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const done = (value: unknown = true) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    switch (request.url) {
      case "/next":
        if (wa.commands.length) return done(wa.commands.splice(0));
        return void setTimeout(() => done(wa.commands.splice(0)), 500);
      case "/sent": wa.sent.push({ ...data, at: Date.now() }); return done();
      case "/presence": wa.presence.push({ ...data, at: Date.now() }); return done();
      case "/connect": wa.connects += 1; return done();
      case "/logout": wa.logouts += 1; return done();
      case "/code-requested": wa.codeRequested.push(data.phone); return done();
      default: return done(false);
    }
  });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const push = (...commands: object[]) => wa.commands.push(...commands);
let messageId = 0;
const incoming = (remoteJid: string, text: string, extra: { fromMe?: boolean; message?: object; fakeBytes?: string } = {}) => push({
  event: "messages.upsert",
  data: { type: "notify", messages: [{ key: { id: `IN${Date.now()}${++messageId}`, remoteJid, fromMe: Boolean(extra.fromMe) }, pushName: "Mani", message: extra.message ?? { conversation: text }, ...(extra.fakeBytes ? { fakeBytes: extra.fakeBytes } : {}) }] },
});
const sentTo = (jid: string, after: number) => wa.sent.filter((message) => message.jid === jid && message.at > after);

// --- A stand-in Telegram, paired too, to show nothing leaks there -----------------

const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[] };
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
    if (method === "sendMessage") { telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), at: Date.now() }); return reply({ message_id: telegram.sent.length }); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:whatsapp-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
  PERRY_WHATSAPP_DRIVER: join(REPO, "artifacts", "whatsapp", "fake-driver.mjs"),
  PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
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
type View = { status: string; qr?: string; code?: string; number?: string; paired: boolean; pairingCode?: string; wanted: boolean; error?: string };
const view = () => call<View>("whatsapp:status", { key: KEY }, "call");
const runs = () => call<Array<{ prompt: string; status: string }>>("dashboard:listRuns", { key: KEY });
/** The owner writes on WhatsApp; the reply, once the turn is done and it has gone out. */
async function ask(from: string, text: string, extra: { fromMe?: boolean } = {}): Promise<{ reply: string; typing: boolean }> {
  const at = Date.now();
  const before = (await runs()).length;
  incoming(from, text, extra);
  await until(async () => { const all = await runs(); return all.length > before && all.slice(0, all.length - before).every((run) => run.status !== "running"); }, `the reply to "${text}"`, 300);
  const to = extra.fromMe ? PERRY_SELF : OWNER;
  await until(() => sentTo(to, at).some((message) => message.text), "the reply to go out", 30);
  await sleep(1_500);
  return { reply: sentTo(to, at).map((message) => message.text ?? "").join("\n"), typing: wa.presence.some((item) => item.jid === to && item.presence === "composing" && item.at > at) };
}
let PERRY_SELF = OWNER;

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  // Telegram paired first, as the owner would have it.
  const { code: telegramCode } = await call<{ code: string }>("installation:startPairing");
  telegram.pending.push({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private" }, from: { id: 4242, is_bot: false, first_name: "Mani", username: "The_M1N9" }, text: telegramCode } });
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "Telegram to be paired", 30);
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online", 120);

  // 1. Linking by code, then by QR, for a separate number.
  await call("whatsapp:startLinking", { key: KEY, mode: "separate", phone: "+1 555 000 1111" }, "call");
  await until(() => wa.connects >= 1, "WhatsApp to start");
  push({ event: "connection.update", data: { qr: "QR-ONE" } });
  await until(async () => (await view()).status === "code", "the code to type");
  checks.linkByCode = (await view()).code === "ABCD-1234" && wa.codeRequested[0] === "15550001111";
  await call("whatsapp:unlink", { key: KEY }, "call");
  await until(() => wa.logouts >= 1, "the first attempt to end");
  await call("whatsapp:startLinking", { key: KEY, mode: "separate" }, "call");
  await until(() => wa.connects >= 2, "WhatsApp to start again", 30);
  push({ event: "connection.update", data: { qr: "QR-TWO" } });
  await until(async () => (await view()).status === "qr", "the QR");
  checks.linkByQr = (await view()).qr === `data:image/png;base64,${Buffer.from("QR-TWO").toString("base64")}`;

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shoot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64")));
  await send("Page.navigate", { url: `${BASE}/settings?tab=whatsapp` });
  await until(async () => Boolean(await evaluate(`!!document.querySelector('img[alt="WhatsApp link QR code"]')`)), "the QR on the dashboard", 30);
  await shoot("whatsapp-qr.png");

  push({ user: { id: "15550001111:7@s.whatsapp.net", name: "Perry" } }, { event: "connection.update", data: { connection: "open" } });
  await until(async () => (await view()).status === "connected", "the link to open");
  const linked = await view();
  notes.linked = { number: linked.number, pairingCode: Boolean(linked.pairingCode) };
  checks.showsNumberAndCode = linked.number === "+15550001111" && Boolean(linked.pairingCode) && !linked.paired;
  await until(async () => Boolean(await evaluate(`document.body.innerText.includes(${JSON.stringify(linked.pairingCode)})`)), "the pairing code on the dashboard", 20);
  await shoot("whatsapp-claim.png");

  // 2. A stranger.
  let at = Date.now();
  incoming(STRANGER, "hello, who is this?");
  incoming(STRANGER, "123456");
  await sleep(5_000);
  checks.strangerIgnored = sentTo(STRANGER, at).length === 0 && !(await call<unknown>("conversations:getByExternalId", { channel: "whatsapp", externalId: STRANGER }));

  // 3. Claimed with the code.
  at = Date.now();
  incoming(OWNER, `here it is: ${linked.pairingCode}`);
  await until(() => sentTo(OWNER, at).some((message) => message.text?.startsWith("Paired.")), "the claim to be confirmed", 20);
  checks.claimedWithCode = (await view()).paired;

  // 4. The owner, answered, on WhatsApp.
  const where = await ask(OWNER, "In one short sentence: which app am I talking to you in right now? Use **bold** for its name.");
  notes.where = where;
  checks.typingThenReply = where.typing && where.reply.length > 0;
  checks.knowsItIsWhatsApp = /whatsapp/i.test(where.reply);
  checks.whatsappFormatting = !where.reply.includes("**");
  const chat = (await call<{ _id: string } | null>("conversations:getByExternalId", { channel: "whatsapp", externalId: OWNER }))!._id;

  // 5. An approval, asked and answered on WhatsApp.
  const token = (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string }).token;
  at = Date.now();
  const telegramBefore = telegram.sent.length;
  const approval = await call<{ id: string }>("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\dist", cwd: "C:\\work\\site", conversationId: chat }, "call");
  await until(() => sentTo(OWNER, at).some((message) => message.text?.includes("Reply *1* to approve")), "the approval on WhatsApp", 20);
  const prompt = sentTo(OWNER, at).find((message) => message.text?.includes("Reply *1* to approve"))!.text!;
  notes.approvalPrompt = prompt;
  at = Date.now();
  incoming(OWNER, "1");
  await until(() => sentTo(OWNER, at).some((message) => message.text === "Approved."), "the approval to be answered", 20);
  const settled = await call<{ status: string; decidedBy?: string }>("approvals:view", { id: approval.id });
  checks.approvalOnWhatsApp = prompt.includes("*") && prompt.includes("```") && settled.status === "approved" && settled.decidedBy === "whatsapp" && telegram.sent.length === telegramBefore;

  // 6. Reports.
  const job = await call<{ id: string }>("jobs:create", { name: "Water", at: new Date(Date.now() + 3_600_000).toISOString(), prompt: "Remind me to drink water.", origin: chat });
  at = Date.now();
  await call("jobs:finished", { id: job.id, result: "Time to drink **water**.\n\n| Glass | ml |\n|---|---|\n| One | 250 |\n\n- sip slowly" });
  await until(() => sentTo(OWNER, at).some((message) => message.text?.includes("Water")), "the job's report on WhatsApp", 20);
  const report = sentTo(OWNER, at).find((message) => message.text?.includes("Water"))!.text!;
  notes.report = report;
  checks.jobReportsFormatted = report.includes("*Water*") && report.includes("*water*") && !report.includes("**") && report.includes("```Glass") && report.includes("• sip slowly");
  const heartbeat = (await call<Array<{ id: string; builtin?: string }>>("jobs:list")).find((item) => item.builtin === "heartbeat")!;
  await call("whatsapp:setHomeChannel", { key: KEY, channel: "whatsapp" }, "call");
  at = Date.now();
  await call("jobs:finished", { id: heartbeat.id, result: "Your 3pm moved to 4pm." });
  await until(() => sentTo(OWNER, at).some((message) => message.text?.includes("3pm moved")), "the heartbeat on WhatsApp", 20).catch(() => {});
  const onWhatsApp = sentTo(OWNER, at).some((message) => message.text?.includes("3pm moved")) && !telegram.sent.some((message) => message.at > at);
  await call("whatsapp:setHomeChannel", { key: KEY, channel: "telegram" }, "call");
  at = Date.now();
  await call("jobs:finished", { id: heartbeat.id, result: "Your 5pm moved to 6pm." });
  await until(() => telegram.sent.some((message) => message.at > at && message.text.includes("5pm moved")), "the heartbeat back on Telegram", 20).catch(() => {});
  checks.homeChannelChoice = onWhatsApp && telegram.sent.some((message) => message.at > at && message.text.includes("5pm moved")) && !sentTo(OWNER, at).some((message) => message.text?.includes("5pm moved"));

  // 7. A voice note.
  const voice = await ask(OWNER, "", { message: { audioMessage: { ptt: true, mimetype: "audio/ogg; codecs=opus" } }, fakeBytes: Buffer.from("OggS fake opus bytes").toString("base64") } as never);
  const thread = (await call<{ threadId: string }>("conversations:getById", { id: chat })).threadId;
  const history = await call<{ page: Array<{ text?: string; message?: { role?: string } }> }>("agentStore:listMessages", { threadId: thread, paginationOpts: { numItems: 20, cursor: null } });
  notes.voiceReply = voice.reply;
  checks.voiceNoteAttached = history.page.some((item) => item.message?.role === "user" && /attachments:/.test(item.text ?? ""));

  // 8. Logged out from the phone.
  const connectsBefore = wa.connects;
  push({ event: "connection.update", data: { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } } });
  await until(async () => (await view()).status === "logged-out", "the logout to show");
  await sleep(8_000);
  const out = await view();
  checks.loggedOutHandled = !out.wanted && !out.paired && wa.connects === connectsBefore && !existsSync(join(home, "whatsapp", "auth"));
  await send("Page.navigate", { url: `${BASE}/settings?tab=whatsapp` });
  await until(async () => Boolean(await evaluate(`document.body.innerText.includes("Unlinked")`)), "the dashboard to say unlinked", 20).catch(() => {});

  // 9. Self mode.
  PERRY_SELF = OWNER;
  await call("whatsapp:startLinking", { key: KEY, mode: "self" }, "call");
  await until(() => wa.connects > connectsBefore, "WhatsApp to start for self mode", 30);
  push({ user: { id: "919876543210:12@s.whatsapp.net", lid: "123456789:12@lid", name: "Mani" } }, { event: "connection.update", data: { connection: "open" } });
  await until(async () => (await view()).paired, "linking your own number to pair it", 20);
  at = Date.now();
  const runsBefore = (await runs()).length;
  incoming("15551234567@s.whatsapp.net", "someone else writes to me", { fromMe: false });
  incoming("15551234567@s.whatsapp.net", "I write to someone else", { fromMe: true });
  await sleep(5_000);
  const quietElsewhere = (await runs()).length === runsBefore && wa.sent.filter((message) => message.at > at).length === 0;
  const pong = await ask(OWNER, "Reply with exactly the word pong.", { fromMe: true });
  notes.selfReply = pong.reply;
  const echoBefore = (await runs()).length;
  incoming(OWNER, pong.reply.split("\n")[0], { fromMe: true });
  incoming("123456789@lid", "🤖 pong", { fromMe: true });
  await sleep(6_000);
  checks.selfModeOnlyOwnChat = quietElsewhere;
  checks.selfModeMarkedReply = pong.reply.startsWith("🤖 ") && /pong/i.test(pong.reply);
  checks.selfModeNoEchoLoop = (await runs()).length === echoBefore;

  // 10. Unlinked from the dashboard.
  const logoutsBefore = wa.logouts;
  await call("whatsapp:unlink", { key: KEY }, "call");
  await until(() => wa.logouts > logoutsBefore, "the device to log out", 20).then(() => { checks.unlinkLogsOut = true; }, () => { checks.unlinkLogsOut = false; });

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
  control.close();
  await sleep(2_000);
  notes.whatsappSent = wa.sent.map(({ jid, text, file }) => ({ jid, text: text?.slice(0, 300), file }));
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt, where: notes.where, selfReply: notes.selfReply }, null, 2));
process.exit(result.passed ? 0 : 1);
