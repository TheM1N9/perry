// Inventory: stream-reconnect-failure-cases.md. Native Chrome/CDP + loopback HTTP; no shared Next build.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/computer-control/stream-reconnect.mjs <outDir> [--baseline]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { registerHooks } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv[2]) throw Error('Pass a disposable output directory');
const out = resolve(process.argv[2]), baseline = process.argv.includes('--baseline');
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'perry-cast-reconnect-'));
process.env.PERRY_HOME = home;
process.env.PERRY_BROWSER_PATH ??= 'C:/Program Files/Google/Chrome/Application/chrome.exe';
process.env.PERRY_BROWSER_HEADED = '0';
const report = { baseline, checkedAt: new Date().toISOString(), passed: false, checks: {}, evidence: {}, teardown: {} };
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const check = (name, ok, evidence) => {
  report.checks[name] = Boolean(ok);
  if (evidence !== undefined) report.evidence[name] = evidence;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  save();
};
const until = async (test, ms = 8_000) => {
  const deadline = Date.now() + ms;
  while (!await test()) { if (Date.now() >= deadline) throw Error('Native screencast condition timed out'); await delay(25); }
};
if (baseline) {
  const target = fileURLToPath(new URL('../../server/browser-stream.ts', import.meta.url));
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (!url.startsWith('file:') || fileURLToPath(url) !== target) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString();
    const guard = /if \(cast\.watchers\.size\) cast\.again = true;\s+else if \(casts\.get\(scope\) === cast\) casts\.delete\(scope\);/;
    assert.ok(guard.test(source), 'baseline must replace the exact post-release recheck');
    report.evidence.baselineChangedOnlyPostReleaseRecheck = true;
    return { ...loaded, source: source.replace(guard, 'if (casts.get(scope) === cast) casts.delete(scope);') };
  } });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('External fetch disabled');
  return realFetch(input, ...args);
};
let browser, controlBrowser, streamBrowser, connection, sendNormally, nativeRelease;
let activeHttpViews = 0;
const scope = 'native-stream-reconnect';
const viewers = [];
const server = createServer((req, res) => {
  if (req.url === '/view') {
    activeHttpViews++;
    const abort = new AbortController();
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const bridge = Readable.fromWeb(streamBrowser(scope, false, 640, abort.signal));
    bridge.on('error', () => res.destroy());
    res.once('close', () => { activeHttpViews--; abort.abort(); bridge.destroy(); });
    bridge.pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><title>Native cast reconnect</title><body>
    <button id="button" style="margin:40px" onclick="window.clicked++">Verify live control</button><p id="pulse"></p>
    <script>window.clicked=0;window.releases=0;document.addEventListener('mouseup',()=>window.releases++);
    let n=0;const timer=setInterval(()=>document.getElementById('pulse').textContent='Native frame '+n++,100);
    addEventListener('pagehide',()=>clearInterval(timer),{once:true});</script></body></html>`);
});
const openViewer = async base => {
  const abort = new AbortController(), frames = [], states = [];
  const viewer = { abort, frames, states, error: undefined, reading: undefined };
  viewers.push(viewer);
  const response = await fetch(base + '/view', { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  viewer.reading = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        pending += decoder.decode(part.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) if (line) {
          const packet = JSON.parse(line);
          if (packet.frame) frames.push({ identity: packet.frame.identity, bytes: Buffer.from(packet.frame.image, 'base64').length });
          if (packet.state) states.push(packet.state.identity);
        }
      }
    } catch (error) { if (!abort.signal.aborted) viewer.error = String(error); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  })();
  return viewer;
};
const evaluate = async expression => (await browser.withBrowserView(scope, () => browser.hostCommand('Runtime.evaluate', { expression, returnByValue: true }))).result.value;
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await import('../../convex/lib/browser.ts');
  ({ controlBrowser } = await import('../../server/browser-host.ts'));
  ({ streamBrowser } = await import('../../server/browser-stream.ts'));
  await controlBrowser(scope, { action: 'start', nativeWindow: false }, false);
  await controlBrowser(scope, { action: 'navigate', identity: browser.identity(scope), url: base + '/fixture' }, false);
  await until(async () => await evaluate('document.title') === 'Native cast reconnect');
  report.evidence.browser = await browser.withBrowserView(scope, () => browser.hostCommand('Browser.getVersion'));
  connection = browser.browserControl(scope).current;
  const listenersBefore = connection.listeners.size, control = browser.browserControl(scope);
  const viewsBefore = control.viewers, leasesBefore = control.leases;
  sendNormally = connection.ws.send.bind(connection.ws);
  let starts = 0, stops = 0, gateRequested = false;
  connection.ws.send = data => {
    const packet = JSON.parse(String(data));
    if (packet.method === 'Page.startScreencast') starts++;
    if (packet.method === 'Page.stopScreencast') stops++;
    if (gateRequested && packet.method === 'Input.dispatchMouseEvent' && packet.params.type === 'mouseReleased') {
      gateRequested = false;
      const waiting = connection.pending.get(packet.id), resolveNative = waiting.resolve;
      // Chrome receives the real release. Delay only the authentic response reaching its awaiting cleanup.
      waiting.resolve = result => {
        report.evidence.nativeRelease = { packet, result };
        nativeRelease = () => { nativeRelease = undefined; resolveNative(result); };
      };
    }
    sendNormally(data);
  };
  const one = await openViewer(base);
  await until(() => one.frames.length > 0);
  const casts = globalThis.__perryScreencasts, original = casts.get(scope);
  check('first HTTP viewer receives a real native frame', one.frames[0].bytes > 500 && original.watchers.size === 1, one.frames[0]);
  await controlBrowser(scope, { action: 'input', identity: browser.identity(scope), input: { type: 'pointer', phase: 'mousePressed', x: 700, y: 500, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } }, false);
  gateRequested = true;
  one.abort.abort();
  await until(() => nativeRelease !== undefined);
  check('cleanup awaits an authentic native pointer-release response', casts.get(scope) === original && original.watchers.size === 0 && Boolean(original.following) && await evaluate('window.releases') === 1, { releases: await evaluate('window.releases'), castRegistered: casts.get(scope) === original });
  const two = await openViewer(base);
  check('rejoining viewer joins the same cast before release settles', casts.get(scope) === original && original.watchers.size === 1);
  nativeRelease();
  await until(() => two.frames.length > 0);
  check('post-release cleanup retains the rejoined live cast', casts.get(scope) === original && original.watchers.size === 1 && two.frames[0].bytes > 500, { registered: casts.get(scope) === original, watchers: original.watchers.size, frame: two.frames[0] });
  const rect = await evaluate('(()=>{const r=document.getElementById("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  const beforeClick = two.frames.length;
  await controlBrowser(scope, { action: 'click', identity: browser.identity(scope), ...rect }, false);
  await until(() => two.frames.length > beforeClick);
  check('rejoined viewer remains usable with real owner input and fresh frames', await evaluate('window.clicked') === 1 && two.frames.every(frame => frame.identity.tabId === browser.identity(scope).tabId));
  two.abort.abort();
  await until(() => activeHttpViews === 0);
  let settled = true;
  try { await until(() => !casts.has(scope) && connection.listeners.size === listenersBefore && control.viewers === viewsBefore && control.leases === leasesBefore, 3_000); }
  catch { settled = false; }
  check('final disconnect releases cast, native listener, view and lease', settled, { castRegistered: casts.has(scope), listenersBefore, listenersAfter: connection.listeners.size, viewsBefore, viewsAfter: control.viewers, leasesBefore, leasesAfter: control.leases });
  check('each started native screencast receives its stop', starts === stops, { starts, stops });
  const castBeforeAborted = casts.get(scope), listenersBeforeAborted = connection.listeners.size, viewsBeforeAborted = control.viewers;
  const gone = new AbortController(); gone.abort();
  const alreadyClosed = streamBrowser(scope, false, 640, gone.signal).getReader();
  check('already-aborted viewer retains nothing', (await alreadyClosed.read()).done && casts.get(scope) === castBeforeAborted && control.viewers === viewsBeforeAborted && connection.listeners.size === listenersBeforeAborted);
  alreadyClosed.releaseLock();
  report.evidence.viewerFrames = viewers.map(viewer => ({ frames: viewer.frames.length, states: viewer.states.length, error: viewer.error }));
  check('native CDP has no unsettled commands after teardown', connection.pending.size === 0);
} catch (error) {
  report.error = error.stack ?? String(error);
} finally {
  nativeRelease?.();
  if (connection && sendNormally) connection.ws.send = sendNormally;
  for (const viewer of viewers) viewer.abort.abort();
  await Promise.all(viewers.map(viewer => viewer.reading));
  const child = connection?.child;
  if (browser) await browser.withBrowserView(scope, async () => browser.closeBrowser()).catch(error => { report.teardown.browserError = String(error); });
  if (child) await until(() => child.exitCode !== null || child.signalCode !== null).catch(error => { report.teardown.childError = String(error); });
  server.closeAllConnections();
  if (server.listening) await new Promise(done => server.close(done));
  globalThis.fetch = realFetch;
  report.teardown.serverClosed = !server.listening;
  report.teardown.httpViews = activeHttpViews;
  report.teardown.browserExited = !child || child.exitCode !== null || child.signalCode !== null;
  assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep) && home.includes('perry-cast-reconnect-'));
  try { rmSync(home, { recursive: true, force: true }); } catch (error) { report.teardown.homeError = String(error); }
  report.teardown.homeRemoved = !existsSync(home);
  report.passed = !report.error && Object.values(report.checks).every(Boolean) && report.teardown.serverClosed && report.teardown.browserExited && report.teardown.homeRemoved;
  save();
}
console.log(JSON.stringify({ passed: report.passed, baseline, checks: report.checks, teardown: report.teardown, error: report.error }, null, 2));
if (!report.passed) process.exitCode = 1;
