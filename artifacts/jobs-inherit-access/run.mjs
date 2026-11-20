// Failure inventory: failure-cases.md. Real backend/SQLite and runner claims,
// with the scheduler stopped, synthetic data, and external IO disabled.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/jobs-inherit-access/run.mjs <outDir>
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Pass a disposable output directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const report = { checkedAt: new Date().toISOString(), passed: false, cases: [] };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
const scratch = mkdtempSync(join(tmpdir(), "perry-job-access-"));
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = "synthetic-job-access-key";
process.env.PERRY_CREDENTIAL_KEY = "35".repeat(32);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("External IO disabled for job-access replay"); };
const [{ Runtime }, { default: schema }, { modules }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"),
]);
const sql = new DatabaseSync(":memory:");
const runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage") });
await runtime.stop();
const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const token = "synthetic-job-access-runner";
const chat = async access => {
  const id = await call("dashboard:createChat", { key: process.env.DASHBOARD_KEY });
  await patch(id, { access });
  return id;
};
const job = async origin => {
  const created = await call("jobs:create", { name: "Access replay", prompt: "Verify synthetic work", at: new Date(Date.now() + 3600_000).toISOString(), ...(origin ? { origin } : {}) });
  assert.ok(created.id, JSON.stringify(created));
  return created.id;
};
const claim = async conversationId => {
  const conversation = await get(conversationId);
  const scheduled = sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn' ORDER BY createdAt DESC").all()
    .map(row => JSON.parse(row.args)).find(args => args.externalId === conversation.externalId);
  assert.ok(scheduled, "work must schedule a brain turn");
  await call("brain:handleTurn", scheduled);
  const turns = await runtime.exclusive(() => runtime.store.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", conversationId).eq("status", "queued")).collect());
  assert.equal(turns.length, 1, "brain must enqueue exactly one turn");
  const claimed = await call("codex:claimTurn", { token, id: turns[0]._id });
  assert.ok(claimed, "runner must claim the turn");
  return claimed;
};
const runJob = async id => {
  await call("jobs:run", { id });
  const conversationId = (await get(id)).conversationId;
  assert.ok(conversationId);
  return { conversationId, turn: await claim(conversationId) };
};
const launchTask = async id => {
  await call("tasks:tick");
  assert.equal((await get(id)).status, "running");
  await call("tasks:work", { id });
  const conversationId = (await get(id)).conversationId;
  assert.ok(conversationId);
  const turn = await claim(conversationId);
  await patch(id, { status: "done" });
  return { id, conversationId, turn };
};
const runTask = async (origin, extra = {}) => {
  const id = await call("tasks:queue", { title: "Access replay", prompt: "Verify synthetic work", ...(origin ? { origin } : {}) });
  await patch(id, extra);
  return await launchTask(id);
};
const check = async (name, run) => {
  try { await run(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error) }); }
  save();
};
try {
  const installation = await insert("installation", { defaultEngine: "codex", defaultAccess: "full", onboarding: "skipped", createdAt: Date.now() });
  await insert("runners", { name: "Synthetic runner", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  for (const access of ["full", "auto", "supervised", undefined]) {
    const expected = access ?? "supervised";
    await check(`job from ${access ?? "unset/Ask"} origin reaches runner as ${expected}`, async () => {
      const { turn } = await runJob(await job(await chat(access)));
      assert.equal(turn.access, expected);
    });
    await check(`task from ${access ?? "unset/Ask"} origin reaches runner as ${expected}`, async () => {
      const { turn } = await runTask(await chat(access));
      assert.equal(turn.access, expected);
    });
  }
  for (const access of [undefined, "supervised", "auto", "full"]) {
    await check(`legacy job chat ${access ?? "unset"} preserves explicit access or inherits once`, async () => {
      const origin = await chat("full");
      const id = await job(origin);
      const conversationId = await chat(access);
      await patch(conversationId, { jobId: id });
      await patch(id, { conversationId });
      assert.equal((await runJob(id)).turn.access, access ?? "full");
      assert.equal((await get(conversationId)).pendingTurns, 1);
      await patch(origin, { access: "supervised" });
      await call("jobs:chatFor", { id, threadId: "unused" });
      assert.equal((await get(conversationId)).access, access ?? "full");
      assert.equal((await get(conversationId)).pendingTurns, 2);
    });
  }
  await check("deleted job chat is recreated with origin access and project", async () => {
    const origin = await chat("auto");
    const projectId = await insert("projects", { name: "Synthetic project", createdAt: Date.now() });
    await patch(origin, { projectId });
    const id = await job(origin);
    const deleted = await chat("supervised");
    await patch(id, { conversationId: deleted });
    await runtime.exclusive(() => runtime.store.delete(deleted));
    await call("jobs:chatFor", { id, threadId: "replacement-thread" });
    const { conversationId, turn } = await runJob(id);
    assert.notEqual(conversationId, deleted);
    assert.equal(turn.access, "auto");
    assert.equal((await get(conversationId)).projectId, projectId);
  });
  for (const missing of ["absent", "deleted"]) {
    await check(`${missing} origin preserves job Ask and task installation fallback`, async () => {
      const origin = missing === "deleted" ? await chat("full") : undefined;
      const jobId = await job(origin);
      const taskId = await call("tasks:queue", { title: "Missing origin", prompt: "Verify synthetic fallback", ...(origin ? { origin } : {}) });
      if (origin) await runtime.exclusive(() => runtime.store.delete(origin));
      assert.equal((await runJob(jobId)).turn.access, "supervised");
      assert.equal((await launchTask(taskId)).turn.access, "full");
    });
  }
  await check("task without origin or installation access defaults to Ask", async () => {
    await patch(installation, { defaultAccess: undefined });
    assert.equal((await runTask()).turn.access, "supervised");
  });
  await check("Full origin overrides the installation's Ask default for jobs and tasks", async () => {
    await patch(installation, { defaultAccess: "supervised" });
    const origin = await chat("full");
    assert.equal((await runJob(await job(origin))).turn.access, "full");
    assert.equal((await runTask(origin)).turn.access, "full");
  });
  await check("initiative remains Ask despite Full origin", async () => {
    const startedBy = await runtime.exclusive(async () => (await runtime.store.query("codexTurns").first())._id);
    const { turn } = await runTask(await chat("full"), { initiative: { key: "synthetic", reason: "Synthetic preparation", sources: [], startedBy, attempts: [Date.now()], nextCheckAt: Date.now() } });
    assert.equal(turn.access, "supervised");
    assert.equal(turn.preparation, true);
  });
  await check("expired approval remains Ask and resume resets existing Full access", async () => {
    const expiredApprovalId = await insert("approvals", { status: "expired", createdAt: Date.now() });
    const { id, conversationId, turn } = await runTask(await chat("full"), { expiredApprovalId });
    assert.equal(turn.access, "supervised");
    await patch(turn._id, { status: "done", finalizedAt: Date.now() });
    await patch(id, { status: "blocked", question: "Synthetic expired proposal" });
    await patch(conversationId, { access: "full" });
    assert.equal(await call("tasks:resume", { id, answer: "Recheck the proposal" }), true);
    assert.equal((await get(conversationId)).access, "supervised");
  });
  await check("existing task chat retains its owner's access", async () => {
    const { id, conversationId } = await runTask(await chat("full"));
    await patch(conversationId, { access: "supervised" });
    await call("tasks:chatFor", { id, threadId: "unused" });
    assert.equal((await get(conversationId)).access, "supervised");
  });
  report.passed = report.cases.every(item => item.passed);
  save();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await runtime.stop(); sql.close(); globalThis.fetch = originalFetch;
  const absolute = resolve(scratch);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes("perry-job-access-")) rmSync(absolute, { recursive: true, force: true });
}
