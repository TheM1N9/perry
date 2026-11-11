import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openChat, sleep } from "../browser.ts";

// The welcome page, in a real browser against a production build (`pnpm build` first), with no engine and no pet:
// the server is told what a pet would tell it.
//
// Ways it could fail, written down before the checks:
//   1. A new owner is still asked everything on one page, or sees a raw USER.md before the first chat.
//   2. The answers given are lost, or the rest is never asked for in the first chat.
//   3. The last step can be left without saying hello (a Continue there), or cannot be skipped at all.
//   4. The step ignores the pet: no way to turn him on, the wrong keys, or it never notices he heard you.
//   5. Coming back with a USER.md, saving replaces it unseen.
//   6. A new chat suggests several things at once, or "Not now" does not stick.
//   7. Starting a text chat requires personalization, voice or a desktop pet.
//   8. Optional setup interrupts a new chat, or hides a dismissed suggestion only until reopened.

const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "perry-welcome-ui-"));
const key = "synthetic-welcome-owner";
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "ab".repeat(32);
const report = { checks: {} };
const save = () => writeFileSync(join(output, "welcome.json"), JSON.stringify(report, null, 2));
let server;
let browser;
try {
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts")]);
  const database = new DatabaseSync(join(scratch, "perry.sqlite"));
  initializeCredentialEncryption(database, scratch);
  const runtime = new Runtime(database, schema, modules, { storageDir: join(scratch, "storage") });
  await runtime.stop();
  await runtime.exclusive(() => runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "pending", createdAt: Date.now() }));
  await runtime.stop();
  database.close();

  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: resolve("."), env: { ...process.env, PERRY_PORT: String(port), TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", PERRY_WAKE_DISABLED: "1" }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let serverLog = "";
  server.stderr.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-8_000); });
  let answered = false;
  for (let at = 0; at < 300 && !answered; at++) {
    if (server.exitCode !== null) throw new Error(`The server exited before answering (${server.exitCode}). Run pnpm build first.\n${serverLog}`);
    answered = await fetch(base).then((response) => response.ok, () => false);
    if (!answered) await sleep(100);
  }
  if (!answered) throw new Error(`The server did not answer in 30 seconds.\n${serverLog}`);
  const call = async (path, args = {}) => {
    const response = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args: { key, ...args } }) });
    const body = await response.json();
    if (body.error) throw new Error(`${path}: ${body.error}`);
    return body.value;
  };
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(base, key);
  const until = async (expression) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try { if (await browser.evaluate(`Boolean(${expression})`)) return; }
      catch (error) { if (!/navigated or closed|context was destroyed|Cannot find context|Cannot read properties of null/.test(String(error))) throw error; }
      await sleep(50);
    }
    throw new Error(`UI condition timed out: ${expression}\n${await browser.evaluate("document.body.innerText").catch(() => "")}`);
  };
  const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
  const button = (name) => `Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === ${JSON.stringify(name)})`;
  const click = async (name) => { await until(button(name)); await browser.evaluate(`${button(name)}.click()`); };
  const screenshot = async (name) => {
    await browser.evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
    await sleep(400);
    const shot = await browser.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(output, name), Buffer.from(shot.data, "base64"));
  };

  await browser.send("Page.navigate", { url: `${base}/welcome` });
  await until(has("Start with something useful"));
  report.checks.personalizationIsOptional = await browser.evaluate(`Boolean(${button("Start chatting")}) && Boolean(${button("Personalize first (optional)")}) && !document.querySelector('input[autocomplete=given-name]')`);
  await screenshot("text-first.png");
  await click("Start chatting");
  await until("/^\\/chat(?:\\/.*)?$/.test(location.pathname)");
  report.checks.textChatNeedsNoPet = true;
  await call("dashboard:redoOnboarding");
  await browser.send("Page.navigate", { url: `${base}/welcome` });
  await until(has("Start with something useful"));
  await click("Personalize first (optional)");
  await until(has("Meet your assistant"));
  report.checks.skipIsInTheCorner = await browser.evaluate("Boolean(document.querySelector('.welcome-escapes'))");
  await screenshot("meet.png");
  await click("Continue");

  // 1. Only what it needs to know now.
  await until("document.querySelector('h1,h2')?.innerText === 'About you' || " + has("What should I call you?"));
  report.checks.asksOnlyTwoThings = await browser.evaluate(`${has("What should I call you?")} && ${has("What do you want help with?")} && !${has("What do you do?")} && !${has("Anything I should never do?")}`);
  report.checks.saysTheRestComesLater = await browser.evaluate(has("will ask about the rest as you talk"));
  await browser.evaluate("(()=>{const input=document.querySelector('input[autocomplete=given-name]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Maya');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await browser.evaluate("document.querySelector('[role=group][aria-label=\"What you want help with\"] button').click()");
  await screenshot("about-you.png");
  await click("Continue");

  // 3, 4. No way on until he has heard you, but it can be skipped; first he has to be there.
  await until(has("Say hello to"));
  report.checks.noReviewForANewOwner = !await browser.evaluate(has("Your USER.md"));
  report.checks.offersToTurnHimOn = await browser.evaluate(`Boolean(${button("Put Perry on my desktop")})`);
  report.checks.noWayOnUntilHeard = await browser.evaluate("!Array.from(document.querySelectorAll('button')).some((item) => /^(Continue|Save and meet)/.test(item.textContent.trim()))");
  report.checks.canBeSkipped = await browser.evaluate(`Boolean(${button("Skip for now")})`);
  await screenshot("say-hello-no-pet.png");

  // He arrives, on the Talk keys in force.
  await call("todos:presence", { idleSeconds: 0, hotkey: "CommandOrControl+Shift+Space" });
  await until(has("say hi"));
  report.checks.showsTheRealKeys = await browser.evaluate("/Shift\\+Space|⇧⌘Space/.test(document.body.innerText)");
  report.checks.stillNoWayOnWhileWaiting = await browser.evaluate("!Array.from(document.querySelectorAll('button')).some((item) => /^(Continue|Save and meet)/.test(item.textContent.trim()))");
  await screenshot("say-hello-waiting.png");

  // He hears you: the way on appears, with something made of it.
  await call("pet:heardVoice");
  await until(has("Well done!"));
  report.checks.wayOnAppearsOnceHeard = await browser.evaluate("Array.from(document.querySelectorAll('button')).some((item) => /^Save and meet/.test(item.textContent.trim()))");
  await screenshot("say-hello-heard.png");
  await browser.evaluate("Array.from(document.querySelectorAll('button')).find((item) => /^Save and meet/.test(item.textContent.trim())).click()");
  await until("/^\\/chat\\/.+/.test(location.pathname)");

  // 2. What was said is kept, and the first chat asks for the rest.
  const persona = await call("dashboard:getPersona");
  report.checks.answersAreKept = /Maya/.test(persona.user);
  report.checks.firstChatAsksTheRest = (await call("dashboard:listChats")).some((chat) => chat.title === "Getting to know you");

  // 6. A new chat suggests one thing; Not now moves on.
  await browser.send("Page.navigate", { url: `${base}/chat` });
  await until(has("Optional setup: desktop, voice and calendar"));
  report.checks.optionalSetupStartsCollapsed = await browser.evaluate("!Array.from(document.querySelectorAll('details')).find((item) => item.querySelector('summary')?.textContent.includes('Optional setup:'))?.open");
  await browser.evaluate("Array.from(document.querySelectorAll('summary')).find((item) => item.textContent.includes('Optional setup:')).click()");
  await until(has("Connect your calendar"));
  report.checks.suggestsOneThing = await browser.evaluate(`!${has("Put Perry on your desktop")}`);
  await screenshot("next-step.png");
  await click("Not now");
  await until(`!${has("Connect your calendar")}`);
  await browser.send("Page.reload");
  await until("document.querySelector('#composer')");
  await until(has("Optional setup: desktop, voice and calendar"));
  await browser.evaluate("Array.from(document.querySelectorAll('summary')).find((item) => item.textContent.includes('Optional setup:')).click()");
  await sleep(1_000);
  report.checks.notNowSticks = !await browser.evaluate(has("Connect your calendar"));

  // 5. Coming back with a USER.md: the full questions and a review, since saving replaces it.
  await call("dashboard:redoOnboarding");
  await browser.send("Page.navigate", { url: `${base}/welcome` });
  await until(has("Meet your assistant"));
  report.checks.returningOwnerIsShownReview = await browser.evaluate(has("Review"));
  await click("Continue");
  await until(has("What do you do?"));
  report.checks.returningOwnerGetsAllQuestions = true;

  report.errors = browser.errors;
  assert.ok(Object.values(report.checks).every(Boolean), JSON.stringify(report.checks));
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  browser?.close();
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { server.kill(); await new Promise((done) => server.once("exit", done)); }
  }
  await sleep(500);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  report.scratchRemoved = !existsSync(scratch);
  report.passed = !report.error && report.scratchRemoved;
  save();
  console.log(JSON.stringify(report));
}
