import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { FAKE_AGENT, REPO, perry, redact, sleep, type Row } from "../engine-acp/harness";
import { GUEST_TOOLS } from "../../convex/lib/engines";

// bun artifacts/library/run.ts <outDir>
// Issues #216 (the Library: every file uploaded to Perry or made by Perry, in one place) and #217 (one media player
// for video, audio and voice notes). A fresh Perry from the production build (`pnpm build` first) on a spare port,
// its PERRY_HOME in PERRY_E2E_DIR (W:\perry-tests\library on the owner's machine), TEMP and TMP wherever the caller
// set them (W:\perry-tests\tmp), the real runner and headless Chrome (artifacts/browser.ts). Only fakes answer:
// every chat is on Grok played by the fake ACP agent (artifacts/engine-acp/fake-agent.ts); Codex and Claude Code
// are signed out in homes of their own; Telegram is a stand-in Bot API (TELEGRAM_API_BASE) and WhatsApp the stand-in
// driver (artifacts/whatsapp/fake-driver.mjs). Test media is made here: PNGs and a WAV written byte by byte, a WebM
// video and an Opus voice note recorded by Chrome's MediaRecorder; no ffmpeg.
//
// Ways it could fail, written down before the checks.
// Where files come from, and what the Library says of each:
//   1. A kind of file never reaches the Library: a web upload, the pet's picture, a Telegram photo, voice note or
//      document, a WhatsApp image or voice note, a file Perry shared, one he wrote in his files folder in a step,
//      a generated image (on the computer, and stored for Telegram), a browser screenshot, a file added with
//      library_add, a file Perry left in his files folder without saying so.
//   2. It is there with the wrong kind (image, document, audio and video, other), the wrong who (you or Perry), the
//      wrong source (web chat, Telegram, WhatsApp, pet, schedule, task, project, Perry's folder) or the wrong how.
//   3. It is there twice: a file shared in two messages, a branch's copy of a chat's file, a generated image found by
//      the folder scan before its turn finished, a file indexed again on every start.
//   4. Something is there that should not be: a step's small browser picture (they stay with their steps), a file a
//      step changed outside Perry's files folder, a file in a chat with someone else, a file not on this computer.
//   5. Nothing is copied twice: an item's file is not the very file the chat shows (another copy in another folder).
//   6. The file cannot be opened from the Library: it is not served, served to someone without the key, served as
//      something that could run (HTML, SVG), or a stored (Telegram) file is not served at all.
// Backfill, from an install from before the Library:
//   7. Existing chat files are not indexed when Perry starts, are indexed with the wrong who/source/how (pet
//      pictures, looks at the screen, job and task chats, projects), or a second start adds them again.
//   8. Files in Perry's files folder are not found, hidden folders are, or a file deleted outside Perry stays listed.
// Filters, search and the page:
//   9. A filter lets through what it should not (kind, who, from, a project, when), the search misses a name or
//      matches on something other than the name, or filters do not survive a reload.
//  10. The gallery does not show images as pictures (or videos as their first frame), the list misses size, who or
//      source, the item view lacks the preview (image, video, audio, PDF, text, Markdown), the details, the link to
//      the chat, or the download; the empty state is missing on a fresh Perry.
//  11. The sidebar has no Library next to Brain; any page throws, in light or dark.
// Deleting:
//  12. Delete does not ask first; the file stays on disk (an upload, a stored Telegram file); the item stays in the
//      Library; the chat still shows the file, or shows nothing instead of saying it was removed; a turn is still
//      sent the file; a file outside Perry's folders is deleted from the owner's disk.
//  13. Deleting a chat leaves the Library pointing at it, loses a file a branch still shows, deletes a stored file
//      a branch still shows, or keeps a stored file nothing shows.
// Perry's tools:
//  14. library_list or library_find misses an item, ignores a filter, or gives no id to send it with; share_file
//      with a Library id does not show the file in the reply; library_add does not add, or copies the file.
//  15. A chat with someone else is given the Library tools, can call them, or can share a Library item; its files
//      are listed in the owner's Library.
// The media player (#217):
//  16. Video: no poster frame or big play button; play, pause, seeking by the bar, speed, mute, volume, the keys
//      (space/k, arrows, j/l, m, f) do nothing; picture-in-picture or full screen is missing.
//  17. Audio and voice notes: no waveform, seeking by the waveform does nothing, speed does not change, no download.
//  18. Two play at once; where a file was left is forgotten when its player comes back.
//  19. Voice notes from Telegram and WhatsApp do not get the player in the chat; it breaks at a phone's width or in dark.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/library/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

// --- Stand-ins for Telegram and WhatsApp -------------------------------------------------------------------------------
const OWNER_TG = 4242;
const telegram = { pending: [] as object[], sent: [] as Array<{ method: string; at: number }>, files: new Map<string, Buffer>() };
const tgServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const url = request.url ?? "";
    const file = url.match(/^\/file\/bot[^/]+\/(.+)$/);
    if (file) {
      const bytes = telegram.files.get(decodeURIComponent(file[1]));
      response.writeHead(bytes ? 200 : 404);
      return response.end(bytes ?? "");
    }
    const method = url.split("/").pop() ?? "";
    let args: Record<string, any> = {};
    try { args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 800);
    }
    if (method === "getFile") return reply({ file_id: args.file_id, file_path: args.file_id });
    if (method === "getMe") return reply({ id: 1, is_bot: true, username: "perry_test_bot", first_name: "Perry" });
    telegram.sent.push({ method, at: Date.now() });
    if (method.startsWith("send") || method === "editMessageText") return reply({ message_id: telegram.sent.length, chat: { id: OWNER_TG } });
    return reply(true);
  });
});
await new Promise<void>((done) => tgServer.listen(0, "127.0.0.1", done));
let updateId = 10;
const tgMessage = (fields: object) => telegram.pending.push({
  update_id: ++updateId,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: OWNER_TG, type: "private" }, from: { id: OWNER_TG, is_bot: false, first_name: "Mani" }, ...fields },
});

const OWNER_WA = "919876543210@s.whatsapp.net";
const wa = { commands: [] as object[], sent: [] as Array<Record<string, unknown>>, connects: 0 };
const waControl = createServer((request: IncomingMessage, response: ServerResponse) => {
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
      case "/connect": wa.connects += 1; return done();
      default: return done();
    }
  });
});
await new Promise<void>((done) => waControl.listen(0, "127.0.0.1", done));
let waId = 0;
const waIncoming = (message: object, fakeBytes?: Buffer) => wa.commands.push({
  event: "messages.upsert",
  data: { type: "notify", messages: [{ key: { id: `IN${Date.now()}${++waId}`, remoteJid: OWNER_WA, fromMe: false }, pushName: "Mani", message, ...(fakeBytes ? { fakeBytes: fakeBytes.toString("base64") } : {}) }] },
});

