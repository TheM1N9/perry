// Failure inventory: failure-cases.md. Real Runtime/SQLite and backend functions;
// synthetic records, no scheduler, engines, owner data, or external traffic.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/orphan-tasks/run.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const out = resolve(import.meta.dirname);
const scratch = mkdtempSync(join(tmpdir(), "perry-orphan-tasks-"));
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = "synthetic-orphan-task-key";
process.env.PERRY_CREDENTIAL_KEY = "34".repeat(32);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("External IO disabled for orphan-task replay"); };
const [{ Runtime }, { default: schema }, { modules }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"),
]);
const sql = new DatabaseSync(":memory:");
const runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage") });
await runtime.stop();
const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const remove = id => runtime.exclusive(() => runtime.store.delete(id));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const chat = () => call("dashboard:createChat", { key: process.env.DASHBOARD_KEY });
const results = { checkedAt: new Date().toISOString(), passed: false, cases: [] };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(results, null, 2) + "\n");
const check = async (name, run) => {
  try { await run(); results.cases.push({ name, passed: true }); }
  catch (error) { results.cases.push({ name, passed: false, error: String(error) }); }
  save();
};
const task = async (status = "blocked", extra = {}) => {
  const conversationId = await chat();
  const id = await insert("tasks", {
    title: "Synthetic task", prompt: "Finish the synthetic task", plan: [], status,
    turns: 1, conversationId, createdAt: Date.now(), updatedAt: Date.now(), ...extra,
  });
  await patch(conversationId, { taskId: id });
  return { id, conversationId };
};
try {
  await check("resume refuses a deleted task chat without changing status", async () => {
    const row = await task(); await remove(row.conversationId);
    assert.equal(await call("tasks:resume", { id: row.id, answer: "Carry on" }), false);
    assert.equal((await get(row.id)).status, "blocked");
  });
  await check("cancel succeeds after both task and origin chats are deleted", async () => {
    const origin = await chat(); const row = await task("running", { origin });
    await remove(row.conversationId); await remove(origin);
    await call("work:updateTask", { taskId: row.id, status: "cancelled" });
    assert.equal((await get(row.id)).status, "cancelled");
    await call("work:updateTask", { taskId: row.id, status: "cancelled" });
  });
  await check("deleting an idle task chat cancels the task atomically", async () => {
    const row = await task();
    await call("dashboard:deleteChat", { key: process.env.DASHBOARD_KEY, id: row.conversationId });
    assert.equal(await get(row.conversationId), null);
    assert.equal((await get(row.id)).status, "cancelled");
  });
  await check("deleting a completed chat preserves its completed task", async () => {
    const row = await task("done", { result: "Already completed" });
    await call("dashboard:deleteChat", { key: process.env.DASHBOARD_KEY, id: row.conversationId });
    assert.equal((await get(row.id)).status, "done");
  });
  await check("recovery fails orphaned tasks and preserves a new task without a chat", async () => {
    const row = await task("running"); await remove(row.conversationId);
    const fresh = await insert("tasks", { title: "New", prompt: "Synthetic new task", plan: [], status: "running", turns: 1, createdAt: Date.now(), updatedAt: Date.now() });
    await call("recovery:sweep");
    assert.equal((await get(row.id)).status, "failed");
    assert.match((await get(row.id)).error, /chat was deleted/);
    assert.equal((await get(fresh)).status, "running");
    assert.equal(await call("tasks:reconcileMissingChats"), 0);
  });
  await check("a stale scheduled callback fails safely without recreating the chat", async () => {
    const row = await task("running"); await remove(row.conversationId);
    await call("tasks:work", { id: row.id });
    assert.equal((await get(row.id)).status, "failed");
    assert.equal((await get(row.id)).conversationId, row.conversationId);
    assert.equal(await get(row.conversationId), null);
  });
  await check("orphaned running tasks do not consume all background slots", async () => {
    for (let i = 0; i < 2; i++) {
      const row = await task("running"); await remove(row.conversationId);
    }
    const queued = await task("queued");
    await call("tasks:tick");
    assert.equal((await get(queued.id)).status, "running");
  });
  await check("healthy blocked tasks still resume", async () => {
    const row = await task();
    assert.equal(await call("tasks:resume", { id: row.id, answer: "Continue this task" }), true);
    assert.equal((await get(row.id)).status, "queued");
    assert.equal((await get(row.id)).answer, "Continue this task");
  });
  await check("steering an orphan refuses without accepting an update", async () => {
    const row = await task("running"); await remove(row.conversationId);
    await assert.rejects(call("tasks:steerFromDashboard", { key: process.env.DASHBOARD_KEY, id: row.id, text: "Synthetic update", requestId: "orphan-update-1" }), /unavailable/);
    assert.equal((await get(row.id)).steering, undefined);
  });
  results.passed = results.cases.every(item => item.passed);
  save();
  console.log(JSON.stringify(results, null, 2));
  if (!results.passed) process.exitCode = 1;
} finally {
  await runtime.stop(); sql.close(); globalThis.fetch = originalFetch;
  const absolute = resolve(scratch);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes("perry-orphan-tasks-")) rmSync(absolute, { recursive: true, force: true });
}
