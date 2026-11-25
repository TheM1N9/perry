// Real browser + production React player. Read failure-cases.md first.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const output=resolve(process.argv[2]??'node_modules/.cache/audio-lifecycle-result');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(resolve('node_modules/.cache/audio-lifecycle-'));
const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);for(let i=0;i<8000;i++)wav.writeInt16LE(Math.round(Math.sin(i*Math.PI/20)*5000),44+i*2);
const counts=new Map(),closed=new Map(),gates=new Map();let repaired=false;
const server=createServer((req,res)=>{
  if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync(join(scratch,'fixture.js')));return;}
  if(!req.url.startsWith('/audio')){res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');return;}
  res.setHeader('content-type','audio/wav');
  if(req.headers['sec-fetch-dest']==='audio'){res.end(wav);return;}
  const name=req.url;counts.set(name,(counts.get(name)??0)+1);res.on('close',()=>closed.set(name,(closed.get(name)??0)+1));
  if(name.includes('held')){gates.set(name,()=>res.end(wav.subarray(12)));res.writeHead(200);res.write(wav.subarray(0,12));return;}
  if(name.includes('oversized-header')){res.setHeader('content-length',30*1024*1024);res.flushHeaders();return;}
  if(name.includes('oversized-chunked')){res.writeHead(200);let sent=0;const chunk=Buffer.alloc(64*1024);const pump=()=>{while(sent<27*1024*1024&&!res.destroyed){sent+=chunk.length;if(!res.write(chunk)){res.once('drain',pump);return;}}if(!res.destroyed)res.end();};pump();return;}
  if(name.includes('repair')&&!repaired){res.statusCode=503;res.end('Synthetic outage');return;}
  if(name.includes('malformed')){res.end('Not a WAV file');return;}
  res.end(wav);
});
const checks={},errors=[];let browser;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(test,label,ms=15000)=>{const end=Date.now()+ms;while(!await test()){if(Date.now()>end)throw Error('Timed out: '+label);await sleep(25);}};
const check=(name,condition)=>{checks[name]=Boolean(condition);assert.ok(condition,name);console.log('PASS '+name);};
try{
  const build=spawnSync('bun',['build','artifacts/audio-lifecycle/fixture.tsx','--target','browser','--outdir',scratch],{encoding:'utf8',windowsHide:true});
  if(build.status!==0)throw Error(build.stderr||build.error||'Fixture bundling failed');
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
  const {chromium}=await import(pathToFileURL(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
  browser=await chromium.launch({headless:true,executablePath:process.env.PERRY_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await until(()=>page.evaluate(()=>typeof window.setAudioPlayers==='function'),'React mount');
  const mount=players=>page.evaluate(players=>window.setAudioPlayers(players),players);
  const resources=()=>page.evaluate(()=>window.audioResources());
  await mount([{id:1,src:'/audio-held-shared'},{id:2,src:'/audio-held-shared'}]);await until(()=>Promise.resolve(gates.has('/audio-held-shared')),'shared fetch');
  check('two mounted players share one waveform fetch',counts.get('/audio-held-shared')===1);
  await mount([{id:2,src:'/audio-held-shared'}]);await sleep(150);
  check('one consumer leaving preserves the shared pending fetch',!closed.get('/audio-held-shared'));
  gates.get('/audio-held-shared')();await page.locator('[data-waveform="ready"]').waitFor();
  check('shared audio decodes once and closes its context',(await resources()).decoded===1&&(await resources()).openContexts===0);
  await mount([]);await mount([{id:3,src:'/audio-held-shared'}]);await page.locator('[data-waveform="ready"]').waitFor();
  check('completed cached waveforms survive back navigation',counts.get('/audio-held-shared')===1&&(await resources()).decoded===1);
  await mount([{id:4,src:'/audio-held-abandoned'}]);await until(()=>Promise.resolve(gates.has('/audio-held-abandoned')),'abandoned fetch');await mount([]);await until(()=>Promise.resolve(Boolean(closed.get('/audio-held-abandoned'))),'last consumer abort');
  check('last consumer leaving aborts its pending fetch',true);
  await mount([{id:5,src:'/audio-held-abandoned'}]);await until(()=>Promise.resolve(counts.get('/audio-held-abandoned')===2),'aborted work retries');gates.get('/audio-held-abandoned')();await page.locator('[data-waveform="ready"]').waitFor();
  check('remount starts fresh work after cancellation',true);
  const decoded=(await resources()).decoded;
  await mount([{id:6,src:'/audio-oversized-header'}]);await page.locator('[data-waveform="none"]').waitFor();
  check('oversized declared audio is rejected before decode',(await resources()).decoded===decoded);
  await mount([{id:7,src:'/audio-oversized-chunked'}]);await page.locator('[data-waveform="none"]').waitFor();
  check('chunked audio is capped by actual bytes before decode',(await resources()).decoded===decoded);
  await mount([{id:8,src:'/audio-repair'}]);await page.locator('[data-waveform="none"]').waitFor();repaired=true;await mount([]);await mount([{id:9,src:'/audio-repair'}]);await page.locator('[data-waveform="ready"]').waitFor();
  check('a transient HTTP failure does not poison the waveform cache',counts.get('/audio-repair')===2);
  await mount([{id:10,src:'/audio-malformed'}]);await page.locator('[data-waveform="none"]').waitFor();await until(async()=>(await resources()).openContexts===0,'failed decoder context closes');
  check('malformed audio closes its decode context',true);
  await mount([{id:11,src:'/audio-held-old'}]);await until(()=>Promise.resolve(gates.has('/audio-held-old')),'source change');await mount([{id:11,src:'/audio-fresh'}]);await page.locator('[data-waveform="ready"]').waitFor();
  check('source changes cancel obsolete work and show the new waveform',Boolean(closed.get('/audio-held-old')));
  await mount([]);await until(async()=>(await resources()).openContexts===0,'final contexts close');check('no uncaught browser errors',errors.length===0);
}catch(error){checks.completed=false;errors.push(String(error.stack??error));process.exitCode=1;}
finally{
  await browser?.close();server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));
  try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){errors.push(String(error));process.exitCode=1;}
  const result={pass:Object.keys(checks).length>0&&Object.values(checks).every(Boolean)&&errors.length===0,checks,errors,counts:Object.fromEntries(counts),scratchRemoved:!existsSync(scratch),scope:'Production AudioPlayer/React, real Chromium AudioContext, loopback synthetic audio streams'};
  writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
