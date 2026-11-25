// Actual React computer hook and BackendClient; loopback protocol response fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const output=resolve(process.argv[2]??'node_modules/.cache/machine-panel-result');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(resolve('node_modules/.cache/machine-panel-'));
const checks={},errors=[],requests=[];const receipts=new Map();let browser,mode='done',drop=0,polls=0;
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync(join(scratch,'panel-fixture.js')));return;}
    if(req.url==='/api/backend/events'){res.setHeader('content-type','text/event-stream');res.write('event: ready\ndata: {}\n\n');return;}
    if(req.url!=='/api/backend/call'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const {path,args}=JSON.parse(Buffer.concat(chunks));
    let value;
    if(path==='machines:state')value={runners:[],terminals:[]};
    else if(path==='machines:request'){
      requests.push(args);
      if(mode==='reject'||mode==='outage'){res.statusCode=mode==='reject'?400:503;res.end(JSON.stringify({error:mode==='reject'?'Synthetic validation rejection':'Synthetic unavailable backend'}));return;}
      if(!receipts.has(args.requestId))receipts.set(args.requestId,'operation-'+receipts.size);
      value=receipts.get(args.requestId);
      if(drop-->0){res.destroy();return;}
    }else if(path==='machines:result'){
      polls++;value=mode==='waiting'?{status:'running'}:mode==='result-error'?{status:'error',error:'Synthetic operation failed'}:{status:'done',result:JSON.stringify({ok:true})};
    }else throw Error('Unexpected path: '+path);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({value,reads:[],writes:[]}));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(test,label,ms=15000)=>{const end=Date.now()+ms;while(!await test()){if(Date.now()>end)throw Error('Timed out: '+label);await sleep(25);}};
const check=(name,condition)=>{checks[name]=Boolean(condition);assert.ok(condition,name);console.log('PASS '+name);};
try{
  const build=spawnSync('bun',['build','artifacts/machine-lifecycle/panel-fixture.tsx','--target','browser','--outdir',scratch],{encoding:'utf8',windowsHide:true});if(build.status!==0)throw Error(build.stderr||build.error||'Fixture bundling failed');
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
  const {chromium}=await import(pathToFileURL(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
  browser=await chromium.launch({headless:true,executablePath:process.env.PERRY_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await page.locator('#state').waitFor();
  const run=file=>page.evaluate(async file=>{try{return {value:await window.machineActions.run({kind:'git.diff',file,staged:false})};}catch(error){return {error:error.message};}},file);
  const state=async()=>JSON.parse(await page.locator('#state').textContent());
  mode='reject';for(let i=0;i<40;i++)assert.match((await run('rejected-'+i)).error,/validation rejection/);
  check('forty explicit rejections do not consume the uncertainty budget',requests.length===40);await until(async()=>!(await state()).busy,'rejection releases busy');
  mode='done';drop=1;const before=receipts.size;const recovered=await run('ambiguous');const retried=requests.slice(-2);
  check('lost acknowledgement retries the same durable operation ID',recovered.value?.ok&&retried[0].requestId===retried[1].requestId&&receipts.size===before+1);
  drop=20;const uncertain=await run('ambiguous-twice');check('repeated lost acknowledgements surface uncertainty',/could not confirm/.test(uncertain.error));const original=requests.at(-1).requestId;drop=0;
  check('manual retry recovers the original uncertain operation',(await run('ambiguous-twice')).value?.ok&&requests.at(-1).requestId===original);
  mode='result-error';check('operation failure returns a useful error',/Synthetic operation failed/.test((await run('failed-result')).error));mode='done';check('failed operation releases its request for a later success',(await run('failed-result')).value?.ok);
  mode='outage';for(let i=0;i<32;i++)assert.match((await run('outage-'+i)).error,/unavailable backend/);const count=requests.length;check('unacknowledged requests remain bounded with a recovery instruction',/Too many computer requests/.test((await run('outage-overflow')).error)&&requests.length===count);
  await page.evaluate(()=>window.mountMachine(false));await page.locator('#unmounted').waitFor();await page.evaluate(()=>window.mountMachine(true));await page.locator('#state').waitFor();mode='waiting';
  await page.evaluate(()=>{window.pendingMachine=window.machineActions.run({kind:'git.status'}).then(value=>({value}),error=>({error:error.message}));});await until(()=>Promise.resolve(polls>0&&requests.at(-1).input==='{"kind":"git.status"}'),'polling request');await sleep(200);
  await page.evaluate(()=>window.mountMachine(false));await page.locator('#unmounted').waitFor();const pending=await page.evaluate(()=>window.pendingMachine);const stoppedAt=polls;await sleep(450);
  check('unmount cancels polling and reports submitted operation uncertainty',/Panel closed/.test(pending.error)&&polls===stoppedAt);await page.evaluate(()=>window.closeBackend());check('no uncaught browser errors',errors.length===0);
}catch(error){checks.completed=false;errors.push(String(error.stack??error));process.exitCode=1;}
finally{
  await browser?.close();server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));
  try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){errors.push(String(error));process.exitCode=1;}
  const result={pass:Object.keys(checks).length>0&&Object.values(checks).every(Boolean)&&errors.length===0,checks,errors,requests:requests.length,durableOperations:receipts.size,polls,scratchRemoved:!existsSync(scratch),scope:'Production useMachine/React/BackendClient with loopback HTTP protocol responses; no native runner execution'};
  writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
