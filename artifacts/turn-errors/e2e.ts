// @ts-nocheck -- Integration harness deliberately consumes dynamic Runtime documents.
// Coordinator: pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/turn-errors/e2e.ts.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Set isolation BEFORE any project import. No server/index, live runner or build.
const scratch = resolve(".batch-work/batch-1/244/test-home");
process.env.PERRY_HOME = scratch;
process.env.PERRY_DB = join(scratch, "turn-errors.sqlite");
process.env.DASHBOARD_KEY = "turn-errors-synthetic-dashboard-key";
process.env.PERRY_CREDENTIAL_KEY = "11".repeat(32);
process.env.TELEGRAM_BOT_TOKEN = "turn-errors-synthetic-bot";
process.env.TELEGRAM_API_BASE = "http://turn-errors.invalid";
mkdirSync(scratch, { recursive: true });
const evidence = { passed: false, cases: [] as object[], telegram: [] as object[], error: undefined as string | undefined };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  assert.ok(String(input).startsWith("http://turn-errors.invalid/"), "unexpected external request");
  const body = JSON.parse(String(init?.body ?? "{}"));
  evidence.telegram.push({ method: String(input).split("/").at(-1), text: body.text });
  return Response.json({ ok: true, result: { message_id: evidence.telegram.length } });
};
let runtime;
let sql;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const { Runtime } = await import("../../server/runtime");
  const { default: schema } = await import("../../convex/schema");
  const codex = await import("../../convex/codex");
  const dashboard = await import("../../convex/dashboard");
  const agentStore = await import("../../convex/agentStore");
  const conversations = await import("../../convex/conversations");
  const secrets = await import("../../convex/secrets");
  const runs = await import("../../convex/runs");
  const { internalMutation } = await import("../../convex/_generated/server.js");
  const { TURN_ERROR_CODES, turnErrorCopy } = await import("../../lib/turn-errors");
  const { encryptCredential } = await import("../../convex/lib/credential-encryption");
  sql = new DatabaseSync(":memory:");
  runtime = new Runtime(sql, schema, {
    codex, dashboard, agentStore, conversations, secrets, runs,
    brain: { checkpointIfFull: internalMutation({ args: {}, handler: async () => null }) },
    routing: { retryTurn: internalMutation({ args: {}, handler: async () => null }) },
  }, { storageDir: join(scratch, "storage") });
  // Disable scheduler before the first mutation; drive finalization explicitly.
  await runtime.stop();
  const call = async (name, args) => (await runtime.call(name, args, { internal: true })).value;
  const insert = (table, value) => runtime.exclusive(() => runtime.store.insert(table, value));
  const get = (id) => runtime.exclusive(() => runtime.store.get(id));
  const patch = (id, value) => runtime.exclusive(() => runtime.store.patch(id, value));
  const secret = "synthetic-secret-that-must-be-hidden";
  await insert("vault", { label: "Synthetic only", value: encryptCredential("vault", secret), by: "owner", updatedAt: Date.now() });
  const token = "synthetic-runner";
  const runnerId = await insert("runners", { token, name: "Fake computer", lastSeenAt: Date.now(), codexAvailable: true, codexAuthMode: "chatgpt" });
  const threadId = await call("agentStore:createThread", { userId: "web:dashboard" });
  const conversationId = await insert("conversations", { channel: "web", externalId: "test", threadId, engine: "codex", codexRunnerId: runnerId, lastMessageAt: Date.now(), pendingTurns: 0 });
  const fakeEngine = {
    async runTurn(code) { return { errorCode: code, error: `Detail mentions offline runner, too old for Perry and limit; ignore those words. ${secret}`, response: "A partial answer" }; },
  };
  for (const code of TURN_ERROR_CODES) {
    const prompt = "Repeated prompt";
    const runId = await call("runs:start", { conversationId, prompt });
    const id = await insert("codexTurns", { runnerId, conversationId, runId, engine: "codex", prompt, instructions: "", status: "running", createdAt: Date.now(), startedAt: Date.now(), partial: "A streamed partial" });
    const outcome = await fakeEngine.runTurn(code);
    await call("codex:finishTurn", { token, id, ...outcome });
    await call("codex:finalizeTurn", { id });
    const turn = await get(id);
    const run = await get(runId);
    assert.equal(turn.errorCode, code);
    assert.equal(run.errorCode, code);
    assert.ok(!turn.error.includes(secret), "persisted turn error must be redacted");
    assert.ok(!run.error.includes(secret), "persisted run error must be redacted");
    assert.equal(turn.response, "A partial answer");
    const page = await call("dashboard:getChatMessages", { key: process.env.DASHBOARD_KEY, id: conversationId, paginationOpts: { cursor: null, numItems: 100 } });
    const ownMessages = page.page.filter((message) => message.runId === runId);
    assert.equal(ownMessages.length, 2, "both saved messages retain run identity");
    assert.ok(ownMessages.every((message) => message.failure.errorCode === code));
    await call("codex:finalizeTurn", { id });
    const again = await call("dashboard:getChatMessages", { key: process.env.DASHBOARD_KEY, id: conversationId, paginationOpts: { cursor: null, numItems: 100 } });
    assert.equal(again.page.filter((message) => message.runId === runId).length, 2);
    evidence.cases.push({ code, turn: turn.status, run: run.status, linkedMessages: ownMessages.length, title: turnErrorCopy(code).title });
  }
  // Real Telegram delivery uses the same persisted code, through a fake Bot API.
  const telegramThread = await call("agentStore:createThread", { userId: "telegram:test" });
  const telegramChat = await insert("conversations", { channel: "telegram", externalId: "test", threadId: telegramThread, engine: "codex", lastMessageAt: Date.now() });
  for (const code of TURN_ERROR_CODES) {
    const runId = await call("runs:start", { conversationId: telegramChat, prompt: "Telegram failure" });
    const id = await insert("codexTurns", { runnerId, conversationId: telegramChat, runId, engine: "codex", prompt: "Telegram failure", instructions: "", status: "running", createdAt: Date.now() });
    await call("codex:finishTurn", { token, id, ...await fakeEngine.runTurn(code) });
    const before = evidence.telegram.length;
    await call("codex:finalizeTurn", { id });
    assert.ok(evidence.telegram.slice(before).some((entry) => String(entry.text).includes(turnErrorCopy(code).title.replaceAll("'", "&#39;")) || String(entry.text).includes(turnErrorCopy(code).title)));
    assert.ok(evidence.telegram.slice(before).every((entry) => !String(entry.text).includes(secret)));
    evidence.cases.push({ code, telegram: true });
  }
  // Genuine empty completion, stopped completion, old runner payload, and legacy query.
  for (const scenario of ["empty", "stopped", "legacy-runner", "code-only"]) {
    const runId = await call("runs:start", { conversationId, prompt: scenario });
    const id = await insert("codexTurns", { runnerId, conversationId, runId, engine: "codex", prompt: scenario, instructions: "", status: "running", createdAt: Date.now() });
    const result = scenario === "stopped" ? { stopped: true } : scenario === "legacy-runner" ? { error: "offline runner too old for Perry" } : scenario === "code-only" ? { errorCode: "max_time" } : { response: "" };
    await call("codex:finishTurn", { token, id, ...result });
    await call("codex:finalizeTurn", { id });
    const turn = await get(id);
    assert.equal(turn.errorCode, scenario === "empty" ? "empty_reply" : scenario === "stopped" ? undefined : scenario === "code-only" ? "max_time" : "engine_failed");
    evidence.cases.push({ scenario, code: turn.errorCode ?? null });
  }
  const older = await call("dashboard:getChatMessages", { key: process.env.DASHBOARD_KEY, id: conversationId, paginationOpts: { cursor: null, numItems: 100 } });
  assert.ok(older.page.filter((message) => message.text === "Repeated prompt" && message.failure).length === TURN_ERROR_CODES.length, "repeated prompts retain distinct historical failures after newer runs");
  const legacy = await insert("runs", { conversationId, prompt: "Legacy", status: "error", error: "offline runner", startedAt: Date.now(), finishedAt: Date.now() });
  const latest = await call("dashboard:getChat", { key: process.env.DASHBOARD_KEY, id: conversationId });
  assert.equal(latest.lastErrorCode, "engine_failed");
  assert.equal(latest.lastErrorRunId, legacy);
  // Offline admission's structured error survives the actual runtime boundary.
  await patch(runnerId, { lastSeenAt: 0 });
  const admissionRun = await call("runs:start", { conversationId, prompt: "offline" });
  await assert.rejects(() => call("codex:enqueueTurn", { conversationId, runId: admissionRun, prompt: "offline", instructions: "", engine: "codex" }), (error) => error.data?.errorCode === "offline");
  await patch(runnerId, { lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], version: "0.0.1", updatedAt: Date.now() }] });
  await assert.rejects(() => call("codex:enqueueTurn", { conversationId, runId: admissionRun, prompt: "old engine", instructions: "", engine: "codex" }), (error) => error.data?.errorCode === "engine_old");
  evidence.cases.push({ scenario: "legacy-and-offline-admission", passed: true });
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await runtime?.stop();
  sql?.close();
  globalThis.fetch = originalFetch;
  writeFileSync(join(scratch, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ passed: evidence.passed, cases: evidence.cases.length, result: join(scratch, "result.json"), error: evidence.error }));
}
