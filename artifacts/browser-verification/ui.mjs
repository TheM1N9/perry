import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openChat, sleep } from "../browser.ts";

if (!process.argv[2]) throw Error("Pass a disposable output directory");
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-browser-verification-ui-"));
const key = "synthetic-browser-verification-ui-key";
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "97".repeat(32);
const report = { checks: {}, build: readFileSync(".next/BUILD_ID", "utf8").trim(), realChallengesCompleted: 0, modelTurnsStarted: 0, homeRemoved: false };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
const check = (name, passed) => { report.checks[name] = Boolean(passed); save(); assert.equal(Boolean(passed), true, name); };
save();
let runtime, database, server, browser, siteServer, browserCall;
let chat;
const completed = [];
let submitted = 0;
try {
  siteServer = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.local");
    if (url.pathname === "/complete") { completed.push(url.searchParams.get("value")); response.end("ok"); return; }
    if (url.pathname === "/submit") { submitted++; response.end("ok"); return; }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("content-security-policy", "default-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'");
    response.end(`<!doctype html><html><title>Local browser verification</title><body style="font:16px system-ui;margin:24px">
      <h1 style="font-size:24px">Local sign-in fixture</h1>
      <form onsubmit="event.preventDefault();fetch('/submit')">
        <label style="position:absolute;left:24px;top:68px">Phone number
          <input id="phone" aria-label="Phone number" style="display:block;width:260px;height:32px">
        </label>
        <div class="cf-turnstile" style="position:absolute;left:24px;top:132px">Verify you are human</div>
        <input type="hidden" name="cf-turnstile-response">
        <p id="failure" style="position:absolute;left:24px;top:218px">We couldn't finish checking your browser. Retry the check to request a code.</p>
        <button id="complete" type="button" style="position:absolute;left:24px;top:170px;width:260px;height:36px" onclick="finish()">Complete synthetic verification</button>
        <button id="retry" type="button" style="position:absolute;left:24px;top:280px">Retry browser check</button>
        <button type="submit" style="position:absolute;left:24px;top:320px">Send code</button>
      </form><script>async function finish(){await fetch('/complete?value='+encodeURIComponent(document.querySelector('#phone').value));document.querySelector('[name=cf-turnstile-response]').value='synthetic-complete';document.querySelector('.cf-turnstile').remove();document.querySelector('#failure').remove();document.querySelector('#retry').remove();document.querySelector('h1').textContent='Synthetic verification complete';}</script>
    </body></html>`);
  });
  await new Promise(resolve => siteServer.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${siteServer.address().port}`;
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts"),
  ]);
  database = new DatabaseSync(join(home, "perry.sqlite"));
  initializeCredentialEncryption(database, home);
  runtime = new Runtime(database, schema, modules, { storageDir: join(home, "storage") });
  await runtime.stop();
  runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", claimedAt: Date.now(), createdAt: Date.now() });
  chat = (await runtime.call("dashboard:createChat", { key }, { internal: true })).value;
  await runtime.stop(); database.close(); runtime = null; database = null;

  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PERRY_PORT: String(port), PERRY_BROWSER_HEADED: "0", TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", GROQ_API_KEY: "", GEMINI_API_KEY: "", PERRY_WAKE_DISABLED: "1" },
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-12000); writeFileSync(join(output, "server.log"), log); });
  const until = async (predicate, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await sleep(80); }
  };
  await until(async () => { if (server.exitCode !== null) throw Error(`Production server exited: ${log}`); return fetch(base).then(response => response.ok, () => false); }, "production server");
  browserCall = async request => {
    const response = await fetch(`${base}/api/browser`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key, origin: base }, body: JSON.stringify({ conversationId: chat, request }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? `Browser API ${response.status}`);
    return data;
  };
  let state = await browserCall({ action: "start", nativeWindow: false });
  await browserCall({ action: "navigate", identity: state.identity, url: site });
  await until(async () => { state = await browserCall({ action: "status" }); return state.verification?.state === "failed"; }, "local failed verification");
  const generation = state.identity;
  await browserCall({ action: "resume", identity: state.identity });
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(base, key);
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const pageUntil = (expression, label = expression) => until(async () => {
    try { return await browser.evaluate(`Boolean(${expression})`); }
    catch (error) { if (/navigated or closed|Execution context was destroyed|Cannot find context/.test(String(error))) return false; throw error; }
  }, label);
  const click = async expression => {
    await pageUntil(`(() => { const el=${expression}; if(!el)return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()`, "click target is reachable");
    const at = await browser.evaluate(`(() => { const el=${expression}; if(!el) throw Error('Missing click target'); el.scrollIntoView({block:'nearest',behavior:'instant'}); const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
    await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
  };
  const button = label => `Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(label)})`;
  const panel = "document.querySelector('[aria-label=\"Live browser\"]')";
  const screenshot = async name => { const shot = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(output, name), Buffer.from(shot.data, "base64")); };
  const checkVisible = async (name, expression) => check(name, await browser.evaluate(`(() => {const el=${expression};if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`));
  await browser.send("Page.navigate", { url: `${base}/chat/${chat}` });
  await pageUntil("document.querySelector('[data-chat-panel-toggle]')");
  await click("document.querySelector('[data-chat-panel-toggle]')");
  await pageUntil("document.getElementById('chat-panel-open-browser')");
  await click("document.getElementById('chat-panel-open-browser')");
  await pageUntil(`${panel}?.textContent.includes('Site verification')`);
  check("failed website check is shown separately from disconnect", await browser.evaluate(`${panel}.textContent.includes('verification failed')&&!${panel}.textContent.includes('Disconnected')`));
  await checkVisible("desktop takeover control is reachable", button("Pause & take over"));
  await screenshot("desktop-site-verification.png");
  await click(button("Pause & take over"));
  await pageUntil(`${panel}?.dataset.browserState==='paused'&&document.querySelector('[role=application] img')?.complete`);
  check("dashboard takeover changes browser ownership", (await browserCall({ action: "status" })).state === "paused");
  check("paused guidance points to the page and Resume", await browser.evaluate(`${panel}.textContent.includes('page below')&&${panel}.textContent.includes('Resume Perry')`));
  const pageClick = async (x, y) => {
    const current = await browserCall({ action: "status" });
    const at = await browser.evaluate(`(() => {const r=document.querySelector('[role=application]').getBoundingClientRect();return{x:r.x+${x}*r.width/${current.viewport.width},y:r.y+${y}*r.height/${current.viewport.height}};})()`);
    await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
    await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
  };
  await pageClick(100, 102);
  await browser.send("Input.insertText", { text: "synthetic-form-retained" });
  await pageClick(140, 188);
  await until(() => completed.length === 1, "owner completes local button");
  check("streamed owner input and form value survive takeover", completed[0] === "synthetic-form-retained");
  await pageUntil(`!${panel}.textContent.includes('verification failed')`);
  check("verification banner clears after local completion", !(await browserCall({ action: "status" })).verification);
  await checkVisible("desktop Resume control is reachable", button("Resume Perry"));
  await click(button("Resume Perry"));
  await pageUntil(`${panel}.textContent.includes('Perry is browsing')`);
  state = await browserCall({ action: "status" });
  check("Resume retains the same browser session and tab", state.state === "live" && state.identity.sessionId === generation.sessionId && state.identity.tabId === generation.tabId);

  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pageUntil("document.querySelector('[data-chat-panel][data-panel-mode=sheet]')");
  await browserCall({ action: "takeover" });
  state = await browserCall({ action: "status" });
  await browserCall({ action: "navigate", identity: state.identity, url: site });
  await until(async () => { state = await browserCall({ action: "status" }); return state.verification?.state === "failed"; }, "mobile failed verification");
  await browserCall({ action: "resume", identity: state.identity });
  await pageUntil(`${panel}?.textContent.includes('Site verification')`);
  await checkVisible("phone takeover control is reachable", button("Pause & take over"));
  check("phone recovery guidance fits without horizontal page overflow", await browser.evaluate(`document.documentElement.scrollWidth<=innerWidth&&${panel}.textContent.includes('Pause & take over')`));
  await screenshot("phone-site-verification.png");
  await click(button("Pause & take over"));
  await pageUntil(`${panel}?.dataset.browserState==='paused'&&document.querySelector('[role=application] img')?.complete`);
  await pageClick(100, 102);
  await browser.send("Input.insertText", { text: "phone-form-retained" });
  await pageClick(140, 188);
  await until(() => completed.length === 2, "phone completes local button");
  check("phone owner input reaches the same browser page", completed[1] === "phone-form-retained");
  await pageUntil(`!${panel}.textContent.includes('verification failed')`);
  await checkVisible("phone Resume control is reachable", button("Resume Perry"));
  await click(button("Resume Perry"));
  await pageUntil(`${panel}.textContent.includes('Perry is browsing')`);
  check("recovery never submits the sign-in form", submitted === 0);
  check("dashboard has no uncaught browser exceptions", browser.errors.length === 0);
  const saved = new DatabaseSync(join(home, "perry.sqlite"));
  try { check("recovery does not start any model turn", saved.prepare("SELECT count(*) AS count FROM doc_codexTurns").get().count === 0); }
  finally { saved.close(); }
} catch (error) {
  report.error = String(error.stack ?? error);
  if (browser) {
    report.page = await browser.evaluate("document.body.innerText.slice(-5000)").catch(() => "unavailable");
    try { const shot = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(output, "failure.png"), Buffer.from(shot.data, "base64")); } catch {}
  }
} finally {
  if (browserCall && chat) {
    try { await browserCall({ action: "takeover" }); const state = await browserCall({ action: "status" }); if (state.identity) await browserCall({ action: "close", identity: state.identity }); }
    catch (error) { report.browserCloseError = String(error); }
  }
  browser?.close();
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { server.kill(); await new Promise(resolve => server.once("exit", resolve)); }
  }
  await runtime?.stop(); database?.close();
  if (siteServer) { siteServer.closeAllConnections(); await new Promise(resolve => siteServer.close(resolve)); }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (error) { report.cleanupError = String(error); }
  report.homeRemoved = !existsSync(home);
  report.passed = !report.error && report.homeRemoved && !report.cleanupError && !report.browserCloseError && Object.values(report.checks).every(Boolean);
  save();
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
