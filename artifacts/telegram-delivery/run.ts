import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sleep } from "../browser";

// bun artifacts/telegram-delivery/run.ts <outDir>
//
// Telegram delivery end to end, without reaching Telegram or the owner. A stand-in
// Bot API runs here, behind a cloudflared quick tunnel, and the deployment's
// TELEGRAM_API_BASE points at it for the length of the run (restored after), so
// every call Convex makes to "Telegram" is captured here instead. The test posts
// updates to the real /telegram webhook as the owner's chat; Codex on the runner
// answers them; the stand-in records and checks each call.
//
// Setup:
//   - This branch deployed to the deployment the Convex CLI in this folder targets
//     (a dev deployment, not the one you use day to day).
//   - The runner on this branch running, and signed in, and it must be the runner the
//     owner's Telegram chat is bound to (the one that has answered it before).
//   - cloudflared on PATH (a quick tunnel needs no account), or E2E_TUNNEL_URL set to
//     a public URL that forwards to http://127.0.0.1:${E2E_PORT ?? 8787}.
//   - CONVEX_URL set; the site URL is derived from it (or set CONVEX_SITE_URL).
//   - Do not message the bot while this runs: the owner's real replies would come
//     here too. Test turns are saved in the owner's Telegram chat history.
//   - The Codex turns write ~51 MB (big.bin) into <outDir>; the runner uploads it.
//
// Ways it could fail, and what this checks:
//   1. TELEGRAM_API_BASE is ignored, or not yet live, and a reply reaches real
//      Telegram. A probe goes to a chat id that does not exist ("e2e-probe"),
//      harmless if misrouted, and nothing else is sent until the stand-in sees it.
//   2. The deployment runs older code. Checked: codex:sharedFiles must exist.
//   3. An incoming file over 20 MB is fetched anyway, or silently dropped.
//      Checked: no getFile, one plain reply saying it is too big, no Codex turn.
//   4. Shared local files never reach Telegram (runner skips the upload, or
//      finishTurn drops them). Checked: every shared file arrives, bytes intact.
//   5. finishTurn duplicates a shared file instead of adding its upload to the
//      existing row. Checked: one attachment row per file, each with both a
//      local path and a storage id.
//   6. The wrong Bot API method for a type. Checked: png→sendPhoto,
//      gif→sendAnimation, mp3→sendAudio, ogg→sendVoice, mp4→sendVideo,
//      csv/txt→sendDocument.
//   7. A refused photo or voice note is lost. The stand-in refuses wide.png as a
//      photo and voice.ogg as a voice note; both must arrive as documents.
//   8. A file over 50 MB is uploaded (Telegram would refuse) or dropped. Checked:
//      big.bin is never uploaded, and a message links to its Convex storage URL.
//   9. A short reply is not captioned onto the first file, or the streamed draft
//      is left behind as a duplicate. Checked: square.png carries the caption and
//      the draft, if one was shown, is deleted.
//  10. A long reply comes after its files, or goes as a caption. Checked: it is
//      the first formatted message, before any file.
//  11. Markdown reaches Telegram unconverted or unescaped. Checked: bold, inline
//      code, links, code blocks with language, and <, & escaped, in the HTML sent.
//  12. Unparsable HTML loses the reply. The stand-in refuses the first HTML caption
//      with "can't parse entities"; the caption must come again as plain text.
//  13. A 429 is not retried, retried too soon, or retried forever. The stand-in
//      answers 429 (retry_after 1) once to square.png and twice to notes.txt; each
//      must succeed on the next try, no sooner than a second later.
//  14. Drafts are sent as HTML while streaming. Checked: only the last edit of a
//      draft carries parse_mode.

