// Failure inventory: failure-cases.md. Synthetic transport, real BackendClient.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendClient } from '../../client/backend.ts';
const originalFetch = globalThis.fetch;
const clients = new Set(); const streams = new Set(); const checks = [];
let content = 'before'; let hold = null; let waiting = null; let requestSignal;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/events')) {
    let current;
    return new Response(new ReadableStream({ start(controller) {
      current = controller; streams.add(current);
      options.signal?.addEventListener('abort', () => { streams.delete(current); try { current.close(); } catch {} }, { once: true });
      controller.enqueue(new TextEncoder().encode('retry: 2000\n\n'));
    }, cancel() { streams.delete(current); } }));
  }
  const value = { page: [{ text: content }], isDone: true, continueCursor: '' };
  if (hold) { requestSignal = options.signal; waiting?.(); await hold; }
  return Response.json({ value, reads: ['agentMessages', 'vault'] });
};
const args = { key: 'synthetic', id: 'chat', paginationOpts: { cursor: null, numItems: 50 } };
const name = 'dashboard:getChatMessages';
const client = () => { const c = new BackendClient(); clients.add(c); return c; };
const until = async predicate => {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(10); }
  throw Error('Bounded synthetic cache replay timed out');
};
async function check(name, work) {
  try { checks.push({ name, completed: true, ...await work() }); }
  catch (error) { checks.push({ name, completed: false, error: String(error) }); }
}
try {
  await check('Vault invalidation removes old active history and loads redacted content', async () => {
    const c = client(); const off = c.subscribe(name, args, () => {});
    await until(() => c.snapshot(name, args).loaded);
    content = 'redacted'; await c.refresh(['vault']);
    assert.equal(c.snapshot(name, args).value.page[0].text, 'redacted'); off(); c.close();
    return { protectionPassed: true };
  });
  await check('Lock invalidation prevents late history response from repopulating cache', async () => {
    const c = client(); const off = c.subscribe(name, args, () => {});
    await until(() => c.snapshot(name, args).loaded);
    let release; hold = new Promise(done => { release = done; });
    const started = new Promise(done => { waiting = done; });
    const refresh = c.refresh(['agentMessages']); await started;
    c.clearChatCache(); release(); hold = null; waiting = null; await refresh;
    assert.equal(c.snapshot(name, args).value, undefined); off(); c.close();
    return { protectionPassed: true };
  });
  await check('Reconnect refreshes subscribed history after missed changes', async () => {
    const c = client(); const off = c.subscribe(name, args, () => {});
    await until(() => c.snapshot(name, args).loaded);
    content = 'changed while disconnected';
    for (const stream of [...streams]) { streams.delete(stream); try { stream.close(); } catch {} }
    await until(() => c.snapshot(name, args).value?.page?.[0]?.text === content);
    off(); c.close(); return { protectionPassed: true };
  });
  await check('Client close does not abort its pending ordinary backend fetch', async () => {
    const c = client(); let release; hold = new Promise(done => { release = done; });
    const started = new Promise(done => { waiting = done; });
    const pending = c.call(name, args); await started; c.close();
    const abortSignalSupplied = Boolean(requestSignal);
    release(); hold = null; waiting = null; await pending;
    assert.equal(abortSignalSupplied, false);
    return { findingConfirmed: true, abortSignalSupplied, limitation: 'Synthetic stalled transport; real call method supplies no cancellation or deadline' };
  });
} finally {
  for (const c of clients) c.close(); globalThis.fetch = originalFetch;
  for (const stream of streams) { try { stream.close(); } catch {} } streams.clear();
  writeFileSync(new URL('./baseline-client-replay-result.json', import.meta.url), JSON.stringify({ completed: checks.every(c => c.completed), scope: 'Real client with synthetic fetch/stream transport', checks }, null, 2) + '\n');
}
console.log(JSON.stringify(checks, null, 2)); process.exitCode = checks.every(c => c.completed) ? 0 : 1;
