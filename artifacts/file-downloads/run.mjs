import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateRawSync } from "node:zlib";
import { openChat, sleep } from "../browser.ts";

if (!process.argv[2]) throw Error("Pass a disposable output directory");
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-file-downloads-"));
const key = "synthetic-file-download-owner";
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "9a".repeat(32);
const report = { build: readFileSync(".next/BUILD_ID", "utf8").trim(), checks: {}, downloads: [], modelTurnsStarted: 0, homeRemoved: false };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
const check = (name, ok) => { report.checks[name] = Boolean(ok); save(); console.log(JSON.stringify({ name, passed: Boolean(ok) })); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const until = async (predicate, label, timeout = 20000) => { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() >= end) throw Error(`Timed out: ${label}`); await sleep(80); } };
const dispositionName = response => { const value = response.headers.get("content-disposition")?.match(/filename\*=UTF-8''(.*)$/i)?.[1]; return value ? decodeURIComponent(value) : null; };
save();

function zip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data), packed = deflateRawSync(raw), fileName = Buffer.from(name);
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(fileName.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(fileName.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(header, fileName, packed); central.push(entry, fileName); offset += header.length + fileName.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function pdf() {
  const stream = "BT /F1 18 Tf 72 700 Td (Synthetic download verification) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = "%PDF-1.4\n"; const offsets = objects.map((object, index) => { const at = Buffer.byteLength(text); text += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(text); text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const sheet = zip({
  "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Synthetic budget</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
});
const doc = zip({
  "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic document</w:t></w:r></w:p></w:body></w:document>',
});
const noise = Buffer.concat(Array.from({ length: 4096 }, (_, i) => createHash("sha256").update(String(i)).digest()));
const samples = [
  { name: "Résumé's budget (final).pdf", type: "application/pdf", bytes: pdf() },
  { name: "Budget – 2026.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: sheet },
  { name: "Owner's report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: doc },
  { name: "Archive – résumé.zip", type: "application/zip", bytes: zip({ "binary.dat": noise }) },
];
let runtime, database, server, site, browser, browserCall, chat;
try {
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts")]);
  database = new DatabaseSync(join(home, "perry.sqlite")); initializeCredentialEncryption(database, home);
  runtime = new Runtime(database, schema, modules, { storageDir: join(home, "storage") }); await runtime.stop();
  runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", claimedAt: Date.now(), createdAt: Date.now() });
  const call = async (path, args) => (await runtime.call(path, args, { internal: true })).value;
  chat = await call("dashboard:createChat", { key }); const threadId = runtime.store.get(chat).threadId;
  for (const sample of samples) sample.storageId = await runtime.storeFile(new Blob([sample.bytes], { type: sample.type }));
  mkdirSync(join(home, "files"), { recursive: true }); mkdirSync(join(home, "fixture-inputs"), { recursive: true });
  const local = join(home, "fixture-inputs", "physical.xlsx"); writeFileSync(local, sheet);
  const changedOriginal = join(home, "fixture-inputs", "changed-original.xlsx"); writeFileSync(changedOriginal, "This original changed after its snapshot was stored.");
  const snapshotId = runtime.store.insert("library", { name: "Stored snapshot", contentType: samples[1].type, kind: "document", size: sheet.length, storageId: samples[1].storageId, originPath: changedOriginal, by: "perry", how: "shared", from: "web", conversationId: chat, search: "stored snapshot", createdAt: Date.now() });
  runtime.store.insert("workspaceFiles", { conversationId: chat, sourceConversationId: chat, libraryId: snapshotId, kind: "document", role: "output", provenance: "produced", createdAt: Date.now() });
  const legacyPath = join(home, "files", "7bbcbfe5-2300-4822-aac4-6b32175c2e1b");
  writeFileSync(legacyPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV3sAAAAASUVORK5CYII=", "base64"));
  const legacyId = runtime.store.insert("library", { name: "legacy-browser-image.png", contentType: "application/octet-stream", kind: "other", size: readFileSync(legacyPath).length, localPath: legacyPath, by: "perry", how: "added", from: "web", conversationId: chat, search: "legacy-browser-image.png", createdAt: Date.now() });
  runtime.store.insert("workspaceFiles", { conversationId: chat, sourceConversationId: chat, libraryId: legacyId, kind: "other", role: "output", provenance: "produced", createdAt: Date.now() });
  const unknownPath = join(home, "files", "unknown.constructor"); writeFileSync(unknownPath, "Synthetic unknown-format bytes");
  runtime.store.insert("library", { name: "legacy.constructor", contentType: "application/octet-stream", kind: "other", size: 30, localPath: unknownPath, by: "perry", how: "added", from: "web", conversationId: chat, search: "legacy.constructor", createdAt: Date.now() });
  const missing = runtime.store.insert("chatAttachments", { conversationId: chat, messageKey: "synthetic-missing", localPath: join(home, "missing.pdf"), fileName: "missing.pdf", contentType: "application/pdf", size: 1, createdAt: Date.now() });
  const removed = runtime.store.insert("chatAttachments", { conversationId: chat, messageKey: "synthetic-removed", storageId: samples[0].storageId, fileName: "removed.pdf", contentType: "application/pdf", size: samples[0].bytes.length, removedAt: Date.now(), createdAt: Date.now() });
  const remoteRunner = runtime.store.insert("runners", { name: "Synthetic other runner", token: "synthetic-other-runner", createdAt: Date.now(), lastSeenAt: Date.now() });
  const remote = runtime.store.insert("chatAttachments", { conversationId: chat, messageKey: "synthetic-other-runner", originRunnerId: remoteRunner, localPath: local, fileName: "other-runner.xlsx", contentType: samples[1].type, size: sheet.length, createdAt: Date.now() });
  await runtime.stop(); database.close(); runtime = null; database = null;

  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PERRY_PORT: String(port), PERRY_BROWSER_HEADED: "0", TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", GROQ_API_KEY: "", GEMINI_API_KEY: "", PERRY_WAKE_DISABLED: "1" } });
  let log = ""; for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-16000); writeFileSync(join(output, "server.log"), log); });
  await until(async () => { if (server.exitCode !== null) throw Error(`Production server exited: ${log}`); return fetch(base).then(r => r.ok, () => false); }, "production server");
  const admin = async (path, args) => { const r = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args }), signal: AbortSignal.timeout(20000) }); const b = await r.json(); if (!r.ok || b.error) throw Error(`${path}: ${b.error ?? r.status}`); return b.value; };
  for (const sample of samples) sample.id = await admin("dashboard:registerAttachment", { key, conversationId: chat, messageKey: "synthetic-downloads", storageId: sample.storageId, fileName: sample.name, contentType: sample.type, size: sample.bytes.length });
  await admin("agentStore:saveMessages", { threadId, messages: [{ role: "user", content: "Synthetic download samples\n<!-- attachments:synthetic-downloads -->" }] });
  const labelledId = await admin("library:add", { path: local, name: "Quarterly report", by: "owner", how: "added", conversationId: chat });
  const scriptBytes = Buffer.from('print("Synthetic download fixture")\n'), scriptPath = join(home, "files", "helper.py"); writeFileSync(scriptPath, scriptBytes);
  const scriptId = await admin("library:add", { path: scriptPath, name: "Utility script", by: "owner", how: "added", conversationId: chat });
  const legacy = await admin("library:get", { key, id: legacyId });
  check("cold startup repairs legacy browser MIME and kind", legacy.contentType === "image/png" && legacy.kind === "image");
  const images = await admin("workspace:files", { key, conversationId: chat, scope: "chat", working: false, hidden: false, kind: "image", paginationOpts: { numItems: 40, cursor: null } });
  check("legacy browser image appears in the workspace Images filter", images.page.some(item => item.id === legacyId));
  const newUnknownPath = join(home, "files", "new.constructor"); writeFileSync(newUnknownPath, "Synthetic unknown-format bytes");
  let unknown; try { unknown = await admin("library:add", { path: newUnknownPath, name: "Unknown format", by: "owner", how: "added", conversationId: chat }); } catch {}
  const unknownItem = unknown ? await admin("library:get", { key, id: unknown }) : null;
  check("unknown inherited-property suffix stays binary without crashing registration or backfill", unknownItem?.contentType === "application/octet-stream");
  const longPath = join(home, "files", "9e101702-24d7-420b-af12-d6a3a5e36f7e"); writeFileSync(longPath, samples[0].bytes);
  const longId = await admin("library:add", { path: longPath, name: `A${"🙂".repeat(120)}.pdf`, by: "perry", how: "added", conversationId: chat });
  const longItem = await admin("library:get", { key, id: longId });
  check("long browser names retain PDF suffix and complete Unicode code points", longItem.name.length <= 200 && longItem.name.endsWith(".pdf") && longItem.name === longItem.name.toWellFormed() && longItem.contentType === "application/pdf");
  const messages = await admin("dashboard:getChatMessages", { key, id: chat, paginationOpts: { numItems: 40, cursor: null } });
  const attachments = messages.page.flatMap(message => message.attachments ?? []);
  for (const sample of samples) sample.url = attachments.find(attachment => attachment.id === sample.id)?.url;
  check("dashboard resolves each stored attachment through its named media route", samples.every(sample => sample.url === `/api/media/${sample.id}`));
  const http = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { cookie: `perry_media=${key}`, ...options.headers }, signal: AbortSignal.timeout(20000) });
  const longResponse = await http(`/api/media/library/${longId}?download=1`);
  check("long Unicode browser names produce a valid downloadable PDF response", longResponse.ok && dispositionName(longResponse)?.endsWith(".pdf") && hash(Buffer.from(await longResponse.arrayBuffer())) === hash(samples[0].bytes));
  for (const sample of samples) {
    const response = await http(sample.url + "?download=1"), bytes = Buffer.from(await response.arrayBuffer());
    check(`${sample.name}: HTTP preserves original name`, dispositionName(response) === sample.name);
    check(`${sample.name}: HTTP preserves exact bytes`, response.ok && hash(bytes) === hash(sample.bytes));
    if (sample.name.includes("'")) check(`${sample.name}: RFC 5987 punctuation is encoded`, response.headers.get("content-disposition")?.includes("%27") && (!sample.name.includes("(") || (response.headers.get("content-disposition").includes("%28") && response.headers.get("content-disposition").includes("%29"))));
  }
  const preview = await http(samples[0].url + "?preview=1");
  check("stored PDF preview is inline PDF with the original filename", preview.headers.get("content-type") === "application/pdf" && preview.headers.get("content-disposition")?.startsWith("inline;") && dispositionName(preview) === samples[0].name); await preview.arrayBuffer();
  const namedUrl = `/api/media/library/${labelledId}?download=1`, named = await http(namedUrl);
  check("Library descriptive labels retain the physical format suffix", dispositionName(named) === "Quarterly report.xlsx" && hash(Buffer.from(await named.arrayBuffer())) === hash(sheet));
  const workspaceUrl = `/api/media/workspace/${labelledId}?conversation=${chat}&scope=chat&download=1`, workspace = await http(workspaceUrl);
  check("workspace downloads retain descriptive labels and format suffix", dispositionName(workspace) === "Quarterly report.xlsx" && hash(Buffer.from(await workspace.arrayBuffer())) === hash(sheet));
  const snapshotUrl = `/api/media/library/${snapshotId}?download=1`, snapshot = await http(snapshotUrl);
  check("stored Library labels use the origin suffix while serving immutable snapshot bytes", dispositionName(snapshot) === "Stored snapshot.xlsx" && hash(Buffer.from(await snapshot.arrayBuffer())) === hash(sheet));
  const snapshotWorkspace = await http(`/api/media/workspace/${snapshotId}?conversation=${chat}&scope=chat&download=1`);
  check("stored workspace labels use the origin suffix without reading changed originals", dispositionName(snapshotWorkspace) === "Stored snapshot.xlsx" && hash(Buffer.from(await snapshotWorkspace.arrayBuffer())) === hash(sheet));
  const scriptUrl = `/api/media/library/${scriptId}?download=1`, script = await http(scriptUrl);
  check("unknown MIME types still retain their physical file extension", dispositionName(script) === "Utility script.py" && hash(Buffer.from(await script.arrayBuffer())) === hash(scriptBytes));
  const head = await http(samples[0].url + "?download=1", { method: "HEAD", headers: { "accept-encoding": "identity" } });
  const headLength = head.headers.get("content-length"), headBytes = (await head.arrayBuffer()).byteLength;
  report.head = { status: head.status, name: dispositionName(head), contentLength: headLength, bodyBytes: headBytes };
  check("HEAD retains filename and any declared size without a response body", head.ok && dispositionName(head) === samples[0].name && (headLength === null || Number(headLength) === samples[0].bytes.length) && headBytes === 0);
  const range = await http(samples[0].url + "?download=1", { headers: { range: "bytes=0-15" } });
  check("range downloads preserve filename and exact partial bytes", range.status === 206 && dispositionName(range) === samples[0].name && Buffer.from(await range.arrayBuffer()).equals(samples[0].bytes.subarray(0, 16)));
  check("an out-of-bounds range is refused", (await http(samples[0].url, { headers: { range: "bytes=9999999-" } })).status === 416);
  check("missing authentication cannot download named attachments", (await fetch(`${base}/api/media/${samples[0].id}`)).status === 401);
  check("wrong owner authentication cannot download named attachments", (await fetch(`${base}/api/media/${samples[0].id}`, { headers: { cookie: "perry_media=synthetic-wrong-owner" } })).status === 403);
  for (const [label, id] of [["missing local file", missing], ["removed attachment", removed], ["other-runner local attachment", remote], ["unregistered attachment", "unregistered-synthetic-file"]]) check(`${label} cannot be downloaded`, (await http(`/api/media/${id}`)).status === 404);
  const html = join(home, "files", "active.html"); writeFileSync(html, "<script>throw Error('must never execute')</script>");
  const htmlId = await admin("library:add", { path: html, by: "owner", how: "added", conversationId: chat }); const htmlResponse = await http(`/api/media/library/${htmlId}?preview=1`);
  check("active HTML remains an attachment with nosniff", htmlResponse.headers.get("content-disposition")?.startsWith("attachment;") && htmlResponse.headers.get("x-content-type-options") === "nosniff"); await htmlResponse.arrayBuffer();

  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(base, key);
  await browser.send("Network.setCookie", { name: "perry_media", value: key, url: base, path: "/api/media" });
  const downloadDir = join(output, "downloads"); mkdirSync(downloadDir, { recursive: true });
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  const download = async (label, url, expectedName, bytes, activate) => {
    const before = new Set(readdirSync(downloadDir));
    await (activate ? activate() : browser.evaluate(`(() => { const a=document.createElement('a');a.href=${JSON.stringify(new URL(url, base).href)};a.download='';document.body.append(a);a.click();a.remove(); })()`));
    let file; await until(() => { file = readdirSync(downloadDir).find(name => { if (before.has(name) || name.endsWith(".crdownload")) return false; try { return hash(readFileSync(join(downloadDir, name))) === hash(bytes); } catch { return false; } }); return Boolean(file); }, label + " native byte-identical download");
    const actual = readFileSync(join(downloadDir, file)); report.downloads.push({ label, name: file, expectedName, bytes: actual.length, sha256: hash(actual), expectedSha256: hash(bytes) });
    check(label + ": Chrome saves the original filename", file === expectedName);
    check(label + ": Chrome saves byte-identical original content", hash(actual) === hash(bytes));
  };
  await browser.send("Page.navigate", { url: `${base}/chat/${chat}` });
  await until(() => browser.evaluate(`Array.from(document.querySelectorAll('button')).some(el=>el.textContent.trim()===${JSON.stringify(samples[0].name)})`), "chat attachment card");
  await browser.evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(samples[0].name)}).click()`);
  await until(() => browser.evaluate("Boolean(document.querySelector('[role=dialog] a[download]'))"), "attachment Download link");
  await sleep(300);
  const screenshot = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(output, "stored-pdf-preview.png"), Buffer.from(screenshot.data, "base64"));
  await download("dashboard PDF Download control", samples[0].url, samples[0].name, samples[0].bytes, () => browser.evaluate("document.querySelector('[role=dialog] a[download]').click()"));
  for (const sample of samples.slice(1)) await download("stored " + sample.name, sample.url + "?download=1", sample.name, sample.bytes);
  await download("labelled Library spreadsheet", namedUrl, "Quarterly report.xlsx", sheet);
  await download("labelled stored snapshot", snapshotUrl, "Stored snapshot.xlsx", sheet);
  await download("labelled source file with unknown MIME", scriptUrl, "Utility script.py", scriptBytes);

  site = createServer((request, response) => { if (request.url === "/document") { response.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=browser-report.pdf" }); response.end(samples[0].bytes); } else { response.setHeader("content-type", "text/html"); response.end('<a style="display:block;width:200px;height:50px" href="/document">Download local PDF</a>'); } });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  browserCall = async request => { const r = await fetch(`${base}/api/browser`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key, origin: base }, body: JSON.stringify({ conversationId: chat, request }), signal: AbortSignal.timeout(20000) }); const b = await r.json(); if (!r.ok) throw Error(b.error ?? r.status); return b; };
  let state = await browserCall({ action: "start", nativeWindow: false }); state = await browserCall({ action: "navigate", identity: state.identity, url: `http://127.0.0.1:${site.address().port}/` });
  await browserCall({ action: "click", identity: state.identity, x: 80, y: 25 });
  let browserItem; await until(async () => { browserItem = (await admin("library:list", { key, query: "browser-report.pdf" })).items.find(item => item.name === "browser-report.pdf"); return Boolean(browserItem); }, "Perry browser download registration");
  const detail = await admin("library:get", { key, id: browserItem.id });
  check("Perry browser GUID download retains PDF MIME and preview", detail.contentType === "application/pdf" && detail.preview === "pdf" && !basename(detail.path).includes("."));
  const browserPreview = await http(`/api/media/library/${browserItem.id}?preview=1`);
  check("Perry browser PDF has an inline byte-identical preview", browserPreview.headers.get("content-type") === "application/pdf" && hash(Buffer.from(await browserPreview.arrayBuffer())) === hash(samples[0].bytes));
  await download("Perry browser Library PDF", `/api/media/library/${browserItem.id}?download=1`, "browser-report.pdf", samples[0].bytes);
  check("dashboard has no uncaught browser exceptions", browser.errors.length === 0);
  const saved = new DatabaseSync(join(home, "perry.sqlite"), { readOnly: true }); try { check("no model turns were created", saved.prepare("SELECT count(*) AS count FROM doc_codexTurns").get().count === 0); } finally { saved.close(); }
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  if (browserCall) { try { await browserCall({ action: "takeover" }); const state = await browserCall({ action: "status" }); if (state.identity) await browserCall({ action: "close", identity: state.identity }); } catch (error) { report.browserCloseError = String(error); } }
  browser?.close();
  if (server?.pid && server.exitCode === null) { if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else server.kill(); }
  await runtime?.stop(); database?.close();
  if (site) { site.closeAllConnections(); if (site.listening) await new Promise(resolve => site.close(resolve)); }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (error) { report.cleanupError = String(error); }
  report.homeRemoved = !existsSync(home); report.passed = !report.error && !report.cleanupError && !report.browserCloseError && report.homeRemoved && Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean);
  save(); console.log(JSON.stringify({ passed: report.passed, checks: Object.keys(report.checks).length, failed: Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name), error: report.error, homeRemoved: report.homeRemoved }));
  if (!report.passed) process.exitCode = 1;
}
