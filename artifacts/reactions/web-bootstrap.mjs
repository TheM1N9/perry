// Isolated production-server fixture: no model download or paid model calls.
process.env.PERRY_EMBED_MODEL = 'web-reactions-fixture';
globalThis.__perryEmbedders = new Map([['web-reactions-fixture', Promise.resolve(async texts => texts.map(() => [1, 0]))]]);
globalThis.__perryEmbeddersReady = new Set(['web-reactions-fixture']);
