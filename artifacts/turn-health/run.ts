/** #243: bounded fake-runner journey through production mutations and SQLite. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// All project imports are dynamic and occur only after isolation is configured.
const root = resolve(process.cwd()); // Run from the repository root, including when bundled.
const out = resolve(root, ".batch-work/batch-1/243");
process.env.PERRY_HOME = resolve(out, "test-home");
process.env.DASHBOARD_KEY = "turn-health-synthetic-key";
process.env.PERRY_FAKE_ENGINE = "1";
process.env.PERRY_ENGINE = "";
process.env.PERRY_CREDENTIAL_KEY = "24".repeat(32);
mkdirSync(process.env.PERRY_HOME, { recursive: true });
const checks: string[] = [];
const retryEvidence: Record<string, unknown> = {};
let failure: string | undefined;
const originalNow = Date.now;
let now = 1_800_000_000_000;
Date.now = () => now;
const sql = new DatabaseSync(":memory:");
let runtime: import("../../server/runtime").Runtime | undefined;
try {
  const [{ default: schema }, { Runtime }, runner, recovery, codex, dashboard, routing] = await Promise.all([
    import("../../convex/schema"), import("../../server/runtime"), import("../../convex/runner"),
    import("../../convex/recovery"), import("../../convex/codex"), import("../../convex/dashboard"), import("../../convex/routing"),
  ]);
  runtime = new Runtime(sql, schema as never, { runner, recovery, codex, dashboard, routing }, {
    storageDir: resolve(process.env.PERRY_HOME, "storage"),
  });
  // Stop scheduler before mutations: scheduled finalization is inspected, never
  // delivered to engines, channels, or models. There are no cron/watch timers.
  await runtime.stop();
  const store = runtime.store;
  const insert = (table: string, fields: Record<string, unknown>) => store.insert(table, fields);
  const get = (id: string) => store.get(id)!;
  const mutate = (name: string, args: Record<string, unknown>, internal = false) => runtime!.runMutation(name, args, { internal });
  const query = async (name: string, args: Record<string, unknown>) => (await runtime!.runQuery(name, args)).value as Record<string, any>;
  const pass = (name: string) => { checks.push(name); };
  const token = "fake-runner-243";
  const runnerId = insert("runners", { name: "Fake computer", token, revoked: false, autoApprove: false, lastSeenAt: now, turnHeartbeats: true, createdAt: now });
  const otherRunner = insert("runners", { name: "Other fake computer", token: "other-fake-243", revoked: false, autoApprove: false, lastSeenAt: now, turnHeartbeats: true, createdAt: now });
  function turn(extra: Record<string, unknown> = {}) {
    const conversationId = insert("conversations", { channel: "web", externalId: crypto.randomUUID(), threadId: crypto.randomUUID(), pendingTurns: 1, lastMessageAt: now, engine: "codex" });
    const runId = insert("runs", { conversationId, prompt: "Fake long task", status: "running", startedAt: now - 3_600_000 });
    const id = insert("codexTurns", { runnerId, conversationId, runId, engine: "codex", prompt: "Fake long task", instructions: "", createdAt: now - 3_600_000, startedAt: now - 3_600_000, lastHeartbeatAt: now, status: "running", partial: "Saved partial text", ...extra });
    return { id, conversationId, runId };
  }
  const beat = (ids?: string[], runnerToken = token) => mutate("runner:checkIn", { token: runnerToken, ...(ids === undefined ? {} : { activeTurnIds: ids }) });
  const sweep = (only?: string) => mutate("recovery:sweep", { now, ...(only ? { only } : {}) }, true);
  const chat = (id: string) => query("dashboard:getChat", { key: process.env.DASHBOARD_KEY, id });

  const quiet = turn();
  await beat([quiet.id]);
  await sweep(quiet.conversationId);
  assert.equal(get(quiet.id).status, "running");
  assert.equal((await chat(quiet.conversationId)).unresponsive, false);
  pass("quiet hour-old execution remains healthy on explicit heartbeat");

  now += 89_999;
  await sweep(quiet.conversationId);
  assert.equal(get(quiet.id).unresponsiveAt, undefined);
  now += 1;
  await sweep(quiet.conversationId);
  assert.equal(get(quiet.id).status, "running");
  assert.equal(get(quiet.id).unresponsiveAt, now);
  assert.equal((await chat(quiet.conversationId)).unresponsive, true);
  const activity = await query("dashboard:getActivity", { key: process.env.DASHBOARD_KEY, id: quiet.conversationId });
  assert.equal(activity.step.label, "Computer unresponsive");
  pass("90-second gap warns through dashboard and activity while retaining running status");

  await beat([quiet.id]);
  assert.equal(get(quiet.id).unresponsiveAt, undefined);
  assert.equal((await chat(quiet.conversationId)).unresponsive, false);
  assert.equal(get(quiet.id).partial, "Saved partial text");
  pass("genuine ownership beat immediately clears warning without losing partial text");

  const aliveAt = now;
  now = aliveAt + 900_000 - 1;
  await sweep(quiet.conversationId);
  assert.equal(get(quiet.id).status, "running");
  now += 1;
  await sweep(quiet.conversationId);
  assert.equal(get(quiet.id).status, "error");
  assert.equal(get(quiet.id).response, "Saved partial text");
  assert.equal(get(quiet.id).partial, undefined);
  const finishedAt = get(quiet.id).finishedAt;
  const scheduled = () => Number((sql.prepare("SELECT count(*) AS n FROM _scheduled").get() as { n: number }).n);
  const before = scheduled();
  await sweep(quiet.conversationId);
  assert.equal(scheduled(), before);
  await beat([quiet.id]);
  await mutate("codex:streamTurn", { token, id: quiet.id, text: "Late text" });
  await mutate("codex:finishTurn", { token, id: quiet.id, response: "Late result" });
  assert.equal(get(quiet.id).status, "error");
  assert.equal(get(quiet.id).finishedAt, finishedAt);
  assert.equal(get(quiet.id).response, "Saved partial text");
  pass("15-minute grace uses last beat; repeated sweep and late beat/stream/result preserve terminal error");

  const done = turn({ status: "done", response: "Completed", finishedAt: now, finalizedAt: now });
  const beforeDone = JSON.stringify(get(done.id));
  now += 30_000;
  await beat([done.id]);
  await mutate("codex:streamTurn", { token, id: done.id, text: "Late text" });
  await mutate("codex:finishTurn", { token, id: done.id, response: "Late completion" });
  assert.equal(JSON.stringify(get(done.id)), beforeDone);
  pass("late heartbeat/stream/completion never reopen finalized done turn");

  const missing = turn();
  const missingAt = now;
  now += 90_000;
  await beat([]);
  await sweep(missing.conversationId);
  assert.equal((await chat(missing.conversationId)).unresponsive, true);
  now = missingAt + 900_000;
  await beat([]);
  await sweep(missing.conversationId);
  assert.equal(get(missing.id).status, "error");
  pass("healthy machine with explicit empty active list cannot prolong an orphaned turn");

  const foreign = turn({ runnerId: otherRunner });
  const foreignBeat = get(foreign.id).lastHeartbeatAt;
  now += 30_000;
  await beat([foreign.id]);
  assert.equal(get(foreign.id).lastHeartbeatAt, foreignBeat);
  await assert.rejects(beat([foreign.id], "invalid-fake-token"));
  pass("ownership and authentication reject foreign/invalid heartbeat attempts");

  const legacy = turn({ lastHeartbeatAt: undefined });
  now += 120_000;
  await beat();
  await sweep(legacy.conversationId);
  assert.equal(get(legacy.id).status, "running");
  assert.equal((await chat(legacy.conversationId)).unresponsive, false);
  const legacyAlive = now;
  now += 30_000;
  await beat([]);
  assert.equal(get(legacy.id).lastHeartbeatAt, legacyAlive);
  now = legacyAlive + 90_000;
  await beat([]);
  await sweep(legacy.conversationId);
  assert.equal((await chat(legacy.conversationId)).unresponsive, true);
  await beat([legacy.id]);
  assert.equal((await chat(legacy.conversationId)).unresponsive, false);
  pass("legacy omission stays compatible; modern empty list freezes prior liveness and later genuine beat restores it");

  const queued = turn({ status: "queued", startedAt: undefined, lastHeartbeatAt: undefined });
  await beat([]);
  const queuedAlive = now;
  await sweep(queued.conversationId);
  assert.equal(get(queued.id).status, "queued");
  now = queuedAlive + 600_000 - 1;
  await sweep(queued.conversationId);
  assert.equal(get(queued.id).status, "queued");
  now += 1;
  await sweep(queued.conversationId);
  assert.equal(get(queued.id).status, "error");
  pass("old queued turn receives ten-minute offline grace from last machine liveness");

  const hidden = turn();
  for (let i = 0; i < 320; i++) {
    now += 1;
    insert("codexTurns", { runnerId, conversationId: hidden.conversationId, runId: hidden.runId, engine: "codex", prompt: "Completed fixture", instructions: "", status: "done", createdAt: now, finishedAt: now, finalizedAt: now });
  }
  now += 90_000;
  await sweep();
  assert.equal(get(hidden.id).unresponsiveAt, now);
  assert.equal(get(hidden.id).status, "running");
  pass("global sweep finds active turn behind more than 300 newer terminal records");

  store.patch(runnerId, { revoked: true });
  await assert.rejects(beat([hidden.id]));
  assert.equal((await chat(hidden.conversationId)).unresponsive, true);
  pass("revoked machine cannot restore liveness");

  // Retry ownership: production refusal/claim/finalization mutations and real
  // transactional orderings. No routing model or channel delivery is invoked.
  store.patch(runnerId, { revoked: false, lastSeenAt: now, engines: [
    { kind: "claude", installed: true, signedIn: true, auth: {}, models: [], updatedAt: now },
  ] });
  const route = { engine: "claude", tier: "standard", by: "auto", why: "Synthetic alternate engine" };
  const begin = (id: string) => mutate("codex:beginFinalize", { id }, true);
  const mark = (id: string) => mutate("codex:markFinalized", { id }, true);
  const retry = (id: string) => mutate("codex:retryOn", { id, route }, true);
  const attempts = (runId: string) => store.query("codexTurns").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
  const renewRunner = () => store.patch(runnerId, { lastSeenAt: now });
  async function refuse() {
    const fixture = turn({ partial: undefined });
    await mutate("codex:finishTurn", { token, id: fixture.id, error: "Synthetic plan limit", errorCode: "limit" });
    assert.equal(get(fixture.id).retrying, true);
    return fixture;
  }
  const GRACE = codex.FINALIZE_LEASE_MS;
  const pending = await refuse();
  const refusedAt = now;
  now += 60_001;
  const pendingSweep = await sweep(pending.conversationId) as { refinalized: number };
  assert.equal(pendingSweep.refinalized, 0);
  assert.equal(get(pending.id).retrying, true);
  assert.equal(await begin(pending.id), false);
  await mark(pending.id);
  assert.equal(get(pending.id).finalizedAt, undefined);
  assert.equal(get(pending.runId).status, "running");
  assert.equal(get(pending.conversationId).pendingTurns, 1);
  pass("pending retry rejects recovery finalization, direct begin and direct mark after sixty seconds");

  now = refusedAt + GRACE - 1;
  await sweep(pending.conversationId);
  assert.equal(get(pending.id).retrying, true);
  now += 1;
  assert.equal(get(pending.id).retrying, true);
  assert.equal(await retry(pending.id), false); // Deadline wins even before recovery executes.
  const expiredSweep = await sweep(pending.conversationId) as { refinalized: number };
  assert.equal(get(pending.id).retrying, undefined);
  assert.equal(expiredSweep.refinalized, 1);
  assert.equal(await retry(pending.id), false);
  assert.equal(await begin(pending.id), true);
  assert.equal(await begin(pending.id), false);
  await mark(pending.id);
  assert.equal(get(pending.runId).status, "error");
  assert.equal(get(pending.conversationId).pendingTurns, 0);
  assert.equal(await retry(pending.id), false);
  retryEvidence.expiry = { refusedAt, graceMs: GRACE, claimedAt: now, turn: get(pending.id), run: get(pending.runId) };
  pass("exact ten-minute retry deadline revokes execution before finalization; competing claims and late retry lose");

  renewRunner();
  const retryFirst = await refuse();
  const retryFirstOrder = await Promise.all([retry(retryFirst.id), begin(retryFirst.id)]);
  assert.deepEqual(retryFirstOrder, [true, false]);
  const replacement = (await attempts(retryFirst.runId)).find((item) => item._id !== retryFirst.id)!;
  assert(replacement);
  assert.equal((await attempts(retryFirst.runId)).length, 2);
  assert.equal(get(retryFirst.runId).status, "running");
  assert.equal(get(retryFirst.conversationId).pendingTurns, 1);
  await mutate("codex:claimTurn", { token, id: replacement._id });
  await mutate("codex:traceTurn", { token, id: replacement._id, spans: [
    { callId: "retry-open", kind: "command", name: "Synthetic replacement step", status: "running", startedAt: now },
  ] });
  await mark(retryFirst.id);
  await sweep(retryFirst.conversationId);
  assert.equal(get(retryFirst.runId).status, "running");
  const liveSpan = await store.query("runSpans").withIndex("by_run", (q) => q.eq("runId", retryFirst.runId)).first();
  assert.equal(liveSpan?.status, "running");
  assert.equal(await retry(retryFirst.id), false);
  retryEvidence.retryWins = { ordering: retryFirstOrder, original: get(retryFirst.id), replacement: get(replacement._id), span: liveSpan };
  pass("retry-first transaction prevents stale finalizer and leaves replacement run and traces active");

  renewRunner();
  const finalizeFirst = await refuse();
  await mutate("routing:giveUpRetry", { id: finalizeFirst.id }, true);
  const finalizeFirstOrder = await Promise.all([begin(finalizeFirst.id), retry(finalizeFirst.id)]);
  assert.deepEqual(finalizeFirstOrder, [true, false]);
  assert.equal((await attempts(finalizeFirst.runId)).length, 1);
  await mutate("codex:markStep", { id: finalizeFirst.id, step: "deliveredAt" }, true);
  await mark(finalizeFirst.id);
  assert.equal(await retry(finalizeFirst.id), false);
  assert.equal(get(finalizeFirst.conversationId).pendingTurns, 0);
  retryEvidence.finalizeWins = { ordering: finalizeFirstOrder, turn: get(finalizeFirst.id), run: get(finalizeFirst.runId) };
  pass("finalize-first transaction after explicit give-up blocks stale retry before and after delivery");

  for (const marker of ["finalizingAt", "reportedAt", "savedAt", "deliveredAt"] as const) {
    const legacy = turn({ status: "error", error: "Synthetic old refusal", errorCode: "limit", retrying: true, finishedAt: now - 120_000, [marker]: now - GRACE - 1 });
    const beforeChat = JSON.stringify(get(legacy.conversationId));
    assert.equal(await retry(legacy.id), false);
    assert.equal((await attempts(legacy.runId)).length, 1);
    assert.equal(JSON.stringify(get(legacy.conversationId)), beforeChat);
    await sweep(legacy.conversationId);
    assert.equal(get(legacy.id).retrying, undefined);
    assert.equal(await begin(legacy.id), true);
    await mark(legacy.id);
    assert.equal(get(legacy.runId).status, "error");
    pass(`legacy ${marker} evidence permanently blocks execution and permits delivery recovery`);
  }

  const endedParent = turn({ status: "error", error: "Synthetic refusal", retrying: true, finishedAt: now });
  store.patch(endedParent.runId, { status: "error", finishedAt: now });
  assert.equal(await retry(endedParent.id), false);
  assert.equal((await attempts(endedParent.runId)).length, 1);
  pass("ended parent run cannot acquire replacement execution");

  const executing = turn();
  const queuedOnly = turn({ status: "queued", startedAt: undefined });
  assert.equal(await begin(executing.id), false);
  assert.equal(await begin(queuedOnly.id), false);
  pass("nonterminal turns cannot acquire finalization ownership");

  renewRunner();
  const abandonedRetry = await refuse();
  const abandonedAt = now;
  const targeted = (sql.prepare("SELECT name, args, runAt FROM _scheduled WHERE name = 'recovery:sweep'").all() as Array<{ name: string; args: string; runAt: number }>)
    .find((row) => JSON.parse(row.args).only === abandonedRetry.conversationId);
  assert(targeted, "retry refusal must register durable targeted recovery");
  assert.equal(targeted.runAt, abandonedAt + GRACE);
  for (let i = 0; i < 320; i++) {
    now += 1;
    insert("codexTurns", { runnerId, conversationId: abandonedRetry.conversationId, runId: abandonedRetry.runId, prompt: "Unrelated completed history", instructions: "", status: "done", createdAt: now, finishedAt: now, finalizedAt: now });
  }
  assert(!(await store.query("codexTurns").order("desc").take(300)).some((item) => item._id === abandonedRetry.id));
  now = abandonedAt + GRACE;
  // Invoke the exact persisted callback through Runtime, with no scheduler or
  // routing action running. This tests the durable fallback's real arguments.
  await mutate(targeted.name, JSON.parse(targeted.args), true);
  assert.equal(get(abandonedRetry.id).retrying, undefined);
  assert.equal(await retry(abandonedRetry.id), false);
  assert.equal(await begin(abandonedRetry.id), true);
  await mark(abandonedRetry.id);
  assert.equal(get(abandonedRetry.runId).status, "error");
  retryEvidence.targetedRecovery = { callback: targeted, expiredAt: now, turn: get(abandonedRetry.id) };
  pass("durable targeted callback recovers an abandoned retry hidden behind more than 300 completed turns");

} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  await runtime?.stop();
  sql.close();
  Date.now = originalNow;
  writeFileSync(resolve(out, "result.json"), JSON.stringify({ issue: 243, ok: failure === undefined, mode: "in-process real SQLite/runtime; fake clock and runner; no models", proposedCodexSha256: process.env.PERRY_RETRY_OVERLAY_SHA256, checks, retryEvidence, failure }, null, 2) + "\n");
}
if (failure) throw new Error(failure);
console.log(`PASS ${checks.length} turn-health journeys; evidence: ${resolve(out, "result.json")}`);
