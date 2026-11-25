// Fake-only relay acceptance: prevent startup embedding downloads and external provider fetches.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
if (process.env.PERRY_EMBED_MODEL !== 'task-handoff-fixture') throw Error('Expected isolated task-handoff embedding model');
globalThis.__perryEmbedders = new Map([['task-handoff-fixture', Promise.resolve(async texts => texts.map(() => [1, 0]))]]);
globalThis.__perryEmbeddersReady = new Set(['task-handoff-fixture']);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('External fetch disabled in task relay acceptance');
  return nativeFetch(input, options);
};
// Defer only relay dispatch; the serial scheduler remains free to prepare sibling tasks.
let backend;
const held = async name => {
  const file = join(process.env.PERRY_HOME, name), deadline = Date.now() + 30_000;
  while (existsSync(file)) {
    if (Date.now() >= deadline) throw Error('Task relay fixture gate was not released');
    await delay(20);
  }
};
Object.defineProperty(globalThis, '__perry', {
  configurable: true,
  get: () => backend,
  set(value) {
    backend = value;
    const action = value.runtime.runAction.bind(value.runtime);
    const relay = value.runtime.registry.get('tasks:handOff'), dispatch = relay.handler;
    relay.handler = async (ctx, args) => {
      const file = join(process.env.PERRY_HOME, 'hold-task-relay');
      if (existsSync(file)) {
        if (Date.now() - statSync(file).mtimeMs > 60_000) throw Error('Task relay fixture gate was not released');
        await ctx.scheduler.runAfter(100, 'tasks:handOff', args);
        return null;
      }
      return dispatch(ctx, args);
    };
    value.runtime.runAction = async (name, args, options) => {
      if (name === 'brain:handleTurn' && args.title?.includes('Preparing cancellation')) await held('hold-task-preparation');
      return action(name, args, options);
    };
  },
});
