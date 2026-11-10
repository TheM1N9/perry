import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/chat-timeline/run.ts <outDir>
// The chat's timeline after T3 Code: what the agent is doing ("Working for 12s" and the one step it is on), the
// finished turn folded to "Worked for 46s · Ran 2 commands…", and the queue docked on the composer with Send now
// (into the running reply when it can join it), Edit in the composer, Remove, and reordering. A fresh Perry from the production build (`pnpm build` first),
// the real runner and Codex (signed in with ChatGPT), headless Chrome. Replies run on PERRY_E2E_MODEL
// (gpt-6-luna by default).
//
// Ways it could fail, and what this checks for each:
//   1. Queued messages still render as sent bubbles in the conversation, or scroll away with it: they must sit on
//      the composer, after the live reply in the page and still in view with the chat scrolled up, their bubbles
//      dashed and unfilled, "4 queued" said to screen readers, and each row read as "Queued message 1 of 4, not
//      sent" with "Send now" as its first action.
//   2. A long queue pushes the reply out of view: with more than three, two show and "Show all 4 queued" opens
//      the rest.
//   3. The live reply still lists every step, or none: while it runs there must be one "Working for Ns" line
//      and exactly one line for the step it is on, in the present tense ("Running …"), with no list open.
//   4. The running time re-renders the chat each second: its text must advance while nothing in the composer
//      or the history changes in the page for those seconds.
//   5. The step list cannot be reached while live: a click on the live step must open every step.
//   6. The finished turn does not fold, or folds without saying what it did: above its reply it must read
//      "Worked for Ns · Ran N command(s)…", closed, and open to steps with a kind icon each, past tense ("Ran …"),
//      a duration each, in a list no taller than 18rem that scrolls.
//   7. Edit loses the message or the draft: Edit must put the queued words in the composer, mark the row
//      "Editing in the composer", and Save must change the queued turn's prompt and the bubble, and give the
//      composer back what it held before (nothing, here).
//   8. Remove leaves the message to run: the turn must end stopped, and its row go.
//   9. Reordering does nothing, or only on screen: ArrowUp on a row's grip must move it up on screen and in
//      the order turns are claimed (B, moved first, starts before C).
//  10. Send now during a reply queues instead, or joins another reply: it must make a steer of the running turn,
//      applied, the message gone from the queue and saved in the history.
//  11. Send now does nothing: during a /compact (which nothing can join) queued rows must offer "Send now",
//      and it must move that message to the front, so it starts first.
//  12. Compaction is said nowhere, or as a note that never goes: the end of the timeline must say
//      "Compacting context" while it runs and "Context compacted" after.
//  13. The jump-to-latest pill says nothing of what goes on: scrolled up during the reply it must read
//      "Jump to latest · Working" (the queue is in view on the composer, so it is not repeated).
//  14. Any of it throws in the page: no page errors. Screenshots at 1280 and 390 wide, live and folded.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/chat-timeline/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const p = await perry({ name: "chat-timeline", outDir, runnerEnv: () => ({}), engine: "codex" });
const { BASE, KEY, call, check, notes, until, rows, computers, openBrowser, turnsOf, messagesOf } = p;

const QUEUED = {
  a: "Queued A: reply with the single word alpha.",
  b: "Queued B: reply with the single word beta.",
  c: "Queued C: reply with the single word gamma.",
  d: "Queued D: reply with the single word delta.",
};
const EDITED = "Queued C, edited: reply with the single word gamma-two.";
// Long enough to queue, edit, remove, reorder and steer while the first reply runs.
// Commands with no quotes in them: Codex on Windows may wrap a command in PowerShell, whose quoting broke a `node -e "…"`
// sleep so that it ended at once and left nothing running to watch.
const PING = process.platform === "win32" ? "ping -n 61 127.0.0.1" : "ping -c 61 127.0.0.1";
const FIRST = `Use the shell. First run exactly this command and wait for it to finish: ${PING} `
  + "Then run hostname as a second command. Then reply with the single word done.";

