// Failure inventory: failure-cases.md. Production dashboard, real Runtime/SQLite and isolated Chrome.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { perry, REPO } from "../engine-acp/harness";

const output = process.argv[2];
if (!output) throw Error("Pass an output directory");
const out = resolve(output);
const preload = pathToFileURL(join(REPO, "artifacts/connector-details/preload.mjs")).href;
const p = await perry({ name: "board-kanban", outDir: out, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex"), CLAUDE_CONFIG_DIR: join(home, "empty-claude") }), env: {
  PERRY_EMBED_MODEL: "connector-fixture", PERRY_WAKE_DISABLED: "1", TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GROQ_API_KEY: "",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`,
} });
const { BASE, KEY, notes, check, call, until } = p;
let page: any, connected: any, browser: Awaited<ReturnType<typeof p.openBrowser>> | undefined;
let fixture: { queued: string[]; done: string[]; project: string; token: string; blocked: string; tracked: string; waiting: string; failed: string; live: string; turn: string; child: string; questionTurn: string; remoteThread: string; approval: string; doneParent: string; waitingChild: string; childTurn: string; childRun: string; childApproval: string; mixedFirst: string; mixedSecond: string; mixedChat: string; questionRun: string; childSpan: string; finishedChild: string; finishedRun: string };
const errors: string[] = [];
const verify = async (name: string, run: () => Promise<void>) => {
  try { await call("runner:checkIn", { token: fixture.token, activeTurnIds: [fixture.turn, fixture.childTurn, fixture.questionTurn] }); await run(); check(name, true); }
  catch (error) {
    check(name, false, String(error));
    try {
      notes[`${name}State`] = await page.evaluate(() => ({ address: location.href, active: document.activeElement?.outerHTML, activeInertAncestor: document.activeElement?.closest("[inert], [aria-hidden=true]")?.outerHTML.slice(0, 800), main: document.querySelector("[data-board] main")?.outerHTML.slice(0, 500) }));
      await shot(`failure-${name}`);
    } catch {}
  }
};
const params = () => new URL(page.url()).searchParams;
const column = (status: string) => page.locator(`[data-kanban-column="${status}"]`);
const card = (id: string) => page.locator(`[data-card="${id}"]`);
const cardLink = (id: string) => card(id).locator(":scope > a");
const pane = () => page.locator("[data-pane]");
const go = async (query: Record<string, string> = {}) => { await page.goto(`${BASE}/board?${new URLSearchParams(query)}`); await page.locator("[data-board]").waitFor(); };
const shot = async (name: string) => {
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
};
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Board must not create page-wide horizontal overflow");
const columnColors = async () => {
  const colors = await page.locator("[data-kanban-column]").evaluateAll((columns: HTMLElement[]) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const channels = [...context.getImageData(0, 0, 1, 1).data];
      if (channels[3] !== 255) throw Error("Measure colors on an opaque rendered surface");
      return channels.slice(0, 3);
    };
    const luminance = (channels: number[]) => channels.map(channel => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (foreground: number[], background: number[]) => { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    return columns.map(column => {
      const heading = column.querySelector("h2")!, badge = column.querySelector("[data-column-count]")!;
      const foreground = rgb(getComputedStyle(heading).color), background = rgb(getComputedStyle(column).backgroundColor);
      return { status: column.dataset.kanbanColumn, foreground, background, headingContrast: contrast(foreground, background), countContrast: contrast(rgb(getComputedStyle(badge).color), rgb(getComputedStyle(badge).backgroundColor)) };
    });
  });
  assert.equal(colors.length, 6); assert.equal(new Set(colors.map((color: any) => color.foreground.join(","))).size, 6, "Each column has a distinct accent");
  assert.equal(new Set(colors.map((color: any) => color.background.join(","))).size, 6, "Each column has its own tinted surface");
  for (const color of colors) { assert.ok(color.headingContrast >= 4.5, `${color.status} heading contrast ${color.headingContrast}`); assert.ok(color.countContrast >= 4.5, `${color.status} count contrast ${color.countContrast}`); }
  return colors;
};
const close = async () => { await pane().getByRole("link", { name: "Close", exact: true }).click(); await pane().waitFor({ state: "hidden" }); };
const choose = async (control: string, option: string) => {
  const trigger = page.getByRole("button", { name: control, exact: true });
  await trigger.click(); await page.getByRole("menuitemradio", { name: option, exact: true }).click();
  if (control !== "Sort board") await trigger.getByText(option, { exact: true }).waitFor();
};
const returnedTo = async (target: any) => until(() => target.evaluate((element: HTMLElement) => document.activeElement === element), "focus returned to source card");
let ok = false;
try {
  const seeded = spawnSync("node", ["--experimental-transform-types", "--import", pathToFileURL(join(REPO, "artifacts/secrets-at-rest/node-loader.mjs")).href, join(REPO, "artifacts/board-kanban/seed.mjs"), p.home], { cwd: REPO, env: { ...process.env, PERRY_HOME: p.home, DASHBOARD_KEY: KEY, PERRY_ENGINE: "codex", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}` }, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.equal(seeded.status, 0, seeded.stderr);
  fixture = JSON.parse(seeded.stdout);
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then(response => response.ok, () => false), "production server", 90);
  notes.build = readFileSync(join(REPO, ".next/BUILD_ID"), "utf8").trim();
  notes.seed = fixture;
  browser = await p.openBrowser();
  const { chromium } = await import(pathToFileURL(process.env.PERRY_E2E_PLAYWRIGHT ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")).href);
  connected = await chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`);
  page = connected.contexts()[0].pages().find((item: any) => item.url().startsWith(BASE));
  assert.ok(page);
  page.on("pageerror", (error: Error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await verify("mixedQueueOrdersTasksConsistentlyAroundQueuedChats", async () => {
    await go({ q: "Mixed queue" }); await card(`task:${fixture.mixedFirst}`).waitFor();
    const expected = [`task:${fixture.mixedFirst}`, `task:${fixture.mixedSecond}`, fixture.mixedChat];
    assert.deepEqual(await column("queued").locator("[data-card]").evaluateAll((elements: HTMLElement[]) => elements.map(element => element.dataset.card)), expected);
    await shot("mixed-queue");
    await page.getByRole("navigation", { name: "Board views" }).getByRole("link", { name: "List", exact: true }).click();
    await page.locator(`[data-row="task:${fixture.mixedFirst}"]`).waitFor();
    assert.deepEqual(await page.locator("[data-rows] > [data-row]").evaluateAll((elements: HTMLElement[]) => elements.map(element => element.dataset.row)), expected);
  });
  await verify("providerAgentFollowUpsKeepStartedPostedAndFinishedActivity", async () => {
    const view = await call<{ events: Array<{ id: string; thread?: string; verb: string; text?: string }> }>("board:get", { key: KEY });
    for (const [id, thread, verb] of [
      [`run:${fixture.questionRun}:started`, `agent:${fixture.child}`, "started"],
      [`span:${fixture.childSpan}`, `agent:${fixture.waitingChild}`, "posted"],
      [`run:${fixture.finishedRun}:finished`, `agent:${fixture.finishedChild}`, "finished"],
    ]) {
      const event = view.events.find(event => event.id === id);
      assert.ok(event, `${verb} follow-up event must remain on the Board`);
      assert.equal(event.thread, thread); assert.equal(event.verb, verb);
    }
    assert.equal(view.events.find(event => event.id === `run:${fixture.finishedRun}:finished`)?.text, "Follow-up result delivered.");
    await go({ view: "activity", q: "Security sign-off child" });
    await page.locator(`[data-entry="agent:${fixture.waitingChild}"]`).filter({ hasText: "Security follow-up is ready for review." }).waitFor();
    await go({ view: "activity", q: "Completed follow-up agent" });
    await page.locator(`[data-entry="agent:${fixture.finishedChild}"]`).filter({ hasText: "Follow-up result delivered." }).waitFor();
    await shot("provider-agent-activity");
  });
  await verify("kanbanIsDefaultWithHonestLiveStates", async () => {
    await go({ tab: "all" }); await page.locator("[data-kanban]").waitFor();
    for (const status of ["queued", "working", "waiting", "blocked", "done", "failed"]) await column(status).waitFor();
    notes.columnColorsLight = await columnColors();
    for (const status of ["queued", "working", "waiting", "blocked", "done", "failed"]) assert.ok(Math.abs(await column(status).evaluate((element: HTMLElement) => element.getBoundingClientRect().width) - 288) <= 1, "Desktop lanes stay 18rem wide");
    assert.match(await column("queued").locator("[data-card]").first().innerText(), /Next in line/);
    assert.ok(await page.locator("[data-kanban]").evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), "Desktop board scrolls horizontally within its region");
    for (const [id, status] of [[fixture.live, "working"], [fixture.waiting, "waiting"], [fixture.blocked, "blocked"], [fixture.failed, "failed"]]) assert.equal(await card(`task:${id}`).locator("xpath=ancestor::*[@data-kanban-column]").getAttribute("data-kanban-column"), status);
    await card(`task:${fixture.waiting}`).getByText("Answer question", { exact: true }).waitFor();
    await card(`task:${fixture.failed}`).getByText("View error", { exact: true }).waitFor();
    await card(`task:${fixture.blocked}`).getByText("View details", { exact: true }).waitFor();
    assert.equal(await card(`agent:${fixture.child}`).count(), 0, "Child agents must not become duplicate top-level cards");
    await noOverflow(); await shot("desktop-all");
    await column("done").getByRole("heading", { name: "Done", exact: true }).scrollIntoViewIfNeeded();
    assert.ok(await page.locator("[data-kanban]").evaluate((element: HTMLElement) => element.scrollLeft > 0), "Done is reachable by scrolling the board region");
    await shot("desktop-done");
  });
  await verify("eachColumnHasIndependentBoundedExpansion", async () => {
    const initialQueued = await column("queued").locator("[data-card]").count();
    const initialDone = await column("done").locator("[data-card]").count();
    assert.ok(initialQueued > 0 && initialQueued < fixture.queued.length);
    assert.ok(initialDone > 0 && initialDone < fixture.done.length);
    await column("queued").getByRole("button", { name: /show more/i }).click();
    assert.ok(await column("queued").locator("[data-card]").count() > initialQueued);
    assert.equal(await column("done").locator("[data-card]").count(), initialDone);
    await column("done").getByRole("button", { name: /show more/i }).click();
    assert.ok(await column("done").locator("[data-card]").count() > initialDone);
    notes.initialMounted = { queued: initialQueued, done: initialDone };
  });
  await verify("nativeFilterControlsAndLayoutSwitchPreserveScope", async () => {
    await go({ q: "launch" });
    await choose("Filter by source", "Launch workspace");
    await choose("Filter by computer", "Travel computer");
    await card(fixture.remoteThread).waitFor();
    assert.equal(await page.locator("[data-card]").count(), 1);
    await choose("Filter by computer", "Studio computer");
    await card(`task:${fixture.live}`).waitFor();
    assert.equal(await page.locator("[data-card]").count(), 1);
    await choose("Filter by status", "Working");
    await choose("Sort board", "Recently updated");
    const expected = { q: "launch", channel: `project:${fixture.project}`, computer: "Studio computer", tab: "working", sort: "updated" };
    await page.getByRole("navigation", { name: "Board views" }).getByRole("link", { name: "List", exact: true }).click();
    await page.locator(`[data-row="task:${fixture.live}"]`).waitFor();
    for (const [name, value] of Object.entries(expected)) assert.equal(params().get(name), value);
    assert.equal(params().get("layout"), "list");
    await page.getByRole("navigation", { name: "Board views" }).getByRole("link", { name: "Kanban", exact: true }).click();
    await card(`task:${fixture.live}`).waitFor();
    for (const [name, value] of Object.entries(expected)) assert.equal(params().get(name), value);
    assert.equal(params().get("layout"), null);
    await page.getByRole("link", { name: "Clear filters", exact: true }).click();
    await card(`task:${fixture.waiting}`).waitFor();
    for (const name of ["q", "channel", "computer", "tab"]) assert.equal(params().get(name), null);
  });
  await verify("keyboardOpensDetailAndKeepsNavigationState", async () => {
    await go({ tab: "all", q: "Live launch", sort: "oldest", channel: `project:${fixture.project}`, computer: "Studio computer" });
    await card(`task:${fixture.live}`).waitFor();
    await cardLink(`task:${fixture.live}`).focus(); await page.keyboard.press("Enter");
    await page.locator(`[data-pane="task:${fixture.live}"]`).waitFor();
    const dialog = page.getByRole("dialog", { name: "Work details", exact: true });
    // Base UI's focus guards redirect focus on an animation frame.
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press("Tab");
      await until(() => dialog.evaluate((element: HTMLElement) => element.contains(document.activeElement)), "Tab focus settled inside work details", 2);
    }
    for (const [name, value] of Object.entries({ q: "Live launch", sort: "oldest", channel: `project:${fixture.project}`, computer: "Studio computer", tab: "all" })) assert.equal(params().get(name), value);
    await close();
    await returnedTo(cardLink(`task:${fixture.live}`));
    assert.equal(params().get("thread"), null); assert.equal(params().get("q"), "Live launch");
    await page.goBack(); await page.locator(`[data-pane="task:${fixture.live}"]`).waitFor();
    await close();
  });
  await verify("searchFindsChildUnderParentAndCanClear", async () => {
    await call("questions:request", { token: fixture.token, turnId: fixture.questionTurn, nativeId: "kanban-keyboard-choice", questions: [{ id: "approach", header: "Keyboard support", question: "Which keyboard navigation should I document?", options: [{ label: "Tab and Enter", description: "Use the native keyboard controls." }, { label: "Shortcut keys", description: "Document the additional shortcuts." }] }] });
    await go({ tab: "all" });
    const search = page.getByRole("searchbox", { name: "Search board", exact: true });
    await search.fill("Research accessibility child");
    await card(`task:${fixture.live}`).waitFor();
    await until(async () => await page.locator("[data-card]").count() === 1, "child search rendered its matching parent");
    assert.equal(await page.locator("[data-card]").count(), 1);
    assert.equal(await card(`agent:${fixture.child}`).count(), 0);
    assert.equal(await card(`task:${fixture.live}`).getAttribute("data-status"), "working");
    assert.equal(await card(`task:${fixture.live}`).locator("xpath=ancestor::*[@data-kanban-column]").getAttribute("data-kanban-column"), "waiting");
    const child = page.locator(`[data-agent][data-row="agent:${fixture.child}"] > a`);
    await child.waitFor();
    assert.equal(await child.count(), 1);
    await child.click(); await page.locator(`[data-pane="agent:${fixture.child}"]`).waitFor();
    const nativeQuestion = pane().locator("[data-native-questions]");
    await nativeQuestion.getByText("Which keyboard navigation should I document?", { exact: true }).waitFor();
    await nativeQuestion.getByRole("button", { name: "Tab and Enter", exact: true }).click();
    assert.equal(await nativeQuestion.getByRole("button", { name: "Continue", exact: true }).isEnabled(), true);
    await shot("native-child-question");
    await close(); await returnedTo(child);
    await search.fill("no-matching-launch-xyz");
    await until(async () => await page.locator("[data-card]").count() === 0, "honest empty search");
    await shot("empty-search");
    await page.getByRole("button", { name: "Clear board search", exact: true }).click();
    await card(`task:${fixture.live}`).waitFor();
    assert.equal(params().get("q"), null);
  });
  await verify("needsYouContainsDecisionsAndUpdatesStayInformational", async () => {
    await go({ tab: "needs you" });
    await card(`task:${fixture.waiting}`).waitFor();
    await page.getByText("Review synthetic export command", { exact: true }).waitFor();
    assert.equal(await card(`task:${fixture.failed}`).count(), 0);
    assert.equal(await card(`task:${fixture.blocked}`).count(), 0);
    await shot("needs-you");
    await cardLink(`approval:${fixture.approval}`).click(); await page.locator(`[data-pane="approval:${fixture.approval}"]`).waitFor();
    await pane().getByText("Review synthetic export command", { exact: true }).waitFor(); await close(); await returnedTo(cardLink(`approval:${fixture.approval}`));
    await go({ tab: "updates" });
    await page.getByText("Upload retry information", { exact: true }).first().waitFor();
    assert.equal(await card(`task:${fixture.waiting}`).count(), 0);
    await shot("updates");
  });
  await verify("oldCompletedParentSurfacesItsChildDecisionBeforePagination", async () => {
    await go();
    const parent = card(`task:${fixture.doneParent}`);
    await parent.waitFor();
    assert.equal(await parent.getAttribute("data-status"), "done");
    assert.equal(await parent.locator("xpath=ancestor::*[@data-kanban-column]").getAttribute("data-kanban-column"), "waiting");
    assert.equal(await column("done").locator("[data-card]").count(), 10);
    assert.equal(await card(`agent:${fixture.waitingChild}`).count(), 0);
    assert.equal(await card(`run:${fixture.childRun}`).count(), 0, "An agent's own run must not become another root card");
    await go({ tab: "needs you" }); await parent.waitFor();
    assert.equal(await parent.locator("xpath=ancestor::*[@data-kanban-column]").getAttribute("data-kanban-column"), "waiting");
    const child = page.locator(`[data-agent][data-row="agent:${fixture.waitingChild}"] > a`);
    if (!await child.isVisible()) await parent.locator("[data-agents-toggle]").click();
    await child.waitFor();
    await child.getByText("needs you", { exact: true }).waitFor();
    await shot("completed-parent-child-decision");
    await child.click(); await page.locator(`[data-pane="agent:${fixture.waitingChild}"]`).waitFor();
    await pane().getByRole("button", { name: "Allow once", exact: true }).waitFor();
    await shot("child-approval-detail");
    await close(); await returnedTo(child);
  });
  await verify("nativeTransitionsMoveExactlyOneCardWithoutReload", async () => {
    await go({ tab: "all", q: "Live launch" });
    await card(`task:${fixture.live}`).waitFor();
    await call("runner:checkIn", { token: fixture.token, activeTurnIds: [fixture.turn, fixture.childTurn, fixture.questionTurn] });
    await call("work:updateTask", { taskId: fixture.live, status: "blocked", question: "Approve the synthetic launch window?" });
    await until(async () => await column("waiting").locator(`[data-card="task:${fixture.live}"]`).count() === 1, "live owner decision reflected");
    assert.equal(await page.locator(`[data-card="task:${fixture.live}"]`).count(), 1);
    await call("work:updateTask", { taskId: fixture.live, status: "done", result: "Verified synthetic launch review." });
    await until(async () => await column("done").locator(`[data-card="task:${fixture.live}"]`).count() === 1, "live completion reflected");
    assert.equal(await page.locator(`[data-card="task:${fixture.live}"]`).count(), 1);
    await shot("live-completed");
  });
  await verify("listActivityAndExistingDeepLinksRemainUsable", async () => {
    await go({ layout: "list", tab: "all", q: "Choose launch" });
    await page.locator(`[data-row="task:${fixture.waiting}"]`).waitFor();
    assert.equal(await page.locator("[data-kanban]").count(), 0);
    await page.locator(`[data-row="task:${fixture.waiting}"]`).click(); await pane().waitFor(); await close();
    await go({ view: "activity", tab: "all", q: "Choose launch" });
    await page.locator("[data-board]").getByText("Choose launch window", { exact: true }).first().waitFor();
    await shot("activity");
    await go({ layout: "list", tab: "waiting", thread: `task:${fixture.waiting}` });
    await page.locator(`[data-pane="task:${fixture.waiting}"]`).waitFor(); await close();
    assert.equal(params().get("layout"), "list"); assert.equal(params().get("tab"), "waiting");
  });
  await verify("phoneKanbanAndModalRemainUsableWithoutPageOverflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(); await page.locator("[data-kanban]").waitFor();
    await column("queued").waitFor();
    assert.ok(await column("queued").locator("ul").first().evaluate((element: HTMLElement) => element.scrollHeight <= element.clientHeight + 1), "Phone lanes must not trap vertical scrolling in their own lists");
    await noOverflow(); await shot("mobile-all");
    await go({ tab: "all", q: "Choose launch" });
    await card(`task:${fixture.waiting}`).waitFor();
    await noOverflow(); await shot("mobile-board");
    await cardLink(`task:${fixture.waiting}`).click();
    const dialog = page.getByRole("dialog", { name: "Work details", exact: true });
    await dialog.waitFor(); await noOverflow(); await shot("mobile-detail");
    await page.keyboard.press("Escape"); await pane().waitFor({ state: "hidden" });
    await returnedTo(cardLink(`task:${fixture.waiting}`));
    assert.equal(params().get("q"), "Choose launch");
    await noOverflow();
  });
  await verify("filteredOutCardDismissalReturnsFocusToSearch", async () => {
    await go({ tab: "needs you", q: "Choose launch" });
    await cardLink(`task:${fixture.waiting}`).click(); await pane().waitFor();
    await call("work:updateTask", { taskId: fixture.waiting, status: "done", result: "Synthetic decision handled elsewhere." });
    await until(async () => await card(`task:${fixture.waiting}`).count() === 0, "resolved card removed from decision filter");
    await page.keyboard.press("Escape"); await pane().waitFor({ state: "hidden" });
    await until(() => page.getByRole("searchbox", { name: "Search board", exact: true }).evaluate((element: HTMLElement) => document.activeElement === element), "focus returned to search after source disappeared", 5);
  });
  await verify("smallPhoneAndDarkThemeKeepReadableUsableLayout", async () => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.emulateMedia({ colorScheme: "dark" });
    await go(); await page.locator("[data-kanban]").waitFor();
    await until(() => page.evaluate(() => document.documentElement.classList.contains("dark")), "system dark theme applied");
    notes.columnColorsDark = await columnColors();
    await noOverflow(); await shot("mobile-small-dark");
    await cardLink(`task:${fixture.failed}`).click(); await page.getByRole("dialog", { name: "Work details", exact: true }).waitFor();
    await noOverflow(); await shot("mobile-small-dark-detail");
    await page.keyboard.press("Escape"); await pane().waitFor({ state: "hidden" }); await returnedTo(cardLink(`task:${fixture.failed}`));
  });
  notes.browserErrors = [...browser.errors, ...errors];
  assert.deepEqual(notes.browserErrors, []);
  assert.equal(p.logs.runner, "");
  check("noBrowserErrorsOrEngineProcess", true);
  ok = Object.values(p.checks).every(Boolean);
} catch (error) {
  notes.stoppedAt = String(error);
  notes.serverLog = p.logs.server.split("\n").slice(-80);
  try { notes.failureState = await page?.locator("body").innerText(); await shot("failure"); } catch {}
  check("journeyCompleted", false, String(error));
} finally { await connected?.close().catch(() => {}); }
const passed = await p.finish({ ok, mode: "synthetic-production-kanban-browser" });
assert.equal(notes.tempHomeRemoved, true, "Disposable Perry home must be deleted after verification");
process.exitCode = passed ? 0 : 1;
