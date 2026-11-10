import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const out = resolve(process.argv[2] || 'artifacts/pr-303'); mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(tmpdir(),'perry-pr303-'));
process.env.PERRY_HOME=home; process.env.DASHBOARD_KEY='synthetic-pr303'; process.env.PERRY_CREDENTIAL_KEY='88'.repeat(32);
globalThis.fetch=async()=>{throw Error('No network in synthetic lifecycle replay')};
const [{Runtime},{default:schema},{modules}]=await Promise.all([import('../../server/runtime'),import('../../convex/schema'),import('../../server/modules')]);
let sql=new DatabaseSync(join(home,'perry.sqlite'));
let rt=new Runtime(sql,schema as never,modules,{storageDir:join(home,'storage')}); await rt.stop();
const args={key:process.env.DASHBOARD_KEY};
const mutate=(name:string,extra:any={})=>rt.runMutation(name,{...args,...extra},{internal:true}) as Promise<any>;
const list=async()=> (await rt.runQuery('dashboard:listMemories',args,{internal:true})).value as any[];
const add=(text:string)=>rt.store.insert('memories',{text,tags:[],source:'dashboard',kind:'core',createdAt:Date.now(),origin:'owner'});
const wait=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const results:any[]=[];
async function check(name:string,work:()=>Promise<void>){try{await work();results.push({name,pass:true})}catch(error){results.push({name,pass:false,error:String(error)});throw error}finally{writeFileSync(join(out,'backend-result.json'),JSON.stringify({results},null,2));}}
try {
 for(let i=0;i<25;i++)add('Synthetic older memory '+i);
 await check('accepted Forget persists hidden state and preserves the 25-result limit',async()=>{
   const id=(await list())[0].id; const at=await mutate('dashboard:forgetMemory',{id});
   const found=await list(); assert.equal(found.length,25); assert.equal(found.filter(m=>m.forgetAt===undefined).length,24);
   assert.equal(await mutate('dashboard:forgetMemory',{id}),at);
   assert.equal((sql.prepare('SELECT count(*) AS n FROM _scheduled').get() as any).n,1);
   assert.equal(await mutate('dashboard:undoForgetMemory',{id,at}),true);
   assert.equal((await list()).filter(m=>m.forgetAt===undefined).length,25);
   assert.equal(await mutate('dashboard:undoForgetMemory',{id,at}),false);
 });
 await check('stale Undo cannot cancel a later Forget; scheduled operation survives a database reopen',async()=>{
   const id=(await list())[0].id;const old=await mutate('dashboard:forgetMemory',{id});
   assert(await mutate('dashboard:undoForgetMemory',{id,at:old})); await wait(5);
   const at=await mutate('dashboard:forgetMemory',{id});assert.notEqual(old,at);
   assert.equal(await mutate('dashboard:undoForgetMemory',{id,at:old}),false);
   await rt.stop();sql.close();sql=new DatabaseSync(join(home,'perry.sqlite'));rt=new Runtime(sql,schema as never,modules,{storageDir:join(home,'storage')});await rt.stop();
   assert.equal((await list()).find(m=>m.id===id).forgetAt,at);
   await wait(Math.max(0,at-Date.now()+30));
   assert.equal(await mutate('dashboard:undoForgetMemory',{id,at}),false);
   rt.start();await wait(300);await rt.stop();assert.equal(rt.store.get(id),null);
 });
 await check('Undo leaves the memory intact after the original deadline',async()=>{
   const id=add('Undo keeps this');const at=await mutate('dashboard:forgetMemory',{id});await mutate('dashboard:undoForgetMemory',{id,at});
   rt.start();await wait(Math.max(0,at-Date.now()+100));await rt.stop();assert(rt.store.get(id));
 });
 await check('deletion failure restores the row with a durable visible error',async()=>{
   const id=add('Injected deletion failure');const at=await mutate('dashboard:forgetMemory',{id});
   const failing={...modules,memories:{...modules.memories,removeMany:{...(modules.memories.removeMany as any),handler:async()=>{throw Error('Synthetic storage refusal')}}}};
   rt=new Runtime(sql,schema as never,failing,{storageDir:join(home,'storage')});await rt.stop();
   await rt.runMutation('dashboard:finishForgettingMemory',{id,at},{internal:true});
   const row=(await list()).find(m=>m.id===id);assert.equal(row.forgetAt,undefined);assert.match(row.forgetError,/could not forget/);
 });
 await check('older-memory Forget rejects page lines and wrong dashboard keys',async()=>{
   const id=rt.store.insert('memories',{text:'Protected page',tags:[],source:'dashboard',kind:'page',createdAt:Date.now()});
   await assert.rejects(()=>mutate('dashboard:forgetMemory',{id}));
   await assert.rejects(()=>mutate('dashboard:forgetMemory',{id:add('Owner only'),key:'wrong'}));
 });
} finally {await rt.stop();sql.close()}
console.log(JSON.stringify({results},null,2));
process.exit(0);
