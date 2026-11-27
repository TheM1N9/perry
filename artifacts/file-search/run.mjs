import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { openChat, sleep } from "../browser.ts";

if (!process.argv[2]) throw Error("Pass a disposable output directory");
const output = resolve(process.argv[2]); mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-file-search-")), key = "synthetic-file-search-owner";
process.env.PERRY_HOME = home; process.env.DASHBOARD_KEY = key; process.env.PERRY_CREDENTIAL_KEY = "9b".repeat(32);
const report = { build: readFileSync(".next/BUILD_ID", "utf8").trim(), checks: {}, modelTurnsStarted: 0, homeRemoved: false };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
const check = (name, passed) => { report.checks[name] = Boolean(passed); save(); assert.equal(Boolean(passed), true, name); };
const until = async (predicate, label, timeout = 20000) => { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await sleep(60); } };
save();
let runtime, database, server, browser;
try {
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts")]);
  database = new DatabaseSync(join(home, "perry.sqlite")); initializeCredentialEncryption(database, home);
  runtime = new Runtime(database, schema, modules, { storageDir: join(home, "storage") }); await runtime.stop();
  runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", claimedAt: Date.now(), createdAt: Date.now() });
  const call = async (path, args) => (await runtime.call(path, args, { internal: true })).value;
  const now = Date.now(), project = runtime.store.insert("projects", { name: "Search project", instructions: "Synthetic fixture", createdAt: now, updatedAt: now });
  const chat = await call("dashboard:createChat", { key }), peer = await call("dashboard:createChat", { key }), outside = await call("dashboard:createChat", { key }), contactChat = await call("dashboard:createChat", { key });
  runtime.store.patch(chat, { title: "Search fixture", projectId: project }); runtime.store.patch(peer, { title: "Search peer", projectId: project });
  const contact = runtime.store.insert("contacts", { channel: "whatsapp", externalId: "synthetic-file-search-contact", kind: "person", name: "Synthetic contact", status: "blocked", createdAt: now, updatedAt: now });
  runtime.store.patch(contactChat, { contactId: contact, projectId: project });
  mkdirSync(join(home, "fixture-inputs"), { recursive: true });
  let counter = 0;
  const add = (name, options = {}) => {
    const number = counter++, source = options.chat ?? chat, kind = options.kind ?? "document", path = join(home, "fixture-inputs", `file-${number}.${kind === "image" ? "png" : "txt"}`);
    const body = kind === "image" ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV3sAAAAASUVORK5CYII=", "base64") : Buffer.from(`Synthetic file search content: ${name}`);
    writeFileSync(path, body);
    const id = runtime.store.insert("library", { name, localPath: path, contentType: kind === "image" ? "image/png" : "text/plain", kind, size: body.length, by: "perry", how: "added", from: "web", conversationId: source, search: name.toLowerCase(), createdAt: now + number });
    runtime.store.insert("workspaceFiles", { conversationId: source, sourceConversationId: source, ...(source !== outside ? { projectId: project } : {}), libraryId: id, kind, role: options.role ?? "output", provenance: "produced", createdAt: now + number });
    if (options.hidden) runtime.store.insert("workspaceViews", { scope: `chat:${chat}`, libraryId: id, pinned: false, hidden: true });
    return id;
  };
  for (let i = 0; i < 60; i++) add(`filler-${String(i).padStart(3, "0")}.txt`);
  const matches = Array.from({ length: 70 }, (_, i) => add(`Quarterly budget match ${String(i).padStart(2, "0")}.txt`));
  const target = add("Résumé Budget final.txt"), image = add("Quarterly budget chart.png", { kind: "image" });
  const working = add("Draft workspace memo.txt", { role: "working" });
  const labelled = add("Quarterly statement");
  const hidden = add("Quarterly budget hidden.txt", { hidden: true });
  const projectOnly = add("Project budget peer.txt", { chat: peer }); add("Quarterly budget outside.txt", { chat: outside }); add("Quarterly budget contact.txt", { chat: contactChat });
  const originalRealpath = fs.realpathSync;
  let pathReads = 0;
  fs.realpathSync = (...args) => { if (String(args[0]).startsWith(home)) pathReads++; return originalRealpath(...args); };
  syncBuiltinESMExports();
  try {
    const args = { key, conversationId: chat, scope: "project", working: true, hidden: false, paginationOpts: { numItems: 50, cursor: null } };
    await call("workspace:files", { ...args, query: "this name cannot match a fixture file" });
    check("nonmatching names cause no native realpath reads", pathReads === 0);
    pathReads = 0;
    await call("workspace:files", { ...args, query: "contact" });
    check("rejected contact sources cause no native realpath reads", pathReads === 0);
  } finally { fs.realpathSync = originalRealpath; syncBuiltinESMExports(); }
  const originalRows = runtime.store.rows;
  let membershipReads = 0;
  runtime.store.rows = function* (sql, params) { for (const row of originalRows.call(this, sql, params)) { if (sql.includes("doc_workspaceFiles")) membershipReads++; yield row; } };
  try {
    const absent = await call("workspace:files", { key, conversationId: chat, scope: "chat", working: false, hidden: false, query: "no matching filename", paginationOpts: { numItems: 50, cursor: null } });
    report.pagination = { decodedMembershipRows: membershipReads, totalSeededMemberships: counter };
    check("sparse search with working files excluded hydrates membership only once per batch", !absent.page.length && absent.isDone && membershipReads > 0 && membershipReads <= counter + 10);
  } finally { runtime.store.rows = originalRows; }
  await runtime.stop(); database.close(); runtime = null; database = null;
  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PERRY_PORT: String(port), TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", GROQ_API_KEY: "", GEMINI_API_KEY: "", PERRY_WAKE_DISABLED: "1" } });
  let log = ""; for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-16000); writeFileSync(join(output, "server.log"), log); });
  await until(async () => { if (server.exitCode !== null) throw Error(`Production server exited: ${log}`); return fetch(base).then(r => r.ok, () => false); }, "production server");
  const admin = async (path, args) => { const r = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args }), signal: AbortSignal.timeout(20000) }); const b = await r.json(); if (!r.ok || b.error) throw Error(`${path}: ${b.error ?? r.status}`); return b.value; };
  const files = (query, options = {}) => admin("workspace:files", { key, conversationId: chat, scope: "chat", working: true, hidden: false, paginationOpts: { numItems: 50, cursor: null }, query, ...options });
  const first = await files(""); check("unfiltered first page remains bounded and excludes a later target", first.page.length === 50 && !first.isDone && !first.page.some(file => file.id === target));
  const found = await files(" BUDGET final "); check("search finds a case-insensitive multiword name beyond the first page", found.page.length === 1 && found.page[0].id === target && found.isDone);
  check("a descriptive label can be searched by its actual download suffix", (await files("quarterly statement .txt")).page[0]?.id === labelled);
  const paged = []; let cursor = null, pages = 0;
  do { const page = await files("quarterly budget", { paginationOpts: { numItems: 17, cursor } }); paged.push(...page.page.map(file => file.id)); pages++; if (page.isDone) break; if (page.continueCursor === cursor || pages > 20) throw Error("Search pagination did not advance"); cursor = page.continueCursor; } while (true);
  check("matching pages contain every scoped result once across membership pages", pages > 1 && paged.length === matches.length + 1 && new Set(paged).size === paged.length && [...matches, image].every(id => paged.includes(id)));
  check("file type applies to search results", (await files("quarterly budget", { kind: "image" })).page.map(file => file.id).join() === image);
  check("hidden results stay hidden until requested", !(await files("budget hidden")).page.length && (await files("budget hidden", { hidden: true })).page[0]?.id === hidden);
  check("working-file controls apply to search", !(await files("draft memo", { working: false })).page.length && (await files("draft memo")).page[0]?.id === working);
  check("chat search does not include another chat in the same project", !(await files("project budget peer")).page.length);
  check("project search includes the selected project's peer chat", (await files("project budget peer", { scope: "project" })).page[0]?.id === projectOnly);
  check("project search excludes unrelated and contact sources", !(await files("outside", { scope: "project" })).page.length && !(await files("contact", { scope: "project" })).page.length);
  let denied = false; try { await files("budget", { conversationId: contactChat }); } catch { denied = true; } check("contact workspaces cannot be searched", denied);
  process.env.PERRY_E2E_BROWSER ??= process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome";
  browser = await openChat(base, key); await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await browser.evaluate(`localStorage.setItem('perry.panel',JSON.stringify({[${JSON.stringify(chat)}]:{at:Date.now(),value:{open:true,tabs:['files'],active:'files',scope:'chat'}}}));localStorage.setItem('perry.files',JSON.stringify({[${JSON.stringify(`chat:${chat}`)}]:{at:Date.now(),value:{mode:'tree',expanded:{'Search fixture':false,'Working files':false}}}}));true`);
  await browser.send("Page.navigate", { url: `${base}/chat/${chat}` });
  const panel = "document.querySelector('[data-surface=files]')", input = `${panel}?.querySelector('input[type=search]')`;
  const pageUntil = (expression, label = expression) => until(async () => { try { return await browser.evaluate(`Boolean(${expression})`); } catch (error) { if (/navigated or closed|Execution context was destroyed|Cannot find context/.test(String(error))) return false; throw error; } }, label);
  const button = text => `Array.from(${panel}.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(text)})`;
  const named = name => `Array.from(${panel}.querySelectorAll('button')).find(el=>el.textContent.trim().startsWith(${JSON.stringify(name)}))`;
  const click = async expression => { await pageUntil(`(() => {const el=${expression};if(!el)return false;el.scrollIntoView({block:'nearest',behavior:'instant'});const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`, "reachable click target"); const p = await browser.evaluate(`(() => {const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); for (const type of ["mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, ...p, button: "left", clickCount: 1 }); };
  const type = async text => { await pageUntil(input); await browser.evaluate(`${input}.focus();${input}.select()`); await browser.send("Input.insertText", { text }); };
  const keyPress = async (key, code, windowsVirtualKeyCode) => { for (const type of ["keyDown", "keyUp"]) await browser.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode }); };
  const shot = async name => { const r = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(output, name), Buffer.from(r.data, "base64")); };
  await pageUntil(input); check("Files exposes a labelled native search field", await browser.evaluate(`${input}.getAttribute('aria-label')==='Search files'`));
  await type("budget final"); await pageUntil(named("Résumé Budget final.txt"));
  check("search opens matching groups collapsed before searching", await browser.evaluate(`(() => {const el=${named("Résumé Budget final.txt")};return el.getBoundingClientRect().height>0;})()`));
  check("unrelated Latest result shortcut does not appear during search", await browser.evaluate(`!${panel}.textContent.includes('Latest result:')`));
  await shot("files-search-desktop.png");
  await click(named("Résumé Budget final.txt")); await pageUntil(`${panel}?.querySelector('[data-file-text]')?.textContent.includes('Synthetic file search content')`);
  check("a searched result opens its actual file preview", true);
  await click(`${panel}.querySelector('[aria-label="All files"]')`); await pageUntil(`${input}?.value==='budget final'`); check("returning from preview preserves query and matching result", await browser.evaluate(`Boolean(${named("Résumé Budget final.txt")})`));
  await click(`${panel}.querySelector('[aria-label="Clear file search"]')`); await pageUntil(`${input}?.value===''&&${button("Next files")}`);
  check("clear resets search and keeps focus in the field", await browser.evaluate(`document.activeElement===${input}`));
  await click(button("Next files")); await pageUntil(button("Previous files")); await type("filler-000"); await pageUntil(named("filler-000.txt")); check("typing a new query resets a later-page cursor", true);
  await keyPress("Escape", "Escape", 27); await pageUntil(`${input}?.value===''`); check("Escape clears before closing Files", await browser.evaluate(`Boolean(${panel})`));
  await type("draft memo"); await pageUntil(named("Draft workspace memo.txt")); check("working matches are visible despite their saved collapsed group", await browser.evaluate(`(${named("Draft workspace memo.txt")}).getBoundingClientRect().height>0`));
  await type("quarterly statement .txt"); await pageUntil(named("Quarterly statement")); check("sidebar search finds a labelled file by source format", true);
  await type("nothing matches this filename"); await pageUntil(`${panel}.textContent.includes('No files match')`); check("empty search retains a useful clear action", await browser.evaluate(`Boolean(${panel}.querySelector('[aria-label="Clear file search"]'))`));
  await keyPress("Enter", "Enter", 13); check("Enter leaves the Files panel open", await browser.evaluate(`Boolean(${panel})`));
  await click(`${panel}.querySelector('[aria-label="Scope"]')`); await click("Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.trim()==='Search project')"); await pageUntil(`${input}?.value===''`);
  await type("project budget peer"); await pageUntil(named("Project budget peer.txt")); check("switching scope clears the previous query and searches the selected project", true);
  await click(`${panel}.querySelector('[aria-label="Scope"]')`); await click("Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.trim()==='This chat')"); await pageUntil(`${input}?.value===''`); await type("project budget peer"); await pageUntil(`${panel}.textContent.includes('No files match')`); check("switching back to chat excludes project-only results", true);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await pageUntil("document.querySelector('[data-chat-panel][data-panel-mode=sheet]')");
  await type("budget final"); await pageUntil(named("Résumé Budget final.txt"));
  check("phone search remains readable and fits the panel", await browser.evaluate(`(() => {const r=${input}.getBoundingClientRect();return parseFloat(getComputedStyle(${input}).fontSize)>=16&&r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;})()`));
  await shot("files-search-phone.png"); check("dashboard has no uncaught browser exceptions", browser.errors.length === 0);
  const saved = new DatabaseSync(join(home, "perry.sqlite"), { readOnly: true }); try { check("search and keyboard use create no model turn", saved.prepare("SELECT count(*) AS count FROM doc_codexTurns").get().count === 0); } finally { saved.close(); }
} catch (error) {
  report.error = String(error.stack ?? error);
  if (browser) { report.page = await browser.evaluate("document.body.innerText.slice(-4000)").catch(() => "unavailable"); try { const r = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(output, "failure.png"), Buffer.from(r.data, "base64")); } catch {} }
} finally {
  browser?.close();
  if (server?.pid && server.exitCode === null) { if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else { server.kill(); await new Promise(resolve => server.once("exit", resolve)); } }
  await runtime?.stop(); database?.close();
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (error) { report.cleanupError = String(error); }
  report.homeRemoved = !existsSync(home); report.passed = !report.error && !report.cleanupError && report.homeRemoved && Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean); save(); console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
}
