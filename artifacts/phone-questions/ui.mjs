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
const home = mkdtempSync(join(tmpdir(), "perry-phone-question-ui-"));
const key = "synthetic-phone-question-ui-owner";
const token = "synthetic-phone-question-ui-runner";
const owner = "15550001111@s.whatsapp.net";
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "be".repeat(32);
const report = { checks: {}, build: readFileSync(".next/BUILD_ID", "utf8").trim(), realMessagesSent: 0, modelTurnsStarted: 0 };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
let runtime, database, server, browser, phone;
try {
  // The native WhatsApp worker can only connect to this synthetic driver. It
  // never receives a connection-open event, so queued prompts stay inspectable.
  phone = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/next" ? "[]" : "{}");
  });
  await new Promise(resolve => phone.listen(0, "127.0.0.1", resolve));
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts"),
  ]);
  database = new DatabaseSync(join(home, "perry.sqlite"));
  initializeCredentialEncryption(database, home);
  runtime = new Runtime(database, schema, modules, { storageDir: join(home, "storage") });
  await runtime.stop();
  const native = async (path, args) => (await runtime.call(path, args, { internal: true })).value;
  runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now(), claimedAt: Date.now(), whatsappOwner: owner });
  runtime.store.insert("whatsappLink", { mode: "separate", wanted: true, status: "connected", me: "15550003333@s.whatsapp.net" });
  const runnerId = await native("runner:createToken", { token, name: "Question handoff fixture" });
  const thread = await native("agentStore:createThread", { userId: `whatsapp:${owner}`, title: "Question handoff" });
  const chat = await native("conversations:create", { channel: "whatsapp", externalId: owner, threadId: thread, title: "Question handoff" });
  const runId = runtime.store.insert("runs", { conversationId: chat, prompt: "Synthetic question handoff", status: "running", startedAt: Date.now() });
  const turn = runtime.store.insert("codexTurns", { runnerId, conversationId: chat, runId, prompt: "Synthetic question handoff", instructions: "Fixture only", status: "running", createdAt: Date.now(), startedAt: Date.now() });
  const options = [{ label: "Brief", description: "A short answer" }, { label: "Detailed", description: "Explain the reasoning" }];
  const questions = [
    { id: "format", header: "Format", question: "Which format should I use?", options },
    { id: "topic", header: "Topic", question: "What should I cover?", options: [] },
    { id: "draft", header: "Dashboard draft", question: "What should I keep in mind?", options: [] },
    { id: "incoming", header: "Incoming phone answer", question: "How much detail should I include?", options },
    { id: "finish", header: "Final answer", question: "What is the deadline?", options: [] },
  ];
  const id = await native("questions:request", { token, turnId: turn, nativeId: "synthetic-ui-batch", questions });
  const code = runtime.store.get(id).phone.code;
  const phoneAnswer = index => `/answer ${code}.${index}`;
  const accept = text => native("whatsapp:acceptOwner", { chatId: owner, text, stored: [] });
  await accept(`${phoneAnswer(1)} 2`);
  await accept(`${phoneAnswer(2)} Quarterly planning`);
  assert.deepEqual(await native("questions:response", { token, id }), {});
  report.checks.partialBatchDoesNotResumeRunner = true;
  const prompts = runtime.store.all("whatsappOutbox").filter(row => row.question?.id === id).map(row => row._id);
  const turnCount = runtime.store.all("codexTurns").length;
  await runtime.stop(); database.close(); runtime = null; database = null;

  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PERRY_PORT: String(port), PERRY_WHATSAPP_DRIVER: resolve("artifacts/whatsapp/fake-driver.mjs"), PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${phone.address().port}`, TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", GROQ_API_KEY: "", GEMINI_API_KEY: "", PERRY_WAKE_DISABLED: "1" },
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-16000); writeFileSync(join(output, "server.log"), log); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(base).then(response => response.ok, () => false)) break;
    if (server.exitCode !== null) throw Error(`Question UI server exited: ${log}`);
    await sleep(100);
  }
  const call = async (path, args) => {
    const response = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args }), signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    if (!response.ok || body.error) throw Error(`${path}: ${body.error ?? response.status}`);
    return body.value;
  };
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(base, key);
  const until = async expression => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { if (await browser.evaluate(`Boolean(${expression})`)) return; }
      catch (error) { if (!/navigated or closed|Execution context was destroyed|Cannot find context/.test(String(error))) throw error; }
      await sleep(50);
    }
    throw Error(`Question UI condition timed out: ${expression}`);
  };
  const field = question => `[data-native-questions] textarea[id="${id}-${question}"]`;
  const fieldset = index => `document.querySelectorAll('[data-native-questions] fieldset')[${index}]`;
  const button = (index, label) => `Array.from(${fieldset(index)}.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(label)})`;
  await browser.send("Page.navigate", { url: `${base}/chat/${chat}` });
  await until("document.querySelector('[data-native-questions]')");
  report.checks.phoneOptionSelectedOnMount = await browser.evaluate(`${button(0, "Detailed")}.getAttribute('aria-pressed') === 'true'`);
  report.checks.phoneFreeTextPopulatedOnMount = await browser.evaluate(`document.querySelector(${JSON.stringify(field("topic"))}).value === 'Quarterly planning'`);
  await browser.evaluate(`document.querySelector(${JSON.stringify(field("topic"))}).focus(); document.querySelector(${JSON.stringify(field("topic"))}).select()`);
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await until(`document.querySelector(${JSON.stringify(field("topic"))}).value === ''`);
  await browser.evaluate(`${button(0, "Brief")}.click()`);
  await browser.evaluate(`document.querySelector(${JSON.stringify(field("draft"))}).focus()`);
  await browser.send("Input.insertText", { text: "Local dashboard draft" });
  await call("whatsapp:acceptOwner", { chatId: owner, text: `${phoneAnswer(4)} 2`, stored: [] });
  await until(`${button(3, "Detailed")}.getAttribute('aria-pressed') === 'true'`);
  report.checks.incomingPhoneAnswerUpdatesMountedForm = true;
  report.checks.localDraftSurvivesIncomingAnswer = await browser.evaluate(`document.querySelector(${JSON.stringify(field("draft"))}).value === 'Local dashboard draft'`);
  report.checks.clearedPhoneTextStaysCleared = await browser.evaluate(`document.querySelector(${JSON.stringify(field("topic"))}).value === ''`);
  report.checks.localChoiceSurvivesIncomingAnswer = await browser.evaluate(`${button(0, "Brief")}.getAttribute('aria-pressed') === 'true' && ${button(0, "Detailed")}.getAttribute('aria-pressed') === 'false'`);
  assert.deepEqual(await call("questions:response", { token, id }), {});
  report.checks.mountedPartialBatchStillDoesNotResumeRunner = true;
  await browser.evaluate(`document.querySelector(${JSON.stringify(field("finish"))}).focus()`);
  await browser.send("Input.insertText", { text: "Friday afternoon" });
  report.checks.clearedPhoneAnswerDisablesContinue = await browser.evaluate("document.querySelector('[data-native-questions] button[type=submit]').disabled");
  await browser.evaluate(`document.querySelector(${JSON.stringify(field("topic"))}).focus()`);
  await browser.send("Input.insertText", { text: "Quarterly planning" });
  await until("document.querySelector('[data-native-questions] button[type=submit]')?.disabled === false");
  report.checks.mixedAnswersEnableContinue = true;
  await browser.evaluate("document.querySelector('[data-native-questions]').scrollTo({top:0,behavior:'instant'})");
  const screenshot = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, "dashboard-handoff.png"), Buffer.from(screenshot.data, "base64"));
  await browser.evaluate("document.querySelector('[data-native-questions] button[type=submit]').scrollIntoView({block:'nearest',behavior:'instant'})");
  const submitPoint = await browser.evaluate("(() => { const button = document.querySelector('[data-native-questions] button[type=submit]'); const box = button.getBoundingClientRect(); const x = box.left + box.width / 2, y = box.top + box.height / 2; return {x,y,reachable: box.top >= 0 && box.bottom <= innerHeight && button.contains(document.elementFromPoint(x,y))}; })()");
  report.checks.continueReachableInScrolledForm = submitPoint.reachable;
  assert.equal(submitPoint.reachable, true);
  const continueScreenshot = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, "dashboard-continue.png"), Buffer.from(continueScreenshot.data, "base64"));
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: submitPoint.x, y: submitPoint.y, button: "left", clickCount: 1 });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: submitPoint.x, y: submitPoint.y, button: "left", clickCount: 1 });
  await until("!document.querySelector('[data-native-questions]')");
  report.checks.completedQuestionDisappears = true;
  assert.deepEqual(await call("questions:response", { token, id }), { answers: { format: ["Brief"], topic: ["Quarterly planning"], draft: ["Local dashboard draft"], incoming: ["Detailed"], finish: ["Friday afternoon"] } });
  report.checks.mixedAnswersReachOriginalRunner = true;
  for (const prompt of prompts) assert.equal(await call("whatsapp:reserveMessageId", { id: prompt }), null);
  report.checks.completedBatchRevokesQueuedPrompts = true;
  const messages = await call("agentStore:listMessages", { threadId: thread, paginationOpts: { numItems: 20, cursor: null } });
  assert.equal(messages.page.filter(row => row.message.content.startsWith("Answers to Perry's questions:")).length, 1);
  report.checks.oneAnswerHistoryEntry = true;

  const reviewQuestions = [
    { id: "multi", header: "Multiple choices", question: "Which formats?", options, multiple: true },
    { id: "hold", header: "Review context", question: "Anything else?", options: [] },
  ];
  const reviewId = await call("questions:request", { token, turnId: turn, nativeId: "synthetic-review-multi", questions: reviewQuestions });
  const pending = (await call("questions:pending", { key, conversationId: chat })).find(row => row._id === reviewId);
  await call("whatsapp:acceptOwner", { chatId: owner, text: `/answer ${pending.phone.code}.1 Custom response`, stored: [] });
  const reviewField = `[data-native-questions] textarea[id="${reviewId}-multi"]`;
  await until(`document.querySelector(${JSON.stringify(reviewField)})?.value === 'Custom response'`);
  await browser.evaluate(`${button(0, "Brief")}.click()`);
  await browser.evaluate(`${button(0, "Detailed")}.click()`);
  report.checks.multiChoicePreservesOtherSelectedOptions = await browser.evaluate(`${button(0, "Brief")}.getAttribute('aria-pressed') === 'true' && ${button(0, "Detailed")}.getAttribute('aria-pressed') === 'true'`);
  await browser.evaluate(`${button(0, "Brief")}.click()`);
  report.checks.switchingCustomAnswerClearsVisibleText = await browser.evaluate(`document.querySelector(${JSON.stringify(reviewField)}).value === ''`);
  await browser.evaluate(`document.getElementById('${reviewId}-hold').focus()`);
  await browser.send("Input.insertText", { text: "Keep the chosen option" });
  await browser.evaluate("document.querySelector('[data-native-questions] button[type=submit]').click()");
  await until("!document.querySelector('[data-native-questions]')");
  const reviewResponse = await call("questions:response", { token, id: reviewId });
  report.checks.noHiddenCustomAnswerSubmitted = JSON.stringify(reviewResponse) === JSON.stringify({ answers: { multi: ["Detailed"], hold: ["Keep the chosen option"] } });

  const namedQuestions = [
    { id: "constructor", header: "Constructor", question: "Choose formats", options, multiple: true },
    { id: "toString", header: "Text answer", question: "Give context", options: [] },
    { id: "__proto__", header: "Last choices", question: "Choose more formats", options, multiple: true },
  ];
  const namedId = await call("questions:request", { token, turnId: turn, nativeId: "synthetic-review-prototype-names", questions: namedQuestions });
  await until(`document.getElementById('${namedId}-constructor')`);
  report.checks.inheritedPropertyIdsRenderAsUnanswered = await browser.evaluate(`Array.from(document.querySelectorAll('[data-native-questions] textarea')).every(input => input.value === '') && document.querySelector('[data-native-questions] button[type=submit]').disabled`);
  await browser.evaluate(`${button(0, "Brief")}.click()`);
  await browser.evaluate(`${button(0, "Detailed")}.click()`);
  await browser.evaluate(`document.getElementById('${namedId}-toString').focus()`);
  await browser.send("Input.insertText", { text: "Own text answer" });
  await browser.evaluate(`${button(2, "Detailed")}.click()`);
  await browser.evaluate("document.querySelector('[data-native-questions] button[type=submit]').click()");
  await until("!document.querySelector('[data-native-questions]')");
  assert.deepEqual(await call("questions:response", { token, id: namedId }), { answers: { constructor: ["Brief", "Detailed"], toString: ["Own text answer"], ["__proto__"]: ["Detailed"] } });
  report.checks.inheritedPropertyIdsSubmitOwnValues = true;
  report.errors = browser.errors;
  report.checks.noUncaughtBrowserErrors = browser.errors.length === 0;
  const saved = new DatabaseSync(join(home, "perry.sqlite"));
  try { report.checks.noNewTurn = saved.prepare("SELECT count(*) AS count FROM doc_codexTurns").get().count === turnCount; }
  finally { saved.close(); }
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  browser?.close();
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { server.kill(); await new Promise(resolve => server.once("exit", resolve)); }
  }
  await runtime?.stop(); database?.close();
  if (phone) { phone.closeAllConnections(); await new Promise(resolve => phone.close(resolve)); }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  report.homeRemoved = !existsSync(home);
  report.passed = !report.error && report.homeRemoved && Object.values(report.checks).every(Boolean);
  save();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, homeRemoved: report.homeRemoved, error: report.error }));
  if (!report.passed) process.exitCode = 1;
}
