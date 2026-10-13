// Production HTTP/MCP/browser journeys. Failure checklist: docs/interactive-answers.md.
// PERRY_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node artifacts/interactive-answers/run.mjs <output-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, platform, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(repo, "artifacts/interactive-answers/latest"));
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-issue-282-"));
const key = "isolated-interactive-answer-e2e";
const token = "isolated-interactive-runner";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, pass: Boolean(ok), ...(detail ? { detail } : {}) }); console.log(`${ok ? "ok" : "FAIL"} ${name}`); assert.ok(ok, name); };
async function until(test, label, seconds = 45) {
  for (let i = 0; i < seconds * 4; i++) { if (await test().catch(() => false)) return; await sleep(250); }
  throw new Error(`Timed out: ${label}`);
}
const portProbe = createServer();
await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
const port = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
const base = `http://127.0.0.1:${port}`;
let externalHits = 0;
const site = createServer((req, res) => {
  if (req.url !== "/fixture") externalHits++;
  res.setHeader("content-type", "text/html");
  res.end("<h1>Illustrative channel analytics fixture</h1><p>Fixture source, not a connected account. Channel A 120 views. Channel B is missing. Period 2026-10-01 to 2026-10-07. This page deliberately contains no live account data.</p>");
});
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const siteHost = `127.0.0.1:${site.address().port}`;
const fixture = `http://${siteHost}/fixture`;
const env = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(port), PERRY_INTERACTIVE_ANSWERS: "1", DASHBOARD_KEY: key, PERRY_ENGINE: "codex", PERRY_WEB_TEST_SITE: siteHost, TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", NODE_ENV: "production", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
let server;
let serverLog = "";
let browser;
let chat;
let turnId;
let rpc = 0;
const browserDiagnostics = [];
async function start(flag = "1") {
  server = spawn(process.execPath, [join(repo, "node_modules/next/dist/bin/next"), "start", "-p", String(port)], { cwd: repo, env: { ...env, PERRY_INTERACTIVE_ANSWERS: flag }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (chunk) => { serverLog += chunk; });
  server.stderr.on("data", (chunk) => { serverLog += chunk; });
  await until(() => fetch(`${base}/api/backend/http/health`).then((r) => r.ok), "server start", 90);
}
async function stop() {
  if (server && server.exitCode === null) {
    const exited = new Promise((done) => server.once("exit", done));
    server.kill("SIGTERM");
    await Promise.race([exited, sleep(3000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
    await exited;
  }
}
async function call(path, args = {}, admin = true) {
  const response = await fetch(`${base}/api/backend/${admin ? "admin" : "call"}`, { method: "POST", headers: { "content-type": "application/json", ...(admin ? { "x-perry-key": key } : {}) }, body: JSON.stringify({ path, args }) });
  const body = await response.json();
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value;
}
async function mcp(name, args) {
  const response = await fetch(`${base}/api/backend/http/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-perry-chat": chat }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.json();
  if (body.error || body.result?.isError) throw new Error(body.error?.message ?? body.result.content[0].text);
  return JSON.parse(body.result.content[0].text);
}
async function list() { return call("interactive:list", { key, conversationId: chat }, false); }
async function claim(text) {
  await call("runner:checkIn", { token, platform: platform(), hostname: hostname(), workdir: home });
  await call("dashboard:sendChat", { key, id: chat, text });
  let turn;
  await until(async () => { turn = (await call("codex:queuedTurns", { token })).find((t) => t.conversationId === chat); return Boolean(turn); }, "queued fixture turn", 90);
  turnId = turn._id;
  assert.ok(await call("codex:claimTurn", { token, id: turnId }));
}
const definition = {
  schemaVersion: 1, title: "AI subscription cost comparison", summary: "Illustrative prices for testing only. Change usage to compare local monthly totals; these are not verified current subscription prices.",
  inputs: [{ kind: "number", id: "usage", label: "Monthly usage", unit: "units", min: 0, max: 1000, step: 1, initial: 10 }],
  provenance: { kind: "illustrative", sources: [], period: "Monthly", units: "USD/month", assumptions: ["Fixture prices, no live subscription connection"], missing: ["Taxes and overages"] },
  view: { kind: "calculator", items: [{ label: "Plan A", fixed: 20, perUnit: 2, input: "usage", unit: "USD/month" }, { label: "Plan B", fixed: 40, perUnit: 1, input: "usage", unit: "USD/month" }] },
};
try {
  await start();
  await call("dashboard:skipOnboarding", { key });
  await call("dashboard:setDefaultEngine", { key, engine: "codex" });
  await call("runner:createToken", { name: "Fixture runner, never executes", token });
  await call("runner:checkIn", { token, platform: platform(), hostname: hostname(), workdir: home });
  await call("engines:report", { token, engines: [{ kind: "codex", installed: true, version: "999.0.0-e2e", signedIn: true, auth: { type: "chatgpt", label: "Fixture" }, models: [{ id: "gpt-e2e", name: "Fixture", isDefault: true, efforts: ["low"], defaultEffort: "low" }] }] });
  chat = await call("dashboard:createChat", { key });
  check("direct text chats start without artifacts", (await list()).length === 0);
  await claim("Create an illustrative local calculator fixture.");
  const created = await mcp("interactive_create", { requestId: "calculator-fixture", definition });
  const duplicate = await mcp("interactive_create", { requestId: "calculator-fixture", definition });
  check("MCP creation retries return the same durable artifact", duplicate.id === created.id && (await list()).length === 1);
  await assert.rejects(() => mcp("interactive_create", { requestId: "bad-contract", definition: { ...definition, schemaVersion: 99 } }));
  await assert.rejects(() => mcp("interactive_create", { requestId: "bad-input", definition: { ...definition, inputs: [{ ...definition.inputs[0], initial: 1001 }] } }));
  await assert.rejects(() => mcp("interactive_create", { requestId: "oversized", definition: { ...definition, summary: "x".repeat(100_000) } }));
  check("malformed, out-of-range and oversized contracts are rejected", (await list()).length === 1);
  const wrongChat = await call("dashboard:createChat", { key });
  await assert.rejects(() => call("interactive:list", { key: "wrong", conversationId: chat }, false));
  await assert.rejects(() => call("interactive:save", { key, conversationId: wrongChat, id: created.id, expectedRevision: 1, requestId: "wrong-chat", operation: "save", values: '{"usage":1}' }, false));
  await assert.rejects(() => call("interactive:create", { conversationId: chat, turnId, requestId: "public-internal", definition: JSON.stringify(definition) }, false));
  check("wrong key, conversation and public calls to internal functions are rejected", true);
  await call("contacts:learn", { items: [{ channel: "telegram", externalId: "fixture-guest", kind: "person", name: "Fixture guest" }] });
  const contact = (await call("contacts:search", { query: "Fixture guest" }))[0];
  const guestThread = await call("agentStore:createThread", { userId: "fixture-guest" });
  const guestChat = await call("conversations:create", { channel: "telegram", externalId: "fixture-guest", threadId: guestThread, contactId: contact.id });
  await assert.rejects(() => call("interactive:list", { key, conversationId: guestChat }, false));
  check("guest conversations cannot read the owner's artifacts", true);

  const modulePath = process.env.PERRY_PLAYWRIGHT_MODULE;
  if (!modulePath) throw new Error("Set PERRY_PLAYWRIGHT_MODULE to an installed playwright/index.mjs (test tooling only).");
  const { chromium } = await import(pathToFileURL(modulePath).href);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PERRY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await context.addInitScript((key) => { if (window === top) localStorage.setItem("perry.dashboard.key", key); }, key);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserDiagnostics.push(message.text()); });
  await page.goto(`${base}/chat/${chat}`);
  const card = page.locator(`[data-interactive="${created.id}"]`);
  await card.waitFor();
  const usage = card.getByLabel("Monthly usage (units)");
  await usage.fill("25");
  await until(async () => (await card.locator("tbody").innerText()).includes("70"), "local calculation");
  check("calculator recalculates locally without a model turn", (await call("codex:queuedTurns", { token })).filter((t) => t.conversationId === chat).length === 0);
  await until(async () => (await list())[0].values.usage === 25, "debounced durable save");
  await page.reload();
  await until(async () => (await card.getByLabel("Monthly usage (units)").inputValue()) === "25", "reload restoration");
  check("calculator selected inputs survive reload", true);
  await card.screenshot({ path: join(output, "calculator-desktop.png") });

  // Two real browser tabs, with one tab's unsaved changes held while another writes.
  const second = await context.newPage();
  await second.goto(`${base}/chat/${chat}`);
  await second.locator(`[data-interactive="${created.id}"]`).waitFor();
  let releaseSave;
  const blocked = new Promise((done) => { releaseSave = done; });
  await second.route("**/api/backend/call", async (route) => {
    if (route.request().postDataJSON()?.path === "interactive:save") await blocked;
    await route.continue();
  });
  await second.getByLabel("Monthly usage (units)").fill("33");
  await usage.fill("31");
  await until(async () => (await list())[0].values.usage === 31, "first tab saves");
  releaseSave();
  await until(async () => (await second.locator("body").innerText()).match(/newer revision|Revision conflict/), "two-tab conflict notice");
  check("two-tab conflicts preserve the unsaved input", await second.getByLabel("Monthly usage (units)").inputValue() === "33");
  await second.getByRole("button", { name: "Load latest draft" }).click();
  await until(async () => (await second.getByLabel("Monthly usage (units)").inputValue()) === "31", "load latest conflict recovery");
  await second.close();

  let current = (await list())[0];
  const revised = await mcp("interactive_update", { id: created.id, expectedRevision: current.revision, requestId: "revise-calculator", definition: { ...definition, title: "Updated cost comparison", view: { ...definition.view, items: [...definition.view.items, { label: "Plan C", fixed: 10, perUnit: 3, input: "usage", unit: "USD/month" }] } } });
  check("follow-up revision updates the same id and retains compatible selected inputs", revised.id === created.id && revised.values.usage === 31 && (await list()).length === 1);
  await assert.rejects(() => mcp("interactive_update", { id: created.id, expectedRevision: current.revision, requestId: "stale-revision", definition }));
  check("stale definition revision is rejected", true);
  const replay = await mcp("interactive_update", { id: created.id, expectedRevision: current.revision, requestId: "revise-calculator", definition: revised.definition });
  check("definition update retry does not create another revision", replay.revision === revised.revision);
  await assert.rejects(() => call("interactive:save", { key, conversationId: chat, id: created.id, expectedRevision: revised.revision, requestId: "unknown-input", operation: "save", values: '{"usage":31,"secret":true}' }));
  check("undeclared state cannot be saved", true);

  // Real read_page HTTP path, explicitly fixture data. It must carry a server receipt.
  const read = await mcp("read_page", { url: fixture });
  check("successful read gets a server source receipt and untrusted marker", read.sourceReceipt?.receipt && read.untrusted);
  const sourced = { ...definition, title: "Channel analytics fixture", inputs: [{ kind: "text", id: "filter", label: "Filter channels", initial: "" }], provenance: { kind: "retrieved", sources: [read.sourceReceipt], period: "2026-10-01 through 2026-10-07", units: "views", assumptions: ["Fixture source; no real account connection"], missing: ["Channel B views unavailable"] }, view: { kind: "chart", columns: ["Channel", "Views"], rows: [["A", 120], ["B", null]] } };
  const analytics = await mcp("interactive_create", { requestId: "analytics", definition: sourced });
  await assert.rejects(() => mcp("interactive_create", { requestId: "forged-source", definition: { ...sourced, provenance: { ...sourced.provenance, sources: [{ ...read.sourceReceipt, fetchedAt: "2000-01-01T00:00:00Z" }] } } }));
  check("fabricated fetch metadata is rejected", true);
  const analyticsCard = page.locator(`[data-interactive="${analytics.id}"]`);
  await analyticsCard.waitFor();
  check("partial source data displays provenance and missing values honestly", (await analyticsCard.innerText()).includes("Missing") && (await analyticsCard.innerText()).includes(read.sourceReceipt.fetchedAt));
  await analyticsCard.getByLabel("Filter channels").fill("no-such-channel");
  await until(async () => (await analyticsCard.innerText()).includes("No data matches"), "empty data filter");
  check("filters handle empty results without invented values", true);
  const held = await mcp("run_action", { slug: "GMAIL_SEND_EMAIL", args: { to: "nobody@example.invalid" } });
  check("outside-read consequential account action is refused server-side", held.refused === true && Boolean(held.error));
  const approval = await call("approvals:request", { token, kind: "write", title: "Fixture proposed publish (never executed)", conversationId: chat });
  if (approval.next === "review") await call("approvals:reviewed", { token, id: approval.id, verdict: "caution", reason: "Fixture consequential action" });
  assert.notEqual(approval.next, "run");
  await call("approvals:decide", { key, id: approval.id, approved: false });
  check("existing approval rejection remains a decline, without an external write", await call("approvals:decision", { token, id: approval.id }) === "declined" && externalHits === 0);

  const calendar = await mcp("interactive_create", { requestId: "calendar", definition: { ...definition, title: "Draft content calendar", summary: "Owner input fixture. Dates are saved drafts; nothing is published.", inputs: [{ kind: "date", id: "date", label: "Draft publication date", initial: "2026-10-13" }, { kind: "select", id: "channel", label: "Draft channel", options: ["Blog", "Video"], initial: "Blog" }], provenance: { ...definition.provenance, kind: "owner" }, view: { kind: "table", columns: ["Date", "Channel", "Status"], rows: [[{ input: "date" }, { input: "channel" }, "Draft"], ["2026-10-22", "Blog", "\t=1+1"]] } } });
  const calendarCard = page.locator(`[data-interactive="${calendar.id}"]`);
  await calendarCard.getByLabel("Draft publication date").fill("2026-10-20");
  await calendarCard.getByRole("combobox", { name: "Draft channel" }).click();
  await page.getByRole("option", { name: "Video", exact: true }).click();
  await until(async () => { const row = (await list()).find((row) => row.id === calendar.id); return row.values.date === "2026-10-20" && row.values.channel === "Video"; }, "draft calendar save");
  check("content calendar dates and channels update and save as drafts", (await calendarCard.locator("tbody").innerText()).includes("2026-10-20") && externalHits === 0);
  const calendarExport = page.waitForEvent("download");
  await calendarCard.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Export CSV", exact: true }).click();
  await (await calendarExport).saveAs(join(output, "calendar.csv"));
  check("CSV exports neutralize formulas after leading whitespace", readFileSync(join(output, "calendar.csv"), "utf8").includes("\"'\t=1+1\""));

  const customDefinition = { ...definition, title: "Custom simulation fixture", summary: "Accessible fallback: a worker doubles your monthly usage. This is illustrative and has no account connection.", view: { kind: "sandbox", html: "<p>Fallback</p>", css: "p{font-weight:bold}", js: "function render(inputs){return '<p>Worker result: '+(inputs.usage*2)+'</p><input data-perry-input=usage type=number value='+inputs.usage+'>'; }" } };
  const custom = await mcp("interactive_create", { requestId: "custom", definition: customDefinition });
  const customCard = page.locator(`[data-interactive="${custom.id}"]`);
  await customCard.waitFor();
  const frame = customCard.frameLocator("iframe");
  await frame.getByText("Worker result: 20").waitFor();
  await frame.locator("input").fill("17");
  await frame.locator("input").blur();
  await until(async () => (await list()).find((row) => row.id === custom.id).values.usage === 17, "typed sandbox bridge save");
  check("sandbox declared input bridge persists validated state", true);
  const beforeForgery = (await list()).find((row) => row.id === custom.id);
  await page.evaluate(({ id, revision }) => window.postMessage({ type: "perry:input", id, revision, nonce: "forged", input: "usage", value: 999 }, "*"), { id: custom.id, revision: beforeForgery.revision });
  await sleep(800);
  check("forged host-window sandbox messages cannot alter state", (await list()).find((row) => row.id === custom.id).values.usage === 17);
  const inside = await (await customCard.locator("iframe").elementHandle()).contentFrame();
  await inside.evaluate(() => {
    parent.postMessage({ ...identity, type: "perry:input", input: "secret", value: "unknown" }, hostOrigin);
    parent.postMessage({ ...identity, type: "perry:input", input: "usage", value: "x".repeat(2001) }, hostOrigin);
    parent.postMessage({ ...identity, type: "perry:input", revision: identity.revision - 1, input: "usage", value: 999 }, hostOrigin);
  });
  await sleep(750);
  check("actual iframe messages with unknown, oversized or stale inputs are rejected", (await list()).find((row) => row.id === custom.id).values.usage === 17);
  let customCurrent = (await list()).find((row) => row.id === custom.id);
  const customRevision = await mcp("interactive_update", { id: custom.id, expectedRevision: customCurrent.revision, requestId: "custom-compatible", definition: { ...customDefinition, summary: "Revised accessible fallback; selected inputs remain." } });
  check("custom code revision remounts and retains compatible inputs", customRevision.values.usage === 17);
  await customCard.frameLocator("iframe").getByText("Worker result: 34").waitFor();
  const incompatible = await mcp("interactive_update", { id: custom.id, expectedRevision: customRevision.revision, requestId: "custom-incompatible", definition: { ...customDefinition, inputs: [{ ...definition.inputs[0], max: 10 }] } });
  check("incompatible selected values reset to validated defaults", incompatible.values.usage === 10);
  // Generated JS itself probes the worker boundary; generated DOM event handlers probe the iframe CSP.
  const attack = { ...customDefinition, title: "Sandbox boundary fixture", view: { kind: "sandbox", html: "", css: `body{background-image:url(http://${siteHost}/css-leak)}`, js: `function render(inputs){let storage='blocked',dom='blocked';try{localStorage.getItem('perry.dashboard.key');storage='leaked';}catch{}try{parent.document.body;dom='leaked';}catch{}fetch('http://${siteHost}/fetch-leak').catch(()=>{});return '<p>storage '+storage+'; DOM '+dom+'</p><img src=http://${siteHost}/image-leak onerror=parent.postMessage({type:123},"*")><script>parent.document.body.innerHTML="owned"</script>';}` } };
  const attackArtifact = await mcp("interactive_create", { requestId: "boundary", definition: attack });
  const attackFrame = page.locator(`[data-interactive="${attackArtifact.id}"]`).frameLocator("iframe");
  await attackFrame.getByText("storage blocked; DOM blocked").waitFor();
  await sleep(500);
  check("actual worker/iframe cannot read host storage or send network requests", externalHits === 0);
  check("generated scripts and inline event handlers do not execute", await page.locator("body").innerText().then((text) => !text.includes("owned")));
  const loop = await mcp("interactive_create", { requestId: "infinite-loop", definition: { ...customDefinition, title: "Timeout fixture", view: { ...customDefinition.view, js: "while(true){}" } } });
  const loopCard = page.locator(`[data-interactive="${loop.id}"]`);
  await loopCard.getByRole("button", { name: "Retry rendering" }).waitFor();
  check("infinite loop terminates with accessible fallback and recovery", (await loopCard.innerText()).includes("Accessible fallback"));
  await loopCard.getByRole("button", { name: "Retry rendering" }).click();
  await loopCard.getByRole("button", { name: "Retry rendering" }).waitFor();
  const recover = await mcp("interactive_update", { id: loop.id, expectedRevision: (await list()).find((row) => row.id === loop.id).revision, requestId: "recover-code", definition: { ...customDefinition, title: "Recovered simulation" } });
  await loopCard.frameLocator("iframe").getByText("Worker result: 20").waitFor();
  check("failed renderer retries and recovers in the same artifact", recover.id === loop.id);

  await page.setViewportSize({ width: 390, height: 844 });
  await usage.focus();
  await page.keyboard.press("ArrowUp");
  await until(async () => (await list())[0].values.usage === 32, "keyboard number input");
  check("keyboard works at narrow width with reduced motion", await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches && document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, "mobile-reduced-motion.png"), fullPage: true });
  await card.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Reset", exact: true }).click();
  await until(async () => (await list())[0].values.usage === 10, "reset draft");
  await card.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await until(async () => (await list())[0].values.usage === 32, "undo draft");
  const downloadEvent = page.waitForEvent("download");
  await card.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Export CSV", exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(join(output, "comparison.csv"));
  check("reset, undo and table export complete", Boolean(download.suggestedFilename().endsWith(".csv")));
  await page.route("**/api/backend/call", async (route) => {
    if (route.request().postDataJSON()?.path === "interactive:save") await route.abort("failed");
    else await route.continue();
  });
  await usage.fill("35");
  await until(async () => (await card.innerText()).includes("Save failed"), "failed save notice");
  check("failed save preserves inputs and never displays success", await usage.inputValue() === "35" && (await list())[0].values.usage === 32);
  await page.unroute("**/api/backend/call");
  await card.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Save draft", exact: true }).click();
  await until(async () => (await list())[0].values.usage === 35, "save recovery");
  await usage.fill("32");
  await until(async () => (await list())[0].values.usage === 32, "restore test input");
  check("failed draft save recovers through explicit retry", true);

  // Finish the fixture runner turn; stopped turns cannot write more code.
  await call("dashboard:stopChat", { key, id: chat });
  const revisionBeforeStop = (await list())[0].revision;
  await assert.rejects(() => call("interactive:revise", { conversationId: chat, turnId, id: created.id, expectedRevision: revisionBeforeStop, requestId: "late-stopped", definition: JSON.stringify(definition) }));
  check("canceled generation cannot replace the last good draft", true);
  await call("codex:finishTurn", { token, id: turnId, stopped: true, response: "Fixture draft ready." });
  const revisionBeforeLate = (await list())[0].revision;
  await assert.rejects(() => call("interactive:revise", { conversationId: chat, turnId, id: created.id, expectedRevision: revisionBeforeLate, requestId: "late-finished", definition: JSON.stringify(definition) }));
  check("late events from finished turns cannot overwrite the artifact", true);
  await until(async () => !(await call("dashboard:getChat", { key, id: chat })).isRunning, "fixture finish");
  const savedBeforeRestart = (await list()).map(({ id, revision, values }) => ({ id, revision, values }));
  await stop();
  await start();
  check("server restart restores ids, revisions and selected inputs", JSON.stringify((await list()).map(({ id, revision, values }) => ({ id, revision, values }))) === JSON.stringify(savedBeforeRestart));
  await page.reload();
  await until(async () => await usage.inputValue() === "32", "browser reconnect restoration");
  check("browser reconnect restores the calculator", true);
  check("production browser has no uncaught errors", pageErrors.length === 0, pageErrors);

  current = (await list())[0];
  const followupArgs = { key, conversationId: chat, id: created.id, expectedRevision: current.revision, requestId: "draft-followup", text: "Add an illustrative option, retaining selected usage." };
  await call("interactive:followup", followupArgs, false);
  await call("interactive:followup", followupArgs, false);
  check("targeted draft follow-up retries are idempotent", (await list())[0].revision === current.revision + 1);
  let next;
  await until(async () => { next = (await call("codex:queuedTurns", { token })).find((t) => t.conversationId === chat); return Boolean(next); }, "draft follow-up queued", 90);
  check("follow-up carries target id/revision and starts under outside-read gate", next.prompt.includes(created.id) && Boolean(next.outsideAt));
  await call("codex:claimTurn", { token, id: next._id });
  await call("codex:finishTurn", { token, id: next._id, response: "Fixture follow-up draft ready." });
  await until(async () => !(await call("dashboard:getChat", { key, id: chat })).isRunning, "follow-up finished");
  await claim("Owner fixture asks for another local draft, without a source read.");
  assert.equal(await call("codex:outwardAllowed", { turnId }), true);
  current = (await list())[0];
  await call("interactive:followup", { ...followupArgs, expectedRevision: current.revision, requestId: "draft-steer" }, false);
  let steer;
  await until(async () => { steer = (await call("codex:pendingSteers", { token })).find((row) => row.turnId === turnId); return Boolean(steer); }, "draft steer");
  await call("codex:ackSteer", { token, id: steer._id, applied: true });
  check("applied artifact follow-up cannot count as approval to act outward", await call("codex:outwardAllowed", { turnId }) === false);
  check("draft steer blocks consequential connector action after application", (await mcp("run_action", { slug: "GMAIL_SEND_EMAIL", args: { to: "nobody@example.invalid" } })).refused === true);
  current = (await list())[0];
  await call("interactive:followup", { ...followupArgs, expectedRevision: current.revision, requestId: "draft-steer-queued" }, false);
  let failedSteer;
  await until(async () => { failedSteer = (await call("codex:pendingSteers", { token })).find((row) => row.turnId === turnId); return Boolean(failedSteer); }, "second draft steer");
  await call("codex:ackSteer", { token, id: failedSteer._id, applied: false, error: "Fixture steer cannot join" });
  const requeued = (await call("codex:queuedTurns", { token })).find((row) => row.prompt === failedSteer.prompt);
  check("requeued draft follow-up retains the server approval boundary", Boolean(requeued?.outsideAt));
  await call("dashboard:stopChat", { key, id: chat });
  await call("codex:finishTurn", { token, id: turnId, stopped: true, response: "Fixture done." });
  await until(async () => !(await call("dashboard:getChat", { key, id: chat })).isRunning, "steer fixtures finished");
  await stop();
  await start("0");
  check("feature flag hides existing interactive answers", (await list()).length === 0);
  await assert.rejects(() => call("interactive:save", { key, conversationId: chat, id: created.id, expectedRevision: current.revision, requestId: "disabled-write", operation: "reset" }, false));
  check("feature flag rejects writes", true);
  await stop();
  await start();
  await call("dashboard:deleteChat", { key, id: chat });
  await assert.rejects(() => list());
  const { DatabaseSync } = await import("node:sqlite");
  const sql = new DatabaseSync(join(home, "perry.sqlite"));
  const retained = sql.prepare("SELECT (SELECT count(*) FROM doc_interactiveAnswers) + (SELECT count(*) FROM doc_interactiveSources) AS n").get();
  sql.close();
  check("conversation deletion removes its artifacts and source receipts", retained.n === 0);
} catch (error) {
  checks.push({ name: "journey completed", pass: false, detail: error.stack });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop();
  await new Promise((done) => site.close(done));
  writeFileSync(join(output, "result.json"), JSON.stringify({ ranAt: new Date().toISOString(), platform: platform(), pass: checks.every((check) => check.pass), checks, browserDiagnostics: browserDiagnostics.slice(-20), limitations: ["Fixture data, no real connector account calls", "Simulated runner reports, no LLM-selection behavior evaluated", "macOS Chrome runtime only; no Windows runtime claim"], home }, null, 2));
  writeFileSync(join(output, "server.log"), serverLog);
}
