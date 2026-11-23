import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Pass a disposable output directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const report = { at: new Date().toISOString(), passed: false, cases: [] };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
const originalFetch = globalThis.fetch;
let scratch, sql, runtime, server;
try {
  scratch = mkdtempSync(join(tmpdir(), "perry-worker-webhook-"));
  process.env.PERRY_HOME = scratch;
  process.env.DASHBOARD_KEY = "synthetic-worker-dashboard-key";
  process.env.PERRY_CREDENTIAL_KEY = "35".repeat(32);
  globalThis.fetch = (input, init) => {
    const destination = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (destination.hostname !== "127.0.0.1") throw new Error("External IO disabled for webhook replay");
    return originalFetch(input, init);
  };
  const [{ Runtime }, { default: schema }, { modules }, { workerRequest }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"),
    import("../../server/modules.ts"), import("../../server/worker-webhook.ts"),
  ]);
  sql = new DatabaseSync(join(scratch, "test.sqlite"));
  runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage") });
  const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
  const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
  const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
  const rows = table => runtime.exclusive(() => runtime.store.query(table).collect());
  let dropNextReply = false;
  let truncateNextReply = false;
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await workerRequest(new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers: req.headers, body: Buffer.concat(chunks),
    }), runtime);
    if (dropNextReply) { dropNextReply = false; res.destroy(); return; }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (truncateNextReply) { truncateNextReply = false; res.write('{"eventId":'); setTimeout(() => res.destroy(), 30); return; }
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.PERRY_PORT = String(server.address().port);
  const post = async (body, token, extra = {}) => {
    const response = await fetch(`${url}/api/workers/notify`, { method: "POST", headers: {
      "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra,
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const cli = args => new Promise((done, reject) => {
    const child = spawn(process.env.PERRY_TEST_BUN ?? "bun", [join(repo, "scripts/perry.ts"), ...args], {
      cwd: scratch, env: process.env, windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    child.on("error", reject);
    child.on("exit", code => done({ code, output }));
  });
  const shellCommand = command => new Promise((done, reject) => {
    const executable = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
    const child = spawn(executable, args, { cwd: scratch, env: { ...process.env, PATH: `${join(scratch, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` }, windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    child.on("error", reject); child.on("exit", code => done({ code, output }));
  });
  const check = async (name, fn) => {
    try { await fn(); report.cases.push({ name, passed: true }); }
    catch (error) { report.cases.push({ name, passed: false, error: String(error) }); }
  };
  let installation, chat;
  const result = join(scratch, "result ' & $ with spaces.md");
  writeFileSync(result, "Implemented the worker webhook.\nVerified HTTP, SQLite and retries.\n");
  const body = { eventId: "manual-1", name: "test worker", result, text: readFileSync(result, "utf8") };
  installation = await insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now() });
  const threadId = await call("agentStore:createThread", {});
  chat = await call("conversations:create", { channel: "web", externalId: "session:worker-origin", threadId, title: "Worker origin" });
  await check("HTTP rejects unauthenticated, cross-site and invalid events", async () => {
    assert.equal((await post(body)).status, 401);
    assert.equal((await post(body, "wrong")).status, 401);
    assert.equal((await post(body, null, { "x-perry-key": process.env.DASHBOARD_KEY, origin: "https://evil.example" })).status, 403);
    assert.equal((await post({}, null, { "x-perry-key": process.env.DASHBOARD_KEY })).status, 400);
    const response = await fetch(`${url}/api/workers/notify`, { method: "POST", body: "{" });
    assert.equal(response.status, 400);
    assert.equal((await post({ ...body, text: "x".repeat(300_000) }, null, { "x-perry-key": process.env.DASHBOARD_KEY })).status, 413);
    assert.equal((await rows("workerEvents")).length, 0);
  });
  let registration;
  await check("register helper returns a scoped executable command", async () => {
    registration = await call("workers:register", { name: body.name, result, conversationId: chat });
    assert.ok(registration.command.includes("perry notify"));
    assert.ok(registration.command.includes("--completion"));
    assert.ok(!registration.command.includes(process.env.DASHBOARD_KEY));
    const saved = (await rows("workers"))[0];
    assert.ok(saved.tokenHash && !JSON.stringify(saved).includes(registration.token));
  });
  await check("scoped token cannot change its registration", async () => {
    for (const change of [{ name: "other" }, { result: result + ".other" }, { eventId: "other" }, { chat }, { ask: "new question" }]) {
      assert.equal((await post({ ...body, eventId: registration.eventId, ...change }, registration.token)).status, 403);
    }
    assert.equal((await rows("workerEvents")).length, 0);
  });
  await check("CLI reads the real result and concurrent retries reserve one turn", async () => {
    const args = ["notify", "--name", body.name, "--result", result, "--event", registration.eventId, "--token", registration.token];
    const replies = await Promise.all([cli(args), cli(args), cli(args)]);
    for (const reply of replies) { assert.equal(reply.code, 0, reply.output); assert.ok(!reply.output.includes(registration.token)); }
    const events = await rows("workerEvents");
    assert.equal(events.length, 1);
    assert.equal(events[0].conversationId, chat);
    const turns = await rows("codexTurns");
    assert.equal(turns.length, 1);
    assert.ok(turns[0].preparing);
    assert.ok(turns[0].prompt.includes(readFileSync(result, "utf8")));
    assert.ok(turns[0].prompt.includes(JSON.stringify(result)));
    const handoff = sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn'").all();
    assert.equal(handoff.length, 1);
    const argsToBrain = JSON.parse(handoff[0].args);
    assert.equal(argsToBrain.outside, true);
    assert.equal(argsToBrain.hidden, true);
    assert.equal(argsToBrain.externalId, "session:worker-origin");
  });
  await check("durable deduplication survives restart and rejects conflicting data", async () => {
    await runtime.stop(); sql.close();
    sql = new DatabaseSync(join(scratch, "test.sqlite"));
    runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage") });
    const request = { ...body, eventId: registration.eventId };
    assert.equal((await post(request, registration.token)).body.duplicate, true);
    assert.equal((await post({ ...request, text: "changed" }, registration.token)).status, 409);
    assert.equal((await rows("codexTurns")).length, 1);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name = 'brain:handleTurn'").get().n, 1);
  });
  await check("missing and oversized files fail CLI without posting", async () => {
    for (const path of [result + ".missing", scratch]) {
      const reply = await cli(["notify", "--name", "missing", "--result", path, "--token", "secret"]);
      assert.notEqual(reply.code, 0); assert.ok(!reply.output.includes("secret"));
    }
    const large = join(scratch, "large.md"); writeFileSync(large, "x".repeat(300_000));
    assert.notEqual((await cli(["notify", "--name", "large", "--result", large])).code, 0);
    assert.equal((await rows("workerEvents")).length, 1);
  });
  await check("registration CLI and lost acknowledgement retry deliver exactly once", async () => {
    const reply = await cli(["worker", "register", "--name", "Lost reply", "--result", result, "--chat", chat]);
    assert.equal(reply.code, 0, reply.output);
    const registered = JSON.parse(reply.output);
    dropNextReply = true;
    const sent = await cli(["notify", "--name", "Lost reply", "--result", result, "--event", registered.eventId, "--token", registered.token]);
    assert.equal(sent.code, 0, sent.output);
    assert.ok(sent.output.includes("already received"));
    assert.equal((await rows("workerEvents")).filter(event => event.eventId === registered.eventId).length, 1);
  });
  await check("receipt body interrupted after headers retries the accepted event", async () => {
    const registered = await call("workers:register", { name: "Truncated receipt", result, conversationId: chat });
    truncateNextReply = true;
    const sent = await cli(["notify", "--name", "Truncated receipt", "--result", result, "--event", registered.eventId, "--token", registered.token]);
    assert.equal(sent.code, 0, sent.output);
    assert.ok(sent.output.includes("already received"));
    assert.equal((await rows("workerEvents")).filter(event => event.eventId === registered.eventId).length, 1);
  });
  await check("reserved completion prepares and reaches the real runner with outside provenance", async () => {
    const runnerToken = "synthetic-worker-runner";
    await insert("runners", { name: "Synthetic runner", token: runnerToken, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
    const scheduled = sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn' ORDER BY createdAt").all().map(row => JSON.parse(row.args));
    const first = scheduled.find(args => args.externalId === "session:worker-origin");
    await call("brain:handleTurn", first);
    const turn = (await rows("codexTurns")).find(item => item._id === first.preparingId);
    assert.equal(turn.preparing, undefined);
    assert.ok(turn.outsideAt);
    const claimed = await call("codex:claimTurn", { token: runnerToken, id: turn._id });
    assert.ok(claimed, "completion should be claimable by real runner");
    assert.ok(claimed.prompt.includes(readFileSync(result, "utf8")));
    assert.equal((await rows("codexSteers")).length, 0);
    const busy = await post({ ...body, eventId: "busy", chat }, null, { "x-perry-key": process.env.DASHBOARD_KEY });
    assert.equal(busy.status, 200);
    const queued = (await rows("codexTurns")).find(item => item._id === busy.body.turnId);
    assert.equal(queued.steerTarget, turn._id, "worker should join the busy parent");
    assert.equal((await call("codex:claimTurn", { token: runnerToken, id: queued._id })), null);
    const busyArgs = sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn'").all().map(row => JSON.parse(row.args)).find(args => args.preparingId === queued._id);
    await call("brain:handleTurn", busyArgs);
    const steer = (await rows("codexSteers")).find(item => item.runId === queued.runId);
    assert.ok(steer.hidden && steer.outsideAt);
    await call("codex:ackSteer", { token: runnerToken, id: steer._id, applied: true });
    assert.equal(await call("codex:outwardAllowed", { turnId: turn._id }), false);
    assert.equal((await call("codex:getTurn", { id: turn._id })).steers.length, 0, "worker report must not become an owner message");
    const fallback = await post({ ...body, eventId: "steer-fallback", chat }, null, { "x-perry-key": process.env.DASHBOARD_KEY });
    const fallbackTurn = (await rows("codexTurns")).find(item => item._id === fallback.body.turnId);
    const fallbackArgs = sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn'").all().map(row => JSON.parse(row.args)).find(args => args.preparingId === fallbackTurn._id);
    await call("brain:handleTurn", fallbackArgs);
    const fallbackSteer = (await rows("codexSteers")).find(item => item.runId === fallbackTurn.runId);
    await call("codex:ackSteer", { token: runnerToken, id: fallbackSteer._id, applied: false, error: "Engine cannot steer" });
    const queuedAgain = (await rows("codexTurns")).find(item => item.runId === fallbackTurn.runId);
    assert.ok(queuedAgain.hidden && queuedAgain.outsideAt, "queued fallback must keep provenance");
  });
  await check("deleted origin falls back to owner's main channel", async () => {
    await patch(installation, { claimedAt: Date.now(), ownerChannel: "telegram", ownerExternalId: "12345" });
    await runtime.exclusive(() => runtime.store.delete(chat));
    const reply = await post({ ...body, eventId: "fallback", chat }, null, { "x-perry-key": process.env.DASHBOARD_KEY });
    assert.equal(reply.status, 200);
    const target = (await rows("conversations")).find(row => row._id === reply.body.conversationId);
    assert.equal(target.channel, "telegram"); assert.equal(target.externalId, "12345");
  });
  await check("web-only owner gets dashboard fallback", async () => {
    await patch(installation, { claimedAt: undefined, ownerChannel: undefined, ownerExternalId: undefined });
    const reply = await post({ ...body, eventId: "web-fallback" }, null, { "x-perry-key": process.env.DASHBOARD_KEY });
    assert.equal(reply.status, 200);
    const target = (await rows("conversations")).find(row => row._id === reply.body.conversationId);
    assert.equal(target.channel, "web"); assert.equal(target.externalId, "dashboard");
  });
  await check("paused admission rolls back and same event retries", async () => {
    await patch(installation, { paused: { at: Date.now(), by: "web" } });
    const request = { ...body, eventId: "paused" };
    assert.equal((await post(request, null, { "x-perry-key": process.env.DASHBOARD_KEY })).status, 503);
    assert.ok(!(await rows("workerEvents")).some(row => row.eventId === "paused"));
    await patch(installation, { paused: undefined });
    assert.equal((await post(request, null, { "x-perry-key": process.env.DASHBOARD_KEY })).status, 200);
  });
  await check("expired token and guest registrations are refused", async () => {
    const saved = (await rows("workers"))[0]; await patch(saved._id, { expiresAt: 0 });
    assert.equal((await post({ ...body, eventId: registration.eventId }, registration.token)).status, 401);
    const contactId = await insert("contacts", { name: "Guest", kind: "person", createdAt: Date.now() });
    const threadId = await call("agentStore:createThread", {});
    const guest = await call("conversations:create", { channel: "web", externalId: "guest", threadId, contactId });
    await assert.rejects(call("workers:register", { name: "guest", result, conversationId: guest }));
  });
  await check("generated final-step command executes with shell metacharacters", async () => {
    mkdirSync(join(scratch, "bin"));
    if (process.platform === "win32") {
      writeFileSync(join(scratch, "bin/perry.cmd"), `@echo off\r\nbun "${join(repo, "scripts/perry.ts")}" %*\r\n`);
    } else {
      writeFileSync(join(scratch, "bin/perry"), `#!/bin/sh\nexec bun '${join(repo, "scripts/perry.ts").replaceAll("'", "'\"'\"'")}' "$@"\n`, { mode: 0o755 });
    }
    const registered = await call("workers:register", { name: "worker ' & $ \" quotes", result: result.replaceAll("\\", "/"), ask: "Report 'checks' & failures $true" });
    const reply = await shellCommand(registered.command);
    assert.equal(reply.code, 0, reply.output);
    assert.ok((await rows("workerEvents")).some(row => row.eventId === registered.eventId));
  });
  await check("full queue rolls back admission and retries after room is available", async () => {
    const threadId = await call("agentStore:createThread", {});
    const full = await call("conversations:create", { channel: "web", externalId: "full", threadId });
    const queued = [];
    for (let i = 0; i < 10; i++) queued.push(await call("codex:prepareTurn", { conversationId: full, prompt: `Queued ${i}`, queue: true }));
    const request = { ...body, eventId: "full", chat: full };
    assert.equal((await post(request, null, { "x-perry-key": process.env.DASHBOARD_KEY })).status, 503);
    assert.ok(!(await rows("workerEvents")).some(row => row.eventId === "full"));
    await patch(queued[0], { status: "done", preparing: undefined });
    assert.equal((await post(request, null, { "x-perry-key": process.env.DASHBOARD_KEY })).status, 200);
  });
  await check("scoped token cannot register workers or authenticate generic admin calls", async () => {
    const response = await fetch(`${url}/api/workers/register`, { method: "POST", headers: { authorization: `Bearer ${registration.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "bad", result }) });
    assert.equal(response.status, 401);
    const { isAdmin } = await import("../../server/api.ts");
    assert.equal(isAdmin(new Request(url, { headers: { authorization: `Bearer ${registration.token}` } })), false);
  });
  await check("job and task origin chains reach the owner chat, with cycle fallback", async () => {
    const ownerThread = await call("agentStore:createThread", {});
    const owner = await call("conversations:create", { channel: "web", externalId: "chain-owner", threadId: ownerThread });
    const task = await call("tasks:queue", { title: "Synthetic task", prompt: "Synthetic work", origin: owner });
    const taskThread = await call("agentStore:createThread", {});
    const taskChat = await call("conversations:create", { channel: "web", externalId: "chain-task", threadId: taskThread });
    await patch(taskChat, { taskId: task });
    const job = await call("jobs:create", { name: "Synthetic job", prompt: "Synthetic work", origin: taskChat, at: new Date(Date.now() + 3600_000).toISOString() });
    const jobThread = await call("agentStore:createThread", {});
    const jobChat = await call("conversations:create", { channel: "web", externalId: "chain-job", threadId: jobThread });
    await patch(jobChat, { jobId: job.id });
    const request = { ...body, eventId: "job-task-chain", chat: jobChat };
    const reply = await post(request, null, { "x-perry-key": process.env.DASHBOARD_KEY });
    assert.equal(reply.status, 200); assert.equal(reply.body.conversationId, owner);
    await patch(task, { origin: jobChat });
    const cycle = await post({ ...request, eventId: "origin-cycle" }, null, { "x-perry-key": process.env.DASHBOARD_KEY });
    assert.equal(cycle.status, 200);
    const destination = (await rows("conversations")).find(row => row._id === cycle.body.conversationId);
    assert.equal(destination.externalId, "dashboard");
  });
  await check("unusable completion commands are refused before saving registration", async () => {
    const before = (await rows("workers")).length;
    await assert.rejects(call("workers:register", { name: "界".repeat(200), result, ask: "界".repeat(2000) }), /Shorten/);
    assert.equal((await rows("workers")).length, before);
  });
  report.passed = report.cases.every(item => item.passed);
} catch (error) {
  report.passed = false;
  report.cases.push({ name: "setup or replay", passed: false, error: String(error) });
} finally {
  globalThis.fetch = originalFetch;
  try {
    if (server?.listening) await new Promise(done => server.close(done));
    await runtime?.stop(); sql?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    report.passed = false;
    report.cases.push({ name: "cleanup", passed: false, error: String(error) });
  }
  save();
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
