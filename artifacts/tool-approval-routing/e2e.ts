// Failure inventory was recorded before this fixture and implementation.
// Real Codex adapter -> actual runner dispatch -> production approvals/SQLite.
// No app-server process, model, account action or network is started.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
const out = resolve(process.argv[2] ?? 'artifacts/tool-approval-routing/results');
mkdirSync(out, { recursive: true });
process.env.PERRY_HOME = join(out, 'home');
process.env.DASHBOARD_KEY = 'synthetic-approval-key';
process.env.PERRY_CREDENTIAL_KEY = '66'.repeat(32);
delete process.env.COMPOSIO_API_KEY; delete process.env.TELEGRAM_BOT_TOKEN;
globalThis.fetch = async () => { throw Error('Fixture blocks all network'); };
const [{ Runtime }, { default: schema }, { modules }, { CodexEngine }, { optionOf }] = await Promise.all([
  import('../../server/runtime'), import('../../convex/schema'), import('../../server/modules'), import('../../runner/engines/codex'), import('../../runner/engine'),
]);
const sql = new DatabaseSync(':memory:');
const rt = new Runtime(sql, schema as never, modules, { storageDir: join(out, 'storage') });
await rt.stop();
const mutate = (name: string, args: any = {}) => rt.runMutation(name, args, { internal: true }) as Promise<any>;
const query = async (name: string, args: any = {}) => (await rt.runQuery(name, args, { internal: true })).value as any;
const token = 'synthetic-approval-runner';
const runnerId = await mutate('runner:createToken', { token, name: 'Synthetic computer' });
rt.store.insert('installation', { timezone: 'Asia/Calcutta' });
const threadId = await mutate('agentStore:createThread', { userId: 'fixture-owner' });
const chat = rt.store.insert('conversations', { channel: 'web', externalId: 'synthetic-owner', threadId, access: 'supervised', lastMessageAt: Date.now() });
// Compile only the unchanged runner dispatcher out of index.ts, which otherwise
// starts an actual runner on import. This keeps the regression on its real code.
const source = readFileSync('runner/index.ts', 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  const answer = async (request: EngineRequest');
const end = source.indexOf('\n\n  const checkInAndShare', start);
assert(start >= 0 && end > start);
const dispatchSource = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const waiting = new Map<string, (value: boolean) => void>();
const asked: string[] = [];
const approve = async (request: any, conversationId: string) => {
  const result = await mutate('approvals:request', { token, kind: request.kind, title: request.what, detail: request.detail, conversationId });
  asked.push(result.id);
  if (result.next === 'run') return true;
  return await new Promise<boolean>(done => waiting.set(result.id, done));
};
const dispatch = new Function('optionOf', 'denied', 'approve', dispatchSource + '\nreturn answer;')(optionOf, () => false, approve);
const engine: any = new CodexEngine();
const replies: any[] = [];
const app = { respond: (id: any, result: any) => replies.push({ id, result }), rejectRequest: (id: any, error: string) => replies.push({ id, error }) };
const running = { cwd: process.cwd(), turnId: 'synthetic-turn', sink: { onRequest: (r: any) => dispatch(r, chat, 'codex') } };
engine.turns.set('synthetic-thread', running);
let sequence = 0;
const begin = (extra: any = {}) => {
  const id = ++sequence;
  const response = engine.answer(app, { id, method: 'mcpServer/elicitation/request', params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', serverName: 'synthetic-github', mode: 'form', message: 'Create the synthetic fixture issue?', requestedSchema: { type: 'object', properties: {} }, ...extra } });
  return { id, response };
};
const flush = () => new Promise(done => setImmediate(done));
const settle = async (id: string, approved: boolean, timeout = false) => {
  if (timeout) await mutate('approvals:settle', { token, id, approved: false, by: 'timeout' });
  else await mutate('approvals:decide', { key: process.env.DASHBOARD_KEY, id, approved });
  const status = await query('approvals:decision', { token, id });
  waiting.get(id)?.(status === 'approved' || status === 'auto'); waiting.delete(id);
};
const results: any[] = [];
async function check(name: string, work: () => Promise<void>) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  for (const done of waiting.values()) done(false); waiting.clear();
  console.log(JSON.stringify(results.at(-1)));
  writeFileSync(join(out, 'result.json'), JSON.stringify({ results }, null, 2));
}
await check('confirmation appears and cannot execute before the owner approves', async () => {
  const count = asked.length; const call = begin(); await flush();
  assert.equal(asked.length, count + 1);
  assert(!replies.some(r => r.id === call.id));
  const pending = await query('approvals:pending', { key: process.env.DASHBOARD_KEY });
  assert(pending.some((r: any) => r.id === asked.at(-1) && r.kind === 'tool' && r.title.includes('synthetic-github')));
  await settle(asked.at(-1)!, true); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { action: 'accept', content: {}, _meta: null });
});
for (const mode of ['decline', 'timeout']) await check(`${mode} returns a protocol decline without executing`, async () => {
  const call = begin(); await flush(); const id = asked.at(-1)!;
  assert(waiting.has(id)); await settle(id, false, mode === 'timeout'); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { action: 'decline', content: null, _meta: null });
  assert.equal(rt.store.get(id)?.status, mode === 'timeout' ? 'expired' : 'declined');
});
for (const access of ['full', 'auto']) await check(`${access} access still requires this external confirmation`, async () => {
  rt.store.patch(chat, { access }); const call = begin(); await flush();
  assert(waiting.has(asked.at(-1)!)); assert(!replies.some(r => r.id === call.id));
  await settle(asked.at(-1)!, false); await call.response; rt.store.patch(chat, { access: 'supervised' });
});
// Native computer permission regression inventory: artifacts/computer-control/full-access-failure-cases.md.
const permissions = { network: { enabled: true }, fileSystem: { read: ['C:/fixture/read'], write: ['C:/fixture/write'] } };
const permission = (extra: any = {}) => {
  const id = ++sequence;
  const response = engine.answer(app, { id, method: 'item/permissions/requestApproval', params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: `permission-${id}`, cwd: process.cwd(), reason: 'Use the fixture computer', permissions, ...extra } });
  return { id, response };
};
await check('Full access grants requested native computer permissions without asking', async () => {
  rt.store.patch(chat, { access: 'full' }); const before = waiting.size; const call = permission(); await flush();
  assert.equal(waiting.size, before); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions, scope: 'turn' });
  rt.store.patch(chat, { access: 'supervised' });
});
for (const access of ['supervised', 'auto', 'full']) await check(`${access}: oversized native permission scope is declined before approval`, async () => {
  rt.store.patch(chat, { access });
  const count = asked.length;
  const call = permission({ permissions: { fileSystem: { write: [`C:/fixture/${'scope'.repeat(900)}`] } } });
  await flush();
  if (asked.length > count) await settle(asked.at(-1)!, true);
  await call.response;
  assert.equal(asked.length, count);
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions: {}, scope: 'turn' });
  rt.store.patch(chat, { access: 'supervised' });
});
await check('long permission reasons cannot hide any of the requested scope', async () => {
  rt.store.patch(chat, { access: 'supervised' });
  const call = permission({ reason: 'Explanation '.repeat(700) }); await flush();
  const id = asked.at(-1)!;
  const row = rt.store.get(id)!;
  assert(typeof row.detail === 'string' && row.detail.includes(JSON.stringify(permissions)) && row.detail.length <= 800);
  await settle(id, true); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions, scope: 'turn' });
});
await check('the exact permission display boundary preserves the full scope', async () => {
  const boundary = { fileSystem: { read: null, write: ['C:/fixture/'] } };
  boundary.fileSystem.write[0] += 'x'.repeat(800 - JSON.stringify(boundary).length);
  assert.equal(JSON.stringify(boundary).length, 800);
  const call = permission({ permissions: boundary, reason: 'A reason that cannot displace the scope' }); await flush();
  const id = asked.at(-1)!; assert.equal(rt.store.get(id)?.detail, JSON.stringify(boundary));
  await settle(id, true); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions: boundary, scope: 'turn' });
});
await check('missing permission scopes cannot ask and backend rejects oversized details', async () => {
  const count = asked.length;
  assert.equal(await dispatch({ type: 'permission_approval', detail: {}, options: [{ id: 'turn', kind: 'accept' }, { id: 'none', kind: 'decline' }], raw: {} }, chat, 'codex'), 'none');
  assert.equal(asked.length, count);
  await assert.rejects(() => mutate('approvals:request', { token, kind: 'permission', title: 'Oversized scope', detail: 'x'.repeat(801), conversationId: chat }));
});
for (const access of ['supervised', 'auto']) await check(`${access}: native computer permission asks rather than silently refusing`, async () => {
  rt.store.patch(chat, { access }); const count = asked.length; const call = permission(); await flush();
  assert.equal(asked.length, count + 1); const id = asked.at(-1)!;
  assert(waiting.has(id)); assert.equal(rt.store.get(id)?.kind, 'permission');
  assert.equal(rt.store.get(id)?.alwaysAllow, undefined);
  await settle(id, true); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions, scope: 'turn' });
  rt.store.patch(chat, { access: 'supervised' });
});
await check('declining native computer permission grants nothing with a valid turn scope', async () => {
  const count = asked.length; const call = permission(); await flush(); assert.equal(asked.length, count + 1);
  await settle(asked.at(-1)!, false); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions: {}, scope: 'turn' });
});
await check('switching to Full access releases pending native computer permission', async () => {
  const count = asked.length; const call = permission(); await flush(); assert.equal(asked.length, count + 1);
  const id = asked.at(-1)!; await mutate('conversations:setAccess', { id: chat, access: 'full' });
  assert.equal(rt.store.get(id)?.status, 'auto'); waiting.get(id)?.(true); waiting.delete(id);
  await call.response; assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions, scope: 'turn' });
  rt.store.patch(chat, { access: 'supervised' });
});
await check('permission grant cannot outlive or select a different native turn', async () => {
  rt.store.patch(chat, { access: 'full' }); const before = asked.length;
  for (const extra of [{ turnId: 'earlier-turn' }, { threadId: 'missing-thread' }]) {
    const call = permission(extra); await call.response;
    assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions: {}, scope: 'turn' });
  }
  assert.equal(asked.length, before); rt.store.patch(chat, { access: 'supervised' });
});
await check('late native permission approval cannot survive replacement', async () => {
  const count = asked.length; const call = permission(); await flush(); assert.equal(asked.length, count + 1);
  engine.turns.set('synthetic-thread', { ...running, turnId: 'replacement' });
  await settle(asked.at(-1)!, true); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions: {}, scope: 'turn' });
  engine.turns.set('synthetic-thread', running);
});
await check('native permission approval cannot survive Stop on the same turn', async () => {
  const count = asked.length; const call = permission(); await flush(); assert.equal(asked.length, count + 1);
  await engine.interrupt({ cursor: 'synthetic-thread', turnId: 'synthetic-turn' });
  await settle(asked.at(-1)!, true); await call.response;
  assert.deepEqual(replies.find(r => r.id === call.id)?.result, { permissions: {}, scope: 'turn' });
  delete (running as any).interrupted;
});
await check('Full permission grants remain turn-scoped and downgrade restores asking', async () => {
  rt.store.patch(chat, { access: 'full' }); const granted = permission(); await granted.response;
  assert.equal(replies.find(r => r.id === granted.id)?.result.scope, 'turn');
  await mutate('conversations:setAccess', { id: chat, access: 'supervised' });
  const count = asked.length; const requested = permission(); await flush(); assert.equal(asked.length, count + 1);
  assert(waiting.has(asked.at(-1)!)); await settle(asked.at(-1)!, false); await requested.response;
});
await check('saved file rules never grant native computer permission', async () => {
  rt.store.insert('approvalRules', { runnerId, kind: 'file', pathPrefix: 'C:/fixture', uses: 0, createdAt: Date.now() });
  const result = await mutate('approvals:request', { token, kind: 'permission', title: 'Requested computer permissions', detail: JSON.stringify(permissions), conversationId: chat, paths: ['C:/fixture/write/test.txt'] });
  assert.equal(result.next, 'ask'); assert.equal(rt.store.get(result.id)?.alwaysAllow, undefined);
  await mutate('approvals:decide', { key: process.env.DASHBOARD_KEY, id: result.id, approved: false });
});
await check('Full-access startup and resumed turns tell Codex computer access is already granted', async () => {
  const native: any = new CodexEngine();
  const requests: any[] = [];
  const fake = {
    reloadSkills: async () => [], on() {}, off() {},
    request: async (method: string, params: any) => {
      requests.push({ method, params });
      return method === 'turn/start' ? { turn: { id: 'prompt-fixture-turn' } } : { thread: { id: 'prompt-fixture-thread' } };
    },
    waitForTurn: async () => ({ text: 'Fixture only', images: [], interrupted: false }),
  };
  native.ensure = async () => fake;
  const input = { instructions: 'Fixture instructions', prompt: 'Use the computer', cwd: process.cwd(), access: 'full', attachments: [] };
  const sink = { onSession: async () => {}, onRequest: async () => 'decline' };
  await native.runTurn(input, sink);
  const started = requests.find(item => item.method === 'thread/start');
  assert.match(started.params.developerInstructions, /Full access[\s\S]*already[\s\S]*permission/i);
  requests.length = 0;
  await native.runTurn({ ...input, resumeCursor: 'another-existing-thread' }, sink);
  const resumed = requests.find(item => item.method === 'thread/resume');
  assert.match(resumed.params.developerInstructions, /Do not ask again for general computer/i);
});
await check('Full access in one chat does not authorize another chat computer permissions', async () => {
  rt.store.patch(chat, { access: 'full' });
  const otherThread = await mutate('agentStore:createThread', { userId: 'fixture-other-chat' });
  const otherChat = rt.store.insert('conversations', { channel: 'web', externalId: 'permission-other-chat', threadId: otherThread, access: 'supervised', lastMessageAt: Date.now() });
  const request = await mutate('approvals:request', { token, kind: 'permission', title: 'Other chat computer permissions', detail: JSON.stringify(permissions), conversationId: otherChat });
  assert.equal(request.next, 'ask');
  await mutate('approvals:decide', { key: process.env.DASHBOARD_KEY, id: request.id, approved: false });
  rt.store.patch(chat, { access: 'supervised' });
});
await check('Perry browser Full access runs without another approval prompt', async () => {
  rt.store.patch(chat, { access: 'full' });
  const before = (await query('approvals:pending', { key: process.env.DASHBOARD_KEY })).length;
  const request = await mutate('approvals:askForBrowser', { conversationId: chat, title: 'Fixture browser step' });
  assert.equal(request.status, 'auto');
  assert.equal((await query('approvals:pending', { key: process.env.DASHBOARD_KEY })).length, before);
  rt.store.patch(chat, { access: 'supervised' });
});
await check('changing access does not grant a pending tool request', async () => {
  const call = begin(); await flush(); const id = asked.at(-1)!;
  await mutate('conversations:setAccess', { id: chat, access: 'full' });
  assert.equal(rt.store.get(id)?.status, 'pending');
  await settle(id, false); await call.response; rt.store.patch(chat, { access: 'supervised' });
});
await check('tool approvals never create an Always allow rule', async () => {
  const ruleCount = rt.store.all('approvalRules').length;
  const call = begin(); await flush(); const id = asked.at(-1)!;
  assert.equal(rt.store.get(id)?.alwaysAllow, undefined);
  await mutate('approvals:decide', { key: process.env.DASHBOARD_KEY, id, approved: true, always: true });
  waiting.get(id)?.(true); waiting.delete(id); await call.response;
  assert.equal(rt.store.all('approvalRules').length, ruleCount);
});
for (const params of [
  { mode: 'form', requestedSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] } },
  { mode: 'url', url: 'https://fixture.invalid/sign-in' },
  { mode: 'openai/userVerification', title: 'Synthetic identity check', challenge: 'synthetic' },
]) await check(`unsupported ${params.mode} request has an explicit error instead of fake consent`, async () => {
  const count = asked.length; const call = begin(params); await call.response;
  assert.equal(asked.length, count); assert.match(replies.find(r => r.id === call.id)?.error ?? '', /cannot collect|not supported|requires/i);
});
await check('orphan requests decline without asking the owner', async () => {
  const count = asked.length; const call = begin({ threadId: 'missing' }); await call.response;
  assert.equal(asked.length, count); assert.equal(replies.find(r => r.id === call.id)?.result?.action, 'decline');
});
await check('quick reviewer threads cannot request tool consent', async () => {
  engine.quickThreads.add('review-thread'); const count = asked.length;
  const call = begin({ threadId: 'review-thread' }); await call.response;
  assert.equal(asked.length, count); assert.match(replies.find(r => r.id === call.id)?.error ?? '', /only answers/);
});
await check('a stopped or replaced turn cannot accept a late approval', async () => {
  const call = begin(); await flush(); const id = asked.at(-1)!;
  engine.turns.delete('synthetic-thread');
  await settle(id, true); await call.response;
  assert.equal(replies.find(r => r.id === call.id)?.result?.action, 'cancel');
  engine.turns.set('synthetic-thread', running);
});
await check('a request from an earlier turn cannot ask for consent in the new turn', async () => {
  const count = asked.length; const call = begin({ turnId: 'old-turn' }); await call.response;
  assert.equal(asked.length, count); assert.equal(replies.find(r => r.id === call.id)?.result?.action, 'cancel');
});
await check('concurrent requests keep independent owner decisions', async () => {
  const first = begin(), second = begin(); await flush(); const [a, b] = asked.slice(-2);
  assert(a !== b); await settle(a, true); await first.response;
  assert(!replies.some(r => r.id === second.id));
  await settle(b, false); await second.response;
  assert.equal(replies.find(r => r.id === first.id)?.result.action, 'accept');
  assert.equal(replies.find(r => r.id === second.id)?.result.action, 'decline');
});
await check('Perry own gated MCP flow remains supported', async () => {
  const count = asked.length; const { ASSISTANT_MCP } = await import('../../runner/codex');
  const call = begin({ serverName: ASSISTANT_MCP }); await call.response;
  assert.equal(asked.length, count); assert.equal(replies.find(r => r.id === call.id)?.result.action, 'accept');
});
await check('a guest cannot create a tool approval for the owner', async () => {
  const contactId = rt.store.insert('contacts', { channel: 'whatsapp', externalId: 'synthetic-guest', name: 'Fixture guest', kind: 'person', status: 'allowed' });
  const guest = rt.store.insert('conversations', { channel: 'whatsapp', externalId: 'synthetic-guest', threadId, contactId, lastMessageAt: Date.now() });
  await assert.rejects(mutate('approvals:request', { token, kind: 'tool', title: 'Synthetic request', conversationId: guest }), /owner/);
});
// Exercise the production wait loop too: a backend expiration must resolve it
// immediately, rather than leaving the native tool hung until another timer.
const askStart = source.indexOf('  const askOwner = async');
const askEnd = source.indexOf('\n\n  /**', askStart);
const askSource = ts.transpileModule(source.slice(askStart, askEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
await check('runner wait loop handles backend expiration and cleans its listener', async () => {
  let listener: (status: string) => void = () => {}; let removed = false;
  const client = { onUpdate: (_: any, __: any, callback: any) => { listener = callback; return () => { removed = true; }; }, mutation: async () => null };
  const identity = (text: any) => text;
  const askOwner = new Function('client','api','token','terminal','workdir','relative','console','bold','cyan','dim','APPROVAL_TIMEOUT_MS', askSource + '\nreturn askOwner;')(
    client, { approvals: {} }, token, null, process.cwd(), () => '', { log() {}, error() {} }, identity, identity, identity, 1000,
  );
  const promise = askOwner('synthetic', { what: 'Synthetic confirmation', detail: null });
  listener('expired'); assert.equal(await promise, false); assert(removed);
});
for (const type of ['exec_command_approval', 'file_change_approval']) await check(`existing ${type} still routes through normal approvals`, async () => {
  const promise = dispatch({ type, detail: { command: 'synthetic read', changes: [{ path: 'W:/fixture/test.txt', kind: 'update' }] }, options: [{ id: 'once', kind: 'accept' }, { id: 'no', kind: 'decline' }] }, chat, 'codex');
  await flush(); const id = asked.at(-1)!; assert(waiting.has(id));
  await settle(id, true); assert.equal(await promise, 'once');
});
await check('another runner cannot settle this tool approval', async () => {
  const call = begin(); await flush(); const id = asked.at(-1)!;
  await mutate('runner:createToken', { token: 'synthetic-other-runner', name: 'Other fixture' });
  await mutate('approvals:settle', { token: 'synthetic-other-runner', id, approved: true, by: 'terminal' });
  assert.equal(rt.store.get(id)?.status, 'pending');
  await settle(id, false); await call.response;
});
await check('saved file rules cannot grant external tool consent', async () => {
  rt.store.insert('approvalRules', { runnerId, kind: 'file', pathPrefix: 'W:/fixture', uses: 0, createdAt: Date.now() });
  const result = await mutate('approvals:request', { token, kind: 'tool', title: 'Synthetic', conversationId: chat, paths: ['W:/fixture/file.txt'] });
  assert.equal(result.next, 'ask'); assert.equal(rt.store.get(result.id)?.alwaysAllow, undefined);
  await mutate('approvals:decide', { key: process.env.DASHBOARD_KEY, id: result.id, approved: false });
});
await rt.stop(); sql.close();
const passed = results.filter(r => r.passed).length;
console.log(JSON.stringify({ passed, total: results.length }));
if (passed !== results.length) process.exitCode = 1;
