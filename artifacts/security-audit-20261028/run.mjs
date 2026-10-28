// Read failure-cases.md before extending this audit replay.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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
const report = { baselineCommit: '75a07880cae2a29022960b61b8fa4057f6caab70', checkedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform },
  scope: 'Real application HTTP handlers and SQLite behind a loopback adapter; not Next.js deployment or provider E2E', checks };
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
save();
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
  writeFileSync(join(out, 'function-inventory-result.json'), JSON.stringify(definitions, null, 2) + '\n');
  await internal('installation:ensure');
  await internal('installation:setDefaultEngine', { engine: 'codex' });
  const runnerId = await internal('runner:createToken', { name: 'Synthetic runner', token: runnerToken });
  await rt.exclusive(() => rt.store.patch(runnerId, { codexAvailable: true, codexAuthMode: 'chatgpt', lastSeenAt: Date.now() }));

  await check('HTTP authorization and internal visibility', async () => {
    assert.equal((await owner('dashboard:listChats')).status, 200);
    const wrong = await post('dashboard:listChats', { key: 'wrong' }); assert.equal(wrong.status, 401);
    assert.equal((await post('installation:get')).status, 404);
    assert.equal((await post('installation:get', {}, true, 'wrong')).status, 403);
    assert.equal((await post('runner:checkIn', { token: 'wrong' })).status, 401);
    return { protectionPassed: true, wrongDashboardStatus: wrong.status };
  });
  await check('Malformed calls and foreign browser origins are rejected', async () => {
    const malformed = await fetch(base + '/api/backend/call', { method: 'POST', body: 'null' });
    assert.equal(malformed.status, 400);
    const foreign = await fetch(base + '/api/backend/call', { method: 'POST', headers: { origin: 'https://foreign.invalid' }, body: JSON.stringify({ path: 'dashboard:listChats', args: { key } }) });
    assert.equal(foreign.status, 403);
    const local = await callRoute.POST(new NextRequest('http://localhost:7377/api/backend/call', {
      method: 'POST', headers: { host: '127.0.0.1:7377', origin: 'http://127.0.0.1:7377' },
      body: JSON.stringify({ path: 'dashboard:listChats', args: { key } }),
    }));
    assert.equal(local.status, 200);
    return { protectionPassed: true };
  });
  await check('Backend JSON streaming is capped without Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
    const request = new NextRequest(base + '/api/backend/call', { method: 'POST', body: stream, duplex: 'half' });
    const response = await callRoute.POST(request);
    assert.equal(response.status, 413); assert.equal(cancelled, true);
    return { protectionPassed: true, rejectedStatus: response.status };
  });
  await check('Backend admission is bounded and aborted requests release capacity', async () => {
    const aborts = []; const pending = [];
    try {
      for (let index = 0; index < 16; index++) {
        const abort = new AbortController(); aborts.push(abort);
        const body = new ReadableStream({ start() {} });
        pending.push(callRoute.POST(new NextRequest(base + '/api/backend/call', { method: 'POST', body, duplex: 'half', signal: abort.signal })));
      }
      const refused = await callRoute.POST(new NextRequest(base + '/api/backend/call', { method: 'POST', body: '{}' }));
      assert.equal(refused.status, 429);
    } finally { for (const abort of aborts) abort.abort(); await Promise.all(pending); }
    assert.equal((await owner('dashboard:listChats')).status, 200);
    return { protectionPassed: true, concurrentLimit: 16 };
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
  await check('Stored HTML downloads without dashboard-origin script execution', async () => {
    const html = `<html><body><script>document.body.innerHTML=localStorage.getItem('perry.dashboard.key')==='${key}'?'<h1 id="audit-proof">origin-key-readable</h1>':'<h1>no-key</h1>'</script></body></html>`;
    const id = await rt.storeFile(new Blob([html], { type: 'text/html' })); storedHtmlUrl = rt.urlFor(id);
    const response = await fetch(base + storedHtmlUrl);
    const headers = Object.fromEntries(response.headers);
    assert.equal(response.status, 200); assert.match(headers['content-type'], /application\/octet-stream/);
    assert.match(headers['content-disposition'], /^attachment/);
    assert.match(headers['content-security-policy'], /sandbox/);
    assert.equal(headers['x-content-type-options'], 'nosniff');
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
      assert.equal(browserExecuted, false);
    }
    return { protectionPassed: true, anonymousStatus: response.status, headers, syntheticKeyReadableInChrome: browserExecuted };
  });
  await check('Active MIME variants download while media retains byte-range support', async () => {
    for (const type of ['image/svg+xml; charset=utf-8', 'application/xhtml+xml', 'application/xml', 'text/xml']) {
      const id = await rt.storeFile(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type }));
      const response = await fetch(base + rt.urlFor(id));
      assert.match(response.headers.get('content-disposition'), /^attachment/);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    }
    const id = await rt.storeFile(new Blob(['0123456789'], { type: 'audio/ogg' }));
    const response = await fetch(base + rt.urlFor(id), { headers: { range: 'bytes=2-4' } });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-disposition'), /^inline/);
    assert.equal(await response.text(), '234');
    return { protectionPassed: true, activeVariants: 4, mediaRanges: true };
  });
  await check('Oversized declared uploads do not consume their one-use capability', async () => {
    const upload = (await owner('dashboard:generateUploadUrl')).body.value;
    const request = new NextRequest(base + upload, { method: 'POST', headers: { 'content-length': String(50 * 1024 * 1024 + 1) }, body: 'tiny' });
    assert.equal((await uploadRoute.POST(request)).status, 413);
    const response = await fetch(base + upload, { method: 'POST', body: 'small accepted upload' });
    assert.equal(response.status, 200);
    return { protectionPassed: true, rejectedStatus: 413, retryStatus: 200 };
  });
  await check('A large-upload stream may finish beyond the JSON body deadline', async () => {
    const upload = (await owner('dashboard:generateUploadUrl')).body.value;
    let timer;
    const stream = new ReadableStream({ start(controller) {
      timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('slow synthetic upload')); controller.close(); }, 31_000);
    }, cancel() { clearTimeout(timer); } });
    const request = new NextRequest(base + upload, { method: 'POST', body: stream, duplex: 'half' });
    try { assert.equal((await uploadRoute.POST(request)).status, 200); }
    finally { clearTimeout(timer); }
    return { protectionPassed: true, nativeDelayMs: 31_000 };
  });
  await check('Invalid uploads are rejected before consuming the body', async () => {
    let consumed = false;
    const request = { nextUrl: new URL(base + '/api/backend/storage/upload?ticket=invalid'), headers: new Headers(),
      arrayBuffer: async () => { consumed = true; return new Uint8Array([1, 2, 3]).buffer; } };
    const response = await uploadRoute.POST(request);
    assert.equal(response.status, 403); assert.equal(consumed, false);
    return { protectionPassed: true, bytesInProbe: 3, rejectedStatus: response.status, bodyReadBeforeRejection: consumed };
  });
  await check('SSE connections are bounded and ordinary cancellation cleans up', async () => {
    const before = rt.events.listenerCount('change'); const connections = [];
    try {
      for (let n = 0; n < 40; n++) connections.push(await eventsRoute.GET(new Request(base + '/api/backend/events')));
      assert.equal(connections.filter(r => r.status === 200).length, 32 - before);
      assert(connections.some(r => r.status === 429)); assert.equal(rt.events.listenerCount('change'), 32);
    } finally { await Promise.all(connections.map(r => r.body.cancel())); }
    assert.equal(rt.events.listenerCount('change'), before);
    return { protectionPassed: true, maximumListeners: 32, ordinaryCancelCleanupPassed: true };
  });
  await check('An already-aborted SSE request attaches no resources', async () => {
    const before = rt.events.listenerCount('change'); const abort = new AbortController(); abort.abort();
    const response = await eventsRoute.GET(new Request(base + '/api/backend/events', { signal: abort.signal }));
    const retained = rt.events.listenerCount('change') - before;
    await response.body?.cancel(); assert.equal(retained, 0); assert.equal(rt.events.listenerCount('change'), before);
    return { protectionPassed: true, retainedListenersAfterPriorAbort: retained };
  });
  await check('An unread SSE stream cannot accumulate an unbounded buffer', async () => {
    const before = rt.events.listenerCount('change');
    const response = await eventsRoute.GET(new Request(base + '/api/backend/events'));
    for (let index = 0; index < 1000; index++) rt.events.emit('change', ['synthetic-table-name-'.repeat(8)]);
    assert.equal(rt.events.listenerCount('change'), before);
    const reader = response.body.getReader(); let bytes = 0;
    while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; }
    reader.releaseLock();
    assert(bytes <= 64 * 1024);
    return { protectionPassed: true, bufferedBytes: bytes, maximumBytes: 64 * 1024 };
  });
  await check('File approval rules reject traversal and unverified paths', async () => {
    const ruleId = await rt.exclusive(() => rt.store.insert('approvalRules', { runnerId, kind: 'file', pathPrefix: 'C:\\audit\\allowed', uses: 0, createdAt: Date.now() }));
    const escaped = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'synthetic edit only', paths: ['C:\\audit\\allowed\\..\\outside.txt'], pathsVerified: true, conversationId: chatId });
    assert.equal(escaped.body.value.next, 'ask');
    const row = await rt.exclusive(() => rt.store.get(escaped.body.value.id)); assert.notEqual(row.decidedBy, 'rule');
    const unverified = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'legacy unresolved path', paths: ['C:\\audit\\allowed\\ok.txt'], conversationId: chatId });
    assert.equal(unverified.body.value.next, 'ask');
    const verified = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'resolved path', paths: ['C:\\audit\\allowed\\ok.txt'], pathsVerified: true, conversationId: chatId });
    assert.equal(verified.body.value.next, 'run');
    const sibling = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'sibling control', paths: ['C:\\audit\\allowed-sibling\\x'], conversationId: chatId });
    assert.equal(sibling.body.value.next, 'ask');
    await rt.exclusive(() => rt.store.delete(ruleId));
    return { protectionPassed: true, traversalDecision: row.status, unverifiedDecision: 'ask', verifiedDecision: 'run', siblingControl: 'ask', fileWritesPerformed: false };
  });
  await check('Network-share approvals require a subdirectory', async () => {
    const root = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'share-root control', paths: ['\\\\synthetic-server\\share\\file.txt'], pathsVerified: true });
    const narrow = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'share-directory control', paths: ['\\\\synthetic-server\\share\\project\\file.txt'], pathsVerified: true });
    const rows = await rt.exclusive(() => [rt.store.get(root.body.value.id), rt.store.get(narrow.body.value.id)]);
    assert.equal(rows[0].alwaysAllow, undefined);
    assert.equal(rows[1].alwaysAllow.pathPrefix.replaceAll('\\', '/'), '//synthetic-server/share/project');
    return { protectionPassed: true, shareRootOffered: false, subdirectoryOffered: true };
  });
  await check('Runner filesystem resolution refuses symlink-parent ambiguity', async () => {
    const { approvalPath } = await import('../../runner/approval-path.ts');
    const allowed = join(scratch, 'allowed'); const outside = join(scratch, 'outside');
    mkdirSync(allowed); mkdirSync(join(outside, 'deep'), { recursive: true });
    symlinkSync(join(outside, 'deep'), join(allowed, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const rule = await rt.exclusive(() => rt.store.insert('approvalRules', { runnerId, kind: 'file', pathPrefix: allowed, uses: 0, createdAt: Date.now() }));
    try {
      const raw = join(allowed, 'link') + sep + '..' + sep + 'secret';
      assert.equal(approvalPath(raw), undefined);
      const canonical = approvalPath(join(allowed, 'link', 'new-file'));
      assert.equal(canonical, join(approvalPath(join(outside, 'deep')), 'new-file'));
      const ambiguous = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'ambiguous path control', paths: [raw], pathsVerified: false });
      const escaped = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'canonical outside control', paths: [canonical], pathsVerified: true });
      const inside = approvalPath(join(allowed, 'new-file'));
      const accepted = await post('approvals:request', { token: runnerToken, kind: 'file', title: 'canonical inside control', paths: [inside], pathsVerified: true });
      assert.equal(ambiguous.body.value.next, 'ask'); assert.equal(escaped.body.value.next, 'ask'); assert.equal(accepted.body.value.next, 'run');
      return { protectionPassed: true, actualFilesystemLink: true, ambiguousDecision: 'ask', outsideDecision: 'ask', insideDecision: 'run' };
    } finally { await rt.exclusive(() => rt.store.delete(rule)); }
  });
  await check('A lost write acknowledgement exposes an unknown outcome without replay', async () => {
    const { BackendClient, WriteOutcomeUnknownError } = await import('../../client/backend.ts');
    const client = new BackendClient(base); let sent = 0;
    const before = await rt.exclusive(() => rt.store.all('conversations').length);
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const response = await previous(url, options); sent++;
      assert.equal(response.status, 200); await response.arrayBuffer();
      throw new DOMException('Synthetic response lost after commit', 'TimeoutError');
    };
    try { await assert.rejects(client.mutation('dashboard:createChat', { key }), error => error instanceof WriteOutcomeUnknownError && error.outcome === 'unknown'); }
    finally { globalThis.fetch = previous; client.close(); }
    assert.equal(sent, 1);
    assert.equal(await rt.exclusive(() => rt.store.all('conversations').length), before + 1);
    return { protectionPassed: true, committedWrites: 1, transportAttempts: sent, reportedOutcome: 'unknown' };
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
    writeFileSync(join(out, 'indexes-result.json'), JSON.stringify({ indexes, queries, plans, uploadCleanupPlan, pragmas: { journalMode: sql.prepare('PRAGMA journal_mode').get(), synchronous: sql.prepare('PRAGMA synchronous').get() } }, null, 2) + '\n');
    return { protectionPassed: true, generatedIndexCount: indexes.length, plans };
  });
  await check('Chat deletion rollback preserves metadata and stored file bytes', async () => {
    await rt.exclusive(() => sql.exec('DELETE FROM _scheduled'));
    const id = (await owner('dashboard:createChat')).body.value;
    const fileId = await rt.storeFile(new Blob(['synthetic rollback bytes'], { type: 'text/plain' }));
    const attachmentId = await rt.exclusive(() => rt.store.insert('chatAttachments', { conversationId: id, messageKey: 'rollback', storageId: fileId,
      fileName: 'synthetic.txt', contentType: 'text/plain', size: 24, createdAt: Date.now() }));
    const definition = rt.registry.get('dashboard:deleteChat');
    const originalHandler = definition.handler;
    let tick;
    definition.handler = async (ctx, args) => {
      await originalHandler(ctx, args);
      // Let a real scheduler tick run while the mutation has not committed.
      rt.stopped = false;
      tick = rt.tick();
      await new Promise(done => setTimeout(done, 10));
      assert.equal(existsSync(join(home, 'storage', fileId)), true);
      throw Error('Synthetic failure before delete-chat commit');
    };
    let response;
    try { response = await owner('dashboard:deleteChat', { id }); }
    finally { definition.handler = originalHandler; await tick; await rt.stop(); }
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM _scheduled').get().n, 0);
    assert.equal(response.status, 500);
    assert(await rt.exclusive(() => rt.store.get(id))); assert(await rt.exclusive(() => rt.store.get(attachmentId)));
    assert(await rt.fileInfo(fileId)); assert.equal(existsSync(join(home, 'storage', fileId)), true);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM _file_deletions WHERE id = ?').get(fileId).n, 0);
    return { protectionPassed: true, databaseRowsRolledBack: true, metadataRestored: true, fileBytesLost: false, concurrentSweeperWaited: true, injectedFailure: 'Disposable delete-chat handler before commit only' };
  });
  await check('An interrupted post-commit unlink is recovered on Runtime restart', async () => {
    const id = (await owner('dashboard:createChat')).body.value;
    const fileId = await rt.storeFile(new Blob(['synthetic committed bytes'], { type: 'text/plain' }));
    await rt.exclusive(() => rt.store.insert('chatAttachments', { conversationId: id, messageKey: 'commit', storageId: fileId,
      fileName: 'committed.txt', contentType: 'text/plain', size: 25, createdAt: Date.now() }));
    const collect = rt.collectDeletedFiles;
    rt.collectDeletedFiles = () => {};
    try { assert.equal((await owner('dashboard:deleteChat', { id })).status, 200); }
    finally { rt.collectDeletedFiles = collect; }
    assert.equal(await rt.fileInfo(fileId), null);
    assert.equal(existsSync(join(home, 'storage', fileId)), true);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM _file_deletions WHERE id = ?').get(fileId).n, 1);
    const restarted = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') });
    await restarted.stop();
    assert.equal(existsSync(join(home, 'storage', fileId)), false);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM _file_deletions WHERE id = ?').get(fileId).n, 0);
    return { protectionPassed: true, durableUnlinkRecovered: true };
  });
  await check('Action storage deletion rolls back if its tombstone cannot be inserted', async () => {
    const id = await rt.storeFile(new Blob(['action-delete-fixture']));
    rt.registry.set('security:deleteStoredFile', { perryFunction: true, kind: 'action', visibility: 'internal', handler: (ctx, args) => ctx.storage.delete(args.id) });
    await rt.exclusive(() => sql.exec("CREATE TEMP TRIGGER synthetic_fail_tombstone BEFORE INSERT ON _file_deletions BEGIN SELECT RAISE(ABORT, 'synthetic tombstone failure'); END"));
    try { await assert.rejects(rt.runAction('security:deleteStoredFile', { id }, { internal: true }), /synthetic tombstone failure/); }
    finally { await rt.exclusive(() => sql.exec('DROP TRIGGER synthetic_fail_tombstone')); }
    assert(await rt.fileInfo(id)); assert.equal(existsSync(join(home, 'storage', id)), true);
    await rt.runAction('security:deleteStoredFile', { id }, { internal: true });
    assert.equal(await rt.fileInfo(id), null); assert.equal(existsSync(join(home, 'storage', id)), false);
    return { protectionPassed: true, rollbackPreservedFile: true, successfulRetryDeletedFile: true };
  });
  await check('Repeated unlink failures do not starve later files', async () => {
    const blocked = Array.from({ length: 100 }, (_, i) => 'blocked-' + String(i).padStart(8, '0'));
    try {
      await rt.exclusive(() => {
        for (const [index, id] of blocked.entries()) {
          mkdirSync(join(home, 'storage', id));
          sql.prepare('INSERT INTO _file_deletions (id, createdAt) VALUES (?, ?)').run(id, index);
        }
      });
      const id = await rt.storeFile(new Blob(['removable-file']));
      await rt.runAction('security:deleteStoredFile', { id }, { internal: true });
      assert.equal(existsSync(join(home, 'storage', id)), true);
      await rt.exclusive(() => rt.collectDeletedFiles());
      assert.equal(existsSync(join(home, 'storage', id)), false);
      return { protectionPassed: true, blockedEntries: 100, laterFileRemoved: true };
    } finally {
      for (const id of blocked) if (existsSync(join(home, 'storage', id))) rmdirSync(join(home, 'storage', id));
      await rt.exclusive(() => rt.collectDeletedFiles());
    }
  });
  await check('File import serializes bytes and metadata with pending cleanup', async () => {
    for (const sweepFirst of [false, true]) {
      const id = await rt.storeFile(new Blob(['old import bytes']));
      await rt.exclusive(() => rt.deleteFileInTx(id));
      rmSync(join(home, 'storage', id));
      let release; let entered;
      const ready = new Promise(done => { entered = done; });
      const blocker = rt.exclusive(() => { entered(); return new Promise(done => { release = done; }); });
      await ready;
      const sweep = () => rt.exclusive(() => rt.collectDeletedFiles());
      const operations = [];
      try {
        if (sweepFirst) operations.push(sweep());
        operations.push(rt.importFile(id, Buffer.from('restored import bytes'), 'text/plain', Date.now()));
        assert.equal(existsSync(join(home, 'storage', id)), false);
        if (!sweepFirst) operations.push(sweep());
      } finally { release(); await blocker; await Promise.all(operations); }
      assert(await rt.fileInfo(id));
      assert.equal(readFileSync(join(home, 'storage', id), 'utf8'), 'restored import bytes');
    }
    return { protectionPassed: true, importFirstAndSweepFirstPassed: true, noFilesystemWriteBeforeQueue: true };
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