try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)),
    "the runner to report Codex signed in", 120);

  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: chat, title: "Chat timeline" });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: MODEL, engine: "codex" });

  const browser = await openBrowser();
  const { evaluate, send, errors } = browser;
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const width = async (value: 1280 | 390) => {
    await send("Emulation.setDeviceMetricsOverride", value === 390
      ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
      : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
  };
  const turn = (prompt: string) => turnsOf(chat).find((row) => row.prompt === prompt || row.prompt.startsWith(prompt.split(":")[0]!));
  const position = (row: Record<string, any>) => row.queueOrder ?? row.createdAt;
  /** The queued rows as shown: their words, what their send button says, and what it does (steer or send). */
  const upNext = () => evaluate(`[...document.querySelectorAll('section[data-up-next] li[data-queued]')].map((li) => ({
    text: li.querySelector('p')?.textContent ?? '', label: li.getAttribute('aria-label'),
    dashed: Boolean(li.querySelector('.border-dashed')), says: li.querySelector('[data-queue-action]')?.textContent?.trim() ?? null,
    action: li.querySelector('[data-queue-action]')?.getAttribute('data-queue-action') ?? null,
    editing: li.textContent.includes('Editing in the composer') }))`) as Promise<Array<{ text: string; label: string; dashed: boolean; says: string | null; action: string | null; editing: boolean }>>;
  /** Click a control in the Up next row whose words start like `text`. */
  const press = (text: string, selector: string) => evaluate(`(() => {
    const li = [...document.querySelectorAll('section[data-up-next] li[data-queued]')].find((li) => (li.querySelector('p')?.textContent ?? '').startsWith(${JSON.stringify(text.slice(0, 9))}));
    const button = li?.querySelector(${JSON.stringify(selector)}); if (!button || button.disabled) return false; button.click(); return true; })()`) as Promise<boolean>;
  const composerValue = () => evaluate(`document.querySelector('textarea#composer')?.value ?? null`) as Promise<string | null>;
  const typeInComposer = (text: string) => evaluate(`(() => { const box = document.querySelector('textarea#composer');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true })); box.focus(); return true; })()`);

  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await until(() => evaluate(`Boolean(document.querySelector('textarea#composer'))`), "the chat to open", 30);

  // --- The first reply, live -----------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: FIRST });
  await until(() => turn(FIRST)?.status === "running", "the first reply to start", 60);
  const first = turn(FIRST)!;
  // The long command in particular: the model may run the quick one first, and the checks below need time.
  await until(() => rows("runSpans").some((span) => span.runId === first.runId && span.kind === "command" && span.status === "running" && /ping/.test(span.name ?? "")), "the long command to start", 120);
  await until(() => evaluate(`Boolean([...document.querySelectorAll('[data-live-reply] [data-live-step][data-status="running"]')].some((step) => step.textContent.includes('ping')))`), "the live step line", 20);
  const live = await evaluate(`(() => { const reply = document.querySelector('[data-live-reply]');
    return { work: reply.querySelector('[data-work]')?.getAttribute('data-work-state'), head: reply.querySelector('[data-work] [data-slot=trace-title]')?.textContent ?? '',
      steps: reply.querySelectorAll('[data-live-step]').length, step: reply.querySelector('[data-live-step]')?.textContent ?? '', list: Boolean(reply.querySelector('[data-work-steps]')),
      replies: document.querySelectorAll('[data-live-reply]').length }; })()`) as
    { work: string; head: string; steps: number; step: string; list: boolean; replies: number };
  notes.live = live;
  // A reply in progress is shown once: siblings that shared a React key once left a copy behind at every update.
  check("oneLiveReply", live.replies === 1);
  check("liveShowsWorkingAndOneStep", live.work === "working" && /^Working for \d+(s|m \d+s)$/.test(live.head) && live.steps === 1 && /^Running /.test(live.step) && !live.list);

  // 4. The time advances by itself; nothing else in the page is touched meanwhile.
  // A reply's data landing re-renders the screen once (React re-applies an input's name and type then); what this
  // looks for is a render every second, so it counts the seconds that saw a change, not the changes.
  await evaluate(`(() => { window.__churn = 0; window.__churned = []; window.__churnSince = performance.now(); window.__churnSeconds = new Set(); window.__churnObserver?.disconnect();
    window.__churnObserver = new MutationObserver((records) => { window.__churn += records.length; window.__churnSeconds.add(Math.floor((performance.now() - window.__churnSince) / 1000));
      for (const record of records) window.__churned.push([record.type, record.attributeName, (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.outerHTML?.slice(0, 160)]); });
    for (const node of [document.querySelector('[data-composer]'), ...document.querySelectorAll('[data-role="user"]')]) if (node) window.__churnObserver.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
    return true; })()`);
  const before = await evaluate(`document.querySelector('[data-live-reply] [data-work] [data-slot=trace-title]').textContent`) as string;
  await sleep(3_200);
  const after = await evaluate(`document.querySelector('[data-live-reply] [data-work] [data-slot=trace-title]').textContent`) as string;
  const churn = await evaluate(`(window.__churnObserver.disconnect(), window.__churn)`) as number;
  const seconds = await evaluate(`window.__churnSeconds.size`) as number;
  notes.timer = { before, after, churn, seconds, churned: await evaluate(`window.__churned.slice(0, 20)`) };
  check("timerTicksWithoutChurn", before !== after && seconds <= 1);

  // --- Up next -------------------------------------------------------------------------------------------------
  for (const text of Object.values(QUEUED)) await call("dashboard:sendChat", { key: KEY, id: chat, text, mode: "queue" });
  await until(() => Object.values(QUEUED).every((text) => { const row = turn(text); return row?.status === "queued" && !row.preparing; }), "the four messages to queue", 60);
  await until(async () => (await evaluate(`document.querySelector('section[data-up-next] p.sr-only')?.textContent ?? ''`) as string) === "4 queued", "the queue to list them", 20);
  const layout = await evaluate(`(() => { const live = document.querySelector('[data-live-reply]'); const next = document.querySelector('section[data-up-next]');
    return { after: Boolean(live && next && (live.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)),
      onComposer: Boolean(next && next.parentElement?.contains(document.querySelector('textarea#composer'))),
      said: next.querySelector('p.sr-only').textContent,
      showAll: [...next.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('Show all 4 queued')),
      inConversation: [...document.querySelectorAll('[data-role="user"]')].some((row) => row.textContent.includes('Queued A')) }; })()`) as
    { after: boolean; onComposer: boolean; said: string; showAll: boolean; inConversation: boolean };
  const shown = await upNext();
  notes.upNext = { layout, shown };
  check("upNextAfterLiveReply", layout.after && !layout.inConversation);
  check("upNextOnComposer", layout.onComposer);
  check("upNextDashedAndLabelled", layout.said === "4 queued" && shown.length === 2 && shown.every((row) => row.dashed)
    && shown[0]?.label === "Queued message 1 of 4, not sent" && shown[0]?.text === QUEUED.a && shown[0]?.says === "Send now");
  check("longQueueCollapses", layout.showAll);

  // 13. Scrolled up, the pill names what waits.
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 300, deltaX: 0, deltaY: -4000 });
  await sleep(800);
  const pill = await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Jump to latest'))?.textContent.trim() ?? null`) as string | null;
  // Scrolled up, the queue stays in view on the composer.
  const queueInView = await evaluate(`(() => { const next = document.querySelector('section[data-up-next]'); if (!next) return false;
    const box = next.getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight; })()`) as boolean;
  notes.pill = pill;
  check("pillNamesWhatWaits", pill === "Jump to latest · Working");
  check("queueInViewScrolledUp", queueInView);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Jump to latest'))?.click(), true`);
  await sleep(500);
  await shot("live-1280.png");
  await width(390);
  await shot("live-390.png");
  await width(1280);

  await evaluate(`[...document.querySelectorAll('section[data-up-next] button')].find((b) => b.textContent.trim().startsWith('Show all'))?.click(), true`);
  await until(async () => (await upNext()).length === 4, "every queued row to show", 10);

  // 7. Edit C in the composer.
  check("editOpens", await press(QUEUED.c, 'button[aria-label="Edit the queued message"]'));
  await until(async () => (await composerValue()) === QUEUED.c, "C's words in the composer", 10);
  const marked = (await upNext()).find((row) => row.text === QUEUED.c)?.editing ?? false;
  await typeInComposer(EDITED);
  await sleep(200);
  await evaluate(`document.querySelector('[aria-label="Save the queued message"]').click(), true`);
  await until(() => turn(QUEUED.c)?.prompt === EDITED, "C's prompt to change", 20).catch(() => {});
  await until(async () => (await upNext()).some((row) => row.text === EDITED), "C's bubble to change", 10).catch(() => {});
  notes.edit = { marked, prompt: turn(QUEUED.c)?.prompt, composer: await composerValue() };
  check("editSavesInPlace", marked && turn(QUEUED.c)?.prompt === EDITED && (await upNext()).some((row) => row.text === EDITED) && (await composerValue()) === "");

  // 8. Remove D.
  check("removeClicked", await press(QUEUED.d, 'button[aria-label="Remove the queued message"]'));
  await until(() => turn(QUEUED.d)?.status === "done", "D to leave the queue", 20).catch(() => {});
  await until(async () => (await upNext()).length === 3, "D's row to go", 10).catch(() => {});
  notes.remove = { status: turn(QUEUED.d)?.status, stopped: turn(QUEUED.d)?.stopped, rows: (await upNext()).map((row) => row.text) };
  check("removeStopsIt", turn(QUEUED.d)?.status === "done" && turn(QUEUED.d)?.stopped === true && !(await upNext()).some((row) => row.text === QUEUED.d));

  // 9. B up past A, with the arrow key on its grip.
  await evaluate(`(() => { const li = [...document.querySelectorAll('section[data-up-next] li[data-queued]')].find((li) => li.querySelector('p')?.textContent === ${JSON.stringify(QUEUED.b)});
    li.querySelector('[data-grip]').focus(); return true; })()`);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
  await until(() => position(turn(QUEUED.b)!) < position(turn(QUEUED.a)!), "B to move ahead of A", 10).catch(() => {});
  await until(async () => (await upNext())[0]?.text === QUEUED.b, "B's row to lead", 10).catch(() => {});
  const order = (await upNext()).map((row) => row.text);
  const gripFocused = await evaluate(`document.activeElement?.hasAttribute('data-grip') && document.activeElement.closest('li')?.querySelector('p')?.textContent === ${JSON.stringify(QUEUED.b)}`) as boolean;
  notes.reorder = { order, gripFocused };
  check("reorderMovesIt", order[0] === QUEUED.b && order[1] === QUEUED.a && position(turn(QUEUED.b)!) < position(turn(QUEUED.a)!));
  check("reorderKeepsFocus", gripFocused);

  // 10. Steer A into the reply running.
  const steerRow = (await upNext()).find((row) => row.text === QUEUED.a);
  const steerLabel = steerRow?.action;
  check("steerClicked", steerLabel === "steer" && steerRow?.says === "Send now" && await press(QUEUED.a, "[data-queue-action]"));
  await until(() => rows("codexSteers").some((steer) => steer.conversationId === chat && steer.prompt === QUEUED.a), "A to become a steer", 20).catch(() => {});
  await until(() => rows("codexSteers").find((steer) => steer.prompt === QUEUED.a)?.status !== "pending", "the runner to answer the steer", 60).catch(() => {});
  const steer = rows("codexSteers").find((row) => row.conversationId === chat && row.prompt === QUEUED.a);
  notes.steer = { label: steerLabel, status: steer?.status, error: steer?.error, intoFirst: steer?.turnId === first._id };
  check("steerJoinsRunningTurn", steer?.turnId === first._id && steer?.status === "applied" && !(await upNext()).some((row) => row.text === QUEUED.a));

  // --- The first reply, finished -------------------------------------------------------------------------------
  await until(() => turn(FIRST)?.status === "done" || turn(FIRST)?.status === "error", "the first reply to finish", 240);
  await until(() => evaluate(`Boolean(document.querySelector('[data-role="assistant"] [data-work][data-work-state="done"]'))`), "the first reply's fold", 30).catch(() => {});
  const fold = await evaluate(`(() => { const work = document.querySelector('[data-role="assistant"] [data-work][data-work-state="done"]');
    const trigger = work?.querySelector('button[aria-expanded]');
    return { label: work?.querySelector('[data-slot=trace-title]')?.textContent ?? '', open: trigger?.getAttribute('aria-expanded') ?? null }; })()`) as { label: string; open: string | null };
  await evaluate(`document.querySelector('[data-role="assistant"] [data-work][data-work-state="done"] button[aria-expanded]')?.click(), true`);
  await until(() => evaluate(`Boolean(document.querySelector('[data-role="assistant"] [data-work-steps] ol li'))`), "the fold's steps", 15).catch(() => {});
  const steps = await evaluate(`(() => { const list = document.querySelector('[data-role="assistant"] [data-work-steps] ol'); if (!list) return null; const style = getComputedStyle(list);
    return { maxHeight: parseFloat(style.maxHeight), overflow: style.overflowY, rows: [...list.children].map((li) => ({
      icon: Boolean(li.querySelector('[data-slot=trace-icon] svg')), label: li.querySelector('[data-slot=trace-title]')?.textContent ?? '',
      time: li.querySelector('[data-slot=trace-description]')?.textContent ?? '', height: li.querySelector('[data-slot=trace-line]')?.getBoundingClientRect().height ?? 0 })) }; })()`) as
    { maxHeight: number; overflow: string; rows: Array<{ icon: boolean; label: string; time: string; height: number }> } | null;
  notes.fold = { fold, steps };
  check("foldSaysWhatItDid", fold.open === "false" && /^Worked for \d+(s|m \d+s) · Ran \d+ commands?/.test(fold.label));
  check("foldOpensCappedPastTenseSteps", Boolean(steps && steps.rows.length >= 2 && steps.maxHeight <= 288 && /auto|scroll/.test(steps.overflow)
    && steps.rows.every((row) => row.icon && row.time && row.height <= 28) && steps.rows.some((row) => /^Ran /.test(row.label))));
  // A message queued during the first reply comes after it once that reply is saved, not above it by its earlier clock.
  const transcript = await evaluate(`[...document.querySelectorAll('[data-role="user"]')].map((node) => node.textContent.trim())`) as string[];
  const at = (text: string) => transcript.findIndex((line) => line.includes(text.slice(0, 30)));
  notes.transcript = transcript;
  check("transcriptInOrder", at(FIRST) >= 0 && (at(QUEUED.b) === -1 || at(FIRST) < at(QUEUED.b)) && (at(QUEUED.a) === -1 || at(FIRST) < at(QUEUED.a)));
  await shot("fold-1280.png");
  await width(390);
  await shot("fold-390.png");
  await width(1280);

  // 9 and 10, after: B was claimed before C, and A was saved with the first reply.
  await until(() => turn(QUEUED.b)?.startedAt !== undefined && turn(EDITED)?.startedAt !== undefined, "B and C to start", 300).catch(() => {});
  notes.claims = { b: turn(QUEUED.b)?.startedAt, c: turn(EDITED)?.startedAt };
  check("reorderChangesClaimOrder", (turn(QUEUED.b)?.startedAt ?? Infinity) < (turn(EDITED)?.startedAt ?? -Infinity));
  const history = await messagesOf(chat);
  check("steeredMessageSaved", history.some((message) => message.role === "user" && message.text === QUEUED.a && !(message as { pending?: boolean }).pending));
  await until(() => turnsOf(chat).every((row) => row.status !== "queued" && row.status !== "running"), "the queue to empty", 300);

  // --- 11 and 12. Send now, during a /compact -------------------------------------------------------------------
  const E = "Queued E: reply with the single word epsilon.";
  const F = "Queued F: reply with the single word zeta.";
  await call("dashboard:compactChat", { key: KEY, id: chat });
  for (const text of [E, F]) await call("dashboard:sendChat", { key: KEY, id: chat, text, mode: "queue" });
  const compacting = await until(() => evaluate(`document.querySelector('[data-compaction="running"]')?.textContent?.includes('Compacting context') ?? false`), "the compaction line", 15)
    .then(() => true, () => false);
  await until(async () => (await upNext()).filter((row) => row.action === "send").length === 2, "Send now on both", 15).catch(() => {});
  const offered = (await upNext()).map((row) => row.action);
  const clicked = await press(F, "[data-queue-action]");
  await until(() => position(turn(F)!) < position(turn(E)!), "F to move to the front", 10).catch(() => {});
  notes.sendNow = { compacting, offered, clicked, f: turn(F) && position(turn(F)!), e: turn(E) && position(turn(E)!) };
  check("compactionLineWhileRunning", compacting);
  check("sendNowOfferedWhenNothingToJoin", offered.length === 2 && offered.every((action) => action === "send"));
  await until(() => turn(E)?.startedAt !== undefined && turn(F)?.startedAt !== undefined, "E and F to start", 300).catch(() => {});
  check("sendNowGoesFirst", clicked && (turn(F)?.startedAt ?? Infinity) < (turn(E)?.startedAt ?? -Infinity));
  await until(() => turnsOf(chat).every((row) => row.status !== "queued" && row.status !== "running"), "E and F to finish", 300);

  // A /compact on its own, to see it said as done.
  await call("dashboard:compactChat", { key: KEY, id: chat });
  const compacted = await until(() => evaluate(`document.querySelector('[data-compaction="ok"]')?.textContent?.includes('Context compacted') ?? false`), "Context compacted", 180)
    .then(() => true, () => false);
  check("compactionLineWhenDone", compacted);

  notes.pageErrors = errors;
  check("noPageErrors", errors.length === 0);
} catch (error) {
  notes.stoppedAt = String(error);
  // What the model did instead, when it did not follow the script (a quick command first, or none at all).
  try { notes.spans = rows("runSpans").map((span) => `${span.kind}:${span.status}:${String(span.name ?? "").slice(0, 80)}`); } catch {}
  check("completed", false);
}

process.exit(await p.finish() ? 0 : 1);
