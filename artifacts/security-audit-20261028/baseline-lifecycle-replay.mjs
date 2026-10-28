// Real pollTelegram lifecycle, no provider traffic or database. Inventory: failure-cases.md.
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { writeFileSync } from 'node:fs';
import { pollTelegram } from '../../server/telegram.ts';
const nativeTimer = globalThis.setTimeout;
const NativeController = globalThis.AbortController;
let controller; let queries = 0; let stop; let finish;
const complete = new Promise(done => { finish = done; });
globalThis.AbortController = class extends NativeController { constructor() { super(); controller = this; } };
globalThis.setTimeout = (callback, ms, ...args) => nativeTimer(callback, ms === 15000 ? 0 : ms, ...args);
const result = { scope: 'Actual Telegram idle polling loop with a synthetic no-token runtime; only 15-second delays accelerated' };
try {
  stop = pollTelegram({ runQuery: async () => {
    if (++queries === 13) {
      result.idleCycles = queries - 1;
      result.abortListenersRetainedBeforeStop = getEventListeners(controller.signal, 'abort').length;
      stop(); finish();
    }
    return { value: null };
  } });
  let watchdog;
  try { await Promise.race([complete, new Promise((_, reject) => { watchdog = nativeTimer(() => reject(Error('Lifecycle replay timed out')), 2000); })]); }
  finally { clearTimeout(watchdog); }
  // Let the loop finish its post-query continuation while delays are still accelerated.
  await new Promise(done => nativeTimer(done, 20));
  result.abortListenersAfterStop = getEventListeners(controller.signal, 'abort').length;
  assert.equal(result.abortListenersRetainedBeforeStop, 12);
  result.completed = true; result.findingConfirmed = true;
} catch (error) { result.completed = false; result.error = String(error); }
finally {
  stop?.(); globalThis.setTimeout = nativeTimer; globalThis.AbortController = NativeController;
  writeFileSync(new URL('./baseline-lifecycle-replay-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result)); process.exitCode = result.completed ? 0 : 1;
