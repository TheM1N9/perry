// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs .batch-work/batch-2/238/e2e.mjs
// Read failure-cases.md first. No server/bootstrap, engines, services, live keys or network.
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const root = resolve(".batch-work/batch-2/238");
const home = join(root, "fixture");
assert.ok(!isAbsolute(relative(root, home)) && !relative(root, home).startsWith(".."));
process.env.PERRY_HOME = home;
process.env.PERRY_DB = join(home, "stream.sqlite");
process.env.DASHBOARD_KEY = "batch238-synthetic-key";
process.env.PERRY_CREDENTIAL_KEY = "11".repeat(32);
process.env.TELEGRAM_BOT_TOKEN = "batch238-synthetic-bot";
process.env.TELEGRAM_API_BASE = "http://batch238.invalid";
fs.mkdirSync(home, { recursive: true });
const useOverlay = process.argv.includes("--overlay");
const useFollowup = process.argv.includes("--followup-proposal");
assert.ok(!(useOverlay && useFollowup));
const overlay = useOverlay || useFollowup ? JSON.parse(fs.readFileSync(join(root, useFollowup ? "followup-overlay.json" : "integration-overlay.json"), "utf8")) : {};
const sources = new Map(Object.entries(overlay).map(([path, source]) => [pathToFileURL(resolve(path)).href, source]));
registerHooks({ load(url, context, next) {
  if (sources.has(url)) return { format: "module-typescript", source: sources.get(url), shortCircuit: true };
  return next(url, context);
} });
const evidence = { passed: false, isolation: { syntheticHome: home, schedulerStopped: true, normalBootstrap: false, realNetwork: false, sourceMode: useOverlay ? "virtual-original-proposal" : useFollowup ? "integrated-source-with-shared-followup-proposal" : "actual-integrated-source" }, cases: [], growth: [], delivery: [] };
const requests = {};
let heldDelivery;
let nestedDelivery;
const holdDelivery = (method, behavior = "hold") => {
  let release, entered;
  const wait = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = { method, wait, entered, claimed: false, error: undefined, behavior, signal: undefined };
  heldDelivery = gate;
  return { started, release, fail(error) { gate.error = error; }, signal() { return gate.signal; } };
};
let runtime, sql, client;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === "http://batch238.invalid/api/backend/events") {
    return new Response(new ReadableStream({ start(controller) {
      const change = (tables) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ tables })}\n\n`));
      runtime.events.on("change", change);
      init.signal?.addEventListener("abort", () => { runtime.events.off("change", change); controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  }
  if (url === "http://batch238.invalid/api/backend/call") {
    const { path, args } = JSON.parse(init.body);
    requests[path] = (requests[path] ?? 0) + 1;
    try { return Response.json(await runtime.call(path, args)); }
    catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
  assert.ok(url.startsWith("http://batch238.invalid/bot"), `Unexpected network: ${url}`);
  const body = JSON.parse(init.body ?? "{}");
  const gate = heldDelivery;
  if (gate && !gate.claimed && url.endsWith(`/${gate.method}`)) {
    gate.claimed = true; gate.signal = init.signal; gate.entered(); await gate.wait;
    if (gate.error) throw gate.error;
    if (gate.behavior === "hangingSend") {
      assert.ok(init.signal instanceof AbortSignal, "Draft request needs an abort deadline");
      await new Promise((_, reject) => {
        const guard = setTimeout(() => reject(new Error("Draft deadline failed to abort within 20s")), 20_000);
        const aborted = () => { clearTimeout(guard); reject(init.signal.reason); };
        if (init.signal.aborted) aborted();
        else init.signal.addEventListener("abort", aborted, { once: true });
      });
    }
    if (gate.behavior === "rateLimitedSend") return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, { status: 429 });
  }
  if (nestedDelivery) { const nested = nestedDelivery; nestedDelivery = undefined; await nested(); }
  evidence.delivery.push({ method: url.split("/").at(-1), text: body.text, messageId: body.message_id });
  return Response.json({ ok: true, result: { message_id: 238 } });
};
try {
  const imp = (file) => import(pathToFileURL(resolve(file)).href);
  const { Runtime } = await imp("server/runtime.ts");
  const { default: schema } = await imp("convex/schema.ts");
  const modules = {};
  for (const name of ["codex", "dashboard", "turnStreams", "recovery", "runner", "vault", "routing", "agentStore", "conversations", "secrets", "runs", "whatsapp"]) modules[name] = await imp(`convex/${name}.ts`);
  const { internalMutation } = await imp("convex/_generated/server.js");
  modules.brain = { checkpointIfFull: internalMutation({ args: {}, handler: async () => null }) };
  const { BackendClient } = await imp("client/backend.ts");
  const { createReplyStream, streamFlushMs } = await imp("runner/stream-reply.ts");
  const open = async (database = ":memory:") => {
    sql = new DatabaseSync(database);
    runtime = new Runtime(sql, schema, modules, { storageDir: join(home, "storage") });
    await runtime.stop(); // Before any fixture mutation, including setup.
  };
  await open();
  const call = async (name, args) => (await runtime.call(name, args, { internal: true })).value;
  const insert = (table, value) => runtime.exclusive(() => runtime.store.insert(table, value));
  const get = (id) => runtime.exclusive(() => runtime.store.get(id));
  const patch = (id, value) => runtime.exclusive(() => runtime.store.patch(id, value));
  const token = "batch238-synthetic-runner";
  let runnerId = await insert("runners", { token, name: "Synthetic runner", revoked: false, lastSeenAt: Date.now(), turnHeartbeats: true });
  const fixture = async (channel = "web", extras = {}) => {
    const userId = channel === "web" ? "web:dashboard" : `${channel}:synthetic`;
    const threadId = await call("agentStore:createThread", { userId });
    const conversationId = await insert("conversations", { channel, externalId: "synthetic", threadId, engine: "codex", pendingTurns: 1, lastMessageAt: Date.now() });
    const runId = await call("runs:start", { conversationId, prompt: "Synthetic stream" });
    const id = await insert("codexTurns", { runnerId, conversationId, runId, engine: "codex", prompt: "Synthetic stream", instructions: "i".repeat(40_000), history: "h".repeat(40_000), recalled: "r".repeat(20_000), status: "running", createdAt: Date.now(), startedAt: Date.now(), lastHeartbeatAt: Date.now(), ...extras });
    return { id, runId, conversationId, threadId };
  };
  const append = (f, offset, text, reset, resetKey) => call("turnStreams:append", { token, id: f.id, offset, text, ...(reset ? { reset } : {}), ...(resetKey ? { resetKey } : {}) });
  const body = (f) => call("turnStreams:getChatStream", { key: process.env.DASHBOARD_KEY, id: f.conversationId });
  const finish = (f, result) => call("codex:finishTurn", { token, id: f.id, ...result });
  const finalize = (f) => call("codex:finalizeTurn", { id: f.id });

  // Actual SQLite trigger instrumentation, counting JSON payload bytes supplied
  // to document INSERT/UPDATE (not an estimate based on outgoing API arguments).
  sql.exec("CREATE TABLE meter (tbl TEXT, bytes INTEGER)");
  for (const table of ["codexTurns", "turnStreams", "turnStreamChunks"]) {
    for (const [operation, suffix] of [["INSERT", "i"], ["UPDATE", "u"]]) sql.exec(`CREATE TRIGGER meter_${table}_${suffix} AFTER ${operation} ON doc_${table} BEGIN INSERT INTO meter VALUES ('${table}', length(CAST(new.doc AS BLOB))); END`);
  }
  for (const length of [5_000, 10_000, 20_000]) {
    const f = await fixture();
    sql.exec("DELETE FROM meter");
    const meta = await runtime.runQuery("dashboard:getChat", { key: process.env.DASHBOARD_KEY, id: f.conversationId });
    assert.ok(!meta.reads.includes("turnStreams") && !meta.reads.includes("turnStreamChunks"));
    client = new BackendClient("http://batch238.invalid");
    const args = { key: process.env.DASHBOARD_KEY, id: f.conversationId };
    client.subscribe("dashboard:getChat", args, () => {});
    client.subscribe("turnStreams:getChatStream", args, () => {});
    await client.refresh();
    await new Promise(setImmediate);
    await client.refresh();
    const chatBefore = requests["dashboard:getChat"];
    const streamBefore = requests["turnStreams:getChatStream"];
    let deltaCharacters = 0, flushes = 0;
    const sender = new BackendClient("http://batch238.invalid");
    const stream = createReplyStream(async (packet) => {
      deltaCharacters += packet.text.length; flushes++;
      return sender.mutation("turnStreams:append", { token, id: f.id, ...packet });
    });
    for (let n = 200; n <= length; n += 200) { stream.update("x".repeat(n)); await stream.flush(); await new Promise(setImmediate); }
    assert.equal(await body(f), "x".repeat(length));
    assert.equal(requests["dashboard:getChat"] - chatBefore, 0, "stream flush invalidated metadata");
    assert.ok(requests["turnStreams:getChatStream"] > streamBefore);
    const rows = sql.prepare("SELECT tbl, count(*) AS writes, sum(bytes) AS bytes FROM meter GROUP BY tbl").all();
    assert.ok(!rows.some((row) => row.tbl === "codexTurns"), "heavy row was rewritten");
    evidence.growth.push({ characters: length, deltaCharacters, flushes, metadataReruns: requests["dashboard:getChat"] - chatBefore, streamReruns: requests["turnStreams:getChatStream"] - streamBefore, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), writes: rows, metadataReadTables: meta.reads });
    assert.equal(client.snapshot("turnStreams:getChatStream", args).value, "x".repeat(length));
    sender.close(); client.close(); client = null;
  }
  for (let i = 1; i < evidence.growth.length; i++) {
    const ratio = evidence.growth[i].bytes / evidence.growth[i - 1].bytes;
    assert.ok(ratio > 1.9 && ratio < 2.1, `nonlinear write growth: ${ratio}`);
  }
  evidence.byteMetric = "Actual SQLite INSERT/UPDATE JSON BLOB payload bytes via triggers; excludes page/WAL/index amplification and fixture setup.";
  evidence.intervals = [0, 5_000, 10_000, 20_000, 100_000].map((length) => ({ length, milliseconds: streamFlushMs(length) }));

  const retry = await fixture();
  let loseAck = true;
  const retryStream = createReplyStream(async (packet) => {
    const result = await append(retry, packet.offset, packet.text, packet.reset, packet.resetKey);
    if (loseAck) { loseAck = false; throw new Error("Synthetic lost acknowledgment after commit"); }
    return result;
  });
  retryStream.update("hello");
  await assert.rejects(retryStream.flush(), /lost acknowledgment/);
  retryStream.update("hello world");
  await Promise.all([retryStream.flush(), retryStream.flush()]);
  assert.equal(await body(retry), "hello world");
  retryStream.update("rewrite"); await retryStream.flush();
  assert.equal(await body(retry), "rewrite");
  await assert.rejects(append(retry, 999, "gap"), /does not follow/);
  await assert.rejects(append(retry, -1, "negative"), /Invalid/);
  await assert.rejects(call("turnStreams:append", { token: "wrong", id: retry.id, offset: 7, text: "bad" }), /not valid/);
  await assert.rejects(call("turnStreams:getChatStream", { key: "wrong", id: retry.conversationId }), /Wrong dashboard key/);
  const other = await insert("runners", { token: "other-synthetic", revoked: false });
  assert.equal(await call("turnStreams:append", { token: "other-synthetic", id: retry.id, offset: 7, text: "bad" }), null);
  evidence.cases.push("Serialized ambiguous-commit retry with newer text, concurrent flushes, rewrite, gap/negative offsets, ownership/dashboard auth");

  const legacy = await fixture("web", { partial: "Legacy partial" });
  assert.equal(await body(legacy), "Legacy partial");
  await call("codex:streamTurn", { token, id: legacy.id, text: "Legacy partial continued" });
  await call("codex:streamTurn", { token, id: legacy.id, text: "Legacy partial continued again" });
  assert.equal(await body(legacy), "Legacy partial continued again");
  assert.equal((await get(legacy.id)).partial, "Legacy partial");
  const legacyEmpty = await fixture("web", { partial: "Legacy stale" });
  await call("codex:streamTurn", { token, id: legacyEmpty.id, text: "" });
  assert.equal(await body(legacyEmpty), "");
  evidence.cases.push("Legacy partial fallback and cumulative-snapshot runner compatibility");

  const redaction = await fixture();
  const secret = "synthetic-secret-238";
  await append(redaction, 0, "Before synthetic-");
  await append(redaction, 17, "secret-238 after\nmem");
  assert.equal(await body(redaction), `Before ${secret} after`);
  await call("vault:save", { label: "Synthetic", value: secret, by: "owner", conversationId: redaction.conversationId });
  assert.equal(await body(redaction), "Before [saved in Logins & secrets] after");
  const raw = sql.prepare("SELECT doc FROM doc_turnStreamChunks WHERE json_extract(doc, '$.turnId') = ?").all(redaction.id).map((row) => JSON.parse(row.doc).text).join("");
  assert.ok(!raw.includes(secret) && !raw.includes("secret-238"));
  const sourceLength = "Before synthetic-secret-238 after\nmem".length;
  await append(redaction, sourceLength, "ories: abc123");
  assert.equal(await body(redaction), "Before [saved in Logins & secrets] after");
  const splitSaved = await fixture();
  await append(splitSaved, 0, "synthetic-"); await append(splitSaved, 10, "secret-238");
  assert.equal(await body(splitSaved), "[saved in Logins & secrets]");
  evidence.cases.push("Footer and saved-secret redaction across chunks; vault scrubs raw chunks without changing source offset; later saved-value reads hide split secrets");

  const stopped = await fixture();
  await append(stopped, 0, "Stopped partial");
  await insert("runSpans", { runId: stopped.runId, callId: "synthetic", kind: "command", name: "Fake tool", status: "running", startedAt: Date.now() - 100 });
  await finish(stopped, { stopped: true });
  await finalize(stopped); await finalize(stopped);
  assert.equal((await get(stopped.id)).response, "Stopped partial");
  assert.equal(await body(stopped), null);
  assert.equal(await append(stopped, 15, "late"), null);
  const spans = sql.prepare("SELECT doc FROM doc_runSpans WHERE json_extract(doc, '$.runId') = ?").all(stopped.runId).map((row) => JSON.parse(row.doc));
  assert.ok(spans.every((span) => span.status !== "running"));
  const history = await call("agentStore:listMessages", { threadId: stopped.threadId, paginationOpts: { cursor: null, numItems: 100 } });
  assert.equal(history.page.length, 2);
  assert.ok(JSON.stringify(history).includes("Stopped partial"));
  const assertStreamRemoved = (turn) => {
    assert.equal(runtime.store.all("turnStreams").filter((row) => row.turnId === turn.id).length, 0);
    assert.equal(runtime.store.all("turnStreamChunks").filter((row) => row.turnId === turn.id).length, 0);
  };
  assertStreamRemoved(stopped);
  evidence.cases.push("Cancellation partial fallback, finalization replay/idempotency, terminal delta rejection and trace settlement");

  const failed = await fixture();
  await append(failed, 0, "Failure partial");
  await finish(failed, { error: "Synthetic engine failure", errorCode: "engine_failed" });
  assert.equal((await get(failed.id)).response, "Failure partial");
  assert.equal((await get(failed.id)).errorCode, "engine_failed");
  await finalize(failed); await finalize(failed);
  assertStreamRemoved(failed);
  assert.equal((await get(failed.id)).response, "Failure partial");
  const healthy = await fixture();
  const oldHeartbeat = Date.now() - 120_000;
  await patch(healthy.id, { lastHeartbeatAt: oldHeartbeat });
  await append(healthy, 0, "not a heartbeat");
  assert.equal((await get(healthy.id)).lastHeartbeatAt, oldHeartbeat);
  await call("runner:checkIn", { token, activeTurnIds: [healthy.id] });
  assert.ok((await get(healthy.id)).lastHeartbeatAt > oldHeartbeat);
  assert.equal((await get(failed.id)).errorCode, "engine_failed");
  const abandoned = await fixture();
  await append(abandoned, 0, "Recovered partial");
  await patch(abandoned.id, { createdAt: Date.now() - 2_000_000, startedAt: Date.now() - 2_000_000, lastHeartbeatAt: Date.now() - 2_000_000 });
  await call("recovery:sweep", { only: abandoned.conversationId });
  assert.equal((await get(abandoned.id)).response, "Recovered partial");
  assert.equal((await get(abandoned.id)).errorCode, "offline");
  await finalize(abandoned); await finalize(abandoned);
  assertStreamRemoved(abandoned);
  assert.equal((await get(abandoned.id)).response, "Recovered partial");
  evidence.cases.push("Error partial/code, no stream-driven heartbeat, genuine active-turn check-in, recovery abandoned partial");

  const refused = await fixture();
  await finish(refused, { error: "Synthetic plan limit", errorCode: "limit" });
  assert.equal((await get(refused.id)).retrying, true);
  await call("recovery:sweep", { only: refused.conversationId });
  assert.equal((await get(refused.id)).retrying, true, "Recovery stole retry ownership during grace");
  await patch(refused.id, { finishedAt: Date.now() - 700_000 });
  await call("recovery:sweep", { only: refused.conversationId });
  assert.equal((await get(refused.id)).retrying, undefined);
  assert.equal(await call("codex:retryOn", { id: refused.id, route: { engine: "codex", tier: "standard", by: "auto", why: "Synthetic" } }), false);
  await finalize(refused);
  assert.equal((await get(refused.id)).errorCode, "limit");
  evidence.cases.push("Limit refusal preserves retry grace; overdue recovery owns finalization and rejects a late retry");

  const telegram = await fixture("telegram");
  sql.exec("DELETE FROM meter");
  await append(telegram, 0, `Reply ${secret}\nmem`);
  await call("codex:streamToTelegram", { id: telegram.id });
  assert.equal(sql.prepare("SELECT count(*) AS n FROM meter WHERE tbl = 'codexTurns'").get().n, 0);
  const tgState = sql.prepare("SELECT _id, doc FROM doc_turnStreams WHERE json_extract(doc, '$.turnId') = ?").get(telegram.id);
  assert.equal(JSON.parse(tgState.doc).telegramMessageId, 238);
  await patch(tgState._id, { telegramEditedAt: Date.now() - 2_000 });
  const next = `Reply ${secret}\nmem`.length;
  await append(telegram, next, "ories: abc123");
  await call("codex:streamToTelegram", { id: telegram.id });
  await finish(telegram, { stopped: true });
  await finalize(telegram);
  const delivered = evidence.delivery.length;
  await finalize(telegram);
  assert.equal(evidence.delivery.length, delivered);
  assert.ok(evidence.delivery.some((row) => row.method === "sendMessage"));
  assert.ok(evidence.delivery.some((row) => row.method === "editMessageText" && row.messageId === 238));
  assert.ok(evidence.delivery.every((row) => !String(row.text).includes(secret) && !String(row.text).includes("memories:")));
  assertStreamRemoved(telegram);
  const wa = await fixture("whatsapp");
  await insert("installation", { whatsappOwner: "synthetic" });
  await append(wa, 0, "WhatsApp partial");
  await finish(wa, { stopped: true }); await finalize(wa); await finalize(wa);
  const waRows = runtime.store.all("whatsappOutbox");
  assert.ok(waRows.some((row) => row.text.includes("WhatsApp partial")));
  assertStreamRemoved(wa);
  const completed = await fixture();
  await append(completed, 0, "Complete final reply");
  await finish(completed, { response: "Complete final reply" });
  await finalize(completed); await finalize(completed);
  assertStreamRemoved(completed);
  assert.equal((await get(completed.id)).response, "Complete final reply");
  assert.ok(JSON.stringify(await call("agentStore:listMessages", { threadId: completed.threadId, paginationOpts: { cursor: null, numItems: 100 } })).includes("Complete final reply"));
  evidence.cases.push("Terminal finalization removes stream metadata/chunks for stopped, failed, recovered, Telegram, WhatsApp and successful turns; response/history/replay preserved before orphan pruning");
  evidence.cases.push("Telegram draft send/edit/finalize preserves message ID without heavy turn writes; redaction/footer; WhatsApp final outbox and finalization replay");

  await call("codex:pruneOrphans", { conversationId: wa.conversationId });
  assert.equal(runtime.store.all("turnStreams").filter((row) => row.turnId === wa.id).length, 0);
  assert.equal(runtime.store.all("turnStreamChunks").filter((row) => row.turnId === wa.id).length, 0);
  const cap = await fixture();
  const capStream = createReplyStream((packet) => append(cap, packet.offset, packet.text, packet.reset, packet.resetKey));
  capStream.update("z".repeat(100_100)); await capStream.flush();
  assert.equal((await body(cap)).length, 100_000);
  evidence.cases.push("Orphan stream cleanup and 100k body cap");

  if (process.argv.includes("--lifecycle")) {
    const raceResults = [];
    for (const method of ["sendMessage", "editMessageText", "failedSend", "hangingSend", "rateLimitedSend"]) {
      const race = await fixture("telegram");
      await append(race, 0, "Partial draft");
      if (method === "editMessageText") await call("codex:streamToTelegram", { id: race.id });
      const gate = holdDelivery(method === "editMessageText" ? method : "sendMessage", method);
      const before = evidence.delivery.length;
      const draft = call("codex:streamToTelegram", { id: race.id });
      await gate.started;
      const heldAt = performance.now();
      await finish(race, { response: "Final answer" });
      const final = finalize(race);
      await new Promise(setImmediate);
      const prematureFinalization = (await get(race.id)).finalizedAt !== undefined;
      if (method === "failedSend") gate.fail(new Error("Synthetic held draft failure"));
      gate.release();
      await Promise.all([draft, final]);
      const output = evidence.delivery.slice(before);
      const terminalLast = output.at(-1)?.text === "Final answer";
      const duplicateFirstSend = method === "sendMessage" && output.filter((row) => row.method === "sendMessage").length > 1;
      const count = evidence.delivery.length;
      await call("codex:streamToTelegram", { id: race.id });
      assert.equal(evidence.delivery.length, count, "Queued terminal draft wrote after finalization");
      const boundedDraft = method === "hangingSend" || method === "rateLimitedSend";
      const milliseconds = Math.round(performance.now() - heldAt);
      if (boundedDraft) {
        assert.equal(gate.signal()?.aborted, true, "Draft deadline did not abort");
        assert.ok(milliseconds < 20_000, "Draft deadline failed to bound delivery ordering");
      }
      raceResults.push({ method, prematureFinalization, terminalLast, duplicateFirstSend, ...(boundedDraft ? { aborted: true, milliseconds } : {}) });
    }
    evidence.telegramRaces = raceResults;
    const recursive = await fixture("telegram");
    await append(recursive, 0, "Recursive draft");
    let recursionRejected = false;
    nestedDelivery = async () => {
      await assert.rejects(finalize(recursive), /Recursive delivery for the same turn/);
      recursionRejected = true;
    };
    await call("codex:streamToTelegram", { id: recursive.id });
    assert.equal(recursionRejected, true);
    await finish(recursive, { response: "Final recursive answer" }); await finalize(recursive);
    assert.ok((await get(recursive.id)).finalizedAt);
    evidence.recursiveDeliveryRejectedWithoutDeadlock = recursionRejected;
    const resetRace = await fixture();
    let loseReset = false;
    const resetStream = createReplyStream(async (packet) => {
      const result = await append(resetRace, packet.offset, packet.text, packet.reset, packet.resetKey);
      if (packet.reset && loseReset) { loseReset = false; throw new Error("Synthetic reset ack lost"); }
      return result;
    });
    resetStream.update("Original"); await resetStream.flush();
    const resetSecret = "newly-saved-secret-238";
    loseReset = true;
    resetStream.update(`Reset ${resetSecret}`);
    await assert.rejects(resetStream.flush(), /reset ack lost/);
    await call("vault:save", { label: "Reset synthetic", value: resetSecret, by: "owner", conversationId: resetRace.conversationId });
    resetStream.update(`Reset ${resetSecret} continued`);
    await resetStream.flush();
    const stored = sql.prepare("SELECT doc FROM doc_turnStreamChunks WHERE json_extract(doc, '$.turnId') = ?").all(resetRace.id).map((row) => JSON.parse(row.doc).text).join("");
    evidence.resetAfterScrub = { visible: await body(resetRace), persistedSecretReintroduced: stored.includes(resetSecret) };
    assert.ok(raceResults.every((row) => !row.prematureFinalization && row.terminalLast && !row.duplicateFirstSend), "In-flight Telegram draft raced final delivery");
    assert.equal(evidence.resetAfterScrub.persistedSecretReintroduced, false, "Reset retry resurrected a vault-scrubbed value");
    assert.equal(evidence.resetAfterScrub.visible, "Reset [saved in Logins & secrets] continued");
    const repeatedReset = await fixture();
    const repeated = createReplyStream((packet) => append(repeatedReset, packet.offset, packet.text, packet.reset, packet.resetKey));
    for (const text of ["abcdef", "XYZ", "XYZabc", "XYZ"]) { repeated.update(text); await repeated.flush(); }
    assert.equal(await body(repeatedReset), "XYZ", "A later genuine reset with the same packet must still apply after intervening growth");
    evidence.cases.push("Held Telegram first-send/edit across finish/finalize, queued terminal draft, ambiguous reset retry after real vault scrub");
  }

  await runtime.stop(); sql.close();
  const database = join(home, "restart.sqlite");
  assert.ok(!fs.existsSync(database), "Refuse existing restart fixture");
  await open(database);
  runnerId = await insert("runners", { token, revoked: false, lastSeenAt: Date.now(), turnHeartbeats: true });
  const durable = await fixture();
  await append(durable, 0, "Durable "); await append(durable, 8, "stream");
  await runtime.stop(); sql.close();
  await open(database);
  assert.equal(await body(durable), "Durable stream");
  await finish(durable, { error: "Restart synthetic", errorCode: "offline" });
  await finalize(durable); await finalize(durable);
  assert.equal((await get(durable.id)).response, "Durable stream");
  evidence.cases.push("SQLite close/reopen preserves append body; restart error fallback and finalization replay");
  await runtime.stop(); sql.close(); sql = null;
  for (const suffix of ["", "-wal", "-shm"]) { const path = database + suffix; if (fs.existsSync(path)) fs.unlinkSync(path); }
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  process.exitCode = 1;
} finally {
  client?.close();
  if (runtime) await runtime.stop();
  try { sql?.close(); } catch {}
  globalThis.fetch = realFetch;
  evidence.queryCalls = requests;
  const artifact = join(root, useOverlay ? "evidence.json" : useFollowup ? "evidence-lifecycle-proposal.json" : process.argv.includes("--lifecycle") ? "evidence-lifecycle-integrated.json" : "evidence-integrated.json");
  fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, growth: evidence.growth.map(({ characters, bytes, metadataReruns }) => ({ characters, bytes, metadataReruns })), evidence: artifact }));
}
