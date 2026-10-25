import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const output = resolve("artifacts/message-lifecycle");
const scratch = resolve("node_modules/.cache/perry-message-lifecycle", `run-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
process.env.PERRY_HOME = join(scratch, "home");
process.env.DASHBOARD_KEY = "message-lifecycle-synthetic";
process.env.PERRY_ENGINE = "codex";
process.env.PERRY_CREDENTIAL_KEY = "33".repeat(32);
process.env.PERRY_EMBED_MODEL = "fixture";
// Stand in for local embedding compute; all application handlers remain real.
(globalThis as any).__perryEmbedders = new Map([["fixture", Promise.resolve(async (texts: string[]) => texts.map(() => [1, 0]))]]);
(globalThis as any).__perryEmbeddersReady = new Set(["fixture"]);
globalThis.fetch = async () => { throw new Error("Network disabled in message lifecycle fixture"); };
const [{ Runtime }, { default: schema }, { modules }] = await Promise.all([
  import("../../server/runtime"), import("../../convex/schema"), import("../../server/modules"),
]);
const sql = new DatabaseSync(join(scratch, "fixture.sqlite"));
const runtime = new Runtime(sql, schema as never, modules, { storageDir: join(scratch, "storage") });
await runtime.stop();
const db = runtime.store;
const call = async (path: string, args: object) => (await runtime.call(path, args, { internal: true })).value as any;
const key = process.env.DASHBOARD_KEY;
const token = "message-lifecycle-fake-runner";
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
function check(name: string, pass: boolean) { checks[name] = pass; if (!pass) throw new Error(name); }
const rows = async (table: string) => await db.query(table).collect() as any[];
async function chat() {
  return await call("dashboard:createChat", { key });
}
async function send(id: string, text: string, extra: object = {}) {
  await call("dashboard:sendChat", { key, id, text, ...extra });
  const scheduled = sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn' ORDER BY rowid DESC LIMIT 1").get() as { args: string };
  return JSON.parse(scheduled.args);
}
async function prepare(accepted: any) {
  const turn = db.get(accepted.preparingId)!;
  const attachments = await call("media:forTurn", { conversationId: turn.conversationId, attachmentIds: accepted.attachmentIds });
  return await call("codex:enqueueTurn", {
    conversationId: turn.conversationId, runId: turn.runId, prompt: accepted.text,
    instructions: "Isolated fake runner", engine: "codex", policy: "steer",
    preparingId: accepted.preparingId, attachments,
  });
}
async function finish(id: string, extra: object = {}) {
  await call("codex:finishTurn", { token, id, response: "Fixture reply", ...extra });
  await call("codex:finalizeTurn", { id });
}
async function start(id: string, text: string) {
  const accepted = await send(id, text);
  const turnId = await prepare(accepted);
  check(`claim ${text}`, Boolean(await call("codex:claimTurn", { token, id: turnId })));
  return turnId;
}
async function refuses(name: string, path: string, args: object) {
  let refused = false;
  try { await call(path, args); } catch { refused = true; }
  check(name, refused);
}
try {
  await runtime.exclusive(() => db.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now(), autoUpdate: false }));
  await runtime.exclusive(() => db.insert("runners", { name: "Fake runner", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] }));
  const integrated = await chat();
  const integratedArgs = await send(integrated, "full scheduled preparation");
  await call("brain:handleTurn", integratedArgs);
  const integratedTurn = db.get(integratedArgs.preparingId)!;
  check("real scheduled brain preparation fills the reserved turn", integratedTurn.status === "queued" && !integratedTurn.preparing && Boolean(integratedTurn.instructions) && Boolean(integratedTurn.runnerId));
  check("real prepared turn reaches the fake runner", Boolean(await call("codex:claimTurn", { token, id: integratedTurn._id })));
  await finish(integratedTurn._id);
  check("full admission-to-history journey releases pending count", db.get(integrated)?.pendingTurns === 0);
  const id = await chat();
  const accepted = await send(id, "first message");
  evidence.accepted = accepted;
  const pending = (await rows("codexTurns")).find(turn => turn.conversationId === id);
  check("accepted message has a durable turn before preparation", Boolean(pending));
  check("preparing message cannot be claimed", await call("codex:claimTurn", { token, id: pending._id }) === null);
  await call("dashboard:stopChat", { key, id });
  check("Stop cancels preparation", db.get(pending._id)?.status === "done" && db.get(pending._id)?.stopped === true);
  check("late successful handoff cannot resurrect Stop", await prepare(accepted) === pending._id && db.get(pending._id)?.status === "done");
  await call("codex:failPreparation", { id: pending._id, error: "Late preparation failure" });
  check("late preparation failure cannot overwrite Stop", !db.get(pending._id)?.error);
  await call("brain:handleTurn", accepted);
  check("cancelled scheduled preparation exits", (await rows("codexTurns")).filter(t => t.conversationId === id).length === 1);
  await call("codex:finalizeTurn", { id: pending._id });
  await call("codex:finalizeTurn", { id: pending._id });
  check("stopped preparation finalizes once and releases pending count", db.get(id)?.pendingTurns === 0 && (await rows("agentMessages")).filter(m => m.text === "first message").length === 1);

  const fifo = await chat();
  const first = await send(fifo, "FIFO first");
  const second = await send(fifo, "FIFO second");
  const secondTurn = await prepare(second);
  check("later preparation cannot overtake earlier send", await call("codex:claimTurn", { token, id: secondTurn }) === null);
  const firstTurn = await prepare(first);
  check("first accepted message starts first", Boolean(await call("codex:claimTurn", { token, id: firstTurn })));
  await finish(firstTurn);
  check("follow-up sent before startup stays a separate turn", !(await rows("codexSteers")).some(s => s.conversationId === fifo));
  check("second accepted message starts after first", Boolean(await call("codex:claimTurn", { token, id: secondTurn })));
  await finish(secondTurn);
  const fifoThread = db.get(fifo)?.threadId;
  check("FIFO history and pending accounting", (await rows("agentMessages")).filter(m => m.threadId === fifoThread && m.message.role === "user").map(m => m.text).join("|") === "FIFO first|FIFO second" && db.get(fifo)?.pendingTurns === 0);

  const steering = await chat();
  const active = await start(steering, "steering original");
  const messageKey = "media-followup";
  const attachment = await call("dashboard:registerAttachment", { key, conversationId: steering, messageKey, localPath: "C:/fixture/image.png", fileName: "image.png", contentType: "image/png", size: 12 });
  const followup = await send(steering, "steer with image", { messageKey, attachmentIds: [attachment] });
  const steerId = await prepare(followup);
  const steer = db.get(steerId)!;
  check("follow-up targets the original running turn", steer.turnId === active && steer.status === "pending");
  check("steering preserves media", (steer.attachments as any[])?.[0]?.localPath === "C:/fixture/image.png");
  await call("codex:ackSteer", { token, id: steerId, applied: true });
  const queued = await send(steering, "explicitly queued", { mode: "queue" });
  const queuedTurn = await prepare(queued);
  check("explicit Queue does not steer", db.get(queuedTurn)?.status === "queued" && !db.get(queuedTurn)?.turnId);
  check("explicit Queue waits for active turn", await call("codex:claimTurn", { token, id: queuedTurn }) === null);
  await finish(active);
  check("applied steer releases its pending count", db.get(steering)?.pendingTurns === 1);
  const mediaPage = await call("dashboard:getChatMessages", { key, id: steering, paginationOpts: { cursor: null, numItems: 30 } });
  check("steered media is preserved in final history", mediaPage.page.find((m: any) => m.text === "steer with image")?.attachments[0]?.fileName === "image.png");
  check("explicit queued message can now start", Boolean(await call("codex:claimTurn", { token, id: queuedTurn })));
  await finish(queuedTurn);

  const changing = await chat();
  const old = await start(changing, "old target");
  const late = await send(changing, "late follow-up");
  const replacement = await send(changing, "replacement reply", { mode: "queue" });
  const replacementId = await prepare(replacement);
  await finish(old);
  check("preparation holds its queue position during target completion", await call("codex:claimTurn", { token, id: replacementId }) === null);
  // Simulate a legacy/newer active turn: a late update must never join it.
  await runtime.exclusive(() => db.patch(replacementId, { status: "running", startedAt: Date.now() }));
  const lateId = await prepare(late);
  check("finished target cannot redirect a late steer to a newer reply", db.get(lateId)?.status === "queued" && !db.get(lateId)?.turnId);
  await call("dashboard:stopChat", { key, id: changing });
  await finish(replacementId);
  await call("codex:finalizeTurn", { id: lateId });

  const stoppedChat = await chat();
  const otherChat = await chat();
  const stoppedTurn = await start(stoppedChat, "stop this chat");
  const otherTurn = await start(otherChat, "keep other chat running");
  const missed = await send(stoppedChat, "pending steer at stop");
  const missedSteer = await prepare(missed);
  await call("codex:streamTurn", { token, id: stoppedTurn, text: "Preserved partial" });
  await call("dashboard:stopChat", { key, id: stoppedChat });
  await call("codex:ackSteer", { token, id: missedSteer, applied: false, error: "Interrupted before delivery" });
  await finish(stoppedTurn, { response: undefined, error: "usage limit", errorCode: "limit" });
  const terminal = db.get(stoppedTurn)!;
  check("Stop beats a late engine error and disables retry", terminal.stopped === true && terminal.status === "done" && !terminal.retrying && !terminal.error);
  check("Stop retains streamed partial text", terminal.response === "Preserved partial");
  const fallback = (await rows("codexTurns")).find(t => t.runId === db.get(missedSteer)?.runId);
  check("pending steer cannot become runnable after Stop", fallback?.status === "done" && fallback.stopped === true);
  await call("codex:finalizeTurn", { id: fallback._id });
  check("Stop affects only its chat", db.get(otherTurn)?.status === "running" && !db.get(otherTurn)?.stopRequested);
  await finish(otherTurn);
  check("Stop releases original and fallback pending counts", db.get(stoppedChat)?.pendingTurns === 0);

  const successRace = await chat();
  const successRaceTurn = await start(successRace, "stop versus success");
  await call("dashboard:stopChat", { key, id: successRace });
  await finish(successRaceTurn);
  check("Stop beats late normal completion", db.get(successRaceTurn)?.stopped === true);

  const orderedSteers = await chat();
  const orderedActive = await start(orderedSteers, "ordered updates");
  const earlier = await send(orderedSteers, "first update");
  const later = await send(orderedSteers, "second update");
  const laterId = await prepare(later);
  check("later steer waits for earlier preparation", !(await call("codex:pendingSteers", { token })).some((s: any) => s.turnId === orderedActive));
  const earlierId = await prepare(earlier);
  const updates = (await call("codex:pendingSteers", { token })).filter((s: any) => s.turnId === orderedActive);
  check("only earliest update is delivered before acknowledgement", updates.length === 1 && updates[0]._id === earlierId);
  const repeated = await call("codex:enqueueTurn", { conversationId: orderedSteers, runId: db.get(earlierId)?.runId, prompt: earlier.text, instructions: "Repeated handoff", preparingId: earlier.preparingId });
  check("accepted steer handoff is idempotent", repeated === earlierId);
  await call("codex:ackSteer", { token, id: earlierId, applied: true });
  check("next update is delivered after acknowledgement", (await call("codex:pendingSteers", { token })).some((s: any) => s._id === laterId));
  await call("codex:ackSteer", { token, id: laterId, applied: true });
  await finish(orderedActive);

  const fallbackChat = await chat();
  const fallbackActive = await start(fallbackChat, "fallback original");
  const earlySteer = await send(fallbackChat, "earlier refused steer");
  const earlySteerId = await prepare(earlySteer);
  const laterQueue = await send(fallbackChat, "later queued message", { mode: "queue" });
  const laterQueueId = await prepare(laterQueue);
  await call("codex:ackSteer", { token, id: earlySteerId, applied: false, error: "No active turn" });
  const fallbackId = db.get(earlySteerId)?.queuedTurnId as string;
  check("refused steer keeps its acceptance order", Number(db.get(fallbackId)?.createdAt) < Number(db.get(laterQueueId)?.createdAt));
  await finish(fallbackActive);
  check("later queue cannot overtake steer fallback", await call("codex:claimTurn", { token, id: laterQueueId }) === null);

  const full = await chat();
  const reservations = [];
  for (let i = 0; i < 10; i++) reservations.push(await send(full, `capacity ${i}`));
  await refuses("queue capacity includes preparing sends", "dashboard:sendChat", { key, id: full, text: "overflow" });
  const readyAtCapacity = await prepare(reservations[0]);
  check("preparation replaces rather than duplicates its queue slot", (await rows("codexTurns")).filter(t => t.conversationId === full && t.status === "queued").length === 10 && !db.get(readyAtCapacity)?.preparing);
  const removed = reservations[1].preparingId;
  check("preparing send can be removed", await call("queue:remove", { key, conversationId: full, id: removed }) === true);
  await prepare(reservations[1]);
  check("removed send cannot be resurrected", db.get(removed)?.status === "done" && Boolean(db.get(removed)?.finalizedAt));
  await send(full, "space after removal");
  check("removal releases one pending count", db.get(full)?.pendingTurns === 10);

  const abandoned = await chat();
  const abandonedArgs = await send(abandoned, "preparation lost on restart");
  await call("recovery:sweep", { only: abandoned, now: Number(db.get(abandonedArgs.preparingId)?.createdAt) + 301_000 });
  check("orphaned preparation is recovered", db.get(abandonedArgs.preparingId)?.status === "error" && !db.get(abandonedArgs.preparingId)?.preparing);
  await call("codex:finalizeTurn", { id: abandonedArgs.preparingId });
  check("recovery releases pending count", db.get(abandoned)?.pendingTurns === 0);

  await refuses("duplicate media rejected", "dashboard:sendChat", { key, id: steering, text: "duplicates", messageKey, attachmentIds: [attachment, attachment] });
  await runtime.exclusive(() => db.patch(attachment, { removedAt: Date.now() }));
  await refuses("removed media rejected", "dashboard:sendChat", { key, id: steering, text: "removed", messageKey, attachmentIds: [attachment] });
  const pauseChat = await chat();
  const pauseSend = await send(pauseChat, "pause during preparation");
  await call("pause:set", { key, paused: true });
  check("Pause stops preparation without an assigned runner", db.get(pauseSend.preparingId)?.status === "done" && db.get(pauseSend.preparingId)?.stopped === true);
  await call("pause:set", { key, paused: false });
  await call("brain:handleTurn", pauseSend);
  check("Resume cannot resurrect a paused preparation", db.get(pauseSend.preparingId)?.status === "done");
  await call("codex:finalizeTurn", { id: pauseSend.preparingId });
  check("paused preparation releases pending count", db.get(pauseChat)?.pendingTurns === 0);
  evidence.journeys = { fifo, steering, changing, stoppedChat, otherChat, full, abandoned };
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  mkdirSync(output, { recursive: true });
  const result = { passed: !evidence.error && Object.values(checks).every(Boolean), checks, evidence };
  writeFileSync(join(output, process.argv.includes("--baseline") ? "baseline.json" : "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  await runtime.stop();
  sql.close();
}
