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
const home = mkdtempSync(join(tmpdir(), "perry-pet-reminders-"));
const key = "synthetic-pet-reminders-key";
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "a9".repeat(32);
const report = { build: readFileSync(".next/BUILD_ID", "utf8").trim(), checks: {}, realNotifications: 0, modelTurnsStarted: 0 };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
let runtime, database, server, browser;
try {
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts"),
  ]);
  database = new DatabaseSync(join(home, "perry.sqlite"));
  initializeCredentialEncryption(database, home);
  runtime = new Runtime(database, schema, modules, { storageDir: join(home, "storage") });
  await runtime.stop();
  runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now(), claimedAt: Date.now(), timezone: "UTC" });
  await runtime.stop(); database.close(); runtime = null; database = null;
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PERRY_PORT: String(port), TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", GROQ_API_KEY: "", GEMINI_API_KEY: "", PERRY_WAKE_DISABLED: "1" },
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-16000); writeFileSync(join(output, "server.log"), log); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(base).then(response => response.ok, () => false)) break;
    if (server.exitCode !== null) throw Error(`Reminder fixture server exited: ${log}`);
    await sleep(100);
  }
  const call = async (path, args) => {
    const response = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args }), signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    if (!response.ok || body.error) throw Error(`${path}: ${body.error ?? response.status}`);
    return body.value;
  };
  const ids = [];
  const add = async (title, dueAt) => {
    const id = await call("todos:add", { key, title, dueAt }); ids.push(id);
    if (browser) await browser.evaluate(`window.__reminders.watch(${JSON.stringify(ids)})`);
    return id;
  };
  const edit = (id, dueAt) => call("todos:edit", { key, id, dueAt });
  const done = id => call("todos:setDone", { key, id, done: true });
  const clock = Date.now();
  const initialDue = clock + 14 * 60_000;
  const headId = await add("Synthetic heads-up retention", initialDue);
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(base, key);
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const ids = new Set(${JSON.stringify(ids)}), heads = new Set(), notices = new Set(), ticks = new Map();
    const nativeSet = Map.prototype.set, nativeAdd = Set.prototype.add;
    let constructing = 0;
    window.Map = new Proxy(Map, { construct(target, args, receiver) {
      constructing++;
      try { return Reflect.construct(target, args, receiver); }
      finally { constructing--; }
    } });
    const originalInterval = window.setInterval.bind(window), originalClear = window.clearInterval.bind(window);
    const originalNow = Date.now;
    let now = ${clock}, permission = 'granted';
    const match = key => typeof key === 'string' && Array.from(ids).some(id => key === id || key.startsWith(id + ':'));
    Map.prototype.set = function(key, value) {
      if (!constructing && typeof key === 'string') {
        if (typeof value === 'number' && /^[a-z0-9]{26}:\\d+:(10|15)$/.test(key)) nativeAdd.call(heads, this);
        else if (typeof value === 'number' && /^[a-z0-9]{26}$/.test(key)) nativeAdd.call(notices, this);
        else if (value && typeof value.dueAt === 'number' && value.steps instanceof Map) nativeAdd.call(heads, this);
      }
      return nativeSet.call(this, key, value);
    };
    Set.prototype.add = function(key) {
      if (typeof key === 'string' && /^[a-z0-9]{26}:\\d+$/.test(key)) nativeAdd.call(notices, this);
      return nativeAdd.call(this, key);
    };
    Date.now = () => now;
    const delivered = [];
    window.Notification = class {
      static get permission() { return permission; }
      constructor(title, options) { delivered.push({ title, ...options, at: now }); }
    };
    window.setInterval = (fn, ms, ...args) => {
      const id = originalInterval(fn, ms, ...args);
      if (ms === 1000 && typeof fn === 'function') ticks.set(id, () => fn(...args));
      return id;
    };
    window.clearInterval = id => { ticks.delete(id); originalClear(id); };
    const entries = cache => Array.from(cache.entries()).filter(([key]) => match(key));
    window.__reminders = {
      watch(values) { for (const id of values) ids.add(id); },
      tick(at) { now = at; for (const run of ticks.values()) run(); },
      permission(value) { permission = value; },
      snapshot() { return { heads: Array.from(heads).flatMap(entries).map(([key,value]) => ({ key, dueAt: value?.dueAt, steps: value?.steps instanceof Map ? Array.from(value.steps) : undefined })), notices: Array.from(notices).flatMap(cache => Array.from(cache.keys()).filter(match)), delivered: [...delivered], clock: now, ticks: ticks.size }; },
      saw(id, dueAt) { return Array.from(heads).some(cache => cache.has(id + ':' + dueAt + ':15') || cache.get(id)?.dueAt === dueAt); },
      originalNow,
    };
  })()` });
  await browser.send("Page.navigate", { url: `${base}/pet#key=${encodeURIComponent(key)}` });
  const until = async (expression, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await browser.evaluate(`Boolean(${expression})`)) return; }
      catch (error) { if (!/navigated or closed|Execution context was destroyed|Cannot find context/.test(String(error))) throw error; }
      await sleep(50);
    }
    throw Error(`Reminder condition timed out: ${expression}`);
  };
  const tick = async at => { await browser.evaluate(`window.__reminders.tick(${at})`); await sleep(100); };
  const settled = async expression => {
    try { await until(expression, 3000); return true; }
    catch (error) { if (String(error).includes("Reminder condition timed out:")) return false; throw error; }
  };
  const snapshot = () => browser.evaluate("window.__reminders.snapshot()");
  const waitHead = async (id, dueAt) => until(`window.__reminders.saw(${JSON.stringify(id)},${dueAt})`);
  await waitHead(headId, initialDue);
  await until("document.body.innerText.includes('Psst: Synthetic heads-up retention')");
  report.checks.initialHeadsUpVisible = await browser.evaluate("document.body.innerText.includes('Psst: Synthetic heads-up retention')");
  for (let revision = 1; revision <= 25; revision++) {
    const dueAt = initialDue + revision * 1000;
    await edit(headId, dueAt);
    await waitHead(headId, dueAt);
  }
  report.headsAfterReschedules = (await snapshot()).heads;
  report.checks.headsUpRetainedOnlyForCurrentTodo = report.headsAfterReschedules.length === 1;
  await browser.evaluate("window.__reminders.permission('denied')");
  await edit(headId, null); await sleep(300); await tick(clock + 1000);
  report.checks.untimedTodoPrunedWithoutNotificationPermission = await settled("window.__reminders.snapshot().heads.length === 0");
  await done(headId);

  await browser.evaluate("window.__reminders.permission('granted')");
  let dueAt = clock + 30 * 60_000;
  const noticeId = await add("Synthetic notification retention", dueAt);
  for (let revision = 0; revision < 25; revision++) {
    dueAt = clock + (30 + revision) * 60_000;
    if (revision) await edit(noticeId, dueAt);
    await tick(dueAt + 1);
    await until(`window.__reminders.snapshot().delivered.length === ${revision + 1}`);
  }
  const notified = await snapshot();
  report.checks.rescheduledDueTimeNotifiesAgain = notified.delivered.length === 25;
  report.noticesAfterReschedules = notified.notices;
  report.checks.notificationsRetainedOnlyForCurrentTodo = notified.notices.length === 1;
  await tick(dueAt + 2000); await tick(dueAt + 3000);
  report.checks.unchangedDueTimeNotifiesOnlyOnce = (await snapshot()).delivered.length === 25;
  await browser.evaluate("window.__reminders.permission('denied')");
  await done(noticeId); await sleep(300); await tick(dueAt + 4000);
  report.checks.completedTodoPrunedWithoutNotificationPermission = await settled("window.__reminders.snapshot().notices.length === 0");
  report.noticesAfterCompletion = (await snapshot()).notices;

  // Start the heads-up UI phase with a fresh Motion timeline after the long
  // notification clock advances; retained-cache checks above stay in the report.
  await browser.send("Page.navigate", { url: `${base}/pet?phase=heads#key=${encodeURIComponent(key)}` });
  await until(`window.__reminders?.snapshot().clock === ${clock} && document.querySelector('main button[data-state]')`);
  await browser.evaluate(`window.__reminders.watch(${JSON.stringify(ids)})`);
  const dismissDue = clock + 14 * 60_000;
  const dismissId = await add("Synthetic dismissed heads-up", dismissDue);
  await waitHead(dismissId, dismissDue);
  await until("document.body.innerText.includes('Psst: Synthetic dismissed heads-up') && document.querySelector('button[aria-label=Hide]')");
  await browser.evaluate("window.__reminders.staleClose = (() => { const button = document.querySelector('button[aria-label=Hide]'); const key = Object.keys(button).find(key => key.startsWith('__reactProps$')); return button[key].onClick; })()");
  await browser.evaluate("document.querySelector('button[aria-label=Hide]').click()");
  await tick(clock + 1000);
  await until("!document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  report.checks.dismissedFifteenMinuteHeadsUpStaysHidden = await browser.evaluate("!document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  await tick(dismissDue - 9 * 60_000);
  await until("document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  await browser.evaluate("document.querySelector('button[aria-label=Hide]').click()");
  await tick(clock + 2000);
  await until("!document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  report.checks.dismissedHeadsUpSurvivesClockRollback = await browser.evaluate("!document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  await tick(dismissDue - 9 * 60_000 + 1000);
  report.checks.dismissedTenMinuteHeadsUpStaysHidden = await browser.evaluate("!document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  await tick(clock);
  const movedDue = clock + 13 * 60_000;
  await edit(dismissId, movedDue); await waitHead(dismissId, movedDue);
  await until("document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  report.checks.rescheduledHeadsUpDoesNotInheritDismissal = await browser.evaluate("document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  await browser.evaluate("window.__reminders.staleClose({stopPropagation(){}})");
  await tick(clock + 1000);
  report.checks.staleHideDoesNotDismissRescheduledHeadsUp = await browser.evaluate("document.body.innerText.includes('Psst: Synthetic dismissed heads-up')");
  await call("todos:remove", { key, id: dismissId }); await sleep(300); await tick(clock + 3000);
  report.checks.deletedTodoLeavesNoReminderCache = await settled("window.__reminders.snapshot().heads.length === 0");

  await browser.evaluate("window.__reminders.permission('denied')");
  const a = await add("Synthetic independent A", clock - 1000), b = await add("Synthetic independent B", clock - 1000);
  await sleep(300);
  await tick(clock + 4000);
  const denied = await snapshot();
  report.checks.deniedPermissionDoesNotRecordNotifications = denied.delivered.length === 0 && denied.notices.length === 0;
  await browser.evaluate("window.__reminders.permission('granted')");
  await tick(clock + 4500);
  await until("window.__reminders.snapshot().delivered.length === 2");
  await done(a); await sleep(300); await tick(clock + 5000);
  await settled(`window.__reminders.snapshot().notices.length === 1`);
  const remaining = await snapshot();
  report.checks.pruningOneTodoKeepsAnother = remaining.notices.length === 1 && remaining.notices[0] === b;
  report.checks.unrelatedBoardUpdateDoesNotRenotify = remaining.delivered.length === 2;
  await call("todos:remove", { key, id: b }); await sleep(300); await tick(clock + 6000);
  report.checks.emptyBoardClearsReminderCaches = await settled("window.__reminders.snapshot().heads.length === 0 && window.__reminders.snapshot().notices.length === 0");
  report.errors = browser.errors;
  report.checks.noUncaughtBrowserErrors = browser.errors.length === 0;
  const shot = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, "pet.png"), Buffer.from(shot.data, "base64"));
} catch (error) {
  report.error = String(error.stack ?? error);
  if (browser) report.page = await browser.evaluate("document.body.innerText").catch(() => null);
} finally {
  browser?.close();
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { server.kill(); await new Promise(resolve => server.once("exit", resolve)); }
  }
  await runtime?.stop(); database?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  report.homeRemoved = !existsSync(home);
  report.passed = !report.error && report.homeRemoved && Object.values(report.checks).every(Boolean);
  save();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, homeRemoved: report.homeRemoved, error: report.error }));
  if (!report.passed) process.exitCode = 1;
}
