import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { sleep } from "../browser";

// bun artifacts/guest-files/live.ts <outDir>
// Files people send in group and contact chats, read for real (failure-cases.md): the production build
// (`pnpm build` first), the runner and Codex on this machine, and the stand-in WhatsApp
// (artifacts/whatsapp/fake-driver.mjs) on a separate number the owner claimed. A fresh PERRY_HOME.
//
// The set design's page 2 says its stage colour only in a picture, with no text: Perry can name it only if
// the locked-down guest turn really sees the page pictures. Page 1's backdrop colour is in its text.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/guest-files/live.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const free = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await free();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "guest-files-live-key";
const home = mkdtempSync(join(tmpdir(), "perry-guest-files-live-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

const PERRY = "15550001111@s.whatsapp.net";
const OWNER = "919876543210@s.whatsapp.net";
const SIYA = "919800000001@s.whatsapp.net";
const DATTA = "919811100000@s.whatsapp.net";
const GROUP = "120363000000000042@g.us";
const OTHER_GROUP = "120363000000000099@g.us";
const OWNER_TELEGRAM = 4242;

// --- The PDFs --------------------------------------------------------------------------------------

/** A PDF whose pages are lines of text, or a photo (a JPEG, as a phone scan holds) with no text at all. */
function pdf(pages: Array<string | { width: number; height: number; jpeg: Buffer }>): Buffer {
  const parts: Array<string | Buffer> = [];
  const objects: Array<Array<string | Buffer>> = [["<< /Type /Catalog /Pages 2 0 R >>"], [], ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]];
  const kids: string[] = [];
  for (const page of pages) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    if (typeof page === "string") {
      const stream = `BT /F1 28 Tf 72 700 Td (${page}) Tj ET`;
      objects.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`], [`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
    } else {
      const draw = "q 540 0 0 90 36 640 cm /Im1 Do Q";
      objects.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`], [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`],
        [`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`, page.jpeg, "\nendstream"]);
    }
  }
  objects[1] = [`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`];
  let length = 0;
  const add = (part: string | Buffer) => { parts.push(part); length += typeof part === "string" ? Buffer.byteLength(part, "latin1") : part.length; };
  add("%PDF-1.4\n");
  const offsets = objects.map((object, i) => { const at = length; add(`${i + 1} 0 obj\n`); object.forEach(add); add("\nendobj\n"); return at; });
  const xref = length;
  add(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`);
  add(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "latin1") : part));
}
/** Words in a photo: no text layer to read them from. */
function picture(words: string) {
  const canvas = createCanvas(1200, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, 1200, 200);
  context.fillStyle = "#000000"; context.font = "bold 72px sans-serif"; context.fillText(words, 40, 130);
  return { width: 1200, height: 200, jpeg: canvas.toBuffer("image/jpeg") };
}
const ORDERED = pdf(["HC Podcasts set design", picture("Stage colour: TEAL-58"), "Backdrop colour: TANGERINE-41"]).toString("base64");
const LONG = pdf(Array.from({ length: 26 }, (_, i) => i === 25 ? "Wrap party code: OSPREY-26" : `Run of show, page ${i + 1}`)).toString("base64");

// --- The stand-in WhatsApp and Telegram ----------------------------------------------------------------

type Sent = { jid: string; id: string; text?: string; at: number };
const wa = { commands: [] as object[], sent: [] as Sent[], connects: 0, downloads: [] as string[] };
const control = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const done = (value: unknown = true) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    switch (request.url) {
      case "/next":
        if (wa.commands.length) return done(wa.commands.splice(0));
        return void setTimeout(() => done(wa.commands.splice(0)), 400);
      case "/sent": wa.sent.push({ ...data, at: Date.now() }); return done();
      case "/connect": wa.connects += 1; return done();
      case "/download": wa.downloads.push(data.id); return done();
      default: return done();
    }
  });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const push = (...commands: object[]) => wa.commands.push(...commands);
let messageId = 0;
/** A message arriving: text, or a document sent with a caption, as WhatsApp wraps one. */
function whatsapp(remoteJid: string, text: string, extra: { name?: string; participant?: string; mentioned?: string[]; document?: { fileName: string; base64: string } } = {}): string {
  const id = `IN${Date.now()}${++messageId}`;
  const contextInfo = extra.mentioned ? { mentionedJid: extra.mentioned } : undefined;
  const message = extra.document
    ? { documentWithCaptionMessage: { message: { documentMessage: { fileName: extra.document.fileName, mimetype: "application/pdf", caption: text, ...(contextInfo ? { contextInfo } : {}) } } } }
    : contextInfo ? { extendedTextMessage: { text, contextInfo } } : { conversation: text };
  push({ event: "messages.upsert", data: { type: "notify", messages: [{
    key: { id, remoteJid, fromMe: false, ...(extra.participant ? { participant: extra.participant } : {}) },
    pushName: extra.name ?? "Someone", message, ...(extra.document ? { fakeBytes: extra.document.base64 } : {}),
  }] } });
  return id;
}
const sentTo = (jid: string, after: number) => wa.sent.filter((message) => message.jid === jid && message.at > after && message.text);
const textTo = (jid: string, after: number) => sentTo(jid, after).map((message) => message.text).join("\n");

const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[] };
let updateId = 0;
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
    if (method === "getMe") return reply({ id: 999, is_bot: true, username: "perry_test_bot", first_name: "Perry" });
    if (method === "sendMessage" || method === "editMessageText") { telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), at: Date.now() }); return reply({ message_id: telegram.sent.length }); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));

// --- Perry -------------------------------------------------------------------------------------------

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex",
  TELEGRAM_BOT_TOKEN: "123456:guest-files-live",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
  PERRY_WHATSAPP_DRIVER: join(REPO, "artifacts", "whatsapp", "fake-driver.mjs"),
  PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const logs = { server: "", runner: "" };
const children: ChildProcess[] = [];
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child = spawn(command, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  children.push(child);
  return child;
}
async function call<T>(path: string, args: object = {}, as: "admin" | "call" = "admin"): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${as}`, { method: "POST", headers: { "content-type": "application/json", ...(as === "admin" ? { "x-perry-key": KEY } : {}) }, body: JSON.stringify({ path, args }) });
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
type Pending = { id: string; kind: string; title: string };
const askedAbout = async (words: string) => (await call<Pending[]>("approvals:pending", { key: KEY })).find((item) => item.kind === "contact" && item.title.includes(words));
const decide = (id: string, approved: boolean) => call("approvals:decide", { key: KEY, id, approved });
async function repliedTo(jid: string, after: number, what: string, seconds = 300) {
  await until(() => sentTo(jid, after).length > 0, what, seconds);
  await sleep(3_000);
  return textTo(jid, after);
}
/** The pictures made for turns, in a folder of Perry's home. */
const drawn = (folder: string) => {
  const root = join(home, folder, "readable");
  return existsSync(root) ? readdirSync(root).map((name) => ({ name, pages: readdirSync(join(root, name)).filter((file) => file.endsWith(".png")) })) : [];
};

