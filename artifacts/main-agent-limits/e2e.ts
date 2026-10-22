// @ts-nocheck -- The production Runtime exposes dynamic documents to this protocol harness.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/main-agent-limits/e2e.ts <output-directory>
// Failure cases written before implementation:
// 1. A second limit ends the run although a third signed-in engine is eligible, or a chain loops.
// 2. A main web agent loses its completed work/text, repeats the original request without a handoff,
//    resumes a stale session, duplicates final messages, or leaks a saved secret into the handoff.
// 3. An outside read becomes fresh owner authorization on another engine.
// 4. Stop, pending approval/unfinished/failed action, applied steer, guest, media, maintenance,
//    legacy trace gaps or oversized evidence incorrectly permit replay of work with uncertain effects.
// 5. Pausing, repeated routing delivery, exhausted alternatives or a failed history read create extra turns.
// No engines or external services are contacted. Real SQLite Runtime, routing actions, claim/trace/finish
// and finalization functions run against disposable synthetic data; a runner is driven by this harness.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const out = resolve(process.argv[2] ?? "W:/perry-qa/main-agent-limits-20261022");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(out, "fixture-"));
process.env.PERRY_HOME = home;
process.env.PERRY_CREDENTIAL_KEY = "11".repeat(32);
process.env.DASHBOARD_KEY = "synthetic-dashboard";
const result = { passed: false, cases: [], error: undefined };
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("External traffic forbidden in this harness"); };
let runtime, db;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const { Runtime } = await import("../../server/runtime");
  const { default: schema } = await import("../../convex/schema");
  const modules = {};
  for (const name of ["codex", "routing", "dashboard", "agentStore", "conversations", "secrets", "runs", "usage", "runner", "pause", "recovery"]) {
    modules[name] = await import(`../../convex/${name}.ts`);
  }
  const { internalMutation } = await import("../../convex/_generated/server.js");
  modules.brain = { checkpointIfFull: internalMutation({ args: {}, handler: async () => null }) };
  db = new DatabaseSync(":memory:");
  runtime = new Runtime(db, schema, modules, { storageDir: join(home, "storage") });
  await runtime.stop(); // Drive durable callbacks explicitly, as a restart would.
  const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
  const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
  const get = id => runtime.exclusive(() => runtime.store.get(id));
  const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
  const rows = table => db.prepare(`SELECT _id, doc FROM "doc_${table}"`).all().map(row => ({ _id: row._id, ...JSON.parse(row.doc) }));
  const engines = ["codex", "claude", "grok", "antigravity"];
  const token = "synthetic-runner";
  const install = await insert("installation", { defaultEngine: "codex", timezone: "Asia/Calcutta" });
  const runnerId = await call("runner:createToken", { name: "Synthetic computer", token });
  await call("runner:checkIn", { token, hostname: "synthetic", platform: "win32", activeTurnIds: [] });
  // Use the production status shape without launching any engine.
  await patch(runnerId, { engines: engines.map(kind => ({ kind, installed: true, signedIn: true, guestLockdown: kind === "codex" || kind === "claude", version: "999.0.0", auth: {}, models: [{ id: `${kind}-fake`, name: `${kind}-fake`, isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }], updatedAt: Date.now() })) });
  const { encryptCredential } = await import("../../convex/lib/credential-encryption");
  const secret = "synthetic-secret-for-redaction";
  await insert("vault", { label: "Synthetic", value: encryptCredential("vault", secret), by: "owner", updatedAt: Date.now() });
  const resetUsage = () => patch(runnerId, { usage: {}, lastSeenAt: Date.now() });
  const make = async (extra = {}, chatExtra = {}) => {
    await resetUsage();
    const threadId = await call("agentStore:createThread", { userId: "web:dashboard" });
    const chat = await insert("conversations", { threadId, channel: "web", externalId: "synthetic", engine: "codex", codexRunnerId: runnerId, pendingTurns: 1, lastMessageAt: Date.now(), ...chatExtra });
    const prompt = "Finish the synthetic report";
    const run = await call("runs:start", { conversationId: chat, prompt });
    const turn = await call("codex:enqueueTurn", { conversationId: chat, runId: run, engine: "codex", prompt, instructions: "Synthetic owner instructions", recalled: "Synthetic memory", access: "supervised", ...extra });
    assert.ok(await call("codex:claimTurn", { token, id: turn }));
    return { chat, run, turn, prompt };
  };
  const finishLimit = (id, response) => call("codex:finishTurn", { token, id, error: "You've hit your usage limit", errorCode: "limit", ...(response ? { response } : {}) });
  const trace = (s, status = "ok", kind = "command", callId = "synthetic-step") => call("codex:traceTurn", { token, id: s.turn, spans: [{ callId, kind, name: "Inspect synthetic file", status, startedAt: Date.now() - 10, ...(status !== "running" ? { endedAt: Date.now() } : {}), input: "read local report", output: `Completed synthetic result ${secret}` }] });
  const turns = run => rows("codexTurns").filter(t => t.runId === run);
  const routeRetry = async s => {
    await call("routing:retryTurn", { id: s.turn });
    return turns(s.run).find(t => t.retryOf === s.turn);
  };
  const check = async (name, run) => {
    try { await run(); result.cases.push({ name, passed: true }); }
    catch (e) { result.cases.push({ name, passed: false, error: e.message }); }
  };
  await check("empty refusal carries outside guard", async () => {
    const s = await make({ outside: true });
    await finishLimit(s.turn);
    const next = await routeRetry(s);
    assert.ok(next);
    assert.equal(await call("codex:outwardAllowed", { turnId: next._id }), false);
  });
  await check("chain tries every engine once and terminates", async () => {
    const s = await make();
    let current = s.turn;
    for (let n = 0; n < engines.length; n++) {
      await finishLimit(current);
      await call("routing:retryTurn", { id: current });
      await call("routing:retryTurn", { id: current }); // at-most-once creation
      const next = turns(s.run).find(t => t.retryOf === current);
      if (n === engines.length - 1) { assert.equal(next, undefined); break; }
      assert.ok(next, `alternative ${n + 1} should exist`);
      assert.ok(await call("codex:claimTurn", { token, id: next._id }));
      current = next._id;
    }
    assert.equal(turns(s.run).length, engines.length);
    assert.equal(new Set(turns(s.run).map(t => t.engine)).size, engines.length);
  });
  await check("main web progress hands off and finalizes once", async () => {
    const s = await make({ outside: true });
    await trace(s);
    await call("codex:setResume", { token, id: s.turn, cursor: "old-session" });
    await finishLimit(s.turn, "I inspected the report and saved the findings.");
    const first = await routeRetry(s);
    assert.ok(first);
    assert.equal(first.prompt, s.prompt);
    assert.ok(first.history.includes("I inspected the report"));
    assert.ok(first.history.includes("Completed synthetic result"));
    assert.ok(!first.history.includes(secret));
    assert.ok(first.instructions.includes("Do not repeat completed actions"));
    assert.equal(first.recalled, "Synthetic memory");
    const claimed = await call("codex:claimTurn", { token, id: first._id });
    assert.equal(claimed.resumeCursor, undefined);
    assert.equal(claimed.access, "supervised");
    assert.equal(await call("codex:outwardAllowed", { turnId: first._id }), false);
    await finishLimit(first._id, "The follow-up finding is also ready.");
    const second = await routeRetry({ ...s, turn: first._id });
    assert.ok(second.history.includes("I inspected the report"));
    assert.ok(second.history.includes("follow-up finding"));
    assert.ok(await call("codex:claimTurn", { token, id: second._id }));
    await call("codex:finishTurn", { token, id: second._id, response: "Finished synthetic report.", model: `${second.engine}/fake` });
    await call("codex:finalizeTurn", { id: second._id });
    await call("codex:finalizeTurn", { id: second._id });
    const messages = await call("agentStore:listMessages", { threadId: (await get(s.chat)).threadId, paginationOpts: { numItems: 50, cursor: null } });
    assert.equal(messages.page.length, 2);
    assert.equal((await get(s.chat)).pendingTurns, 0);
    assert.equal((await get(s.run)).status, "ok");
    assert.equal((await get(s.run)).route.retried, true);
  });
  await check("partial stream without final response is retained", async () => {
    const s = await make();
    await call("codex:streamTurn", { token, id: s.turn, text: "Visible progress before the limit" });
    await finishLimit(s.turn);
    const next = await routeRetry(s);
    assert.ok(next.history.includes("Visible progress before the limit"));
  });
  for (const scenario of ["running-tool", "failed-tool", "legacy-trace", "too-many-steps", "pending-approval", "stopped", "stop-requested", "guest-progress", "phone-progress", "media", "maintenance", "applied-steer", "non-limit"]) {
    await check(`blocks unsafe handoff: ${scenario}`, async () => {
      const s = await make(scenario === "maintenance" ? { checkpoint: true } : {}, scenario === "guest-progress" ? { contactId: "contacts:synthetic" } : scenario === "phone-progress" ? { channel: "telegram" } : {});
      if (scenario === "running-tool" || scenario === "failed-tool") await trace(s, scenario === "running-tool" ? "running" : "error");
      if (scenario === "too-many-steps") for (let n = 0; n < 33; n++) await trace(s, "ok", "command", `step-${n}`);
      if (scenario === "legacy-trace") await patch(s.run, { toolCalls: ["missing legacy evidence"] });
      if (scenario === "stop-requested") await patch(s.turn, { stopRequested: true });
      if (scenario === "media") await patch(s.turn, { mediaKey: "synthetic-media" });
      if (scenario === "pending-approval") await insert("approvals", { runnerId, conversationId: s.chat, kind: "command", title: "Synthetic pending action", status: "pending", createdAt: Date.now() });
      if (scenario === "applied-steer") await insert("codexSteers", { turnId: s.turn, runnerId, conversationId: s.chat, runId: s.run, prompt: "Changed request", instructions: "", status: "applied", appliedAt: Date.now(), createdAt: Date.now() });
      await call("codex:finishTurn", { token, id: s.turn, error: "Synthetic failure", errorCode: scenario === "non-limit" ? "engine_failed" : "limit", response: "Progress", ...(scenario === "stopped" ? { stopped: true } : {}) });
      assert.ok(!(await get(s.turn)).retrying, scenario);
      assert.equal(turns(s.run).length, 1);
    });
  }
  await check("pause between finish and routing prevents continuation", async () => {
    const s = await make();
    await finishLimit(s.turn);
    await patch(install, { paused: { at: Date.now(), by: "web" } });
    await call("routing:retryTurn", { id: s.turn });
    assert.equal(turns(s.run).length, 1);
    await patch(install, { paused: undefined });
  });
  await check("failed history read preserves original failure", async () => {
    const s = await make();
    await finishLimit(s.turn, "Some real progress");
    const query = runtime.runQuery.bind(runtime);
    runtime.runQuery = async (name, ...args) => {
      if (name === "agentStore:listMessages") throw new Error("Synthetic unavailable history");
      return query(name, ...args);
    };
    try {
      assert.equal(await routeRetry(s), undefined);
      assert.equal((await get(s.turn)).retrying, undefined);
      assert.equal((await get(s.turn)).response, "Some real progress");
    } finally { runtime.runQuery = query; }
  });
  await check("stop between finish and routing cancels handoff", async () => {
    const s = await make();
    await finishLimit(s.turn, "Already inspected the report");
    assert.equal(await call("codex:requestStop", { conversationId: s.chat }), 1);
    await call("routing:retryTurn", { id: s.turn });
    assert.equal(turns(s.run).length, 1);
    assert.equal((await get(s.turn)).stopped, true);
  });
  await check("runner unavailable at commit leaves chat engine unchanged", async () => {
    const s = await make();
    await finishLimit(s.turn);
    const plan = await call("routing:retryPlan", { id: s.turn });
    assert.ok(plan);
    const runner = await get(runnerId);
    await patch(runnerId, { engines: runner.engines.map(e => e.kind === plan.choice.engine ? { ...e, signedIn: false } : e) });
    assert.equal(await call("codex:retryOn", { id: s.turn, route: modules.routing.routeOf(plan.choice) }), false);
    assert.equal((await get(s.chat)).engine, "codex");
    await patch(runnerId, { engines: runner.engines });
  });
  await check("later failure keeps earlier visible progress", async () => {
    const s = await make();
    await finishLimit(s.turn, "Earlier completed findings");
    const next = await routeRetry(s);
    await call("codex:claimTurn", { token, id: next._id });
    await call("codex:finishTurn", { token, id: next._id, error: "Transport failed", errorCode: "engine_failed" });
    assert.ok((await get(next._id)).response.includes("Earlier completed findings"));
  });
  await check("tool ids cannot collide across engine attempts", async () => {
    const s = await make();
    await trace(s, "ok", "command", "reused-provider-id");
    await finishLimit(s.turn, "Completed first step");
    const next = await routeRetry(s);
    await call("codex:claimTurn", { token, id: next._id });
    await trace({ ...s, turn: next._id }, "running", "command", "reused-provider-id");
    await finishLimit(next._id, "Second step started");
    assert.ok(!(await get(next._id)).retrying, "unfinished second action must prevent another handoff");
    assert.equal(rows("runSpans").filter(span => span.runId === s.run).length, 2);
  });
  await check("all exhausted alternatives keep original progress for delivery", async () => {
    const s = await make();
    await finishLimit(s.turn, "Completed findings before exhaustion");
    const next = await routeRetry(s);
    await call("codex:claimTurn", { token, id: next._id });
    await patch(runnerId, { usage: Object.fromEntries(engines.map(engine => [engine, { hit: { at: Date.now(), message: "usage limit reached" } }])) });
    await finishLimit(next._id);
    await call("routing:retryTurn", { id: next._id });
    const delivered = await call("codex:getTurn", { id: next._id });
    assert.ok(delivered.job.response.includes("Completed findings before exhaustion"));
  });
  await check("pause cancels the routing gap even after resume", async () => {
    const s = await make();
    await finishLimit(s.turn, "Completed work before pause");
    await call("pause:pauseFrom", { by: "web" });
    await patch(install, { paused: undefined });
    await call("routing:retryTurn", { id: s.turn });
    assert.equal(turns(s.run).length, 1);
    assert.equal((await get(s.turn)).stopped, true);
  });
  result.passed = result.cases.every(c => c.passed);
  if (!result.passed) process.exitCode = 1;
} catch (e) { result.error = e.stack; process.exitCode = 1; }
finally {
  await runtime?.stop(); db?.close(); globalThis.fetch = fetchBefore;
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
