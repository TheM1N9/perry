// Inventory: failure-cases.md. Actual production browser/HTTP/SQLite, synthetic worker metadata, no engine process.
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { perry, REPO } from "../engine-acp/harness";
import { boardLink } from "../../lib/board-links";

const output = process.argv[2];
if (!output) throw Error("Pass an output directory");
const p = await perry({ name: "task-presence-browser", outDir: output, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex"), CLAUDE_CONFIG_DIR: join(home, "empty-claude") }), env: {
  PERRY_EMBED_MODEL: "connector-fixture", PERRY_WAKE_DISABLED: "1", TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GROQ_API_KEY: "",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(REPO, "artifacts/connector-details/preload.mjs")).href}`,
} });
const { BASE, KEY, notes, check, call, until } = p;
let connected: any, page: any, browser: Awaited<ReturnType<typeof p.openBrowser>> | undefined;
const token = "synthetic-browser-presence-runner";
const task = (id: string) => p.rows("tasks").find(row => row._id === id)!;
const board = () => call<any>("board:get", { key: KEY });
const open = async (id: string) => { await page.goto(BASE + boardLink({ channel: "tasks", tab: "all", thread: `task:${id}` })); await page.locator(`[data-pane="task:${id}"]`).waitFor(); };
const pane = () => page.locator("[data-pane]");
const update = () => pane().getByRole("textbox", { name: "Update instructions", exact: true });
const row = (id: string) => page.locator(`[data-row="task:${id}"]`);
const setTurns = (id: string) => p.sql('UPDATE doc_tasks SET doc = json_set(doc, \'$.turns\', 1) WHERE _id = ?', [id]);
const create = (title: string, origin?: string) => call<string>("work:createTask", { title, prompt: "Preserve this synthetic unfinished comparison plan.", ...(origin ? { origin } : {}) });
let ok = false;
try {
  p.start("server"); await until(() => fetch(BASE + "/api/backend/http/health").then(reply => reply.ok, () => false), "production server", 90);
  await call("dashboard:skipOnboarding", { key: KEY });
  const source = await call<string>("dashboard:createChat", { key: KEY });
  const tracked = await create("Tracked plan with source", source);
  const idle = await create("Unfinished without worker"); await call("tasks:chatFor", { id: idle, threadId: "presence-idle" }); setTurns(idle);
  const live = await create("Genuinely claimed comparison"); await call("tasks:chatFor", { id: live, threadId: "presence-live" }); setTurns(live);
  await call("work:setPlan", { taskId: live, plan: [{ title: "Collected inputs", status: "done" }, { title: "Unfinished comparison", status: "active" }] });
  await call("runner:createToken", { name: "Synthetic browser worker", token });
  await call("runner:checkIn", { token, activeTurnIds: [] });
  await call("codex:reportAccount", { token, available: true, authMode: "chatgpt" });
  const chat = task(live).conversationId;
  const run = await call<string>("runs:start", { conversationId: chat, prompt: "Synthetic comparison execution." });
  const turn = await call<string>("codex:enqueueTurn", { conversationId: chat, runId: run, prompt: "Synthetic comparison execution.", instructions: "No external calls.", engine: "codex" });
  assert.ok(await call("codex:claimTurn", { token, id: turn }));
  notes.build = readFileSync(join(REPO, ".next/BUILD_ID"), "utf8").trim();
  browser = await p.openBrowser();
  const { chromium } = await import(pathToFileURL(process.env.PERRY_E2E_PLAYWRIGHT ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")).href);
  connected = await chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`);
  page = connected.contexts()[0].pages().find((item: any) => item.url().startsWith(BASE)); assert.ok(page);
  await open(tracked);
  await pane().getByText("tracked", { exact: true }).waitFor();
  assert.equal(await row(tracked).getAttribute("data-status"), "blocked");
  assert.equal(await row(tracked).locator('[class*="animate-pulse"]').count(), 0);
  assert.equal(await update().count(), 0);
  const sourceLink = pane().getByRole("link", { name: "open source chat", exact: true });
  assert.equal(await sourceLink.getAttribute("href"), `/chat/${source}`);
  assert.equal(task(tracked).conversationId, undefined); assert.equal(task(tracked).status, "running");
  check("trackedPlanIsNonpulsingWithReviewOnlySourceLink", true);
  await open(idle); await pane().getByText("not running", { exact: true }).waitFor();
  await pane().locator("[data-task-presence]").filter({ hasText: "unfinished and has no active turn" }).waitFor();
  assert.equal(await update().count(), 0); assert.equal(task(idle).status, "running");
  assert.equal(await pane().getByRole("link", { name: "open chat", exact: true }).getAttribute("href"), `/chat/${task(idle).conversationId}`);
  await pane().getByRole("button", { name: "More", exact: true }).click();
  const cancelTask = page.getByRole("menuitem", { name: "cancel task", exact: true });
  await cancelTask.waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.press("Escape");
  await cancelTask.waitFor({ state: "hidden", timeout: 5_000 });
  check("unfinishedTaskHasReviewAndCancellationWithoutUnusableSteering", true);
  await open(live); await pane().getByText("working", { exact: true }).waitFor(); await update().waitFor();
  assert.equal(await row(live).getAttribute("data-status"), "working");
  check("authenticatedClaimedWorkerKeepsWorkingAndOwnerComposer", true);
  const response = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === "tasks:steerFromDashboard");
  await update().fill("Use the collected inputs and preserve completed work."); await update().press("Enter"); assert.equal((await response).status(), 200);
  await until(() => Boolean(task(live).steering?.length), "owner update recorded");
  await until(async () => await update().inputValue() === "", "owner update accepted");
  assert.equal(task(live).steering.length, 1);
  assert.equal((await board()).threads.find((thread: any) => thread.id === `task:${live}`).status, "working");
  assert.ok(await update().isVisible());
  check("newSteeringReceiptDoesNotHideCurrentExecutingWorker", true);
  await page.screenshot({ path: join(output, "live-worker.png") });
  const delivering = await create("Worker result being delivered"); await call("tasks:chatFor", { id: delivering, threadId: "presence-delivering" }); setTurns(delivering);
  await call("work:setPlan", { taskId: delivering, plan: [{ title: "Collected inputs", status: "done" }, { title: "Unfinished comparison", status: "active" }] });
  const deliveryChat = task(delivering).conversationId;
  const deliveryRun = await call<string>("runs:start", { conversationId: deliveryChat, prompt: "Synthetic delivery phase." });
  const deliveryTurn = await call<string>("codex:enqueueTurn", { conversationId: deliveryChat, runId: deliveryRun, prompt: "Synthetic delivery phase.", instructions: "No external calls.", engine: "codex" });
  assert.ok(await call("codex:claimTurn", { token, id: deliveryTurn }));
  await call("codex:traceTurn", { token, id: deliveryTurn, spans: [{ callId: "presence-delivery-step", kind: "command", name: "fixture comparison", status: "running", startedAt: Date.now() }] });
  await call("runner:checkIn", { token, activeTurnIds: [turn, deliveryTurn] });
  // Stable delivery precondition; the separate protocol proof executes authenticated finishTurn.
  p.sql('UPDATE doc_codexTurns SET doc = json_set(doc, \'$.status\', \'done\', \'$.response\', \'Synthetic worker result awaiting delivery\', \'$.finishedAt\', ?) WHERE _id = ?', [Date.now(), deliveryTurn]);
  await open(delivering); await pane().getByText("finishing", { exact: true }).waitFor();
  await pane().locator("[data-task-presence]").filter({ hasText: "result is being saved and delivered" }).waitFor();
  const steps = pane().locator("[data-tool-group]"); await steps.waitFor(); await steps.getByRole("button").first().click();
  await pane().locator("[data-work-steps]").waitFor();
  assert.equal(await pane().getByText(/Waiting for your computer to reconnect/).count(), 0);
  assert.equal(await update().count(), 0); assert.equal(await row(delivering).locator('[class*="animate-pulse"]').count(), 0);
  assert.equal(task(delivering).status, "running"); assert.equal(task(delivering).plan[0].status, "done");
  check("pendingDeliveryIsNonpulsingAndRetainsPlanWithoutSteering", true);
  await page.screenshot({ path: join(output, "finishing-worker.png") });
  notes.tasks = [task(tracked), task(idle), task(live), task(delivering)]; notes.board = await board(); notes.browserErrors = browser.errors;
  assert.equal(browser.errors.length, 0); assert.equal(p.logs.runner, "");
  check("noBrowserErrorsOrEngineProcess", true); ok = true;
} catch (error) {
  notes.stoppedAt = String(error); notes.tasks = p.rows("tasks");
  try { notes.failureState = await page?.locator("body").innerText(); await page?.screenshot({ path: join(output, "failure.png") }); } catch {}
  check("journeyCompleted", false, String(error));
} finally { await connected?.close().catch(() => {}); }
process.exitCode = await p.finish({ ok, mode: "synthetic-production-browser" }) ? 0 : 1;
