// Failure inventory: docs/regression-checks.md. No model or real account is called.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/unattended-work/run.mjs <outDir>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv[2]) throw Error('Pass a disposable output directory');
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'perry-unattended-'));
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = 'synthetic-unattended-key';
process.env.PERRY_CREDENTIAL_KEY = '71'.repeat(32);
process.env.TELEGRAM_BOT_TOKEN = '999:synthetic';
process.env.TELEMETRY_DISABLED = 'true';
const report = { checkedAt: new Date().toISOString(), passed: false, cases: [], telegram: [], homeRemoved: false };
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const originalFetch = globalThis.fetch;
let runtime, sql, gate, pendingExternal, runCall, releaseExternal;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const args = req.headers['content-type']?.startsWith('multipart/') ? { multipart: raw } : JSON.parse(raw || '{}');
    if (req.url?.startsWith('/bot999:synthetic/')) {
      report.telegram.push({ method: req.url.split('/').at(-1), ...args });
      if (gate) {
        const active = gate;
        gate = undefined;
        active.started();
        await active.release;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: 1000 + report.telegram.length } }));
      return;
    }
    if (req.url === '/api/backend') {
      const response = await runCall(new Request(base + '/api/backend', { method: 'POST', body: JSON.stringify(args) }), { internal: true });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
      return;
    }
    const value = (await runtime.call(args.path, args.args ?? {}, { internal: true })).value;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ value: value ?? null }));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message, name: error.name }));
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_API_BASE = base;
globalThis.fetch = (input, ...args) => {
  if (!String(input).startsWith(base + '/')) throw Error('External IO disabled');
  return originalFetch(input, ...args);
};
const [{ Runtime }, { default: schema }, { modules }, { default: http }] = await Promise.all([
  import('../../server/runtime.ts'), import('../../convex/schema.ts'), import('../../server/modules.ts'), import('../../convex/http.ts'),
]);
const open = async () => {
  sql = new DatabaseSync(join(home, 'fixture.sqlite'));
  runtime = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage'), http });
  await runtime.stop();
  globalThis.__perry = { runtime, started: false };
};
await open();
({ runCall } = await import('../../server/api.ts'));
const call = async (path, args = {}) => {
  const body = await (await fetch(base + '/call', { method: 'POST', body: JSON.stringify({ path, args }) })).json();
  if (body.error) throw Object.assign(Error(body.error), { name: body.name });
  return body.value;
};
const rows = table => runtime.exclusive(() => runtime.store.all(table));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const publicCall = async (path, args) => {
  const response = await fetch(base + '/api/backend', { method: 'POST', body: JSON.stringify({ path, args }) });
  return { status: response.status, body: await response.json() };
};
const restart = async () => { await runtime.stop(); sql.close(); await open(); };
const scheduled = name => sql.prepare('SELECT id, args FROM _scheduled WHERE name = ? ORDER BY createdAt, rowid').all(name);
const drain = async name => {
  for (const row of scheduled(name)) {
    sql.prepare('DELETE FROM _scheduled WHERE id = ?').run(row.id);
    await call(name, JSON.parse(row.args));
  }
};
const check = async (name, work) => {
  try { await work(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error), stack: error.stack }); }
  save();
};
const token = 'synthetic-unattended-runner';
let installation, runner, heartbeatJob, ownerChat;
const heartbeat = async () => {
  const threadId = await call('agentStore:createThread');
  const conversationId = await insert('conversations', { threadId, channel: 'web', externalId: `session:${threadId}`, jobId: heartbeatJob, createdAt: Date.now() });
  const runId = await insert('runs', { conversationId, prompt: 'Synthetic heartbeat', status: 'running', startedAt: Date.now() });
  return await insert('codexTurns', { conversationId, runnerId: runner, runId, prompt: 'Synthetic heartbeat', instructions: '', status: 'running', engine: 'codex', createdAt: Date.now() });
};
const prepare = (turnId, source, extra = {}) => call('initiative:prepare', { turnId, source, title: 'Prepare renewal options', prompt: 'Compare the renewal options and prepare the exact draft.', reason: 'The renewal terms changed.', sources: ['Renewal notice: deadline next week; price changed.'], ...extra });
const blocked = async (title = 'Owner choice') => {
  const id = await call('work:createTask', { title, prompt: 'Prepare a concrete decision.' });
  await call('work:updateTask', { taskId: id, status: 'blocked', question: 'Choose the verified draft A or B.' });
  return await get(id);
};
const review = (task, turnId, extra = {}) => call('notify:reviewDecision', { id: task._id, version: task.decision.version, turnId, action: 'notify', reason: 'The deadline is approaching.', message: 'The draft is ready; choose A or B.', ...extra });
const claimTask = async id => {
  await call('tasks:tick');
  await call('tasks:work', { id });
  const task = await get(id), chat = await get(task.conversationId);
  const pending = scheduled('brain:handleTurn').find(row => JSON.parse(row.args).externalId === chat.externalId);
  assert.ok(pending, 'task schedules one brain preparation');
  sql.prepare('DELETE FROM _scheduled WHERE id = ?').run(pending.id);
  await call('brain:handleTurn', JSON.parse(pending.args));
  const turn = (await rows('codexTurns')).find(row => row.conversationId === chat._id && row.status === 'queued');
  assert.ok(turn);
  const claimed = await call('codex:claimTurn', { token, id: turn._id });
  assert.ok(claimed?.mcpGrant);
  return { ...await get(turn._id), mcpGrant: claimed.mcpGrant };
};
const tool = async (turn, name, args) => {
  const response = await runtime.runHttp('/mcp', new Request(`http://synthetic/mcp?turn=${turn._id}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-perry-chat': turn.conversationId, 'x-perry-turn': turn._id, 'x-perry-grant': turn.mcpGrant },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  return await response.json();
};
const remoteToken = 'synthetic-remote-job-runner', remotePath = join(home, 'private-server-copy.txt');
const serverCanary = 'SYNTHETIC SERVER-ONLY BYTES', snapshotBytes = 'VERIFIED REMOTE SNAPSHOT';
let remoteRunner;
const remoteResult = async (channel = 'telegram', snapshot = false, legacyLocation = false) => {
  if (!remoteRunner) remoteRunner = await insert('runners', { name: 'Remote runner', token: remoteToken, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: 'codex', installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  writeFileSync(remotePath, serverCanary);
  await patch(installation, { homeChannel: channel });
  const created = await call('jobs:create', { name: 'Remote source', prompt: 'Prepare the remote report.', at: new Date(Date.now() + 3600_000).toISOString() });
  await call('jobs:run', { id: created.id });
  await drain('brain:handleTurn');
  const job = await get(created.id), turn = (await rows('codexTurns')).find(row => row.conversationId === job.conversationId);
  await patch(turn._id, { runnerId: remoteRunner });
  assert.ok(await call('codex:claimTurn', { token: remoteToken, id: turn._id }));
  await call('media:shareFromTurn', { turnId: turn._id, path: remotePath });
  const storageId = snapshot ? await runtime.storeFile(new Blob([snapshotBytes], { type: 'text/plain' })) : undefined;
  await call('codex:finishTurn', { token: remoteToken, id: turn._id, response: 'Remote report prepared.', ...(snapshot ? { media: [{ storageId, localPath: remotePath, fileName: 'private-server-copy.txt', contentType: 'text/plain' }] } : {}) });
  if (legacyLocation) {
    const file = (await rows('chatAttachments')).find(row => row.conversationId === turn.conversationId && row.messageKey === `codex-${turn._id}`);
    await patch(file._id, { localPath: remotePath });
  }
  await call('codex:finalizeTurn', { id: turn._id });
  await drain('notify:deliver');
  return { receipt: (await rows('sent')).find(row => row.fromId === created.id), storageId };
};
const remoteReply = async (channel, snapshot = false) => {
  const externalId = channel === 'telegram' ? '42' : '100@s.whatsapp.net';
  await call('brain:handleTurn', { channel, externalId, text: 'Prepare and share the remote report.' });
  const chat = (await rows('conversations')).find(row => row.channel === channel && row.externalId === externalId);
  const turn = (await rows('codexTurns')).find(row => row.conversationId === chat._id && row.status === 'queued');
  assert.ok(turn);
  await patch(turn._id, { runnerId: remoteRunner });
  assert.ok(await call('codex:claimTurn', { token: remoteToken, id: turn._id }));
  await call('media:shareFromTurn', { turnId: turn._id, path: remotePath });
  const storageId = snapshot ? await runtime.storeFile(new Blob([snapshotBytes], { type: 'text/plain' })) : undefined;
  await call('codex:finishTurn', { token: remoteToken, id: turn._id, response: 'Remote reply prepared.', ...(snapshot ? { media: [{ storageId, localPath: remotePath, fileName: 'private-server-copy.txt', contentType: 'text/plain' }] } : {}) });
  await call('codex:finalizeTurn', { id: turn._id });
  return { turn: await get(turn._id), storageId };
};
try {
  installation = await insert('installation', { defaultEngine: 'codex', defaultAccess: 'full', onboarding: 'skipped', claimedAt: Date.now(), homeChannel: 'telegram', ownerChannel: 'telegram', ownerExternalId: '42', createdAt: Date.now() });
  runner = await insert('runners', { name: 'Synthetic runner', token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: 'codex', installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  writeFileSync(join(home, 'runner.json'), JSON.stringify({ token, url: base }));
  ownerChat = await insert('conversations', { threadId: await call('agentStore:createThread'), channel: 'telegram', externalId: '42', createdAt: Date.now() });
  heartbeatJob = await insert('jobs', { name: 'Heartbeat', prompt: 'Check useful signals.', builtin: 'heartbeat', enabled: true, schedule: '0 8 * * *', nextRunAt: Date.now() + 86400_000, createdAt: Date.now() });
  await check('first-use initiative and decision contexts are empty', async () => {
    assert.deepEqual((await call('initiative:context')).initiatives, []);
    assert.deepEqual((await call('taskDecisions:context', { jobId: heartbeatJob })).decisions, []);
  });
  let initiative, prepTurn;
  await check('concurrent equivalent source signals create exactly one preparation receipt', async () => {
    const a = await heartbeat(), b = await heartbeat();
    const attempts = await Promise.all([prepare(a, 'https://example.test/renewal?utm_source=mail&b=2&a=1#terms'), prepare(b, 'https://example.test/renewal?a=1&b=2')]);
    assert.equal(attempts.filter(row => row.started).length, 1);
    assert.equal(attempts[0].taskId, attempts[1].taskId);
    initiative = attempts[0].taskId;
    assert.equal((await get(initiative)).initiative.attempts.length, 1);
  });
  await check('preparation reaches the real runner with Ask and the immutable preparation boundary', async () => {
    prepTurn = await claimTask(initiative);
    assert.equal(prepTurn.preparation, true);
    assert.equal(prepTurn.access, 'supervised');
    const denied = await tool(prepTurn, 'queue_task', { title: 'Escape', prompt: 'Delegate preparation to another task.' });
    assert.ok(denied.result?.isError || denied.error, JSON.stringify(denied));
  });
  await check('real MCP preparation keeps its completed plan and concrete owner question', async () => {
    const plan = await tool(prepTurn, 'set_plan', { taskId: initiative, steps: [{ title: 'Compare verified terms', status: 'done' }, { title: 'Owner chooses draft', status: 'active' }] });
    assert.ok(!plan.result?.isError && !plan.error, JSON.stringify(plan));
    const finished = await tool(prepTurn, 'finish_task', { taskId: initiative, outcome: 'blocked', summary: 'Draft A costs 20; draft B costs 25. Choose the exact draft.' });
    assert.ok(!finished.result?.isError && !finished.error, JSON.stringify(finished));
    await call('codex:finishTurn', { token, id: prepTurn._id, response: 'Verified comparison and both drafts are ready.' });
    await call('codex:finalizeTurn', { id: prepTurn._id });
    const task = await get(initiative);
    assert.equal(task.status, 'blocked');
    assert.match(task.question, /Draft A costs 20/);
    assert.equal(task.plan[0].status, 'done');
  });
  await check('owner answer is accepted once and resumes the same task after SQLite restart', async () => {
    const task = await get(initiative), version = task.decision.version;
    await restart();
    const answers = await Promise.all([call('taskDecisions:fromPhone', { channel: 'telegram', senderId: '42', text: `/decision ${version} answer Use draft A only.` }), call('taskDecisions:fromPhone', { channel: 'telegram', senderId: '42', text: `/decision ${version} answer Use draft B.` })]);
    assert.equal(answers.filter(text => text.startsWith('Answered.')).length, 1);
    const fresh = await get(initiative);
    assert.equal(fresh.status, 'queued');
    assert.equal(fresh.conversationId, task.conversationId);
    assert.equal(fresh.plan[0].status, 'done');
    assert.match(fresh.answer, /exact proposal\/question/);
    assert.equal(fresh.decision, undefined);
  });
  await check('owner-directed work resumes under Ask and records the verified result once', async () => {
    const turn = await claimTask(initiative);
    assert.equal(turn.preparation, false);
    assert.equal(turn.access, 'supervised');
    assert.match(turn.prompt, /Draft A costs 20/);
    await call('work:setPlan', { taskId: initiative, plan: [{ title: 'Compare verified terms', status: 'done' }, { title: 'Owner chooses draft', status: 'done' }] });
    await call('codex:finishTurn', { token, id: turn._id, response: 'Draft A prepared as chosen. Verified current terms; no external action taken.' });
    await call('codex:finalizeTurn', { id: turn._id });
    await call('codex:finalizeTurn', { id: turn._id });
    const task = await get(initiative);
    assert.equal(task.status, 'done');
    assert.match(task.result, /Verified current terms/);
    assert.equal((await rows('taskHandoffs')).filter(row => row.taskId === initiative && row.outcome === 'done').length, 1);
  });
  await check('stopped and disabled Heartbeats cannot start work', async () => {
    const turnId = await heartbeat();
    await patch(turnId, { stopRequested: true });
    await assert.rejects(prepare(turnId, 'https://example.test/stopped'), /running, enabled Heartbeat/);
    await patch(turnId, { stopRequested: undefined });
    await patch(heartbeatJob, { enabled: false });
    await assert.rejects(prepare(turnId, 'https://example.test/disabled'), /running, enabled Heartbeat/);
    await patch(heartbeatJob, { enabled: true });
  });
  await check('snooze invalidates old controls and a held follow-up never leaks afterward', async () => {
    const task = await blocked(), turnId = await heartbeat(), before = report.telegram.length;
    await patch(installation, { quietHours: { start: '00:00', end: '23:59' } });
    assert.equal((await review(task, turnId)).status, 'queued');
    const receipt = (await get(task._id)).decision.deliveryId;
    await call('taskDecisions:snoozeFromDashboard', { key: process.env.DASHBOARD_KEY, id: task._id, version: task.decision.version, until: Date.now() + 3600_000 });
    const fresh = await get(task._id);
    assert.notEqual(fresh.decision.version, task.decision.version);
    assert.match(await call('taskDecisions:fromPhone', { channel: 'telegram', senderId: '42', text: `tq:${task._id}:${task.decision.version}:d` }), /already changed/);
    await patch(installation, { quietHours: undefined });
    await Promise.all([call('notify:releaseHeld'), call('notify:releaseHeld')]);
    assert.equal(report.telegram.length, before);
    assert.equal((await get(receipt)).deliveryState, 'failed');
    await assert.rejects(review(fresh, await heartbeat()), /snoozed/);
  });
  await check('stale dashboard snooze retains its actionable repair message over production HTTP', async () => {
    const task = await blocked();
    await call('work:updateTask', { taskId: task._id, status: 'blocked', question: 'The terms changed. Choose C or D.' });
    const result = await publicCall('taskDecisions:snoozeFromDashboard', { key: process.env.DASHBOARD_KEY, id: task._id, version: task.decision.version, until: Date.now() + 3600_000 });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.match(result.body.error, /question changed.*Refresh/i);
  });
  await check('stale dashboard answer retains its actionable repair message over production HTTP', async () => {
    const task = await blocked();
    await call('work:updateTask', { taskId: task._id, status: 'blocked', question: 'Choose the updated proposal.' });
    const result = await publicCall('tasks:answerFromDashboard', { key: process.env.DASHBOARD_KEY, id: task._id, decisionVersion: task.decision.version, answer: 'Choose the old proposal.' });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.match(result.body.error, /question changed.*Refresh/i);
  });
  await check('invalid dashboard snooze time explains how to repair it without changing the question', async () => {
    const task = await blocked();
    const result = await publicCall('taskDecisions:snoozeFromDashboard', { key: process.env.DASHBOARD_KEY, id: task._id, version: task.decision.version, until: Date.now() - 1 });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.match(result.body.error, /between a minute and 90 days/);
    assert.deepEqual((await get(task._id)).decision, task.decision);
  });
  await check('held follow-up survives restart and concurrent releases send it once', async () => {
    const task = await blocked(), before = report.telegram.length;
    await patch(installation, { quietHours: { start: '00:00', end: '23:59' } });
    await review(task, await heartbeat());
    const receipt = (await get(task._id)).decision.deliveryId;
    await restart();
    await patch(installation, { quietHours: undefined });
    await Promise.all([call('notify:releaseHeld'), call('notify:releaseHeld')]);
    assert.equal(report.telegram.length, before + 1);
    assert.equal((await get(receipt)).deliveryState, 'delivered');
  });
  await check('paired destination change refuses a held message before external IO', async () => {
    const task = await blocked(), before = report.telegram.length;
    await patch(installation, { quietHours: { start: '00:00', end: '23:59' } });
    await review(task, await heartbeat());
    const receipt = (await get(task._id)).decision.deliveryId;
    await patch(installation, { quietHours: undefined, ownerExternalId: '43' });
    await call('notify:releaseHeld');
    assert.equal(report.telegram.length, before);
    assert.equal((await get(receipt)).deliveryState, 'failed');
    await patch(installation, { ownerExternalId: '42' });
  });
  await check('withdrawal after external IO remains uncertain and is never replayed', async () => {
    const task = await blocked(), turnId = await heartbeat();
    let started, release;
    const began = new Promise(done => { started = done; });
    const wait = new Promise(done => { release = done; });
    releaseExternal = release;
    gate = { started, release: wait };
    pendingExternal = review(task, turnId);
    let deadline;
    await Promise.race([began, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('External delivery did not start')), 10_000); })]).finally(() => clearTimeout(deadline));
    const receipt = (await get(task._id)).decision.deliveryId;
    await call('taskDecisions:review', { id: task._id, version: task.decision.version, turnId, action: 'stop', reason: 'The owner no longer needs this follow-up.' });
    release();
    releaseExternal = undefined;
    assert.equal((await pendingExternal).status, 'uncertain');
    pendingExternal = undefined;
    const before = report.telegram.length;
    assert.equal((await get(receipt)).deliveryState, 'uncertain');
    await restart();
    await call('notify:releaseHeld');
    assert.equal(report.telegram.length, before);
  });
  await check('nonowner phone and task chat cannot answer a decision', async () => {
    const task = await blocked();
    assert.match(await call('taskDecisions:fromPhone', { channel: 'telegram', senderId: '77', text: `/decision ${task.decision.version} answer choose A` }), /Only the owner/);
    await assert.rejects(call('taskDecisions:update', { id: task._id, version: task.decision.version, drop: true, conversationId: (await get(initiative)).conversationId }), /Only the owner/);
    assert.equal((await get(task._id)).status, 'blocked');
  });
  await check('owner cancellation wins over late finish, answer and scheduled work', async () => {
    const task = await blocked();
    await call('taskDecisions:update', { id: task._id, version: task.decision.version, drop: true, conversationId: ownerChat });
    await assert.rejects(call('work:updateTask', { taskId: task._id, status: 'done', result: 'Late result' }), /cancelled/);
    assert.equal(await call('tasks:resume', { id: task._id, answer: 'Continue', decisionVersion: task.decision.version }), false);
    await restart();
    await call('tasks:work', { id: task._id });
    assert.equal((await get(task._id)).status, 'cancelled');
  });
  await check('paused goals hold decisions without sending and owner answers wait for resume', async () => {
    const task = await blocked(), goalId = await call('work:createGoal', { title: 'Renewal outcome', milestones: [] });
    await patch(task._id, { goalId });
    await patch(installation, { quietHours: { start: '00:00', end: '23:59' } });
    await review(task, await heartbeat());
    const receipt = (await get(task._id)).decision.deliveryId, before = report.telegram.length;
    await call('work:updateGoal', { id: goalId, status: 'paused' });
    await patch(installation, { quietHours: undefined });
    await call('notify:releaseHeld');
    assert.equal(report.telegram.length, before);
    assert.equal((await get(receipt)).deliveryState, 'held');
    assert.equal(await call('tasks:resume', { id: task._id, decisionVersion: task.decision.version, answer: 'Choose A' }), false);
    await call('work:updateGoal', { id: goalId, status: 'active' });
    assert.equal(await call('tasks:resume', { id: task._id, decisionVersion: task.decision.version, answer: 'Choose A' }), true);
    await call('notify:releaseHeld');
    assert.equal(report.telegram.length, before);
    assert.equal((await get(receipt)).deliveryState, 'failed');
    await call('work:updateTask', { taskId: task._id, status: 'done', result: 'Verified selected draft.' });
  });
  await check('expired approval becomes one exact decision and requires fresh approval on resume', async () => {
    const id = await insert('approvals', { runnerId: runner, conversationId: ownerChat, kind: 'command', title: 'Send exact renewal draft A', detail: 'Recipient: owner@example.test; price: 20.', status: 'expired', createdAt: Date.now() - 3600_000 });
    await Promise.all([call('taskDecisions:expiredApproval', { id }), call('taskDecisions:expiredApproval', { id })]);
    const tasks = (await rows('tasks')).filter(task => task.expiredApprovalId === id);
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].question, /Recipient: owner@example.test; price: 20/);
    const response = await call('taskDecisions:fromPhone', { channel: 'telegram', senderId: '42', text: `/decision ${tasks[0].decision.version} recheck` });
    assert.match(response, /^Answered/);
    const task = await get(tasks[0]._id);
    assert.equal(task.approvalRecheck, true);
    assert.match(task.answer, /NEW execution approval/);
    assert.equal((await get(id)).status, 'expired');
    await call('work:updateTask', { taskId: task._id, status: 'cancelled' });
  });
  await check('one-check, concurrent-active and rolling-day preparation budgets remain atomic', async () => {
    const first = await get(initiative);
    await assert.rejects(prepare(first.initiative.startedBy, 'https://example.test/same-check-second'), /at most one initiative/);
    const turns = await Promise.all([heartbeat(), heartbeat(), heartbeat()]);
    const attempts = await Promise.allSettled(turns.map((id, i) => prepare(id, `https://example.test/budget-${i}`)));
    assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 2);
    assert.match(attempts.find(row => row.status === 'rejected').reason.message, /Two autonomous tasks/);
    for (const row of attempts.filter(row => row.status === 'fulfilled')) await call('work:updateTask', { taskId: row.value.taskId, status: 'done', result: 'Prepared and verified.' });
    const fourth = await prepare(await heartbeat(), 'https://example.test/fourth');
    await call('work:updateTask', { taskId: fourth.taskId, status: 'done', result: 'Prepared and verified.' });
    await assert.rejects(prepare(await heartbeat(), 'https://example.test/fifth'), /four autonomous work sessions/);
    const task = await get(fourth.taskId);
    await patch(task._id, { initiative: { ...task.initiative, attempts: [Date.now() - 86400_001] } });
    const next = await prepare(await heartbeat(), 'https://example.test/rolling-next');
    assert.equal(next.started, true);
    await call('work:updateTask', { taskId: next.taskId, status: 'done', result: 'Prepared after rolling reset.' });
  });
  await check('text-only result recovery does not deliver or append the same run twice', async () => {
    const note = await call('notes:create', { key: process.env.DASHBOARD_KEY, title: 'Summary log', content: '' });
    const created = await call('jobs:create', { name: 'Text recovery', prompt: 'Prepare the daily summary.', at: new Date(Date.now() + 3600_000).toISOString(), noteId: note.id ?? note });
    await call('jobs:run', { id: created.id });
    await drain('brain:handleTurn');
    const job = await get(created.id), turn = (await rows('codexTurns')).find(row => row.conversationId === job.conversationId);
    assert.ok(await call('codex:claimTurn', { token, id: turn._id }));
    await call('codex:finishTurn', { token, id: turn._id, response: 'The verified daily summary.' });
    const originalMutation = runtime.runMutation.bind(runtime);
    runtime.runMutation = async (name, args, options) => {
      if (name === 'codex:markStep' && args.step === 'reportedAt') throw Error('Synthetic process interruption before report receipt');
      return originalMutation(name, args, options);
    };
    await assert.rejects(call('codex:finalizeTurn', { id: turn._id }), /Synthetic process interruption/);
    runtime.runMutation = originalMutation;
    // Reopen the persisted database at the exact action boundary rather than replaying a helper in memory.
    await restart();
    await patch(turn._id, { finalizingAt: Date.now() - 11 * 60_000 });
    await call('codex:finalizeTurn', { id: turn._id });
    await drain('notify:deliver');
    const receipts = (await rows('sent')).filter(row => row.fromId === job._id);
    const messages = report.telegram.filter(row => row.text?.includes('The verified daily summary.'));
    assert.equal(receipts.length, 1, `receipts=${receipts.length}, outbound=${messages.length}`);
    assert.equal(messages.length, 1);
    assert.equal((await get(note.id ?? note)).content.split('The verified daily summary.').length - 1, 1);
  });
  await check('failed remote snapshot never uploads a same-spelled server file to the owner', async () => {
    const before = report.telegram.length;
    const { receipt } = await remoteResult();
    assert.ok(!report.telegram.slice(before).some(row => row.multipart?.includes(serverCanary)), 'remote source uploaded server-only bytes');
    assert.equal(receipt.deliveryState, 'failed');
    assert.match(receipt.deliveryError, /private-server-copy.*source machine must upload a copy/);
  });
  await check('remote stored snapshot reaches Telegram without substituting server bytes', async () => {
    const before = report.telegram.length;
    const { receipt } = await remoteResult('telegram', true);
    const files = report.telegram.slice(before).filter(row => row.multipart);
    assert.equal(receipt.deliveryState, 'delivered');
    assert.equal(files.length, 1);
    assert.ok(files[0].multipart.includes(snapshotBytes));
    assert.ok(!files[0].multipart.includes(serverCanary));
  });
  await check('failed remote snapshot is refused before WhatsApp queues a local path', async () => {
    await patch(installation, { whatsappOwner: '100@s.whatsapp.net' });
    await insert('whatsappLink', { mode: 'separate', wanted: true, status: 'connected', updatedAt: Date.now() });
    const { receipt } = await remoteResult('whatsapp');
    assert.equal(receipt.deliveryState, 'failed');
    assert.match(receipt.deliveryError, /source machine must upload a copy/);
    assert.ok(!(await rows('whatsappOutbox')).some(row => row.notificationId === receipt._id || row.file?.localPath === remotePath));
  });
  await check('remote stored snapshot queues ordered WhatsApp delivery and awaits acknowledgement', async () => {
    const { receipt, storageId } = await remoteResult('whatsapp', true);
    const outbox = (await rows('whatsappOutbox')).filter(row => row.notificationId === receipt._id);
    assert.equal(receipt.deliveryState, 'sending');
    assert.equal(outbox.length, 2);
    assert.ok(outbox.some(row => row.kind === 'file' && row.file.storageId === storageId && !row.file.localPath));
    for (const row of outbox) await call('whatsapp:sent', { id: row._id });
    assert.equal((await get(receipt._id)).deliveryState, 'delivered');
  });
  await check('ordinary Telegram reply explains failed remote transfer without claiming a server location', async () => {
    const before = report.telegram.length;
    await remoteReply('telegram');
    const attempts = report.telegram.slice(before);
    assert.ok(!attempts.some(row => row.multipart?.includes(serverCanary)));
    const explanation = attempts.find(row => row.text?.includes('private-server-copy.txt'))?.text ?? '';
    assert.match(explanation, /source machine must upload a copy/);
    assert.ok(!explanation.includes(remotePath));
  });
  await check('ordinary WhatsApp reply refuses an unreadable remote file with actionable feedback', async () => {
    const key = process.env.DASHBOARD_KEY;
    for (const row of await call('whatsapp:pending')) await call('whatsapp:sent', { id: row._id });
    const before = new Set((await rows('whatsappOutbox')).map(row => row._id));
    const { turn } = await remoteReply('whatsapp');
    const attempts = (await rows('whatsappOutbox')).filter(row => !before.has(row._id));
    const file = attempts.find(row => row.kind === 'file');
    assert.ok(file, 'ordinary replies retain the immutable delivery journal');
    assert.equal(file.file.localPath, undefined); assert.equal(file.file.storageId, undefined);
    process.env.PERRY_WHATSAPP_DRIVER = fileURLToPath(new URL('../job-share-file/whatsapp-driver.mjs', import.meta.url));
    const driver = await import('../job-share-file/whatsapp-driver.mjs');
    const { runWhatsApp } = await import('../../server/whatsapp.ts');
    const sentBefore = driver.attempts.length, listeners = runtime.events.listenerCount('change');
    const stop = runWhatsApp(runtime);
    try {
      const deadline = Date.now() + 15_000;
      while (['pending', 'sending'].includes((await get(file._id)).state) && Date.now() < deadline) await delay(25);
      assert.equal((await get(file._id)).state, 'failed');
      assert.ok(driver.attempts.slice(sentBefore).every(row => row.name === 'text'), 'no destination file may receive the server canary');
      const finished = await get(turn._id);
      assert.match(finished.deliveryError, /private-server-copy\.txt.*not on this computer|source machine must upload a copy/);
      assert.ok(!finished.deliveryError.includes(remotePath));
      const notice = (await call('dashboard:getInbox', { key })).find(row => row.kind === 'delivery' && row.id === turn._id);
      assert.ok(notice, 'deferred failure remains visible on Board Updates');
      assert.match(notice.revision, /^[a-f0-9]{64}$/);
      const second = await insert('whatsappOutbox', { to: '100@s.whatsapp.net', kind: 'file', turnId: turn._id,
        file: { fileName: 'second-failure.txt', contentType: 'text/plain' }, state: 'sending', createdAt: Date.now(), attempts: 0 });
      await call('whatsapp:sent', { id: second, error: 'Synthetic second file failure', permanent: true });
      const changed = (await call('dashboard:getInbox', { key })).find(row => row.id === turn._id);
      assert.equal(changed.at, notice.at);
      assert.notEqual(changed.revision, notice.revision);
      assert.match(changed.text, /second-failure/);
      await call('dashboard:dismissInbox', { key, items: [{ kind: notice.kind, id: notice.id, at: notice.at, revision: notice.revision }] });
      assert.ok((await call('dashboard:getInbox', { key })).some(row => row.id === turn._id), 'stale warning A must not dismiss warning B at the same timestamp');
      await call('dashboard:dismissInbox', { key, items: [{ kind: changed.kind, id: changed.id, at: changed.at - 1, revision: changed.revision }] });
      assert.ok((await call('dashboard:getInbox', { key })).some(row => row.id === turn._id));
      await call('dashboard:dismissInbox', { key, items: [{ kind: changed.kind, id: changed.id, at: changed.at, revision: changed.revision }] });
      assert.ok(!(await call('dashboard:getInbox', { key })).some(row => row.id === turn._id));
      assert.match((await get(turn._id)).deliveryError, /second-failure/, 'acknowledgment keeps warning history');
    } finally { await stop(); }
    assert.equal(runtime.events.listenerCount('change'), listeners);
  });
  await check('notification warning revisions fence same-time aggregate changes and retain history', async () => {
    const key = process.env.DASHBOARD_KEY;
    const { receipt } = await remoteResult('whatsapp', true);
    const pending = (await rows('whatsappOutbox')).filter(row => row.notificationId === receipt._id);
    assert.equal(pending.length, 2);
    await call('whatsapp:sent', { id: pending[0]._id, error: 'Synthetic report failure', permanent: true });
    const first = (await call('dashboard:getInbox', { key })).find(row => row.id === receipt._id);
    assert.ok(first?.revision);
    await call('whatsapp:sent', { id: pending[1]._id, error: 'Synthetic attachment failure', permanent: true });
    const second = (await call('dashboard:getInbox', { key })).find(row => row.id === receipt._id);
    assert.equal(second.at, first.at);
    assert.notEqual(second.revision, first.revision);
    await call('dashboard:dismissInbox', { key, items: [{ kind: first.kind, id: first.id, at: first.at, revision: first.revision }] });
    assert.ok((await call('dashboard:getInbox', { key })).some(row => row.id === receipt._id));
    await patch(receipt._id, { deliveryText: 'Updated synthetic notification body' });
    const bodyChanged = (await call('dashboard:getInbox', { key })).find(row => row.id === receipt._id);
    assert.notEqual(bodyChanged.revision, second.revision);
    await call('dashboard:dismissInbox', { key, items: [{ kind: second.kind, id: second.id, at: second.at, revision: second.revision }] });
    assert.ok((await call('dashboard:getInbox', { key })).some(row => row.id === receipt._id));
    await call('dashboard:dismissInbox', { key, items: [{ kind: bodyChanged.kind, id: bodyChanged.id, at: bodyChanged.at, revision: bodyChanged.revision }] });
    assert.ok(!(await call('dashboard:getInbox', { key })).some(row => row.id === receipt._id));
    assert.match((await get(receipt._id)).deliveryError, /Could not send/, 'aggregate history survives dismissal');
    const lateFile = await insert('whatsappOutbox', { to: '100@s.whatsapp.net', kind: 'file', notificationId: receipt._id, file: { fileName: 'late-warning.txt', contentType: 'text/plain' }, state: 'sending', createdAt: Date.now(), attempts: 0 });
    await call('whatsapp:sent', { id: lateFile, error: 'Synthetic acknowledgment lost', uncertain: true });
    const renewed = (await call('dashboard:getInbox', { key })).find(row => row.id === receipt._id);
    assert.ok(renewed, 'a new aggregate warning reappears after the previous warning was acknowledged');
    assert.equal(renewed.at, bodyChanged.at);
    assert.notEqual(renewed.revision, bodyChanged.revision);
    assert.match(renewed.title, /unconfirmed/);
    await call('dashboard:dismissInbox', { key, items: [{ kind: bodyChanged.kind, id: bodyChanged.id, at: bodyChanged.at, revision: bodyChanged.revision }] });
    assert.ok((await call('dashboard:getInbox', { key })).some(row => row.id === receipt._id));
    await call('dashboard:dismissInbox', { key, items: [{ kind: renewed.kind, id: renewed.id, at: renewed.at, revision: renewed.revision }] });
    assert.ok(!(await call('dashboard:getInbox', { key })).some(row => row.id === receipt._id));
  });
  await check('remaining delivery sources reject stale revisions and keep older-client acknowledgments compatible', async () => {
    const key = process.env.DASHBOARD_KEY;
    const at = Date.now();
    const examples = [
      ['scheduledFailures', { scheduleId: 'synthetic-warning', functionName: 'fixture:delivery', state: 'failed', createdAt: at }, { state: 'uncertain' }],
      ['whatsappInbox', { key: 'synthetic-warning', account: 'fixture', remote: '100@s.whatsapp.net', messageId: 'fixture-warning', mode: 'separate', state: 'failed', createdAt: at, nextAt: at, attempts: 5, error: 'Synthetic intake failure A' }, { error: 'Synthetic intake failure B' }],
      ['whatsappOutbox', { to: '100@s.whatsapp.net', kind: 'text', text: 'Synthetic owner notification', state: 'failed', createdAt: at, attempts: 3, error: 'Synthetic send failure A' }, { state: 'uncertain', error: 'Synthetic send failure B' }],
    ];
    for (const [table, source, changed] of examples) {
      const id = await insert(table, source);
      const first = (await call('dashboard:getInbox', { key })).find(row => row.id === id);
      assert.match(first.revision, /^[a-f0-9]{64}$/);
      await patch(id, changed);
      const second = (await call('dashboard:getInbox', { key })).find(row => row.id === id);
      assert.equal(second.at, first.at);
      assert.notEqual(second.revision, first.revision);
      await call('dashboard:dismissInbox', { key, items: [{ kind: first.kind, id, at: first.at, revision: first.revision }] });
      assert.ok((await call('dashboard:getInbox', { key })).some(row => row.id === id), table);
      await call('dashboard:dismissInbox', { key, items: [{ kind: second.kind, id, at: second.at, revision: second.revision }] });
      assert.ok(!(await call('dashboard:getInbox', { key })).some(row => row.id === id), table);
      assert.ok(await get(id), 'history remains persisted');
      await patch(id, { seenAt: undefined });
      await call('dashboard:dismissInbox', { key, items: [{ kind: second.kind, id, at: second.at }] });
      assert.ok(!(await call('dashboard:getInbox', { key })).some(row => row.id === id), 'an older client may still acknowledge without a revision');
    }
  });
  await check('ordinary Telegram reply delivers the remote stored snapshot once', async () => {
    const before = report.telegram.length;
    const { turn } = await remoteReply('telegram', true);
    await call('codex:finalizeTurn', { id: turn._id });
    const files = report.telegram.slice(before).filter(row => row.multipart);
    assert.equal(files.length, 1);
    assert.ok(files[0].multipart.includes(snapshotBytes) && !files[0].multipart.includes(serverCanary));
  });
  await check('ordinary WhatsApp reply queues the remote stored snapshot once', async () => {
    const before = new Set((await rows('whatsappOutbox')).map(row => row._id));
    const { turn, storageId } = await remoteReply('whatsapp', true);
    await call('codex:finalizeTurn', { id: turn._id });
    const files = (await rows('whatsappOutbox')).filter(row => !before.has(row._id) && row.kind === 'file');
    assert.equal(files.length, 1);
    assert.equal(files[0].file.storageId, storageId);
    assert.equal(files[0].file.localPath, undefined);
  });
  await check('legacy stored-plus-remote locations resolve exclusively to the stored snapshot', async () => {
    const { receipt, storageId } = await remoteResult('whatsapp', true, true);
    const files = await call('notify:files', { ids: [receipt._id] });
    assert.equal(files.length, 1);
    assert.equal(files[0].storageId, storageId);
    assert.equal(files[0].localPath, undefined);
    const queued = (await rows('whatsappOutbox')).find(row => row.notificationId === receipt._id && row.kind === 'file');
    assert.equal(queued.file.storageId, storageId);
    assert.equal(queued.file.localPath, undefined);
  });
  await check('missing stored bytes never fall back to a legacy remote path in the real WhatsApp worker', async () => {
    for (const row of await call('whatsapp:pending')) await call('whatsapp:sent', { id: row._id });
    const { receipt, storageId } = await remoteResult('whatsapp', true, true);
    const file = (await rows('whatsappOutbox')).find(row => row.notificationId === receipt._id && row.kind === 'file');
    // Also cover an already persisted outbox row from before source normalization.
    await patch(file._id, { file: { ...file.file, localPath: remotePath } });
    unlinkSync(join(home, 'storage', storageId));
    process.env.PERRY_WHATSAPP_DRIVER = fileURLToPath(new URL('../job-share-file/whatsapp-driver.mjs', import.meta.url));
    const driver = await import('../job-share-file/whatsapp-driver.mjs');
    const { runWhatsApp } = await import('../../server/whatsapp.ts');
    const before = driver.attempts.length, listeners = runtime.events.listenerCount('change');
    const stop = runWhatsApp(runtime);
    try {
      const deadline = Date.now() + 15_000;
      while ((await get(file._id)).state === 'pending' && Date.now() < deadline) await delay(25);
      assert.equal((await get(file._id)).state, 'failed');
      assert.equal((await get(receipt._id)).deliveryState, 'failed');
      assert.ok(!driver.attempts.slice(before).some(row => row.name === serverCanary));
    } finally { await stop(); }
    assert.equal(runtime.events.listenerCount('change'), listeners);
    assert.ok(driver.sockets.every(socket => socket.ev.eventNames().length === 0));
  });
  report.passed = report.cases.every(row => row.passed);
} finally {
  releaseExternal?.();
  await pendingExternal?.catch(() => {});
  report.state = { tasks: await rows('tasks'), receipts: await rows('sent') };
  await runtime.stop();
  sql.close();
  await new Promise(done => server.close(done));
  globalThis.fetch = originalFetch;
  delete globalThis.__perry;
  assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep) && home.includes('perry-unattended-'));
  rmSync(home, { recursive: true, force: true });
  report.homeRemoved = !existsSync(home);
  save();
}
console.log(JSON.stringify({ passed: report.passed, homeRemoved: report.homeRemoved, cases: report.cases.map(({ name, passed, error }) => ({ name, passed, error })) }, null, 2));
if (!report.passed) process.exitCode = 1;
