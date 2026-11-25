// Native capability baseline only; failure inventory is in docs/regression-checks.md.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.TEMP=process.env.TMP=join(homedir(),'AppData','Local','Temp');
const {openChat,sleep}=await import('../browser.ts');
const output=resolve(process.argv[2]??'node_modules/.cache/media-fullscreen-result');mkdirSync(output,{recursive:true});
const html=`<!doctype html><html><body><input type="file" hidden><div id="target" tabindex="0" style="width:450px;height:250px;background:#234;color:white;padding:20px">Native fullscreen target. Press F.</div><button id="button">Native fullscreen</button><script>
window.attempts=[];window.transitions=[];
function request(event){const attempt={type:event.type,key:event.key,trusted:event.isTrusted,focused:document.hasFocus(),visibility:document.visibilityState,enabled:document.fullscreenEnabled,active:document.activeElement.id,activation:{active:navigator.userActivation.isActive,ever:navigator.userActivation.hasBeenActive}};attempts.push(attempt);document.getElementById('target').requestFullscreen().then(()=>{attempt.result='entered';attempt.element=document.fullscreenElement?.id;},error=>{attempt.result='rejected';attempt.error={name:error.name,message:error.message};});}
document.getElementById('target').addEventListener('keydown',event=>{if(event.key==='f'){event.preventDefault();request(event);}});document.getElementById('button').addEventListener('click',request);document.addEventListener('fullscreenchange',()=>transitions.push(document.fullscreenElement?.id??null));
</script></body></html>`;
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});let browser;const report={scope:'Same artifacts/browser.ts headless Chrome helper, native DOM/fullscreen promise, real CDP key/click; no Perry/Next/model/account',attempts:[],transitions:[],errors:[]};
try{
  await new Promise(done=>server.listen(0,'127.0.0.1',done));browser=await openChat(`http://127.0.0.1:${server.address().port}`,'synthetic-native-fullscreen');
  const finishAttempt=async count=>{const end=Date.now()+5000;while(Date.now()<end){if(await browser.evaluate(`window.attempts.length>=${count} && Boolean(window.attempts[${count-1}].result)`))break;await sleep(25);}if(await browser.evaluate('Boolean(document.fullscreenElement)'))await browser.evaluate('document.exitFullscreen()');await sleep(100);};
  const key=async()=>{await browser.evaluate("document.getElementById('target').focus(); true");await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'f',code:'KeyF',windowsVirtualKeyCode:70,text:'f'});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'f',code:'KeyF',windowsVirtualKeyCode:70});};
  await key();await finishAttempt(1);
  await browser.send('Page.bringToFront');await key();await finishAttempt(2);
  const point=await browser.evaluate("(()=>{const box=document.getElementById('button').getBoundingClientRect();return{x:box.x+box.width/2,y:box.y+box.height/2};})()");
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await finishAttempt(3);
  Object.assign(report,await browser.evaluate('({attempts:window.attempts,transitions:window.transitions,userAgent:navigator.userAgent})'));report.errors=browser.errors;report.tempRoot=tmpdir();report.classification=report.attempts.length===3&&report.attempts.every(attempt=>attempt.result==='rejected')?'native fullscreen refused in this headless environment':report.attempts.some(attempt=>attempt.result==='entered')?'native fullscreen entered; investigate app/helper differences':'incomplete baseline';
}catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;}
finally{browser?.close();server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));report.serverClosed=!server.listening;writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
