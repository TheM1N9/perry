// Failure inventory: docs/regression-checks.md. Real Runtime/SQLite/HTTP regression journey, isolated HOME.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/library/lifecycle.mjs <outDir>
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const home = mkdtempSync(join(tmpdir(), 'perry-origin-'));
const out = resolve(process.argv[2] ?? 'node_modules/.cache/library-lifecycle');
mkdirSync(out, { recursive: true });
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = 'synthetic-origin-key';
process.env.PERRY_CREDENTIAL_KEY = '63'.repeat(32);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => { if (!String(input).startsWith('http://127.0.0.1:'))
    throw Error('External IO disabled'); return nativeFetch(input, ...args); };
const [{ Runtime }, { default: schema }, { modules }] = await Promise.all([import('../../server/runtime.ts'), import('../../convex/schema.ts'), import('../../server/modules.ts')]);
const sql = new DatabaseSync(join(home, 'fixture.sqlite'));
let runtime = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') });
await runtime.stop();
const key = process.env.DASHBOARD_KEY, token = 'native-origin-runner', remoteToken = 'remote-origin-runner', checks = [];
const server = createServer(async (req, res) => { try {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    if (req.url === '/blob') {
        const id = await runtime.storeFile(new Blob(chunks, { type: 'text/plain' }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id }));
        return;
    }
    if (req.url?.startsWith('/item/')) {
        const item = (await runtime.call('library:file', { key, id: req.url.slice(6) }, { internal: true })).value;
        if (!item) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.end(readFileSync(item.path));
        return;
    }
    const { path, args } = JSON.parse(Buffer.concat(chunks).toString());
    const value = (await runtime.call(path, args, { internal: true })).value;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ value }));
}
catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
} });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (path, args = {}) => { const body = await (await fetch(base + '/call', { method: 'POST', body: JSON.stringify({ path, args }) })).json(); if (body.error)
    throw Error(path + ': ' + body.error); return body.value; };
