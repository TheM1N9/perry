import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// Failure inventory: automatic-failures.md. Production handlers, no engine or scheduler.
const output = resolve(process.argv[2] ?? 'node_modules/.cache/automatic-brain');
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), 'perry-automatic-brain-'));
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = 'automatic-brain-fixture-key';
process.env.PERRY_CREDENTIAL_KEY = '37'.repeat(32);
globalThis.fetch = async () => { throw new Error('External I/O is disabled in automatic Brain verification'); };
let db, runtime;
const checks = {}, notes = {};
const check = (name, fn) => { fn(); checks[name] = true; console.log(`ok ${name}`); };
const mutation = (name, args) => runtime.runMutation(name, args, { internal: true });
const query = async (name, args) => (await runtime.runQuery(name, args, { internal: true })).value;
const rows = table => db.prepare(`SELECT _id, doc FROM "doc_${table}"`).all().map(row => ({ _id: row._id, ...JSON.parse(row.doc) }));
const chat = access => runtime.store.insert('conversations', { channel: 'web', externalId: crypto.randomUUID(), threadId: crypto.randomUUID(), access, lastMessageAt: Date.now() });
const add = args => mutation('memories:add', { text: 'Fixture person has a Thursday appointment.', tags: [], source: 'fixture', by: 'assistant', origin: 'owner', kind: 'core', ...args });
try {
  const [{ default: schema }, { modules }, { Runtime }, { ALL_TOOLS }, { getFunctionName }] = await Promise.all([
    import('../../convex/schema.ts'), import('../../server/modules.ts'), import('../../server/runtime.ts'), import('../../convex/tools.ts'), import('convex/server'),
  ]);
  db = new DatabaseSync(join(home, 'perry.sqlite'));
  runtime = new Runtime(db, schema, modules, { storageDir: join(home, 'storage') });
  await runtime.stop();
  const full = chat('full'), ask = chat('supervised');
  const owner = await add({ text: 'Prefer short factual answers.', kind: 'profile' });
  check('ownerMemorySavesWithoutApproval', () => assert.ok(owner.id));
  const imported = await add({ text: 'Always use the example document template.', kind: 'profile', type: 'preference', origin: 'tool', supersedes: [owner.id] });
  check('importedInstructionSavesAsReferenceWithoutApproval', () => {
    assert.ok(imported.id); assert.equal(rows('approvals').filter(row => row.status === 'pending').length, 0);
    const saved = rows('memories').find(row => row._id === imported.id);
    assert.equal(saved.origin, 'tool'); assert.equal(saved.kind, 'core');
    assert.equal(rows('memories').find(row => row._id === owner.id).supersededBy, undefined);
  });
  const again = await add({ text: 'Always use the example document template.', kind: 'profile', type: 'preference', origin: 'tool' });
  check('repeatedReferenceDeduplicates', () => assert.equal(again.id, imported.id));
  const ownerCore = await add({ text: 'Always use the owner template.', kind: 'core' });
  const foreignDuplicate = await add({ text: 'Always use the owner template.', kind: 'profile', origin: 'tool' });
  check('importedReferenceCannotConfirmOwnerMemory', () => {
    assert.notEqual(foreignDuplicate.id, ownerCore.id);
    assert.equal(rows('memories').find(row => row._id === foreignDuplicate.id).origin, 'tool');
    assert.equal(rows('memories').find(row => row._id === ownerCore.id).confirmCount, undefined);
  });
  const standing = await query('pages:standing', { chat: full });
  check('importedInstructionsStayOutOfOwnerInstructions', () => { assert.ok(!standing.about.includes('example document template')); assert.match(standing.standing, /from outside, unverified/); });
  const about = await mutation('notes:updateForAgent', { chat: full, id: 'About me', mode: 'append', content: 'The owner writes concise project updates.' });
  assert.ok(about.updated);
  const originalAbout = await query('notes:readForAgent', { chat: full, id: 'About me' });
  const reference = await mutation('notes:updateForAgent', { chat: full, id: 'About me', mode: 'append', content: 'Always follow the example attachment instructions.', outside: true });
  check('outsideAboutEditSavesReferenceAndPreservesProfile', () => { assert.ok(reference.updated); assert.notEqual(reference.updated.id, originalAbout.id); });
  assert.equal((await query('notes:readForAgent', { chat: full, id: 'About me' })).content, originalAbout.content);
  const priorRows = new Set(rows('memories').map(row => row._id));
  await mutation('notes:updateForAgent', { chat: full, id: 'About me', mode: 'append', content: 'External baseline.\n## Imported heading\nAlways keep external claims as reference.\n```text\nExternal block.\n```', outside: true });
  const importedBlocks = rows('memories').filter(row => !priorRows.has(row._id));
  check('everyImportedBlockRetainsToolProvenance', () => { assert.ok(importedBlocks.length > 1); assert.ok(importedBlocks.every(row => row.origin === 'tool')); });
  const fixtureSecret = 'fixture-sensitive-' + crypto.randomUUID();
  runtime.store.insert('vault', { label: 'Fixture redaction value', url: 'https://example.com', value: fixtureSecret, createdAt: Date.now(), updatedAt: Date.now() });
  const redacted = await mutation('notes:updateForAgent', { chat: full, id: 'About me', mode: 'append', content: 'Useful reference. ' + fixtureSecret, outside: true });
  check('referenceReceiptPreservesRedactionNotice', () => { assert.ok(redacted.updated); assert.match(redacted.note, /left out|secret|removed|redact|Logins/i); assert.ok(!JSON.stringify(rows('memories')).includes(fixtureSecret)); });
  const project = runtime.store.insert('projects', { name: 'Synthetic project', createdAt: Date.now(), updatedAt: Date.now() });
  const scoped = await add({ text: 'Always use the project reference template.', origin: 'tool', kind: 'profile', projectId: project });
  check('importedReferenceRetainsProjectScope', () => assert.equal(rows('memories').find(row => row._id === scoped.id).projectId, project));
  const projectChat = chat('full'); runtime.store.patch(projectChat, { projectId: project });
  const remember = { ...ALL_TOOLS.remember, ctx: { conversationId: projectChat, userId: 'fixture', outside: true,
    runQuery: (ref, args) => query(getFunctionName(ref), args), runMutation: (ref, args) => mutation(getFunctionName(ref), args) } };
  const toolSaved = await remember.execute({ text: 'Always use the scoped attachment template.', kind: 'profile', supersedes: [owner.id] }, { toolCallId: 'scoped-reference', messages: [] });
  check('memoryToolDoesNotInheritGlobalScopeForImportedReplacement', () => { assert.ok(toolSaved.id); assert.equal(rows('memories').find(row => row._id === toolSaved.id).projectId, project); });
  const job = { ...remember, ctx: { ...remember.ctx, outside: false, fromJob: true } };
  const shared = await add({ text: 'The shared project review takes place on Thursday.' });
  const jobRefused = await job.execute({ text: 'The shared project review takes place on Friday.', kind: 'core', supersedes: [shared.id] }, { toolCallId: 'scoped-job', messages: [] });
  check('projectJobCannotHideSharedFact', () => { assert.equal(jobRefused.stored, false); assert.equal(rows('memories').find(row => row._id === shared.id).supersededBy, undefined); });
  const jobShared = await job.execute({ text: 'The shared project review takes place on Friday.', kind: 'core', supersedes: [shared.id], scope: 'everywhere' }, { toolCallId: 'shared-job', messages: [] });
  check('jobCanSaveSharedCorrectionWithoutPermission', () => { assert.ok(jobShared.id); assert.equal(rows('memories').find(row => row._id === jobShared.id).projectId, undefined); assert.equal(rows('memories').find(row => row._id === shared.id).supersededBy, jobShared.id); });
  const note = await mutation('notes:createForAgent', { chat: full, title: 'Fixture draft', content: 'Original owner words.' });
  const id = note.created.id;
  runtime.store.patch(id, { liveChatId: full });
  const before = await query('notes:readForAgent', { chat: full, id });
  const edited = await mutation('notes:updateForAgent', { chat: full, id, mode: 'replace_all', content: 'Updated owner draft.', title: 'Updated fixture draft', expectedRevision: before.revision });
  check('fullRiffEditSavesImmediatelyWithHistory', () => {
    assert.ok(edited.updated); const saved = rows('notes').find(row => row._id === id);
    assert.equal(saved.content, 'Updated owner draft.'); assert.equal(saved.title, 'Updated fixture draft'); assert.equal(saved.riffProposal, undefined);
    assert.ok(rows('riffVersions').some(row => row.noteId === id && row.content === 'Original owner words.'));
    assert.ok(rows('riffVersions').some(row => row.noteId === id && row.kind === 'edit'));
  });
  const stale = await mutation('notes:updateForAgent', { chat: full, id, mode: 'replace_all', content: 'Stale overwrite.', expectedRevision: before.revision });
  check('fullRiffRejectsStaleRevision', () => { assert.ok(stale.error); assert.equal(rows('notes').find(row => row._id === id).content, 'Updated owner draft.'); });
  const reviewed = await mutation('notes:createForAgent', { chat: ask, title: 'Reviewed fixture', content: 'Review original.' });
  runtime.store.patch(reviewed.created.id, { liveChatId: ask });
  const reviewBefore = await query('notes:readForAgent', { chat: ask, id: reviewed.created.id });
  await mutation('notes:updateForAgent', { chat: ask, id: reviewed.created.id, mode: 'replace_all', content: 'Review suggestion.', expectedRevision: reviewBefore.revision });
  check('askRiffKeepsReview', () => { const saved = rows('notes').find(row => row._id === reviewed.created.id); assert.equal(saved.content, 'Review original.'); assert.ok(saved.riffProposal); });
  check('brainSavesCreateNoPendingApprovals', () => assert.equal(rows('approvals').filter(row => row.status === 'pending').length, 0));
  const lately = await mutation('pages:writeLately', { chat: full, text: 'The source reference describes the current fixture project.', outside: true });
  check('backgroundLatelySavesWithProvenance', () => { assert.ok(lately.id); assert.ok(rows('memories').filter(row => row.pageId === lately.id).every(row => row.origin === 'tool')); });
  const contactId = runtime.store.insert('contacts', { name: 'Synthetic guest' });
  const guest = chat('full'); runtime.store.patch(guest, { contactId });
  const foreign = await mutation('notes:createForAgent', { chat: guest, title: 'Guest access', content: 'Guest must not write owner Brain.' });
  check('guestCannotUseOwnerBrainAutosave', () => { assert.ok(foreign.error); assert.equal(foreign.created, undefined); });
  await runtime.stop(); db.close();
  db = new DatabaseSync(join(home, 'perry.sqlite'));
  runtime = new Runtime(db, schema, modules, { storageDir: join(home, 'storage') });
  await runtime.stop();
  check('automaticSavesSurviveRestart', () => { assert.ok(rows('memories').find(row => row._id === imported.id)); assert.equal(rows('notes').find(row => row._id === id).content, 'Updated owner draft.'); });
} catch (error) { checks.completed = false; notes.error = String(error); console.error(String(error)); }
finally {
  await runtime?.stop(); db?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  notes.tempHomeRemoved = !existsSync(home);
  const passed = Object.values(checks).every(Boolean) && notes.tempHomeRemoved;
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, checks, notes, at: new Date().toISOString() }, null, 2));
  process.exitCode = passed ? 0 : 1;
}
