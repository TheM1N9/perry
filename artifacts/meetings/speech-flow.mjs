import assert from "node:assert/strict";

export async function speechFlow(call, key, check) {
  const originalFetch = globalThis.fetch;
  let paid = 0;
  let fail = true;
  globalThis.fetch = async (url, options) => {
    if (String(url) !== "https://api.groq.com/openai/v1/audio/transcriptions") return originalFetch(url, options);
    paid++;
    assert.equal(options.headers.Authorization, "Bearer synthetic-groq-ci-key");
    assert.equal(options.body.get("model"), "whisper-large-v3");
    assert.equal(options.body.get("prompt"), "Perry, Composio");
    assert.equal(options.body.get("language"), null);
    const wave = Buffer.from(await options.body.get("file").arrayBuffer());
    assert.equal(wave.toString("ascii", 0, 4), "RIFF");
    assert.equal(wave.readUInt32LE(24), 16000);
    if (fail) return new Response("", { status: 429 });
    return Response.json({ text: paid === 3 ? "" : "The Perry launch is on Friday." });
  };
  let id;
  try {
    await call("secrets:set", { name: "GROQ_API_KEY", value: "synthetic-groq-ci-key" });
    await call("meetings:setSettings", { key, speech: { provider: "groq", model: "small", language: "auto", vocabulary: "Perry, Composio" } });
    ({ id } = await call("meetings:start", { key, title: "Cloud transcription transport" }));
    // Changing the next recording's settings must not change an active session's provider.
    await call("meetings:setSettings", { key, speech: { provider: "local", model: "small", language: "en", vocabulary: "" } });
    const chunk = { key, id, seq: 0, source: "you", startMs: 0, endMs: 1000, audio: Buffer.alloc(32000).toString("base64") };
    await assert.rejects(call("speech:transcribe", chunk), /limit/i);
    fail = false;
    const first = await call("speech:transcribe", chunk);
    const again = await call("speech:transcribe", chunk);
    check("cloud retry persists a paid result before returning and reuses it", first.text.includes("Perry") && again.text === first.text && paid === 2 && (await call("meetings:transcript", { key, id })).length === 1);
    await call("speech:transcribe", { ...chunk, seq: 1 });
    await call("speech:transcribe", { ...chunk, seq: 1 });
    check("silence results are persisted without another paid request", paid === 3);
    await assert.rejects(call("speech:transcribe", { ...chunk, key: "wrong" }), /key/i);
    await assert.rejects(call("speech:transcribe", { ...chunk, seq: 2, device: "foreign-pet" }), /computer|id/i);
    check("cloud speech protects owner and device authorization", paid === 3);
    check("speech settings never expose the provider key", !JSON.stringify(await call("meetings:settings", { key })).includes("synthetic-groq"));
  } finally {
    globalThis.fetch = originalFetch;
    if (id) await call("meetings:remove", { key, id });
    await call("meetings:setSettings", { key, speech: { provider: "local", model: "small", language: "en", vocabulary: "" } });
  }
}