const rows = table => runtime.exclusive(() => runtime.store.all(table));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const check = (name, ok) => { checks.push({ name, pass: Boolean(ok) }); assert.ok(ok, name); console.log('PASS ' + name); };
const blob = async (text) => (await (await fetch(base + '/blob', { method: 'POST', body: text })).json()).id;
let nativeId, remoteId;
const turn = async (chat, remote = false) => { chat ??= await call('dashboard:createChat', { key }); const id = await runtime.exclusive(() => { const now = Date.now(); const runId = runtime.store.insert('runs', { conversationId: chat, prompt: 'Synthetic file share', status: 'running', startedAt: now }); return runtime.store.insert('codexTurns', { conversationId: chat, runnerId: remote ? remoteId : nativeId, runId, engine: 'codex', prompt: 'Synthetic file share', instructions: 'Preserve owner file boundaries.', status: 'queued', createdAt: now }); }); const claimed = await call('codex:claimTurn', { token: remote ? remoteToken : token, id }); assert.ok(claimed); return { chat, id, token: remote ? remoteToken : token }; };
const share = async (t, path, text) => { await call('media:shareFromTurn', { turnId: t.id, path }); const storageId = await blob(text); await call('codex:finishTurn', { token: t.token, id: t.id, response: 'Synthetic shared file.', media: [{ storageId, localPath: path, fileName: path.split(/[\\/]/).at(-1), contentType: 'text/plain' }] }); await call('codex:finalizeTurn', { id: t.id }); return storageId; };
try {
    await runtime.exclusive(() => { runtime.store.insert('installation', { createdAt: Date.now(), defaultEngine: 'codex', onboarding: 'skipped' }); const engine = { kind: 'codex', installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }; nativeId = runtime.store.insert('runners', { name: 'Native fixture', token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [engine] }); remoteId = runtime.store.insert('runners', { name: 'Remote fixture', token: remoteToken, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [engine] }); });
    writeFileSync(join(home, 'runner.json'), JSON.stringify({ token, url: base }));
    mkdirSync(join(home, 'files'), { recursive: true });
    const path = join(home, 'files', 'shared.txt');
    writeFileSync(path, 'v1');
    await call('library:sync');
    const initial = (await rows('library')).find(x => x.localPath === path);
    const a = await turn();
    const aStorage = await share(a, path, 'v1');
    const b = await turn();
    writeFileSync(path, 'version two');
    const bStorage = await share(b, path, 'version two');
    await call('library:sync');
    await call('library:backfill');
    const canonical = (await rows('library')).filter(x => x.originPath === path && x.originRunnerId === nativeId);
    check('two shares and folder scan retain one logical item', canonical.length === 1 && canonical[0]._id === initial._id);
    const item = canonical[0];
    check('Library serves newest stored bytes', await (await fetch(base + '/item/' + item._id)).text() === 'version two');
    check('metadata size matches stored bytes', item.size === 11);
    check('older chat immutable copy retains original bytes', await (await runtime.readFile(aStorage)).text() === 'v1');
    check('all chat snapshots link canonical item', (await rows('chatAttachments')).filter(x => x.libraryId === item._id).length === 2);
    writeFileSync(path, 'changed outside after sharing');
    await call('library:sync');
    check('folder rescan does not change stored bytes or size', await (await fetch(base + '/item/' + item._id)).text() === 'version two' && (await get(item._id)).size === 11);
    fs.renameSync(path, path + '.away');
    check('stored preview remains available when native original is missing', await (await fetch(base + '/item/' + item._id)).text() === 'version two');
    const foundSnapshot = (await call('library:find', { query: 'shared.txt' })).find(found => found.id === item._id);
    check('model-facing Library path resolves the same stored snapshot', foundSnapshot.path === join(home, 'storage', bStorage) && readFileSync(foundSnapshot.path, 'utf8') === 'version two');
    fs.renameSync(path + '.away', path);
    const byId = await turn();
    await call('media:shareFromLibrary', { turnId: byId.id, id: item._id });
    await call('media:shareFromLibrary', { turnId: byId.id, id: item._id });
    const byIdFiles = (await rows('chatAttachments')).filter(x => x.messageKey === `codex-${byId.id}`);
    check('share by Library id uses preview snapshot once despite changed original', byIdFiles.length === 1 && byIdFiles[0].storageId === bStorage && !byIdFiles[0].localPath && byIdFiles[0].libraryId === item._id);
    await call('codex:finishTurn', { token, id: byId.id, response: 'Shared stored snapshot' });
    await call('codex:finalizeTurn', { id: byId.id });
    await runtime.stop();
    runtime = new Runtime(sql, schema, modules, { storageDir: join(home, 'storage') });
    await runtime.stop();
    await call('library:backfill');
    check('origin identity and snapshot refs survive Runtime restart', (await rows('library')).filter(x => x.originPath === path).length === 1 && (await rows('chatAttachments')).filter(x => x.libraryId === item._id).length === 3 && await (await fetch(base + '/item/' + item._id)).text() === 'version two');
    await call('dashboard:deleteChat', { key, id: b.chat });
    check('deleting latest chat retains Library current snapshot', await (await fetch(base + '/item/' + item._id)).text() === 'version two' && existsSync(join(home, 'storage', bStorage)));
    check('remaining chat old copy stays readable', await (await runtime.readFile(aStorage)).text() === 'v1');
    await call('library:remove', { key, id: item._id });
    check('Library removal tombstones every remaining chat reference', (await rows('chatAttachments')).filter(x => x.libraryId === item._id).every(x => x.removedAt && !x.storageId && !x.localPath));
    check('Library removal deletes all snapshots', !existsSync(join(home, 'storage', aStorage)) && !existsSync(join(home, 'storage', bStorage)));
    check('native generated original removed', !existsSync(path));
    await call('library:sync');
    check('removed native file does not return on folder scan', !(await rows('library')).some(x => x.originPath === path || x.localPath === path));
    const external = join(home, 'owner-original.txt');
    writeFileSync(external, 'owner original');
    const c = await turn();
    const cStorage = await share(c, external, 'owner original');
    const owned = (await rows('library')).find(x => x.originPath === external);
    await call('dashboard:deleteChat', { key, id: c.chat });
    check('last chat deletion retains source-backed Library snapshot', await (await fetch(base + '/item/' + owned._id)).text() === 'owner original');
    const removed = await call('library:remove', { key, id: owned._id });
    check('external original retained and reported', existsSync(external) && removed.kept === external && !existsSync(join(home, 'storage', cStorage)));
    const same = join(home, 'files', 'same-spelling.txt');
    writeFileSync(same, 'server local');
    await call('library:sync');
    const localItem = (await rows('library')).find(x => x.localPath === same);
    const remote = await turn(undefined, true);
    let originIO = 0;
    const nativeIO = new Map(['realpathSync', 'statSync', 'readFileSync', 'rmSync'].map(name => [name, fs[name]]));
    for (const [name, native] of nativeIO)
        fs[name] = function (target, ...args) { if (String(target) === same)
            originIO++; return native.call(this, target, ...args); };
    syncBuiltinESMExports();
    let remoteItem;
    try {
        await share(remote, same, 'remote bytes');
        remoteItem = (await rows('library')).find(x => x.originPath === same && x.originRunnerId === remoteId);
        check('remote same-spelled path is distinct and has no local location', remoteItem && remoteItem._id !== localItem._id && !remoteItem.localPath);
        check('remote origin serves only backend snapshot', await (await fetch(base + '/item/' + remoteItem._id)).text() === 'remote bytes');
        await call('library:remove', { key, id: remoteItem._id });
    }
    finally {
        for (const [name, native] of nativeIO)
            fs[name] = native;
        syncBuiltinESMExports();
    }
    check('remote origin performs no server realpath stat read or delete', originIO === 0);
    check('remote origin removal never deletes server same-spelled file', readFileSync(same, 'utf8') === 'server local');
    const missingPath = join(home, 'files', 'unknown-producer.txt');
    writeFileSync(missingPath, 'server private');
    await call('library:sync');
    const unknown = await runtime.exclusive(() => runtime.store.insert('chatAttachments', { conversationId: a.chat, messageKey: 'codex-missing-turn', localPath: missingPath, fileName: 'unknown-producer.txt', contentType: 'text/plain', size: 0, createdAt: Date.now() }));
    await call('library:indexAttachment', { id: unknown });
    const unknownItem = await get((await get(unknown)).libraryId);
    check('missing codex producer does not infer a server location or origin', !unknownItem.localPath && !unknownItem.originRunnerId && unknownItem._id !== (await rows('library')).find(x => x.localPath === missingPath)._id);
    const late = join(home, 'files', 'late.txt');
    writeFileSync(late, 'late');
    const pending = await turn();
    await call('media:shareFromTurn', { turnId: pending.id, path: late });
    const before = (await rows('library')).find(x => x.originPath === late);
    await call('library:remove', { key, id: before._id });
    const lateStorage = await blob('late');
    await call('codex:finishTurn', { token, id: pending.id, response: 'Late snapshot acknowledgement', media: [{ storageId: lateStorage, localPath: late, fileName: 'late.txt', contentType: 'text/plain' }] });
    await call('codex:finalizeTurn', { id: pending.id });
    check('late snapshot acknowledgement cannot resurrect removed Library file', !(await rows('library')).some(x => x.name === 'late.txt') && !existsSync(join(home, 'storage', lateStorage)));
    const reshare = await turn();
    writeFileSync(late, 'explicit new share');
    await share(reshare, late, 'explicit new share');
    const reshared = (await rows('library')).find(x => x.originPath === late);
    check('new turn explicit re-share after removal is allowed', reshared && await (await fetch(base + '/item/' + reshared._id)).text() === 'explicit new share');
    const opposite = join(home, 'owner-opposite.txt');
    writeFileSync(opposite, 'shared external');
    const first = await turn(), second = await turn();
    const firstBlob = await share(first, opposite, 'first copy'), secondBlob = await share(second, opposite, 'second copy');
    const oppositeItem = (await rows('library')).find(x => x.originPath === opposite);
    await call('dashboard:deleteChat', { key, id: first.chat });
    check('deleting origin chat retargets surviving chat and keeps its snapshot', (await get(oppositeItem._id)).conversationId === second.chat && await (await fetch(base + '/item/' + oppositeItem._id)).text() === 'second copy');
    await call('library:remove', { key, id: oppositeItem._id });
    check('opposite deletion order removes remaining copies and keeps external original', !existsSync(join(home, 'storage', firstBlob)) && !existsSync(join(home, 'storage', secondBlob)) && existsSync(opposite));
    const legacy1 = await blob('legacy one'), legacy2 = await blob('legacy two');
    await call('media:attachStored', { conversationId: a.chat, messageKey: 'legacy-1', storageId: legacy1, fileName: 'lost-path.txt', contentType: 'text/plain', size: 10 });
    await call('media:attachStored', { conversationId: a.chat, messageKey: 'legacy-2', storageId: legacy2, fileName: 'lost-path.txt', contentType: 'text/plain', size: 10 });
    await call('library:backfill');
    const unknownOrigins = (await rows('library')).filter(x => x.name === 'lost-path.txt');
    check('legacy stored-only equal names are not merged or assigned an origin', unknownOrigins.length === 2 && unknownOrigins.every(x => !x.originPath && !x.originRunnerId));
    const pendingPath = join(home, 'files', 'pending-remote.txt');
    writeFileSync(pendingPath, 'native pending');
    const nativePending = await turn();
    await share(nativePending, pendingPath, 'native stored');
    const nativePendingItem = (await rows('library')).find(x => x.originPath === pendingPath && x.originRunnerId === nativeId);
    const remotePending = await turn(undefined, true);
    await call('media:shareFromTurn', { turnId: remotePending.id, path: pendingPath });
    const remoteAttachment = (await rows('chatAttachments')).find(x => x.messageKey === `codex-${remotePending.id}`);
    const copiedRemote = await runtime.exclusive(() => runtime.store.insert('chatAttachments', { conversationId: remotePending.chat, messageKey: 'copied-pending-remote', libraryId: remoteAttachment.libraryId, originPath: remoteAttachment.originPath, localPath: pendingPath, fileName: 'pending-remote.txt', contentType: 'text/plain', size: 0, createdAt: Date.now() }));
    let copiedOriginIO = 0;
    const copiedNativeIO = new Map(['realpathSync', 'statSync', 'readFileSync', 'rmSync'].map(name => [name, fs[name]]));
    for (const [name, native] of copiedNativeIO) fs[name] = function (target, ...args) { if (String(target) === pendingPath) copiedOriginIO++; return native.call(this, target, ...args); };
    syncBuiltinESMExports();
    try {
        await call('library:indexAttachment', { id: copiedRemote });
        check('copied pending remote with non-codex key stays unavailable to local protocols', await call('media:localAttachment', { key, id: copiedRemote }) === null && await call('media:runnerAttachment', { token: remoteToken, id: copiedRemote }) === null);
    } finally {
        for (const [name, native] of copiedNativeIO) fs[name] = native;
        syncBuiltinESMExports();
    }
    check('copied remote canonical identity causes no native path IO', copiedOriginIO === 0);
    check('pending remote path is unavailable to dashboard and runner local file protocols', (await call('media:localAttachment', { key, id: remoteAttachment._id })) === null && (await call('media:runnerAttachment', { token: remoteToken, id: remoteAttachment._id })) === null);
    await call('dashboard:deleteChat', { key, id: nativePending.chat });
    check('native chat deletion cannot reattribute item to same-spelled remote chat', !(await get(nativePendingItem._id)).conversationId && !(await get(remoteAttachment._id)).removedAt);
    await call('library:remove', { key, id: nativePendingItem._id });
    check('native removal cannot tombstone explicit different remote Library reference', !(await get(remoteAttachment._id)).removedAt);
    const pendingBlob = await blob('remote pending snapshot');
    await call('codex:finishTurn', { token: remoteToken, id: remotePending.id, response: 'remote pending result', media: [{ storageId: pendingBlob, localPath: pendingPath, fileName: 'pending-remote.txt', contentType: 'text/plain' }] });
    await call('codex:finalizeTurn', { id: remotePending.id });
    check('remote pending snapshot remains deliverable after native removal', await (await fetch(base + '/item/' + remoteAttachment.libraryId)).text() === 'remote pending snapshot');
    const sharedLegacy = await blob('shared legacy bytes');
    const legacyPair = await runtime.exclusive(() => { const now = Date.now(); const fields = { name: 'ambiguous legacy.txt', contentType: 'text/plain', kind: 'document', size: 19, storageId: sharedLegacy, by: 'owner', from: 'web', how: 'upload', search: 'ambiguous legacy.txt', createdAt: now }; const one = runtime.store.insert('library', fields), two = runtime.store.insert('library', fields); const attachmentFields = { conversationId: a.chat, messageKey: 'ambiguous-legacy', fileName: 'ambiguous legacy.txt', contentType: 'text/plain', size: 19, storageId: sharedLegacy, createdAt: now }; runtime.store.insert('chatAttachments', { ...attachmentFields, libraryId: one }); const other = runtime.store.insert('chatAttachments', { ...attachmentFields, libraryId: two }); return { one, two, other }; });
    await call('library:remove', { key, id: legacyPair.one });
    check('removing legacy duplicate cannot delete another logical items shared blob', await (await fetch(base + '/item/' + legacyPair.two)).text() === 'shared legacy bytes' && !(await get(legacyPair.other)).removedAt && existsSync(join(home, 'storage', sharedLegacy)));
    const versionOne = await blob('version one'), versionTwo = await blob('version two');
    const versionItems = await runtime.exclusive(() => {
        const fields = { name: 'legacy-version.txt', localPath: same, contentType: 'text/plain', kind: 'document', size: 11, by: 'owner', from: 'web', how: 'upload', search: 'legacy-version.txt', createdAt: Date.now() };
        return [runtime.store.insert('library', { ...fields, storageId: versionOne }), runtime.store.insert('library', { ...fields, storageId: versionTwo })];
    });
    const versionsTurn = await turn();
    for (const id of [...versionItems, ...versionItems]) await call('media:shareFromLibrary', { turnId: versionsTurn.id, id });
    const selectedVersions = (await rows('chatAttachments')).filter(row => row.messageKey === `codex-${versionsTurn.id}`);
    check('explicit different Library versions sharing a path retain both selected snapshots', selectedVersions.length === 2 && selectedVersions.some(row => row.libraryId === versionItems[0] && row.storageId === versionOne && !row.localPath) && selectedVersions.some(row => row.libraryId === versionItems[1] && row.storageId === versionTwo && !row.localPath));
    const nativeSourcePath = join(home, 'files', 'native-source-remote-consumer.txt');
    writeFileSync(nativeSourcePath, 'native source bytes');
    const nativeSourceId = await call('library:add', { path: nativeSourcePath, how: 'added', by: 'owner' });
    const remoteConsumer = await turn(undefined, true);
    await call('media:shareFromLibrary', { turnId: remoteConsumer.id, id: nativeSourceId });
    const nativeSourceCopy = (await rows('chatAttachments')).find(row => row.messageKey === `codex-${remoteConsumer.id}`);
    check('remote consumer retains proven native Library source identity', (await get(nativeSourceCopy.libraryId)).localPath === nativeSourcePath && (await call('media:localAttachment', { key, id: nativeSourceCopy._id })).localPath === nativeSourcePath);
    const stepPath = join(home, 'files', 'remote-step-collision.txt');
    writeFileSync(stepPath, 'server native step bytes');
    const remoteStep = await turn(undefined, true);
    const remoteStepRun = (await get(remoteStep.id)).runId;
    let stepIO = 0;
    const stepNativeIO = new Map(['realpathSync', 'statSync', 'readFileSync', 'rmSync'].map(name => [name, fs[name]]));
    for (const [name, native] of stepNativeIO) fs[name] = function (target, ...args) { if (String(target) === stepPath) stepIO++; return native.call(this, target, ...args); };
    syncBuiltinESMExports();
    let remoteStepRow;
    try {
        await call('codex:traceTurn', { token: remoteToken, id: remoteStep.id, spans: [{ callId: 'remote-file-change', kind: 'fileChange', name: stepPath, status: 'ok', startedAt: Date.now(), endedAt: Date.now() }] });
        remoteStepRow = (await rows('chatAttachments')).find(row => row.messageKey === `steps-${remoteStepRun}`);
        check('authenticated remote traced file is denied by local file protocol', await call('media:localAttachment', { key, id: remoteStepRow._id }) === null);
        check('authenticated remote trace cannot serve same-spelled server bytes', await (await fetch(base + '/item/' + remoteStepRow.libraryId)).text() !== 'server native step bytes');
    } finally {
        for (const [name, native] of stepNativeIO) fs[name] = native;
        syncBuiltinESMExports();
    }
    check('remote traced file performs zero native source path IO', stepIO === 0);
    const externalStepPath = join(home, 'owner-step-collision.txt');
    writeFileSync(externalStepPath, 'native owner bytes');
    const externalNativeIO = new Map(['realpathSync', 'statSync', 'readFileSync', 'rmSync'].map(name => [name, fs[name]]));
    let externalStepIO = 0;
    for (const [name, native] of externalNativeIO) fs[name] = function (target, ...args) { if (String(target) === externalStepPath) externalStepIO++; return native.call(this, target, ...args); };
    syncBuiltinESMExports();
    try {
        await call('codex:traceTurn', { token: remoteToken, id: remoteStep.id, spans: [{ callId: 'remote-external-file', kind: 'fileChange', name: externalStepPath, status: 'ok', startedAt: Date.now(), endedAt: Date.now() }] });
        const originalStep = (await rows('chatAttachments')).find(row => row.messageKey === `steps-${remoteStepRun}` && row.localPath === externalStepPath);
        const copiedStep = await runtime.exclusive(() => runtime.store.insert('chatAttachments', { conversationId: remoteStep.chat, messageKey: 'copied-external-step', localPath: originalStep.localPath, originPath: originalStep.originPath, originRunnerId: originalStep.originRunnerId, fileName: originalStep.fileName, contentType: originalStep.contentType, size: 0, createdAt: Date.now() }));
        check('copied remote step without Library membership retains producer and is denied', originalStep.originRunnerId === remoteId && !originalStep.libraryId && await call('media:localAttachment', { key, id: copiedStep }) === null && await call('media:runnerAttachment', { token: remoteToken, id: copiedStep }) === null);
    } finally {
        for (const [name, native] of externalNativeIO) fs[name] = native;
        syncBuiltinESMExports();
    }
    check('remote external step and copy cause zero native path IO', externalStepIO === 0);
    const nativeStepPath = join(home, 'files', 'native-step.txt');
    writeFileSync(nativeStepPath, 'native step');
    const nativeStep = await turn();
    const nativeStepRun = (await get(nativeStep.id)).runId;
    await call('codex:traceTurn', { token, id: nativeStep.id, spans: [{ callId: 'native-file-change', kind: 'fileChange', name: nativeStepPath, status: 'ok', startedAt: Date.now(), endedAt: Date.now() }] });
    const nativeStepRow = (await rows('chatAttachments')).find(row => row.messageKey === `steps-${nativeStepRun}`);
    check('authenticated native traced file remains readable', nativeStepRow.originRunnerId === nativeId && (await call('media:localAttachment', { key, id: nativeStepRow._id })).localPath === nativeStepPath);
    const legacyStep = await runtime.exclusive(() => runtime.store.insert('chatAttachments', { conversationId: nativeStep.chat, messageKey: `steps-${nativeStepRun}`, localPath: nativeStepPath, fileName: 'legacy-step.txt', contentType: 'text/plain', size: 0, createdAt: Date.now() }));
    check('legacy step unambiguous native producer remains readable', (await call('media:localAttachment', { key, id: legacyStep })).localPath === nativeStepPath);
    await runtime.exclusive(() => runtime.store.insert('codexTurns', { conversationId: nativeStep.chat, runnerId: remoteId, runId: nativeStepRun, engine: 'codex', prompt: 'Historical mixed producer', instructions: '', status: 'done', createdAt: Date.now(), finishedAt: Date.now(), finalizedAt: Date.now() }));
    check('legacy step mixed producers fail closed without changing explicit native source', await call('media:localAttachment', { key, id: legacyStep }) === null && (await call('media:localAttachment', { key, id: nativeStepRow._id })).localPath === nativeStepPath);
    const missingStep = await runtime.exclusive(() => runtime.store.insert('chatAttachments', { conversationId: nativeStep.chat, messageKey: 'steps-missing-run', localPath: nativeStepPath, fileName: 'missing-step.txt', contentType: 'text/plain', size: 0, createdAt: Date.now() }));
    check('legacy step missing producer fails closed', await call('media:localAttachment', { key, id: missingStep }) === null);
}
catch (error) {
    checks.push({ name: 'journey completion', pass: false, error: error.stack });
    process.exitCode = 1;
}
finally {
    await runtime.stop();
    await new Promise(done => server.close(done));
    sql.close();
    globalThis.fetch = nativeFetch;
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep) || !basename(home).startsWith('perry-origin-')) throw Error('Scratch cleanup escaped its allocated home');
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    const result = { checkedAt: new Date().toISOString(), pass: checks.every(x => x.pass), checks, homeRemoved: !existsSync(home), ...(existsSync(home) ? { retainedHome: home } : {}) };
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ artifact: join(out, 'result.json'), pass: result.pass, checks: checks.length, homeRemoved: result.homeRemoved }));
}
