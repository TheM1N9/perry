// Inventory: failure-cases.md. Real Runtime/SQLite/backend HTTP, plus bounded scheduler admission; no engine or personal data.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-presence/run.mjs <outDir>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const out = resolve(process.argv[2] ?? 'node_modules/.cache/task-presence');
const admissionBaseline = process.argv.includes('--admission-baseline');
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
const report = { checkedAt: new Date().toISOString(), mode: 'backend-projection-proof', admissionBaseline, cases: [], evidence: {}, passed: false };
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
const journey = async (name, run) => {
  try { report.evidence[name] = await run(); report.cases.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error) }); console.log('FAIL ' + name); }
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

const admissionJourney = async (name, run) => journey(name, async () => {
  const previous = runtime, admissionSql = new DatabaseSync(':memory:');
  let unexpectedActions = 0;
  runtime = new Runtime(admissionSql, schema, {
    ...modules,
    // Replay the previous single-mutation admission boundary without editing source.
    ...(admissionBaseline ? { tasks: { ...modules.tasks, work: modules.tasks.admitTurn } } : {}),
    brain: { ...modules.brain, handleTurn: { ...modules.brain.handleTurn, handler: () => { unexpectedActions++; throw Error('Preparation actions are forbidden in admission replay'); } } },
  }, { storageDir: join(home, 'admission-storage') });
  await runtime.stop();
  try {
    await insert('installation', { createdAt: Date.now(), defaultEngine: 'codex', onboarding: 'skipped' });
    const origin = await insert('conversations', { channel: 'web', externalId: 'admission-origin', threadId: 'synthetic-admission-origin' });
    const seed = (title, fields = {}) => insert('tasks', { title, prompt: 'Synthetic admission task.', origin, status: 'queued', plan: [], createdAt: Date.now(), updatedAt: Date.now(), ...fields });
    const result = await run({ sql: admissionSql, origin, seed });
    assert.equal(unexpectedActions, 0, 'Admission checks must not execute a preparation action');
    return result;
  } finally {
    await runtime.stop(); admissionSql.close(); runtime = previous;
  }
});

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
  const claim = async (conversationId) => {
    conversationId ??= await call('dashboard:createChat', { key });
    const runId = await call('runs:start', { conversationId, prompt: 'Synthetic exact task completion' });
    const turnId = await call('codex:enqueueTurn', { conversationId, runId, engine: 'codex', prompt: 'Synthetic exact task completion', instructions: 'No provider or external IO.' });
    assert.ok(await call('codex:claimTurn', { token, id: turnId }));
    return { conversationId, runId, turnId };
  };
  const tracked = async (title, plan) => {
    const turn = await claim();
    const id = await call('work:createTask', { title, prompt: 'Preserve verified task work and its original checklist.', origin: turn.conversationId, turnId: turn.turnId });
    await call('work:setPlan', { taskId: id, plan, turnId: turn.turnId }); return { id, ...turn };
  };
  const finish = async (item, extra = {}) => {
    await call('codex:finishTurn', { token, id: item.turnId, response: 'Synthetic verified result saved in the source chat.', ...extra });
    await call('codex:markFinalized', { id: item.turnId });
  };
  const recordedPlan = [{ title: 'Verified deliverable', status: 'done', note: 'Preserved evidence' }, { title: 'Checklist metadata not updated', status: 'active' }];
  const completedPlan = [{ title: 'Verified deliverable', status: 'done' }, { title: 'Excluded by scope', status: 'skipped', note: 'Owner excluded this step' }];
  await journey('exact authenticated tracked run closes confirmed plan without touching legacy source plans', async () => {
    const item = await tracked('Exact completed tracked plan', completedPlan);
    const legacy = await call('work:createTask', { title: 'Legacy unbound source plan', prompt: 'Unknown historical progress', origin: item.conversationId });
    await call('work:setPlan', { taskId: legacy, plan: completedPlan }); const before = await get(legacy);
    assert.equal((await get(item.id)).originRunId, item.runId); await finish(item);
    assert.equal((await get(item.id)).status, 'done'); assert.deepEqual((await get(item.id)).plan, completedPlan); assert.match((await get(item.id)).result, /Synthetic verified result/);
    assert.deepEqual(await get(legacy), before); return { task: await get(item.id), untouchedLegacy: await get(legacy) };
  });
  await journey('tracked final result with stale checklist stays nonurgent without replay and survives duplicate callbacks', async () => {
    const item = await tracked('Tracked result candidate', recordedPlan); await finish(item); const saved = await get(item.id);
    assert.equal(saved.status, 'blocked'); assert.ok(saved.completion); assert.equal(saved.question, undefined); assert.equal(saved.decision, undefined); assert.deepEqual(saved.plan, recordedPlan);
    await call('taskDecisions:armWaiting', {}); assert.equal((await get(item.id)).decision, undefined);
    assert.equal((await call('dashboard:getInbox', { key })).some(row => row.id === item.id), false);
    await call('codex:markFinalized', { id: item.turnId }); await call('tasks:afterTurn', { id: item.id, turnId: item.turnId, response: 'Late callback' }); assert.deepEqual(await get(item.id), saved);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name='tasks:work' AND args LIKE ?").get(`%${item.id}%`).n, 0);
    return { task: saved, board: await board(item.id) };
  });
  await journey('exact-version owner completion retains recorded steps and rejects stale completion replay', async () => {
    const item = await tracked('Owner confirms saved result', recordedPlan); await finish(item); const saved = await get(item.id);
    await assert.rejects(call('tasks:resolveCompletionFromDashboard', { key, id: item.id, version: 'stale-version', action: 'complete' })); assert.deepEqual(await get(item.id), saved);
    await call('tasks:resolveCompletionFromDashboard', { key, id: item.id, version: saved.completion.version, action: 'complete' });
    assert.equal((await get(item.id)).status, 'done'); assert.equal((await get(item.id)).result, saved.result); assert.deepEqual((await get(item.id)).plan, recordedPlan);
    await assert.rejects(call('tasks:resolveCompletionFromDashboard', { key, id: item.id, version: saved.completion.version, action: 'continue' })); return { task: await get(item.id) };
  });
  await journey('literal Stop and engine failure never complete even a recorded complete plan', async () => {
    const stopped = await tracked('Stopped exact tracked run', completedPlan); await call('codex:requestStop', { conversationId: stopped.conversationId }); await finish(stopped, { stopped: true, response: 'Partial work before Stop' });
    const failed = await tracked('Failed exact tracked run', completedPlan); await finish(failed, { response: '', error: 'Synthetic engine failure' });
    for (const item of [stopped, failed]) { assert.equal((await get(item.id)).status, 'failed'); assert.equal((await get(item.id)).completion, undefined); assert.equal((await get(item.runId)).status, 'error'); }
    return { stopped: await get(stopped.id), failed: await get(failed.id) };
  });
  await journey('new authenticated plan owner fences a late old finish after candidate continuation', async () => {
    const item = await tracked('Rebound tracked plan', recordedPlan); await finish(item); const saved = await get(item.id);
    const newer = await claim(item.conversationId); await call('work:setPlan', { taskId: item.id, plan: completedPlan, turnId: newer.turnId });
    const before = await get(item.id); assert.equal(before.originRunId, newer.runId); assert.equal(before.completion, undefined);
    await assert.rejects(call('work:updateTask', { taskId: item.id, turnId: item.turnId, status: 'done', result: 'Late superseded result' }));
    await assert.rejects(call('tasks:resolveCompletionFromDashboard', { key, id: item.id, version: saved.completion.version, action: 'complete' })); assert.deepEqual(await get(item.id), before);
    await finish(newer); assert.equal((await get(item.id)).status, 'done'); return { task: await get(item.id), rejectedOldTurn: item.turnId };
  });
  await journey('background media-only result is retained and relayed once without replaying generation', async () => {
    const id = await call('work:createTask', { title: 'Media-only background deliverable', prompt: 'Synthetic attachment result' }); await call('tasks:chatFor', { id, threadId: 'presence-media-result' });
    const chat = (await get(id)).conversationId; await patch(id, { turns: 1, plan: recordedPlan }); const item = { id, ...await claim(chat) };
    const storageId = await runtime.storeFile(new Blob(['Synthetic saved artifact'], { type: 'text/plain' }));
    await call('codex:finishTurn', { token, id: item.turnId, media: [{ storageId, fileName: 'synthetic-result.txt', contentType: 'text/plain', size: 24 }] }); await call('codex:markFinalized', { id: item.turnId });
    const saved = await get(id); assert.equal(saved.status, 'blocked'); assert.ok(saved.completion); assert.match(saved.result, /Attachments were saved/); assert.equal(saved.question, undefined); assert.deepEqual(saved.plan, recordedPlan); assert.equal(saved.turns, 1);
    const handoffs = (await rows('taskHandoffs')).filter(row => row.taskId === id); assert.equal(handoffs.length, 1); assert.equal(handoffs[0].outcome, 'result-ready');
    assert.equal(sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name='tasks:work' AND args LIKE ?").get(`%${id}%`).n, 0);
    await call('codex:markFinalized', { id: item.turnId }); assert.equal((await rows('taskHandoffs')).filter(row => row.taskId === id).length, 1); return { task: saved, handoff: handoffs[0] };
  });
  const taskSnapshot = await rows('tasks');
  const beforeRestart = await board(live.id);
  await runtime.stop(); runtime = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') }); await runtime.stop();
  assert.deepEqual(await rows('tasks'), taskSnapshot);
  await check('projection survives restart without task data repair', live, thread => assert.deepEqual(thread, beforeRestart));
  const paused = await fixture('Paused queued task', { status: 'queued' });
  await call('pause:set', { key, paused: true });
  await check('paused queued task is not classified as executing', paused, thread => assert.notEqual(thread.status, 'working'));
  report.taskDataPreservedAcrossRestart = true;
  await admissionJourney('failed scheduled admissions release task capacity', async ({ sql, seed }) => {
    const rejected = [await seed('Admission rejected A'), await seed('Admission rejected B')], later = await seed('Later queued task');
    sql.exec(`CREATE TEMP TRIGGER reject_admission BEFORE INSERT ON doc_agentThreads
      WHEN json_extract(NEW.doc, '$.title') LIKE '%Admission rejected%'
      BEGIN SELECT RAISE(ABORT, 'synthetic-private-admission-reason'); END`);
    await call('tasks:tick');
    let watchdog, finished = false, resolveDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; watchdog = setTimeout(() => reject(Error('Admission scheduler did not settle')), 5000); });
    const onChange = () => {
      const failedTasks = rejected.every(id => runtime.store.get(id)?.status === 'failed');
      const failedSchedules = sql.prepare("SELECT count(*) AS n FROM doc_scheduledFailures WHERE json_extract(doc,'$.functionName')='tasks:work'").get().n;
      if (!finished && (failedTasks || failedSchedules === 2)) { finished = true; void runtime.stop(); resolveDone(); }
    };
    runtime.events.on('change', onChange);
    try { runtime.start(); await done; await runtime.stop(); }
    finally { clearTimeout(watchdog); runtime.events.off('change', onChange); await runtime.stop(); }
    await call('tasks:tick');
    const observed = { rejected: await Promise.all(rejected.map(get)), later: await get(later), handoffs: await rows('taskHandoffs'), scheduledFailures: await rows('scheduledFailures') };
    report.evidence.admissionFailure = observed;
    assert.ok(observed.rejected.every(task => task.status === 'failed'), 'Rejected starts must not remain running');
    assert.equal(observed.later.status, 'running', 'A later task must obtain a released slot');
    assert.equal(observed.scheduledFailures.length, 0, 'Handled admission errors must not leave failed scheduled callbacks');
    for (const task of observed.rejected) {
      assert.ok(task.error && !task.error.includes('synthetic-private-admission-reason'));
      assert.equal(observed.handoffs.filter(row => row.taskId === task._id && row.outcome === 'failed').length, 1);
      await call('tasks:work', { id: task._id });
    }
    assert.equal((await rows('taskHandoffs')).length, 2, 'Repeated callbacks must not duplicate failure reports');
    return observed;
  });
  await admissionJourney('partial task admission rolls back with a failed preparation schedule', async ({ sql, seed }) => {
    const id = await seed('Late admission failure', { status: 'running', turns: 1, result: 'Earlier saved work.', plan: [{ title: 'Keep prior work', status: 'done' }] });
    const before = Object.fromEntries(await Promise.all(['agentThreads', 'conversations', 'runs', 'codexTurns'].map(async table => [table, (await rows(table)).length])));
    sql.exec("CREATE TEMP TRIGGER reject_preparation BEFORE INSERT ON _scheduled WHEN NEW.name='brain:handleTurn' BEGIN SELECT RAISE(ABORT, 'synthetic-private-admission-reason'); END");
    let error; try { await call('tasks:work', { id }); } catch (cause) { error = String(cause); }
    const task = await get(id), after = Object.fromEntries(await Promise.all(Object.keys(before).map(async table => [table, (await rows(table)).length])));
    report.evidence.partialAdmission = { task, before, after, error };
    assert.equal(error, undefined, 'Startup failure must be contained by its admission boundary');
    assert.equal(task.status, 'failed'); assert.equal(task.result, 'Earlier saved work.'); assert.equal(task.plan[0].status, 'done');
    assert.equal(task.conversationId, undefined); assert.deepEqual(after, before);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name='brain:handleTurn'").get().n, 0);
    return { task, before, after };
  });
  await admissionJourney('existing durable work survives a later admission fault', async ({ sql, seed, origin }) => {
    const id = await seed('Existing admitted work', { status: 'running', turns: 1 });
    await call('tasks:work', { id });
    const task = await get(id), turns = await rows('codexTurns'), pending = sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name='brain:handleTurn'").get().n;
    assert.equal(turns.length, 1); assert.equal(pending, 1);
    sql.exec("CREATE TEMP TRIGGER reject_route BEFORE UPDATE ON doc_tasks WHEN NEW._id=OLD._id BEGIN SELECT RAISE(ABORT, 'synthetic-private-admission-reason'); END");
    await call('tasks:work', { id });
    assert.deepEqual(await get(id), task); assert.deepEqual(await rows('codexTurns'), turns);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name='brain:handleTurn'").get().n, pending);
    assert.equal((await rows('taskHandoffs')).length, 0);
    return { task, turns, origin };
  });
  await admissionJourney('pending accepted steering survives an admission fault', async ({ sql, seed }) => {
    const id = await seed('Admitted task awaiting steering', { status: 'running', turns: 1 });
    await call('tasks:work', { id });
    const task = await get(id), turn = (await rows('codexTurns'))[0];
    await patch(turn._id, { status: 'done', finalizedAt: Date.now() });
    const machine = await insert('runners', { token: 'synthetic-admission-runner', name: 'Admission replay', createdAt: Date.now(), lastSeenAt: Date.now() });
    const steer = await insert('codexSteers', { turnId: turn._id, runnerId: machine, conversationId: task.conversationId, runId: turn.runId, prompt: 'Keep the accepted owner correction.', instructions: '', status: 'pending', createdAt: Date.now() });
    await patch(id, { steering: [{ requestId: 'admission-steer', text: 'Keep the accepted owner correction.', deliveryId: steer, createdAt: Date.now() }] });
    const before = await get(id), beforeSteers = await rows('codexSteers');
    sql.exec("CREATE TEMP TRIGGER reject_route BEFORE UPDATE ON doc_tasks WHEN NEW._id=OLD._id BEGIN SELECT RAISE(ABORT, 'synthetic-private-admission-reason'); END");
    await call('tasks:work', { id });
    assert.deepEqual(await get(id), before); assert.deepEqual(await rows('codexSteers'), beforeSteers);
    assert.equal((await rows('taskHandoffs')).length, 0);
    return { task: before, steering: beforeSteers };
  });
  await admissionJourney('cancelled paused and dependent task holds remain holds', async ({ seed }) => {
    const cancelled = await seed('Cancelled before callback', { status: 'cancelled', turns: 1 });
    const saved = await get(cancelled); await call('tasks:work', { id: cancelled }); assert.deepEqual(await get(cancelled), saved);
    const prerequisite = await seed('Prerequisite not finished'), dependent = await seed('Wait for prerequisite', { status: 'running', turns: 1, dependsOn: [prerequisite] });
    await call('tasks:work', { id: dependent }); assert.equal((await get(dependent)).status, 'queued'); assert.equal((await get(dependent)).turns, 0);
    const paused = await seed('Paused before callback', { status: 'running', turns: 1 });
    await call('pause:set', { key, paused: true }); await call('tasks:work', { id: paused });
    assert.equal((await get(paused)).status, 'blocked'); assert.match((await get(paused)).question, /paused/); assert.equal((await rows('codexTurns')).length, 0); assert.equal((await rows('taskHandoffs')).length, 0);
    return { cancelled: await get(cancelled), dependent: await get(dependent), paused: await get(paused) };
  });
} catch (error) { report.setupError = String(error); }
finally {
  await runtime.stop(); await new Promise(done => server.close(done)); server.closeAllConnections(); sql.close(); globalThis.fetch = nativeFetch;
  rmSync(home, { recursive: true, force: true }); report.homeRemoved = !existsSync(home);
  report.passed = !report.setupError && report.cases.every(item => item.passed); save();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, failures: report.cases.filter(item => !item.passed), setupError: report.setupError }, null, 2));
process.exitCode = report.passed ? 0 : 1;
