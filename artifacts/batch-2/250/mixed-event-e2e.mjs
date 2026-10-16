// Actual Runtime/SQLite + BackendClient E2E, with only the proposed shared files overlaid.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir = resolve('.batch-work/batch-2/250');
process.env.PERRY_HOME = join(dir,'test-home');
process.env.PERRY_DB = join(dir,'test-home','synthetic.sqlite');
process.env.DASHBOARD_KEY = 'notes-synthetic-dashboard-key';
process.env.PERRY_CREDENTIAL_KEY = '11'.repeat(32);
mkdirSync(process.env.PERRY_HOME,{recursive:true});
const evidence = {passed:false, checks:[], listRuns:0, events:[], calls:[]};
const originalFetch = globalThis.fetch;
let runtime,sql,client,streamController,mixedBuffer=null;
const tick = () => new Promise(r => setTimeout(r,5));
async function until(predicate) { for(let i=0;i<200;i++){if(predicate())return; await tick();} throw new Error('bounded wait expired'); }
globalThis.fetch = async (input,init) => {
 assert.ok(String(input).startsWith('http://notes.invalid/api/backend/'),'network blocked');
 if(String(input).endsWith('/events')) return new Response(new ReadableStream({start(c){streamController=c;init.signal.addEventListener('abort',()=>c.close(),{once:true});}}),{headers:{'content-type':'text/event-stream'}});
 const {path,args} = JSON.parse(init.body);
 evidence.calls.push(path);
 try {return Response.json(await runtime.call(path,args,{internal:true}));} catch(e){return Response.json({error:e.message},{status:400});}
};
try {
 const {DatabaseSync} = await import('node:sqlite');
 const {Runtime} = await import('../../../server/runtime.ts');
 const {default:schema} = await import('../../../convex/schema.ts');
 const notes = await import('../../../convex/notes.ts');
 const pages = await import('../../../convex/pages.ts');
 const {BackendClient} = await import('../../../client/backend.ts');
 const {internalMutation} = await import('../../../convex/_generated/server.js');
 const fake = internalMutation({args:{},handler:async()=>null});
 const fixture = {
  seed:internalMutation({handler:async(ctx)=>{
   const project = await ctx.db.insert('projects',{name:'Synthetic project',createdAt:1});
   const ids=[];
   for(let i=0;i<240;i++){
    const kind=['journal','person','journey'][i%3];
    ids.push(await ctx.db.insert('notes',{title:`Brain ${i}`,content:'Synthetic brain body '.repeat(100),search:'Synthetic brain body',summaries:[{text:'Synthetic summary',lines:100,at:1}],kind,day:'2026-10-17',by:'owner',revision:1,createdAt:i,updatedAt:i}));
   }
   const contact=await ctx.db.insert('contacts',{name:'Synthetic contact'});
   const chat=await ctx.db.insert('conversations',{channel:'web',externalId:'synthetic',threadId:'synthetic',contactId:contact,lastMessageAt:1});
   return {ids,project,chat};
  }}),
  kind:internalMutation({handler:async(ctx,args)=>ctx.db.patch(args.id,{kind:args.kind})}),
  replace:internalMutation({handler:async(ctx,args)=>{const doc=await ctx.db.get(args.id); delete doc.kind; await ctx.db.replace(args.id,doc);}}),
  fail:internalMutation({handler:async(ctx,args)=>{await ctx.db.patch(args.id,{kind:undefined});throw new Error('synthetic rollback');}}),
 };
 sql = new DatabaseSync(':memory:');
 const counted = {...notes,list:{...notes.list,handler:async(ctx,args)=>{evidence.listRuns++;return notes.list.handler(ctx,args);}}};
 runtime=new Runtime(sql,schema,{notes:counted,pages,fixture,memories:{embedMissing:fake},compaction:{reviewIfDue:fake}},{storageDir:join(process.env.PERRY_HOME,'storage')});
 await runtime.stop();
 const call=async(name,args={})=>(await runtime.call(name,args,{internal:true})).value;
 const {ids,project,chat}=await call('fixture:seed');
 const key=process.env.DASHBOARD_KEY;
 const args={key};
 let decoded=[];
 const rows=runtime.store.rows.bind(runtime.store);
 runtime.store.rows=function*(text,params){for(const row of rows(text,params)){if(text.includes('"doc_notes"'))decoded.push(row.kind??'ordinary');yield row;}};
 client=new BackendClient('http://notes.invalid');
 runtime.events.on('change',tags=>{evidence.events.push(tags);if(mixedBuffer){mixedBuffer.push(tags);return;}streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({tables:tags})}\n\n`));});
 client.subscribe('notes:list',args,()=>{});
 await until(()=>client.snapshot('notes:list',args).loaded);
 await tick();await tick();
 assert.deepEqual(client.snapshot('notes:list',args).value,[]);
 const create=async(title,content)=>client.mutation('notes:create',{key,title,content});
 const a=await create('First','**Fresh** ordinary apple');
 await until(()=>client.snapshot('notes:list',args).value.length===1);
 const b=await create('Second','Other ordinary pear');
 await until(()=>client.snapshot('notes:list',args).value.length===2);
 decoded=[];
 const explicit=await runtime.runQuery('notes:list',args);
 assert.deepEqual(explicit.reads,['projects','notes:ordinary']);
 assert.equal(decoded.length,2);
 assert.equal(explicit.value[0].id,b);
 assert.equal(explicit.value[1].preview,'Fresh ordinary apple');
 const plan=sql.prepare(`EXPLAIN QUERY PLAN SELECT _id,_creationTime,doc FROM doc_notes WHERE json_extract(doc,'$.kind') IS ? ORDER BY json_extract(doc,'$.kind'),json_extract(doc,'$.day'),_creationTime`).all(null);
 assert.ok(plan.some(x=>x.detail.includes('i_notes_by_kind')));
 evidence.checks.push({case:'240 Brain bodies, two ordinary notes',decodedRows:decoded.length,reads:explicit.reads,indexPlan:plan.map(x=>x.detail)});
 await tick();await tick();
 const baseline=evidence.listRuns;
 const append=await client.mutation('notes:updateForAgent',{id:ids[0],mode:'append',content:'A synthetic journal append.'});
 assert.ok(append.updated);
 await tick();await tick();
 assert.equal(evidence.listRuns,baseline);
 assert.ok(runtime.store.get(ids[0]).content.includes('A synthetic journal append.'));
 evidence.checks.push({case:'real assistant journal append via Runtime, mutation writes and SSE',listRunsBefore:baseline,listRunsAfter:evidence.listRuns,journalRevision:runtime.store.get(ids[0]).revision,writes:evidence.events.at(-1)});
 const save=await client.mutation('notes:save',{key,id:a,content:'Updated ordinary kiwi',expectedRevision:1});
 assert.equal(save.ok,true);
 await until(()=>client.snapshot('notes:list',args).value.find(n=>n.id===a)?.preview==='Updated ordinary kiwi');
 const stale=await call('notes:save',{key,id:a,content:'lost',expectedRevision:1});
 assert.equal(stale.ok,false);
 const search=await call('notes:search',{key,query:'kiwi'});
 assert.ok(search.some(n=>n.id===a));
 await client.mutation('notes:pinForAgent',{id:a,pinned:true});
 await until(()=>client.snapshot('notes:list',args).value.find(n=>n.id===a)?.pinned);
 await client.mutation('notes:move',{key,id:a,projectId:project});
 await until(()=>client.snapshot('notes:list',args).value.find(n=>n.id===a)?.project==='Synthetic project');
 assert.equal((await call('notes:list',{key,projectId:project})).length,1);
 const sealed=await call('notes:listForAgent',{chat});assert.equal(sealed.notes.length,0);assert.ok(sealed.error);
 await assert.rejects(()=>call('notes:list',{key:'wrong'}),/Wrong dashboard key/);
 evidence.checks.push({case:'preview, content search, revision conflict, pins, project and owner access',passed:true});
 await client.mutation('fixture:kind',{id:b,kind:'person'});
 await until(()=>client.snapshot('notes:list',args).value.length===1);
 await client.mutation('fixture:kind',{id:b});
 await until(()=>client.snapshot('notes:list',args).value.length===2);
 await client.mutation('fixture:kind',{id:b,kind:'journal'});
 await until(()=>client.snapshot('notes:list',args).value.length===1);
 await client.mutation('fixture:replace',{id:b});
 await until(()=>client.snapshot('notes:list',args).value.length===2);
 const beforeFail=evidence.events.length;
 await assert.rejects(()=>call('fixture:fail',{id:ids[1]}),/synthetic rollback/);
 assert.equal(runtime.store.get(ids[1]).kind,'person');assert.equal(evidence.events.length,beforeFail);
 await client.mutation('notes:remove',{key,id:b});
 await until(()=>client.snapshot('notes:list',args).value.length===1);
 const beforeImport=evidence.listRuns;
 await runtime.importDocuments('notes',[{_id:'syntheticimport0000000000001',_creationTime:999,title:'Imported',content:'Imported ordinary',search:'Imported ordinary',by:'owner',revision:1,createdAt:999,updatedAt:999}]);
 await until(()=>client.snapshot('notes:list',args).value.length===2);
 assert.ok(evidence.listRuns>beforeImport);
 evidence.checks.push({case:'empty-list insert, kind transitions, replace, delete, rollback and broad import event',passed:true});

 // Synthetic coalescing adapter: the real server currently emits these separately.
 await tick();await tick();
 const beforeMixed=evidence.listRuns;
 const cachedBefore=client.snapshot('notes:list',args).value.length;
 mixedBuffer=[];
 await call('notes:updateForAgent',{id:ids[0],mode:'append',content:'Another synthetic journal append.'});
 await runtime.importDocuments('notes',[{_id:'syntheticmerged0000000000001',_creationTime:1000,title:'Merged event import',content:'A broad imported note',search:'A broad imported note',by:'owner',revision:1,createdAt:1000,updatedAt:1000}]);
 const separate=mixedBuffer;
 mixedBuffer=null;
 const union=[...new Set(separate.flat())];
 assert.ok(union.includes('notes:scoped-write'));
 assert.ok(union.includes('notes:ordinary'));
 streamController.enqueue(new TextEncoder().encode('data: '+JSON.stringify({tables:union})+'\n\n'));
 await until(()=>client.snapshot('notes:list',args).value.length===cachedBefore+1);
 const afterMixed=evidence.listRuns;
 const cachedAfter=client.snapshot('notes:list',args).value.length;
 assert.ok(afterMixed>beforeMixed);
 assert.equal(cachedAfter,cachedBefore+1);
 const actual=(await runtime.runQuery('notes:list',args)).value.length;
 assert.equal(actual,cachedBefore+1);
 streamController.enqueue(new TextEncoder().encode('data: '+JSON.stringify({tables:['notes']})+'\n\n'));
 await until(()=>client.snapshot('notes:list',args).value.length===actual);
 evidence.checks.push({case:'merged journal and broad-import event refreshes Notes',productionCoalescing:false,separateEvents:separate,mergedTags:union,listRunsBefore:beforeMixed,listRunsAfterMerged:afterMixed,cachedAfterMerged:cachedAfter,databaseNotes:actual,broadOnlyFallbackAlsoPassed:true});
 evidence.passed=true;
} catch(e){evidence.error=e.stack;process.exitCode=1;}
finally {client?.close();await runtime?.stop();sql?.close();globalThis.fetch=originalFetch;writeFileSync(join(dir,'mixed-event-evidence.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks,error:evidence.error}));
