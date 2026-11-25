// Built Next application and actual browser chunk loading; no terminal commands execute.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const output=resolve(process.argv[2]??'node_modules/.cache/terminal-ui-result');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(resolve('node_modules/.cache/terminal-ui-'));
process.env.PERRY_HOME=scratch;process.env.DASHBOARD_KEY='synthetic-terminal-ui';process.env.PERRY_CREDENTIAL_KEY='bc'.repeat(32);
const key=process.env.DASHBOARD_KEY,checks={},errors=[];let browser,server,runtime,sql,releaseImport;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(test,label,ms=20000)=>{const end=Date.now()+ms;while(!await test()){if(Date.now()>end)throw Error('Timed out: '+label);await sleep(50);}};
const check=(name,ok)=>{checks[name]=Boolean(ok);assert.ok(ok,name);console.log('PASS '+name);};
try{
  const [{Runtime},{default:schema},{modules},{initializeCredentialEncryption}]=await Promise.all([import('../../server/runtime.ts'),import('../../convex/schema.ts'),import('../../server/modules.ts'),import('../../server/credential-encryption.ts')]);
  sql=new DatabaseSync(join(scratch,'perry.sqlite'));initializeCredentialEncryption(sql,scratch);runtime=new Runtime(sql,schema,modules,{storageDir:join(scratch,'storage')});await runtime.stop();
  const call=async(path,args)=>(await runtime.call(path,args,{internal:true})).value;
  await runtime.exclusive(()=>runtime.store.insert('installation',{defaultEngine:'codex',onboarding:'skipped',createdAt:Date.now()}));
  const token='synthetic-terminal-ui-runner';await call('runner:createToken',{name:'Fixture computer',token});await call('runner:checkIn',{token,hostname:'Fixture',platform:process.platform,workdir:scratch});
  const chat=await call('dashboard:createChat',{key});await runtime.stop();sql.close();sql=null;runtime=null;
  const chunks=resolve('.next/static/chunks');const terminalChunk=readdirSync(chunks).find(file=>file.endsWith('.js')&&readFileSync(join(chunks,file),'utf8').includes('xterm-screen'));assert.ok(terminalChunk,'xterm chunk exists in current build');
  const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p',String(port),'-H','127.0.0.1'],{cwd:resolve('.'),env:{...process.env,PERRY_PORT:String(port),TELEGRAM_BOT_TOKEN:'',COMPOSIO_API_KEY:'',GROQ_API_KEY:'',GEMINI_API_KEY:'',PERRY_WAKE_DISABLED:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{log=(log+chunk).slice(-16000);writeFileSync(join(output,'server.log'),log);});
  await until(async()=>{if(server.exitCode!==null)throw Error('Next exited: '+log);return fetch(base).then(response=>response.ok,()=>false);},'Next server');
  const {chromium}=await import(pathToFileURL(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);browser=await chromium.launch({headless:true,executablePath:process.env.PERRY_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=async()=>{const ctx=await browser.newContext({viewport:{width:1280,height:800}});await ctx.addInitScript(key=>{
    localStorage.setItem('perry.dashboard.key',key);
    const NativeObserver=window.ResizeObserver,observers=new Map();
    window.ResizeObserver=class extends NativeObserver{constructor(callback){super(callback);observers.set(this,new Set());}observe(target,options){observers.get(this).add(target);super.observe(target,options);}unobserve(target){observers.get(this).delete(target);super.unobserve(target);}disconnect(){observers.delete(this);super.disconnect();}};
    window.terminalObservers=()=>[...observers.values()].filter(targets=>[...targets].some(target=>target.hasAttribute('data-terminal'))).length;
  },key);return ctx;};
  const open=async page=>{await page.goto(`${base}/chat/${chat}`);await page.locator('[data-chat-panel-toggle]').waitFor();await page.locator('[data-chat-panel-toggle]').click();await page.locator('[data-launcher-row="terminal"]').click();await page.locator('[data-surface="terminal"]').waitFor();};
  const first=await context();const page=await first.newPage();page.on('pageerror',error=>errors.push(error.message));let fail=true,blocked=0;
  await first.route(`**/_next/static/chunks/${terminalChunk}`,async route=>{if(fail){blocked++;await route.abort('failed');}else await route.continue();});
  await open(page);await page.getByRole('alert').filter({hasText:"Couldn't load the terminal"}).waitFor();
  check('a failed production chunk shows a retry and disables terminal opening',blocked>0&&await page.getByRole('button',{name:'Try again',exact:true}).isVisible()&&await page.getByRole('button',{name:'Open terminal',exact:true}).isDisabled());
  fail=false;await page.getByRole('button',{name:'Try again',exact:true}).click();await page.locator('[data-terminal] .xterm').waitFor();
  check('retry initializes one terminal and one terminal observer',await page.locator('[data-terminal] .xterm').count()===1&&await page.evaluate(()=>window.terminalObservers())===1&&await page.getByRole('button',{name:'Open terminal',exact:true}).isEnabled());
  await page.screenshot({path:join(output,'terminal-recovered.png')});await page.getByRole('button',{name:'Close Terminal',exact:true}).click();await until(()=>page.evaluate(()=>window.terminalObservers()===0),'terminal observer disconnect');
  check('closing an initialized tab disposes its terminal observer',await page.locator('.xterm').count()===0);await first.close();
  const second=await context();const pending=await second.newPage();pending.on('pageerror',error=>errors.push(error.message));let imported=false;
  const importGate=new Promise(done=>releaseImport=done);await second.route(`**/_next/static/chunks/${terminalChunk}`,async route=>{imported=true;await importGate;await route.continue().catch(()=>{});});
  await open(pending);await until(()=>Promise.resolve(imported),'held terminal chunk');await pending.getByRole('button',{name:'Close Terminal',exact:true}).click();releaseImport();releaseImport=undefined;await sleep(600);
  check('late chunk completion after unmount creates no terminal or observer',await pending.locator('.xterm').count()===0&&await pending.evaluate(()=>window.terminalObservers())===0);
  await pending.locator('[data-chat-panel-toggle]').click();await pending.locator('[data-launcher-row="terminal"]').click();await pending.locator('[data-terminal] .xterm').waitFor();check('a new terminal mounts once after an abandoned import',await pending.locator('[data-terminal] .xterm').count()===1&&await pending.evaluate(()=>window.terminalObservers())===1);
  await pending.getByRole('button',{name:'Close Terminal',exact:true}).click();await until(()=>pending.evaluate(()=>window.terminalObservers()===0),'second observer disconnect');await second.close();check('no uncaught browser errors',errors.length===0);
}catch(error){errors.push(String(error.stack??error));process.exitCode=1;}
finally{
  releaseImport?.();await browser?.close();if(server?.pid&&server.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else{server.kill();await new Promise(done=>server.once('exit',done));}}
  await runtime?.stop();sql?.close();try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){errors.push(String(error));process.exitCode=1;}
  const result={pass:Object.keys(checks).length>0&&Object.values(checks).every(Boolean)&&errors.length===0,checks,errors,scratchRemoved:!existsSync(scratch),scope:'Current built Next application, real chunk HTTP failure/retry, fresh Runtime home, native Chromium; no terminal commands or owner installation'};writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
