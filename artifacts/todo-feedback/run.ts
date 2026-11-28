// Inventory: failure-cases.md. Real production UI/HTTP/SQLite; no runner or provider.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { perry, REPO } from "../engine-acp/harness";

const overlapOnly = process.argv.includes("--overlap-only");
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "node_modules/.cache/todo-feedback");
const p = await perry({ name: "todo-feedback", outDir: output, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex"), CLAUDE_CONFIG_DIR: join(home, "empty-claude") }), env: {
  PERRY_EMBED_MODEL: "connector-fixture", PERRY_WAKE_DISABLED: "1", TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GROQ_API_KEY: "",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(REPO, "artifacts/connector-details/preload.mjs")).href}`,
} });
const { BASE, KEY, check, notes, until } = p;
let connected: any, page: any, browser: Awaited<ReturnType<typeof p.openBrowser>> | undefined;
type Gate = { path: string; fail: boolean; before: boolean; entered: boolean; release: () => void; ready: Promise<void> };
const gates: Gate[] = [], allGates: Gate[] = [];
const calls: Array<{ path: string; args: Record<string, any> }> = [];
const gate = (path: string, fail = false, before = false) => {
  let release!: () => void;
  const ready = new Promise<void>(done => { release = done; });
  const item = { path, fail, before, entered: false, release, ready };
  gates.push(item); allGates.push(item); return item;
};
const input = () => page.getByRole("textbox", { name: "Add a to-do", exact: true });
const addButton = () => page.getByRole("button", { name: "Add to-do", exact: true });
const form = () => input().locator("xpath=ancestor::form");
const success = (text: string) => page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: text });
const added = (title: string) => success(`Added “${title}”`);
const completed = (title: string) => success(`Completed “${title}”`);
const todos = () => p.rows("todos");
const byTitle = (title: string) => todos().filter(row => row.title === title);
const one = (title: string) => { const found = byTitle(title); assert.equal(found.length, 1, title); return found[0]; };
const response = (path: string) => {
  const pending = page.waitForResponse((reply: any) => reply.url().endsWith("/api/backend/call") && reply.request().postDataJSON()?.path === path);
  void pending.catch(() => {});
  return pending;
};
const enter = async (text: string) => { await input().fill(text); await input().press("Enter"); };
const add = async (text: string, title = text, pointer = true) => {
  await input().fill(text); const reply = response("todos:add");
  if (pointer) await addButton().click(); else await input().press("Enter");
  assert.equal((await reply).status(), 200); await added(title).waitFor(); return one(title);
};
const doneBox = (title: string) => page.getByRole("checkbox", { name: `Done: “${title}”`, exact: true });
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
const openPet = async () => {
  // The body keeps animating; native keyboard activation does not require a motionless pointer target.
  const body = page.getByRole("button", { name: /^Perry\. Click to open him/ });
  await body.focus(); await page.keyboard.press("Enter");
};

let ok = false;
try {
  p.start("server");
  await until(() => fetch(BASE + "/api/backend/http/health").then(reply => reply.ok, () => false), "production server", 90);
  await p.call("dashboard:skipOnboarding", { key: KEY });
  browser = await p.openBrowser();
  const { chromium } = await import(pathToFileURL(process.env.PERRY_E2E_PLAYWRIGHT ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")).href);
  connected = await chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`);
  page = connected.contexts()[0].pages().find((item: any) => item.url().startsWith(BASE));
  assert.ok(page);
  await page.route("**/api/backend/call", async (route: any) => {
    const body = route.request().postDataJSON(); calls.push(body);
    const index = gates.findIndex(item => item.path === body.path);
    if (index < 0) return route.continue();
    const item = gates.splice(index, 1)[0];
    const timer = setTimeout(item.release, 20_000);
    let reply: any;
    try {
      if (item.before) { item.entered = true; await item.ready; }
      reply = item.fail ? null : await route.fetch();
      item.entered = true;
      if (!item.before) await item.ready;
    } finally { clearTimeout(timer); }
    return reply ? route.fulfill({ response: reply }) : route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save failure. Retry your to-do." }) });
  });
  const initialBoard = overlapOnly ? undefined : gate("todos:board", false, true);
  await page.goto(`${BASE}/todos`); await input().waitFor();
  notes.build = readFileSync(join(REPO, ".next/BUILD_ID"), "utf8").trim();

  const overlap = async () => {
    const a = gate("todos:add", true), b = gate("todos:add", true);
    await enter("Unsent alpha draft"); await until(() => a.entered, "first held addition");
    await input().fill("Unsent beta draft"); await input().press("Enter");
    assert.equal(b.entered, false, "one admission at a time while newer typing stays available");
    const ra = response("todos:add"); a.release(); await ra;
    await until(async () => !await form().getAttribute("aria-busy"), "first failed addition settled");
    assert.equal(await input().inputValue(), "Unsent beta draft");
    await input().press("Enter"); await until(() => b.entered, "second failed addition");
    const rb = response("todos:add"); b.release(); await rb;
    await until(async () => !await form().getAttribute("aria-busy"), "failed additions settled");
    const text = await page.locator("body").innerText(), draft = await input().inputValue();
    notes.overlapFailure = { draft, visible: text, stored: byTitle("Unsent alpha draft").concat(byTitle("Unsent beta draft")) };
    assert.ok(`${draft}\n${text}`.includes("Unsent alpha draft") && `${draft}\n${text}`.includes("Unsent beta draft"), "both failed submissions must remain visible for recovery");
    assert.equal(byTitle("Unsent alpha draft").length + byTitle("Unsent beta draft").length, 0);
    check("bothOverlappingFailedDraftsHaveVisibleRecovery", true);
    await form().getByRole("button", { name: "Dismiss failed to-do “Unsent alpha draft”", exact: true }).click();
    assert.equal(await form().getByRole("alert").filter({ hasText: "Unsent alpha draft" }).count(), 0);
    assert.equal(await form().getByRole("alert").filter({ hasText: "Unsent beta draft" }).count(), 1);
    assert.equal(await input().inputValue(), "Unsent beta draft");
    check("failedCapturesHaveExplicitDismissalWithoutErasingOtherDrafts", true);
  };
  if (overlapOnly) await overlap();
  else {
    await until(() => initialBoard!.entered, "initial board query held before admission");
    const initialAdd = gate("todos:add");
    await enter("Capture while board loads"); await until(() => initialAdd.entered, "add committed before initial board query");
    initialBoard!.release(); await doneBox("Capture while board loads").waitFor();
    assert.equal(await doneBox("Capture while board loads").count(), 1, "late initial snapshot must not receive a second provisional row");
    const initialReply = response("todos:add"); initialAdd.release(); await initialReply; await added("Capture while board loads").waitFor();
    assert.equal(byTitle("Capture while board loads").length, 1);
    check("addBeforeInitialBoardLoadsDoesNotDuplicateServerRow", true);
    assert.equal(await addButton().isDisabled(), true);
    const startAdds = calls.filter(call => call.path === "todos:add").length;
    await input().press("Enter");
    assert.equal(calls.filter(call => call.path === "todos:add").length, startAdds);
    check("emptyDraftHasDisabledPointerActionAndDoesNotSubmit", true);

    const ordinary = await add("Pointer capture");
    assert.equal(ordinary.dueAt, undefined);
    check("pointerAddStoresOneTodoAndConfirmsExactTitle", true);
    const timed = await add("Call Sam tomorrow 9am", "Call Sam", false);
    assert.ok(timed.dueAt > Date.now());
    assert.equal(new Date(timed.dueAt).getHours(), 9);
    check("enterAddParsesDateAndConfirmsTitle", true);

    const literal = "Review QA tomorrow 9am";
    await input().fill(literal); await form().getByRole("button", { name: "Use text only", exact: true }).click();
    assert.equal(await input().inputValue(), literal);
    await form().getByText("Text only · Enter to add", { exact: true }).waitFor();
    let reply = response("todos:add"); await addButton().click(); await reply; await added(literal).waitFor();
    assert.equal(one(literal).dueAt, undefined); assert.equal(one(literal).repeat, undefined);
    check("dateOptOutKeepsFullLiteralTitleWithoutReminder", true);

    const recurring = await add("Water ferns every day at 9am", "Water ferns");
    assert.equal(recurring.repeat, "0 9 * * *"); assert.ok(recurring.dueAt > Date.now());
    check("freshDraftResetsLiteralChoiceAndParsesRepeat", true);
    const literalRepeat = "Audit every day at 9am";
    await input().fill(literalRepeat); await form().getByRole("button", { name: "Use text only", exact: true }).click();
    reply = response("todos:add"); await input().press("Enter"); await reply; await added(literalRepeat).waitFor();
    assert.equal(one(literalRepeat).dueAt, undefined); assert.equal(one(literalRepeat).repeat, undefined);
    check("repeatOptOutKeepsFullLiteralTitle", true);

    const pending = gate("todos:add");
    await enter("Pending appointment tomorrow 9am"); await until(() => pending.entered, "committed addition with held acknowledgement");
    const pendingCalls = calls.filter(call => call.path === "todos:add").length;
    assert.equal(await input().inputValue(), "");
    assert.equal(await input().evaluate((element: HTMLInputElement) => element.readOnly), false);
    assert.equal(await input().evaluate((element: HTMLInputElement) => document.activeElement === element), true);
    assert.equal(await addButton().isDisabled(), true);
    assert.equal(await form().getByText("Saving…", { exact: true }).count(), 0);
    await doneBox("Pending appointment").waitFor();
    assert.equal(await doneBox("Pending appointment").isDisabled(), true, "provisional ids cannot be sent to server actions");
    await page.keyboard.type("Follow-up capture"); await page.keyboard.press("Enter");
    assert.equal(await input().inputValue(), "Follow-up capture");
    assert.equal(await input().evaluate((element: HTMLInputElement) => document.activeElement === element), true);
    assert.equal(calls.filter(call => call.path === "todos:add").length, pendingCalls);
    assert.equal(await added("Pending appointment").count(), 0);
    check("heldAddAppearsImmediatelyAndKeepsNewTypingWithoutSavingLabel", true);
    reply = response("todos:add"); pending.release(); await reply; await added("Pending appointment").waitFor();
    await until(async () => !await form().getAttribute("aria-busy"), "addition acknowledged");
    assert.equal(await input().evaluate((element: HTMLInputElement) => document.activeElement === element), true);
    assert.equal(await input().inputValue(), "Follow-up capture");
    assert.equal(await doneBox("Pending appointment").isEnabled(), true);
    assert.equal(byTitle("Pending appointment").length, 1);
    check("confirmedAddKeepsNewerDraftAndReplacesProvisionalIdExactlyOnce", true);

    const failedLiteral = "Failed audit tomorrow 9am";
    await input().fill(failedLiteral); await form().getByRole("button", { name: "Use text only", exact: true }).click();
    const failedAdd = gate("todos:add", true); await addButton().click(); await until(() => failedAdd.entered, "failed add held");
    reply = response("todos:add"); failedAdd.release(); assert.equal((await reply).status(), 503);
    await form().getByRole("alert").filter({ hasText: "Synthetic save failure. Retry your to-do." }).waitFor();
    assert.equal(await input().inputValue(), failedLiteral); assert.equal(await input().isEnabled(), true);
    assert.equal(byTitle(failedLiteral).length, 0); assert.equal(await added(failedLiteral).count(), 0);
    reply = response("todos:add"); await addButton().click(); await reply; await added(failedLiteral).waitFor();
    assert.equal(one(failedLiteral).dueAt, undefined); assert.equal(one(failedLiteral).repeat, undefined);
    check("failedAddKeepsExactLiteralDraftAndRetryChoice", true);

    const overlapAdd = gate("todos:add"), overlapDone = gate("todos:setDone");
    await enter("Overlapping board update"); await until(() => overlapAdd.entered, "held add before another mutation");
    await doneBox(timed.title).click(); await until(() => overlapDone.entered, "held completion beside add");
    const putBack = page.getByRole("checkbox", { name: `Put back “${timed.title}”`, exact: true });
    await putBack.waitFor(); assert.equal(await putBack.isChecked(), true);
    reply = response("todos:add"); overlapAdd.release(); await reply; await added("Overlapping board update").waitFor();
    assert.equal(await putBack.isChecked(), true, "settling the earlier add must retain the later completion");
    reply = response("todos:setDone"); overlapDone.release(); await reply; await completed(timed.title).waitFor();
    assert.equal(byTitle("Overlapping board update").length, 1); assert.ok(one(timed.title).doneAt);
    check("overlappingBoardMutationsRetainLaterOptimisticUpdate", true);

    const failedDone = gate("todos:setDone", true);
    await doneBox(ordinary.title).click(); await until(() => failedDone.entered, "failed completion held");
    await page.getByRole("checkbox", { name: `Put back “${ordinary.title}”`, exact: true }).waitFor();
    assert.equal(await completed(ordinary.title).count(), 0);
    reply = response("todos:setDone"); failedDone.release(); assert.equal((await reply).status(), 503);
    await page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "Synthetic save failure" }).waitFor();
    assert.equal(one(ordinary.title).doneAt, undefined); assert.equal(await completed(ordinary.title).count(), 0);
    await doneBox(ordinary.title).waitFor();
    check("failedCompletionReportsErrorWithoutSuccessOrUndo", true);

    const heldDone = gate("todos:setDone");
    await doneBox(ordinary.title).click(); await until(() => heldDone.entered, "committed completion with held acknowledgement");
    assert.ok(one(ordinary.title).doneAt); assert.equal(await completed(ordinary.title).count(), 0);
    check("completionSuccessWaitsForAcknowledgement", true);
    reply = response("todos:setDone"); heldDone.release(); await reply; await completed(ordinary.title).waitFor();
    reply = response("todos:setDone"); await completed(ordinary.title).getByRole("button", { name: "Undo", exact: true }).click(); await reply;
    await doneBox(ordinary.title).waitFor(); assert.equal(one(ordinary.title)._id, ordinary._id); assert.equal(one(ordinary.title).doneAt, undefined);
    check("ordinaryCompletionUndoRestoresSameTodo", true);

    const failedRemove = gate("todos:remove", true);
    await page.getByRole("button", { name: `Remove “${literalRepeat}”`, exact: true }).click(); await until(() => failedRemove.entered, "failed removal held");
    assert.equal(await doneBox(literalRepeat).count(), 0);
    reply = response("todos:remove"); failedRemove.release(); await reply; await doneBox(literalRepeat).waitFor();
    assert.equal(byTitle(literalRepeat).length, 1);
    check("optimisticRemovalRollsBackWithoutLosingTodo", true);

    const failedRepeat = gate("todos:setRepeat", true);
    await page.getByRole("button", { name: `Make “${ordinary.title}” repeat`, exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Every day", exact: true }).click(); await until(() => failedRepeat.entered, "failed repeat held");
    await doneBox(ordinary.title).locator("xpath=ancestor::li").getByRole("button", { name: /Repeats daily: change/i }).waitFor();
    reply = response("todos:setRepeat"); failedRepeat.release(); await reply;
    await page.getByRole("button", { name: `Make “${ordinary.title}” repeat`, exact: true }).waitFor();
    await page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "Couldn't change the repeat" }).waitFor();
    assert.equal(one(ordinary.title).repeat, undefined);
    await page.keyboard.press("Escape");
    check("optimisticRepeatRollsBackAndReportsFailure", true);

    reply = response("todos:setDone"); await doneBox(recurring.title).click(); await reply; await completed(recurring.title).waitFor();
    await completed(recurring.title).getByText("Its next occurrence is on your list.", { exact: true }).waitFor();
    assert.equal(await completed(recurring.title).getByRole("button", { name: "Undo", exact: true }).count(), 0);
    const versions = byTitle(recurring.title), next = versions.filter(row => !row.doneAt);
    assert.equal(versions.length, 2); assert.equal(next.length, 1); assert.ok(next[0].dueAt > recurring.dueAt && next[0].dueAt > Date.now());
    check("repeatCompletionExplainsOneFutureOccurrenceWithoutUndo", true);

    for (let i = 0; i < 23; i++) await p.call("todos:add", { key: KEY, title: `Viewport filler ${i}` });
    await add("Below the fold capture");
    const row = doneBox("Below the fold capture");
    await row.waitFor(); const position = await row.boundingBox();
    assert.ok(position && position.y > await page.evaluate(() => innerHeight));
    assert.ok(await added("Below the fold capture").isVisible());
    check("addToastConfirmsTodoEvenWhenSortedBelowViewport", true);

    await page.setViewportSize({ width: 390, height: 844 });
    await input().fill("A long literal QA review title tomorrow at 9am");
    await form().getByRole("button", { name: "Use text only", exact: true }).waitFor();
    await noOverflow(); assert.ok(await addButton().isVisible());
    notes.dashboardViewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    await page.screenshot({ path: join(output, "dashboard-390.png") });
    check("dashboard390KeepsAddAndCorrectionWithoutOverflow", true);

    await page.setViewportSize({ width: 404, height: 760 }); await page.goto(`${BASE}/pet`);
    await openPet();
    await page.getByRole("tab", { name: "To-dos", exact: true }).click(); await input().waitFor();
    await noOverflow();
    await input().fill("Pet callback capture"); reply = response("todos:add"); await addButton().click(); await reply;
    await until(async () => await input().inputValue() === "", "pet add acknowledgement");
    assert.equal(one("Pet callback capture").doneAt, undefined); assert.equal(await added("Pet callback capture").count(), 0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText("Got it: Pet callback capture", { exact: true }).waitFor();
    check("pet404UsesExistingAddCallbackWithoutDuplicateToast", true);
    await openPet(); await input().waitFor();
    const petFailed = gate("todos:setDone", true);
    await doneBox("Pet callback capture").click(); await until(() => petFailed.entered, "pet failed completion");
    reply = response("todos:setDone"); petFailed.release(); await reply;
    await page.getByRole("alert").filter({ hasText: "Synthetic save failure" }).waitFor();
    assert.equal(one("Pet callback capture").doneAt, undefined);
    check("petFailedCompletionUsesProblemCallbackWithoutCompleting", true);
    const beforePetDone = calls.filter(call => call.path === "todos:setDone" && call.args.id === one("Pet callback capture")._id).length;
    reply = response("todos:setDone"); await doneBox("Pet callback capture").click(); await reply;
    await until(() => Boolean(one("Pet callback capture").doneAt), "pet completion");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText("Done!", { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path === "todos:setDone" && call.args.id === one("Pet callback capture")._id).length - beforePetDone, 1);
    assert.equal(await completed("Pet callback capture").count(), 0);
    check("petCompletionAcknowledgesOnceWithoutSecondMutation", true);
    await openPet(); await input().waitFor();
    const petFailedAdd = gate("todos:add", true); await enter("Pet unsaved draft"); await until(() => petFailedAdd.entered, "pet add failure held");
    reply = response("todos:add"); petFailedAdd.release(); await reply;
    await form().getByRole("alert").filter({ hasText: "Synthetic save failure. Retry your to-do." }).waitFor();
    assert.equal(await input().inputValue(), "Pet unsaved draft"); assert.equal(byTitle("Pet unsaved draft").length, 0);
    assert.equal(await page.getByText("Got it: Pet unsaved draft", { exact: true }).count(), 0);
    await noOverflow(); notes.petViewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    await page.screenshot({ path: join(output, "pet-404.png") });
    check("petFailedAddRetainsDraftWithoutSuccessCallback", true);
    assert.equal(browser.errors.length, 0); assert.equal(p.rows("codexTurns").length, 0);
    check("noBrowserRuntimeErrorsOrRunnerModelWork", true);
  }
  notes.browserErrors = browser.errors; ok = true;
} catch (error) {
  notes.stoppedAt = String(error); notes.todos = todos();
  try { notes.visibleFailure = await page?.locator("body").innerText(); await page?.screenshot({ path: join(output, "failure.png") }); } catch {}
  check("journeyCompleted", false, String(error));
} finally { for (const item of allGates) item.release(); await connected?.close().catch(() => {}); }
notes.calls = calls;
process.exitCode = await p.finish({ ok, mode: overlapOnly ? "overlap-failure-baseline" : "full-feedback-acceptance" }) ? 0 : 1;
