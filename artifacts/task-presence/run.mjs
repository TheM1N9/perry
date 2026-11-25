// Inventory: failure-cases.md. Real Runtime/SQLite/backend HTTP; no engine, scheduler or personal data.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-presence/run.mjs <outDir>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const out = resolve(process.argv[2] ?? 'node_modules/.cache/task-presence');
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'perry-task-presence-'));
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = 'synthetic-task-presence-key';
process.env.PERRY_CREDENTIAL_KEY = '82'.repeat(32);
process.env.PERRY_ENGINE = 'codex';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  if (!String(input).startsWith('http://127.0.0.1:')) throw Error('External IO disabled in task-presence fixture');
  return nativeFetch(input, ...args);
};
const [{ Runtime }, { default: schema }, { modules }] = await Promise.all([
  import('../../server/runtime.ts'), import('../../convex/schema.ts'), import('../../server/modules.ts'),
]);
const sql = new DatabaseSync(join(home, 'fixture.sqlite'));
let runtime = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') });
await runtime.stop();
const report = { checkedAt: new Date().toISOString(), mode: 'backend-projection-proof', cases: [], evidence: {}, passed: false };
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const rows = table => runtime.exclusive(() => runtime.store.all(table));
const key = process.env.DASHBOARD_KEY, token = 'synthetic-presence-runner';
let runner;
const server = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { path, args } = JSON.parse(Buffer.concat(chunks).toString());
    const { value } = await runtime.call(path, args ?? {}, { internal: true });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ value }));
  } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (path, args = {}) => {
  const response = await fetch(base, { method: 'POST', body: JSON.stringify({ path, args }) });
  const body = await response.json(); if (body.error) throw Error(body.error); return body.value;
};
const board = async id => (await call('board:get', { key })).threads.find(thread => thread.id === `task:${id}`);
const check = async (name, fixture, accept) => {
  try {
    const taskBefore = await get(fixture.id), thread = await board(fixture.id);
    const taskAfter = await get(fixture.id);
    assert.deepEqual(taskAfter, taskBefore, 'Board read must not repair or mutate task');
    report.evidence[name] = { task: taskBefore, thread, ...(fixture.run ? { run: await get(fixture.run) } : {}), ...(fixture.turn ? { turn: await get(fixture.turn) } : {}) };
    accept(thread); report.cases.push({ name, passed: true }); console.log('PASS ' + name);
  } catch (error) { report.cases.push({ name, passed: false, error: String(error) }); console.log('FAIL ' + name); }
  save();
};
const fixture = async (name, { tracked = false, age = 0, status = 'running', runStatus, turnStatus, preparing = false, question, origin } = {}) => {
  const now = Date.now(), started = now - age;
  const id = await insert('tasks', { title: name, prompt: 'Synthetic task presence proof.', plan: [{ title: 'Preserved unfinished step', status: 'active' }], status, createdAt: started, updatedAt: started, ...(tracked ? {} : { turns: 1 }), ...(question ? { question } : {}), ...(origin ? { origin } : {}) });
  if (tracked) return { id };
  await call('tasks:chatFor', { id, threadId: `presence-${id}` });
  const chat = (await get(id)).conversationId;
  if (!runStatus) return { id, chat };
  const run = await insert('runs', { conversationId: chat, prompt: 'Synthetic task execution.', status: runStatus, startedAt: started, ...(runStatus === 'running' ? {} : { finishedAt: now, ...(runStatus === 'error' ? { error: 'Synthetic stopped worker' } : {}) }) });
  const turn = turnStatus ? await insert('codexTurns', { conversationId: chat, runId: run, runnerId: runner, engine: 'codex', prompt: 'Synthetic task execution.', instructions: 'No external calls.', status: turnStatus, createdAt: started, ...(preparing ? { preparing: true } : {}) }) : undefined;
  return { id, chat, run, turn };
};

