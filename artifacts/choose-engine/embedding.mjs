// Engine setup and routing are under test; embedding downloads are not needed.
globalThis.__perryEmbedders = new Map([["choose-engine-fixture", Promise.resolve(async texts => texts.map(() => [1, 0]))]]);
globalThis.__perryEmbeddersReady = new Set(["choose-engine-fixture"]);
