import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir = resolve(process.argv[2] || 'artifacts/pr-302/results'); mkdirSync(dir,{recursive:true});
process.env.PERRY_HOME = mkdtempSync(join(dir,'home-'));
process.env.FIXTURE_STATE = join(dir,'state.json');
process.env.PERRY_OPENCODE_COMMAND = `"${process.execPath}" "${resolve('artifacts/pr-302/fake-opencode.ts')}"`;
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({model:{providerID:'z',model:'configured'}, plugins:[]});
const save = (extra:any={}) => writeFileSync(process.env.FIXTURE_STATE!,JSON.stringify({providers:[{id:'provider',connections:[{type:'credential',id:'first'},{type:'credential',id:'second'}]}],...extra}));
save();
const { OpenCodeEngine } = await import('../../runner/engines/opencode');
const engine = new OpenCodeEngine();
const results: any[] = [];
try {
 const status = await engine.status();
 assert.equal(status.models.find(m=>m.isDefault)?.id,'default');
 assert(status.models.every(m=>!m.efforts));
 results.push({check:'Unlearned default stays with OpenCode; no invented efforts',pass:true});
 let cursor: string|undefined;
 for (const access of ['supervised','auto','full'] as const) {
  for (const tool of ['command','edit']) {
   let requests=0;
   const result = await engine.runTurn({resumeCursor:cursor,instructions:'',prompt:tool,attachments:[],cwd:dir,model:'default',access}, {onSession:async id=>{cursor=id},onRequest:async request=>{ requests++; assert.equal(request.type,tool==='edit'?'file_change_approval':'exec_command_approval');return 'no'; }});
   cursor=result.cursor;
   assert.equal(result.text,access==='full'?'executed':'denied');
   assert.equal(requests,access==='full'?0:1);
   results.push({check:`${access} ${tool}: native plugin + ACP permission routing`,pass:true});
  }
  engine.reload();
 }
 assert.equal((await engine.status()).models.find(m=>m.isDefault)?.id,'z/configured');
 results.push({check:'Learned configured default survives status merge',pass:true});
 await engine.logout(); assert.deepEqual(JSON.parse(readFileSync(process.env.FIXTURE_STATE!, 'utf8')).providers[0].connections,[]);
 assert.equal((await engine.status()).signedIn,true);
 results.push({check:'All stored credentials removed noninteractively; no-account models remain',pass:true});
 save({failLogout:true}); await assert.rejects(()=>engine.logout());
 save({providers:[{id:'environment',connections:[{type:'env',name:'PROVIDER_API_KEY'}]}]}); await assert.rejects(()=>engine.logout(),/environment/);
 results.push({check:'Failed logout and environment authentication never report success',pass:true});
 save({failModels:true}); engine.reload(); const fallback=await engine.status(); assert(fallback.models.every(m=>!m.id.includes('failed')));
 results.push({check:'Failed model listing uses learned fallback',pass:true});
} finally { engine.reload(); writeFileSync(join(dir,'result.json'),JSON.stringify({results},null,2)); }
console.log(JSON.stringify({passed:results.length,results},null,2));
