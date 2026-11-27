// Native Runtime -> authenticated MCP -> owned Chrome -> owner controls -> same turn.
// Failure inventory is recorded in failure-cases.md before this replay.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";

if (!process.argv[2]) throw Error("Pass a disposable output directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-browser-verification-"));
const baselineRevision = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
const baseline = process.argv.includes("--baseline") || Boolean(baselineRevision);
const baselineCommit = baselineRevision ?? "e89a386f70b697fd09b34f76ad3309dd861c7d63";
if (!/^[a-f0-9]{40}$/.test(baselineCommit)) throw Error("The baseline must be a full commit SHA");
if (baseline) {
  const originals = new Map();
  for (const path of ["convex/lib/browser.ts", "server/browser-host.ts", "lib/browser-protocol.ts", "convex/tools.ts"]) {
    const result = spawnSync("git", ["show", `${baselineCommit}:${path}`], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw Error(result.stderr);
    originals.set(new URL(`../../${path}`, import.meta.url).href, result.stdout);
  }
  registerHooks({ load(url, context, nextLoad) { const loaded = nextLoad(url, context); return originals.has(url) ? { ...loaded, source: originals.get(url) } : loaded; } });
}
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = "synthetic-browser-verification-key";
process.env.PERRY_CREDENTIAL_KEY = "96".repeat(32);
process.env.PERRY_BROWSER_PATH ??= process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome";
delete process.env.PERRY_BROWSER_HEADED;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.COMPOSIO_API_KEY;
const key = process.env.DASHBOARD_KEY, token = "synthetic-browser-verification-runner";
const report = { baseline, baselineCommit: baseline ? baselineCommit : undefined, checks: {}, realAccountsUsed: 0, realChallengesCompleted: 0, modelTurnsStarted: 0, homeRemoved: false };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
const check = (name, passed) => { report.checks[name] = Boolean(passed); save(); console.log(JSON.stringify({ name, passed: Boolean(passed) })); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 15000) => { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() >= end) throw Error("Native browser fixture timed out"); await sleep(50); } };
const nativeFetch = globalThis.fetch, nativeTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
const idleCallbacks = new Map();
globalThis.setTimeout = (callback, ms, ...args) => { const timer = nativeTimeout(callback, ms, ...args); if (ms === 600000) idleCallbacks.set(timer, () => callback(...args)); return timer; };
globalThis.clearTimeout = timer => { idleCallbacks.delete(timer); nativeClearTimeout(timer); };
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw Error("External Node network is disabled in browser verification replay");
  return nativeFetch(input, options);
};
const service = createServer((request, response) => {
  const path = new URL(request.url, "http://fixture.local").pathname;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-security-policy", "default-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'");
  if (path === "/article") return response.end("<title>Cloudflare documentation article</title><h1>Understanding browser checks</h1><p>This article discusses Cloudflare, CAPTCHA and verify you are human messages. It is ordinary content, not a challenge.</p>");
  const hidden = path === "/hidden";
  const solved = path === "/solved" || path === "/failed-token";
  const failed = path === "/failed" || path === "/failed-token";
  const automatic = path === "/auto";
  const frame = path === "/iframe";
  const deferred = path === "/deferred";
  const checking = path === "/checking" || automatic || deferred;
  response.end(`<!doctype html><html><title>Verification fixture</title><body>
    <h1>Local sign-in fixture</h1><form onsubmit="event.preventDefault();window.submits=(window.submits||0)+1;${deferred ? 'finish()' : ''}">
    <label>Phone number <input id="phone" type="tel" aria-label="Phone number"></label>
    <label>Password <input id="password" type="password" autocomplete="current-password" value="synthetic-private-password-791a"></label>
    ${frame ? '<iframe title="Synthetic blocked frame" src="https://challenges.cloudflare.com/fixture" style="width:300px;height:150px"></iframe>' : `<div class="cf-turnstile" ${hidden ? 'style="display:none"' : ''}><span id="prompt">${checking ? "Checking your browser" : "Verify you are human"}</span></div>`}
    <input type="hidden" name="cf-turnstile-response" value="${solved ? "synthetic-private-verification-token-483d" : ""}">
    ${failed ? '<p id="failure">We couldn’t finish checking your browser. Retry the check to request a code.</p><button type="button" id="retry" onclick="window.retries=(window.retries||0)+1">Retry browser check</button>' : ''}
    <button type="button" id="complete" onclick="finish()">Complete synthetic verification</button>
    <button id="submit" type="submit">Send code</button></form>
    <script>window.submits=0;function finish(){document.querySelector('[name=cf-turnstile-response]').value='synthetic-private-verification-token-483d';document.querySelector('.cf-turnstile').remove();document.querySelector('#failure')?.remove();document.querySelector('#retry')?.remove();document.querySelector('h1').textContent='Synthetic verification complete';}${automatic ? 'setTimeout(finish,4000)' : ''}</script>
  </body></html>`);
});
let rt, sql, browser, controlBrowser;
const scopes = new Set(), children = new Map(), sessions = new Map();
try {
  await new Promise((resolve, reject) => service.once("error", reject).listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${service.address().port}`;
  const [{ Runtime }, { default: schema }, { modules }, { default: http }, web, host, runtime] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../convex/http.ts"),
    import("../../convex/lib/browser.ts"), import("../../server/browser-host.ts"), import("../../server/browser-runtime.ts"),
  ]);
  browser = web; controlBrowser = host.controlBrowser;
  sql = new DatabaseSync(join(home, "perry.sqlite"));
  rt = new Runtime(sql, schema, modules, { storageDir: join(home, "storage"), http });
  await rt.stop();
  const call = async (path, args = {}) => (await rt.call(path, args, { internal: true })).value;
  rt.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", claimedAt: Date.now(), createdAt: Date.now() });
  rt.store.insert("runners", { name: "Synthetic browser runner", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  const identity = chat => browser.identity(chat);
  const owner = (chat, request) => controlBrowser(chat, request, true);
  const evaluate = async (chat, expression) => (await browser.withBrowserView(chat, () => browser.hostCommand("Runtime.evaluate", { expression, returnByValue: true }))).result.value;
  const fresh = async label => {
    const chat = await call("dashboard:createChat", { key }); scopes.add(chat);
    rt.store.patch(chat, { access: "full" });
    const runId = await call("runs:start", { conversationId: chat, prompt: label });
    const turn = await call("codex:enqueueTurn", { conversationId: chat, runId, engine: "codex", prompt: label, instructions: "Synthetic browser fixture only", policy: "queue" });
    const claimed = await call("codex:claimTurn", { token, id: turn });
    if (!claimed?.mcpGrant) throw Error("Synthetic browser turn was not claimable");
    await call("codex:setResume", { token, id: turn, cursor: `synthetic-${label}` });
    sessions.set(chat, { turn, grant: claimed.mcpGrant });
    return chat;
  };
  const mcp = async (chat, args) => {
    const session = sessions.get(chat);
    const response = await rt.runHttp("/mcp", new Request("http://fixture.local/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-perry-chat": chat, "x-perry-turn": session.turn, "x-perry-grant": session.grant }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser", arguments: args } }) }));
    const rpc = await response.json(), text = rpc.result?.content?.find(part => part.type === "text")?.text;
    if (!text) throw Error("Native browser MCP did not return a text result");
    const parsed = rpc.result.isError ? { error: text } : JSON.parse(text);
    return parsed.untrusted ? parsed.result : parsed;
  };
  const rememberChild = chat => { const child = browser.browserControl(chat).current?.child; if (child) children.set(chat, child); };
  const close = async chat => {
    const child = children.get(chat) ?? browser.browserControl(chat).current?.child;
    await browser.withBrowserView(chat, async () => browser.closeBrowser());
    if (child) await until(() => child.exitCode !== null || child.signalCode !== null);
    await until(() => !globalThis.__perryBrowserClosingProfiles?.size);
  };
  const open = async (chat, path) => {
    const result = await mcp(chat, { action: "open", ...(identity(chat) ? { identity: identity(chat) } : {}), url: site + path });
    rememberChild(chat); if (result.error) throw Error(result.error); return result;
  };
  const mode = async (name, value, expected) => {
    if (value === undefined) delete process.env.PERRY_BROWSER_HEADED; else process.env.PERRY_BROWSER_HEADED = value;
    const chat = await fresh(name); await open(chat, "/article");
    const version = await browser.withBrowserView(chat, () => browser.hostCommand("Browser.getVersion"));
    const status = await owner(chat, { action: "status" });
    check(name, status.nativeWindow === expected && /HeadlessChrome/.test(version.userAgent) !== expected);
    return chat;
  };
  const desktop = runtime.nativeBrowserAvailable();
  const defaultChat = await mode("agent default matches local desktop availability", undefined, desktop);
  const defaultState = browser.browserControl(defaultChat), timer = defaultState.current?.idle;
  const idle = idleCallbacks.get(timer);
  check("agent-created browser retains bounded idle cleanup", Boolean(idle));
  const beforeTakeover = identity(defaultChat);
  await owner(defaultChat, { action: "takeover" });
  idle?.();
  check("an old idle callback does not close a desktop browser after owner takeover", !desktop || identity(defaultChat)?.sessionId === beforeTakeover.sessionId);
  await close(defaultChat);
  await close(await mode("explicit headless override remains headless", "0", false));
  if (desktop) await close(await mode("explicit desktop override remains headed", "1", true));
  process.env.PERRY_BROWSER_HEADED = "1";
  const panel = await fresh("panel-only");
  await owner(panel, { action: "start", nativeWindow: false }); rememberChild(panel);
  const panelVersion = await browser.withBrowserView(panel, () => browser.hostCommand("Browser.getVersion"));
  check("explicit panel-only mode overrides headed environment", /HeadlessChrome/.test(panelVersion.userAgent) && (await owner(panel, { action: "status" })).nativeWindow === false);
  await close(panel);
  delete process.env.PERRY_BROWSER_HEADED;
  scopes.add("public-reader");
  await browser.withBrowserView("public-reader", () => browser.hostTargets()); rememberChild("public-reader");
  const publicVersion = await browser.withBrowserView("public-reader", () => browser.hostCommand("Browser.getVersion"));
  check("public reader stays headless and uses its private profile", /HeadlessChrome/.test(publicVersion.userAgent) && browser.browserProfileId("public-reader") === "private");
  await close("public-reader");

  process.env.PERRY_BROWSER_HEADED = "0";
  const chat = await fresh("verification-lifecycle");
  const article = await open(chat, "/article");
  check("normal articles mentioning bot checks are not classified as challenges", !article.verification);
  const hidden = await open(chat, "/hidden");
  check("hidden widgets are not classified as active verification", !hidden.verification);
  const solved = await open(chat, "/solved");
  check("a solved widget does not remain blocked", !solved.verification);
  check("a widget token is not exposed in snapshot content", !JSON.stringify(solved).includes("synthetic-private-verification-token-483d"));
  const checking = await open(chat, "/checking");
  check("an automatic widget reports checking separately from failure", checking.verification?.state === "checking");
  const checkingAction = await mcp(chat, { action: "click", identity: checking.identity, ref: checking.elements.find(element => element.label === "Send code").ref });
  check("checking alone permits a legitimate form to start verification", !checkingAction.error && !checkingAction.blockedAction && await evaluate(chat, "window.submits") === 1);
  const framePage = await open(chat, "/iframe");
  check("a visible known verification iframe is identified without readable parent challenge text", framePage.verification?.state === "checking" && framePage.verification?.provider === "Cloudflare");
  const frameAction = await mcp(chat, { action: "click", identity: framePage.identity, ref: framePage.elements.find(element => element.label === "Send code").ref });
  check("a pending iframe does not deadlock a legitimate verification-triggering submit", !frameAction.error && !frameAction.blockedAction && await evaluate(chat, "window.submits") === 1);
  const deferredPage = await open(chat, "/deferred");
  check("a deferred-execution widget initially reports checking", deferredPage.verification?.state === "checking");
  const deferredAction = await mcp(chat, { action: "click", identity: deferredPage.identity, ref: deferredPage.elements.find(element => element.label === "Send code").ref });
  check("a legitimate submit starts deferred verification and clears its synthetic widget", !deferredAction.error && !deferredAction.blockedAction && !deferredAction.verification && await evaluate(chat, "window.submits") === 1 && await evaluate(chat, "document.querySelector('[name=cf-turnstile-response]').value.length > 0"));
  const required = await open(chat, "/required");
  check("a visible human-verification widget is identified", required.verification?.state === "required" && required.verification?.provider === "Cloudflare");
  const requiredAction = await mcp(chat, { action: "click", identity: required.identity, ref: required.elements.find(element => element.label === "Send code").ref });
  check("required human verification blocks agent form submission", requiredAction.blockedAction === true && await evaluate(chat, "window.submits") === 0);
  const rejectedToken = await open(chat, "/failed-token");
  check("visible verification failure takes precedence over a stale response token", rejectedToken.verification?.state === "failed");
  const failed = await open(chat, "/failed");
  check("failed browser verification is structured in the MCP snapshot", failed.verification?.state === "failed");
  check("password and verification token values are absent from snapshots", !JSON.stringify(failed).includes("synthetic-private-password-791a") && !JSON.stringify(rejectedToken).includes("synthetic-private-verification-token-483d"));
  const status = await owner(chat, { action: "status" });
  check("a site challenge remains distinct from a disconnected browser", status.state === "live" && status.verification?.state === "failed" && status.identity?.tabId === failed.identity.tabId);
  const retried = await mcp(chat, { action: "click", identity: failed.identity, ref: failed.elements.find(element => element.label === "Retry browser check").ref });
  check("a site-provided Retry control remains usable", !retried.error && !retried.blockedAction && await evaluate(chat, "window.retries") === 1 && await evaluate(chat, "window.submits") === 0);
  const blocked = await mcp(chat, { action: "click", identity: retried.identity, ref: retried.elements.find(element => element.label === "Send code").ref });
  check("a failed verification blocks form submission before any site request", blocked.blockedAction === true && await evaluate(chat, "window.submits") === 0);
  await evaluate(chat, "window.submits=0;document.querySelector('form').insertAdjacentHTML('beforeend','<input type=image alt=\"Send image\" style=\"width:100px;height:30px\">')");
  const imagePage = await mcp(chat, { action: "look" });
  const imageResult = await mcp(chat, { action: "click", identity: imagePage.identity, ref: imagePage.elements.find(element => element.label === "Send image").ref });
  check("image submit controls cannot submit a verification-blocked form", imageResult.blockedAction === true && await evaluate(chat, "window.submits") === 0);
  await evaluate(chat, "window.submits=0");
  const current = await mcp(chat, { action: "look" });
  const phone = current.elements.find(element => element.label === "Phone number");
  const typed = await mcp(chat, { action: "type", identity: current.identity, ref: phone.ref, text: "synthetic-owner-form-value" });
  check("ordinary form entry remains available before owner verification", !typed.error && await evaluate(chat, "document.getElementById('phone').value") === "synthetic-owner-form-value");
  const enter = await mcp(chat, { action: "type", identity: typed.identity, ref: typed.elements.find(element => element.label === "Phone number").ref, text: "synthetic-owner-form-value", submit: true });
  check("Enter cannot submit a verification-blocked form", enter.blockedAction === true && await evaluate(chat, "window.submits") === 0);
  await evaluate(chat, "window.submits=0");
  const savedPassword = "synthetic-vault-password-94de", savedUsername = "synthetic-vault-user";
  const savedLogin = await call("vault:save", { label: "Synthetic local verification login", url: site, username: savedUsername, value: savedPassword, by: "owner" });
  const beforeSignIn = await mcp(chat, { action: "look" });
  const savedSignIn = await mcp(chat, { action: "sign_in", identity: beforeSignIn.identity, secretId: savedLogin.id, usernameRef: beforeSignIn.elements.find(element => element.label === "Phone number").ref, passwordRef: beforeSignIn.elements.find(element => element.label === "Password").ref });
  const unusedLogin = (await call("vault:list")).find(entry => entry.id === savedLogin.id);
  check("saved-login automatic submission is blocked before revealing the vault entry", savedSignIn.blockedAction === true && !unusedLogin.lastUsedAt && await evaluate(chat, "window.submits") === 0 && await evaluate(chat, "document.getElementById('password').value") === "synthetic-private-password-791a");
  await evaluate(chat, "window.submits=0");
  const beforeFill = await mcp(chat, { action: "look" });
  const filled = await mcp(chat, { action: "sign_in", identity: beforeFill.identity, secretId: savedLogin.id, usernameRef: beforeFill.elements.find(element => element.label === "Phone number").ref, passwordRef: beforeFill.elements.find(element => element.label === "Password").ref, submit: false });
  check("explicit saved-login fill stays available without submitting a blocked form", !filled.error && !filled.blockedAction && await evaluate(chat, "document.getElementById('phone').value") === savedUsername && await evaluate(chat, "document.getElementById('password').value") === savedPassword && await evaluate(chat, "window.submits") === 0);
  check("saved-login fill does not expose the vault password in its result", !JSON.stringify(filled).includes(savedPassword));
  const restore = await mcp(chat, { action: "look" });
  await mcp(chat, { action: "type", identity: restore.identity, ref: restore.elements.find(element => element.label === "Phone number").ref, text: "synthetic-owner-form-value" });
  const generation = identity(chat);
  await owner(chat, { action: "takeover" });
  check("takeover blocks further agent actions until Resume", Boolean((await mcp(chat, { action: "look" })).error));
  const point = await evaluate(chat, "(() => {const box=document.getElementById('complete').getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};})()");
  await owner(chat, { action: "click", identity: identity(chat), ...point });
  const ownerStatus = await owner(chat, { action: "status" });
  check("owner completion clears verification without reloading", !ownerStatus.verification && ownerStatus.identity?.sessionId === generation.sessionId && ownerStatus.identity?.tabId === generation.tabId);
  await owner(chat, { action: "resume", identity: identity(chat) });
  const resumed = await mcp(chat, { action: "look" });
  check("fresh look resumes in the same browser session and tab", !resumed.error && !resumed.verification && resumed.identity?.sessionId === generation.sessionId && resumed.identity?.tabId === generation.tabId);
  check("the entered form value survives owner completion and Resume", await evaluate(chat, "document.getElementById('phone').value") === "synthetic-owner-form-value");
  check("verification handling does not submit the sign-in form", await evaluate(chat, "window.submits") === 0);
  const stale = await mcp(chat, { action: "click", identity: failed.identity, ref: failed.elements.find(element => element.label === "Send code").ref });
  check("pre-takeover identities cannot act after verification recovery", Boolean(stale.error) && await evaluate(chat, "window.submits") === 0);
  const sent = await mcp(chat, { action: "click", identity: resumed.identity, ref: resumed.elements.find(element => element.label === "Send code").ref });
  check("ordinary Full-access submission works after verification completion", !sent.error && !sent.blockedAction && await evaluate(chat, "window.submits") === 1);
  const auto = await open(chat, "/auto");
  check("self-completing widgets initially report checking", auto.verification?.state === "checking");
  await until(async () => await evaluate(chat, "document.querySelector('[name=cf-turnstile-response]').value.length > 0"), 10000);
  const afterAuto = await mcp(chat, { action: "look" });
  check("a later observation clears a self-completed browser check", !afterAuto.verification && afterAuto.text.includes("Synthetic verification complete"));
  const approvalPage = await open(chat, "/solved");
  rt.store.patch(chat, { access: "ask" });
  const waitingSubmit = mcp(chat, { action: "click", identity: approvalPage.identity, ref: approvalPage.elements.find(element => element.label === "Send code").ref });
  await until(() => rt.store.all("approvals").some(entry => entry.conversationId === chat && entry.status === "pending"));
  const approval = rt.store.all("approvals").find(entry => entry.conversationId === chat && entry.status === "pending");
  const beforeFailure = identity(chat);
  await evaluate(chat, "document.querySelector('[name=cf-turnstile-response]').value='';document.body.insertAdjacentHTML('beforeend', '<p>Browser verification failed</p><button type=button>Retry browser check</button>')");
  const pageUnchanged = identity(chat)?.revision === beforeFailure.revision;
  if (!await call("approvals:decide", { key, id: approval._id, approved: true })) throw Error("Synthetic browser approval was refused");
  const afterApproval = await waitingSubmit;
  check("submission rechecks verification after approval even when page identity is unchanged", pageUnchanged && afterApproval.blockedAction === true && afterApproval.verification?.state === "failed" && await evaluate(chat, "window.submits") === 0);
  await open(chat, "/solved");
  await evaluate(chat, "document.getElementById('submit').type='button'");
  const changingPage = await mcp(chat, { action: "look" });
  const changingSubmit = mcp(chat, { action: "click", identity: changingPage.identity, ref: changingPage.elements.find(element => element.label === "Send code").ref });
  await until(() => rt.store.all("approvals").some(entry => entry.conversationId === chat && entry.status === "pending"));
  const changingApproval = rt.store.all("approvals").find(entry => entry.conversationId === chat && entry.status === "pending");
  const beforeChange = identity(chat);
  await evaluate(chat, "document.getElementById('submit').type='submit';document.querySelector('[name=cf-turnstile-response]').value='';document.body.insertAdjacentHTML('beforeend', '<p>Browser verification failed</p><button type=button>Retry browser check</button>')");
  if (!await call("approvals:decide", { key, id: changingApproval._id, approved: true })) throw Error("Synthetic changing-control approval was refused");
  const afterChange = await changingSubmit;
  check("click reclassifies a control that becomes a submit button while approval is pending", beforeChange.revision === changingPage.identity.revision && afterChange.blockedAction === true && await evaluate(chat, "window.submits") === 0);
  rt.store.patch(chat, { access: "full" });
  await call("dashboard:stopChat", { key, id: chat });
  check("a stopped turn cannot reuse its browser grant", Boolean((await mcp(chat, { action: "look" })).error));
  await close(chat);
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  const cleanupErrors = [];
  for (const scope of scopes) {
    try { await browser?.withBrowserView(scope, async () => browser.closeBrowser()); } catch { cleanupErrors.push("Could not release a browser scope"); }
  }
  for (const child of children.values()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { await until(() => child.exitCode !== null || child.signalCode !== null, 6000); } catch { child.kill(); cleanupErrors.push("Browser needed forced teardown"); }
  }
  await rt?.stop(); sql?.close();
  service.closeAllConnections(); if (service.listening) await new Promise(resolve => service.close(resolve));
  for (const timer of idleCallbacks.keys()) nativeClearTimeout(timer);
  globalThis.setTimeout = nativeTimeout; globalThis.clearTimeout = nativeClearTimeout; globalThis.fetch = nativeFetch;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  report.homeRemoved = !existsSync(home); report.cleanupErrors = cleanupErrors;
  report.passed = !report.error && !cleanupErrors.length && report.homeRemoved && Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean);
  save(); console.log(JSON.stringify({ passed: report.passed, checks: Object.keys(report.checks).length, failures: Object.entries(report.checks).filter(([, passed]) => !passed).map(([name]) => name), error: report.error, homeRemoved: report.homeRemoved }));
  if (!report.passed) process.exitCode = 1;
}
