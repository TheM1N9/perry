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
const result = { scope: 'Actual Telegram idle polling loop and native abortable delays with a synthetic no-token runtime' };
try {
  stop = pollTelegram({ runQuery: async () => {
    if (++queries === 3) {
      result.idleCycles = queries - 1;
      result.abortListenersRetainedBeforeStop = getEventListeners(controller.signal, 'abort').length;
      stop(); finish();
    }
    return { value: null };
  } });
  let watchdog;
  try { await Promise.race([complete, new Promise((_, reject) => { watchdog = nativeTimer(() => reject(Error('Lifecycle replay timed out')), 35000); })]); }
  finally { clearTimeout(watchdog); }
  // Let the loop finish its post-query continuation after the stop.
  await new Promise(done => nativeTimer(done, 20));
  result.abortListenersAfterStop = getEventListeners(controller.signal, 'abort').length;
  assert.equal(result.abortListenersRetainedBeforeStop, 0);
  assert.equal(result.abortListenersAfterStop, 0);
  result.completed = true; result.protectionPassed = true;
} catch (error) { result.completed = false; result.error = String(error); }
finally {
  stop?.(); globalThis.setTimeout = nativeTimer; globalThis.AbortController = NativeController;
  writeFileSync(new URL('./lifecycle-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result)); process.exitCode = result.completed ? 0 : 1;
