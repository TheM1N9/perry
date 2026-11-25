// Production voice hook in Chromium; permission/model boundaries are synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const output=resolve(process.argv[2]??'node_modules/.cache/voice-lifecycle-result');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(resolve('node_modules/.cache/voice-lifecycle-'));
const checks={},errors=[];let browser;
const server=createServer((req,res)=>{
  if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync(join(scratch,'fixture.js')));return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
});
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(test,label,ms=15000)=>{const end=Date.now()+ms;while(!await test()){if(Date.now()>end)throw Error('Timed out: '+label);await sleep(25);}};
const check=(name,condition)=>{checks[name]=Boolean(condition);assert.ok(condition,name);console.log('PASS '+name);};
try{
  const build=spawnSync('bun',['build','artifacts/voice-lifecycle/fixture.tsx','--target','browser','--outdir',scratch],{encoding:'utf8',windowsHide:true});
  if(build.status!==0)throw Error(build.stderr||build.error||'Fixture bundling failed');
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
  const {chromium}=await import(pathToFileURL(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
  browser=await chromium.launch({headless:true,executablePath:process.env.PERRY_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await until(()=>page.evaluate(()=>typeof window.voiceActions?.start==='function'),'React mount');
  const resources=()=>page.evaluate(()=>window.voiceResources());
  const state=async()=>JSON.parse(await page.locator('#state').textContent());
  const configure=(permission,transcription='success')=>page.evaluate(([p,t])=>window.configureVoice(p,t),[permission,transcription]);
  const action=method=>page.evaluate(method=>window.voiceActions[method](),method);
  const idle=()=>until(async()=>(await state()).state==='idle','idle state');
  const clean=()=>until(async()=>{const r=await resources();return r.tracks===0&&r.contexts===0&&r.recorders===0;},'native resources released');
  await configure('denied');check('permission denial returns false',await action('start')===false);await idle();check('denial gives an actionable privacy setting message',/allow the microphone.*privacy settings/.test((await state()).error));await clean();
  await configure('missing');await action('start');await idle();check('missing microphone offers reconnection or another device',/no microphone.*Plug one in/.test((await state()).error));await clean();
  await configure('held');await page.evaluate(()=>{window.pendingOpen=window.voiceActions.start();});await action('cancel');await page.evaluate(()=>window.releasePermission());check('cancel while permission is pending rejects a late stream',await page.evaluate(()=>window.pendingOpen)===false);await clean();
  await configure('held');await page.evaluate(()=>{window.pendingOpen=window.voiceActions.start();});await page.evaluate(()=>window.mountVoice(false));await page.locator('#unmounted').waitFor();await page.evaluate(()=>window.releasePermission());check('unmount while permission is pending releases late resources',await page.evaluate(()=>window.pendingOpen)===false);await clean();check('unmount unsubscribes progress notifications',(await resources()).subscribed===0);
  await page.evaluate(()=>window.mountVoice(true));await page.locator('#state').waitFor();await configure('granted');check('real synthetic microphone and MediaRecorder enter listening',await action('start')===true);await until(async()=>(await state()).state==='listening','listening');await sleep(450);await action('cancel');await idle();await clean();check('active cancellation releases native tracks contexts and recorder',true);
  await configure('granted','failed');await action('start');await sleep(650);check('failed transcription returns no text',await action('stop')==='');await idle();await clean();check('failed transcription preserves a retryable recording',(await state()).failed===true);const before=(await resources()).calls;await configure('granted');check('retry recovers without reopening the microphone',await action('retry')==='Synthetic words'&&(await resources()).calls===before+1);await clean();
  await configure('granted','held');await action('start');await sleep(650);const calls=(await resources()).calls;await page.evaluate(()=>{window.pendingStop=window.voiceActions.stop();});await until(async()=>(await resources()).calls===calls+1,'held transcription');await action('cancel');await page.evaluate(()=>window.releaseTranscript());check('cancellation suppresses a late model result',await page.evaluate(()=>window.pendingStop)==='');await clean();
  await configure('granted');await action('start');await sleep(650);const done=(await resources()).done;await page.evaluate(()=>window.disconnectRecorder());await idle();await clean();check('unexpected native recorder stop completes once with useful feedback',(await resources()).done===done+1&&/microphone stopped/.test((await state()).error));
  await page.evaluate(()=>window.mountVoice(false));await page.locator('#unmounted').waitFor();await clean();check('final unmount releases bridge subscription',(await resources()).subscribed===0);check('no uncaught browser errors',errors.length===0);
}catch(error){checks.completed=false;errors.push(String(error.stack??error));process.exitCode=1;}
finally{
  await browser?.close();server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));
  try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){errors.push(String(error));process.exitCode=1;}
  const result={pass:Object.keys(checks).length>0&&Object.values(checks).every(Boolean)&&errors.length===0,checks,errors,scratchRemoved:!existsSync(scratch),scope:'Production useVoice, real React/Chromium AudioContext/MediaRecorder, synthetic permission and model boundary; no system microphone'};
  writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
