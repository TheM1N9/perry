// Failure inventory: full-access-failure-cases.md. No model or real messaging.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { getEventListeners } from "node:events";

const out = resolve(process.argv[2] ?? "node_modules/.cache/full-access-approvals");
mkdirSync(out, { recursive: true });
const home = join(out, "home");
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = "synthetic-full-access-key";
process.env.PERRY_CREDENTIAL_KEY = "77".repeat(32);
delete process.env.COMPOSIO_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
globalThis.fetch = async () => { throw Error("No network in full-access fixture"); };
const [{ Runtime }, { default: schema }, { modules }, { CodexEngine }, { optionOf, FULL_ACCESS_INSTRUCTIONS }] = await Promise.all([
  import("../../server/runtime"), import("../../convex/schema"), import("../../server/modules"), import("../../runner/engines/codex"), import("../../runner/engine"),
]);
const sql = new DatabaseSync(":memory:");
const rt = new Runtime(sql, schema as never, modules, { storageDir: join(home, "storage") });
await rt.stop();
const mutate = (name: string, args: any = {}) => rt.runMutation(name, args, { internal: true }) as Promise<any>;
const query = async (name: string, args: any = {}) => (await rt.runQuery(name, args, { internal: true })).value as any;
const token = "synthetic-full-access-runner";
const runnerId = await mutate("runner:createToken", { token, name: "Synthetic full-access computer" });
rt.store.insert("installation", { timezone: "UTC" });
const threadId = await mutate("agentStore:createThread", { userId: "full-access-owner" });
const chat = rt.store.insert("conversations", { channel: "web", externalId: "full-access-owner", threadId, access: "supervised", lastMessageAt: Date.now() });
const runId = await mutate("runs:start", { conversationId: chat, prompt: "Synthetic authorization verification" });
const turnId = rt.store.insert("codexTurns", { runnerId, conversationId: chat, runId, prompt: "Synthetic authorization verification", instructions: "Fixture only", status: "running", createdAt: Date.now() });
const results: Array<{ name: string; passed: boolean; error?: string }> = [];
async function check(name: string, work: () => Promise<void>) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  console.log(JSON.stringify(results.at(-1)));
  writeFileSync(join(out, "result.json"), JSON.stringify({ passed: results.every(item => item.passed), results }, null, 2));
}
const request = (kind: string, extra = {}) => mutate("approvals:request", { token, kind, title: `Synthetic ${kind}`, detail: "{}", conversationId: chat, turnId, ...extra });
try {
  for (const access of ["supervised", "auto", "full"]) for (const kind of ["command", "file", "permission", "tool"]) {
    await check(`${access} ${kind} follows current chat authorization`, async () => {
      rt.store.patch(chat, { access });
      const reply = await request(kind);
      assert.equal(reply.next, access === "full" ? "run" : access === "auto" && ["command", "file"].includes(kind) ? "review" : "ask");
      assert.equal(rt.store.get(reply.id)?.status, access === "full" ? "auto" : access === "auto" && ["command", "file"].includes(kind) ? "reviewing" : "pending");
    });
  }
  for (const explicit of [false, true]) await check(`Full browser confirmation explicit=${explicit} does not ask`, async () => {
    rt.store.patch(chat, { access: "full" });
    const reply = await mutate("approvals:askForBrowser", { conversationId: chat, turnId, title: "Synthetic browser operation", explicit });
    assert.equal(reply.status, "auto");
  });
  await check("switching to Full releases pending confirmation-only tool requests", async () => {
    rt.store.patch(chat, { access: "supervised" });
    const reply = await request("tool");
    await mutate("conversations:setAccess", { id: chat, access: "full" });
    assert.equal(rt.store.get(reply.id)?.status, "auto");
  });
  await check("switching another chat to Full does not grant this chat", async () => {
    rt.store.patch(chat, { access: "supervised" });
    const reply = await request("tool");
    const other = rt.store.insert("conversations", { channel: "web", externalId: "other-owner-chat", threadId, access: "supervised", lastMessageAt: Date.now() });
    await mutate("conversations:setAccess", { id: other, access: "full" });
    assert.equal(rt.store.get(reply.id)?.status, "pending");
  });
  await check("stopped Full turns cannot create a consent grant", async () => {
    rt.store.patch(chat, { access: "full" }); rt.store.patch(turnId, { stopRequested: true });
    await assert.rejects(request("tool"), /ended|stopped/);
    rt.store.patch(turnId, { stopRequested: undefined });
  });
  await check("guest Full chats cannot create an owner consent grant", async () => {
    const contactId = rt.store.insert("contacts", { channel: "whatsapp", externalId: "synthetic-guest", name: "Synthetic guest", kind: "person", status: "allowed" });
    rt.store.patch(chat, { contactId });
    await assert.rejects(request("tool"), /owner/);
    rt.store.patch(chat, { contactId: undefined });
  });

  const source = readFileSync("runner/index.ts", "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("  const answer = async (request: EngineRequest");
  const end = source.indexOf("\n\n  const checkInAndShare", start);
  assert(start >= 0 && end > start);
  const dispatchSource = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const decisions: any[] = [];
  const approve = async (req: any, conversationId: string, _engine: string, activeTurn: string) => {
    const response = await mutate("approvals:request", { token, kind: req.kind, title: req.what, detail: req.detail, conversationId, turnId: activeTurn });
    decisions.push(response);
    return response.next === "run";
  };
  const dispatch = new Function("optionOf", "denied", "approve", dispatchSource + "\nreturn answer;")(optionOf, () => false, approve);
  const engine: any = new CodexEngine();
  const replies: any[] = [];
  const app = { respond: (id: any, result: any) => replies.push({ id, result }), rejectRequest: (id: any, error: string) => replies.push({ id, error }) };
  const running = { cwd: process.cwd(), turnId: "native-synthetic-turn", sink: { onRequest: (req: any) => dispatch(req, chat, "codex", turnId, rt.store.get(chat)?.access) } };
  engine.turns.set("native-synthetic-thread", running);
  let sequence = 0;
  const elicit = async (params = {}) => {
    const id = ++sequence;
    await engine.answer(app, { id, method: "mcpServer/elicitation/request", params: { threadId: "native-synthetic-thread", turnId: "native-synthetic-turn", serverName: "synthetic-external", mode: "form", message: "Perform the authorized synthetic operation?", requestedSchema: { type: "object", properties: {} }, ...params } });
    return replies.find(reply => reply.id === id);
  };
  await check("Codex confirmation reaches production runner and backend without asking on Full", async () => {
    rt.store.patch(chat, { access: "full" });
    const reply = await elicit();
    assert.deepEqual(reply.result, { action: "accept", content: {}, _meta: null });
    assert.equal(decisions.at(-1)?.next, "run");
  });
  for (const params of [
    { requestedSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } },
    { mode: "url", url: "https://synthetic.invalid/sign-in" },
    { mode: "openai/userVerification" },
  ]) await check(`Full does not fabricate ${params.mode ?? "structured form"} input`, async () => {
    const before = decisions.length;
    const reply = await elicit(params);
    assert.match(reply.error, /requires|cannot collect/);
    assert.equal(decisions.length, before);
  });
  await check("replaced native turns cannot accept a confirmation on Full", async () => {
    const before = decisions.length;
    const reply = await elicit({ turnId: "old-native-turn" });
    assert.equal(reply.result.action, "cancel");
    assert.equal(decisions.length, before);
  });
  await check("Full instructions cover existing authorization without an external-consent exception", async () => {
    assert.match(FULL_ACCESS_INSTRUCTIONS, /already.*permission/i);
    assert.doesNotMatch(FULL_ACCESS_INSTRUCTIONS, /Explicit external-tool consent/);
  });
  for (const access of ["supervised", "auto", "full"]) await check(`${access} native permission scope respects authorization rather than phone display limits`, async () => {
    rt.store.patch(chat, { access });
    const permissions = { fileSystem: { write: Array.from({ length: 30 }, (_, index) => `C:/synthetic-workspace/authorized-directory-${index}`) } };
    assert.ok(JSON.stringify(permissions).length > 800);
    const id = ++sequence;
    const before = decisions.length;
    await engine.answer(app, { id, method: "item/permissions/requestApproval", params: { threadId: "native-synthetic-thread", turnId: "native-synthetic-turn", permissions } });
    assert.deepEqual(replies.find(reply => reply.id === id)?.result, { permissions: access === "full" ? permissions : {}, scope: "turn" });
    assert.equal(decisions.length - before, access === "full" ? 1 : 0);
  });
  await check("Claude SDK confirmation callback routes Full consent through the same live backend", async () => {
    const claudeSource = readFileSync("runner/engines/claude.ts", "utf8");
    const parsed = ts.createSourceFile("claude.ts", claudeSource, ts.ScriptTarget.Latest, true);
    let callback: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === "onElicitation") callback = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(parsed); assert.ok(callback, "Claude must configure its SDK elicitation callback");
    const callbackSource = ts.transpileModule(`const callback = ${callback.getText(parsed)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const shared: any = await import("../../runner/engine");
    const live: any = { turn: running };
    const elicit = new Function("live", "isConfirmationRequest", callbackSource + "\nreturn callback;")(live, shared.isConfirmationRequest);
    rt.store.patch(chat, { access: "full" });
    const controller = new AbortController();
    const request = { serverName: "synthetic-external", mode: "form", message: "Perform authorized operation?", requestedSchema: { type: "object", properties: {} } };
    assert.deepEqual(await elicit(request, { signal: controller.signal }), { action: "accept", content: {} });
    assert.deepEqual(await elicit({ ...request, requestedSchema: { type: "object", properties: { identity: { type: "string" } } } }, { signal: controller.signal }), { action: "decline" });
    assert.deepEqual(await elicit({ ...request, mode: "url" }, { signal: controller.signal }), { action: "decline" });
    controller.abort();
    assert.deepEqual(await elicit(request, { signal: controller.signal }), { action: "cancel" });
    const pendingController = new AbortController();
    let finish: (choice: string) => void = () => {};
    live.turn = { sink: { onRequest: () => new Promise<string>(done => { finish = done; }) } };
    const pending = elicit(request, { signal: pendingController.signal });
    assert.equal(getEventListeners(pendingController.signal, "abort").length, 1);
    pendingController.abort();
    assert.deepEqual(await pending, { action: "cancel" });
    assert.equal(getEventListeners(pendingController.signal, "abort").length, 0);
    finish("accept");
  });

  const known = rt.store.insert("contacts", { channel: "whatsapp", externalId: "15550000001@s.whatsapp.net", name: "Synthetic known contact", kind: "person", status: "known" });
  const blocked = rt.store.insert("contacts", { channel: "whatsapp", externalId: "15550000002@s.whatsapp.net", name: "Synthetic blocked contact", kind: "person", status: "blocked" });
  await check("Full first-contact send is authorized without permanent contact access", async () => {
    rt.store.patch(chat, { access: "full" });
    const before = rt.store.all("approvals").length;
    const requested = await mutate("contacts:requestSend", { contactId: known, text: "Synthetic authorized message", conversationId: chat, turnId });
    assert.equal(requested.status, "allowed");
    assert.equal(rt.store.get(known)?.status, "known");
    assert.equal(rt.store.all("approvals").length, before);
    const delivered = await rt.runAction("contacts:deliver", { contactId: requested.contactId, text: "Synthetic authorized message", turnId }, { internal: true });
    assert.deepEqual(delivered, { sent: true });
    assert.equal(rt.store.get(known)?.status, "known");
    assert.equal(rt.store.all("approvals").length, before);
    const row = rt.store.all("whatsappOutbox").find((row: any) => row.to === "15550000001@s.whatsapp.net");
    assert.ok(row); assert.equal(row.turnId, undefined);
    assert.equal(row.text, "Synthetic authorized message");
  });
  await check("Full does not bypass an explicit contact block", async () => {
    const requested = await mutate("contacts:requestSend", { contactId: blocked, text: "Synthetic blocked message", conversationId: chat, turnId });
    assert.match(requested.error, /blocked/);
    assert.equal(await mutate("whatsapp:send", { to: "15550000002@s.whatsapp.net", text: "Synthetic blocked message", authorizationTurnId: turnId }), false);
  });
  await check("stopped and downgraded turns cannot enqueue a new-contact message", async () => {
    rt.store.patch(turnId, { stopRequested: true });
    assert.equal(await mutate("whatsapp:send", { to: "15550000001@s.whatsapp.net", text: "Synthetic stopped send", authorizationTurnId: turnId }), false);
    rt.store.patch(turnId, { stopRequested: undefined }); rt.store.patch(chat, { access: "supervised" });
    assert.equal(await mutate("whatsapp:send", { to: "15550000001@s.whatsapp.net", text: "Synthetic downgraded send", authorizationTurnId: turnId }), false);
  });
} finally {
  await rt.stop(); sql.close(); rmSync(home, { recursive: true, force: true });
  writeFileSync(join(out, "result.json"), JSON.stringify({ passed: results.every(item => item.passed), results, temporaryHomeRemoved: true, realMessagesSent: 0, modelTurnsStarted: 0 }, null, 2));
}
if (!results.every(item => item.passed)) process.exitCode = 1;
