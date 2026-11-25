// Actual built Next media route and fresh SQLite home. See docs/verification-desktop-media.md.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, basename, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const output=resolve(process.argv[2]??'node_modules/.cache/media-upload-result');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(resolve('node_modules/.cache/media-upload-'));
process.env.PERRY_HOME=scratch;process.env.DASHBOARD_KEY='synthetic-media-upload';process.env.PERRY_CREDENTIAL_KEY='ac'.repeat(32);
const key=process.env.DASHBOARD_KEY,checks={},errors=[];let runtime,sql,server;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const check=(name,ok)=>{checks[name]=Boolean(ok);assert.ok(ok,name);console.log('PASS '+name);};
try{
  const [{Runtime},{default:schema},{modules},{initializeCredentialEncryption}]=await Promise.all([import('../../server/runtime.ts'),import('../../convex/schema.ts'),import('../../server/modules.ts'),import('../../server/credential-encryption.ts')]);
  sql=new DatabaseSync(join(scratch,'perry.sqlite'));initializeCredentialEncryption(sql,scratch);runtime=new Runtime(sql,schema,modules,{storageDir:join(scratch,'storage')});await runtime.stop();sql.close();sql=null;runtime=null;
  const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p',String(port),'-H','127.0.0.1'],{cwd:resolve('.'),env:{...process.env,PERRY_PORT:String(port),TELEGRAM_BOT_TOKEN:'',COMPOSIO_API_KEY:'',GROQ_API_KEY:'',GEMINI_API_KEY:'',PERRY_WAKE_DISABLED:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{log=(log+chunk).slice(-16000);writeFileSync(join(output,'server.log'),log);});
  const deadline=Date.now()+20000;while(!await fetch(base).then(response=>response.ok,()=>false)){if(server.exitCode!==null||Date.now()>deadline)throw Error('Next did not start: '+log);await sleep(50);}
  const upload=async(id,body='Synthetic attachment',options={})=>{const response=await fetch(base+'/api/media',{method:'POST',headers:{...(options.cookie===null?{}:{cookie:`perry_media=${options.cookie??key}`}),...(id?{'x-upload-id':id}:{}),'x-file-name':encodeURIComponent(options.name??'receipt.txt'),...(options.origin?{origin:options.origin}:{})},body});return {status:response.status,body:await response.json()};};
  const uuid='12345678-1234-4234-8234-123456789abc',indexed=uuid+'-0',uploads=join(scratch,'uploads');
  const first=await upload(indexed);check('chat indexed UUID upload is accepted over HTTP',first.status===200&&basename(first.body.path)===indexed+'.txt');
  const replay=await upload(indexed);check('identical indexed retry returns the same file',replay.status===200&&replay.body.path===first.body.path&&readdirSync(uploads).length===1);
  const conflict=await upload(indexed,'Different attachment');check('different bytes under the same indexed key return409',conflict.status===409&&readFileSync(first.body.path,'utf8')==='Synthetic attachment');
  const second=await upload(uuid+'-1');check('attachment indices identify separate files',second.status===200&&second.body.path!==first.body.path);
  const editor=await upload(uuid);check('bare UUID editor uploads remain accepted',editor.status===200&&basename(editor.body.path)===uuid+'.txt');
  for(const id of [uuid+'-x',uuid+'-1000000','../'+uuid,uuid+'-0/../outside',uuid+'-0\\outside','not-a-uuid']){const response=await upload(id);check('malformed upload key is rejected: '+id,response.status===400);}
  const before=readdirSync(uploads).length;
  check('missing media cookie is refused',(await upload(uuid+'-2','No auth',{cookie:null})).status===401);
  check('foreign owner key is refused',(await upload(uuid+'-2','Wrong auth',{cookie:'synthetic-foreign-owner'})).status===403);
  check('cross-site upload is refused',(await upload(uuid+'-2','Cross site',{origin:'https://outside.example.invalid'})).status===403);
  check('refused requests create no files',readdirSync(uploads).length===before);
  const filename=await upload(uuid+'-3','Safe extension',{name:'../../outside/receipt.svg'});const tail=relative(uploads,filename.body.path??'');
  check('path-like file names retain only a safe extension inside uploads',filename.status===200&&!isAbsolute(tail)&&!tail.startsWith('..')&&basename(filename.body.path)===uuid+'-3.svg');
}catch(error){errors.push(String(error.stack??error));process.exitCode=1;}
finally{
  if(server?.pid&&server.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill();if(server.exitCode===null)await new Promise(done=>server.once('exit',done));}
  await runtime?.stop();sql?.close();
  try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){errors.push(String(error));process.exitCode=1;}
  const result={pass:Object.keys(checks).length>0&&Object.values(checks).every(Boolean)&&errors.length===0,checks,errors,scratchRemoved:!existsSync(scratch),scope:'Current built Next /api/media over real HTTP and fresh SQLite authentication; no real account, model or owner installation'};writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