const [, , outArg] = process.argv;
const outDir = resolve(outArg ?? "artifacts/telegram-delivery/out");
const files = join(outDir, "files");
const received = join(outDir, "received");
mkdirSync(files, { recursive: true });
mkdirSync(received, { recursive: true });
const port = Number(process.env.E2E_PORT ?? 8787);
const site = process.env.CONVEX_SITE_URL ?? process.env.CONVEX_URL!.replace(/\.convex\.cloud\/?$/, ".convex.site");
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const convexRun = (fn: string, args: object) => JSON.parse(cli("run", fn, JSON.stringify(args)).trim() || "null");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// --- The files the agent will share ---
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const made: Record<string, Buffer> = {
  "square.png": png,
  "notes.txt": Buffer.from(`perry telegram e2e ${Date.now()}\n`),
  "wide.png": Buffer.concat([png, Buffer.from("wide")]),
  "clip.gif": Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  "tone.mp3": Buffer.alloc(2048, 1),
  "voice.ogg": Buffer.alloc(2048, 2),
  "clip.mp4": Buffer.alloc(4096, 3),
  "table.csv": Buffer.from("a,b\n1,2\n"),
};
for (const [name, bytes] of Object.entries(made)) writeFileSync(join(files, name), bytes);
writeFileSync(join(files, "big.bin"), Buffer.alloc(51 * 1024 * 1024, 7));
const path = (name: string) => join(files, name);

// --- The stand-in Bot API ---
type Call = { at: number; method: string; chatId?: string; fields: Record<string, string>; file?: { field: string; name: string; type: string; sha: string; size: number }; status: number; reply?: string };
const calls: Call[] = [];
let messageId = 1000;
const attempts = new Map<string, number>();
const once = (key: string) => { const n = (attempts.get(key) ?? 0) + 1; attempts.set(key, n); return n; };
const ok = (result: unknown) => Response.json({ ok: true, result });
const refuse = (status: number, description: string, extra: object = {}) => Response.json({ ok: false, error_code: status, description, ...extra }, { status });

const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/ping") return new Response("pong");
  const method = url.pathname.split("/").pop() ?? "";
  const call: Call = { at: Date.now(), method: url.pathname.startsWith("/file/") ? "download" : method, fields: {}, status: 200 };
  calls.push(call);
  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    for (const [key, value] of (await request.formData()).entries()) {
      if (typeof value === "string") { call.fields[key] = value; continue; }
      const bytes = new Uint8Array(await value.arrayBuffer());
      call.file = { field: key, name: value.name, type: value.type, sha: sha(bytes), size: bytes.length };
      writeFileSync(join(received, `${calls.length}-${method}-${value.name}`), bytes);
    }
  } else if (request.method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) call.fields[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  call.chatId = call.fields.chat_id;
  const answer = (() => {
    const name = call.file?.name;
    // 13: rate limits, once for square.png and twice for notes.txt.
    if (method === "sendPhoto" && name === "square.png" && once("square-429") === 1) return refuse(429, "Too Many Requests: retry after 1", { parameters: { retry_after: 1 } });
    if (method === "sendDocument" && name === "notes.txt" && once("notes-429") <= 2) return refuse(429, "Too Many Requests: retry after 1", { parameters: { retry_after: 1 } });
    // 12: the first HTML caption is refused as unparsable.
    if (method === "sendPhoto" && name === "square.png" && call.fields.parse_mode === "HTML" && once("square-html") === 1) return refuse(400, "Bad Request: can't parse entities: stand-in refusal");
    // 7: a photo and a voice note Telegram would not take.
    if (method === "sendPhoto" && name === "wide.png") return refuse(400, "Bad Request: PHOTO_INVALID_DIMENSIONS");
    if (method === "sendVoice") return refuse(400, "Bad Request: wrong file type");
    if (method === "getFile" || call.method === "download") return refuse(400, "Bad Request: the stand-in serves no files");
    if (method === "sendChatAction" || method === "deleteMessage") return ok(true);
    return ok({ message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: call.chatId, type: "private" }, text: call.fields.text });
  })();
  call.status = answer.status;
  if (answer.ok && method.startsWith("send")) call.reply = String(messageId);
  return answer;
};
const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const response = await handle(new Request(`http://127.0.0.1${incoming.url}`, {
    method: incoming.method,
    headers: Object.entries(incoming.headers).map(([key, value]) => [key, String(value)] as [string, string]),
    body: incoming.method === "POST" ? Buffer.concat(chunks) : undefined,
  }));
  outgoing.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" });
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1");

