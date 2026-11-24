import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (!process.argv[2]) throw new Error("Pass a disposable output directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const report = { passed: false, cases: [], telegram: [] };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
const scratch = mkdtempSync(join(tmpdir(), "perry-job-files-"));
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = "synthetic-job-files-key";
process.env.PERRY_CREDENTIAL_KEY = "38".repeat(32);
process.env.TELEGRAM_BOT_TOKEN = "999:synthetic";
let rejectFile;
let rejectText = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const method = String(url).match(/\/bot[^/]+\/(\w+)$/)?.[1];
  if (!method) throw new Error(`External IO disabled: ${url}`);
  const body = init?.body instanceof FormData
    ? Object.fromEntries([...init.body].map(([key, value]) => [key, typeof value === "string" ? value : { name: value.name, size: value.size }]))
    : JSON.parse(init?.body ?? "{}");
  report.telegram.push({ method, body });
  if (rejectText && method === "sendMessage") return Response.json({ ok: false, error_code: 400, description: "synthetic text refusal" });
  if (rejectFile && Object.values(body).some(value => value?.name === rejectFile)) return Response.json({ ok: false, error_code: 400, description: "synthetic file refusal" });
  return Response.json({ ok: true, result: { message_id: 5000 + report.telegram.length } });
};
process.env.TELEMETRY_DISABLED = "true";
const [{ Runtime }, { default: schema }, { modules }, { default: http }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../convex/http.ts"),
]);
const sql = new DatabaseSync(":memory:");
const runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage"), http });
const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const all = table => runtime.exclusive(() => runtime.store.query(table).collect());
const OWNER = "100@s.whatsapp.net";
const token = "synthetic-job-files-runner";
let installation;
let whatsappLink;
const takeScheduled = async name => {
  const rows = sql.prepare("SELECT id, args FROM _scheduled WHERE name = ? ORDER BY createdAt, rowid").all(name);
  for (const row of rows) {
    sql.prepare("DELETE FROM _scheduled WHERE id = ?").run(row.id);
    await call(name, JSON.parse(row.args));
  }
};
const run = async ({ channel = "whatsapp", files = ["s01.png", "s02.png", "s03.png"], response = "Slides prepared.", origin = true, stopped = false, beforeFinish } = {}) => {
  await patch(installation, { homeChannel: channel === "web" ? "whatsapp" : channel });
  const externalId = channel === "whatsapp" ? OWNER : channel === "telegram" ? "42" : "synthetic-web-origin";
  const existing = (await all("conversations")).find(row => row.channel === channel && row.externalId === externalId);
  const originId = origin ? existing?._id ?? await insert("conversations", { threadId: await call("agentStore:createThread"), channel, externalId, createdAt: Date.now() }) : undefined;
  const created = await call("jobs:create", { name: "Slides", prompt: "Prepare slides", at: new Date(Date.now() + 3600_000).toISOString(), ...(originId ? { origin: originId } : {}) });
  await call("jobs:run", { id: created.id });
  const job = await get(created.id);
  await takeScheduled("brain:handleTurn");
  const turn = (await all("codexTurns")).find(row => row.conversationId === job.conversationId);
  const claimed = await call("codex:claimTurn", { token, id: turn._id });
  assert.ok(claimed);
  for (const file of files) {
    const path = join(scratch, file);
    if (!file.startsWith("missing")) writeFileSync(path, `synthetic:${file}`);
    const response = await runtime.runHttp("/mcp", new Request(`http://synthetic/mcp?turn=${turn._id}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-perry-chat": job.conversationId, "x-perry-turn": turn._id, "x-perry-grant": claimed.mcpGrant },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "share_file", arguments: { path } } }),
    }));
    const answer = await response.json();
    assert.equal(response.status, 200, JSON.stringify(answer));
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    assert.equal(answer.result?.isError, undefined, JSON.stringify(answer));
    const shared = JSON.parse(answer.result.content[0].text);
    assert.equal(shared.delivery, "pending");
    assert.equal(shared.shared, undefined);
  }
  if (beforeFinish) await beforeFinish(turn);
  await call("codex:finishTurn", { token, id: turn._id, response, ...(stopped ? { stopped } : {}) });
  await call("codex:finalizeTurn", { id: turn._id });
  await takeScheduled("notify:deliver");
  const receipt = (await all("sent")).find(row => row.fromId === created.id);
  return { jobId: created.id, turnId: turn._id, receipt, originId };
};
const check = async (name, work) => {
  try { await work(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error), stack: error.stack }); }
  save();
};
const pendingFor = id => all("whatsappOutbox").then(rows => rows.filter(row => row.notificationId === id));
try {
  installation = await insert("installation", { defaultEngine: "codex", onboarding: "skipped", claimedAt: Date.now(), whatsappOwner: OWNER, ownerChannel: "telegram", ownerExternalId: "42", createdAt: Date.now() });
  whatsappLink = await insert("whatsappLink", { mode: "separate", wanted: true, status: "connected", updatedAt: Date.now() });
  await insert("runners", { name: "Synthetic runner", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  await check("WhatsApp job queues ordered files and waits for transport acknowledgement", async () => {
    const r = await run({ response: "Slides prepared.\n" + "x".repeat(9000), files: ["s01.png", "s02.png", "s01.png", "s03.png"] });
    assert.equal(r.receipt.deliveryState, "sending");
    const rows = await pendingFor(r.receipt._id);
    assert.deepEqual(rows.filter(row => row.file).map(row => row.file.fileName), ["s01.png", "s02.png", "s03.png"]);
    const ordered = (await call("whatsapp:pending")).filter(row => row.notificationId === r.receipt._id);
    assert.ok(ordered.slice(0, -3).every(row => row.kind === "text"));
    for (const row of rows.slice(0, -1)) await call("whatsapp:sent", { id: row._id });
    assert.equal((await get(r.receipt._id)).deliveryState, "sending");
    await call("whatsapp:sent", { id: rows.at(-1)._id });
    assert.equal((await get(r.receipt._id)).deliveryState, "delivered");
    const before = (await all("whatsappOutbox")).length;
    await call("codex:finalizeTurn", { id: r.turnId });
    await takeScheduled("notify:deliver");
    assert.equal((await all("whatsappOutbox")).length, before);
    assert.match((await get(r.jobId)).lastResult, /^Files delivered/);
    await call("jobs:finished", { id: r.jobId, result: "Slides prepared.", turnId: r.turnId });
    await takeScheduled("notify:deliver");
    assert.equal((await all("whatsappOutbox")).length, before);
  });
  await check("Telegram job sends local file bytes in order before its summary", async () => {
    const before = report.telegram.length;
    const r = await run({ channel: "telegram" });
    assert.equal(r.receipt.deliveryState, "delivered");
    const sent = report.telegram.slice(before);
    assert.deepEqual(sent.filter(row => row.method === "sendPhoto").map(row => row.body.photo.name), ["s01.png", "s02.png", "s03.png"]);
    assert.equal(sent.at(-1).method, "sendMessage");
  });
  await check("quiet hours retain files until release", async () => {
    await patch(installation, { quietHours: { start: "00:00", end: "23:59" } });
    const r = await run();
    assert.equal(r.receipt.deliveryState, "held");
    assert.equal((await pendingFor(r.receipt._id)).length, 0);
    await patch(installation, { quietHours: undefined });
    await call("notify:releaseHeld");
    assert.equal((await pendingFor(r.receipt._id)).filter(row => row.file).length, 3, JSON.stringify(r.receipt));
  });
  await check("WhatsApp permanent failure updates receipt and job and names the file", async () => {
    const r = await run();
    const rows = await pendingFor(r.receipt._id);
    assert.equal(rows.filter(row => row.file).length, 3);
    const failed = rows.find(row => row.file?.fileName === "s02.png");
    await call("whatsapp:sent", { id: failed._id, error: "synthetic rejection" });
    assert.equal((await get(r.receipt._id)).deliveryState, "sending");
    await call("whatsapp:sent", { id: failed._id, error: "synthetic rejection" });
    await call("whatsapp:sent", { id: failed._id, error: "synthetic rejection" });
    assert.equal((await get(r.receipt._id)).deliveryState, "failed");
    assert.match((await get(r.jobId)).lastError, /s02.png/);
    assert.match((await get(r.jobId)).lastResult, /Could not send s02.png/);
    assert.ok((await all("whatsappOutbox")).some(row => row.kind === "text" && /Could not send s02.png/.test(row.text)));
    for (const row of rows.filter(row => row !== failed)) await call("whatsapp:sent", { id: row._id });
    assert.equal((await get(r.receipt._id)).deliveryState, "failed");
    assert.equal(typeof (await get(r.receipt._id)).sentAt, "number", "partial WhatsApp delivery still counts against the daily limit");
  });
  await check("multiple held runs retain separate receipts and share order", async () => {
    await patch(installation, { dailyLimit: 1 });
    const first = await run({ files: ["a01.png", "a02.png"] });
    const second = await run({ files: ["b01.png", "b02.png"] });
    assert.equal(first.receipt.deliveryState, "held");
    assert.equal(second.receipt.deliveryState, "held");
    await patch(installation, { dailyLimit: undefined });
    await call("notify:releaseHeld");
    assert.deepEqual((await pendingFor(first.receipt._id)).filter(row => row.file).map(row => row.file.fileName), ["a01.png", "a02.png"]);
    assert.deepEqual((await pendingFor(second.receipt._id)).filter(row => row.file).map(row => row.file.fileName), ["b01.png", "b02.png"]);
    await patch(first.receipt._id, { reservedAt: Date.now() - 10 * 60_000 });
    await call("notify:recoverDeliveries");
    assert.equal((await get(first.receipt._id)).deliveryState, "sending", "offline WhatsApp remains queued");
  });
  await check("stored Library attachments and generated images reach Telegram", async () => {
    const stored = await runtime.storeFile(new Blob(["synthetic library"], { type: "application/pdf" }));
    const before = report.telegram.length;
    const r = await run({ channel: "telegram", files: [], beforeFinish: async turn => {
      const libraryId = await insert("library", { name: "guide.pdf", contentType: "application/pdf", kind: "document", size: 17, storageId: stored, createdAt: Date.now(), updatedAt: Date.now() });
      await call("media:shareFromLibrary", { turnId: turn._id, id: libraryId });
      // Engine-generated images use the same turn attachment rows.
      await insert("chatAttachments", { conversationId: turn.conversationId, messageKey: `codex-${turn._id}`, storageId: stored, fileName: "generated.png", contentType: "image/png", size: 17, createdAt: Date.now() });
    } });
    assert.equal(r.receipt.deliveryState, "delivered");
    assert.deepEqual(report.telegram.slice(before).filter(row => row.method !== "sendMessage").map(row => row.body.document?.name ?? row.body.photo?.name), ["guide.pdf", "generated.png"]);
  });
  await check("removed attachments are omitted and oversized files fail before upload", async () => {
    const before = report.telegram.length;
    const r = await run({ channel: "telegram", files: ["removed.png", "oversize.png", "s03.png"], beforeFinish: async turn => {
      const removed = (await all("chatAttachments")).find(row => row.messageKey === `codex-${turn._id}` && row.fileName === "removed.png");
      await patch(removed._id, { removedAt: Date.now() });
      truncateSync(join(scratch, "oversize.png"), 51 * 1024 * 1024);
    } });
    assert.equal(r.receipt.deliveryState, "failed");
    const sent = report.telegram.slice(before);
    assert.deepEqual(sent.filter(row => row.method === "sendPhoto").map(row => row.body.photo.name), ["s03.png"]);
    assert.match((await get(r.jobId)).lastError, /oversize.png/);
  });
  await check("text-only and quiet jobs keep their existing behavior", async () => {
    const text = await run({ files: [] });
    assert.equal(text.receipt.deliveryState, "delivered");
    const quiet = await run({ files: [], response: "NOTHING" });
    assert.equal(quiet.receipt, undefined);
    const files = await run({ response: "NOTHING" });
    assert.equal((await pendingFor(files.receipt._id)).filter(row => row.file).length, 3);
  });
  await check("a late failure does not replace a newer job run's report", async () => {
    const r = await run();
    const rows = await pendingFor(r.receipt._id);
    await patch(r.jobId, { lastRunAt: Date.now() + 1000, lastResult: "Newer run", lastError: undefined });
    const failed = rows.find(row => row.file);
    for (let i = 0; i < 3; i++) await call("whatsapp:sent", { id: failed._id, error: "synthetic rejection" });
    assert.equal((await get(r.jobId)).lastResult, "Newer run");
    assert.equal((await get(r.jobId)).lastError, undefined);
    assert.equal((await get(r.receipt._id)).deliveryState, "failed");
  });
  await check("a changed recipient cannot receive an earlier held run's files", async () => {
    await patch(installation, { quietHours: { start: "00:00", end: "23:59" } });
    const r = await run();
    await patch(installation, { quietHours: undefined, whatsappOwner: "200@s.whatsapp.net" });
    await call("notify:releaseHeld");
    assert.equal((await pendingFor(r.receipt._id)).length, 0);
    assert.equal((await get(r.receipt._id)).deliveryState, "failed");
    assert.match((await get(r.jobId)).lastError, /not delivered/);
    await patch(installation, { whatsappOwner: OWNER, dailyLimit: undefined });
  });
  await check("missing and API-refused Telegram files are reported while later files arrive", async () => {
    rejectFile = "s02.png";
    const r = await run({ channel: "telegram", files: ["missing.png", "s02.png", "s03.png"] });
    rejectFile = undefined;
    assert.equal((await get(r.receipt._id)).deliveryState, "failed");
    assert.match((await get(r.jobId)).lastError, /missing.png/);
    assert.ok(report.telegram.some(row => row.method === "sendMessage" && /Could not send missing.png/.test(row.body.text)));
    assert.ok(report.telegram.some(row => row.method === "sendPhoto" && row.body.photo?.name === "s03.png"));
  });
  await check("file-only default-channel job delivers and stopped job stays silent", async () => {
    const r = await run({ origin: false, response: "" });
    assert.equal((await pendingFor(r.receipt._id)).filter(row => row.file).length, 3, JSON.stringify(r.receipt));
    const stopped = await run({ stopped: true });
    assert.equal(stopped.receipt, undefined);
  });
  await check("web origin keeps attachments in its delivered chat", async () => {
    const r = await run({ channel: "web" });
    assert.equal(r.receipt.deliveryState, "delivered");
    const attachments = (await all("chatAttachments")).filter(row => row.conversationId === r.originId);
    assert.equal(attachments.length, 3);
  });
  await check("partial Telegram delivery keeps its daily-limit slot; unsent text releases it", async () => {
    for (const row of await all("sent")) await patch(row._id, { sentAt: undefined, reservedAt: undefined });
    await patch(installation, { dailyLimit: 1 });
    const partial = await run({ channel: "telegram", files: ["missing-quota.png"] });
    assert.equal(partial.receipt.deliveryState, "failed");
    const later = await run({ channel: "telegram", files: [] });
    assert.equal(later.receipt.deliveryState, "held");
    await patch(installation, { dailyLimit: undefined });
    await call("notify:releaseHeld");
    for (const row of await all("sent")) await patch(row._id, { sentAt: undefined, reservedAt: undefined });
    rejectText = true;
    const unsent = await run({ channel: "telegram", files: [] });
    rejectText = false;
    assert.equal(unsent.receipt.deliveryState, "failed");
    await patch(installation, { dailyLimit: 1 });
    assert.equal((await run({ channel: "telegram", files: [] })).receipt.deliveryState, "delivered");
    await patch(installation, { dailyLimit: undefined });
  });
  for (const change of ["unlink", "logged-out", "replacement"]) await check(`${change} revokes pending WhatsApp files and their receipts`, async () => {
    await patch(installation, { whatsappOwner: OWNER });
    await patch(whatsappLink, { mode: change === "replacement" ? "self" : "separate", wanted: true });
    const r = await run();
    const snapshot = await pendingFor(r.receipt._id);
    if (change === "unlink") await call("whatsapp:unlink", { key: process.env.DASHBOARD_KEY });
    else await call("whatsapp:report", change === "logged-out" ? { status: "logged-out" } : { status: "connected", me: "200@s.whatsapp.net" });
    assert.ok((await pendingFor(r.receipt._id)).every(row => row.state === "failed"));
    assert.equal((await get(r.receipt._id)).deliveryState, "failed");
    for (const row of snapshot) assert.equal(await call("whatsapp:canSend", { id: row._id }), false);
    assert.match((await get(r.jobId)).lastError, /Could not send/);
    await patch(installation, { whatsappOwner: OWNER });
  });
  await check("real WhatsApp outbox preserves ambiguous sends, accepts late receipts and tears down its connection", async () => {
    for (const row of await all("whatsappOutbox")) await runtime.exclusive(() => runtime.store.delete(row._id));
    const r = await run({ files: ["wire01.png", "wire02.png", "wire03.png"] });
    process.env.PERRY_WHATSAPP_DRIVER = fileURLToPath(new URL("./whatsapp-driver.mjs", import.meta.url));
    const driver = await import("./whatsapp-driver.mjs");
    driver.failures.set("wire02.png", 1);
    await patch(whatsappLink, { mode: "separate", wanted: true, status: "connected", updatedAt: Date.now() });
    const { runWhatsApp } = await import("../../server/whatsapp.ts");
    const listeners = runtime.events.listenerCount("change");
    const stop = runWhatsApp(runtime);
    try {
      const deadline = Date.now() + 20_000;
      while ((await get(r.receipt._id)).deliveryState === "sending" && Date.now() < deadline) await delay(25);
      assert.equal((await get(r.receipt._id)).deliveryState, "uncertain");
      const remainingDeadline = Date.now() + 10_000;
      while ((await pendingFor(r.receipt._id)).some(row => row.state === "pending" || row.state === "sending") && Date.now() < remainingDeadline) await delay(25);
      assert.deepEqual(driver.attempts.filter(row => row.name !== "text").map(row => row.name), ["wire01.png", "wire02.png", "wire03.png"], "an ambiguous wire result must not resend the file");
      const ambiguous = (await pendingFor(r.receipt._id)).find(row => row.file?.fileName === "wire02.png");
      assert.equal(ambiguous.state, "uncertain");
      driver.sockets.at(-1).ev.emit("messages.update", [{ key: { id: ambiguous.messageId, remoteJid: OWNER }, update: { status: 3 } }]);
      const receiptDeadline = Date.now() + 10_000;
      while ((await get(r.receipt._id)).deliveryState !== "delivered" && Date.now() < receiptDeadline) await delay(25);
      assert.equal((await get(r.receipt._id)).deliveryState, "delivered");
      const missing = await run({ files: ["wire01.png", "missing-wire.png", "wire03.png"] });
      const failureDeadline = Date.now() + 20_000;
      while ((await pendingFor(missing.receipt._id)).some(row => row.state === "pending") && Date.now() < failureDeadline) await delay(25);
      assert.equal((await get(missing.receipt._id)).deliveryState, "failed");
      assert.match((await get(missing.jobId)).lastError, /missing-wire.png/);
      assert.deepEqual(driver.attempts.filter(row => row.name !== "text").map(row => row.name), ["wire01.png", "wire02.png", "wire03.png", "wire01.png", "wire03.png"]);
      const emptyDeadline = Date.now() + 10_000;
      while ((await call("whatsapp:pending")).length && Date.now() < emptyDeadline) await delay(25);
      const beforeRevocation = driver.attempts.length;
      driver.hooks.afterSend = async () => {
        driver.hooks.afterSend = undefined;
        await call("whatsapp:report", { status: "logged-out" });
      };
      const revoked = await run({ files: ["private01.png", "private02.png"] });
      const revokedDeadline = Date.now() + 10_000;
      while ((await get(revoked.receipt._id)).deliveryState === "sending" && Date.now() < revokedDeadline) await delay(25);
      await delay(1100);
      assert.equal((await get(revoked.receipt._id)).deliveryState, "failed");
      assert.ok(driver.attempts.slice(beforeRevocation).every(row => row.name === "text"), "a stale flush snapshot must not send the revoked files");
      report.whatsapp = driver.attempts;
    } finally {
      driver.hooks.afterSend = undefined;
      await stop();
    }
    assert.equal(runtime.events.listenerCount("change"), listeners);
    assert.ok(driver.sockets.every(socket => socket.ev.eventNames().length === 0));
  });
  report.passed = report.cases.every(row => row.passed);
} finally {
  save();
  await runtime.stop();
  sql.close();
  globalThis.fetch = originalFetch;
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep) && scratch.includes("perry-job-files-"));
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(({ name, passed, error }) => ({ name, passed, error })) }, null, 2));
if (!report.passed) process.exitCode = 1;
