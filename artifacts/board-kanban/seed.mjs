import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const home = process.argv[2];
if (!home || process.env.PERRY_HOME !== home) throw Error('Seed only the explicitly isolated Perry home');
const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
  import('../../server/runtime.ts'), import('../../convex/schema.ts'), import('../../server/modules.ts'), import('../../server/credential-encryption.ts'),
]);
const sql = new DatabaseSync(join(home, 'perry.sqlite'));
initializeCredentialEncryption(sql, home);
const runtime = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') });
await runtime.stop();
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const now = Date.now();
const ids = { queued: [], done: [] };
try {
  await insert('installation', { createdAt: now, defaultEngine: 'codex', onboarding: 'skipped', paused: { at: now, by: 'web' } });
  const project = await insert('projects', { name: 'Launch workspace', instructions: '', createdAt: now, updatedAt: now });
  ids.project = project;
  const runner = await insert('runners', { name: 'Studio computer', token: 'kanban-synthetic-studio', autoApprove: false, revoked: false, createdAt: now, lastSeenAt: now, turnHeartbeats: true });
  const remote = await insert('runners', { name: 'Travel computer', token: 'kanban-synthetic-travel', autoApprove: false, revoked: false, createdAt: now, lastSeenAt: now, turnHeartbeats: true });
  ids.token = 'kanban-synthetic-studio';
  const task = (title, status, extra = {}) => insert('tasks', { title, prompt: 'Synthetic isolated board work. Do not invoke a provider.', status, plan: [], createdAt: now, updatedAt: now, ...extra });
  const chat = (title, extra = {}) => insert('conversations', { title, channel: 'web', externalId: `kanban-${title}`, threadId: `kanban-${title}`, lastMessageAt: now, engine: 'codex', ...extra });
  for (let index = 0; index < 72; index++) ids.queued.push(await task(`Queued launch item ${String(index + 1).padStart(2, '0')}`, 'queued', { createdAt: now - index * 1000, updatedAt: now - index * 1000 }));
  for (let index = 0; index < 65; index++) ids.done.push(await task(`Completed launch item ${String(index + 1).padStart(2, '0')}`, 'done', { result: 'Verified synthetic completed output.', createdAt: now - 100_000 - index * 1000, updatedAt: now - 1000 - index * 1000 }));
  ids.mixedFirst = await task('Mixed queue next task', 'queued', { createdAt: now - 90_000, updatedAt: now - 1000 });
  ids.mixedSecond = await task('Mixed queue second task', 'queued', { createdAt: now - 89_000, updatedAt: now + 2000 });
  const mixedChat = await chat('Mixed queue conversation', { codexRunnerId: runner });
  const mixedRun = await insert('runs', { conversationId: mixedChat, prompt: 'Mixed queue conversation', status: 'running', startedAt: now + 1000 });
  await insert('codexTurns', { conversationId: mixedChat, runId: mixedRun, runnerId: runner, engine: 'codex', prompt: 'Synthetic queued chat.', instructions: 'No provider calls.', status: 'queued', createdAt: now + 1000 });
  ids.mixedChat = `run:${mixedRun}`;
  ids.blocked = await task('Waiting for prerequisite', 'queued', { dependsOn: [ids.queued[0]] });
  ids.tracked = await task('Saved plan without executing worker', 'running');
  ids.waiting = await task('Choose launch window', 'blocked', { question: 'Which launch window should I use?' });
  ids.failed = await task('Upload retry information', 'failed', { error: 'Synthetic upload failed; review this update.' });
  ids.live = await task('Live launch review', 'running', { turns: 1 });
  const liveChat = await chat('Launch review chat', { taskId: ids.live, projectId: project, codexRunnerId: runner });
  await runtime.exclusive(() => runtime.store.patch(ids.live, { conversationId: liveChat }));
  const liveRun = await insert('runs', { conversationId: liveChat, prompt: 'Verify launch readiness.', status: 'running', startedAt: now });
  ids.turn = await insert('codexTurns', { conversationId: liveChat, runId: liveRun, runnerId: runner, engine: 'codex', prompt: 'Synthetic review.', instructions: 'No provider calls.', status: 'running', createdAt: now, startedAt: now, lastHeartbeatAt: now });
  ids.child = await chat('Research accessibility child', { projectId: project, codexRunnerId: runner, parentConversationId: liveChat, providerAgent: { id: 'kanban-child', runId: liveRun, status: 'running', startedAt: now, updatedAt: now, prompt: 'Check the keyboard interaction.', text: 'Reviewing keyboard navigation.' } });
  const questionRun = await insert('runs', { conversationId: ids.child, prompt: 'Review native child question.', status: 'running', startedAt: now });
  ids.questionRun = questionRun;
  ids.questionTurn = await insert('codexTurns', { conversationId: ids.child, runId: questionRun, runnerId: runner, engine: 'codex', prompt: 'Synthetic native question.', instructions: 'No provider calls.', status: 'running', createdAt: now, startedAt: now, lastHeartbeatAt: now });
  ids.doneParent = await task('Archived release package', 'done', { result: 'The parent completed; its child still needs a decision.', createdAt: now - 900_000, updatedAt: now - 21_000 });
  const doneChat = await chat('Archived release chat', { taskId: ids.doneParent, codexRunnerId: runner });
  await runtime.exclusive(() => runtime.store.patch(ids.doneParent, { conversationId: doneChat }));
  const doneRun = await insert('runs', { conversationId: doneChat, prompt: 'Create the archived release package.', status: 'ok', startedAt: now - 900_000, finishedAt: now - 900_000 });
  ids.waitingChild = await chat('Security sign-off child', { codexRunnerId: runner, parentConversationId: doneChat, providerAgent: { id: 'kanban-waiting-child', runId: doneRun, status: 'running', startedAt: now - 900_000, updatedAt: now, prompt: 'Obtain approval before publishing the security notes.', text: 'Waiting for the owner to review the export.' } });
  const childRun = await insert('runs', { conversationId: ids.waitingChild, prompt: 'Review the synthetic security export.', status: 'running', startedAt: now });
  ids.childRun = childRun;
  ids.childSpan = await insert('runSpans', { runId: childRun, callId: 'kanban-follow-up', kind: 'commentary', name: 'Owner follow-up', status: 'done', startedAt: now + 10, output: 'Security follow-up is ready for review.' });
  ids.childTurn = await insert('codexTurns', { conversationId: ids.waitingChild, runId: childRun, runnerId: runner, engine: 'codex', prompt: 'Synthetic child review.', instructions: 'No provider calls.', status: 'running', createdAt: now, startedAt: now, lastHeartbeatAt: now });
  ids.childApproval = await insert('approvals', { runnerId: runner, turnId: ids.childTurn, conversationId: ids.waitingChild, kind: 'command', title: 'Approve synthetic security export', detail: 'Fixture only: no command executes.', status: 'pending', createdAt: now });
  ids.finishedChild = await chat('Completed follow-up agent', { codexRunnerId: runner, parentConversationId: liveChat, providerAgent: { id: 'kanban-finished-child', runId: liveRun, status: 'done', startedAt: now - 2000, updatedAt: now - 1000, finishedAt: now - 1000, text: 'Initial delegation completed.' } });
  ids.finishedRun = await insert('runs', { conversationId: ids.finishedChild, prompt: 'Owner follow-up after delegation.', status: 'ok', startedAt: now - 500, finishedAt: now + 20 });
  await insert('codexTurns', { conversationId: ids.finishedChild, runId: ids.finishedRun, runnerId: runner, engine: 'codex', prompt: 'Synthetic completed follow-up.', instructions: 'No provider calls.', status: 'done', createdAt: now - 500, finishedAt: now + 20, response: 'Follow-up result delivered.' });
  const remoteChat = await chat('Travel launch brief', { projectId: project, codexRunnerId: remote });
  const remoteRun = await insert('runs', { conversationId: remoteChat, prompt: 'Prepare the travel brief.', status: 'ok', startedAt: now - 9000, finishedAt: now - 8000 });
  await insert('codexTurns', { conversationId: remoteChat, runId: remoteRun, runnerId: remote, engine: 'codex', prompt: 'Synthetic completed travel brief.', instructions: 'No provider calls.', status: 'done', createdAt: now - 9000, finishedAt: now - 8000 });
  ids.remoteThread = `run:${remoteRun}`;
  ids.approval = await insert('approvals', { runnerId: runner, kind: 'command', title: 'Review synthetic export command', detail: 'Fixture only: no command will execute.', status: 'pending', createdAt: now });
  process.stdout.write(JSON.stringify(ids));
} finally {
  await runtime.stop();
  sql.close();
}