// --- Perry, on fakes only ----------------------------------------------------------------------------------------------
let fakeHome = "";
const p = await perry({
  name: "library",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "signed in for the test");
    writeFileSync(join(fakeHome, "steps-secret"), "library-steps-secret");
    const codexHome = join(home, "codex-signed-out");
    const claudeHome = join(home, "claude-signed-out");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    return {
      PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome,
      CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "",
    };
  },
  env: {
    TELEGRAM_BOT_TOKEN: "123456:library-e2e",
    TELEGRAM_API_BASE: `http://127.0.0.1:${(tgServer.address() as { port: number }).port}`,
    PERRY_WHATSAPP_DRIVER: join(REPO, "artifacts", "whatsapp", "fake-driver.mjs"),
    PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${(waControl.address() as { port: number }).port}`,
  },
});
const { KEY, BASE, call, check, notes, until, sql, rows, exchange, fakeLog, computers } = p;
const HOME = p.home;
const FILES = join(HOME, "files");
const UPLOADS = join(HOME, "uploads");
const OUTSIDE = join(dirname(HOME), `outside-${Date.now().toString(36)}`);
mkdirSync(OUTSIDE, { recursive: true });
const COOKIE = { cookie: `perry_media=${encodeURIComponent(KEY)}` };

// --- Test media, made here ---------------------------------------------------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** A PNG of a colour, with a stripe so pictures differ. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const stripe = Math.abs(x - y) < width / 8;
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = stripe ? 255 - r : r; raw[at + 1] = stripe ? 255 - g : g; raw[at + 2] = stripe ? 255 - b : b;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A WAV: a tone that swells and fades, so its waveform has a shape. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const envelope = Math.abs(Math.sin((Math.PI * i) / samples * 3));
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * envelope * 30000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8); head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
/** A one-page PDF that says something. */
function pdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 18 Tf 30 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 30 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// --- Helpers -----------------------------------------------------------------------------------------------------------
/** Insert a document as an older Perry would have left it, with its id recorded as the store does. */
function seed(table: string, doc: Record<string, unknown>): string {
  const id = `seed${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, ?)`, [id, table]);
  sql(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [id, Date.now(), JSON.stringify(doc)]);
  return id;
}
const patchDoc = (table: string, id: string, fields: Record<string, unknown>) => {
  for (const [field, value] of Object.entries(fields)) sql(`UPDATE "doc_${table}" SET doc = json_set(doc, '$.${field}', ?) WHERE _id = ?`, [value as string, id]);
};
const library = (): Row[] => rows("library");
const itemAt = (path: string) => library().find((row) => row.localPath === path);
const itemNamed = (name: string) => library().filter((row) => row.name === name);
const attachmentsOf = (chat: string) => rows("chatAttachments").filter((row) => row.conversationId === chat);
type Item = { id: string; name: string; kind: string; by: string; from: string; how: string; size: number; url: string; source: { label: string; href?: string }; project?: { name: string } };
const listed = async (filter: Record<string, string> = {}) => (await call<{ items: Item[]; total: number }>("library:list", { key: KEY, ...filter })).items;
const served = async (url: string, headers: Record<string, string> = COOKIE) => {
  const response = await fetch(`${BASE}${url}`, { headers });
  return { status: response.status, type: response.headers.get("content-type") ?? "", disposition: response.headers.get("content-disposition") ?? "", bytes: Buffer.from(await response.arrayBuffer()) };
};
/** Put a file in the uploads folder the way the composer does, and attach it to a chat's message. */
async function upload(chat: string, messageKey: string, name: string, bytes: Buffer, contentType: string, from?: "pet") {
  const response = await fetch(`${BASE}/api/media`, { method: "POST", headers: { ...COOKIE, "x-file-name": encodeURIComponent(name) }, body: new Uint8Array(bytes) });
  const { path, size } = await response.json() as { path: string; size: number };
  const id = await call<string>("dashboard:registerAttachment", { key: KEY, conversationId: chat, messageKey, localPath: path, fileName: name, contentType, size, ...(from ? { from } : {}) });
  return { id, path };
}
const runsDone = () => rows("runs").every((run) => run.status !== "running");
const onGrok = (id: string) => call("dashboard:setChatModel", { key: KEY, id, model: "grok-fake-fast", engine: "grok" }).catch(() => {});
function toolAnswer(name: string, args: object): any {
  const entry = fakeLog(fakeHome).filter((item) => item.mcp && item.tool === name && JSON.stringify(item.args) === JSON.stringify(args)).at(-1);
  if (!entry) return undefined;
  const text = JSON.parse(entry.answer).result?.content?.[0]?.text ?? "null";
  try { return JSON.parse(text); } catch { return text; }
}
async function tool(chat: string, name: string, args: object) {
  await exchange(chat, `TOOL ${name} ${JSON.stringify(args)}`);
  return toolAnswer(name, args);
}

let server: ReturnType<typeof p.start> | null = null;
const startServer = async () => {
  server = p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
};
const pageErrors: Array<{ page: string; error: string }> = [];

try {
  await startServer();
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // === The browser: the empty Library on a fresh Perry, and the test's video and voice note recorded ===================
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errors = []; { const e = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ").slice(0, 300)); e(...a); }; } window.addEventListener("error", (event) => window.__errors.push(String(event.message)));` });
  const collect = async (page: string) => { for (const error of (await evaluate(`window.__errors ?? []`).catch(() => [])) as string[]) pageErrors.push({ page, error }); };
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const size = (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  const shot = async (name: string) => {
    // This computer's name is in the sidebar; the picture shows a stand-in.
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.split(${JSON.stringify(hostname())}).join("THIS-PC"); return true; })()`);
    await sleep(300);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  const go = async (path: string, test: string, what: string) => {
    await collect(`before ${path}`);
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(test, what);
    await sleep(400);
  };
  const centre = async (selector: string, at = 0.5) => await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width * ${at}, y: r.y + r.height / 2 }; })()`) as { x: number; y: number };
  const clickAt = async ({ x, y }: { x: number; y: number }, count = 1) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let n = 1; n <= count; n++) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: n });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: n });
    }
  };
  const click = async (selector: string, at = 0.5) => clickAt(await centre(selector, at));
  const clickText = async (selector: string, text: string) => clickAt(await evaluate(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.innerText.trim() === ${JSON.stringify(text)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  const press = async (key: string, code = key, keyCode = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(key.length === 1 ? { text: key } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  };

  await scheme("light");
  await go("/library", `document.querySelector("[data-empty]") && document.body.innerText.includes("No files yet")`, "the empty Library");
  const sidebar = await evaluate(`[...document.querySelectorAll("[data-sidebar=menu-button]")].map((b) => b.innerText.trim()).filter(Boolean)`) as string[];
  check("sidebarLibraryNextToBrain", sidebar.indexOf("Library") === sidebar.indexOf("Brain") + 1 && (await evaluate(`document.querySelector('a[href="/library"]')?.getAttribute("data-active")`)) !== null, sidebar);
  check("emptyStateOnAFreshPerry", (await evaluate(`document.querySelector("[data-empty]")?.innerText ?? ""`) as string).includes("Files you send Perry"));
  await shot("empty-light.png");

  // A WebM video and an Opus voice note, recorded by Chrome itself.
  const recorded = await evaluate(`(async () => {
    const toBase64 = (blob) => new Promise((done) => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split("base64,")[1]); reader.readAsDataURL(blob); });
    const record = (stream, type, ms) => new Promise((done) => { const parts = []; const recorder = new MediaRecorder(stream, { mimeType: type }); recorder.ondataavailable = (e) => parts.push(e.data); recorder.onstop = () => done(new Blob(parts, { type })); recorder.start(250); setTimeout(() => recorder.stop(), ms); });
    // In the page and drawn each frame: a canvas off the page, or drawn on a timer, records nothing in headless Chrome.
    const canvas = Object.assign(document.createElement("canvas"), { width: 320, height: 180 });
    canvas.style.cssText = "position:fixed;left:0;top:0;opacity:0.01;pointer-events:none";
    document.body.append(canvas);
    const g = canvas.getContext("2d");
    let frame = 0;
    let drawing = true;
    const paint = () => { frame++; g.fillStyle = "hsl(" + (frame * 4 % 360) + ",70%,55%)"; g.fillRect(0, 0, 320, 180); g.fillStyle = "#fff"; g.font = "bold 40px sans-serif"; g.fillText("Perry " + Math.floor(frame / 30), 60, 105); if (drawing) requestAnimationFrame(paint); };
    paint();
    const audio = new AudioContext();
    const tone = audio.createOscillator(); const gain = audio.createGain(); const out = audio.createMediaStreamDestination();
    tone.frequency.value = 330; tone.connect(gain).connect(out); tone.start();
    let t = audio.currentTime; for (let i = 0; i < 12; i++) { gain.gain.setValueAtTime(i % 2 ? 0.05 : 0.9, t + i * 0.3); }
    const videoStream = canvas.captureStream(30);
    out.stream.getAudioTracks().forEach((track) => videoStream.addTrack(track));
    const videoType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const voiceType = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus" : "audio/webm;codecs=opus";
    const [video, voice] = await Promise.all([record(videoStream, videoType, 8000), record(out.stream, voiceType, 3600)]);
    drawing = false; canvas.remove(); tone.stop();
    return { video: await toBase64(video), voice: await toBase64(voice), voiceType, frames: frame };
  })()`) as { video: string; voice: string; voiceType: string; frames: number };
  const VIDEO = Buffer.from(recorded.video, "base64");
  const VOICE = Buffer.from(recorded.voice, "base64");
  notes.media = { video: VIDEO.length, voice: VOICE.length, voiceType: recorded.voiceType, frames: recorded.frames };
  if (VIDEO.length < 10_000) throw new Error("Chrome recorded no video");

  // === An install from before the Library: chats with files, as an older Perry left them ================================
  const general = await call<string>("dashboard:createChat", { key: KEY });
  const project = await call<string>("projects:create", { key: KEY, name: "Bathroom" });
  const inProject = await call<string>("dashboard:createChat", { key: KEY, projectId: project });
  const job = (await call<{ id: string }>("jobs:create", { name: "Weekly review", schedule: "0 9 * * 1", prompt: "Write the weekly review." })).id;
  const jobChat = await call<string>("dashboard:createChat", { key: KEY });
  patchDoc("conversations", jobChat, { jobId: job, title: "Weekly review" });
  const task = seed("tasks", { title: "Tidy the photos", prompt: "Tidy them", status: "done", createdAt: Date.now(), updatedAt: Date.now() });
  const taskChat = await call<string>("dashboard:createChat", { key: KEY });
  patchDoc("conversations", taskChat, { taskId: task, title: "Tidy the photos" });
  const guestJid = "15550002222@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: guestJid, kind: "person", name: "Priya" }] });
  const priya = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: guestJid });
  const guestThread = await call<string>("agentStore:createThread", { userId: `whatsapp:${guestJid}`, title: "Priya" });
  const guestChat = await call<string>("conversations:create", { channel: "whatsapp", externalId: guestJid, threadId: guestThread, contactId: priya._id });

  const write = (path: string, bytes: Buffer | string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return path; };
  const old = {
    upload: write(join(UPLOADS, "old-upload.png"), png(64, 48, [30, 120, 200])),
    pet: write(join(UPLOADS, "old-pet.png"), png(64, 48, [200, 80, 40])),
    look: write(join(UPLOADS, "old-look.png"), png(64, 48, [40, 160, 90])),
    generated: write(join(FILES, "generated", "old-generated.png"), png(64, 64, [150, 60, 200])),
    shared: write(join(FILES, "old-plan.md"), "# Old plan\n\n- one\n- two\n"),
    written: write(join(FILES, "drafts", "old-notes.txt"), "Notes Perry wrote in a step.\n"),
    elsewhere: write(join(OUTSIDE, "owner-code.ts"), "export const x = 1;\n"),
    stepPicture: write(join(HOME, "steps", "browser-old.jpg"), png(32, 24, [0, 0, 0])),
    job: write(join(FILES, "reviews", "week-39.md"), "# Week 39\n\nAll good.\n"),
    task: write(join(UPLOADS, "task-photo.png"), png(40, 40, [90, 90, 90])),
    projectFile: write(join(UPLOADS, "tiles.pdf"), pdf("Tiles quote")),
    guest: write(join(UPLOADS, "guest-photo.png"), png(40, 40, [250, 250, 0])),
    loose: write(join(FILES, "loose", "budget.csv"), "item,cost\ntiles,400\n"),
    hidden: write(join(FILES, ".cache", "secret.bin"), "x"),
  };
  const missing = join(FILES, "gone", "never-here.png");
  const now = Date.now();
  const attach = (conversationId: string, messageKey: string, localPath: string, fileName: string, contentType: string, createdAt = now - 86_400_000 * 3) =>
    seed("chatAttachments", { conversationId, messageKey, localPath, fileName, contentType, size: 0, createdAt });
  const runId = seed("runs", { conversationId: general, prompt: "old", status: "ok", startedAt: now - 86_400_000 * 3 });
  attach(general, "msg-old-1", old.upload, "receipt-march.png", "image/png", now - 86_400_000 * 40);
  attach(general, "msg-old-2", old.pet, "screen-2026-09-01-10-00-00.png", "image/png");
  attach(general, "codex-oldturn1", old.look, "old-look.png", "image/png");
  seed("screenLooks", { conversationId: general, which: "screen", why: "test", status: "done", path: old.look, createdAt: now - 86_400_000 * 3 });
  attach(general, "codex-oldturn2", old.generated, "ig_old.png", "image/png");
  attach(general, "codex-oldturn3", old.shared, "old-plan.md", "text/markdown");
  attach(general, "codex-oldturn3b", old.shared, "old-plan.md", "text/markdown");
  attach(general, `steps-${runId}`, old.written, "old-notes.txt", "text/plain");
  attach(general, `steps-${runId}`, old.elsewhere, "owner-code.ts", "application/octet-stream");
  attach(general, "steps", old.stepPicture, "browser-old.jpg", "image/jpeg");
  attach(general, "codex-oldturn4", missing, "never-here.png", "image/png");
  attach(jobChat, "codex-oldjob", old.job, "week-39.md", "text/markdown");
  attach(taskChat, "msg-task", old.task, "task-photo.png", "image/png");
  attach(inProject, "msg-proj", old.projectFile, "tiles.pdf", "application/pdf");
  attach(guestChat, "msg-guest", old.guest, "guest-photo.png", "image/png");
  // A fresh install has no Library rows; nothing indexed these when they came.
  sql(`DELETE FROM "doc_library"`);
  p.stop(server);
  await sleep(2_000);
  await startServer();

  // --- 7, 8. Backfill when Perry starts ----------------------------------------------------------------------------------
  const backfilled = Object.fromEntries(Object.entries(old).map(([name, path]) => [name, itemAt(path)]));
  const expectOld: Record<string, { by: string; from: string; how: string; kind: string; project?: boolean } | null> = {
    upload: { by: "owner", from: "web", how: "upload", kind: "image" },
    pet: { by: "owner", from: "pet", how: "upload", kind: "image" },
    look: { by: "perry", from: "pet", how: "look", kind: "image" },
    generated: { by: "perry", from: "web", how: "generated", kind: "image" },
    shared: { by: "perry", from: "web", how: "shared", kind: "document" },
    written: { by: "perry", from: "web", how: "written", kind: "document" },
    elsewhere: null,
    stepPicture: null,
    job: { by: "perry", from: "job", how: "shared", kind: "document" },
    task: { by: "owner", from: "task", how: "upload", kind: "image" },
    projectFile: { by: "owner", from: "web", how: "upload", kind: "document", project: true },
    guest: null,
    loose: { by: "perry", from: "folder", how: "folder", kind: "document" },
    hidden: null,
  };
  const wrongOld = Object.entries(expectOld).filter(([name, want]) => {
    const got = backfilled[name];
    if (!want) return Boolean(got);
    return !got || got.by !== want.by || got.from !== want.from || got.how !== want.how || got.kind !== want.kind || Boolean(got.projectId) !== Boolean(want.project);
  }).map(([name]) => ({ name, got: backfilled[name] && { by: backfilled[name]!.by, from: backfilled[name]!.from, how: backfilled[name]!.how, kind: backfilled[name]!.kind } }));
  check("backfillIndexesWhatWasThere", wrongOld.length === 0, wrongOld);
  check("backfillOncePerFile", itemNamed("old-plan.md").length === 1 && !library().some((row) => row.localPath === missing)
    && library().every((row) => row.localPath ? existsSync(row.localPath) : true), { plans: itemNamed("old-plan.md").length });
  const countBefore = library().length;
  p.stop(server);
  await sleep(2_000);
  await startServer();
  check("secondStartAddsNothing", library().length === countBefore, { before: countBefore, after: library().length });

  // === The runner, Telegram and WhatsApp ===============================================================================
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with the fake Grok", 120);
  const engines = (await computers()).filter((item) => item.online).flatMap((item) => item.engines);
  check("onlyFakeEngines", engines.every((engine) => engine.kind === "grok" || !engine.signedIn), engines.map((engine) => ({ kind: engine.kind, signedIn: engine.signedIn })));
  if (!checks().onlyFakeEngines) throw new Error("a real engine is signed in; stopping before any turn runs");
  for (const chat of [general, inProject]) await onGrok(chat);

  const { code } = await call<{ code: string }>("installation:startPairing");
  tgMessage({ text: code });
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "Telegram to be paired", 30);
  await call("whatsapp:startLinking", { key: KEY, mode: "separate" });
  await until(() => wa.connects >= 1, "WhatsApp to start", 30);
  wa.commands.push({ user: { id: "15550001111:7@s.whatsapp.net", name: "Perry" } }, { event: "connection.update", data: { connection: "open" } });
  await until(async () => (await call<{ status: string }>("whatsapp:status", { key: KEY })).status === "connected", "WhatsApp to connect", 30);
  const pairing = (await call<{ pairingCode?: string }>("whatsapp:status", { key: KEY })).pairingCode;
  waIncoming({ conversation: `here it is: ${pairing}` });
  await until(async () => (await call<{ paired: boolean }>("whatsapp:status", { key: KEY })).paired, "WhatsApp to be paired", 30);

  // === Files arriving, and files Perry makes =============================================================================
  // A web upload, through the composer itself.
  const RECEIPT = png(240, 160, [20, 140, 120]);
  write(join(OUTSIDE, "receipt-october.png"), RECEIPT);
  await go("/chat", `document.querySelector('input[type=file]')`, "the composer");
  const { root } = await send("DOM.getDocument") as { root: { nodeId: number } };
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" }) as { nodeId: number };
  await send("DOM.setFileInputFiles", { nodeId, files: [join(OUTSIDE, "receipt-october.png")] });
  await waitFor(`document.querySelector('[aria-label="Attached files"]')`, "the picked file");
  await evaluate(`document.querySelector('textarea[aria-label^="Message"]').focus(); true`);
  await send("Input.insertText", { text: "Here is the receipt" });
  const runsBefore = rows("runs").length;
  await evaluate(`document.querySelector('button[aria-label="Send message"]').click(); true`);
  await until(() => rows("runs").length > runsBefore && runsDone(), "the reply to the receipt", 120);
  const webChat = rows("runs").sort((a, b) => b.startedAt - a.startedAt)[0].conversationId as string;
  const receipt = itemNamed("receipt-october.png")[0];
  check("webUploadIndexed", receipt?.by === "owner" && receipt.from === "web" && receipt.how === "upload" && receipt.kind === "image" && receipt.conversationId === webChat
    && receipt.size === RECEIPT.length && receipt.localPath.startsWith(UPLOADS), receipt && { by: receipt.by, from: receipt.from, how: receipt.how, size: receipt.size });

  // Files for a chat in a project: a PDF, a voice memo, a Markdown note, a video, a page of HTML.
  const LEASE = pdf("Lease agreement 2026");
  const MEMO = wav(8);
  const files = {
    lease: await upload(inProject, "msg-proj-2", "lease.pdf", LEASE, "application/pdf"),
    memo: await upload(inProject, "msg-proj-2", "memo.wav", MEMO, "audio/wav"),
    note: await upload(inProject, "msg-proj-2", "shopping list.md", Buffer.from("# Shopping\n\n- **tiles**\n- grout\n"), "text/markdown"),
    video: await upload(inProject, "msg-proj-2", "walkthrough.webm", VIDEO, "video/webm"),
    page: await upload(inProject, "msg-proj-2", "page.html", Buffer.from("<script>alert(1)</script>"), "text/html"),
  };
  await call("dashboard:sendChat", { key: KEY, id: inProject, text: "Files for the bathroom", attachmentIds: Object.values(files).map((file) => file.id), messageKey: "msg-proj-2" });
  await until(async () => !(await p.getChat(inProject)).isRunning && p.turnsOf(inProject).length > 0 && p.turnsOf(inProject).every((turn) => turn.finalizedAt), "the bathroom files' reply", 120);
  // The pet's picture of the screen, sent from its chat.
  const petChat = await call<string>("dashboard:createChat", { key: KEY });
  await onGrok(petChat);
  const petShot = await upload(petChat, "msg-pet", "screen-2026-10-02-09-30-00.png", png(200, 120, [60, 60, 200]), "image/png", "pet");

  // Telegram: a photo, a voice note and a document.
  const TG_PHOTO = png(120, 90, [220, 40, 90]);
  telegram.files.set("photo-1", TG_PHOTO);
  telegram.files.set("voice-1", VOICE);
  telegram.files.set("doc-1", pdf("Invoice 42"));
  let before = rows("runs").length;
  tgMessage({ photo: [{ file_id: "photo-1", file_unique_id: "p1", width: 120, height: 90, file_size: TG_PHOTO.length }], caption: "the plumber's photo" });
  await until(() => rows("runs").length > before && runsDone(), "the Telegram photo's turn", 120);
  before = rows("runs").length;
  tgMessage({ voice: { file_id: "voice-1", file_unique_id: "v1", duration: 4, mime_type: "audio/ogg", file_size: VOICE.length } });
  await until(() => rows("runs").length > before && runsDone(), "the Telegram voice note's turn", 120);
  before = rows("runs").length;
  tgMessage({ document: { file_id: "doc-1", file_unique_id: "d1", file_name: "invoice-42.pdf", mime_type: "application/pdf" }, caption: "invoice" });
  await until(() => rows("runs").length > before && runsDone(), "the Telegram document's turn", 120);
  const tgChat = rows("conversations").find((row) => row.channel === "telegram")!._id;

  // WhatsApp: an image and a voice note.
  before = rows("runs").length;
  waIncoming({ imageMessage: { mimetype: "image/png", caption: "the tiles" } }, png(100, 100, [30, 30, 160]));
  await until(() => rows("runs").length > before && runsDone(), "the WhatsApp image's turn", 120);
  before = rows("runs").length;
  waIncoming({ audioMessage: { ptt: true, mimetype: "audio/ogg; codecs=opus" } }, VOICE);
  await until(() => rows("runs").length > before && runsDone(), "the WhatsApp voice note's turn", 120);
  const waChat = rows("conversations").find((row) => row.channel === "whatsapp" && !row.contactId)!._id;

  // Perry shares a file from his folder, adds one from elsewhere, writes one in a step, and takes a browser screenshot.
  const plan = write(join(FILES, "trip-plan.md"), "# Trip plan\n\n1. Lisbon\n2. Porto\n");
  const shared1 = await tool(general, "share_file", { path: plan });
  const shared2 = await tool(webChat, "share_file", { path: plan });
  const keep = write(join(OUTSIDE, "keep-this.txt"), "Keep this one.\n");
  const added = await tool(general, "library_add", { path: keep, name: "Warranty card" });
  const stepsDir = join(FILES, "work");
  mkdirSync(stepsDir, { recursive: true });
  const site = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Library test page</title><h1 style='font:40px sans-serif'>Library test page</h1>"); });
  const sitePort = await new Promise<number>((done) => site.listen(0, "127.0.0.1", () => done((site.address() as { port: number }).port)));
  const PAGE = `http://127.0.0.1:${sitePort}/`;
  await exchange(general, `STEPS ${JSON.stringify({ dir: stepsDir, page: PAGE, secretPage: `${PAGE}secret`, gap: 300 })}`, 180);
  await tool(general, "browser", { action: "open", url: PAGE });
  const screenshot = await tool(general, "browser", { action: "screenshot" });
  await tool(general, "browser", { action: "close" });
  site.close();

  // A generated image, as the runner reports one when a turn ends (codex.finishTurn), and one stored for Telegram
  // (codex.recoverMedia): the runner's own token, on a turn that is running and one that is done.
  const token = (JSON.parse(readFileSync(join(HOME, "runner.json"), "utf8")) as { token: string }).token;
  const generatedPath = write(join(FILES, "generated", `${Date.now()}.png`), png(256, 256, [250, 160, 20]));
  await call("dashboard:sendChat", { key: KEY, id: general, text: "QUIET 25" });
  await until(() => p.turnsOf(general).some((turn) => turn.status === "running"), "the quiet turn to run", 60);
  const quiet = p.turnsOf(general).find((turn) => turn.status === "running")!;
  await fetch(`${BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "codex:finishTurn", args: {
    token, id: quiet._id, response: "Here is the picture.", media: [{ localPath: generatedPath, fileName: "ig_sunset.png", contentType: "image/png" }],
  } }) });
  await until(() => Boolean(p.turnsOf(general).find((turn) => turn._id === quiet._id)?.finalizedAt), "the generated image's turn to finish", 60);
  const tgTurn = p.turnsOf(tgChat).filter((turn) => turn.status === "done").at(-1)!;
  const uploadUrl = await (await fetch(`${BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "codex:recoverMediaUploadUrl", args: { token, id: tgTurn._id } }) })).json() as { value: string };
  const TG_GENERATED = png(128, 128, [10, 200, 220]);
  const { storageId } = await (await fetch(`${BASE}${uploadUrl.value}`, { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(TG_GENERATED) })).json() as { storageId: string };
  await fetch(`${BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "codex:recoverMedia", args: { token, id: tgTurn._id, storageId, fileName: "ig_tg.png", contentType: "image/png" } }) });
  // A file Perry left in his folder without saying so; found when the Library is brought up to date.
  const loose = write(join(FILES, "exports", "photos.zip"), Buffer.from("PK\u0003\u0004 not really a zip"));
  await call("library:sync", {});
  await until(runsDone, "every turn to end", 60);

  // --- 1, 2, 3, 4, 5: each kind of file, as the Library has it ---------------------------------------------------------
  const one = (name: string) => itemNamed(name);
  const expectLive: Record<string, { by: string; from: string; how: string; kind: string; project?: boolean; stored?: boolean }> = {
    "lease.pdf": { by: "owner", from: "web", how: "upload", kind: "document", project: true },
    "memo.wav": { by: "owner", from: "web", how: "upload", kind: "media", project: true },
    "shopping list.md": { by: "owner", from: "web", how: "upload", kind: "document", project: true },
    "walkthrough.webm": { by: "owner", from: "web", how: "upload", kind: "media", project: true },
    "page.html": { by: "owner", from: "web", how: "upload", kind: "document", project: true },
    "screen-2026-10-02-09-30-00.png": { by: "owner", from: "pet", how: "upload", kind: "image" },
    "photo.jpg": { by: "owner", from: "telegram", how: "upload", kind: "image", stored: true },
    "voice-note.ogg": { by: "owner", from: "telegram", how: "upload", kind: "media", stored: true },
    "invoice-42.pdf": { by: "owner", from: "telegram", how: "upload", kind: "document", stored: true },
    "trip-plan.md": { by: "perry", from: "web", how: "shared", kind: "document" },
    "Warranty card": { by: "perry", from: "web", how: "added", kind: "document" },
    "notes.md": { by: "perry", from: "web", how: "written", kind: "document" },
    "ig_sunset.png": { by: "perry", from: "web", how: "generated", kind: "image" },
    "ig_tg.png": { by: "perry", from: "telegram", how: "generated", kind: "image", stored: true },
    "photos.zip": { by: "perry", from: "folder", how: "folder", kind: "other" },
  };
  const waRows = library().filter((row) => row.from === "whatsapp");
  const wrongLive = Object.entries(expectLive).flatMap(([name, want]) => {
    const found = name === "photo.jpg" || name === "voice-note.ogg" ? one(name).filter((row) => row.from === "telegram") : one(name);
    const got = found[0];
    return found.length === 1 && got.by === want.by && got.from === want.from && got.how === want.how && got.kind === want.kind
      && Boolean(got.projectId) === Boolean(want.project) && Boolean(got.storageId) === Boolean(want.stored) ? [] : [{ name, count: found.length, got: got && { by: got.by, from: got.from, how: got.how, kind: got.kind, project: Boolean(got.projectId), stored: Boolean(got.storageId) } }];
  });
  check("eachKindOfFileIndexed", wrongLive.length === 0, wrongLive);
  check("whatsAppFilesIndexed", waRows.length === 2 && waRows.some((row) => row.kind === "image" && row.by === "owner") && waRows.some((row) => row.name === "voice-note.ogg" && row.kind === "media" && row.storageId),
    waRows.map((row) => ({ name: row.name, kind: row.kind, stored: Boolean(row.storageId) })));
  const screenshotPath: string | undefined = screenshot?.result?.screenshot ?? screenshot?.screenshot;
  const shotRow = screenshotPath ? itemAt(screenshotPath) : undefined;
  check("browserScreenshotIndexed", shotRow?.how === "screenshot" && shotRow.by === "perry" && shotRow.conversationId === general, { screenshotPath: screenshotPath && redact(screenshotPath), how: shotRow?.how });
  const stepPictures = rows("chatAttachments").filter((row) => row.messageKey === "steps");
  check("stepPicturesStayWithTheirSteps", stepPictures.length >= 1 && stepPictures.every((row) => !library().some((item) => item.localPath === row.localPath && item.how !== "screenshot")),
    { stepPictures: stepPictures.length });
  check("sharedTwiceIsOneItem", one("trip-plan.md").length === 1 && shared1?.shared === true && shared2?.shared === true
    && rows("chatAttachments").filter((row) => row.localPath === plan).length === 2, { shared1, shared2 });
  check("addedNotCopied", added?.added === true && itemAt(keep)?.name === "Warranty card" && existsSync(keep), added);
  check("generatedFoundOnce", library().filter((row) => row.localPath === generatedPath).length === 1 && itemAt(generatedPath)?.how === "generated", itemAt(generatedPath)?.how);
  check("guestFilesNotInLibrary", !library().some((row) => row.conversationId === guestChat || row.localPath === old.guest));
  // 5. Nothing copied: the item's file is the chat's file.
  const sameFile = [receipt, ...Object.values(files).map((file) => itemAt(file.path))].every((item) => item && rows("chatAttachments").some((row) => row.localPath === item.localPath));
  const storedSame = library().filter((row) => row.storageId).every((row) => rows("chatAttachments").some((attachment) => attachment.storageId === row.storageId));
  check("nothingCopiedTwice", sameFile && storedSame);

  // --- 6. Served from where it is ----------------------------------------------------------------------------------------
  const asListed = await listed();
  const byName = (name: string) => asListed.find((item) => item.name === name)!;
  const receiptServed = await served(byName("receipt-october.png").url);
  const tgServed = await served(asListed.find((item) => item.name === "photo.jpg" && item.from === "telegram")!.url);
  const htmlServed = await served(byName("page.html").url);
  const pdfServed = await served(byName("lease.pdf").url);
  const mdServed = await served(byName("shopping list.md").url);
  const noKey = await served(byName("receipt-october.png").url, {});
  const download = await served(`${byName("receipt-october.png").url}?download=1`);
  const ranged = await fetch(`${BASE}${byName("walkthrough.webm").url}`, { headers: { ...COOKIE, range: "bytes=0-99" } });
  check("servedFromWhereItIs", receiptServed.status === 200 && sha(receiptServed.bytes) === sha(RECEIPT) && receiptServed.type === "image/png"
    && tgServed.status === 200 && sha(tgServed.bytes) === sha(TG_PHOTO)
    && htmlServed.type === "application/octet-stream" && htmlServed.disposition.startsWith("attachment")
    && pdfServed.type === "application/pdf" && pdfServed.disposition.startsWith("inline") && mdServed.type.startsWith("text/plain")
    && noKey.status === 401 && download.disposition.startsWith("attachment") && ranged.status === 206,
  { receipt: receiptServed.status, tg: tgServed.status, html: htmlServed.type, pdf: pdfServed.type, md: mdServed.type, noKey: noKey.status, download: download.disposition.split(";")[0], ranged: ranged.status });

  // --- 9. Filters and search ---------------------------------------------------------------------------------------------
  const names = (items: Item[]) => items.map((item) => item.name);
  const images = await listed({ kind: "image" });
  const media = await listed({ kind: "media" });
  const mine = await listed({ by: "owner" });
  const perrys = await listed({ by: "perry" });
  const fromTelegram = await listed({ from: "telegram" });
  const fromPet = await listed({ from: "pet" });
  const fromJobs = await listed({ from: "job" });
  const fromTasks = await listed({ from: "task" });
  const fromProject = await listed({ from: project });
  const anyProject = await listed({ from: "project" });
  const today = await listed({ since: "today" });
  const month = await listed({ since: "month" });
  const search = await listed({ query: "receipt" });
  const searchTwo = await listed({ query: "SHOPPING list" });
  const searchNone = await listed({ query: "Lisbon" });
  check("filtersKeepToWhatTheySay", images.length > 0 && images.every((item) => item.kind === "image") && media.every((item) => item.kind === "media") && names(media).includes("walkthrough.webm")
    && mine.every((item) => item.by === "owner") && perrys.every((item) => item.by === "perry") && mine.length + perrys.length === asListed.length
    && fromTelegram.length === 4 && fromTelegram.every((item) => item.from === "telegram") && fromPet.every((item) => item.from === "pet") && fromPet.length === 3
    && names(fromJobs).join() === "week-39.md" && names(fromTasks).join() === "task-photo.png"
    && fromProject.length === 6 && fromProject.every((item) => item.project?.name === "Bathroom") && anyProject.length === 6
    && !names(today).includes("receipt-march.png") && names(today).includes("receipt-october.png") && !names(month).includes("receipt-march.png") && names(month).includes("old-look.png"),
  { images: images.length, media: names(media), telegram: names(fromTelegram), pet: names(fromPet), jobs: names(fromJobs), project: names(fromProject), today: today.length });
  check("searchByName", names(search).sort().join() === "receipt-march.png,receipt-october.png" && names(searchTwo).join() === "shopping list.md" && searchNone.length === 0,
    { search: names(search), searchTwo: names(searchTwo) });
  check("sourceLinks", byName("receipt-october.png").source.href === `/chat/${webChat}` && byName("week-39.md").source.label === "Weekly review"
    && byName("task-photo.png").source.label === "Tidy the photos" && byName("photos.zip").source.label === "Perry's files folder",
  { receipt: byName("receipt-october.png").source, job: byName("week-39.md").source });

  // --- 14, 15. Perry's tools, over MCP --------------------------------------------------------------------------------
  const listImages = await tool(general, "library_list", { kind: "image", madeBy: "owner" });
  const findReceipt = await tool(general, "library_find", { query: "receipt", madeBy: "owner", since: "week" });
  const findVoice = await tool(general, "library_find", { query: "voice-note", from: "telegram" });
  check("libraryToolsFind", listImages?.found > 0 && listImages.items.every((item: any) => item.kind === "image" && item.madeBy === "owner")
    && findReceipt?.found === 1 && findReceipt.items[0].name === "receipt-october.png" && findReceipt.items[0].path && findReceipt.items[0].id
    && findVoice?.found === 1 && findVoice.items[0].name === "voice-note.ogg",
  { listImages: listImages?.found, findReceipt: findReceipt?.items?.map((item: any) => item.name), findVoice: findVoice?.items?.map((item: any) => item.name) });
  const tgVoiceId = findVoice?.items?.[0]?.id;
  const sendBack = await tool(general, "share_file", { id: tgVoiceId });
  const lastReply = (await call<{ page: Array<{ role: string; attachments: Array<{ fileName: string; url: string }> }> }>("dashboard:getChatMessages", { key: KEY, id: general, paginationOpts: { numItems: 5, cursor: null } }))
    .page.find((message) => message.role === "assistant");
  check("shareFromLibraryById", sendBack?.shared === true && lastReply?.attachments.some((file) => file.fileName === "voice-note.ogg") === true
    && library().filter((row) => row.name === "voice-note.ogg" && row.from === "telegram").length === 1, { sendBack, files: lastReply?.attachments.map((file) => file.fileName) });

  // A chat with someone else: a turn of theirs is running; the MCP server gives it no Library and no way to share one.
  const runner = rows("runners")[0]._id;
  const guestRun = seed("runs", { conversationId: guestChat, prompt: "hi", status: "running", startedAt: Date.now() });
  const guestTurn = seed("codexTurns", { runnerId: runner, conversationId: guestChat, runId: guestRun, engine: "codex", prompt: "hi", instructions: "", guest: true, status: "running", createdAt: Date.now() });
  const mcp = async (body: object) => await (await fetch(`${BASE}/api/backend/http/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-perry-chat": guestChat }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) })).json() as any;
  const guestList = await mcp({ method: "tools/list" });
  const guestFind = await mcp({ method: "tools/call", params: { name: "library_find", arguments: { query: "receipt" } } });
  const guestShare = await mcp({ method: "tools/call", params: { name: "share_file", arguments: { id: tgVoiceId } } });
  sql(`DELETE FROM "doc_codexTurns" WHERE _id = ?`, [guestTurn]);
  sql(`DELETE FROM "doc_runs" WHERE _id = ?`, [guestRun]);
  const guestNames = (guestList.result?.tools ?? []).map((item: any) => item.name);
  check("guestHasNoLibrary", guestNames.length > 0 && !guestNames.some((name: string) => /library|share_file/.test(name)) && !GUEST_TOOLS.some((name) => /library/.test(name))
    && /Unknown tool/.test(JSON.stringify(guestFind)) && /Unknown tool/.test(JSON.stringify(guestShare)) && !attachmentsOf(guestChat).some((row) => row.messageKey.startsWith("codex-")),
  { guestNames, guestFind: JSON.stringify(guestFind).slice(0, 200), guestShare: JSON.stringify(guestShare).slice(0, 200) });

  // === The page ======================================================================================================
  for (const theme of ["light", "dark"] as const) {
    await scheme(theme);
    await go("/library", `document.querySelector('[data-view="gallery"] li')`, "the gallery");
    // Thumbnails load as they come into view: down the page and back.
    await evaluate(`(async () => { for (const img of document.querySelectorAll('[data-view="gallery"] img')) { img.scrollIntoView(); await new Promise((r) => setTimeout(r, 60)); } for (const box of [document.scrollingElement, document.querySelector("main"), document.querySelector("[data-slot=sidebar-inset]")]) box?.scrollTo?.(0, 0); return true; })()`);
    await until(() => evaluate(`[...document.querySelectorAll('[data-view="gallery"] img')].every((img) => img.complete && img.naturalWidth > 0)`), "the thumbnails", 30);
    await shot(`gallery-${theme}.png`);
    await collect(`/library (${theme})`);
  }
  await scheme("light");
  const gallery = await evaluate(`(() => { const tiles = [...document.querySelectorAll('[data-view="gallery"] li')];
    return { tiles: tiles.length, images: tiles.filter((li) => li.dataset.kind === "image" && li.querySelector("img")?.naturalWidth > 0).length, imageTiles: tiles.filter((li) => li.dataset.kind === "image").length,
      videos: tiles.filter((li) => li.querySelector("video")).length, audio: document.querySelectorAll('[data-view="gallery"] [data-media-player="audio"]').length }; })()`) as Record<string, number>;
  check("galleryShowsPictures", gallery.tiles === asListed.length && gallery.images === gallery.imageTiles && gallery.images > 5 && gallery.videos === 1 && gallery.audio >= 3, gallery);

  // The list, by its toggle.
  await click('[aria-label="List"]');
  await waitFor(`location.search.includes("view=list") && document.querySelector('ul[aria-label="Library"] li')`, "the list view");
  const listText = await evaluate(`document.querySelector('ul[aria-label="Library"]').innerText`) as string;
  check("listShowsDetails", /KB/.test(listText) && /Perry/.test(listText) && /Telegram/.test(listText) && /Schedule · Weekly review/.test(listText), listText.slice(0, 400));
  await shot("list-light.png");

  // Filters, by their menus: Kind → Images, then Who → From you; they stay through a reload.
  await click('[data-filter="Kind"]');
  await waitFor(`[...document.querySelectorAll('[role="option"]')].some((o) => o.innerText.trim() === "Images")`, "the Kind menu");
  await clickAt(await evaluate(`(() => { const r = [...document.querySelectorAll('[role="option"]')].find((o) => o.innerText.trim() === "Images").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  await waitFor(`location.search.includes("kind=image")`, "the Kind filter in the address");
  await click('[data-filter="Who"]');
  await waitFor(`[...document.querySelectorAll('[role="option"]')].some((o) => o.innerText.trim() === "From you")`, "the Who menu");
  await clickAt(await evaluate(`(() => { const r = [...document.querySelectorAll('[role="option"]')].find((o) => o.innerText.trim() === "From you").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  await waitFor(`location.search.includes("by=owner")`, "the Who filter in the address");
  await sleep(800);
  const filteredRows = await evaluate(`[...document.querySelectorAll('ul[aria-label="Library"] li')].map((li) => li.dataset.kind + "/" + li.dataset.by)`) as string[];
  await send("Page.reload");
  await waitFor(`document.querySelector('ul[aria-label="Library"] li')`, "the filtered list after a reload");
  await sleep(800);
  const afterReload = await evaluate(`[...document.querySelectorAll('ul[aria-label="Library"] li')].length`) as number;
  const triggers = await evaluate(`[...document.querySelectorAll('[data-filter]')].map((t) => t.innerText.trim())`) as string[];
  check("filtersByTheirMenus", filteredRows.length === (await listed({ kind: "image", by: "owner" })).length && filteredRows.every((row) => row === "image/owner") && afterReload === filteredRows.length
    && triggers.includes("Images") && triggers.includes("From you"), { filteredRows: filteredRows.length, afterReload, triggers });
  await shot("filters-light.png");
  // Search, typed.
  await evaluate(`(() => { const input = document.querySelector('input[aria-label="Search the Library"]'); input.focus(); return true; })()`);
  await send("Input.insertText", { text: "march" });
  await waitFor(`document.querySelectorAll('ul[aria-label="Library"] li').length === 1 && document.querySelector('ul[aria-label="Library"]').innerText.includes("receipt-march.png")`, "the search to narrow the list");
  await until(() => evaluate(`location.search.includes("q=march")`), "the search in the address", 5);
  await shot("search-light.png");
  await click('[aria-label="Clear search"]');
  await go("/library?q=nothing-is-called-this", `document.querySelector("[data-empty]")`, "nothing matches");
  check("nothingMatchesSays", (await evaluate(`document.querySelector("[data-empty]").innerText`) as string).includes("Nothing matches"));

  // --- 10. Each item ----------------------------------------------------------------------------------------------
  const open = async (name: string) => {
    const item = byName(name);
    await go(`/library/${item.id}`, `document.querySelector("[data-preview]") && document.querySelector('dl[aria-label="Details"]')`, `${name}'s page`);
    return item;
  };
  const previews: Record<string, unknown> = {};
  for (const theme of ["light", "dark"] as const) {
    await scheme(theme);
    await open("receipt-october.png");
    await waitFor(`document.querySelector('[data-preview="image"] img')?.naturalWidth > 0`, "the picture");
    await shot(`item-image-${theme}.png`);
    await collect(`item image (${theme})`);
  }
  await scheme("light");
  const details = await evaluate(`document.querySelector('dl[aria-label="Details"]').innerText`) as string;
  const chatLink = await evaluate(`document.querySelector('[data-source] a')?.getAttribute("href")`) as string;
  const downloadLink = await evaluate(`[...document.querySelectorAll("a[download]")].map((a) => a.getAttribute("href"))[0]`) as string;
  check("itemShowsDetails", /KB/.test(details) && /You · Sent to Perry/.test(details) && /Web chat/.test(details) && /Saved in/.test(details) && chatLink === `/chat/${webChat}`
    && downloadLink?.endsWith("?download=1"), { details: redact(details), chatLink, downloadLink });
  await open("lease.pdf");
  previews.pdf = await evaluate(`document.querySelector('[data-preview="pdf"] iframe')?.getAttribute("src")`);
  await shot("item-pdf-light.png");
  await open("shopping list.md");
  await waitFor(`document.querySelector("[data-text-preview]")`, "the Markdown");
  previews.markdown = await evaluate(`document.querySelector("[data-text-preview] strong")?.innerText`);
  await shot("item-markdown-light.png");
  await open("old-notes.txt");
  await waitFor(`document.querySelector("[data-text-preview]")`, "the text");
  previews.text = await evaluate(`document.querySelector("[data-text-preview]").innerText`);
  await open("photos.zip");
  previews.none = await evaluate(`document.querySelector('[data-preview="none"]')?.innerText`);
  check("previewsByKind", typeof previews.pdf === "string" && previews.markdown === "tiles" && String(previews.text).includes("Notes Perry wrote") && String(previews.none).includes("No preview"), previews);

  // --- 16, 18. The video player ---------------------------------------------------------------------------------------
  const video = `document.querySelector('[data-media-player="video"] video')`;
  await open("walkthrough.webm");
  await until(() => evaluate(`${video}.readyState >= 1 && Number.isFinite(${video}.duration) && ${video}.duration > 5`), "the video's length", 30)
    .catch(async (error) => { notes.videoState = await evaluate(`({ ready: ${video}.readyState, duration: String(${video}.duration), error: ${video}.error?.message ?? null, src: ${video}.currentSrc, time: ${video}.currentTime, network: ${video}.networkState })`); throw error; });
  const poster = await evaluate(`({ big: Boolean(document.querySelector("[data-big-play]")), frame: ${video}.readyState >= 2 })`) as Record<string, boolean>;
  await shot("player-video-poster-light.png");
  await click("[data-big-play]");
  await until(() => evaluate(`!${video}.paused && ${video}.currentTime > 0.3`), "the video to play", 15);
  const playing = await evaluate(`document.querySelector('[data-media-player="video"]').dataset.playing === "true"`);
  await evaluate(`document.querySelector('[data-media-player="video"]').focus(); true`);
  await press("k", "KeyK", 75);
  await until(() => evaluate(`${video}.paused`), "k to pause", 5);
  const duration = await evaluate(`${video}.duration`) as number;
  await clickAt(await evaluate(`(() => { const r = document.querySelector('[data-media-player="video"] input[aria-label="Seek"]').getBoundingClientRect(); return { x: r.x + r.width * 0.75, y: r.y + r.height / 2 }; })()`));
  await sleep(400);
  const seekedTo = await evaluate(`${video}.currentTime`) as number;
  await evaluate(`document.querySelector('[data-media-player="video"]').focus(); true`);
  await press("ArrowLeft", "ArrowLeft", 37);
  await sleep(200);
  const afterLeft = await evaluate(`${video}.currentTime`) as number;
  await press("j", "KeyJ", 74);
  await sleep(200);
  const afterJ = await evaluate(`${video}.currentTime`) as number;
  await press("l", "KeyL", 76);
  await sleep(200);
  const afterL = await evaluate(`${video}.currentTime`) as number;
  await press("m", "KeyM", 77);
  const mutedNow = await evaluate(`${video}.muted`);
  await press("m", "KeyM", 77);
  await press("ArrowDown", "ArrowDown", 40);
  await sleep(100);
  const volume = await evaluate(`${video}.volume`) as number;
  await click('[data-media-player="video"] button[aria-label^="Speed"]');
  const rate = await evaluate(`${video}.playbackRate`);
  await evaluate(`document.querySelector('[data-media-player="video"]').focus(); true`);
  await press(" ", "Space", 32);
  await until(() => evaluate(`!${video}.paused`), "space to play", 5);
  await sleep(1200);
  await shot("player-video-playing-light.png");
  await press(" ", "Space", 32);
  const pipButton = await evaluate(`Boolean(document.querySelector('[data-media-player="video"] button[aria-label="Picture-in-picture"]'))`);
  const pipEnabled = await evaluate(`document.pictureInPictureEnabled === true`);
  await press("f", "KeyF", 70);
  await until(() => evaluate(`document.fullscreenElement?.dataset.mediaPlayer === "video"`), "f for full screen", 5).catch(() => {});
  const fullscreen = await evaluate(`document.fullscreenElement?.dataset.mediaPlayer === "video"`);
  await evaluate(`document.exitFullscreen?.().catch(() => {}); true`);
  await sleep(300);
  check("videoPlayer", poster.big && poster.frame && playing === true && Math.abs(seekedTo - duration * 0.75) < duration * 0.08
    && Math.abs(afterLeft - (seekedTo - 5)) < 0.6 && afterJ < 0.6 && (Math.abs(afterL - 10 - afterJ) < 0.6 || afterL >= duration - 0.6),
  { poster, playing, duration, seekedTo, afterLeft, afterJ, afterL });
  check("videoControls", mutedNow === true && Math.abs(volume - 0.9) < 0.02 && rate === 1.25 && (pipEnabled ? pipButton === true : true) && fullscreen === true,
    { mutedNow, volume, rate, pipButton, pipEnabled, fullscreen });

  // --- 17, 18. Audio and voice notes ---------------------------------------------------------------------------------
  const audioPlayer = `document.querySelector('[data-media-player="audio"]')`;
  const audio = `${audioPlayer}.querySelector("audio")`;
  await open("memo.wav");
  await until(() => evaluate(`${audioPlayer}?.dataset.waveform === "ready" && ${audio}.readyState >= 1`), "the memo's waveform", 30);
  const bars = await evaluate(`[...${audioPlayer}.querySelectorAll('[aria-hidden] > span')].map((bar) => parseFloat(bar.style.height))`) as number[];
  await clickAt(await evaluate(`(() => { const r = ${audioPlayer}.querySelector('input[aria-label="Seek"]').getBoundingClientRect(); return { x: r.x + r.width * 0.5, y: r.y + r.height / 2 }; })()`));
  await sleep(300);
  const audioAt = await evaluate(`${audio}.currentTime / ${audio}.duration`) as number;
  await click(`[data-media-player="audio"] button[aria-label^="Speed"]`);
  const audioRate = await evaluate(`${audio}.playbackRate`);
  const audioDownload = await evaluate(`${audioPlayer}.querySelector("a[download]")?.getAttribute("href")`);
  await click(`[data-media-player="audio"] button[aria-label^="Play"]`);
  await until(() => evaluate(`!${audio}.paused`), "the memo to play", 10);
  await sleep(600);
  await click(`[data-media-player="audio"] button[aria-label^="Pause"]`);
  const leftAt = await evaluate(`${audio}.currentTime`) as number;
  await shot("player-audio-light.png");
  // Away by a link and back: it carries on where it was left.
  await click('a[href="/library"]');
  await waitFor(`location.pathname === "/library" && document.querySelector('ul[aria-label="Library"], [data-view="gallery"]')`, "the Library again");
  await evaluate(`history.back(); true`);
  await until(() => evaluate(`location.pathname.startsWith("/library/") && ${audio}?.readyState >= 1`), "the memo again", 15);
  await sleep(500);
  const resumedAt = await evaluate(`${audio}.currentTime`) as number;
  check("audioPlayer", bars.length > 20 && Math.max(...bars) - Math.min(...bars) > 30 && Math.abs(audioAt - 0.5) < 0.08 && audioRate === 1.5 && String(audioDownload).endsWith("?download=1")
    && Math.abs(resumedAt - leftAt) < 0.3 && leftAt > 0.5, { bars: bars.length, spread: Math.max(...bars) - Math.min(...bars), audioAt, audioRate, leftAt, resumedAt });

  // Voice notes in the chats they came in: the player, with a waveform, and only one plays at a time.
  for (const theme of ["light", "dark"] as const) {
    await scheme(theme);
    await go(`/chat/${tgChat}`, `document.querySelectorAll('[data-media-player="audio"]').length >= 1`, "the Telegram chat's voice note");
    await until(() => evaluate(`[...document.querySelectorAll('[data-media-player="audio"]')].every((player) => player.dataset.waveform === "ready")`), "its waveform", 30);
    await shot(`chat-voice-telegram-${theme}.png`);
    await collect(`telegram chat (${theme})`);
  }
  await scheme("light");
  const tgVoice = await evaluate(`[...document.querySelectorAll('[data-media-player="audio"]')].map((player) => player.getAttribute("aria-label"))`) as string[];
  await go(`/chat/${waChat}`, `document.querySelectorAll('[data-media-player="audio"]').length >= 1`, "the WhatsApp chat's voice note");
  await until(() => evaluate(`[...document.querySelectorAll('[data-media-player="audio"]')].every((player) => player.dataset.waveform === "ready")`), "its waveform", 30);
  const waVoice = await evaluate(`[...document.querySelectorAll('[data-media-player="audio"]')].map((player) => player.getAttribute("aria-label"))`) as string[];
  await shot("chat-voice-whatsapp-light.png");
  check("voiceNotesGetThePlayer", tgVoice.some((label) => /voice-note/.test(label)) && waVoice.some((label) => /voice-note/.test(label)), { tgVoice, waVoice });
  // One at a time: the project chat has a voice memo and a video.
  await go(`/chat/${inProject}`, `document.querySelector('[data-media-player="audio"]') && document.querySelector('[data-media-player="video"]')`, "the project chat's media");
  await click(`[data-media-player="audio"] button[aria-label^="Play"]`);
  await until(() => evaluate(`!document.querySelector('[data-media-player="audio"] audio').paused`), "the memo to play in the chat", 10);
  await click(`[data-media-player="video"] [data-big-play]`);
  await until(() => evaluate(`!document.querySelector('[data-media-player="video"] video').paused`), "the video to play in the chat", 10);
  await sleep(300);
  const oneAtATime = await evaluate(`document.querySelector('[data-media-player="audio"] audio').paused && !document.querySelector('[data-media-player="video"] video').paused`);
  await evaluate(`document.querySelector('[data-media-player="video"] video').pause(); true`);
  check("onlyOnePlays", oneAtATime === true);
  await shot("chat-media-light.png");

  // A phone's width.
  await size(375, 812);
  await go("/library", `document.querySelector('[data-view="gallery"] li, ul[aria-label="Library"] li')`, "the Library on a phone");
  const overflow = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) as number;
  await shot("phone-library-light.png");
  await open("walkthrough.webm");
  const phoneOverflow = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) as number;
  await shot("phone-item-video-light.png");
  await scheme("dark");
  await go(`/chat/${tgChat}`, `document.querySelector('[data-media-player="audio"]')`, "the voice note on a phone");
  await sleep(800);
  const chatOverflow = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) as number;
  await shot("phone-chat-voice-dark.png");
  await collect("phone");
  await scheme("light");
  await size(1280, 800);
  check("fitsAPhone", overflow <= 0 && phoneOverflow <= 0 && chatOverflow <= 0, { overflow, phoneOverflow, chatOverflow });

  // === 12. Deleting =================================================================================================
  // The web upload, from its page: asked first, then the file is gone and the chat says so.
  const receiptItem = await open("receipt-october.png");
  await clickText("button", "Delete");
  await waitFor(`document.querySelector('[role="alertdialog"]')`, "the question");
  const question = await evaluate(`document.querySelector('[role="alertdialog"]').innerText`) as string;
  await shot("delete-confirm-light.png");
  const stillThere = existsSync(receipt.localPath) && Boolean(library().find((row) => row._id === receiptItem.id));
  await clickText('[role="alertdialog"] button', "Delete");
  await waitFor(`location.pathname === "/library"`, "back to the Library");
  await until(() => !library().some((row) => row._id === receiptItem.id), "the item to go", 10);
  const receiptRow = rows("chatAttachments").find((row) => row.fileName === "receipt-october.png")!;
  await go(`/chat/${webChat}`, `document.querySelector("[data-removed]")`, "the chat to say it was removed");
  const removedText = await evaluate(`document.querySelector("[data-removed]").innerText`) as string;
  await shot("chat-removed-light.png");
  const servedAfter = await served(`/api/media/${receiptRow._id}`);
  const turnFiles = await call<unknown[]>("media:forTurn", { conversationId: webChat, attachmentIds: [receiptRow._id] });
  check("deleteAsksThenDeletes", stillThere && /Delete receipt-october\.png\?/.test(question) && !existsSync(receipt.localPath) && receiptRow.removedAt && !receiptRow.localPath
    && /receipt-october\.png/.test(removedText) && /removed/.test(removedText) && servedAfter.status === 404 && turnFiles.length === 0,
  { question, removedText, served: servedAfter.status, forTurn: turnFiles.length });
  // A stored Telegram photo, from the API: its stored file is gone too, and the Telegram chat says so.
  const tgPhoto = library().find((row) => row.name === "photo.jpg" && row.from === "telegram")!;
  const storedFile = join(HOME, "storage", tgPhoto.storageId);
  const storedBefore = existsSync(storedFile);
  await call("library:remove", { key: KEY, id: tgPhoto._id });
  const tgMessages = await call<{ page: Array<{ attachments: Array<{ fileName: string; removed?: boolean }> }> }>("dashboard:getChatMessages", { key: KEY, id: tgChat, paginationOpts: { numItems: 30, cursor: null } });
  check("deleteStoredFile", storedBefore && !existsSync(storedFile) && !library().some((row) => row._id === tgPhoto._id)
    && tgMessages.page.some((message) => message.attachments.some((file) => file.fileName === "photo.jpg" && file.removed)) && sql(`SELECT id FROM _storage WHERE id = ?`, [tgPhoto.storageId]).length === 0);
  // A file outside Perry's folders leaves the Library and stays on the owner's disk.
  const warranty = library().find((row) => row.localPath === keep)!;
  const kept = await call<{ kept?: string }>("library:remove", { key: KEY, id: warranty._id });
  check("deleteOutsideKeepsTheFile", existsSync(keep) && !library().some((row) => row._id === warranty._id) && kept.kept === keep);

  // === 13. Deleting chats ============================================================================================
  const branchSource = await call<string>("dashboard:createChat", { key: KEY });
  await onGrok(branchSource);
  const kept1 = await upload(branchSource, "msg-branch", "floor-plan.png", png(90, 60, [100, 200, 100]), "image/png");
  await call("dashboard:sendChat", { key: KEY, id: branchSource, text: "the floor plan", attachmentIds: [kept1.id], messageKey: "msg-branch" });
  await until(async () => !(await p.getChat(branchSource)).isRunning && p.turnsOf(branchSource).every((turn) => turn.finalizedAt), "the floor plan's reply", 120);
  const first = (await call<{ page: Array<{ id: string; role: string }> }>("dashboard:getChatMessages", { key: KEY, id: branchSource, paginationOpts: { numItems: 10, cursor: null } })).page.find((message) => message.role === "user")!;
  const branch = await call<string>("dashboard:branchChat", { key: KEY, id: branchSource, messageId: first.id });
  const floor = () => itemAt(kept1.path);
  await call("dashboard:deleteChat", { key: KEY, id: branchSource });
  const afterSource = floor();
  await call("dashboard:deleteChat", { key: KEY, id: branch });
  const afterBranch = floor();
  const floorListed = (await listed({ query: "floor" }))[0];
  check("deletingChatsKeepsTheLibraryConsistent", Boolean(afterSource?.conversationId === branch && existsSync(kept1.path) && afterBranch && !afterBranch.conversationId
    && floorListed?.source.label === "Chat deleted" && !floorListed.source.href),
  { afterSource: afterSource?.conversationId === branch, afterBranch: afterBranch && { chat: afterBranch.conversationId ?? null }, label: floorListed?.source.label });

  // === 8. A file deleted outside Perry leaves; a new one in his folder arrives ========================================
  rmSync(loose, { force: true });
  const fresh = write(join(FILES, "exports", "summary.txt"), "Summary.\n");
  await call("library:sync", {});
  check("folderKeptInStep", !itemAt(loose) && itemAt(fresh)?.from === "folder" && !library().some((row) => row.localPath?.includes(".cache")));

  // === 11. No page errors ============================================================================================
  await collect("end");
  const errors = [...pageErrors, ...browser.errors.map((error) => ({ page: "exception", error }))];
  notes.pageErrors = errors.slice(0, 20);
  check("noPageErrors", errors.length === 0, errors.slice(0, 10));
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 2000);
  check("completed", false);
} finally {
  tgServer.close();
  waControl.close();
  try { rmSync(OUTSIDE, { recursive: true, force: true }); } catch {}
}

function checks() { return p.checks; }
const passed = await p.finish({ issue: [216, 217] });
process.exit(passed ? 0 : 1);