try {
  const now = Date.now();
  await insert('installation', { createdAt: now, defaultEngine: 'codex', onboarding: 'skipped' });
  runner = await insert('runners', { token, name: 'Synthetic presence computer', revoked: false, createdAt: now, lastSeenAt: now, turnHeartbeats: true, engines: [{ kind: 'codex', installed: true, signedIn: true, auth: {}, models: [], updatedAt: now }] });
  const notExecuting = thread => { assert.notEqual(thread.status, 'working', JSON.stringify(thread)); assert.equal(thread.canSteer, false); };
  await check('fresh tracked plan is not proof of an executing agent', await fixture('Tracked fresh', { tracked: true }), notExecuting);
  await check('49-day tracked plan is not an executing agent', await fixture('Tracked legacy', { tracked: true, age: 49 * 86_400_000 }), notExecuting);
  const origin = await insert('conversations', { channel: 'web', externalId: 'tracked-origin', threadId: 'tracked-origin' });
  const trackedOrigin = await fixture('Tracked with source chat', { tracked: true, origin });
  const originRun = await insert('runs', { conversationId: origin, prompt: 'Unrelated subsequent owner request.', status: 'running', startedAt: Date.now() });
  const originTurn = await insert('codexTurns', { conversationId: origin, runId: originRun, runnerId: runner, engine: 'codex', prompt: 'Unrelated owner work.', instructions: 'No external calls.', status: 'queued', createdAt: Date.now() });
  assert.ok(await call('codex:claimTurn', { token, id: originTurn }));
  await check('tracked source review does not infer unrelated origin execution', trackedOrigin, thread => { notExecuting(thread); assert.equal(thread.label, 'Tracked'); assert.equal(thread.sourceChatId, origin); assert.equal(thread.chatId, undefined); });
  await check('background without an execution is not working', await fixture('No execution'), notExecuting);
  await check('successful run does not mean unfinished plan is executing', await fixture('Run succeeded', { runStatus: 'ok' }), notExecuting);
  await check('failed run is not an executing worker', await fixture('Run failed', { runStatus: 'error' }), notExecuting);
  await check('orphaned run is not changed back from interrupted to working', await fixture('Orphan run', { runStatus: 'running', age: 60 * 60_000 }), notExecuting);
  const queued = await fixture('Queued worker', { runStatus: 'running', turnStatus: 'queued' });
  await check('durably queued worker remains queued', queued, thread => { assert.equal(thread.status, 'queued'); assert.equal(thread.canSteer, true); });
  const preparing = await fixture('Preparing worker', { runStatus: 'running', turnStatus: 'queued', preparing: true });
  await check('preparing worker is not falsely treated as dead execution', preparing, thread => { assert.equal(thread.status, 'queued'); assert.equal(thread.label, 'Preparing'); });
  const blocked = await fixture('Owner question', { status: 'blocked', question: 'Which option should be used?' });
  await check('explicit owner question remains waiting', blocked, thread => assert.equal(thread.status, 'waiting'));
  const live = await fixture('Long live task', { runStatus: 'running', turnStatus: 'queued', age: 49 * 86_400_000 });
  assert.ok(await call('codex:claimTurn', { token, id: live.turn }));
  await patch(live.turn, { startedAt: Date.now() - 2 * 86_400_000 });
  await call('runner:checkIn', { token, activeTurnIds: [live.turn] });
  await check('old task with authenticated live worker stays working', live, thread => { assert.equal(thread.status, 'working'); assert.equal(thread.canSteer, true); });
  const receiptRun = await call('runs:start', { conversationId: live.chat, prompt: 'A newer receipt awaiting its active worker.' });
  await check('newer steering receipt does not hide existing executing turn', live, thread => { assert.equal(thread.status, 'working'); assert.equal(thread.canSteer, true); });
  await call('runs:finish', { id: receiptRun, status: 'ok' });
  await patch(live.turn, { lastHeartbeatAt: Date.now() - 120_000 });
  await call('runner:checkIn', { token, activeTurnIds: [] });
  await check('unrelated machine check-in does not prolong missing modern worker', live, thread => { assert.equal(thread.status, 'blocked'); assert.equal(thread.label, 'Computer not responding'); });
  await call('runner:checkIn', { token, activeTurnIds: [live.turn] });
  await check('authenticated recovered heartbeat clears warning', live, thread => assert.equal(thread.status, 'working'));
  await patch(live.turn, { stopRequested: true });
  await check('stopping worker does not offer unusable steering', live, thread => { assert.equal(thread.label, 'Stopping'); assert.equal(thread.canSteer, false); });
  await patch(live.turn, { stopRequested: undefined });
  await call('codex:finishTurn', { token, id: live.turn, response: 'Synthetic worker ended while plan still needs review.' });
  await check('terminal worker awaiting delivery is not still executing', live, thread => { notExecuting(thread); assert.equal(thread.label, 'Finishing'); });
  // This is retryOn's persisted shape; no actual model/runner process is started.
  await patch(live.turn, { status: 'error', error: 'Synthetic usage reset', finalizedAt: Date.now() });
  const replacement = await insert('codexTurns', { conversationId: live.chat, runId: live.run, runnerId: runner, retryOf: live.turn, engine: 'codex', prompt: 'Synthetic recovered task.', instructions: 'No external calls.', status: 'queued', createdAt: Date.now() });
  const resumed = { ...live, turn: replacement };
  await check('same-run queued replacement wins over finalized earlier attempt', resumed, thread => assert.equal(thread.status, 'queued'));
  assert.ok(await call('codex:claimTurn', { token, id: replacement }));
  await call('runner:checkIn', { token, activeTurnIds: [replacement] });
  await check('same-run claimed replacement stays working', resumed, thread => assert.equal(thread.status, 'working'));
  const reset = await fixture('Provider reset wait', { runStatus: 'running', turnStatus: 'error' });
  await patch(reset.turn, { retrying: true, waiting: { until: Date.now() + 60_000, why: 'Synthetic provider reset', engine: 'codex' } });
  await check('provider reset wait remains specific and nonsteerable', reset, thread => { notExecuting(thread); assert.equal(thread.label, 'Waiting for reset'); });
  await patch(reset.turn, { waiting: undefined });
  await check('pending engine retry stays retrying without an active executor', reset, thread => { notExecuting(thread); assert.equal(thread.label, 'Retrying'); });
  const finalizing = await fixture('Native finalization', { runStatus: 'running', turnStatus: 'queued' });
  assert.ok(await call('codex:claimTurn', { token, id: finalizing.turn }));
  await call('codex:finishTurn', { token, id: finalizing.turn, response: 'One phase finished; unfinished comparison remains.' });
  await check('native delivery keeps its run running until finalization', finalizing, thread => { notExecuting(thread); assert.equal(thread.label, 'Finishing'); });
  assert.equal((await get(finalizing.run)).status, 'running');
  await call('codex:markFinalized', { id: finalizing.turn });
  assert.ok((await get(finalizing.turn)).finalizedAt); assert.equal((await get(finalizing.run)).status, 'ok');
  await check('native finalization saves result without falsely completing unfinished checklist', finalizing, thread => { notExecuting(thread); assert.equal(thread.label, 'Result ready'); assert.equal(thread.status, 'blocked'); assert.equal(thread.question, undefined); });
  const taskSnapshot = await rows('tasks');
  const beforeRestart = await board(live.id);
  await runtime.stop(); runtime = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') }); await runtime.stop();
  assert.deepEqual(await rows('tasks'), taskSnapshot);
  await check('projection survives restart without task data repair', live, thread => assert.deepEqual(thread, beforeRestart));
  const paused = await fixture('Paused queued task', { status: 'queued' });
  await call('pause:set', { key, paused: true });
  await check('paused queued task is not classified as executing', paused, thread => assert.notEqual(thread.status, 'working'));
  report.taskDataPreservedAcrossRestart = true;
} catch (error) { report.setupError = String(error); }
finally {
  await runtime.stop(); await new Promise(done => server.close(done)); server.closeAllConnections(); sql.close(); globalThis.fetch = nativeFetch;
  rmSync(home, { recursive: true, force: true }); report.homeRemoved = !existsSync(home);
  report.passed = !report.setupError && report.cases.every(item => item.passed); save();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, failures: report.cases.filter(item => !item.passed), setupError: report.setupError }, null, 2));
process.exitCode = report.passed ? 0 : 1;
