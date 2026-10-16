import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const scratch = fileURLToPath(new URL('.', import.meta.url));
process.env.PERRY_HOME = scratch + 'synthetic-home';
process.env.DASHBOARD_KEY = 'synthetic-only';
process.env.TEMP = process.env.TMP = scratch;
// No Runtime/bootstrap import. Every fetch is intercepted, including events.
const { BackendClient } = await import('../../../client/backend.ts');
const clients = [];
const reports = [];
const history = 'dashboard:getChatMessages';
const args = (id, key = 'synthetic-only', size = 50) => ({ key, id, paginationOpts: { numItems: size, cursor: null } });
const page = (text, extra = {}) => ({ page: [{ id: 'message', role: 'assistant', text, createdAt: 1, attachments: [], ...extra }], isDone: true, continueCursor: '' });
const fixtures = new Map();
const calls = [];
let outstanding = 0, maxOutstanding = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
globalThis.fetch = async (url, options = {}) => {
  assert.ok(String(url).startsWith('https://fixture.invalid/api/backend/'), 'blocked unexpected network');
  if (String(url).endsWith('/events')) return new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('fake stream aborted')), { once: true });
  });
  const body = JSON.parse(options.body);
  calls.push(body);
  outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
  try {
    const fixture = fixtures.get(body.args.id) ?? (() => ({ value: page('saved:' + body.args.id), reads: ['conversations', 'messages', 'vault', 'secrets'] }));
    const result = await fixture(body);
    if (result instanceof Error) throw result;
    return Response.json(result.body ?? result, { status: result.status ?? 200 });
  } finally { outstanding--; }
};
const client = () => { const c = new BackendClient('https://fixture.invalid'); clients.push(c); return c; };
async function visit(c, id, input = args(id)) {
  const stop = c.subscribe(history, input, () => {});
  await tick();
  assert.equal(c.snapshot(history, input).loaded, true);
  stop();
}
try {
  const c = client();
  await visit(c, 'a');
  const saved = c.snapshot(history, args('a')).value;
  assert.equal(saved.page[0].text, 'saved:a');
  const before = calls.length;
  let release;
  fixtures.set('a', () => new Promise(resolve => { release = resolve; }));
  const stop = c.subscribe(history, args('a'), () => {});
  assert.equal(c.snapshot(history, args('a')).value, saved, 'first synchronous read uses saved page');
  assert.equal(calls.length, before + 1, 'revisit still fetches fresh data');
  release({ value: saved, reads: ['messages', 'vault', 'secrets'] }); await tick();
  assert.equal(c.snapshot(history, args('a')).value, saved, 'identical response preserves identity');
  fixtures.set('a', () => ({ value: page('fresh:a'), reads: ['messages', 'vault', 'secrets'] }));
  await c.refresh(['messages']);
  assert.equal(c.snapshot(history, args('a')).value.page[0].text, 'fresh:a');
  assert.equal(c.snapshot(history, args('b')).loaded, false);
  assert.equal(c.snapshot(history, args('a', 'other-key')).loaded, false);
  const other = client();
  assert.equal(other.snapshot(history, args('a')).loaded, false);
  reports.push('navigation: synchronous saved page, fresh replacement, stable equal identity, chat/key/client isolation');
  // Active secret change removes previous paint before the new response.
  fixtures.set('a', () => new Promise(resolve => { release = resolve; }));
  const refresh = c.refresh(['vault']);
  assert.equal(c.snapshot(history, args('a')).loaded, false);
  assert.equal(c.snapshot(history, args('a')).value, undefined);
  release({ value: page('[redacted]'), reads: ['messages', 'vault'] }); await refresh;
  assert.equal(c.snapshot(history, args('a')).value.page[0].text, '[redacted]');
  const confirmed = c.snapshot(history, args('a')).value;
  fixtures.set('a', () => new TypeError('fake offline'));
  await c.refresh(['messages']);
  assert.equal(c.snapshot(history, args('a')).value, confirmed, 'transport failure keeps active confirmed history');
  reports.push('transport: transient network error preserves active confirmed history');
  stop();
  await c.refresh(['messages']);
  assert.equal(c.snapshot(history, args('a')).loaded, false, 'inactive write evicts');
  reports.push('invalidation: active vault redact-before-reload and inactive dependent writes evict');
  // In-flight result from a locked session cannot return to the cache.
  let resolveLocked;
  fixtures.set('locked', () => new Promise(resolve => { resolveLocked = resolve; }));
  const stopLocked = c.subscribe(history, args('locked'), () => {});
  c.clearChatCache();
  resolveLocked({ value: page('old session'), reads: ['messages'] }); await tick();
  assert.equal(c.snapshot(history, args('locked')).value, undefined);
  stopLocked();
  await visit(c, 'revoked');
  fixtures.set('revocation', () => ({ status: 500, body: { error: 'Wrong dashboard key.' } }));
  await assert.rejects(c.call('dashboard:getStatus', { id: 'revocation', key: 'synthetic-only' }));
  assert.equal(c.snapshot(history, args('revoked')).loaded, false);
  reports.push('session/auth: synchronous clear ignores late success; actual key-error response purges history');
  // A prefetch keeps a dummy listener through lock/unlock; a new same-key
  // screen must request a post-invalidation result rather than wait forever.
  let releaseSessionPrefetch, sessionFetches = 0;
  fixtures.set('session-prefetch', () => {
    sessionFetches++;
    return sessionFetches === 1
      ? new Promise(resolve => { releaseSessionPrefetch = resolve; })
      : { value: page('new session'), reads: ['messages'] };
  });
  c.scheduleChatPrefetch('synthetic-only', 'session-prefetch'); await pause(180);
  c.clearChatCache(); // lock
  c.clearChatCache(); // unlock with the same key
  const stopNewSession = c.subscribe(history, args('session-prefetch'), () => {});
  releaseSessionPrefetch({ value: page('old prefetched session'), reads: ['messages'] }); await tick();
  assert.equal(c.snapshot(history, args('session-prefetch')).value?.page[0].text, 'new session', 'same-key session reattach fetches after invalidation');
  assert.equal(sessionFetches, 2);
  stopNewSession();
  reports.push('same-key session race: reattach during invalidated prefetch fetches current result and ignores old result');
  // Related tool/stream/metadata text is session-scoped and not an idle cache.
  for (const name of ['dashboard:getChat', 'dashboard:getChatWork', 'turnStreams:getChatStream']) {
    let releasePayload;
    let text = 'sensitive old payload';
    fixtures.set('payload', () => ({ value: { text }, reads: ['messages'] }));
    const payloadArgs = { key: 'synthetic-only', id: 'payload' };
    const stopPayload = c.subscribe(name, payloadArgs, () => {}); await tick();
    fixtures.set('payload', () => new Promise(resolve => { releasePayload = resolve; }));
    const redact = c.refresh(['secrets']);
    assert.equal(c.snapshot(name, payloadArgs).value, undefined, name + ' clears immediately for secrets');
    releasePayload({ value: { text: '[redacted]' }, reads: ['messages'] }); await redact;
    assert.equal(c.snapshot(name, payloadArgs).value.text, '[redacted]');
    c.clearChatCache();
    assert.equal(c.snapshot(name, payloadArgs).value, undefined, name + ' clears for session');
    stopPayload();
    assert.equal(c.snapshot(name, payloadArgs).loaded, false, name + ' has no idle cache');
  }
  reports.push('related chat payloads: metadata/work/live-stream clear on secret/session invalidation and never retain idle text');
  // Resource limits/eligibility through actual client subscription lifetimes.
  for (let i = 0; i < 35; i++) await visit(c, 'bound-' + i);
  const retained = [...c.subscriptions.values()].filter(s => s.idleAt !== undefined && s.name === history);
  assert.ok(retained.length <= 30); assert.equal(c.snapshot(history, args('bound-0')).loaded, false);
  for (let i = 0; i < 30; i++) {
    fixtures.set('bytes-' + i, () => ({ value: page('x'.repeat(100_000)), reads: ['messages'] }));
    await visit(c, 'bytes-' + i);
  }
  const total = [...c.subscriptions.values()].filter(s => s.idleAt !== undefined).reduce((n, s) => n + (s.retainedBytes ?? 0), 0);
  assert.ok(total <= 4 * 1024 * 1024);
  for (const [id, value] of [['oversized', page('x'.repeat(160_000))], ['pending', page('queued', { pending: true })], ['partial', page('half', { status: 'streaming' })]]) {
    fixtures.set(id, () => ({ value, reads: ['messages'] })); await visit(c, id);
    assert.equal(c.snapshot(history, args(id)).loaded, false, id + ' must not be retained');
  }
  await visit(c, 'larger', args('larger', 'synthetic-only', 100));
  assert.equal(c.snapshot(history, args('larger', 'synthetic-only', 100)).loaded, false);
  const now = Date.now; Date.now = () => now() + 120_001;
  assert.equal(c.snapshot(history, args('bytes-29')).loaded, false); Date.now = now;
  reports.push('bounds: <=30 idle pages, <=4MiB accounted bytes, 120s expiry, oversized/pending/partial/larger-page exclusion');
  // Debounce and cancellation use the real timers and shared client gate.
  for (let i = 0; i < 20; i++) c.scheduleChatPrefetch('synthetic-only', 'hover-' + i);
  const beforeHover = calls.length;
  await pause(180); await tick();
  assert.equal(calls.length, beforeHover + 1);
  assert.equal(calls.at(-1).args.id, 'hover-19');
  c.scheduleChatPrefetch('synthetic-only', 'hover-19'); await pause(180);
  assert.equal(calls.length, beforeHover + 1, 'cached hover deduplicated');
  const cancel = c.scheduleChatPrefetch('synthetic-only', 'cancelled'); cancel(); await pause(180);
  assert.equal(calls.length, beforeHover + 1);
  let resolveHover;
  fixtures.set('slow-hover', () => new Promise(resolve => { resolveHover = resolve; }));
  c.scheduleChatPrefetch('synthetic-only', 'slow-hover'); await pause(180);
  const pendingCount = calls.length;
  c.scheduleChatPrefetch('synthetic-only', 'dropped-hover'); await pause(180);
  assert.equal(calls.length, pendingCount);
  resolveHover({ value: page('warm'), reads: ['messages'] }); await tick();
  assert.equal(maxOutstanding, 1);
  reports.push('prefetch: 20 intents => 1 request; cached/cancelled intents => 0; one concurrent request');
  // A currently open chat can lose its first response without becoming an idle cache.
  fixtures.set('transient-active', () => new Error('synthetic transient network failure'));
  const stopTransient = c.subscribe(history, args('transient-active'), () => {}); await tick();
  assert.equal(c.snapshot(history, args('transient-active')).loaded, false);
  c.scheduleChatPrefetch('synthetic-only', 'transient-active'); await pause(180); await tick();
  assert.equal(c.prefetching, false, 'unloaded active subscription without a request must release prefetch gate');
  const beforeRecovery = calls.length;
  c.scheduleChatPrefetch('synthetic-only', 'after-transient'); await pause(180); await tick();
  assert.equal(calls.length, beforeRecovery + 1, 'later hover still starts');
  assert.equal([...c.subscriptions.values()].find(s => s.args.id === 'transient-active').listeners.size, 1, 'temporary hover listener released');
  stopTransient();
  reports.push('transient active query without in-flight request releases hover listener/gate and allows later prefetch');
  // Metadata is deliberately unavailable after navigation.
  const stopMeta = c.subscribe('dashboard:getChat', { key: 'synthetic-only', id: 'meta' }, () => {}); await tick(); stopMeta();
  assert.equal(c.snapshot('dashboard:getChat', { key: 'synthetic-only', id: 'meta' }).loaded, false);
  await visit(c, 'close'); c.close();
  assert.equal(c.snapshot(history, args('close')).loaded, false);
  reports.push('metadata/close: metadata not retained between visits; close releases history/timers');
  const suspended = client(); await visit(suspended, 'suspend'); suspended.suspend();
  assert.equal(suspended.snapshot(history, args('suspend')).loaded, false);
  reports.push('suspend: inactive history is discarded before a disconnected tab can reopen it');
  writeFileSync(new URL('./e2e-results.json', import.meta.url), JSON.stringify({ passed: true, fixture: 'real BackendClient with fake fetch; no server/Runtime bootstrap or network', flows: reports, requestCount: calls.length, maxOutstanding, boundsBytes: total, browserPaintVerified: false }, null, 2));
  console.log(JSON.stringify({ passed: true, flows: reports.length, requestCount: calls.length, maxOutstanding }));
} finally { for (const c of clients) c.close(); }
