// Failure inventory: failure-cases.md. Native trace -> authenticated backend ->
// SQLite outbox -> reservation -> delivery accounting; no model or real phone.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

if (!process.argv[2]) throw Error("Pass a disposable result directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const scratchRoot = resolve(process.env.PERRY_E2E_DIR ?? tmpdir());
mkdirSync(scratchRoot, { recursive: true });
const home = mkdtempSync(join(scratchRoot, "perry-whatsapp-progress-"));
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = "synthetic-whatsapp-progress-key";
process.env.PERRY_CREDENTIAL_KEY = "68".repeat(32);
process.env.PERRY_WHATSAPP_DRIVER = resolve("artifacts/whatsapp/fake-driver.mjs");
process.env.PERRY_WHATSAPP_CONTROL = "http://whatsapp-progress.invalid";
delete process.env.COMPOSIO_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("External network disabled in WhatsApp progress replay"); };
const nativeNow = Date.now;
let clock = nativeNow();
Date.now = () => clock;
const advance = (ms = 60_001) => { clock += ms; };
const OWNER = "15550001111@s.whatsapp.net";
const OTHER = "15550002222@s.whatsapp.net";
const TOKEN = "synthetic-whatsapp-progress-runner";
const report = { ranAt: new Date().toISOString(), passed: false, cases: [], realMessagesSent: 0, modelTurnsStarted: 0, homeRemoved: false };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
let sql, rt;
let restore = () => {};
const check = async (name, work) => {
  try { await work(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error) }); }
  finally { restore(); }
  console.log(JSON.stringify(report.cases.at(-1)));
  save();
};
try {
  const [{ Runtime }, { default: schema }, { modules }, { TurnTrace }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../runner/trace.ts"),
  ]);
  const open = async () => {
    sql = new DatabaseSync(join(home, "perry.sqlite"));
    rt = new Runtime(sql, schema, modules, { storageDir: join(home, "storage") });
    await rt.stop();
  };
  await open();
  const mutate = (name, args = {}) => rt.runMutation(name, args, { internal: true });
  const query = async (name, args = {}) => (await rt.runQuery(name, args, { internal: true })).value;
  const runnerId = await mutate("runner:createToken", { token: TOKEN, name: "Synthetic progress computer" });
  const installation = rt.store.insert("installation", { timezone: "UTC", whatsappOwner: OWNER });
  const link = rt.store.insert("whatsappLink", { mode: "separate", wanted: true, status: "connected", me: "15550003333@s.whatsapp.net" });
  restore = () => {
    rt.store.patch(installation, { paused: undefined, whatsappOwner: OWNER });
    rt.store.patch(link, { wanted: true });
  };
  const threadId = await mutate("agentStore:createThread", { userId: "synthetic-progress-owner" });
  const chat = rt.store.insert("conversations", { channel: "whatsapp", externalId: OWNER, threadId, access: "full", lastMessageAt: clock });
  let sequence = 0;
  const newTurn = (extra = {}, conversationId = chat) => {
    advance(1);
    const runId = rt.store.insert("runs", { conversationId, prompt: "Synthetic progress replay", status: "running", startedAt: clock });
    return rt.store.insert("codexTurns", { runnerId, conversationId, runId, prompt: "Synthetic progress replay", instructions: "Fixture only", status: "running", createdAt: clock, startedAt: clock, ...extra });
  };
  const rows = (turn) => rt.store.all("whatsappOutbox").filter(row => row.progressTurnId === turn);
  const pending = (turn) => rows(turn).filter(row => row.state === "pending");
  const publish = async (turn, text, item = `progress-${++sequence}`) => {
    const trace = new TurnTrace();
    trace.progress(item, text, clock);
    const packet = trace.take();
    await mutate("codex:traceTurn", { token: TOKEN, id: turn, ...packet });
    return packet;
  };
  const reserve = row => mutate("whatsapp:reserveMessageId", { id: row._id });
  const assertRevoked = async row => {
    if (!rt.store.get(row._id)) return;
    assert.equal(await reserve(row), null);
    if (rt.store.get(row._id)) assert.equal(await query("whatsapp:canSend", { id: row._id }), false);
  };
  const send = async (row) => {
    const reservation = await reserve(row);
    assert.equal(typeof reservation?.messageId, "string");
    assert.equal(typeof reservation.text, "string");
    await mutate("whatsapp:sent", { id: row._id });
    return reservation;
  };

  await check("completed provider progress reaches the durable owner outbox through runner trace", async () => {
    const turn = newTurn();
    const packet = await publish(turn, "I found the source deck and am checking the revised outline.");
    assert.equal(packet.spans[0].kind, "commentary");
    assert.equal(packet.spans[0].status, "ok");
    assert.equal(packet.spans[0].progress, true);
    assert.equal(pending(turn).length, 1);
    assert.equal(pending(turn)[0].text, "I found the source deck and am checking the revised outline.");
    assert.equal(pending(turn)[0].turnId, undefined);
  });
  if (typeof TurnTrace.prototype.progress !== "function") throw Error("Baseline: runner trace has no completed-progress path");
  await check("partial text and drained final text never become phone progress", async () => {
    const turn = newTurn();
    const trace = new TurnTrace();
    trace.text("partial", "I am halfway through a", clock);
    await mutate("codex:traceTurn", { token: TOKEN, id: turn, ...trace.take() });
    trace.drain(clock + 1);
    await mutate("codex:traceTurn", { token: TOKEN, id: turn, ...trace.take() });
    assert.equal(rows(turn).length, 0);
    trace.progress("late", "Late progress after a closed turn", clock + 2);
    assert.equal(trace.take(), null);
  });
  await check("reasoning, tool output and child-agent spans cannot publish phone progress", async () => {
    const turn = newTurn();
    for (const [index, fields] of [{ kind: "reasoning" }, { kind: "command" }, { kind: "commentary", agent: "synthetic-child-agent" }].entries()) {
      await mutate("codex:traceTurn", { token: TOKEN, id: turn, spans: [{ callId: `private-span-${index}`, name: "Private trace", status: "ok", startedAt: clock, endedAt: clock, progress: true, output: "Private trace output must not reach WhatsApp.", ...fields }] });
    }
    assert.equal(rows(turn).length, 0);
  });
  await check("repeated packet and duplicate text under a new provider ID do not enqueue twice", async () => {
    const turn = newTurn();
    const packet = await publish(turn, "The source files are checked.", "same-provider-item");
    await mutate("codex:traceTurn", { token: TOKEN, id: turn, ...packet });
    advance();
    await publish(turn, "The source files are checked.");
    assert.equal(rows(turn).length, 1);
    await send(pending(turn)[0]);
    advance();
    await mutate("codex:traceTurn", { token: TOKEN, id: turn, ...packet });
    assert.equal(rows(turn).length, 1);
  });
  await check("rapid updates coalesce to the newest pending text", async () => {
    const turn = newTurn();
    await publish(turn, "The source outline is checked.");
    const first = pending(turn)[0]._id;
    await publish(turn, "The revised outline is ready; I am rendering the slides.");
    assert.equal(pending(turn).length, 1);
    assert.equal(pending(turn)[0]._id, first);
    assert.match(pending(turn)[0].text, /rendering/);
  });
  await check("after a sent update the durable interval prevents flooding", async () => {
    const turn = newTurn();
    await publish(turn, "The first revision is ready.");
    await send(pending(turn)[0]);
    await publish(turn, "The preview is rendering.");
    assert.equal(pending(turn).length, 0);
    advance();
    await publish(turn, "The rendered preview is ready for inspection.");
    assert.equal(pending(turn).length, 1);
  });
  await check("an offline queue's age does not permit back-to-back sends after reconnect", async () => {
    const turn = newTurn();
    await publish(turn, "The first update waited offline.");
    advance(120_000);
    await send(pending(turn)[0]);
    await publish(turn, "A second update arrived just after reconnect.");
    assert.equal(pending(turn).length, 0);
    advance();
    await publish(turn, "The next checked milestone is ready after the send interval.");
    assert.equal(pending(turn).length, 1);
  });
  await check("the per-turn cap bounds long-running phone updates", async () => {
    const turn = newTurn();
    for (let index = 0; index < 9; index++) {
      advance();
      await publish(turn, `Verified production milestone ${index + 1}.`);
      if (pending(turn).length) await send(pending(turn)[0]);
    }
    assert.equal(rows(turn).length, 6);
  });
  await check("empty text and NO_REPLY stay silent and private memory footer is stripped", async () => {
    const turn = newTurn();
    for (const text of ["", "   ", "NO_REPLY", "NO_REPLY\nmemories: fixture-private-id"]) await publish(turn, text);
    assert.equal(rows(turn).length, 0);
    await publish(turn, "I checked the rendered slides.\nmemories: fixture-private-id");
    assert.equal(pending(turn).length, 1);
    assert.ok(!pending(turn)[0].text.includes("memories:"));
    assert.ok(!pending(turn)[0].text.includes("fixture-private-id"));
  });
  await check("bold, italic and fenced code retain their WhatsApp formatting at reservation", async () => {
    const turn = newTurn();
    await publish(turn, "I checked **outline** and *labels*.\n```js\nconst x = '**literal**';\n```\nmemories: fixture-format-private-id\n\n");
    const row = pending(turn)[0];
    const expected = "I checked *outline* and _labels_.\n```const x = '**literal**';```";
    assert.equal(row.text, expected);
    const reservation = await reserve(row);
    assert.equal(reservation.text, expected);
    await mutate("whatsapp:sent", { id: row._id });
  });
  await check("progress text is bounded without splitting a Unicode character", async () => {
    const turn = newTurn();
    await publish(turn, "a".repeat(599) + "😀".repeat(20));
    const text = pending(turn)[0].text;
    assert.ok(Array.from(text).length <= 600);
    assert.equal(text.isWellFormed(), true);
  });
  await check("saved secrets are redacted before enqueue", async () => {
    const secret = "synthetic-progress-preexisting-secret";
    await mutate("vault:save", { label: "Synthetic progress secret", value: secret, by: "owner" });
    const turn = newTurn();
    await publish(turn, `I checked the document containing ${secret}.`);
    assert.ok(!pending(turn)[0].text.includes(secret));
  });
  await check("a secret saved after enqueue is hidden by the atomic send reservation", async () => {
    const secret = "synthetic-progress-newly-saved-secret";
    const turn = newTurn();
    await publish(turn, `I checked the source containing ${secret}.`);
    const row = pending(turn)[0];
    await mutate("vault:save", { label: "Synthetic new progress secret", value: secret, by: "owner" });
    const reservation = await reserve(row);
    assert.equal(typeof reservation.messageId, "string");
    assert.ok(!reservation.text.includes(secret));
    await mutate("whatsapp:sent", { id: row._id });
  });
  await check("saving a secret in the chat removes it from pending durable progress", async () => {
    const secret = "synthetic-progress-chat-hidden-secret";
    const turn = newTurn();
    await publish(turn, `I checked the supplied value ${secret}.`);
    const row = pending(turn)[0];
    await mutate("vault:save", { label: "Synthetic chat progress secret", value: secret, by: "owner", conversationId: chat });
    assert.ok(!rt.store.get(row._id).text.includes(secret));
  });
  for (const extra of [{ checkpoint: true }, { flush: true }, { kind: "compact" }, { guest: true }, { preparation: true }, { stopRequested: true }, { status: "done" }]) {
    await check(`non-owner-facing turn ${Object.keys(extra)[0]} stays silent`, async () => {
      const turn = newTurn(extra);
      await publish(turn, "I am checking the next step.");
      assert.equal(rows(turn).length, 0);
    });
  }
  await check("other channels and guest contacts cannot receive owner progress", async () => {
    for (const extra of [{ channel: "web", externalId: "synthetic-web" }, { externalId: OTHER }, { contactId: "synthetic-guest-contact" }, { jobId: "synthetic-job-chat" }, { taskId: "synthetic-task-chat" }]) {
      const conversationId = rt.store.insert("conversations", { channel: "whatsapp", externalId: OWNER, threadId, lastMessageAt: clock, ...extra });
      const turn = newTurn({}, conversationId);
      await publish(turn, "I am checking an owner file.");
      assert.equal(rows(turn).length, 0);
    }
  });
  await check("Pause and unlink prevent initial progress", async () => {
    const turn = newTurn();
    rt.store.patch(installation, { paused: { at: clock, by: "whatsapp" } });
    await publish(turn, "This must stay paused.");
    assert.equal(rows(turn).length, 0);
    rt.store.patch(installation, { paused: undefined });
    rt.store.patch(link, { wanted: false });
    await publish(turn, "This must stay unlinked.");
    assert.equal(rows(turn).length, 0);
    rt.store.patch(link, { wanted: true });
  });
  for (const change of ["stop", "pause", "owner", "unlink", "finish"]) await check(`queued progress is revoked atomically after ${change}`, async () => {
    const turn = newTurn();
    await publish(turn, `Prepared update before ${change}.`);
    const row = pending(turn)[0];
    assert.ok(row);
    if (change === "stop") rt.store.patch(turn, { stopRequested: true });
    if (change === "pause") rt.store.patch(installation, { paused: { at: clock, by: "web" } });
    if (change === "owner") rt.store.patch(installation, { whatsappOwner: OTHER });
    if (change === "unlink") rt.store.patch(link, { wanted: false });
    if (change === "finish") rt.store.patch(turn, { status: "done", finishedAt: clock });
    await assertRevoked(row);
    rt.store.patch(installation, { paused: undefined, whatsappOwner: OWNER });
    rt.store.patch(link, { wanted: true });
  });
  await check("sending progress cannot finalize delivery or raise final-reply warnings", async () => {
    const turn = newTurn();
    await publish(turn, "The preview is ready.");
    await send(pending(turn)[0]);
    assert.equal(rt.store.get(turn).deliveredAt, undefined);
    advance();
    await publish(turn, "I am checking the final export.");
    const row = pending(turn)[0];
    await reserve(row);
    await mutate("whatsapp:sent", { id: row._id, error: "Synthetic progress transport failure", permanent: true });
    assert.equal(rt.store.get(turn).deliveredAt, undefined);
    assert.equal(rt.store.get(turn).deliveryError, undefined);
    assert.equal(rt.store.get(turn).deliveryNoticeAt, undefined);
  });
  await check("ambiguous progress sends are not replayed by crash recovery", async () => {
    const turn = newTurn();
    await publish(turn, "The export is rendering.");
    const row = pending(turn)[0];
    await reserve(row);
    await mutate("whatsapp:recoverSending");
    assert.equal(rt.store.get(row._id).state, "uncertain");
    assert.equal(await reserve(row), null);
    assert.equal(pending(turn).length, 0);
    assert.equal(rt.store.get(turn).deliveryError, undefined);
  });
  await check("failed or superseded progress never creates an actionable dashboard delivery item", async () => {
    const ordinary = rt.store.insert("whatsappOutbox", { to: OWNER, kind: "text", text: "Ordinary failed owner message", state: "failed", error: "Synthetic ordinary delivery failure", createdAt: clock, attempts: 1 });
    const inbox = await query("dashboard:getInbox", { key: process.env.DASHBOARD_KEY });
    const progressIds = new Set(rt.store.all("whatsappOutbox").filter(row => row.progressTurnId).map(row => row._id));
    assert.ok(inbox.some(item => item.id === ordinary), "ordinary delivery failures remain visible");
    assert.ok(!inbox.some(item => progressIds.has(item.id)));
    rt.store.delete(ordinary);
  });
  await check("final reply queueing drops pending progress and preserves final accounting", async () => {
    const turn = newTurn();
    await publish(turn, "I am reviewing the last slide.");
    const row = pending(turn)[0];
    const args = { turnId: turn, to: OWNER, text: "Here is the checked final result.", files: [] };
    await mutate("whatsapp:queueTurn", args);
    await mutate("whatsapp:queueTurn", args);
    assert.equal(pending(turn).length, 0);
    await assertRevoked(row);
    const finals = rt.store.all("whatsappOutbox").filter(row => row.turnId === turn);
    assert.equal(finals.length, 1);
    assert.equal(typeof await reserve(finals[0]), "string");
    await mutate("whatsapp:sent", { id: finals[0]._id });
    assert.equal(typeof rt.store.get(turn).deliveredAt, "number");
  });
  for (const outcome of ["success", "failure", "uncertain"]) await check(`an identical final waits for in-flight progress outcome ${outcome}`, async () => {
    const turn = newTurn();
    const text = "I checked **the source**.";
    await publish(turn, text);
    const row = pending(turn)[0];
    await reserve(row);
    const args = { turnId: turn, to: OWNER, text, files: [] };
    await mutate("whatsapp:queueTurn", args);
    await mutate("whatsapp:queueTurn", args);
    assert.equal(rt.store.all("whatsappOutbox").filter(item => item.turnId === turn && item.state === "pending").length, 0);
    assert.equal(rt.store.get(turn).deliveredAt, undefined);
    await mutate("whatsapp:sent", { id: row._id, ...(outcome !== "success" ? { error: "Synthetic in-flight failure", ...(outcome === "uncertain" ? { uncertain: true } : { permanent: true }) } : {}) });
    const finals = rt.store.all("whatsappOutbox").filter(item => item.turnId === turn);
    assert.equal(finals.length, 1);
    if (outcome === "success") {
      assert.equal(finals[0]._id, row._id); assert.equal(finals[0].state, "sent");
      assert.equal(typeof rt.store.get(turn).deliveredAt, "number");
    } else if (outcome === "failure") {
      assert.equal(finals[0].state, "pending"); assert.equal(finals[0].text, "I checked *the source*.");
      assert.equal(typeof await reserve(finals[0]), "string");
      await mutate("whatsapp:sent", { id: finals[0]._id });
      assert.equal(typeof rt.store.get(turn).deliveredAt, "number");
    } else {
      assert.equal(finals[0].state, "uncertain"); assert.equal(rt.store.get(turn).deliveredAt, undefined);
      assert.ok(rt.store.get(turn).deliveryError);
    }
  });
  await check("a sent progress message reused as the final fallback is delivered only once", async () => {
    const turn = newTurn();
    const text = "The checked **outline** is ready.";
    await publish(turn, text);
    const progress = pending(turn)[0];
    await send(progress);
    const sentAt = rt.store.get(progress._id).sentAt;
    advance(10);
    const args = { turnId: turn, to: OWNER, text, files: [] };
    await mutate("whatsapp:queueTurn", args);
    await mutate("whatsapp:queueTurn", args);
    const associated = rt.store.all("whatsappOutbox").filter(row => row.turnId === turn || row.progressTurnId === turn);
    assert.equal(associated.length, 1);
    assert.equal(associated[0]._id, progress._id);
    assert.equal(associated[0].state, "sent");
    assert.equal(associated[0].turnId, turn);
    assert.equal(associated[0].progressTurnId, undefined);
    assert.equal(rt.store.get(turn).deliveredAt, sentAt);
    assert.equal(typeof rt.store.get(turn).outgoingQueuedAt, "number");
  });
  await check("distinct final text still queues and unsent identical progress produces one final send", async () => {
    for (const alreadySent of [false, true]) {
      const turn = newTurn();
      const text = "The checked export is ready.";
      await publish(turn, text);
      if (alreadySent) await send(pending(turn)[0]);
      await mutate("whatsapp:queueTurn", { turnId: turn, to: OWNER, text: alreadySent ? "Here is the final checked export and its verification." : text, files: [] });
      const final = rt.store.all("whatsappOutbox").filter(row => row.turnId === turn);
      assert.equal(final.length, 1);
      assert.equal(final[0].state, "pending");
      assert.equal(pending(turn).length, 0);
      assert.equal(rt.store.get(turn).deliveredAt, undefined);
    }
  });
  await check("an unconfirmed identical progress send cannot be promoted as a delivered final reply", async () => {
    const turn = newTurn();
    const text = "The checked export is ready for review.";
    await publish(turn, text);
    const row = pending(turn)[0];
    await reserve(row);
    await mutate("whatsapp:sent", { id: row._id, error: "Synthetic acknowledgement loss", uncertain: true });
    await mutate("whatsapp:queueTurn", { turnId: turn, to: OWNER, text, files: [] });
    assert.equal(rt.store.get(row._id).state, "uncertain");
    assert.equal(rt.store.get(row._id).progressTurnId, turn);
    const finals = rt.store.all("whatsappOutbox").filter(row => row.turnId === turn);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].state, "pending");
    assert.equal(rt.store.get(turn).deliveredAt, undefined);
  });
  await check("a final attachment is preserved even when its text matches sent progress", async () => {
    const turn = newTurn();
    const text = "The checked export and its file are ready.";
    await publish(turn, text);
    await send(pending(turn)[0]);
    await mutate("whatsapp:queueTurn", { turnId: turn, to: OWNER, text, files: [{ localPath: join(home, "synthetic-export.pdf"), fileName: "checked-export.pdf", contentType: "application/pdf" }] });
    const finals = rt.store.all("whatsappOutbox").filter(row => row.turnId === turn);
    assert.equal(finals.length, 2);
    assert.ok(finals.some(row => row.kind === "text"));
    assert.ok(finals.some(row => row.kind === "file" && row.file.fileName === "checked-export.pdf"));
    assert.equal(rt.store.get(turn).deliveredAt, undefined);
  });
  await check("SQLite restart preserves progress deduplication and the rate interval", async () => {
    const turn = newTurn();
    const packet = await publish(turn, "The source reconciliation is complete.", "restart-progress");
    await send(pending(turn)[0]);
    await rt.stop(); sql.close();
    await open();
    await mutate("codex:traceTurn", { token: TOKEN, id: turn, ...packet });
    await publish(turn, "A new milestone arrived too soon.");
    assert.equal(rows(turn).length, 1);
    assert.equal(pending(turn).length, 0);
    advance();
    await publish(turn, "The next verification milestone is complete.");
    assert.equal(rows(turn).length, 2);
  });
  await check("production WhatsApp transport reconciles a final arriving before the progress acknowledgement", async () => {
    for (const row of rt.store.all("whatsappOutbox")) if (row.state === "pending") rt.store.delete(row._id);
    const turn = newTurn();
    const text = "I checked **the complete source**.";
    await publish(turn, text);
    const commands = [{ user: { id: "15550003333@s.whatsapp.net" }, event: "connection.update", data: { connection: "open" } }];
    const sent = [];
    globalThis.fetch = async (input, options) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("http://whatsapp-progress.invalid/")) throw Error("Unexpected external request");
      if (url.endsWith("/next")) {
        if (!commands.length) await new Promise(done => setTimeout(done, 50));
        return Response.json(commands.splice(0));
      }
      if (url.endsWith("/sent")) {
        sent.push(JSON.parse(options.body));
        if (sent.length === 1) {
          assert.equal(rows(turn)[0].state, "sending");
          await mutate("whatsapp:queueTurn", { turnId: turn, to: OWNER, text, files: [] });
          assert.equal(rt.store.get(turn).deliveredAt, undefined);
        }
      }
      return Response.json(true);
    };
    const { runWhatsApp } = await import("../../server/whatsapp.ts");
    const stop = runWhatsApp(rt);
    try {
      const until = nativeNow() + 10_000;
      while (!rt.store.get(turn).deliveredAt && nativeNow() < until) await new Promise(done => setTimeout(done, 50));
      assert.equal(typeof rt.store.get(turn).deliveredAt, "number");
      assert.equal(sent.length, 1); assert.equal(sent[0].text, "I checked *the complete source*.");
    } finally {
      await stop();
      globalThis.fetch = async () => { throw Error("External network disabled in WhatsApp progress replay"); };
    }
  });
  for (const scenario of ["coalesce", "finalize"]) await check(scenario === "coalesce"
    ? "production WhatsApp transport sends the current redacted reservation instead of its stale snapshot"
    : "production WhatsApp transport skips a superseded snapshot update and sends the final reply", async () => {
    for (const row of rt.store.all("whatsappOutbox")) if (row.state === "pending") rt.store.delete(row._id);
    const turn = newTurn();
    const secret = "synthetic-progress-transport-late-secret";
    await publish(turn, `I found the first outline with ${secret}.`);
    const row = pending(turn)[0];
    const commands = [{ user: { id: "15550003333@s.whatsapp.net" }, event: "connection.update", data: { connection: "open" } }];
    const sent = [];
    globalThis.fetch = async (input, options) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("http://whatsapp-progress.invalid/")) throw Error("Unexpected external request in progress transport replay");
      if (url.endsWith("/next")) {
        if (!commands.length) await new Promise(done => setTimeout(done, 50));
        return Response.json(commands.splice(0));
      }
      if (url.endsWith("/sent")) sent.push(JSON.parse(options.body));
      return Response.json(true);
    };
    const originalQuery = rt.runQuery.bind(rt);
    let changedAfterSnapshot = false;
    const finalArgs = { turnId: turn, to: OWNER, text: "The checked final deck is ready.", files: [] };
    rt.runQuery = async (...args) => {
      const value = await originalQuery(...args);
      if (args[0] === "whatsapp:pending" && !changedAfterSnapshot && value.value.some(item => item._id === row._id)) {
        changedAfterSnapshot = true;
        if (scenario === "coalesce") {
          await publish(turn, `The revised outline is verified with ${secret}.`);
          await mutate("vault:save", { label: "Synthetic transport late secret", value: secret, by: "owner" });
        } else await mutate("whatsapp:queueTurn", finalArgs);
      }
      return value;
    };
    const { runWhatsApp } = await import("../../server/whatsapp.ts");
    const stop = runWhatsApp(rt);
    try {
      const until = nativeNow() + 10_000;
      while (!sent.length && nativeNow() < until) await new Promise(done => setTimeout(done, 50));
      assert.equal(changedAfterSnapshot, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].jid, OWNER);
      if (scenario === "finalize") {
        assert.equal(sent[0].text, finalArgs.text);
        return;
      }
      assert.match(sent[0].text, /revised outline is verified/);
      assert.ok(!sent[0].text.includes(secret));
      assert.equal(rt.store.get(turn).deliveredAt, undefined);
      await mutate("whatsapp:queueTurn", finalArgs);
      while (sent.length < 2 && nativeNow() < until) await new Promise(done => setTimeout(done, 50));
      assert.equal(sent.length, 2);
      assert.equal(sent[1].text, finalArgs.text);
    } finally {
      await stop();
      rt.runQuery = originalQuery;
      globalThis.fetch = async () => { throw Error("External network disabled in WhatsApp progress replay"); };
    }
  });
} finally {
  Date.now = nativeNow;
  if (rt) await rt.stop();
  if (sql) sql.close();
  globalThis.fetch = nativeFetch;
  if (!resolve(home).startsWith(scratchRoot + sep)) throw Error("Fixture cleanup escaped its temporary root");
  rmSync(home, { recursive: true, force: true });
  report.homeRemoved = !existsSync(home);
  report.passed = report.cases.length > 0 && report.cases.every(item => item.passed);
  save();
}
if (!report.passed) process.exitCode = 1;
