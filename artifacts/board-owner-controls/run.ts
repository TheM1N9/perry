// Inventory: failure-cases.md. Real production UI/HTTP/SQLite; no runner or model.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/board-owner-controls/run.ts <outDir>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { perry, REPO } from "../engine-acp/harness";
import { boardLink } from "../../lib/board-links";

const outDir = process.argv[2];
if (!outDir) throw Error("Pass an output directory");
const searchOnly = process.argv.includes("--search-only");
const p = await perry({ name: "board-owner-controls", outDir, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex"), CLAUDE_CONFIG_DIR: join(home, "empty-claude") }), env: {
  PERRY_EMBED_MODEL: "connector-fixture", PERRY_WAKE_DISABLED: "1", TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GROQ_API_KEY: "",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(REPO, "artifacts/connector-details/preload.mjs")).href}`,
} });
const { KEY, BASE, call, check, notes, until } = p;
const { chromium } = await import(pathToFileURL(process.env.PERRY_E2E_PLAYWRIGHT ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")).href);
let page: any, connected: any, browser: Awaited<ReturnType<typeof p.openBrowser>> | undefined;
let failNext = "";
const requests: Array<{ path: string; status: number; error?: string }> = [];
const work = () => call<any>("dashboard:getWork", { key: KEY });
const goal = async (id: string) => (await work()).goals.find((item: any) => item._id === id);
const task = async (id: string) => (await work()).tasks.find((item: any) => item._id === id);
const verify = async (name: string, run: () => Promise<void>) => { try { await run(); check(name, true); } catch (error) { check(name, false, String(error)); } };
const dialog = () => page.getByRole("dialog");
const go = async (channel: string, thread?: string) => {
  await page.goto(BASE + boardLink({ channel, tab: "all", ...(thread ? { thread } : {}) }));
  await page.getByRole("button", { name: `new ${channel === "goals" ? "goal" : "task"}`, exact: true }).waitFor();
};
const create = async (kind: "goal" | "task") => { await page.getByRole("button", { name: `new ${kind}`, exact: true }).click(); await dialog().waitFor(); };
const save = async (path: string) => {
  const response = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === path);
  await dialog().getByRole("button", { name: /^(Create|Save)$/ }).click();
  const reply = await response, body = await reply.json();
  requests.push({ path, status: reply.status(), ...(body.error ? { error: body.error } : {}) });
  return { status: reply.status(), body };
};
const choose = async (label: string, option: string) => { await dialog().getByLabel(label, { exact: true }).click(); await page.getByRole("option", { name: option, exact: true }).click(); };
const editGoal = async (id: string) => { await go("goals", `goal:${id}`); await page.getByRole("button", { name: "change", exact: true }).click(); await dialog().waitFor(); };
const editDeps = async (id: string) => { await go("tasks", `task:${id}`); await page.locator("[data-more]").click(); await page.getByRole("menuitem", { name: "edit prerequisites", exact: true }).click(); await dialog().waitFor(); };
const dependency = (title: string) => dialog().locator("[data-dependency-picker] label").filter({ hasText: title }).getByRole("checkbox");
const newTask = async (title: string) => { await go("tasks"); await create("task"); await dialog().getByLabel("Task", { exact: true }).fill(title); await dialog().getByLabel("What to do", { exact: true }).fill("Prepare the synthetic verified summary for the owner."); };

let ok = false;
try {
  p.start("server");
  await until(() => fetch(BASE + "/api/backend/http/health").then(reply => reply.ok, () => false), "production server", 90);
  await call("dashboard:skipOnboarding", { key: KEY });
  await call("pause:set", { key: KEY, paused: true });
  browser = await p.openBrowser();
  connected = await chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`);
  page = connected.contexts()[0].pages().find((item: any) => item.url().startsWith(BASE));
  assert.ok(page);
  await page.route("**/api/backend/call", async (route: any) => {
    if (route.request().postDataJSON()?.path === failNext) { failNext = ""; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic temporary failure. Retry this form." }) }); }
    return route.continue();
  });
  if (searchOnly) {
    const title = "QA background completed search";
    const id = await call<string>("tasks:queueFromDashboard", { key: KEY, title, prompt: "Create the isolated completed task search fixture." });
    await call("work:updateTask", { taskId: id, status: "done", result: "Synthetic verified result for search recovery." });
    const query = new URLSearchParams({ channel: "tasks", q: title, sort: "oldest" });
    const empty = () => page.locator("[data-empty]").filter({ hasText: "No work in this view matches your search." });
    const searchAll = () => page.getByRole("link", { name: "Search all statuses", exact: true });
    const clear = () => page.getByRole("link", { name: "Clear search", exact: true });
    const params = () => new URL(page.url()).searchParams;
    const navigate = async (values: URLSearchParams) => { await page.goto(`${BASE}/board?${values}`); await empty().waitFor(); };
    notes.mode = "scoped-search-only";
    notes.build = readFileSync(join(REPO, ".next/BUILD_ID"), "utf8").trim();
    await navigate(query);
    const scopeHref = await searchAll().getAttribute("href");
    const target = new URL(scopeHref, BASE).searchParams;
    assert.equal(target.get("tab"), "all");
    for (const name of ["channel", "q", "sort"]) assert.equal(target.get(name), query.get(name));
    assert.equal(await page.locator(`[data-row="task:${id}"]`).count(), 0);
    assert.match(await page.getByRole("navigation", { name: "States" }).innerText(), /done\s*1[\s\S]*all\s*1/);
    check("completedMatchExplainsCurrentScopeAndOffersRecovery", true);
    await searchAll().focus(); await page.keyboard.press("Enter");
    await page.locator(`[data-row="task:${id}"]`).waitFor();
    assert.equal(params().get("tab"), "all");
    for (const name of ["channel", "q", "sort"]) assert.equal(params().get(name), query.get(name));
    assert.equal((await task(id)).status, "done");
    check("nativeKeyboardRecoveryFindsCompletedTaskWithFiltersIntact", true);
    const missingAll = new URLSearchParams(query); missingAll.set("tab", "all"); missingAll.set("q", "no-such-work-anywhere");
    await navigate(missingAll); assert.equal(await searchAll().count(), 0);
    await clear().focus(); await page.keyboard.press("Enter");
    await page.locator(`[data-row="task:${id}"]`).waitFor();
    assert.equal(params().get("q"), null); assert.equal(params().get("tab"), "all");
    assert.equal(params().get("channel"), "tasks"); assert.equal(params().get("sort"), "oldest");
    check("allStatusEmptyOmitsPointlessRecoveryAndClearOnlyDropsQuery", true);
    const missingOpen = new URLSearchParams(query); missingOpen.set("q", "no-such-work-anywhere");
    await navigate(missingOpen); assert.equal(await searchAll().count(), 0);
    check("noMatchesInAnyStatusOmitsPointlessAllStatusAction", true);
    const computerScoped = new URLSearchParams(query); computerScoped.set("tab", "all"); computerScoped.set("computer", "Nonmatching fixture computer");
    await navigate(computerScoped); assert.equal(await searchAll().count(), 0);
    await clear().focus(); await page.keyboard.press("Enter");
    await until(() => !params().has("q"), "clear only search text");
    for (const name of ["channel", "computer", "sort", "tab"]) assert.equal(params().get(name), computerScoped.get(name));
    assert.equal(await page.locator(`[data-row="task:${id}"]`).count(), 0);
    assert.equal(await searchAll().count(), 0);
    assert.equal(browser.errors.length, 0); assert.equal(p.rows("codexTurns").length, 0);
    notes.finalAddress = page.url(); notes.finalTask = await task(id); notes.scopeHref = scopeHref; notes.browserErrors = browser.errors;
    await page.screenshot({ path: join(outDir, "scoped-search.png") });
    check("clearSearchKeepsComputerChannelSortAndStatus", true);
  } else {
  await go("goals");
  await verify("emptyGoalsOffersCreation", async () => { await page.locator("[data-empty]").first().waitFor(); assert.equal((await work()).goals.length, 0); });
  await create("goal");
  await dialog().getByLabel("Goal", { exact: true }).fill(" ");
  await verify("invalidGoalKeepsDraftAndExplainsRepair", async () => { const r = await save("dashboard:saveGoal"); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.body.error, /Give the goal a title/); assert.equal(await dialog().getByLabel("Goal", { exact: true }).inputValue(), " "); });
  await dialog().getByLabel("Goal", { exact: true }).fill("Owner milestone goal");
  await dialog().getByLabel("Why, or what counts (optional)", { exact: true }).fill("Verified outcome with two milestones.");
  await dialog().getByLabel("Milestones", { exact: true }).fill("Draft comparison\nVerify decision");
  failNext = "dashboard:saveGoal";
  await verify("transportFailureKeepsGoalDraft", async () => { const r = await save("dashboard:saveGoal"); assert.equal(r.status, 503); assert.equal(await dialog().getByLabel("Goal", { exact: true }).inputValue(), "Owner milestone goal"); assert.equal((await work()).goals.length, 0); });
  const created = await save("dashboard:saveGoal"), goalId = created.body.value;
  assert.equal(created.status, 200);
  await dialog().waitFor({ state: "hidden" });
  await verify("retryCreatesExactlyOneGoal", async () => { assert.equal((await work()).goals.length, 1); assert.equal((await goal(goalId)).milestones.length, 2); });
  await call("work:updateGoal", { id: goalId, completeMilestones: ["Draft comparison"] });
  await editGoal(goalId);
  await dialog().getByLabel("Milestones", { exact: true }).fill("Verify decision\nDraft comparison\n\nPublish findings");
  await save("dashboard:saveGoal");
  await verify("milestoneReorderKeepsTickAndDropsBlankLines", async () => { const g = await goal(goalId); assert.equal(g.milestones.length, 3); assert.equal(g.milestones.find((item: any) => item.title === "Draft comparison").done, true); assert.equal(g.milestones[0].done, false); });
  await editGoal(goalId); await dialog().getByLabel("Milestones", { exact: true }).fill("Verify decision\nDraft updated\nPublish findings"); await save("dashboard:saveGoal");
  await verify("renamedMilestoneRequiresNewVerification", async () => { const g = await goal(goalId); assert.equal(g.milestones.find((item: any) => item.title === "Draft updated").done, false); });
  await call("work:updateGoal", { id: goalId, completeMilestones: ["Draft updated"] });
  for (const [label, status, action] of [["Paused", "paused", "Pause"], ["Active", "active", "Resume"], ["Done", "done", "Complete"], ["Active", "active", "Reopen"]]) {
    await editGoal(goalId); await choose("Status", label); await save("dashboard:saveGoal");
    await verify(`goal${action}Persists`, async () => { const g = await goal(goalId); assert.equal(g.status, status); assert.equal(g.milestones.find((item: any) => item.title === "Draft updated").done, true); });
  }
  await newTask("Prerequisite Alpha");
  await dialog().getByLabel("Task", { exact: true }).fill(" ");
  await verify("invalidTaskNameKeepsDraftAndExplainsRepair", async () => { const r = await save("tasks:queueFromDashboard"); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.body.error, /Give the task a short name/); assert.equal(await dialog().getByLabel("Task", { exact: true }).inputValue(), " "); });
  await dialog().getByLabel("Task", { exact: true }).fill("Prerequisite Alpha");
  await dialog().getByLabel("What to do", { exact: true }).fill("short");
  await verify("invalidTaskBriefKeepsDraftAndExplainsRepair", async () => { const r = await save("tasks:queueFromDashboard"); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.body.error, /Say what Perry should do/); assert.equal(await dialog().getByLabel("Task", { exact: true }).inputValue(), "Prerequisite Alpha"); });
  await dialog().getByLabel("What to do", { exact: true }).fill("Prepare the synthetic verified summary for the owner.");
  const first = await save("tasks:queueFromDashboard"), alpha = first.body.value;
  await newTask("Prerequisite Beta"); const second = await save("tasks:queueFromDashboard"), beta = second.body.value;
  await newTask("Dependent Gamma");
  await choose("For a goal", "Owner milestone goal");
  await dependency("Prerequisite Alpha").check();
  await dialog().getByLabel("Find prerequisite tasks").fill("no-such-prerequisite");
  await verify("dependencySearchHasHonestEmptyState", async () => { assert.ok(await dialog().getByText("No matching tasks. Try a different name.").isVisible()); });
  await dialog().getByLabel("Find prerequisite tasks").fill("");
  await verify("dependencySelectionSurvivesSearch", async () => { assert.equal(await dependency("Prerequisite Alpha").isChecked(), true); });
  failNext = "tasks:queueFromDashboard";
  await verify("failedTaskCreationRetainsGoalAndDependencyDraft", async () => { const r = await save("tasks:queueFromDashboard"); assert.equal(r.status, 503); assert.equal(await dialog().getByLabel("Task", { exact: true }).inputValue(), "Dependent Gamma"); assert.equal(await dependency("Prerequisite Alpha").isChecked(), true); assert.equal((await work()).tasks.length, 2); });
  const third = await save("tasks:queueFromDashboard"), gamma = third.body.value;
  await verify("taskStoresGoalAndPrerequisiteWhilePaused", async () => { const t = await task(gamma); assert.equal(t.goalId, goalId); assert.deepEqual(t.dependsOn, [alpha]); assert.equal(t.status, "queued"); assert.equal(t.conversationId, undefined); });
  await editDeps(alpha);
  await verify("dependencyEditorExcludesSelf", async () => { assert.equal(await dialog().locator("[data-dependency-picker] label").filter({ hasText: "Prerequisite Alpha" }).count(), 0); });
  await dependency("Dependent Gamma").check();
  await verify("dependencyCycleRefusesWithRepairAndRetainsSelection", async () => { const r = await save("tasks:setDependenciesFromDashboard"); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.body.error, /cycle/); assert.equal(await dependency("Dependent Gamma").isChecked(), true); assert.equal((await task(alpha)).dependsOn, undefined); });
  await dependency("Dependent Gamma").uncheck(); await dependency("Prerequisite Beta").check();
  await save("tasks:setDependenciesFromDashboard");
  await verify("dependencyRetrySavesAcyclicGraph", async () => { assert.deepEqual((await task(alpha)).dependsOn, [beta]); assert.deepEqual((await task(gamma)).dependsOn, [alpha]); });
  await editDeps(alpha); await dependency("Prerequisite Beta").uncheck();
  failNext = "tasks:setDependenciesFromDashboard";
  await verify("failedDependencySaveRetainsSelectionAndStoredGraph", async () => { const r = await save("tasks:setDependenciesFromDashboard"); assert.equal(r.status, 503); assert.equal(await dependency("Prerequisite Beta").isChecked(), false); assert.deepEqual((await task(alpha)).dependsOn, [beta]); });
  await save("tasks:setDependenciesFromDashboard");
  await verify("dependencyRetryCanClearAllPrerequisites", async () => { assert.equal((await task(alpha)).dependsOn, undefined); });
  await editDeps(alpha); await dependency("Prerequisite Beta").check();
  await call("work:updateTask", { taskId: alpha, status: "blocked", question: "Synthetic task state changed." });
  await verify("staleDependencySaveRefusesWithRepairAndKeepsDraft", async () => { const r = await save("tasks:setDependenciesFromDashboard"); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.body.error, /Only queued tasks/); assert.equal(await dependency("Prerequisite Beta").isChecked(), true); });
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await editGoal(goalId);
  await dialog().getByLabel("Goal", { exact: true }).fill("Owner unsaved goal draft");
  const before = await goal(goalId);
  await call("dashboard:saveGoal", { key: KEY, id: goalId, title: before.title, description: "Independent newer description", status: "paused", milestones: before.milestones });
  await verify("liveGoalRefreshRetainsOwnerDraft", async () => { assert.equal(await dialog().getByLabel("Goal", { exact: true }).inputValue(), "Owner unsaved goal draft"); });
  await verify("staleGoalSaveCannotOverwriteIndependentChanges", async () => { const r = await save("dashboard:saveGoal"); const current = await goal(goalId); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.body.error, /changed|updated/i); assert.equal(current.description, "Independent newer description"); assert.equal(current.status, "paused"); assert.equal(await dialog().getByLabel("Goal", { exact: true }).inputValue(), "Owner unsaved goal draft"); });
  await verify("staleGoalShowsExplicitReviewWithoutErasingDraft", async () => { await dialog().getByText("This goal was updated", { exact: true }).waitFor(); assert.equal(await dialog().getByLabel("Goal", { exact: true }).inputValue(), "Owner unsaved goal draft"); });
  await dialog().getByRole("button", { name: "Load latest", exact: true }).click();
  await verify("loadLatestReviewsIndependentGoalFields", async () => { assert.equal(await dialog().getByLabel("Goal", { exact: true }).inputValue(), "Owner milestone goal"); assert.equal(await dialog().getByLabel("Why, or what counts (optional)", { exact: true }).inputValue(), "Independent newer description"); assert.match(await dialog().getByLabel("Status", { exact: true }).innerText(), /Paused/); });
  await dialog().getByLabel("Goal", { exact: true }).fill("Owner reviewed goal draft"); await save("dashboard:saveGoal");
  await verify("reviewedRetryPreservesNewDescriptionStatusAndMilestones", async () => { const g = await goal(goalId); assert.equal(g.title, "Owner reviewed goal draft"); assert.equal(g.description, "Independent newer description"); assert.equal(g.status, "paused"); assert.equal(g.milestones.find((item: any) => item.title === "Draft updated").done, true); });
  await go("tasks", `task:${alpha}`); await page.locator("[data-more]").click(); await page.getByRole("menuitem", { name: "cancel task", exact: true }).click();
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await verify("ownerCancelsTaskThroughConfirmation", async () => { await until(async () => (await task(alpha)).status === "cancelled", "task cancelled by owner"); });
  await go("tasks", `task:${gamma}`);
  await verify("dependentShowsCancelledPrerequisiteWithoutStarting", async () => { await page.locator("[data-task-dependencies]").getByText("cancelled", { exact: true }).waitFor(); assert.equal((await task(gamma)).status, "queued"); assert.equal((await task(gamma)).conversationId, undefined); });
  notes.requests = requests;
  notes.finalWork = await work();
  notes.browserErrors = browser.errors;
  check("noBrowserRuntimeErrors", browser.errors.length === 0);
  check("noRunnerOrModelWork", p.rows("runners").every(row => !row.lastSeenAt) && p.rows("codexTurns").length === 0);
  await p.shot("board-owner-controls.png", "main");
  }
  ok = true;
} catch (error) {
  notes.stoppedAt = String(error);
  try { notes.failureState = { work: await work(), requests }; await p.shot("failure.png", "main"); } catch {}
  check("completed", false);
} finally { await connected?.close().catch(() => {}); }
const passed = await p.finish({ ok });
process.exit(passed ? 0 : 1);
