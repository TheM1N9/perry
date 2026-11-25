globalThis.__perryEmbedders = new Map([["connector-fixture", Promise.resolve(async texts => texts.map(() => [1, 0]))]]);
globalThis.__perryEmbeddersReady = new Set(["connector-fixture"]);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('External network disabled in connector fixture');
  return nativeFetch(input, ...args);
};