// --- Point the deployment at it, and put things back afterwards ---
let tunnel: ReturnType<typeof spawn> | null = null;
const previousBase = (() => { try { return cli("env", "get", "TELEGRAM_API_BASE").trim() || null; } catch { return null; } })();
let pointed = false;
const restore = () => {
  if (pointed) {
    try { previousBase ? cli("env", "set", "TELEGRAM_API_BASE", previousBase) : cli("env", "remove", "TELEGRAM_API_BASE"); }
    catch (error) { console.error(`RESTORE TELEGRAM_API_BASE BY HAND: ${String(error)}`); }
    pointed = false;
  }
  tunnel?.kill();
  server.close();
};
process.on("SIGINT", () => { restore(); process.exit(130); });

const waitFor = async <T>(what: string, check: () => T | undefined | null | false, ms: number): Promise<T> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = check();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const results: Record<string, unknown> = { ranAt: new Date().toISOString() };
let pass = false;
try {
  // 2: the deployment has this branch.
  if (!cli("function-spec").includes("sharedFiles")) throw new Error("The deployment does not have this branch's code (codex:sharedFiles is missing).");

  let base = process.env.E2E_TUNNEL_URL;
  if (!base) {
    tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    tunnel.stdout?.on("data", (chunk) => (log += chunk));
    tunnel.stderr?.on("data", (chunk) => (log += chunk));
    base = await waitFor("the tunnel URL", () => log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0], 60_000);
  }
  await waitFor("the tunnel to answer", () => {
    void fetch(`${base}/ping`).then((response) => { if (response.ok) results.tunnel = base; }).catch(() => {});
    return results.tunnel;
  }, 90_000);

  cli("env", "set", "TELEGRAM_API_BASE", base!);
  pointed = true;
  // 1: nothing goes to the owner until a probe to a chat that does not exist lands here.
  await waitFor("the probe", () => {
    // Not execFileSync: that would block this process, and with it the stand-in
    // that has to answer the very call the probe makes.
    execFile("node", ["node_modules/convex/bin/main.js", "run", "brain:sendDirect", JSON.stringify({ chatId: "e2e-probe", text: "probe" })], () => {});
    return calls.some((call) => call.chatId === "e2e-probe");
  }, 60_000);

  const install = convexRun("installation:get", {});
  if (install?.ownerChannel !== "telegram" || !install.ownerExternalId) throw new Error("This install has no Telegram owner.");
  const owner = String(install.ownerExternalId);
  const secret: string = convexRun("secrets:get", { name: "TELEGRAM_WEBHOOK_SECRET" });
  let updateId = Date.now() % 1_000_000_000;
  const post = async (message: object) => {
    const response = await fetch(`${site}/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: ++updateId, message: {
        message_id: updateId, date: Math.floor(Date.now() / 1000),
        chat: { id: Number(owner), type: "private" }, from: { id: Number(owner), is_bot: false }, ...message,
      } }),
    });
    if (!response.ok) throw new Error(`webhook answered ${response.status}`);
  };
  const since = (at: number) => calls.filter((call) => call.at >= at && call.chatId === owner);

  // --- A: a file over 20 MB ---
  const startA = Date.now();
  await post({ document: { file_id: "e2e-too-big", file_unique_id: "e2e", file_name: "huge.zip", mime_type: "application/zip", file_size: 25 * 1024 * 1024 } });
  const tooBig = await waitFor("the too-big reply", () => since(startA).find((call) => call.method === "sendMessage"), 60_000);
  await sleep(5000);
  results.tooBig = {
    reply: tooBig.fields.text,
    plain: !tooBig.fields.parse_mode,
    fetched: calls.some((call) => call.at >= startA && (call.method === "getFile" || call.method === "download")),
    turnStarted: since(startA).some((call) => call.method === "sendChatAction"),
  };
  const passA = /huge\.zip/.test(tooBig.fields.text) && /20 MB/.test(tooBig.fields.text) && !tooBig.fields.parse_mode
    && !(results.tooBig as { fetched: boolean }).fetched && !(results.tooBig as { turnStarted: boolean }).turnStarted;

  // --- B: a short reply captioned onto the first of two files ---
  const nonceB = `e2e-${Date.now()}`;
  const startB = Date.now();
  await post({ text: [
    `This is an automated test (${nonceB}). Call share_file with ${path("square.png")}, then call share_file with ${path("notes.txt")}.`,
    "Do not create, move or change any files. Then reply with exactly this line and nothing else:",
    "**Delivered** `notes.txt` and a <square> & [link](https://example.com/perry_e2e)",
  ].join("\n") });
  await waitFor("both files of B", () => {
    const got = since(startB).filter((call) => call.status === 200 && call.file);
    return got.some((call) => call.file!.name === "square.png") && got.some((call) => call.file!.name === "notes.txt");
  }, 8 * 60_000);
  await sleep(3000);
  const b = since(startB);
  const photos = b.filter((call) => call.method === "sendPhoto" && call.file?.name === "square.png");
  const notes = b.filter((call) => call.method === "sendDocument" && call.file?.name === "notes.txt");
  const drafts = b.filter((call) => call.method === "sendMessage" && !call.fields.parse_mode && call.status === 200);
  const htmlCaption = photos.find((call) => call.fields.parse_mode === "HTML" && call.status === 400)?.fields.caption ?? "";
  const plainCaption = photos.find((call) => call.status === 200)?.fields;
  results.shortReply = {
    photoAttempts: photos.map((call) => ({ status: call.status, parseMode: call.fields.parse_mode ?? null, at: call.at - startB })),
    notesAttempts: notes.map((call) => ({ status: call.status, at: call.at - startB })),
    htmlCaption, plainCaption: plainCaption?.caption,
    drafts: drafts.map((call) => call.reply), deleted: b.filter((call) => call.method === "deleteMessage").map((call) => call.fields.message_id),
    bytesIntact: photos.at(-1)?.file?.sha === sha(made["square.png"]) && notes.at(-1)?.file?.sha === sha(made["notes.txt"]),
  };
  const draftId = drafts[0]?.reply;
  const passB = photos.length === 3 && photos[0].status === 429 && photos[1].status === 400 && photos[2].status === 200
    && photos[1].at - photos[0].at >= 1000 && !photos[2].fields.parse_mode && Boolean(plainCaption?.caption?.includes("Delivered"))
    && notes.length === 3 && notes[0].status === 429 && notes[1].status === 429 && notes[2].status === 200 && notes[2].at - notes[0].at >= 2000
    && !notes[2].fields.caption
    && htmlCaption.includes("<b>Delivered</b>") && htmlCaption.includes("<code>notes.txt</code>")
    && htmlCaption.includes('<a href="https://example.com/perry_e2e">link</a>') && htmlCaption.includes("&lt;square&gt;") && htmlCaption.includes("&amp;")
    && (!draftId || b.some((call) => call.method === "deleteMessage" && call.fields.message_id === draftId))
    && Boolean((results.shortReply as { bytesIntact: boolean }).bytesIntact);

  // --- C: a long reply first, then every kind of file ---
  const nonceC = `e2e-${Date.now()}`;
  const startC = Date.now();
  const shared = ["wide.png", "clip.gif", "tone.mp3", "voice.ogg", "clip.mp4", "table.csv", "big.bin"];
  await post({ text: [
    `This is an automated test (${nonceC}). Call share_file once for each of these files, in this order:`,
    ...shared.map((name) => path(name)),
    "Do not create, move or change any files. Then reply with: a line `## Report`, then the word **done** in bold,",
    "then a fenced code block with language python containing exactly print(1 < 2), then the whole numbers from 1 to 400 separated by single spaces on one line.",
  ].join("\n") });
  await waitFor("every file of C", () => {
    const c = since(startC);
    const delivered = (name: string) => c.some((call) => call.status === 200 && call.file?.name === name);
    return shared.filter((name) => name !== "big.bin").every(delivered) && c.some((call) => call.method === "sendMessage" && /big\.bin/.test(call.fields.text ?? ""));
  }, 10 * 60_000);
  await sleep(3000);
  const c = since(startC);
  const formatted = c.find((call) => (call.method === "sendMessage" || call.method === "editMessageText") && call.fields.parse_mode === "HTML");
  const firstFile = c.findIndex((call) => call.file);
  const methodOf = (name: string) => c.filter((call) => call.file?.name === name).map((call) => `${call.method}:${call.status}`);
  const edits = c.filter((call) => call.method === "editMessageText");
  results.longReply = {
    formatted: formatted ? { method: formatted.method, text: formatted.fields.text.slice(0, 400) } : null,
    beforeFiles: formatted ? c.indexOf(formatted) < firstFile : false,
    methods: Object.fromEntries(shared.map((name) => [name, methodOf(name)])),
    bigLink: c.find((call) => /big\.bin/.test(call.fields.text ?? ""))?.fields.text,
    bytesIntact: shared.filter((name) => name !== "big.bin").every((name) => c.find((call) => call.status === 200 && call.file?.name === name)?.file?.sha === sha(made[name])),
    editsWithParseMode: edits.filter((call) => call.fields.parse_mode).length, edits: edits.length,
  };
  const methods = (results.longReply as { methods: Record<string, string[]> }).methods;
  const passC = Boolean(formatted) && (results.longReply as { beforeFiles: boolean }).beforeFiles
    && /<b>Report<\/b>/.test(formatted!.fields.text) && /<b>done<\/b>/.test(formatted!.fields.text)
    && formatted!.fields.text.includes('<pre><code class="language-python">print(1 &lt; 2)</code></pre>')
    && c.every((call) => !call.file || !call.fields.caption)
    && methods["wide.png"].join() === "sendPhoto:400,sendDocument:200" && methods["clip.gif"].join() === "sendAnimation:200"
    && methods["tone.mp3"].join() === "sendAudio:200" && methods["voice.ogg"].join() === "sendVoice:400,sendDocument:200"
    && methods["clip.mp4"].join() === "sendVideo:200" && methods["table.csv"].join() === "sendDocument:200" && methods["big.bin"].length === 0
    && /\/api\/storage\//.test((results.longReply as { bigLink?: string }).bigLink ?? "")
    && Boolean((results.longReply as { bytesIntact: boolean }).bytesIntact)
    && (edits.length === 0 || (edits.filter((call) => call.fields.parse_mode).length <= 1 && Boolean(edits.at(-1)!.fields.parse_mode) === (formatted!.method === "editMessageText")));

  // 5: one attachment row per shared file, each kept locally and uploaded.
  const turns = JSON.parse(cli("data", "codexTurns", "--limit", "20", "--order", "desc", "--format", "jsonArray")) as Array<{ _id: string; prompt: string }>;
  const rows = JSON.parse(cli("data", "chatAttachments", "--limit", "100", "--order", "desc", "--format", "jsonArray")) as Array<{ messageKey: string; fileName: string; localPath?: string; storageId?: string }>;
  const rowsOf = (nonce: string) => {
    const turn = turns.find((item) => item.prompt.includes(nonce));
    return rows.filter((row) => turn && row.messageKey === `codex-${turn._id}`).map((row) => ({ fileName: row.fileName, local: Boolean(row.localPath), stored: Boolean(row.storageId) }));
  };
  results.rows = { short: rowsOf(nonceB), long: rowsOf(nonceC) };
  const rowsOk = (list: Array<{ fileName: string; local: boolean; stored: boolean }>, names: string[]) =>
    list.length === names.length && names.every((name) => list.some((row) => row.fileName === name && row.local && row.stored));
  const passRows = rowsOk(rowsOf(nonceB), ["square.png", "notes.txt"]) && rowsOk(rowsOf(nonceC), shared);

  results.checks = { tooBig: passA, shortReply: passB, longReply: passC, rows: passRows };
  pass = passA && passB && passC && passRows;
} catch (error) {
  results.error = String(error);
} finally {
  restore();
}

results.pass = pass;
writeFileSync(join(outDir, "calls.json"), JSON.stringify(calls, null, 2) + "\n");
writeFileSync(join(outDir, "result.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
process.exit(pass ? 0 : 1);
