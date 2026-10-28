// Read failure-cases.md before extending this audit replay.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { NextRequest } from 'next/server.js';

const out = resolve(import.meta.dirname);
const scratch = mkdtempSync(join(tmpdir(), 'perry-security-audit-'));
const home = join(scratch, 'home'); mkdirSync(home);
const key = 'synthetic-audit-owner-key';
const runnerToken = 'synthetic-audit-runner-token';
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = 'ca'.repeat(32);
delete process.env.TELEGRAM_BOT_TOKEN;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const parsed = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
  if (parsed.hostname !== '127.0.0.1') throw Error('External IO is disabled in this synthetic audit');
  return nativeFetch(url, options);
};
const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
  import('../../server/runtime.ts'), import('../../convex/schema.ts'), import('../../server/modules.ts'), import('../../server/credential-encryption.ts'),
]);
const sql = new DatabaseSync(join(home, 'perry.sqlite'));
initializeCredentialEncryption(sql, home);
const rt = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') });
// No scheduler, background integration, model, or installed Perry is started.
await rt.stop();
globalThis.__perry = { runtime: rt, started: true };
const [callRoute, adminRoute, uploadRoute, storageRoute, eventsRoute] = await Promise.all([
  import('../../app/api/backend/call/route.ts'), import('../../app/api/backend/admin/route.ts'),
  import('../../app/api/backend/storage/upload/route.ts'), import('../../app/api/backend/storage/[id]/route.ts'),
  import('../../app/api/backend/events/route.ts'),
]);
const checks = [];
const report = { commit: '75a07880cae2a29022960b61b8fa4057f6caab70', environment: { node: process.version, platform: process.platform },
  scope: 'Real application HTTP handlers and SQLite behind a loopback adapter; not Next.js deployment or provider E2E', checks };
