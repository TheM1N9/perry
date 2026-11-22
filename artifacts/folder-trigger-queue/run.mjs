import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Pass a disposable output directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "perry-folder-queue-"));
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = "synthetic-folder-queue-key";
process.env.PERRY_CREDENTIAL_KEY = "35".repeat(32);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("External IO disabled for folder replay"); };
const [{ Runtime }, { default: schema }, { modules }, { runTriggers }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"),
  import("../../server/modules.ts"), import("../../server/triggers.ts"),
]);
const sql = new DatabaseSync(join(scratch, "test.sqlite"));
let runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage") });
const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
const get = id => runtime.exclusive(() => runtime.store.get(id));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message, timeout = 10_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(50); }
  assert.fail(message);
};
const report = { at: new Date().toISOString(), passed: false, cases: [], prompts: [] };
const check = async (name, fn) => {
  try { await fn(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error) }); }
};
// Execute only real jobs actions/mutations. Inspect the final brain prompt;
// never run the brain, engine, notifications, or other scheduled side effects.
const drain = async () => {
  for (let i = 0; i < 100; i++) {
    const row = sql.prepare("SELECT * FROM _scheduled WHERE name LIKE 'jobs:%' AND runAt <= ? ORDER BY runAt LIMIT 1").get(Date.now());
    if (!row) break;
    sql.prepare("DELETE FROM _scheduled WHERE id = ?").run(row.id);
    await call(row.name, JSON.parse(row.args));
  }
};
const prompts = () => sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn' ORDER BY createdAt").all().map(row => JSON.parse(row.args).text);
const finish = async (id, error) => {
  await patch((await get(id)).conversationId, { pendingTurns: 0 });
  await call("jobs:finished", { id, ...(error ? { error } : { result: "NOTHING" }) });
};
const makeJob = async path => {
  mkdirSync(path);
  return (await call("jobs:create", { name: "Folder replay", prompt: "Only report when DONE.txt arrives; otherwise reply NOTHING.", trigger: { kind: "folder", path, label: "A file lands" } })).id;
};
let stop;
try {
  const installation = await runtime.exclusive(() => runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now() }));
  const folder = join(scratch, "drop");
  const id = await makeJob(folder);
  writeFileSync(join(folder, "already-here.txt"), "old");
  stop = runTriggers(runtime);
  await sleep(500);
  const start = Date.now();
  for (let i = 0; i < 10; i++) writeFileSync(join(folder, `burst-${i}.txt`), "new");
  await sleep(2200);
  await drain();
  await check("burst delivers all ten filenames in one prompt", async () => {
    const batch = prompts();
    assert.equal(batch.length, 1);
    for (let i = 0; i < 10; i++) assert.ok(batch[0].includes(`burst-${i}.txt`), `missing burst-${i}.txt`);
    assert.ok(!batch[0].includes("already-here.txt"));
  });
  // Keep the first run in progress for a real 30-second interval.
  await sleep(Math.max(0, 30_000 - (Date.now() - start)));
  writeFileSync(join(folder, "DONE.txt"), "complete");
  await sleep(2200);
  await drain();
  await check("DONE at 30s waits for active run", async () => assert.equal(prompts().length, 1));
  await finish(id);
  await until(async () => { await drain(); return prompts().length >= 2; }, "follow-up never ran").catch(error => report.cases.push({ name: "follow-up starts", passed: false, error: String(error) }));
  await check("follow-up sees DONE after NOTHING", async () => assert.ok(prompts().at(-1)?.includes(`A new file arrived: ${join(folder, "DONE.txt")}`)));
  await finish(id);
  // Reproduce the observed RESULT -> DONE gap (4.3 seconds), inside 20s.
  const event = file => call("jobs:onEvent", { folder, files: [join(folder, file)], event: `A new file arrived: ${join(folder, file)}` });
  await check("cooldown retains later arrivals and long batches across restart", async () => {
    await event("later.txt");
    for (let i = 0; i < 60; i++) await event(`${String(i).padStart(2, "0")}-${"long-name-".repeat(12)}.txt`);
    await runtime.stop();
    stop(); stop = undefined;
    runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage") });
    await sleep(350); await drain();
    const latest = prompts().at(-1);
    assert.ok(latest.includes("later.txt"));
    assert.ok(latest.includes(`59-${"long-name-".repeat(12)}.txt`), "last filename truncated");
    await finish(id, "Synthetic engine failure");
    await event("after-error.txt"); await sleep(350); await drain();
    assert.ok(prompts().at(-1).includes("after-error.txt"));
    await finish(id);
  });
  await check("disabled and paused jobs do not dispatch", async () => {
    const before = prompts().length;
    await patch(id, { enabled: false });
    await event("disabled.txt"); await sleep(350); await drain();
    assert.equal(prompts().length, before);
    await patch(id, { enabled: true });
    await patch(installation, { paused: { at: Date.now(), by: "web" } });
    await event("paused.txt"); await sleep(350); await drain();
    assert.equal(prompts().length, before);
    await patch(installation, { paused: undefined });
    await call("pause:runMissedFrom", { ids: [id] });
    await drain();
    assert.ok(prompts().at(-1).includes("paused.txt"));
    await finish(id);
  });
  await check("more than 100 files drain in complete batches", async () => {
    const before = prompts().length;
    for (let i = 0; i < 105; i++) await event(`overflow-${i}.txt`);
    await sleep(350); await drain();
    assert.equal(prompts().length, before + 1);
    await finish(id); await sleep(350); await drain();
    assert.equal(prompts().length, before + 2);
    const batches = prompts().slice(before).join("\n");
    for (let i = 0; i < 105; i++) assert.ok(batches.includes(`A new file arrived: ${join(folder, `overflow-${i}.txt`)}`));
    await finish(id);
  });
  await check("skipping paused files does not replay them on the next arrival", async () => {
    await patch(installation, { paused: { at: Date.now(), by: "web" } });
    await event("skip-me.txt");
    await call("pause:skipMissedFrom", { id });
    await patch(installation, { paused: undefined });
    await event("keep-me.txt"); await sleep(350); await drain();
    assert.ok(prompts().at(-1).includes("keep-me.txt"));
    assert.ok(!prompts().at(-1).includes("skip-me.txt"));
    await finish(id);
  });
  await check("watcher retries failed enqueue and ignores partial/duplicate writes", async () => {
    const retryFolder = join(scratch, "retry");
    const retryId = await makeJob(retryFolder);
    const mutate = runtime.runMutation.bind(runtime);
    let failures = 0;
    runtime.runMutation = async (name, args, options) => {
      if (name === "jobs:onEvent" && args.folder === retryFolder && failures++ === 0) throw new Error("Synthetic enqueue failure");
      return mutate(name, args, options);
    };
    stop = runTriggers(runtime);
    try {
      await sleep(500);
      writeFileSync(join(retryFolder, "pending.crdownload"), "partial");
      writeFileSync(join(retryFolder, "retry.txt"), "first");
      writeFileSync(join(retryFolder, "retry.txt"), "second");
      await until(async () => (await get(retryId)).pendingFiles?.length === 1, "enqueue was not retried", 12_000);
      assert.equal(failures, 2);
      assert.deepEqual((await get(retryId)).pendingFiles, [join(retryFolder, "retry.txt")]);
      await sleep(1800);
      assert.equal((await get(retryId)).pendingFiles.length, 1);
    } finally {
      stop(); stop = undefined;
      runtime.runMutation = mutate;
    }
    assert.equal(runtime.events.listenerCount("change"), 0);
  });
  await check("app triggers retain existing cooldown", async () => {
    const app = (await call("jobs:create", { name: "App replay", prompt: "Inspect synthetic app event", trigger: { kind: "app", toolkit: "gmail", slug: "mail", instanceId: "synthetic-mail", label: "New mail" } })).id;
    assert.equal(await call("jobs:onEvent", { instanceIds: ["other"], event: "unrelated" }), 0);
    assert.equal(await call("jobs:onEvent", { instanceIds: ["synthetic-mail"], event: "first" }), 1);
    assert.equal(await call("jobs:onEvent", { instanceIds: ["synthetic-mail"], event: "second" }), 0);
    assert.ok((await get(app)).lastRunAt);
  });
  report.prompts = prompts();
  report.passed = report.cases.every(item => item.passed);
} finally {
  stop?.();
  await runtime.stop();
  sql.close();
  globalThis.fetch = originalFetch;
  writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases }, null, 2));
if (!report.passed) process.exitCode = 1;
