// Production PetScreen with synthetic bridge and browser Storage boundary failures.
// Failure inventory: docs/regression-checks.md, Pet storage.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const output=resolve(process.argv[2]??'node_modules/.cache/pet-storage-result');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(resolve('node_modules/.cache/pet-storage-'));
process.env.PERRY_HOME=scratch;process.env.DASHBOARD_KEY='synthetic-pet-storage';process.env.PERRY_CREDENTIAL_KEY='ef'.repeat(32);
const key=process.env.DASHBOARD_KEY,checks={},errors=[];let browser,server,runtime,sql;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(test,label,ms=20000)=>{const end=Date.now()+ms;while(!await test()){if(Date.now()>end)throw Error('Timed out: '+label);await sleep(50);}};
const check=(name,ok)=>{checks[name]=Boolean(ok);assert.ok(ok,name);console.log('PASS '+name);};
try{
  const [{Runtime},{default:schema},{modules},{initializeCredentialEncryption}]=await Promise.all([import('../../server/runtime.ts'),import('../../convex/schema.ts'),import('../../server/modules.ts'),import('../../server/credential-encryption.ts')]);
  sql=new DatabaseSync(join(scratch,'perry.sqlite'));initializeCredentialEncryption(sql,scratch);runtime=new Runtime(sql,schema,modules,{storageDir:join(scratch,'storage')});await runtime.stop();
  const call=async(path,args)=>(await runtime.call(path,args,{internal:true})).value;
  await runtime.exclusive(()=>runtime.store.insert('installation',{defaultEngine:'codex',onboarding:'skipped',createdAt:Date.now()}));
  const chat=await call('dashboard:createChat',{key});await runtime.exclusive(()=>runtime.store.patch(chat,{title:'Storage fixture chat'}));
  await call('runner:createToken',{name:'Synthetic pet computer',token:'synthetic-pet-runner'});await runtime.stop();sql.close();sql=null;runtime=null;
  const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p',String(port),'-H','127.0.0.1'],{cwd:resolve('.'),env:{...process.env,PERRY_PORT:String(port),TELEGRAM_BOT_TOKEN:'',COMPOSIO_API_KEY:'',GROQ_API_KEY:'',GEMINI_API_KEY:'',PERRY_WAKE_DISABLED:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{log=(log+chunk).slice(-16000);writeFileSync(join(output,'server.log'),log);});
  await until(async()=>{if(server.exitCode!==null)throw Error('Next exited: '+log);return fetch(base).then(response=>response.ok,()=>false);},'Next server');
  const {chromium}=await import(pathToFileURL(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);browser=await chromium.launch({headless:true,executablePath:process.env.PERRY_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=async(mode,corrupt)=>{
    const ctx=await browser.newContext({viewport:{width:900,height:800},reducedMotion:'reduce'});
    await ctx.addInitScript(({mode,corrupt})=>{
      const subscriptions=new Set();
      const subscribe=name=>{const token={name};subscriptions.add(token);return ()=>subscriptions.delete(token);};
      const hotkey=async()=>({hotkey:'Ctrl+Shift+Space',error:null});
      window.perryPet={solid(){},moveTo(){},dragStart(){},dragEnd(){},onArmed:()=>subscribe('armed'),onPlace:()=>subscribe('place'),idleSeconds:async()=>0,openDashboard(){},hotkey,setHotkey:hotkey,onVoice:()=>subscribe('voice'),onVoiceProgress:()=>subscribe('progress'),transcribe:async()=>({text:''}),voiceDone(){}};
      window.petSubscriptions=()=>subscriptions.size;
      navigator.mediaDevices.enumerateDevices=async()=>[];
      if(corrupt!==undefined)localStorage.setItem('perry.pet.limits',corrupt);
      const denied=()=>{throw new DOMException('Synthetic storage refusal','SecurityError');};
      if(mode==='getter')Object.defineProperty(window,'localStorage',{get:denied});
      else if(mode==='all')for(const method of ['getItem','setItem','removeItem'])Storage.prototype[method]=denied;
      else if(mode==='writes')for(const method of ['setItem','removeItem'])Storage.prototype[method]=denied;
      window.findPetProvider=kind=>{
        const element=document.querySelector('button[aria-label^="Perry. Click"]');
        const fiberKey=Object.keys(element??{}).find(key=>key.startsWith('__reactFiber$'));
        for(let node=element?.[fiberKey];node;node=node.return){const value=node.memoizedProps?.value;if(kind==='session'&&value?.dashboardKey&&typeof value.lock==='function')return value;if(kind==='router'&&typeof value?.push==='function'&&typeof value?.replace==='function')return value;}
        throw Error('Production context provider not found: '+kind);
      };
    },{mode,corrupt});
    await ctx.route('**/api/backend/call',async route=>{
      const input=route.request().postDataJSON();
      if(input.path==='updates:status')return route.fulfill({json:{value:{supervised:true,behind:1,state:'idle',latest:{sha:'synthetic-pet-update'}},reads:[]}});
      if(input.path==='usage:limits')return route.fulfill({json:{value:{used:['codex'],engines:[{kind:'codex',usage:{limits:{at:Date.now(),windows:[{id:'fixture',label:'5-hour',usedPercent:95,resetsAt:Date.now()+3600000}]}}}]},reads:[]}});
      return route.continue();
    });
    return ctx;
  };
  const open=async(ctx,fragment=true)=>{const page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(`${base}/pet?fixture=storage${fragment?'#key='+key:''}`);await page.getByRole('button',{name:/Perry\. Click to open him/}).waitFor();return page;};
  for(const mode of ['all','getter']){
    const ctx=await context(mode);const page=await open(ctx);await page.getByRole('button',{name:/Perry\. Click to open him/}).click();await page.locator('section[aria-label="Perry"]').waitFor();
    check(mode+': fragment key unlocks the real pet and is scrubbed',page.url()===`${base}/pet?fixture=storage`&&!await page.getByText("I'm locked out.",{exact:true}).count());
    check(mode+': media cookie uses the in-memory key',(await ctx.cookies()).some(cookie=>cookie.name==='perry_media'&&cookie.value===key));
    await page.getByRole('button',{name:"Perry's menu",exact:true}).click();await page.getByRole('menuitemcheckbox',{name:'Sounds when listening',exact:true}).click();await page.keyboard.press('Escape');
    await page.getByRole('button',{name:"Perry's menu",exact:true}).click();check(mode+': voice preference remains usable without persistence',await page.getByRole('menuitemcheckbox',{name:'Sounds when listening',exact:true}).getAttribute('aria-checked')==='false');await page.getByRole('menuitem',{name:'Quiet for an hour',exact:true}).click();
    await page.getByRole('button',{name:"Perry's menu",exact:true}).click();await page.getByRole('menuitem',{name:'Stop being quiet',exact:true}).waitFor();check(mode+': quiet choice remains active',true);await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:'To-dos',exact:true}).click();await page.getByRole('tab',{name:'Chat',exact:true}).click();
    await page.getByRole('button',{name:'New chat: pick a chat',exact:true}).click();await page.getByRole('menuitemradio',{name:'Storage fixture chat',exact:true}).click();await page.getByRole('button',{name:'Storage fixture chat: pick a chat',exact:true}).waitFor();await page.getByRole('button',{name:'New chat',exact:true}).click();
    check(mode+': selecting and clearing a chat works without persistence',await page.getByRole('button',{name:'New chat: pick a chat',exact:true}).isVisible());
    await page.evaluate(()=>window.findPetProvider('session').lock());await page.getByText("I'm locked out.",{exact:true}).waitFor();
    check(mode+': lock clears media authentication despite denied removal',!(await ctx.cookies()).some(cookie=>cookie.name==='perry_media'));check(mode+': lock unsubscribes authenticated voice listeners',await page.evaluate(()=>window.petSubscriptions())===2);
    await ctx.close();
  }
  const locked=await context('getter');const lockedPage=await open(locked,false);await lockedPage.getByText("I'm locked out.",{exact:true}).waitFor();check('denied reads without a fragment show recovery instead of a blank page',true);await locked.close();
  for(const corrupt of ['{broken','{}','[1,null,"old"]']){const ctx=await context('writes',corrupt);const page=await open(ctx);await page.getByRole('button',{name:/Perry\. Click to open him/}).click();await page.locator('section[aria-label="Perry"]').waitFor();await sleep(150);check('malformed or wrongly typed limit preference is recoverable: '+corrupt,await page.locator('section[aria-label="Perry"]').isVisible()&&!await page.getByText('Something went wrong',{exact:true}).count());await ctx.close();}
  const styleContext=await context('all');const stylePage=await styleContext.newPage();stylePage.on('pageerror',error=>errors.push(error.message));await stylePage.goto(`${base}/chat#key=${key}`);await stylePage.locator('[data-chat-panel-toggle]').waitFor();
  const styleResult=await stylePage.evaluate(async()=>{
    // Drive the installed App Router context, retaining this document across route changes.
    const any=document.querySelector('[data-chat-panel-toggle]');const fiberKey=Object.keys(any).find(key=>key.startsWith('__reactFiber$'));let router;for(let node=any[fiberKey];node;node=node.return){const value=node.memoizedProps?.value;if(typeof value?.push==='function'&&typeof value?.replace==='function'){router=value;break;}}
    if(!router)throw Error('App Router context unavailable');
    document.documentElement.style.setProperty('background-color','rgb(1, 2, 3)','important');document.body.style.setProperty('background-color','rgb(4, 5, 6)','important');document.documentElement.style.setProperty('color-scheme','light','important');window.petStyleRouter=router;window.petStyleOrigin=performance.timeOrigin;router.push('/pet#key=synthetic-pet-storage');return true;
  });
  assert.ok(styleResult);await stylePage.getByRole('button',{name:/Perry\. Click to open him/}).waitFor();await stylePage.evaluate(()=>window.petStyleRouter.push('/chat#key=synthetic-pet-storage'));await stylePage.locator('[data-chat-panel-toggle]').waitFor();
  check('client navigation restores document backgrounds and color-scheme priorities',await stylePage.evaluate(()=>performance.timeOrigin===window.petStyleOrigin&&document.documentElement.style.getPropertyValue('background-color')==='rgb(1, 2, 3)'&&document.body.style.getPropertyValue('background-color')==='rgb(4, 5, 6)'&&document.documentElement.style.getPropertyPriority('background-color')==='important'&&document.documentElement.style.getPropertyPriority('color-scheme')==='important'&&document.documentElement.style.colorScheme==='light'));
  await styleContext.close();check('no uncaught browser errors',errors.length===0);
}catch(error){errors.push(String(error.stack??error));if(browser)for(const ctx of browser.contexts())for(const page of ctx.pages())console.log('Failure page: '+await page.locator('body').innerText().catch(()=>''));process.exitCode=1;}
finally{
  await browser?.close();if(server?.pid&&server.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else{server.kill();await new Promise(done=>server.once('exit',done));}}
  await runtime?.stop();sql?.close();try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){errors.push(String(error));process.exitCode=1;}
  const result={pass:Object.keys(checks).length>0&&Object.values(checks).every(Boolean)&&errors.length===0,checks,errors,scratchRemoved:!existsSync(scratch),scope:'Built Next PetScreen, real Runtime authentication, browser Storage refusals, synthetic native bridge/update/usage responses; session lock/router contracts invoked through mounted production React providers'};writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
