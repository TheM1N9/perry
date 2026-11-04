import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { openChat, sleep } from "../browser.ts";

const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "perry-meeting-ui-"));
const key = "synthetic-meeting-ui-owner";
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "cd".repeat(32);
const report = { checks: {} };
const save = () => writeFileSync(join(output, "ui.json"), JSON.stringify(report, null, 2));
let server;
let browser;
let runtime;
let database;
try {
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts")]);
  database = new DatabaseSync(join(scratch, "perry.sqlite"));
  initializeCredentialEncryption(database, scratch);
  runtime = new Runtime(database, schema, modules, { storageDir: join(scratch, "storage") });
  await runtime.stop();
  const call = async (path, args) => (await runtime.call(path, args, { internal: true })).value;
  await runtime.exclusive(() => runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now() }));
  const meeting = await call("meetings:start", { key, title: "Product planning" });
  await call("meetings:appendSegments", { key, id: meeting.id, segments: [{ seq: 0, source: "you", startMs: 0, endMs: 5000, text: "I will send the revised proposal on Friday." }, { seq: 1, source: "them", startMs: 5000, endMs: 10000, text: "The budget is five thousand dollars." }] });
  const note = (await call("meetings:get", { key, id: meeting.id })).noteId;
  const own = await call("notes:get", { key, id: note });
  await call("notes:save", { key, id: note, content: "## Decisions\n\nLaunch on Friday.\n\n## Next steps\n\nSend the revised proposal.", expectedRevision: own.revision });
  await runtime.exclusive(() => runtime.store.patch(meeting.id, { status: "done", endedAt: Date.now(), typed: "Confirm the proposal deadline.", actions: [{ text: "Send the proposal", owner: "You" }] }));
  const live = await call("meetings:start", { key, title: "Live planning" });
  await call("meetings:appendSegments", { key, id: live.id, segments: [{ seq: 0, source: "them", startMs: 0, endMs: 3000, text: "Please confirm the launch date." }] });
  await runtime.stop(); database.close(); database = null; runtime = null;
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: resolve("."), env: { ...process.env, PERRY_PORT: String(port), TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", GROQ_API_KEY: "", GEMINI_API_KEY: "", PERRY_WAKE_DISABLED: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => { log = (log + chunk).slice(-32000); writeFileSync(join(output, "server.log"), log); });
  for (let at = 0; at < 100; at++) {
    if (await fetch(base).then((response) => response.ok, () => false)) break;
    if (server.exitCode !== null) throw new Error(`UI server exited: ${log}`);
    await sleep(100);
  }
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(base, key);
  const until = (expression) => browser.evaluate(`new Promise((resolve, reject) => { const until = Date.now()+20000; const tick=()=>{if(${expression})resolve(true);else if(Date.now()>until)reject(new Error('UI condition timed out'));else setTimeout(tick,50)};tick()})`);
  const tab = async (name) => { await browser.evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(x=>x.textContent.trim()===${JSON.stringify(name)}).click()`); await until(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim()===${JSON.stringify(name)}`); };
  await browser.send("Page.navigate", { url: `${base}/meetings/${meeting.id}` });
  await until("document.body.innerText.includes('Launch on Friday.')");
  report.checks.summaryReadable = true;
  const screenshot = async (name) => {
    await browser.evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    const result = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(output, name), Buffer.from(result.data, "base64"));
  };
  await screenshot("summary.png");
  await tab("My thoughts"); await until("document.body.innerText.includes('Confirm the proposal deadline.')");
  report.checks.personalNotesSeparated = true;
  await tab("Transcript"); await until("document.body.innerText.includes('five thousand dollars')");
  await browser.evaluate("(()=>{const input=document.querySelector('input[aria-label=\"Search transcript\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'proposal');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until("!document.querySelector('[aria-label=\"Meeting transcript\"]').textContent.includes('five thousand dollars')");
  report.checks.transcriptSearch = true;
  await screenshot("transcript.png");
  await tab("Tasks1"); await until("document.body.innerText.includes('Send the proposal')");
  report.checks.tasksSeparated = true;
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  report.checks.mobileFits = await browser.evaluate("document.documentElement.scrollWidth <= innerWidth");
  await screenshot("mobile.png");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await browser.send("Page.navigate", { url: `${base}/meetings/${live.id}` });
  await until("document.querySelector('[contenteditable=true]')");
  await browser.evaluate("document.querySelector('[contenteditable=true]').focus()");
  await browser.send("Input.insertText", { text: "Keep this important detail." });
  await tab("Transcript"); await until("document.body.innerText.includes('confirm the launch date')");
  await tab("My thoughts"); await until("document.querySelector('[contenteditable=true]')?.textContent.includes('Keep this important detail.')");
  report.checks.liveNotesSurviveTabSwitch = true;
  await screenshot("live-notes.png");
  await browser.send("Page.navigate", { url: `${base}/settings/desktop-pet` });
  await until("document.querySelector('#speech-provider')");
  await browser.evaluate("(()=>{const input=document.querySelector('#speech-provider');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,'large-v3-turbo');input.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await browser.evaluate("Array.from(document.querySelectorAll('button')).find(x=>x.textContent.includes('Save speech settings')).click()");
  await until("Array.from(document.querySelectorAll('button')).some(x => x.textContent.includes('Save speech settings') && x.disabled && x.getAttribute('aria-busy') !== 'true')");
  const beforeReload = await browser.evaluate("performance.timeOrigin");
  await browser.send("Page.reload");
  await until(`performance.timeOrigin !== ${beforeReload} && document.querySelector('#speech-provider')?.value === 'large-v3-turbo'`);
  report.checks.localModelChoicePersists = true;
  await browser.evaluate("document.querySelector('#speech-provider').scrollIntoView({block:'center', behavior:'instant'})");
  await screenshot("speech-settings.png");
  report.errors = browser.errors;
  assert.ok(Object.values(report.checks).every(Boolean), JSON.stringify(report.checks));
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  browser?.close();
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { server.kill(); await new Promise((resolve) => server.once("exit", resolve)); }
  }
  await runtime?.stop(); database?.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  report.scratchRemoved = !existsSync(scratch);
  report.passed = !report.error && report.scratchRemoved;
  save(); console.log(JSON.stringify(report));
}
