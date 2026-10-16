import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Engine, TurnHandle } from "../../runner/engine";
import type { Doc } from "../../convex/_generated/dataModel";

// Failure cases: artifacts/task-steering/failure-cases.md, recorded before this E2E.
// Backend-to-runner-adapter E2E: real Runtime/SQLite/tasks/codex, fake running engine.
// No server, browser, scheduler, engine process or network is started here.
// Coordinator: pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-steering/run.ts
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = join(repo, ".batch-work", "batch-1", "281", "e2e", `run-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
process.env.PERRY_HOME = join(scratch, "home");
process.env.DASHBOARD_KEY = "task-steering-synthetic-key";
process.env.PERRY_ENGINE = "codex";
process.env.PERRY_CREDENTIAL_KEY = "22".repeat(32);
// Set isolation before any project module import (runner/home freezes HOME at import).
const [{ Runtime }, { default: schema }, tasks, codex, runs, work, { steerRunningTurn, createSteerDelivery }, routing, recovery] = await Promise.all([
  import("../../server/runtime"), import("../../convex/schema"), import("../../convex/tasks"),
  import("../../convex/codex"), import("../../convex/runs"), import("../../convex/work"), import("../../runner/task-steering"),
  import("../../convex/routing"), import("../../convex/recovery"),
]);
const sql = new DatabaseSync(join(scratch, "test.sqlite"));
const runtime = new Runtime(sql, schema as never, { tasks, codex, runs, work, routing, recovery }, { storageDir: join(scratch, "storage") });
await runtime.stop(); // Deterministic: no cron/action can call any model or integration.
const call = async (path: string, args: object) => (await runtime.call(path, args, { internal: true })).value as any;
const db = runtime.store;
const task = (id: string) => db.get(id) as Doc<"tasks"> | null;
const turn = (id: string) => db.get(id) as Doc<"codexTurns"> | null;
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
function check(name: string, pass: boolean) {
  checks[name] = pass;
  if (!pass) throw new Error(name);
}
async function refuses(name: string, path: string, args: object) {
  let refused = false;
  try { await call(path, args); } catch { refused = true; }
  check(name, refused);
}
const key = process.env.DASHBOARD_KEY;
const token = "task-steering-fake-runner";
const plan = [{ title: "Collected inputs", status: "done" }, { title: "Draft result", status: "active" }];
const events: object[] = [];
let fakeRunnerId = "";

async function fixture() {
  return await runtime.exclusive(() => {
    const now = Date.now();
    const origin = db.insert("conversations", { channel: "web", externalId: `owner-${now}-${Math.random()}`, threadId: "owner" });
    const runnerId = fakeRunnerId || db.insert("runners", { name: "Fake runner", token, createdAt: now, lastSeenAt: now,
      engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: now }] });
    fakeRunnerId = runnerId;
    const id = db.insert("tasks", { title: "Compare inputs", prompt: "Compare collected inputs and produce a result.", origin, status: "running", turns: 1, plan, createdAt: now, updatedAt: now });
    const conversationId = db.insert("conversations", { channel: "web", externalId: `task-${id}`, threadId: `thread-${id}`, taskId: id, access: "supervised", engine: "codex" });
    db.patch(id, { conversationId });
    const runId = db.insert("runs", { conversationId, prompt: "Do the task", status: "running", startedAt: now });
    const turnId = db.insert("codexTurns", { conversationId, runnerId, runId, engine: "codex", prompt: "Do the task", instructions: "Keep approval checks.", status: "queued", createdAt: now });
    return { id, origin, conversationId, turnId, runnerId };
  });
}

try {
  const f = await fixture();
  const claimed = await call("codex:claimTurn", { token, id: f.turnId });
  check("real claim starts original turn with supervised access", claimed?._id === f.turnId && claimed.access === "supervised");
  let release!: () => void;
  let finish!: () => void;
  const steeringArrived = new Promise<void>((done) => { release = done; });
  const finishAllowed = new Promise<void>((done) => { finish = done; });
  let active = false;
  const handle: TurnHandle = { cursor: "fake-session", turnId: "fake-active-turn" };
  const fake = {
    label: "Fake native engine", capabilities: { steer: "native" } as Engine["capabilities"],
    async steer(received: TurnHandle, message: { prompt: string }) {
      check("native steer sees same genuinely running engine turn", active && received === handle);
      check("engine receives update and preserved completed step", message.prompt.includes("Use a table") && message.prompt.includes("[done] Collected inputs"));
      events.push({ type: "steer", turnId: received.turnId });
      release();
    },
    async runTurn() {
      active = true;
      events.push({ type: "started", turnId: handle.turnId });
      await steeringArrived;
      await finishAllowed;
      await call("work:setPlan", { taskId: f.id, plan: [plan[0], { title: "Produce requested table", status: "done" }] });
      await call("work:updateTask", { taskId: f.id, status: "done", result: "Table made from existing inputs" });
      active = false;
      events.push({ type: "finished", turnId: handle.turnId });
    },
  };
  const working = fake.runTurn();
  const update = { key, id: f.id, text: "Use a table", requestId: "native-update-001" };
  const deliveryId = await call("tasks:steerFromDashboard", update);
  check("receipt is pending before acknowledgement", (await call("tasks:steeringFromDashboard", { key, id: f.id }))[0].state === "pending");
  check("unread update prevents early finish", await call("tasks:awaitingSteering", { id: f.id, turnId: f.turnId }));
  await refuses("atomic task update guard rejects early finish", "work:updateTask", { taskId: f.id, turnId: f.turnId, status: "done", result: "Too early" });
  const duplicate = await Promise.all([call("tasks:steerFromDashboard", update), call("tasks:steerFromDashboard", update)]);
  check("concurrent retry reuses one delivery", duplicate.every((id) => id === deliveryId) && task(f.id)?.steering?.length === 1);
  check("origin owner chat uses same idempotent delivery", await call("tasks:steer", { id: f.id, text: update.text, requestId: update.requestId, conversationId: f.origin }) === deliveryId);
  await refuses("id reuse with different text rejected", "tasks:steerFromDashboard", { ...update, text: "Different update" });
  const pending = await call("codex:pendingSteers", { token });
  check("native delivery uses existing pendingSteers", pending.length === 1 && pending[0]._id === deliveryId);
  await runtime.exclusive(() => db.insert("runners", { token: "another-fake-runner", name: "Other runner", createdAt: Date.now() }));
  await call("codex:ackSteer", { token: "another-fake-runner", id: deliveryId, applied: true });
  check("foreign runner cannot acknowledge delivery", db.get(deliveryId)?.status === "pending");
  const ackOutcomes: boolean[] = [];
  let attempts = 0;
  const nativeDelivery = createSteerDelivery(
    () => steerRunningTurn(fake, handle, () => ({ prompt: pending[0].prompt, attachments: [] })),
    async (outcome) => {
      attempts++;
      ackOutcomes.push(outcome.applied);
      if (attempts === 1) throw new Error("Synthetic acknowledgement transport unavailable before commit");
      await call("codex:ackSteer", { token, id: deliveryId, ...outcome });
      if (attempts === 2) throw new Error("Synthetic acknowledgement response lost after commit");
    }, async () => {},
  );
  const settling = nativeDelivery.settle();
  check("concurrent acknowledgement callers share one batch", settling === nativeDelivery.settle());
  await settling;
  check("ack transport retries preserve applied outcome", attempts === 3 && ackOutcomes.every(Boolean) && events.filter((event) => (event as { type?: string }).type === "steer").length === 1);
  await call("codex:ackSteer", { token, id: deliveryId, applied: true });
  check("delivery acknowledged without replacing turn", (await call("tasks:steeringFromDashboard", { key, id: f.id }))[0].state === "applied" && db.get(f.turnId)?.status === "running");
  check("no cancellation or extra turn", !db.get(f.turnId)?.stopRequested && !db.get(f.turnId)?.stopped && (await db.query("codexTurns").collect()).length === 1);
  check("plan and turn count unchanged by steering", JSON.stringify(task(f.id)?.plan) === JSON.stringify(plan) && task(f.id)?.turns === 1);
  check("acknowledged update allows finish", !(await call("tasks:awaitingSteering", { id: f.id, turnId: f.turnId })));
  finish();
  await working;
  await call("codex:finishTurn", { token, id: f.turnId, response: "Table made from existing inputs" });
  check("completed work survives plan revision", task(f.id)?.plan[0].status === "done" && task(f.id)?.steering?.[0].text === "Use a table");
  check("retry after completion returns original receipt", await call("tasks:steerFromDashboard", update) === deliveryId);
  evidence.native = { turnId: f.turnId, deliveryId, plan: task(f.id)?.plan, events, receipts: await call("tasks:steeringFromDashboard", { key, id: f.id }) };

  // Unsupported steering: native runner gate refuses; ackSteer owns fallback, same original turn remains active.
  const next = await fixture();
  await call("codex:claimTurn", { token, id: next.turnId });
  const fallbackId = await call("tasks:steerFromDashboard", { key, id: next.id, text: "Add a summary", requestId: "fallback-update-001" });
  let error = "";
  let refusalAckCalls = 0;
  const refusedDelivery = createSteerDelivery(
    () => steerRunningTurn({ ...fake, capabilities: { ...fake.capabilities, steer: "cancel-and-resend" } }, handle, () => ({ prompt: "Add a summary", attachments: [] })),
    async (outcome) => {
      refusalAckCalls++;
      check("engine refusal stays a refusal across ack retries", !outcome.applied);
      error = outcome.error ?? "";
      if (refusalAckCalls === 1) throw new Error("Synthetic refusal acknowledgement unavailable");
      await call("codex:ackSteer", { token, id: fallbackId, ...outcome });
      if (refusalAckCalls === 2) throw new Error("Synthetic refusal acknowledgement response lost");
    }, async () => {},
  );
  await refusedDelivery.settle();
  check("unsupported mode never cancels and resends", Boolean(error));
  await call("codex:ackSteer", { token, id: fallbackId, applied: false, error });
  const fallback = db.get(fallbackId)!;
  const queued = turn(fallback.queuedTurnId as string)!;
  check("uncertain refusal acknowledgement creates only one fallback", refusalAckCalls === 3 && (await db.query("codexTurns").withIndex("by_run", (q) => q.eq("runId", queued.runId)).collect()).length === 1);
  check("fallback queues exactly once with original access/context", fallback.status === "queued" && queued.status === "queued" && queued.access === "supervised" && queued.prompt.includes("Compare collected inputs") && queued.prompt.includes("[done] Collected inputs"));
  check("original remains running", db.get(next.turnId)?.status === "running" && !db.get(next.turnId)?.stopRequested);
  check("fallback cannot run concurrently in same task chat", await call("codex:claimTurn", { token, id: queued._id }) === null);
  check("original cannot finish task ahead of follow-up", await call("tasks:awaitingSteering", { id: next.id, turnId: next.turnId }));
  await call("codex:finishTurn", { token, id: next.turnId, error: "Synthetic original turn failed", response: "First turn progress saved" });
  await call("tasks:afterTurn", { id: next.id, error: "Synthetic original turn failed" });
  check("error finalization keeps accepted queued follow-up alive", task(next.id)?.status === "running" && task(next.id)?.plan[0].status === "done");
  check("fallback claim runs in original task chat", (await call("codex:claimTurn", { token, id: queued._id }))?.conversationId === next.conversationId);
  check("follow-up can finish its own accepted instruction", !(await call("tasks:awaitingSteering", { id: next.id, turnId: queued._id })));
  await call("work:setPlan", { taskId: next.id, plan: [plan[0], { title: "Add requested summary", status: "done" }] });
  await call("work:updateTask", { taskId: next.id, turnId: queued._id, status: "done", result: "Requested summary complete" });
  await call("codex:finishTurn", { token, id: queued._id, response: "Requested summary complete" });
  check("fallback delivery finishes without losing completed step", (await call("tasks:steeringFromDashboard", { key, id: next.id }))[0].state === "finished" && task(next.id)?.plan[0].status === "done");
  evidence.fallback = { originalTurn: db.get(next.turnId), fallback: db.get(fallbackId), receipts: await call("tasks:steeringFromDashboard", { key, id: next.id }) };

  // Exhaust bounded transport retries, then simulate the runner heartbeat settling its retained outcome.
  const uncertain = await fixture();
  await call("codex:claimTurn", { token, id: uncertain.turnId });
  const uncertainId = await call("tasks:steerFromDashboard", { key, id: uncertain.id, text: "Keep progress", requestId: "uncertain-update-001" });
  let offline = true;
  let engineCalls = 0;
  let ackCalls = 0;
  const retained = createSteerDelivery(
    () => steerRunningTurn({ label: "Fake retained engine", capabilities: fake.capabilities, steer: async () => { engineCalls++; } }, handle, () => ({ prompt: "Keep progress", attachments: [] })),
    async (outcome) => {
      ackCalls++;
      check("retained accepted outcome never becomes refusal", outcome.applied);
      if (offline) throw new Error("Synthetic ack outage");
      await call("codex:ackSteer", { token, id: uncertainId, ...outcome });
    }, async () => {},
  );
  let batchFailed = false;
  try { await retained.settle(); } catch { batchFailed = true; }
  check("ack attempts are bounded without finalizing or queuing duplicate", batchFailed && ackCalls === 3 && engineCalls === 1 && db.get(uncertainId)?.status === "pending" && db.get(uncertain.turnId)?.status === "running");
  offline = false;
  await retained.settle();
  await call("codex:finishTurn", { token, id: uncertain.turnId, response: "Retained engine result" });
  check("later acknowledgement delivers retained result without engine replay", engineCalls === 1 && Number(ackCalls) === 4 && db.get(uncertainId)?.status === "applied" && !db.get(uncertainId)?.queuedTurnId);
  evidence.uncertainAck = { engineCalls, ackCalls, receipt: db.get(uncertainId), original: db.get(uncertain.turnId) };

  // Native refusal followed by real retryOn on a fake second engine; receipt follows retryOf, not siblings.
  const retry = await fixture();
  await runtime.exclusive(() => db.patch(retry.runnerId, { engines: [
    { kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() },
    { kind: "claude", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() },
  ] }));
  await call("codex:claimTurn", { token, id: retry.turnId });
  const retryId = await call("tasks:steerFromDashboard", { key, id: retry.id, text: "Recover this update", requestId: "retry-update-001" });
  await call("codex:ackSteer", { token, id: retryId, applied: false, error: "Fake engine only queues" });
  const retryFirstId = db.get(retryId)!.queuedTurnId as string;
  await call("codex:finishTurn", { token, id: retry.turnId, response: "Prior progress" });
  await call("codex:claimTurn", { token, id: retryFirstId });
  await call("codex:finishTurn", { token, id: retryFirstId, error: "Synthetic usage limit reached", errorCode: "limit" });
  check("receipt remains queued while replacement is being chosen", turn(retryFirstId)?.retrying === true && (await call("tasks:steeringFromDashboard", { key, id: retry.id }))[0].state === "queued");
  check("retry ownership guards completion before replacement exists", await call("tasks:awaitingSteering", { id: retry.id, turnId: retry.turnId }));
  check("production retryOn creates replacement", await call("codex:retryOn", { id: retryFirstId, route: { engine: "claude", tier: "standard", by: "auto", why: "Synthetic alternate engine" } }));
  const replacements = await db.query("codexTurns").withIndex("by_run", (q) => q.eq("runId", turn(retryFirstId)!.runId)).collect();
  const replacement = replacements.find((row) => row.retryOf === retryFirstId)!;
  await refuses("superseded turn cannot finish pending replacement", "work:updateTask", { taskId: retry.id, turnId: retryFirstId, status: "done" });
  await call("codex:claimTurn", { token, id: replacement._id });
  check("receipt follows replacement while running", (await call("tasks:steeringFromDashboard", { key, id: retry.id }))[0].state === "running");
  check("replacement can finish its own update", !(await call("tasks:awaitingSteering", { id: retry.id, turnId: replacement._id })));
  await call("work:updateTask", { taskId: retry.id, turnId: replacement._id, status: "done", result: "Recovered update complete" });
  await call("codex:finishTurn", { token, id: replacement._id, response: "Recovered update complete" });
  check("terminal receipt follows successful replacement", (await call("tasks:steeringFromDashboard", { key, id: retry.id }))[0].state === "finished" && !(await call("tasks:awaitingSteering", { id: retry.id })));
  evidence.retry = { original: db.get(retryFirstId), replacement: db.get(replacement._id), receipts: await call("tasks:steeringFromDashboard", { key, id: retry.id }) };

  await refuses("bad dashboard key", "tasks:steerFromDashboard", { ...update, key: "wrong" });
  await refuses("empty instruction", "tasks:steerFromDashboard", { ...update, id: next.id, text: " ", requestId: "empty-update-001" });
  await refuses("oversize instruction", "tasks:steerFromDashboard", { ...update, id: next.id, text: "x".repeat(4001), requestId: "large-update-001" });
  await refuses("other owner chat cannot steer scoped task", "tasks:steer", { id: next.id, text: "Wrong scope", requestId: "scope-update-001", conversationId: f.origin });
  await refuses("task cannot steer sibling", "tasks:steer", { id: next.id, text: "Wrong scope", requestId: "scope-update-002", conversationId: next.conversationId });
  await refuses("completed task refuses new instruction", "tasks:steerFromDashboard", { ...update, requestId: "terminal-update-001" });
  await runtime.exclusive(() => db.patch(next.id, { status: "running" }));
  await refuses("between turns refuses without orphan receipt", "tasks:steerFromDashboard", { key, id: next.id, text: "Too late for this turn", requestId: "between-update-001" });
  check("rejected instruction leaves only original receipt", task(next.id)?.steering?.length === 1);
  await runtime.exclusive(() => db.patch(next.id, { status: "done" }));
  const guest = await runtime.exclusive(() => db.insert("conversations", { channel: "web", externalId: "guest", threadId: "guest", contactId: "synthetic-guest-contact" }));
  await refuses("guest source cannot steer owner task", "tasks:steer", { id: next.id, text: "Guest instruction", requestId: "guest-update-001", conversationId: guest });
  await runtime.exclusive(() => db.insert("installation", { paused: { at: Date.now(), source: "dashboard" } }));
  await refuses("paused Perry rejects new instruction", "tasks:steerFromDashboard", { key, id: next.id, text: "Run later", requestId: "paused-update-001" });
  // A queued fallback preserves its receipt through another agent plan update and process restart.
  const before = await call("tasks:steeringFromDashboard", { key, id: next.id });
  const restarted = new Runtime(sql, schema as never, { tasks, codex, runs, work, routing, recovery }, { storageDir: join(scratch, "storage") });
  await restarted.stop();
  check("receipt and acknowledgement survive runtime restart", JSON.stringify((await restarted.call("tasks:steeringFromDashboard", { key, id: next.id })).value) === JSON.stringify(before));
} catch (cause) {
  evidence.error = cause instanceof Error ? cause.stack : String(cause);
  process.exitCode = 1;
} finally {
  await runtime.stop();
  sql.close();
  const result = { checks, evidence, pass: Object.values(checks).every(Boolean) && !evidence.error };
  writeFileSync(join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass: result.pass, checks: Object.keys(checks).length, artifact: join(scratch, "result.json") }));
}
