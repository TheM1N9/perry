// Failure inventory and manually observed baseline: README.md. No runner or model.
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { perry, REPO } from "../engine-acp/harness";

const serve = process.argv.includes("--serve");
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "node_modules/.cache/page-recovery");
const app = await perry({ name: "page-recovery", outDir: output, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex"), CLAUDE_CONFIG_DIR: join(home, "empty-claude") }),
  env: { PERRY_EMBED_MODEL: "connector-fixture", PERRY_WAKE_DISABLED: "1", TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GROQ_API_KEY: "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(resolve("artifacts/connector-details/preload.mjs")).href}` } });
const { BASE, KEY, check, notes } = app;
const title = "Recovery fixture note", content = "Confirmed data survives recovery.";
let connected: any, page: any, browser: Awaited<ReturnType<typeof app.openBrowser>> | undefined;
let fault: { path: string; status: number; error: string; remaining?: number; retryAfter?: string } | undefined;
let beforeFaultResponse: (() => Promise<void>) | undefined;
const requests: Array<{ path: string; fault?: number }> = [];
const writes: Array<{ path: string; tables: string[] }> = [];
const retries: Array<{ name: string; before: number; after: number; elapsedMs: number; status: number }> = [];
const count = (path: string) => requests.filter(request => request.path === path).length;
const boundary = () => page.getByRole("heading", { name: "This page couldn't load", exact: true });
const noteLink = () => page.getByRole("link", { name: title, exact: true });
const library = () => page.getByRole("link", { name: "Library: files", exact: true });
const gotoBrain = async () => { await page.goto(`${BASE}/brain`); };
const recover = async (path: string, name: string) => {
  fault = undefined;
  const before = count(path), started = Date.now();
  const response = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === path, { timeout: 2_000 });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  const reply = await response, elapsedMs = Date.now() - started, after = count(path);
  retries.push({ name, before, after, elapsedMs, status: reply.status() });
  assert.equal(reply.status(), 200);
  assert.equal(after - before, 1, "retry must issue exactly one fresh query");
  assert.ok(elapsedMs < 2_000, `retry waited ${elapsedMs}ms`);
  await noteLink().waitFor(); await boundary().waitFor({ state: "hidden" });
  check(name, true);
};

let completed = false;
app.start("server");
try {
  await app.until(() => fetch(`${BASE}/api/backend/http/health`).then(r => r.ok), "production server");
  await app.call("dashboard:skipOnboarding", { key: KEY });
  const noteId = await app.call("notes:create", { key: KEY, title, content });
  const chatId = await app.call<string>("dashboard:createChat", { key: KEY });
  notes.build = readFileSync(join(REPO, ".next/BUILD_ID"), "utf8").trim();
  if (serve) {
    writeFileSync(join(output, "fixture.json"), JSON.stringify({ base: BASE, key: KEY }));
    console.log(`READY ${BASE}/brain#key=${KEY}; press Enter to stop (fixture setup only; recovery not assessed)`);
    await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); process.stdin.off("data", finish); process.stdin.pause(); done(); };
      const timer = setTimeout(finish, 15 * 60_000);
      process.stdin.once("data", finish);
    });
  } else {
    const { chromium } = await import(pathToFileURL(process.env.PERRY_E2E_PLAYWRIGHT ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")).href);
    browser = await app.openBrowser();
    connected = await chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`);
    page = connected.contexts()[0].pages().find((item: any) => item.url().startsWith(BASE));
    assert.ok(page);
    const pendingResponses = new Set<Promise<void>>();
    const responseReadFailures: Array<{ path: string; error: string }> = [];
    await page.route("**/api/backend/call", async (route: any) => {
      const path = route.request().postDataJSON().path, injected = fault && fault.path === path && (fault.remaining === undefined || fault.remaining > 0) ? fault : undefined;
      requests.push({ path, ...(injected ? { fault: injected.status } : {}) });
      if (injected?.remaining !== undefined) injected.remaining--;
      if (injected) {
        await beforeFaultResponse?.();
        return route.fulfill({ status: injected.status, contentType: "application/json", headers: injected.retryAfter ? { "retry-after": injected.retryAfter } : {}, body: JSON.stringify({ error: injected.error }) });
      }
      const pending = (async () => {
        const response = await route.fetch({ timeout: 5_000, maxRetries: 0, maxRedirects: 0 });
        try {
          const body = await response.json();
          if (body.writes?.length) writes.push({ path, tables: body.writes });
          await route.fulfill({ response });
        } finally { await response.dispose(); }
      })().catch(async error => {
        responseReadFailures.push({ path, error: String(error) });
        await route.abort();
      });
      pendingResponses.add(pending);
      void pending.finally(() => pendingResponses.delete(pending));
      return pending;
    });
    try {
      for (const status of [500, 502, 503, 504]) {
        const before = count("notes:list");
        fault = { path: "notes:list", status, error: "Synthetic temporary server failure", remaining: 1 };
        await gotoBrain(); await noteLink().waitFor({ timeout: 5_000 });
        assert.equal(await boundary().count(), 0);
        assert.equal(count("notes:list") - before, 2);
        check(`transientRead${status}RecoversWithoutBoundary`, true);
      }
      const beforeShell = count("dashboard:listChats");
      fault = { path: "dashboard:listChats", status: 500, error: "Synthetic temporary shared-shell failure", remaining: 1 };
      const shellRecovered = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === "dashboard:listChats" && reply.status() === 200, { timeout: 5_000 });
      await gotoBrain(); await shellRecovered; await noteLink().waitFor();
      assert.equal(await boundary().count(), 0);
      assert.equal(count("dashboard:listChats") - beforeShell, 2);
      check("transientSharedReadKeepsDashboardUsable", true);

      const beforeChat = count("dashboard:getChatMessages");
      fault = { path: "dashboard:getChatMessages", status: 500, error: "Synthetic temporary chat-history failure", remaining: 1 };
      const chatRecovered = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === "dashboard:getChatMessages" && reply.status() === 200, { timeout: 5_000 });
      await page.goto(`${BASE}/chat/${chatId}`); await chatRecovered; await page.locator("#composer").waitFor();
      assert.equal(await boundary().count(), 0);
      assert.equal(count("dashboard:getChatMessages") - beforeChat, 2);
      check("transientChatHistoryReadRestoresComposerWithoutBoundary", true);

      fault = { path: "notes:list", status: 500, error: "Synthetic failure before navigation", retryAfter: "2.137" };
      const beforeLeave = count("notes:list");
      beforeFaultResponse = () => page.evaluate(() => {
        const nativeTimeout = window.setTimeout;
        (window as any).__restoreNavigationTimer = () => { window.setTimeout = nativeTimeout; };
        window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: any[]) => {
          const timer = nativeTimeout(handler, delay, ...args);
          if (delay === 2_137) (window as any).__navigationRetryScheduled = true;
          return timer;
        }) as typeof window.setTimeout;
      });
      const failedBeforeLeave = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === "notes:list" && reply.status() === 500);
      try {
        await gotoBrain(); await (await failedBeforeLeave).finished();
        await page.waitForFunction(() => (window as any).__navigationRetryScheduled === true);
        assert.equal(count("notes:list") - beforeLeave, 1);
      } finally {
        beforeFaultResponse = undefined;
        await page.evaluate(() => {
          (window as any).__restoreNavigationTimer?.();
          delete (window as any).__restoreNavigationTimer;
          delete (window as any).__navigationRetryScheduled;
        });
      }
      await library().click(); await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
      const afterLeave = count("notes:list");
      await page.waitForTimeout(2_400);
      assert.equal(count("notes:list"), afterLeave);
      check("navigationCancelsPendingReadBackoff", true);

      for (const name of ["immediatePageRetryFetchesOnce", "repeatedPageRetryFetchesOnce"]) {
        const beforeFailure = count("notes:list");
        fault = { path: "notes:list", status: 500, error: "Synthetic page query failure" };
        await gotoBrain(); await boundary().waitFor();
        assert.equal(count("notes:list") - beforeFailure, 3);
        check(`${name}StopsAfterThreeFailedReads`, true);
        assert.ok(await library().isVisible()); check(`${name}KeepsSidebar`, true);
        await recover("notes:list", name);
      }
      fault = { path: "notes:list", status: 500, error: "Synthetic page query failure" };
      await gotoBrain(); await boundary().waitFor();
      await page.evaluate(() => { (window as any).__recoveryDocument = "same-document"; });
      await library().click();
      await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).__recoveryDocument), "same-document");
      await boundary().waitFor({ state: "hidden" });
      check("healthyClientNavigationClearsNativeBoundary", true);

      fault = { path: "notes:list", status: 404, error: "No public query named notes:list" };
      const beforeMissing = count("notes:list");
      await gotoBrain(); await boundary().waitFor();
      assert.equal(count("notes:list") - beforeMissing, 1);
      assert.ok(await page.getByText("Perry's server is running older code than this page. Restart Perry with perry update, then reload.", { exact: true }).isVisible());
      check("unknownFunctionExplainsServerUpdate", true);
      await recover("notes:list", "updatedServerPageRetriesImmediately");

      fault = { path: "dashboard:listChats", status: 500, error: "Synthetic shared-shell query failure" };
      await gotoBrain(); await boundary().waitFor();
      assert.ok(await page.getByRole("button", { name: "Try again", exact: true }).isVisible());
      assert.ok(await page.getByRole("button", { name: "Reload", exact: true }).isVisible());
      assert.equal(await library().count(), 0);
      assert.ok(await page.getByText("Perry's server returned an error. Try again, or reload the dashboard.", { exact: true }).isVisible());
      check("sharedShellFailureHasPerryRecoveryControls", true);
      await recover("dashboard:listChats", "immediateShellRetryFetchesOnce");

      fault = { path: "dashboard:listChats", status: 401, error: "The dashboard key does not match DASHBOARD_KEY" };
      await gotoBrain(); await page.getByRole("heading", { name: "That key was rejected", exact: true }).waitFor();
      assert.equal(await noteLink().count(), 0); assert.equal(await library().count(), 0);
      check("rejectedSharedKeyHidesPrivateContent", true);
      await page.getByRole("button", { name: "Unlock again", exact: true }).click();
      await page.getByRole("heading", { name: "Unlock Perry", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("perry.dashboard.key")), null);
      check("unlockAgainRemovesRememberedKey", true);
      fault = undefined;
      await page.getByLabel("Dashboard key", { exact: true }).fill("wrong-fixture-key");
      const rejected = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === "dashboard:getStatus");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      assert.equal((await rejected).status(), 401);
      await page.getByText("That key doesn't match this Perry. Copy it again and try once more.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("perry.dashboard.key")), null);
      assert.equal(await noteLink().count(), 0);
      check("wrongReplacementKeyIsRefusedWithoutUnlocking", true);
      const beforeUnlock = count("dashboard:getStatus");
      fault = { path: "dashboard:getStatus", status: 500, error: "Synthetic temporary unlock failure", remaining: 1 };
      await page.getByLabel("Dashboard key", { exact: true }).fill(KEY);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await noteLink().waitFor();
      assert.ok(count("dashboard:getStatus") > beforeUnlock);
      assert.equal(await page.evaluate(() => localStorage.getItem("perry.dashboard.key")), KEY);
      check("correctReplacementKeyFetchesAndRestoresContent", true);
      assert.equal(fault.remaining, 0);
      assert.ok(count("dashboard:getStatus") - beforeUnlock >= 2);
      check("unlockQueryRecoversFromTransientServerFailure", true);

      fault = { path: "notes:create", status: 500, error: "Synthetic failed owner write" };
      const beforeWrite = count("notes:create");
      await page.getByRole("button", { name: "New page", exact: true }).click();
      await page.getByText("Couldn't make it: Synthetic failed owner write", { exact: true }).waitFor();
      await page.waitForTimeout(1_500);
      assert.equal(count("notes:create") - beforeWrite, 1);
      check("failedOwnerMutationIsNeverAutomaticallyReplayed", true);
      fault = undefined;
      await Promise.all([...pendingResponses]);
      assert.deepEqual(responseReadFailures, [], "upstream response bodies must be inspected");
      notes.responseWrites = writes;
      assert.ok(writes.every(write => write.path === "jobs:setTimezone" || write.path === "dashboard:markChatSeen"), JSON.stringify(writes));
      assert.ok(!requests.some(request => /^(?:notes:(?!list|create)|dashboard:(?:sendChat|createChat))/.test(request.path)), JSON.stringify(requests));
      const finalNotes = await app.call<Array<{ id: string; title: string; preview: string }>>("notes:list", { key: KEY });
      const fixtureNotes = finalNotes.filter(note => note.title === title);
      assert.equal(fixtureNotes.length, 1); assert.equal(fixtureNotes[0].id, noteId);
      assert.match(fixtureNotes[0].preview, /Confirmed data survives recovery/);
      check("recoveryDoesNotReplayOwnerWritesOrDuplicateNotes", true);
      check("noRunnerOrModelWork", app.rows("codexTurns").length === 0 && app.rows("runners").every(row => !row.lastSeenAt));
      notes.browserErrors = browser.errors;
      await app.shot("recovered-brain.png", "main");
    } finally {
      await Promise.all([...pendingResponses]);
      notes.responseReadFailures = responseReadFailures;
    }
    assert.deepEqual(responseReadFailures, [], "response inspection must finish without failures");
    completed = true;
  }
} catch (error) {
  notes.stoppedAt = String(error);
  try { notes.visibleFailure = await page?.locator("body").innerText(); await app.shot("failure.png", "main"); } catch {}
  check("automatedJourneyCompleted", false, String(error));
} finally {
  notes.requests = requests; notes.retries = retries;
  await connected?.close().catch(() => {});
  process.exitCode = await app.finish({ mode: serve ? "manual-fixture-only" : "automated-browser-acceptance", acceptance: serve ? "not-run" : completed ? "completed" : "incomplete" }) ? 0 : 1;
}
