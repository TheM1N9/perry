import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {tmpdir} from 'node:os';import {writeFileSync} from 'node:fs';
process.env.PERRY_HOME=join(tmpdir(),'perry-pr303-ui');process.env.DASHBOARD_KEY='synthetic-pr303-ui';
process.env.PERRY_CREDENTIAL_KEY='99'.repeat(32);
const [{Runtime},{default:schema},{modules}]=await Promise.all([import('../../server/runtime'),import('../../convex/schema'),import('../../server/modules')]);
const sql=new DatabaseSync(join(process.env.PERRY_HOME,'perry.sqlite'));const rt=new Runtime(sql,schema as never,modules,{storageDir:join(process.env.PERRY_HOME,'storage')});await rt.stop();
for(const row of rt.store.all('installation'))rt.store.patch(row._id,{memoriesInPages:'undone'});
for(const row of rt.store.all('memories'))if(String(row.text).startsWith('Review fixture memory '))rt.store.delete(row._id);
const ids=[];for(let i=0;i<25;i++)ids.push(rt.store.insert('memories',{text:'Review fixture memory '+i,tags:[],source:'dashboard',kind:'core',createdAt:Date.now()+i,origin:'owner'}));
const token='synthetic-pr303-runner';
for(const row of rt.store.all('runners'))if(row.name==='Fixture runner')rt.store.delete(row._id);
for(const row of rt.store.all('conversations'))if(String(row.title).startsWith('Stream fixture '))rt.store.delete(row._id);
const runnerId=await rt.runMutation('runner:createToken',{token,name:'Fixture runner'},{internal:true});
const chats=[];
for(const title of ['Stream fixture A','Stream fixture B']) {
 const threadId=await rt.runMutation('agentStore:createThread',{userId:'fixture-owner'},{internal:true});
 const chat=rt.store.insert('conversations',{channel:'web',externalId:title,threadId,engine:'codex',title,pendingTurns:1,lastMessageAt:Date.now()});
 const run=rt.store.insert('runs',{conversationId:chat,prompt:'Synthetic stream',status:'running',startedAt:Date.now()});
 const turn=rt.store.insert('codexTurns',{runnerId,conversationId:chat,runId:run,engine:'codex',prompt:'Synthetic stream',instructions:'',status:'running',createdAt:Date.now(),startedAt:Date.now(),lastHeartbeatAt:Date.now()});
 chats.push({chat,turn});
}
writeFileSync('artifacts/pr-303/ui-seed.json',JSON.stringify({ids,chats,token},null,2));sql.close();process.exit(0);
