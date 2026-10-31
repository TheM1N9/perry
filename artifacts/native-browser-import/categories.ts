/** Native history and MV3 extension migration with disposable data only. */
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve} from 'node:path';
const output=resolve('artifacts/native-browser-import/results'),fixture=JSON.parse(readFileSync(join(output,'fixture.json'),'utf8'));
process.env.PERRY_HOME=fixture.home;process.env.PERRY_IMPORT_CHROME_ROOT=fixture.root;process.env.PERRY_IMPORT_HELPER_PATH=fixture.helper;process.env.PERRY_BROWSER_PATH=fixture.browser;
const web=await import('../../convex/lib/browser'),{controlBrowser}=await import('../../server/browser-host'),{nativeImport,nativeProfiles}=await import('../../server/browser-import'),{browserState}=await import('../../lib/browser-protocol');
const checks:Record<string,boolean>={};const check=(name:string,pass:boolean)=>{checks[name]=pass;assert.ok(pass,name);console.log(`PASS ${name}`);};
try {
 const history=new DatabaseSync(join(fixture.root,'Default','History'));
 const time=BigInt(Date.now())*1000n+11644473600000000n;
 const visit=history.prepare('INSERT OR REPLACE INTO urls(url,title,visit_count,typed_count,last_visit_time,hidden) VALUES(?,?,?,?,?,?)').run('https://perry.invalid/fixture-history','Disposable history',1,1,time,0);
 history.prepare('INSERT INTO visits(url,visit_time,transition) VALUES(?,?,?)').run(visit.lastInsertRowid,time,805306369);history.close();
 const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const key=publicKey.export({type:'spki',format:'der'});const id=createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,char=>String.fromCharCode(97+parseInt(char,16)));
 const extension=join(fixture.root,'Default','Extensions',id,'1.0_0');mkdirSync(extension,{recursive:true});writeFileSync(join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Perry disposable extension',version:'1.0',key:key.toString('base64'),permissions:['history'],options_page:'options.html'}));writeFileSync(join(extension,'options.html'),'<title>Disposable extension</title><h1>Perry extension fixture</h1>');
 const source=readFileSync(join(fixture.root,'Default','History'));
 const state=browserState.parse(await controlBrowser(fixture.chat,{action:'start'},true));
 const counts=await nativeImport(fixture.chat,state.identity!,nativeProfiles()[0].id,{cookies:false,passwords:false,history:true,extensions:true});
 check('selected history and extension categories imported',counts.history>=1&&counts.extensions>=1);
 check('source history remains unchanged',source.equals(readFileSync(join(fixture.root,'Default','History'))));
 await web.withOwnerBrowser(fixture.chat,()=>web.hostCommand('Page.navigate',{url:`chrome-extension://${id}/options.html`}));await new Promise(done=>setTimeout(done,300));
 const page=await web.withOwnerBrowser(fixture.chat,()=>web.hostCommand('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true})) as any;
 check('native browser loads extension with preserved identity',page.result.value.includes('Perry extension fixture'));
 const nativeHistory=await web.withOwnerBrowser(fixture.chat,()=>web.hostCommand('Runtime.evaluate',{expression:"new Promise(done=>chrome.history.search({text:'fixture-history',startTime:0},items=>done(items.some(item=>item.url==='https://perry.invalid/fixture-history'))))",awaitPromise:true,returnByValue:true})) as any;
 check('destination contains selected history',nativeHistory.result.value===true);
}catch(error){console.error(error instanceof Error?error.message:'Category check failed');process.exitCode=1;}
finally {if(web.browserControl(fixture.chat).current)await web.withBrowserView(fixture.chat,async()=>{await web.hostCommand('Browser.close').catch(()=>{});web.closeBrowser();});writeFileSync(join(output,'categories-report.json'),JSON.stringify({checks,passed:Object.keys(checks).length===4&&Object.values(checks).every(Boolean),ownerCredentialsRead:false},null,2));}
process.exit(Object.keys(checks).length===4&&Object.values(checks).every(Boolean)?0:1);
