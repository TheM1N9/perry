// Read docs/regression-checks.md before changing this integration soak.
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,statfsSync,writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { snapshotBuild } from './snapshot.mjs';

const durationMinutes=process.argv[3]===undefined?30:Number(process.argv[3]);
if(!Number.isFinite(durationMinutes)||durationMinutes<=0||durationMinutes>1440||!Number.isSafeInteger(durationMinutes*60_000))throw Error('Duration must be finite, positive, at most1440 minutes, and represent whole milliseconds');
if(process.argv.length>5||process.argv[4]!==undefined&&process.argv[4]!=='--snapshot')throw Error('Usage: run.mjs [output-directory] [minutes] [--snapshot]');
const nativeTemp=join(homedir(),'AppData','Local','Temp');
process.env.TEMP=process.env.TMP=nativeTemp;
const output=resolve(process.argv[2]??'node_modules/.cache/session-stability');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(join(nativeTemp,'perry-session-soak-')),home=join(scratch,'home');mkdirSync(home);
const key='synthetic-session-soak',token='synthetic-session-runner',durationMs=durationMinutes*60_000;
process.env.PERRY_HOME=home;process.env.DASHBOARD_KEY=key;process.env.PERRY_CREDENTIAL_KEY='b6'.repeat(32);
const report={scope:`${durationMinutes}-minute built Next dashboard/pet; real HTTP/SSE/React/media; synthetic runner/embedding/native bridge; loopback only`,checks:{},samples:[],errors:[],cycles:0,reconnects:0,liveExchanges:0,phase:'setup',scratch,durationMs};
const save=()=>writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));
const check=(name,ok)=>{report.checks[name]=Boolean(ok);assert.ok(ok,name);console.log('PASS '+name);};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(test,label,ms=25000)=>{const end=Date.now()+ms;while(!await test()){if(serverFailure)throw Error(serverFailure);if(Date.now()>end)throw Error('Timed out: '+label);await sleep(100);}};
const stopped=()=>existsSync(join(output,'stop.request'));
const directoryBytes=path=>readdirSync(path,{withFileTypes:true}).reduce((sum,entry)=>{try{return sum+(entry.isDirectory()?directoryBytes(join(path,entry.name)):statSync(join(path,entry.name)).size);}catch{return sum;}},0);
let server,context,browser,browserCdp,client,pumpTimer,pumping=false,pumpFailure,serverFailure,lastBeat=0,startedAt;
const running=new Set(),network=new Map(),pages={},sessions={};
const record=()=>save();
try{
  const reserve=statfsSync(nativeTemp);if(Number(reserve.bavail)*Number(reserve.bsize)<400*1024*1024)throw Error('Insufficient C temporary space for snapshot/profile and200MiB reserve');
  const snapshot=process.argv[4]==='--snapshot'?snapshotBuild(resolve('.'),scratch,output):null;
  if(snapshot){report.snapshot=snapshot;console.log(`SNAPSHOT_COPIED build=${snapshot.buildId} bytes=${snapshot.bytes} files=${snapshot.files}`);}
  const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const base=`http://127.0.0.1:${port}`;
  const preload=pathToFileURL(resolve('artifacts/session-stability/preload.mjs')).href;
  server=spawn(process.execPath,['--import',preload,...(snapshot?[snapshot.launcher]:['node_modules/next/dist/bin/next','start','-p',String(port),'-H','127.0.0.1'])],{cwd:snapshot?.root??resolve('.'),env:{...process.env,PERRY_PORT:String(port),PERRY_WAKE_DISABLED:'1',PERRY_SUPERVISOR:'',PERRY_EMBED_MODEL:'session-soak-fixture',PERRY_SOAK_SERVER_METRICS:join(output,'server-metrics.jsonl'),PERRY_SOAK_SCRATCH:snapshot?scratch:'',PERRY_SOAK_SNAPSHOT_ROOT:snapshot?.root??'',PERRY_SOAK_FORBIDDEN_BUILD:snapshot?.source??'',PERRY_SOAK_OUTPUT:output,TELEGRAM_BOT_TOKEN:'',COMPOSIO_API_KEY:'',GROQ_API_KEY:'',GEMINI_API_KEY:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{log=(log+chunk).slice(-24000);if(/unhandledRejection|uncaughtException/.test(log))serverFailure='Uncaught production server error: '+log.slice(-2000);writeFileSync(join(output,'server.log'),log);});
  await until(async()=>{if(server.exitCode!==null)throw Error('Next exited: '+log);return fetch(base).then(response=>response.ok,()=>false);},'Next startup');
  report.buildId=snapshot?.buildId??readFileSync('.next/BUILD_ID','utf8').trim();report.serverPid=server.pid;report.base=base;
  const {BackendClient}=await import('../../client/backend.ts');client=new BackendClient(base,{adminKey:key});
  const call=async(path,args={})=>(await client.call(path,args)).value;
  const owner=(path,args={})=>call(path,{key,...args});
  await call('installation:setOnboarding',{state:'skipped'});await call('installation:setDefaultEngine',{engine:'codex'});await call('runner:createToken',{name:'Synthetic soak runner',token});
  await call('engines:report',{token,engines:[{kind:'codex',installed:true,signedIn:true,auth:{type:'chatgpt',plan:'fixture'},models:[{id:'gpt-5.5',name:'Fixture model',isDefault:true,efforts:['low','medium','high'],defaultEffort:'medium'}]}]});
  const pump=async()=>{
    if(pumping||pumpFailure)return;pumping=true;
    try{
      if(Date.now()-lastBeat>5000){await call('runner:checkIn',{token,hostname:'SOAK_FIXTURE',platform:process.platform,workdir:home,activeTurnIds:[...running]});lastBeat=Date.now();}
      for(const turn of await call('codex:queuedTurns',{token})){
        if(!await call('codex:claimTurn',{token,id:turn._id}))continue;running.add(turn._id);
        await call('codex:finishTurn',{token,id:turn._id,model:'gpt-5.5',response:'Synthetic soak reply. No model was called.'});running.delete(turn._id);
      }
    }catch(error){pumpFailure=String(error.stack??error);}finally{pumping=false;}
  };
  await pump();pumpTimer=setInterval(()=>void pump(),2000);
  const chats=[];for(const label of ['A','B','C'])chats.push(await owner('dashboard:createChat'));
  const wav=Buffer.alloc(44+128000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(128000,40);for(let i=0;i<64000;i++)wav.writeInt16LE(Math.round(Math.sin(i*Math.PI/20)*4000),44+i*2);
  const uploaded=await fetch(base+'/api/media',{method:'POST',headers:{cookie:`perry_media=${key}`,'x-file-name':'soak.wav','x-upload-id':randomUUID()},body:wav});assert.ok(uploaded.ok);const media=await uploaded.json();
  const attachment=await owner('dashboard:registerAttachment',{conversationId:chats[0],messageKey:'soak-media',localPath:media.path,fileName:'soak.wav',contentType:'audio/wav',size:wav.length});
  for(let index=0;index<chats.length;index++)await owner('dashboard:sendChat',{id:chats[index],text:`SOAK_CHAT_${index}_BASELINE`,requestId:randomUUID(),...(index===0?{messageKey:'soak-media',attachmentIds:[attachment]}:{})});
  await until(async()=>{if(pumpFailure)throw Error(pumpFailure);return (await Promise.all(chats.map(id=>owner('dashboard:getChat',{id})))).every(chat=>!chat?.isRunning);},'synthetic turns finish');
  for(let index=0;index<chats.length;index++)await owner('dashboard:renameChat',{id:chats[index],title:`Soak ${index}`});
  const {chromium}=await import(pathToFileURL(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
  context=await chromium.launchPersistentContext(join(scratch,'chrome-profile'),{headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',viewport:{width:1280,height:900},reducedMotion:'reduce',args:['--autoplay-policy=no-user-gesture-required','--disk-cache-size=16777216','--media-cache-size=8388608','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
  browser=context.browser();browserCdp=await browser.newBrowserCDPSession();
  const blockedHosts=new Map();await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){blockedHosts.set(url.hostname,(blockedHosts.get(url.hostname)??0)+1);return route.abort('blockedbyclient');}return route.continue();});
  await context.addInitScript(({key})=>{
    localStorage.setItem('perry.dashboard.key',key);
    window.soakObserve=()=>{
      if(!window.soakClient||!window.soakRouter){
        const element=document.querySelector('button[aria-label^="Perry. Click"], [data-chat-panel-toggle], a[href="/library"]');const fiberKey=Object.keys(element??{}).find(key=>key.startsWith('__reactFiber$'));
        for(let node=element?.[fiberKey];node;node=node.return){const value=node.memoizedProps?.value;if(value&&typeof value.query==='function'&&typeof value.clearChatCache==='function')window.soakClient=value;if(value&&typeof value.push==='function'&&typeof value.replace==='function')window.soakRouter=value;}
      }
      const client=window.soakClient;if(!client||!(client.subscriptions instanceof Map)||!(client.queryWaiters instanceof Set))throw Error('Actual BackendClient internals unavailable');
      const values=[...client.subscriptions.values()];return {connection:client.connectionSnapshot(),subscriptions:values.length,activeSubscriptions:values.filter(sub=>sub.listeners.size).length,listeners:values.reduce((sum,sub)=>sum+sub.listeners.size,0),inFlight:values.filter(sub=>sub.inFlight).length,retries:values.filter(sub=>sub.retry).length,queryWaiters:client.queryWaiters.size,activeQueries:client.activeQueries,refreshQueued:client.refreshPending?.due.size??0,connectionListeners:client.connectionListeners.size,retainedChatBytes:values.reduce((sum,sub)=>sum+(sub.retainedBytes??0),0),visibleMessages:[...document.querySelectorAll('[data-role="user"],[data-role="assistant"]')].map(element=>({role:element.getAttribute('data-role'),text:element.innerText})),playing:[...document.querySelectorAll('audio,video')].filter(media=>!media.paused).length,path:location.pathname};
    };
    if(location.pathname==='/pet'){
      const listeners=new Set();const on=name=>{const item={name};listeners.add(item);return()=>listeners.delete(item);};const hotkey=async()=>({hotkey:'Ctrl+Shift+Space',error:null});
      window.perryPet={solid(){},moveTo(){},dragStart(){},dragEnd(){},onArmed:()=>on('armed'),onPlace:()=>on('place'),idleSeconds:async()=>0,openDashboard(){},hotkey,setHotkey:hotkey,onVoice:()=>on('voice'),onVoiceProgress:()=>on('voice-progress'),transcribe:async()=>({text:''}),voiceDone(){}};window.soakPetListeners=()=>listeners.size;navigator.mediaDevices.enumerateDevices=async()=>[];
    }
  },{key});
  pages.dashboard=context.pages()[0]??await context.newPage();pages.pet=await context.newPage();
  for(const [name,page]of Object.entries(pages)){
    page.on('pageerror',error=>report.errors.push(`${name}: ${error.message}`));const cdp=await context.newCDPSession(page);sessions[name]=cdp;network.set(name,new Map());await cdp.send('Network.enable');await cdp.send('Performance.enable');
    cdp.on('Network.requestWillBeSent',event=>{if(event.request.url.startsWith(base))network.get(name).set(event.requestId,{sse:event.request.url.includes('/api/backend/events')});});for(const event of ['Network.loadingFinished','Network.loadingFailed'])cdp.on(event,value=>network.get(name).delete(value.requestId));
  }
  await pages.dashboard.goto(`${base}/chat/${chats[0]}`);await pages.dashboard.locator('[data-chat-panel-toggle]').waitFor();await pages.pet.goto(`${base}/pet#key=${key}`);await pages.pet.getByRole('button',{name:/Perry\. Click to open him/}).waitFor();
  const connected=()=>until(async()=>{if(pumpFailure)throw Error(pumpFailure);return(await Promise.all(Object.values(pages).map(page=>page.evaluate(()=>window.soakObserve())))).every(state=>state.connection==='connected');},'both SSE streams connected');
  const quiet=async()=>{
    let quietSince=0;
    await until(async()=>{
      if(pumpFailure)throw Error(pumpFailure);
      const states=await Promise.all(Object.values(pages).map(page=>page.evaluate(()=>window.soakObserve())));
      const idle=states.every(state=>state.connection==='connected'&&state.inFlight===0&&state.retries===0&&state.queryWaiters===0&&state.activeQueries===0&&state.refreshQueued===0&&state.playing===0);
      if(!idle){quietSince=0;return false;}
      quietSince||=Date.now();return Date.now()-quietSince>=500;
    },'both actual client queues drain and stay idle',15000);
  };
  const pausePump=async(final=false)=>{
    clearInterval(pumpTimer);await until(()=>!pumping,'fixture runner poll settles');
    if(final){lastBeat=0;await pump();if(pumpFailure)throw Error(pumpFailure);report.finalFixtureHeartbeatAt=Date.now();}
  };
  await connected();check('baseline observes actual client maps and real connected SSE',true);
  const visit=async id=>{await pages.dashboard.locator(`a[href="/chat/${id}"]`).first().click();await until(()=>pages.dashboard.evaluate(id=>location.pathname===`/chat/${id}`&&Boolean(document.querySelector('#composer')),id),'chat route');};
  const closePet=async()=>{const close=pages.pet.locator('section[aria-label="Perry"] button[aria-label="Close"]');if(await close.count())await close.click();await until(()=>pages.pet.locator('section[aria-label="Perry"]').count().then(count=>count===0),'pet closes');};
  const terminal=async()=>{const page=pages.dashboard;await page.locator('[data-chat-panel-toggle]').click();const launcher=page.locator('[data-launcher-row="terminal"]');if(await launcher.count())await launcher.click();else throw Error('Terminal launcher missing');await page.locator('[data-terminal] .xterm').waitFor();await page.getByRole('button',{name:'Close Terminal',exact:true}).click();await until(()=>page.locator('.xterm').count().then(count=>count===0),'terminal disposes');};
  const cycle=async(withTerminal=false)=>{
    report.phase='navigation/media';for(const id of [chats[1],chats[2],chats[0]])await visit(id);
    const audio=pages.dashboard.locator('[data-media-player="audio"]').first();await audio.waitFor();await until(()=>audio.getAttribute('data-waveform').then(state=>state==='ready'),'waveform ready');
    await audio.getByRole('button',{name:/^Play/}).click();await until(()=>audio.locator('audio').evaluate(media=>!media.paused),'audio starts');await audio.locator('audio').evaluate(media=>media.pause());
    if(withTerminal)await terminal();
    await pages.pet.getByRole('button',{name:/Perry\. Click to open him/}).click();await pages.pet.getByRole('tab',{name:'To-dos',exact:true}).click();await pages.pet.getByRole('tab',{name:'Needs you',exact:false}).click();await pages.pet.getByRole('tab',{name:'Chat',exact:true}).click();await closePet();report.cycles++;
  };
  const offline=async()=>{
    report.phase='offline';for(const [name,page]of Object.entries(pages)){await sessions[name].send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.evaluate(()=>{window.soakClient.suspend();window.soakClient.resume();});}
    await sleep(4000);for(const cdp of Object.values(sessions))await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await connected();report.reconnects++;
  };
  const sample=async(label,gc=false)=>{
    const value={at:Date.now(),elapsedMs:startedAt?Date.now()-startedAt:0,label,gc,phase:report.phase,cycles:report.cycles,reconnects:report.reconnects,pages:{}};
    for(const [name,page]of Object.entries(pages)){if(gc)await sessions[name].send('HeapProfiler.collectGarbage');value.pages[name]={client:await page.evaluate(()=>window.soakObserve()),heap:await sessions[name].send('Runtime.getHeapUsage'),dom:await sessions[name].send('Memory.getDOMCounters'),network:{sse:[...network.get(name).values()].filter(request=>request.sse).length,ordinary:[...network.get(name).values()].filter(request=>!request.sse).length},...(name==='pet'?{nativeBridgeListeners:await page.evaluate(()=>window.soakPetListeners())}:{})};}
    const processes=(await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;value.browserProcessTypes=processes.reduce((counts,item)=>({...counts,[item.type]:(counts[item.type]??0)+1}),{});value.browserPages=context.pages().length;
    const pids=[server.pid,...processes.map(item=>item.id)].filter(id=>Number.isInteger(id)&&id>0);const command=`Get-Process -Id ${[...new Set(pids)].join(',')} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Handles,@{Name='WorkingSet';Expression={$_.WorkingSet64}},@{Name='PrivateBytes';Expression={$_.PrivateMemorySize64}},@{Name='Threads';Expression={$_.Threads.Count}} | ConvertTo-Json -Compress`;
    const windows=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:5000});value.processes=windows.status===0&&windows.stdout.trim()?JSON.parse(windows.stdout):null;
    value.ownedDiskBytes=directoryBytes(scratch);value.outputBytes=directoryBytes(output);const fs=statfsSync(nativeTemp);value.freeTempBytes=Number(fs.bavail)*Number(fs.bsize);
    if(value.ownedDiskBytes>200*1024*1024)throw Error('Owned temporary data exceeded200MiB budget');if(value.outputBytes>10*1024*1024)throw Error('Generated evidence exceeded10MiB budget');if(value.freeTempBytes<200*1024*1024)throw Error('Native C temporary space below200MiB reserve');
    report.samples.push(value);appendFileSync(join(output,'samples.jsonl'),JSON.stringify(value)+'\n');record();console.log(`SOAK sample ${label}: elapsed=${Math.round(value.elapsedMs/1000)}s cycles=${report.cycles} reconnects=${report.reconnects} heapMB=${Object.entries(value.pages).map(([name,data])=>name+':'+(data.heap.usedSize/1048576).toFixed(1)).join(',')} diskMB=${(value.ownedDiskBytes/1048576).toFixed(1)}`);return value;
  };
  await pages.dashboard.locator('[data-media-player="audio"]').first().waitFor();
  await pages.dashboard.evaluate(()=>{window.soakDepartingAudio=document.querySelector('[data-media-player="audio"] audio');});
  await pages.dashboard.locator('[data-media-player="audio"]').first().getByRole('button',{name:/^Play/}).click();await until(()=>pages.dashboard.evaluate(()=>!window.soakDepartingAudio.paused),'baseline playback');await visit(chats[1]);await until(()=>pages.dashboard.evaluate(()=>!window.soakDepartingAudio.isConnected),'audio unmount');
  report.departingAudio=await pages.dashboard.evaluate(()=>{const audio=window.soakDepartingAudio;const result={paused:audio.paused,connected:audio.isConnected,time:audio.currentTime};audio.pause();delete window.soakDepartingAudio;return result;});
  check('departing media pauses when its player unmounts',report.departingAudio.paused);
  await visit(chats[0]);await cycle(true);await offline();await cycle(false);await sleep(10000);await connected();
  await until(()=>Promise.resolve(existsSync(join(output,'server-metrics.jsonl'))),'preload server sample',35000);const serverSample=JSON.parse(readFileSync(join(output,'server-metrics.jsonl'),'utf8').trim().split('\n').at(-1));check('one fixture embedder prevents native model loading',serverSample.embedders===1&&serverSample.readyEmbedders===1);report.baselineServer=serverSample;
  if(serverFailure)throw Error(serverFailure);
  if(snapshot)check('snapshot serves compiled modules without source-build reads or external writes',serverSample.snapshot?.compiledModules>0&&serverSample.snapshot?.sourceBuildReads===0&&serverSample.snapshot?.externalWrites===0);
  await pausePump();await visit(chats[1]);await sleep(10000);await quiet();await sample('stable-content-baseline',true);await visit(chats[0]);await sleep(10000);await quiet();
  await sample('warm-unforced');await sample('baseline',true);check('warm routes media pet terminal and offline recovery work before timing',true);
  report.snapshotReady=Boolean(snapshot);save();if(snapshot)console.log(`SNAPSHOT_READY shared-build-released build=${snapshot.buildId}`);
  startedAt=Date.now();report.startedAt=new Date(startedAt).toISOString();report.phase='idle';pumpTimer=setInterval(()=>void pump(),2000);save();let nextCycle=startedAt+30000,nextSample=startedAt+60000,lastProgress=0;
  while(Date.now()-startedAt<durationMs){
    if(stopped()){report.interrupted=true;throw Error('Coordinator requested shared-build release');}if(serverFailure)throw Error(serverFailure);if(pumpFailure)throw Error(pumpFailure);if(report.errors.length)throw Error('Uncaught browser errors observed');
    if(Date.now()>=nextCycle){const minute=Math.floor((Date.now()-startedAt)/60000);await cycle(minute%5===0);if(minute>0&&minute%5===0){await offline();const prompt=`SOAK_LIVE_${minute}`;await owner('dashboard:sendChat',{id:chats[0],text:prompt,requestId:randomUUID()});await until(()=>pages.dashboard.getByText(prompt,{exact:true}).count().then(count=>count>0),'SSE delivers live synthetic message');await until(async()=>!(await owner('dashboard:getChat',{id:chats[0]}))?.isRunning,'synthetic reply finishes');report.liveExchanges++;}report.phase='idle';nextCycle+=60000;}
    if(Date.now()>=nextSample){await sample(`minute-${Math.round((Date.now()-startedAt)/60000)}`,false);nextSample+=60000;}
    if(Date.now()-lastProgress>=30000){lastProgress=Date.now();console.log(`SOAK progress elapsed=${Math.round((Date.now()-startedAt)/1000)}s phase=${report.phase}`);}
    await sleep(1000);
  }
  await pausePump(true);await closePet();await visit(chats[0]);await sleep(10000);await quiet();await sample('end-unforced');await sample('end',true);
  const baseline=report.samples.find(value=>value.label==='baseline'),end=report.samples.at(-1);report.comparison={};
  for(const name of ['dashboard','pet']){const before=baseline.pages[name],after=end.pages[name];report.comparison[name]={heapDelta:after.heap.usedSize-before.heap.usedSize,nodeDelta:after.dom.nodes-before.dom.nodes,listenerDelta:after.dom.jsEventListeners-before.dom.jsEventListeners,subscriptionDelta:after.client.subscriptions-before.client.subscriptions,activeSubscriptionDelta:after.client.activeSubscriptions-before.client.activeSubscriptions};check(name+' finishes connected with no queued/retry/media work',after.client.connection==='connected'&&after.client.queryWaiters===0&&after.client.retries===0&&after.client.inFlight===0&&after.client.activeQueries===0&&after.client.refreshQueued===0&&after.client.playing===0);check(name+' retains one SSE stream',after.network.sse===1);}
  await visit(chats[1]);await sleep(10000);await quiet();const stableEnd=await sample('stable-content-end',true),stableBefore=report.samples.find(value=>value.label==='stable-content-baseline');report.stableContentComparison={heapDelta:stableEnd.pages.dashboard.heap.usedSize-stableBefore.pages.dashboard.heap.usedSize,nodeDelta:stableEnd.pages.dashboard.dom.nodes-stableBefore.pages.dashboard.dom.nodes,listenerDelta:stableEnd.pages.dashboard.dom.jsEventListeners-stableBefore.pages.dashboard.dom.jsEventListeners,contentEqual:JSON.stringify(stableEnd.pages.dashboard.client.visibleMessages)===JSON.stringify(stableBefore.pages.dashboard.client.visibleMessages)};
  check('unchanged chat checkpoint retains identical visible message content',report.stableContentComparison.contentEqual);
  report.finalServer=JSON.parse(readFileSync(join(output,'server-metrics.jsonl'),'utf8').trim().split('\n').at(-1));
  check('fresh final server telemetry retains isolated bounded state',Date.now()-report.finalServer.at<45000&&report.finalServer.state?.runningActions===0&&report.finalServer.state?.pendingTurns===0&&report.finalServer.state?.pendingMachines===0&&report.finalServer.blockedExternalFetches===0&&(!snapshot||report.finalServer.snapshot?.sourceBuildReads===0&&report.finalServer.snapshot?.externalWrites===0&&report.finalServer.snapshot?.compiledModules>0));
  check(`two browser pages remain after measured${durationMinutes}minutes`,end.browserPages===2&&Date.now()-startedAt>=durationMs);check('no uncaught browser errors',report.errors.length===0);report.completed=true;report.endedAt=new Date().toISOString();
}catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;console.error(report.errors.at(-1));}
finally{
  report.phase='cleanup';clearInterval(pumpTimer);if(client)client.close();await context?.close();if(server?.pid&&server.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill();if(server.exitCode===null)await new Promise(done=>server.once('exit',done));}
  try{rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:300});}catch(error){report.cleanupError=String(error);}
  report.scratchRemoved=!existsSync(scratch);report.ownedProcessesStopped=true;report.pass=report.completed===true&&Object.values(report.checks).every(Boolean)&&report.errors.length===0;save();console.log(JSON.stringify({pass:report.pass,completed:report.completed,cycles:report.cycles,reconnects:report.reconnects,samples:report.samples.length,comparison:report.comparison,errors:report.errors,scratchRemoved:report.scratchRemoved,ownedProcessesStopped:true},null,2));
}
