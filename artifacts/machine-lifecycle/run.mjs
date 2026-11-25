// Production HTTP/SQLite/computer-runner journeys. Read failure-cases.md first.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const output = resolve(process.argv[2] ?? 'node_modules/.cache/machine-lifecycle-result');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(resolve('node_modules/.cache/machine-lifecycle-'));
const home = join(scratch, 'home'), workdir = join(scratch, 'workspace with spaces');
mkdirSync(home); mkdirSync(workdir);
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = 'synthetic-machine-owner';
process.env.PERRY_CREDENTIAL_KEY = 'd7'.repeat(32);
const key = process.env.DASHBOARD_KEY, token = 'synthetic-machine-runner';
const checks = {}, evidence = {};
const check = (name, ok) => { checks[name] = Boolean(ok); assert.ok(ok, name); console.log('PASS '+name); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const until = async (test, name, ms=15000) => { const deadline=Date.now()+ms; while(!await test()) { if(Date.now()>deadline)throw Error('Timed out: '+name);await sleep(25); } };
const git = (...args) => execFileSync('git', args, {cwd:workdir,windowsHide:true,encoding:'utf8'}).trim();
let runtime, sql, service, client, host, heldClaim, heldRecovery;
try {
  const [{ Runtime }, { default:schema }, { modules }, { initializeCredentialEncryption }, { BackendClient }, { MachineHost }] = await Promise.all([
    import('../../server/runtime.ts'), import('../../convex/schema.ts'), import('../../server/modules.ts'), import('../../server/credential-encryption.ts'), import('../../client/backend.ts'), import('../../runner/machine-host.ts')
  ]);
  sql = new DatabaseSync(join(home,'perry.sqlite')); initializeCredentialEncryption(sql,home);
  runtime = new Runtime(sql,schema,modules,{storageDir:join(home,'storage')}); await runtime.stop();
  service = createServer(async (request,response) => {
    try {
      assert.equal(request.headers['x-perry-key'],key);
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const { path,args } = JSON.parse(Buffer.concat(chunks).toString());
      const result = await runtime.call(path,args,{internal:true});
      if(path==='machines:claim'&&heldClaim){const gate=heldClaim;heldClaim=undefined;gate.entered();await gate.release;}
      if(path==='machines:recover'&&heldRecovery){const gate=heldRecovery;heldRecovery=undefined;gate.entered();await gate.release;}
      response.setHeader('content-type','application/json');response.end(JSON.stringify(result));
    } catch(error) { response.statusCode=error.name==='ArgumentError'?400:500;response.setHeader('content-type','application/json');response.end(JSON.stringify({error:String(error.message)})); }
  });
  await new Promise(done=>service.listen(0,'127.0.0.1',done));
  client = new BackendClient(`http://127.0.0.1:${service.address().port}`,{adminKey:key});
  const call = async(path,args={})=>(await client.call(path,args)).value;
  await runtime.exclusive(()=>runtime.store.insert('installation',{defaultEngine:'codex',onboarding:'skipped',createdAt:Date.now()}));
  await call('runner:createToken',{name:'Isolated computer runner',token});
  await call('runner:checkIn',{token,platform:process.platform,hostname:'Fixture',workdir});
  const chat = await call('dashboard:createChat',{key});
  const other = await call('dashboard:createChat',{key});
  let serial=0;
  const request = (input,requestId=`fixture-${++serial}`,conversationId=chat)=>call('machines:request',{key,conversationId,requestId,input:JSON.stringify(input)});
  const result = id=>call('machines:result',{key,id});
  const run = async input=>{const id=await request(input);host.accept(await call('machines:queued',{token}));await until(async()=>['done','error'].includes((await result(id))?.status),'computer result');const row=await result(id);if(row.status==='error')throw Error(row.error);return JSON.parse(row.result);};
  const repeated = await request({kind:'git.status'},'same-request');
  check('duplicate request IDs identify one durable operation',await request({kind:'git.status'},'same-request')===repeated);
  await assert.rejects(()=>request({kind:'terminal.open',cols:80,rows:24},'same-request'));
  check('reusing a request ID for another operation is rejected',true);
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(workdir,'original.txt'),'initial\n');git('add','--','original.txt');git('commit','-m','Initial fixture');
  host = new MachineHost(client,token,workdir);await host.start();
  host.accept(await call('machines:queued',{token}));await until(async()=>(await result(repeated)).status==='done','original request');
  const opened = await run({kind:'terminal.open',cols:80,rows:24});
  check('real terminal opens in the intended workspace',opened.cwd.toLowerCase()===workdir.toLowerCase());
  await run({kind:'terminal.input',sessionId:opened.sessionId,text:process.platform==='win32'?"Write-Output 'MACHINE_FIXTURE_READY'\r":"printf 'MACHINE_FIXTURE_READY\\n'\r"});
  await until(async()=>(await call('machines:state',{key,conversationId:chat})).terminals.some(row=>row.output.includes('MACHINE_FIXTURE_READY')),'terminal output');
  check('terminal input reaches the real helper and is reported',true);
  await run({kind:'terminal.resize',sessionId:opened.sessionId,cols:100,rows:30});
  check('real terminal resizes',true);
  const foreign=await request({kind:'terminal.input',sessionId:opened.sessionId,text:'SHOULD_NOT_RUN\r'},undefined,other);
  host.accept(await call('machines:queued',{token}));await until(async()=>(await result(foreign)).status==='error','foreign terminal refusal');
  check('another chat cannot type into the terminal',(await result(foreign)).error.includes('closed'));
  await call('pause:set',{key,paused:true});await assert.rejects(()=>request({kind:'git.status'}));
  check('Pause refuses new computer work',true);
  const closing=await run({kind:'terminal.close',sessionId:opened.sessionId});
  check('Pause permits closing an existing terminal',closing.closed===true);
  await call('pause:set',{key,paused:false});
  writeFileSync(join(workdir,'-file with spaces.txt'),'path fixture\n');
  const status=await run({kind:'git.status'});
  check('Git status preserves spaces and leading hyphens',status.files.some(file=>file.path==='-file with spaces.txt'));
  const diff=await run({kind:'git.diff',file:'-file with spaces.txt',staged:false});
  check('untracked Git diff reads the intended literal path',diff.diff.includes('path fixture'));
  await run({kind:'git.stage',files:['-file with spaces.txt']});
  const staged=await run({kind:'git.status'});
  check('Git stage treats option-like names as literal paths',staged.files.some(file=>file.path==='-file with spaces.txt'&&file.index==='A'));
  const before=git('rev-parse','HEAD');
  let release,entered;const gate=new Promise(done=>release=done),claimed=new Promise(done=>entered=done);
  heldClaim={entered,release:gate};
  const stopped=await request({kind:'git.commit',message:'Must not commit after stop'});
  host.accept(await call('machines:queued',{token}));await claimed;host.stop();release();
  await until(async()=>['done','error'].includes((await result(stopped))?.status),'stopped operation receipt');
  const after=git('rev-parse','HEAD');evidence.stoppedClaim={before,after,status:(await result(stopped)).status,error:(await result(stopped)).error};
  check('Stop during a claim prevents a new Git mutation',after===before&&(await result(stopped)).status==='error');
  check('stopped host retains no terminal resources',host.terminals.size===0);
  const orphan=await request({kind:'git.status'});await call('machines:claim',{token,id:orphan});
  const restarted=new MachineHost(client,token,workdir);host=restarted;await host.start();
  check('restart marks unacknowledged running operations uncertain',(await result(orphan)).status==='error'&&(await result(orphan)).error.includes('restarted'));
  host.stop();
  let recovered,continueRecovery;const recovering=new Promise(done=>recovered=done),recoveryGate=new Promise(done=>continueRecovery=done);
  heldRecovery={entered:recovered,release:recoveryGate};host=new MachineHost(client,token,workdir);
  const starting=host.start();await recovering;host.stop();continueRecovery();await starting;
  check('Stop during recovery does not recreate a periodic runner timer',host.timer===undefined);
} catch(error) { evidence.error=String(error.stack??error);process.exitCode=1; }
finally {
  heldClaim=undefined;heldRecovery=undefined;host?.stop();client?.close();
  service?.closeAllConnections();if(service?.listening)await new Promise(done=>service.close(done));
  await runtime?.stop();sql?.close();
  try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){evidence.cleanupError=String(error);process.exitCode=1;}
  const report={passed:!evidence.error&&Object.values(checks).every(Boolean),checks,evidence,scratchRemoved:!existsSync(scratch),scope:'Real HTTP client, SQLite handlers, MachineHost, Git, and node-pty; no live account/model/device'};
  writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