const save = () => writeFileSync(join(out, 'baseline-replay-result.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, work) {
  try { const evidence = await work(); checks.push({ name, completed: true, ...evidence }); }
  catch (error) { checks.push({ name, completed: false, error: String(error) }); }
  save();
}
const server = createServer(async (incoming, outgoing) => {
  try {
    const body = []; for await (const chunk of incoming) body.push(chunk);
    const url = new URL(incoming.url, base);
    const request = new NextRequest(url, { method: incoming.method, headers: incoming.headers,
      ...(incoming.method === 'POST' ? { body: Buffer.concat(body) } : {}) });
    let response;
    if (url.pathname === '/api/backend/call') response = await callRoute.POST(request);
    else if (url.pathname === '/api/backend/admin') response = await adminRoute.POST(request);
    else if (url.pathname === '/api/backend/storage/upload') response = await uploadRoute.POST(request);
    else if (url.pathname.startsWith('/api/backend/storage/')) response = await storageRoute.GET(request, { params: Promise.resolve({ id: url.pathname.split('/').at(-1) }) });
    else if (url.pathname === '/seed') response = new Response(`<script>localStorage.setItem('perry.dashboard.key','${key}');location.href='${storedHtmlUrl}'</script>`, { headers: { 'content-type': 'text/html' } });
    else response = new Response('Not found', { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing); else outgoing.end();
  } catch { outgoing.writeHead(500); outgoing.end('Fixture adapter failure'); }
});
let base; let storedHtmlUrl;
await new Promise(done => server.listen(0, '127.0.0.1', done));
base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, args = {}, admin = false, headerKey = key) => {
  const response = await fetch(`${base}/api/backend/${admin ? 'admin' : 'call'}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-perry-key': headerKey } : {}) }, body: JSON.stringify({ path, args }) });
  return { status: response.status, body: await response.json() };
};
const owner = (path, args = {}) => post(path, { key, ...args });
const internal = async (path, args = {}) => {
  const response = await post(path, args, true); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.value;
};
let browserChild;
try {
  // Inventory all definitions without claiming that string matching proves their authorization.
  const definitions = Object.entries(modules).flatMap(([module, values]) => Object.entries(values)
    .filter(([, def]) => def?.perryFunction).map(([name, def]) => ({ name: `${module}:${name}`, kind: def.kind, visibility: def.visibility,
      authMarkers: ['assertDashboardKey', 'authenticate', 'ownedTurn', 'recordSession', 'asRunner'].filter(marker => def.handler.toString().includes(marker)),
      args: Object.keys(def.args?.fields ?? def.args ?? {}) })));
  writeFileSync(join(out, 'baseline-function-inventory-result.json'), JSON.stringify(definitions, null, 2) + '\n');
  await internal('installation:ensure');
  await internal('installation:setDefaultEngine', { engine: 'codex' });
  const runnerId = await internal('runner:createToken', { name: 'Synthetic runner', token: runnerToken });
  await rt.exclusive(() => rt.store.patch(runnerId, { codexAvailable: true, codexAuthMode: 'chatgpt', lastSeenAt: Date.now() }));

  await check('HTTP authorization and internal visibility', async () => {
    assert.equal((await owner('dashboard:listChats')).status, 200);
    const wrong = await post('dashboard:listChats', { key: 'wrong' }); assert.notEqual(wrong.status, 200);
    assert.equal((await post('installation:get')).status, 404);
    assert.equal((await post('installation:get', {}, true, 'wrong')).status, 403);
    assert.notEqual((await post('runner:checkIn', { token: 'wrong' })).status, 200);
    return { protectionPassed: true, wrongDashboardStatus: wrong.status };
  });
  const chatResponse = await owner('dashboard:createChat'); assert.equal(chatResponse.status, 200);
  const chatId = chatResponse.body.value;

  await check('One-use upload capability rejects concurrent replay', async () => {
    const ticketUrl = (await owner('dashboard:generateUploadUrl')).body.value;
    assert.equal(typeof ticketUrl, 'string');
    const results = await Promise.all([1, 2].map(() => fetch(base + ticketUrl, { method: 'POST', body: 'synthetic' }).then(r => r.status)));
    assert.deepEqual(results.toSorted(), [200, 403]);
    return { protectionPassed: true, statuses: results };
  });
  await check('Stored HTML response permits dashboard-origin script execution', async () => {
    const html = `<html><body><script>document.body.innerHTML=localStorage.getItem('perry.dashboard.key')==='${key}'?'<h1 id="audit-proof">origin-key-readable</h1>':'<h1>no-key</h1>'</script></body></html>`;
    const id = await rt.storeFile(new Blob([html], { type: 'text/html' })); storedHtmlUrl = rt.urlFor(id);
    const response = await fetch(base + storedHtmlUrl);
    const headers = Object.fromEntries(response.headers);
    assert.equal(response.status, 200); assert.match(headers['content-type'], /text\/html/);
    assert.equal(headers['content-disposition'], undefined); assert.equal(headers['content-security-policy'], undefined);
    const chrome = process.env.PERRY_E2E_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    let browserExecuted = null;
    if (existsSync(chrome)) {
      const profile = join(scratch, 'chrome');
      const result = await new Promise((done, reject) => {
        browserChild = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-sync',
          `--user-data-dir=${profile}`, '--dump-dom', '--timeout=10000', '--virtual-time-budget=2000', base + '/seed'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; browserChild.stdout.on('data', chunk => { stdout += chunk; });
        const timeout = setTimeout(() => { browserChild.kill(); reject(Error('Disposable Chrome timed out')); }, 20000);
        browserChild.on('error', error => { clearTimeout(timeout); reject(error); });
        browserChild.on('exit', () => { clearTimeout(timeout); done(stdout); });
      });
      browserExecuted = result.includes('<h1 id="audit-proof">origin-key-readable</h1>');
      assert.equal(browserExecuted, true);
    }
    return { findingConfirmed: true, anonymousStatus: response.status, headers, syntheticKeyReadableInChrome: browserExecuted };
  });
  await check('Invalid upload reads request body before validating its ticket', async () => {
    let consumed = false;
    const request = { nextUrl: new URL(base + '/api/backend/storage/upload?ticket=invalid'), headers: new Headers(),
      arrayBuffer: async () => { consumed = true; return new Uint8Array([1, 2, 3]).buffer; } };
    const response = await uploadRoute.POST(request);
    assert.equal(response.status, 403); assert.equal(consumed, true);
    return { findingConfirmed: true, bytesInProbe: 3, rejectedStatus: response.status, bodyReadBeforeRejection: consumed };
  });
  await check('Anonymous SSE connections have no handler quota; ordinary cancellation cleans up', async () => {
    const before = rt.events.listenerCount('change'); const connections = [];
    try {
      for (let n = 0; n < 12; n++) connections.push(await eventsRoute.GET(new Request(base + '/api/backend/events')));
      assert(connections.every(r => r.status === 200)); assert.equal(rt.events.listenerCount('change') - before, 12);
    } finally { await Promise.all(connections.map(r => r.body.cancel())); }
    assert.equal(rt.events.listenerCount('change'), before);
    return { findingConfirmed: true, acceptedAnonymousConnections: 12, ordinaryCancelCleanupPassed: true };
  });
  await check('Already-aborted SSE request still attaches a listener until explicit cancel', async () => {
    const before = rt.events.listenerCount('change'); const abort = new AbortController(); abort.abort();
    const response = await eventsRoute.GET(new Request(base + '/api/backend/events', { signal: abort.signal }));
    const retained = rt.events.listenerCount('change') - before;
    await response.body.cancel(); assert.equal(retained, 1); assert.equal(rt.events.listenerCount('change'), before);
    return { findingConfirmed: true, retainedListenersAfterPriorAbort: retained };
  });
  await check('File approval path traversal escapes an always-allow folder', async () => {
    const ruleId = await rt.exclusive(() => rt.store.insert('approvalRules', { runnerId, kind: 'file', pathPrefix: 'C:\\audit\\allowed', uses: 0, createdAt: Date.now() }));
    const escaped = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'synthetic edit only', paths: ['C:\\audit\\allowed\\..\\outside.txt'], conversationId: chatId });
    assert.equal(escaped.body.value.next, 'run');
    const row = await rt.exclusive(() => rt.store.get(escaped.body.value.id)); assert.equal(row.decidedBy, 'rule');
    const sibling = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'sibling control', paths: ['C:\\audit\\allowed-sibling\\x'], conversationId: chatId });
    assert.equal(sibling.body.value.next, 'ask');
    await rt.exclusive(() => rt.store.delete(ruleId));
    return { findingConfirmed: true, traversalDecision: row.status, traversalDecidedBy: row.decidedBy, siblingControl: 'ask', fileWritesPerformed: false };
  });
  await check('Concurrent owner approval decisions have one winner', async () => {
    const asked = (await post('approvals:request', { token: runnerToken, kind: 'command', title: 'echo synthetic', conversationId: chatId })).body.value;
    const results = await Promise.all([true, false].map(approved => owner('approvals:decide', { id: asked.id, approved })));
    assert.deepEqual(results.map(r => r.body.value).toSorted(), [false, true]);
    return { protectionPassed: true, winners: results.filter(r => r.body.value).length };
  });
  await check('Concurrent note saves reject a stale revision', async () => {
    const id = (await owner('notes:create', { title: 'Synthetic', content: 'original' })).body.value;
    const revision = await rt.exclusive(() => rt.store.get(id).revision);
    const results = await Promise.all(['one', 'two'].map(content => owner('notes:save', { id, content, expectedRevision: revision })));
    assert.deepEqual(results.map(r => r.body.value.ok).toSorted(), [false, true]);
    return { protectionPassed: true, winners: results.filter(r => r.body.value.ok).length };
  });
  await check('Duplicate chat submission with the same messageKey enqueues twice', async () => {
    const before = (await rt.exclusive(() => rt.store.all('codexTurns'))).length;
    const results = await Promise.all([1, 2].map(() => owner('dashboard:sendChat', { id: chatId, text: 'Synthetic replay; never execute', messageKey: 'fixed-audit-message-key' })));
    assert(results.every(r => r.status === 200), JSON.stringify(results));
    const added = (await rt.exclusive(() => rt.store.all('codexTurns'))).length - before;
    assert.equal(added, 2);
    return { findingConfirmed: true, identicalRequests: 2, durableTurnsAdded: added, enginesStarted: 0 };
  });
  await check('Atomic runner turn claim has one winner', async () => {
    const turnId = await rt.exclusive(() => rt.store.insert('codexTurns', { conversationId: chatId, runnerId, engine: 'codex', status: 'queued', prompt: 'synthetic', instructions: '', createdAt: Date.now() - 10000 }));
    const results = await Promise.all([1, 2].map(() => post('codex:claimTurn', { token: runnerToken, id: turnId })));
    assert(results.every(r => r.status === 200), JSON.stringify(results));
    assert.equal(results.filter(r => r.body.value).length, 1);
    return { protectionPassed: true, winners: 1 };
  });
  await check('Pet pairing is one-use and device removal revokes its key', async () => {
    const { code } = (await owner('pet:pair')).body.value;
    const paired = (await post('pet:redeem', { code, name: 'Synthetic pet' })).body.value;
    assert(paired.key); assert((await post('pet:redeem', { code, name: 'Replay' })).body.value.error);
    assert.equal((await post('dashboard:listChats', { key: paired.key })).status, 200);
    assert.equal((await post('notes:list', { key: paired.key })).status, 403);
    await owner('pet:removeDevice', { id: paired.device });
    assert.equal((await post('dashboard:listChats', { key: paired.key })).status, 403);
    return { protectionPassed: true };
  });
  await check('Generated SQLite indexes and query plans', async () => {
    const indexes = sql.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all();
    const queries = {
      runnerLookup: "SELECT * FROM doc_runners WHERE json_extract(doc, '$.token') IS 'synthetic' ORDER BY json_extract(doc, '$.token'), _creationTime LIMIT 1",
      turnQueue: "SELECT * FROM doc_codexTurns WHERE json_extract(doc, '$.runnerId') IS 'synthetic' AND json_extract(doc, '$.status') IS 'queued' ORDER BY json_extract(doc, '$.runnerId'), json_extract(doc, '$.status'), _creationTime LIMIT 20",
      scheduler: 'SELECT id,name,args FROM _scheduled WHERE runAt <= 0 ORDER BY runAt LIMIT 100',
    };
    const plans = Object.fromEntries(Object.entries(queries).map(([name, query]) => [name, sql.prepare('EXPLAIN QUERY PLAN ' + query).all()]));
    assert(Object.values(plans).every(rows => rows.some(row => /USING INDEX/.test(row.detail))));
    const uploadCleanupPlan = sql.prepare('EXPLAIN QUERY PLAN DELETE FROM _uploads WHERE ticket = ? OR expiresAt < ?').all('synthetic', Date.now());
    writeFileSync(join(out, 'baseline-indexes-result.json'), JSON.stringify({ indexes, queries, plans, uploadCleanupPlan, pragmas: { journalMode: sql.prepare('PRAGMA journal_mode').get(), synchronous: sql.prepare('PRAGMA synchronous').get() } }, null, 2) + '\n');
    return { protectionPassed: true, generatedIndexCount: indexes.length, plans };
  });
  await check('Chat deletion rollback restores metadata but loses stored file bytes', async () => {
    const id = (await owner('dashboard:createChat')).body.value;
    const fileId = await rt.storeFile(new Blob(['synthetic rollback bytes'], { type: 'text/plain' }));
    const attachmentId = await rt.exclusive(() => rt.store.insert('chatAttachments', { conversationId: id, messageKey: 'rollback', storageId: fileId,
      fileName: 'synthetic.txt', contentType: 'text/plain', size: 24, createdAt: Date.now() }));
    const originalDelete = rt.store.delete;
    rt.store.delete = function (target, ...rest) {
      if (target === id) throw Error('Synthetic late database failure after storage deletion');
      return originalDelete.call(this, target, ...rest);
    };
    let response;
    try { response = await owner('dashboard:deleteChat', { id }); }
    finally { rt.store.delete = originalDelete; }
    assert.equal(response.status, 500);
    assert(await rt.exclusive(() => rt.store.get(id))); assert(await rt.exclusive(() => rt.store.get(attachmentId)));
    assert(await rt.fileInfo(fileId)); assert.equal(existsSync(join(home, 'storage', fileId)), false);
    return { findingConfirmed: true, databaseRowsRolledBack: true, metadataRestored: true, fileBytesLost: true, injectedFailure: 'Store deletion of disposable conversation only' };
  });
  await check('Public fetch refuses private, loopback, mapped and reserved destinations', async () => {
    const { fetchPublic } = await import('../../convex/web.ts');
    const refused = [];
    for (const address of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f000001/', 'file:///synthetic', 'http://user:pass@example.com/']) {
      await assert.rejects(() => fetchPublic(address)); refused.push(address);
    }
    return { protectionPassed: true, refused, limitation: 'No DNS-rebinding or browser-fallback network replay' };
  });
  await check('Telegram ingestion failure still advances the update offset', async () => {
    const { pollTelegram } = await import('../../server/telegram.ts');
    const originalFetch = globalThis.fetch; let offset = null; let failures = 0; let finish;
    const complete = new Promise(done => { finish = done; });
    globalThis.fetch = async url => {
      const method = String(url).split('/').at(-1);
      return Response.json({ ok: true, result: method === 'getUpdates' ? [{ update_id: 456, message: {} }] : true });
    };
    const fixture = {
      runQuery: async () => ({ value: 'synthetic-bot-token' }),
      runAction: async () => { failures++; throw Error('Synthetic ingestion failure'); },
      kv: { get: async () => offset, set: async (_key, value) => { offset = value; stop(); finish(); } },
    };
    const stop = pollTelegram(fixture);
    try { await Promise.race([complete, delay(1000).then(() => { throw Error('Poll fixture timed out'); })]); }
    finally { stop(); globalThis.fetch = originalFetch; }
    assert.equal(failures, 1); assert.equal(offset, '457');
    return { findingConfirmed: true, ingestionFailures: failures, nextOffset: offset };
  });
} finally {
  browserChild?.kill();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
  await rt.stop(); sql.close(); delete globalThis.__perry; globalThis.fetch = nativeFetch;
  const target = resolve(scratch); assert(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'));
  try { rmSync(target, { recursive: true, force: true }); report.fixtureRemoved = true; }
  catch { report.fixtureRemoved = false; }
  report.completed = checks.every(check => check.completed); save();
}
console.log(JSON.stringify({ completed: report.completed, checks: checks.map(({ name, completed, error }) => ({ name, completed, ...(error ? { error } : {}) })) }, null, 2));
process.exitCode = report.completed ? 0 : 1;
