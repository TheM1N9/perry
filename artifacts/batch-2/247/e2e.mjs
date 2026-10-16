import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const scratch = resolve('.batch-work/batch-2/247');
const home = fs.mkdtempSync(join(scratch, 'fixture-'));
process.env.PERRY_HOME = home;
process.env.PERRY_DB = join(home, 'fixture.sqlite');
process.env.DASHBOARD_KEY = 'synthetic-247-dashboard';
process.env.PERRY_CREDENTIAL_KEY = '22'.repeat(32);
globalThis.fetch = async () => { throw new Error('Network forbidden in queue E2E'); };
for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[method] = () => { throw new Error('Child processes forbidden'); };
syncBuiltinESMExports();
const [{ Runtime }, {default: schema}, codex, queue, dashboard, brain, agentStore, {internalMutation}] = await Promise.all([
  import('../../../server/runtime.ts'), import('../../../convex/schema.ts'), import('../../../convex/codex.ts'),
  import('../../../convex/queue.ts'), import('../../../convex/dashboard.ts'), import('../../../convex/brain.ts'), import('../../../convex/agentStore.ts'), import('../../../convex/_generated/server.js'),
]);
const harness = { fallback: internalMutation({ handler: async (ctx, args) => { await codex.queueSteer(ctx, args.steer); } }) };
const sql = new DatabaseSync(process.env.PERRY_DB);
const runtime = new Runtime(sql, schema, {codex, queue, dashboard, brain, agentStore, harness}, {storageDir: join(home, 'storage')});
await runtime.stop();
const db = runtime.store;
const now = Date.now();
const runnerId = db.insert('runners', {name:'Fake',token:'synthetic-runner',createdAt:now,lastSeenAt:now,engines:[{kind:'codex',installed:true,signedIn:true,auth:{},models:[],updatedAt:now}]});
db.insert('installation', {defaultEngine:'codex',createdAt:now});
const checks = [];
async function check(name, action) { try { await action(); checks.push({name,passed:true}); } catch(error) { checks.push({name,passed:false,detail: String(error.message).slice(0,350)}); } }
const mutate = (name,args) => runtime.runMutation(name,args,{internal:true});
const makeChat = (extra={}) => db.insert('conversations',{channel:'web',externalId:crypto.randomUUID(),threadId:'synthetic-thread',title:'Fixture',engine:'codex',codexRunnerId:runnerId,lastMessageAt:now,pendingTurns:0,...extra});
const run = chat => db.insert('runs',{conversationId:chat,prompt:'Synthetic',status:'running',startedAt:now});
const enqueue = (chat,extra={}) => mutate('codex:enqueueTurn',{conversationId:chat,runId:run(chat),prompt:crypto.randomUUID(),instructions:'Synthetic',...extra});
const queued = chat => db.all('codexTurns').filter(t=>t.conversationId===chat && t.status==='queued');
const remove = (chat,id,key=process.env.DASHBOARD_KEY) => mutate('queue:remove',{key,conversationId:chat,id});
await check('parallel ordinary/background admission admits exactly 10, refuses 11th with clear detail', async()=>{
 const chat=makeChat(); const results=await Promise.allSettled(Array.from({length:11},()=>enqueue(chat)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10); assert.equal(queued(chat).length,10);
 const error=results.find(r=>r.status==='rejected').reason; assert.match(error.message,/10 messages waiting/);
 assert(!error.message.includes('ConvexError'));
});
await check('dashboard outbox reserves 10 slots; handoff replaces its slot and duplicate enqueue is idempotent',async()=>{
 const chat=makeChat();
 const results=await Promise.allSettled(Array.from({length:11},(_,i)=>mutate('dashboard:sendChat',{key:process.env.DASHBOARD_KEY,id:chat,text:`Send ${i}`})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10, results.find(r=>r.status==='rejected')?.reason?.message); assert.equal(db.get(chat).pendingTurns,10);
 const text=db.get(chat).outbox[0].text; const runId=run(chat);
 const args={conversationId:chat,runId,prompt:text,instructions:'Synthetic'};
 const id=await mutate('codex:enqueueTurn',args); assert.equal(await mutate('codex:enqueueTurn',args),id);
 assert.equal(db.get(chat).outbox.length,9); assert.equal(queued(chat).length,1);
 await assert.rejects(enqueue(chat));
});
await check('expired identical outbox prompt: handoff keeps waiting/pending at 10; refusal unchanged; removal releases exactly one',async()=>{
 const text='Identical prompt';
 const fresh=[{text,at:now},...Array.from({length:9},(_,i)=>({text:`Fresh ${i}`,at:now}))];
 const chat=makeChat({pendingTurns:10,outbox:[{text,at:0},...fresh]});
 const id=await enqueue(chat,{prompt:text});
 assert.equal(db.get(chat).pendingTurns,10);
 assert.equal(db.get(chat).outbox.length,9);
 assert.equal(queued(chat).length+db.get(chat).outbox.length,10);
 await assert.rejects(enqueue(chat,{prompt:'Unrelated'}),/10 messages waiting/);
 assert.equal(db.get(chat).pendingTurns,10);
 assert.equal(queued(chat).length+db.get(chat).outbox.length,10);
 assert.equal(await remove(chat,id),true);
 assert.equal(db.get(chat).pendingTurns,9);
 assert.equal(queued(chat).length+db.get(chat).outbox.length,9);
 assert.equal(await remove(chat,id),false); assert.equal(db.get(chat).pendingTurns,9);
});
await check('matching duplicate fresh prompts consumes exactly one reservation and unrelated prompts cannot borrow capacity',async()=>{
 const text='Duplicate fresh';
 const duplicate=makeChat({pendingTurns:2,outbox:[{text,at:now},{text,at:now+1}]});
 await enqueue(duplicate,{prompt:text}); assert.equal(db.get(duplicate).outbox.length,1);
 assert.equal(db.get(duplicate).outbox[0].at,now+1);
 const full=makeChat({outbox:Array.from({length:10},(_,i)=>({text:`Reserved ${i}`,at:now}))});
 await assert.rejects(enqueue(full,{prompt:'Unrelated'}),/10 messages waiting/);
 assert.equal(db.get(full).outbox.length,10); assert.equal(queued(full).length,0);
});
await check('concurrent same-run durable replay returns one id at capacity including after removal',async()=>{
 const chat=makeChat({pendingTurns:1}); const runId=run(chat);
 const args={conversationId:chat,runId,prompt:'Replay',instructions:'Synthetic'};
 const results=await Promise.all(Array.from({length:11},()=>mutate('codex:enqueueTurn',args)));
 assert.equal(new Set(results).size,1); assert.equal(queued(chat).length,1);
 for(let i=0;i<9;i++) await enqueue(chat); db.patch(chat,{pendingTurns:10});
 assert.equal(await mutate('codex:enqueueTurn',args),results[0]); assert.equal(queued(chat).length,10);
 await remove(chat,results[0]); assert.equal(await mutate('codex:enqueueTurn',args),results[0]);
 assert.equal(queued(chat).length,9); assert.equal(db.get(chat).pendingTurns,9);
});
await check('steers reserve fallback capacity; repeated fallback/recovery never duplicates',async()=>{
 const chat=makeChat(); const active=await enqueue(chat); await mutate('codex:claimTurn',{token:'synthetic-runner',id:active});
 const results=await Promise.allSettled(Array.from({length:11},()=>enqueue(chat,{policy:'steer'})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10);
 const steer=db.get(results.find(r=>r.status==='fulfilled').value);
 await mutate('harness:fallback',{steer}); await mutate('harness:fallback',{steer});
 assert.equal(queued(chat).length,1); assert.equal(db.all('codexSteers').filter(s=>s.conversationId===chat&&s.status==='pending').length,9);
 assert.equal(db.get(active).status,'running');
});
await check('retry and compact cannot bypass full queue, retry remains available after a slot is freed',async()=>{
 const chat=makeChat({codexThreadId:'synthetic-session'});
 for(let i=0;i<10;i++) await enqueue(chat);
 await assert.rejects(mutate('codex:requestCompact',{conversationId:chat}), /10 messages waiting/);
 const runId=run(chat); const failed=db.insert('codexTurns',{engine:'codex',runnerId,conversationId:chat,runId,prompt:'Retry',instructions:'Synthetic',status:'error',retrying:true,finishedAt:now,createdAt:now});
 const args={id:failed,route:{engine:'codex',tier:'standard',by:'owner',why:'Synthetic'}};
 assert.equal(await mutate('codex:retryOn',args),false); assert.equal(queued(chat).length,10);
 await remove(chat,queued(chat)[0]._id);
 assert.equal(await mutate('codex:retryOn',args),true); assert.equal(queued(chat).length,10);
 assert.equal(await mutate('codex:retryOn',args),false);
});
await check('owner/chat authorization, idempotent removal, spans closed, pending count exact and unrelated running turn untouched',async()=>{
 const chat=makeChat({pendingTurns:3}); const other=makeChat(); const active=await enqueue(chat); const target=await enqueue(chat); const unrelated=await enqueue(chat);
 await mutate('codex:claimTurn',{token:'synthetic-runner',id:active});
 const span=db.insert('runSpans',{runId:db.get(target).runId,kind:'command',name:'Queued synthetic trace',callId:'fake',status:'running',startedAt:now});
 await assert.rejects(remove(chat,target,'wrong'),/Wrong dashboard key/);
 assert.equal(await remove(other,target),false);
 const guest=makeChat({contactId:'synthetic-contact'}); await assert.rejects(remove(guest,target),/own chat/);
 assert.equal(await remove(chat,target),true); assert.equal(await remove(chat,target),false);
 assert.equal(db.get(chat).pendingTurns,2); assert.equal(db.get(span).status,'error'); assert(db.get(span).endedAt); assert.equal(db.get(active).status,'running'); assert.equal(db.get(active).stopRequested,undefined);
 assert.equal(db.get(unrelated).status,'queued'); assert(db.get(target).finalizedAt); assert.equal(db.get(db.get(target).runId).status,'error');
 assert.equal(await remove(chat,active),false);
});
await check('claim wins removal race without stop; removal wins claim race without running',async()=>{
 const chat=makeChat({pendingTurns:2}); const id=await enqueue(chat);
 const [claim,removed]=await Promise.all([mutate('codex:claimTurn',{token:'synthetic-runner',id}),remove(chat,id)]);
 assert(claim); assert.equal(removed,false); assert.equal(db.get(id).stopRequested,undefined);
 const secondChat=makeChat({pendingTurns:1}); const second=await enqueue(secondChat);
 const [deleted,lateClaim]=await Promise.all([remove(secondChat,second),mutate('codex:claimTurn',{token:'synthetic-runner',id:second})]);
 assert.equal(deleted,true); assert.equal(lateClaim,null); assert.equal(db.get(secondChat).pendingTurns,0);
});
await check('legacy overfull steer fallback terminates only its own message and schedules recovery finalization',async()=>{
 const chat=makeChat(); const active=await enqueue(chat); await mutate('codex:claimTurn',{token:'synthetic-runner',id:active});
 const sid=await enqueue(chat,{policy:'steer'}); const steer=db.get(sid);
 for(let i=0;i<10;i++) db.insert('codexTurns',{engine:'codex',runnerId,conversationId:chat,runId:run(chat),prompt:`Legacy ${i}`,instructions:'',status:'queued',createdAt:now});
 await mutate('harness:fallback',{steer}); const fallback=db.get(db.get(sid).queuedTurnId);
 assert.equal(fallback.status,'error'); assert.match(fallback.error,/10 messages waiting/); assert.equal(queued(chat).length,10); assert.equal(db.get(active).status,'running');
 assert(sql.prepare('SELECT args FROM _scheduled WHERE name = ?').all('codex:finalizeTurn').some(row=>JSON.parse(row.args).id===fallback._id));
});
await check('backend pending messages expose per-message queue identity only before claim and disappear after removal',async()=>{
 const chat=makeChat({pendingTurns:2}); const target=await enqueue(chat); const active=await enqueue(chat);
 await mutate('codex:claimTurn',{token:'synthetic-runner',id:active});
 const messages=async()=> (await runtime.runQuery('dashboard:getChatMessages',{key:process.env.DASHBOARD_KEY,id:chat,paginationOpts:{numItems:50,cursor:null}})).value.page;
 let page=await messages(); assert(page.some(m=>m.queued?.id===target)); assert(!page.find(m=>m.text===db.get(active).prompt).queued);
 const prompt=db.get(target).prompt; await remove(chat,target); page=await messages(); assert(!page.some(m=>m.text===prompt));
});
await check('delivered/finalizing queued anomalies cannot be removed',async()=>{
 for(const field of ['deliveredAt','savedAt','reportedAt','finalizingAt']) {
  const chat=makeChat(); const id=await enqueue(chat); db.patch(id,{[field]:now}); assert.equal(await remove(chat,id),false); assert.equal(db.get(id).status,'queued');
 }
});
const evidence={scope:'Actual Runtime + native SQLite; integrated checkout sources; no source overlay; synthetic homes only; scheduler stopped; no network/engine/bootstrap',checks,passed:checks.every(c=>c.passed)};
await runtime.stop(); sql.close(); fs.rmSync(home,{recursive:true,force:true});
fs.writeFileSync(join(scratch,'e2e-integrated-result.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2)); if(!evidence.passed) process.exitCode=1;