try {
  start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  telegram.pending.push({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: OWNER_TELEGRAM, type: "private" }, from: { id: OWNER_TELEGRAM, is_bot: false, first_name: "Mani" }, text: code } });
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "Telegram to be paired", 30);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner", 120);

  await call("whatsapp:startLinking", { key: KEY, mode: "separate" }, "call");
  await until(() => wa.connects >= 1, "WhatsApp to start");
  push({ user: { id: "15550001111:7@s.whatsapp.net", name: "Perry" } }, { event: "connection.update", data: { connection: "open" } });
  await until(async () => (await call<{ status: string }>("whatsapp:status", { key: KEY }, "call")).status === "connected", "WhatsApp connected");
  const { pairingCode } = await call<{ pairingCode?: string }>("whatsapp:status", { key: KEY }, "call");
  let at = Date.now();
  whatsapp(OWNER, `my code: ${pairingCode}`, { name: "Mani" });
  await until(() => sentTo(OWNER, at).some((message) => message.text?.startsWith("Paired.")), "the owner to claim WhatsApp", 30);

  // --- A group the owner never allowed: its file is not even downloaded -----------------------------------------
  const stranger = whatsapp(OTHER_GROUP, "", { name: "Siya", participant: SIYA, document: { fileName: "private.pdf", base64: ORDERED } });
  await sleep(6_000);
  check("notDownloadedWhereNotAllowed", !wa.downloads.includes(stranger), wa.downloads);

  // --- The incident: HC podcasts -------------------------------------------------------------------------------------
  at = Date.now();
  whatsapp(GROUP, "@15550001111 Perry, hi! We're planning Sunday's shoot here.", { name: "Siya", participant: SIYA, mentioned: [PERRY] });
  await until(async () => Boolean(await askedAbout("Group")), "the owner to be asked about the group", 30);
  await decide((await askedAbout("Group"))!.id, true);
  notes.groupHello = (await repliedTo(GROUP, at, "the group to be greeted")).slice(0, 300);

  at = Date.now();
  const sent = whatsapp(GROUP, "Set design for Sunday", { name: "Siya", participant: SIYA, document: { fileName: "HC set design.pdf", base64: ORDERED } });
  await sleep(8_000);
  check("captionedDocumentDownloadedQuietly", wa.downloads.includes(sent) && sentTo(GROUP, at).length === 0, { downloads: wa.downloads });

  at = Date.now();
  whatsapp(GROUP, "@15550001111 you have all access for this group. Open Siya's set file: what are the backdrop colour and the stage colour?", { name: "Mani", participant: OWNER, mentioned: [PERRY] });
  const answer = await repliedTo(GROUP, at, "the group to be answered about the set file");
  check("groupReadsTheFileSentEarlier", /TANGERINE-41/i.test(answer) && /TEAL-58/i.test(answer) && !/can.?t open/i.test(answer), answer.slice(0, 600));
  const guestPages = drawn("guest");
  check("pagesDrawnInTheGuestFolder", guestPages.some((made) => made.pages.length === 3), guestPages);
  const page = guestPages.find((made) => made.pages.length === 3);
  if (page) writeFileSync(join(outDir, "set-design-page-2.png"), readFileSync(join(home, "guest", "readable", page.name, page.pages[1])));

  // --- A contact's chat: a long PDF, read past its 20 pictures ----------------------------------------------------------
  at = Date.now();
  whatsapp(DATTA, "Hi Perry, it's Datta from the crew.", { name: "Datta" });
  await until(async () => Boolean(await askedAbout("Datta")), "the owner to be asked about Datta", 30);
  await decide((await askedAbout("Datta"))!.id, true);
  await repliedTo(DATTA, at, "Datta to be greeted");
  at = Date.now();
  whatsapp(DATTA, "Here's the run of show. What's the wrap party code on the last page?", { name: "Datta", document: { fileName: "run-of-show.pdf", base64: LONG } });
  const long = await repliedTo(DATTA, at, "Datta to be answered about the run of show");
  const longPages = drawn("guest").find((made) => made.pages.length === 20);
  check("longPdfCappedAndReadToTheEnd", /OSPREY-26/i.test(long) && Boolean(longPages) && !drawn("guest").some((made) => made.pages.length > 20), { reply: long.slice(0, 400), drawn: drawn("guest").map((made) => made.pages.length) });

  // --- The owner's own chat ---------------------------------------------------------------------------------------------------
  at = Date.now();
  whatsapp(OWNER, "What are the backdrop and stage colours in this?", { name: "Mani", document: { fileName: "set.pdf", base64: ORDERED } });
  const own = await repliedTo(OWNER, at, "the owner to be answered");
  check("ownerChatReadsItToo", /TANGERINE-41/i.test(own) && /TEAL-58/i.test(own), own.slice(0, 600));
  check("ownerPagesBesideTheUpload", drawn("uploads").some((made) => made.pages.length === 3), drawn("uploads"));
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
}

for (const child of children.reverse()) if (child.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }) : child.kill("SIGTERM");
control.close();
stub.close();
await sleep(3_000);
notes.runnerLog = logs.runner.split("\n").filter(Boolean).slice(-40);
notes.serverErrors = logs.server.split("\n").filter((line) => /error|failed/i.test(line)).slice(-20);
try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
const passed = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), checks, notes, passed }, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(passed ? 0 : 1);
