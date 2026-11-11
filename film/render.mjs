// Render/stills for the local film. Frames survive interrupted encodes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const flag=name=>{const i=args.indexOf(name);return i<0?null:args[i+1]?.startsWith('--')?true:args[i+1]??true;};
const PAGE=flag('--page')||'perry.html',OUT=flag('--out')||'perry.mp4';
if(typeof PAGE!=='string'||typeof OUT!=='string')throw Error('--page and --out need a filename.');
const output=path.resolve(ROOT,OUT),audioOutput=output.replace(/\.mp4$/i,'.wav');
if(audioOutput===output)throw Error('--out must end in .mp4.');
const temporaryVideo=path.join(path.dirname(output),`.${path.basename(output)}.${process.pid}.tmp.mp4`);
const cacheRoot=path.join(ROOT,'.render-cache');
const cache=path.join(cacheRoot,createHash('sha256').update(output).digest('hex').slice(0,16));
const framesDir=path.join(cache,'frames'),manifestFile=path.join(cache,'manifest.json'),audio=path.join(cache,'audio.wav');
function clearFrames(){
  const target=path.resolve(framesDir);
  if(!target.startsWith(path.resolve(cacheRoot)+path.sep))throw Error('Invalid render-cache path.');
  fs.rmSync(target,{recursive:true,force:true});
}
function persist(value){const temporary=manifestFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,manifestFile);}
function inputHash(folder=ROOT,hash=createHash('sha256')){
  for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(['node_modules','.render-cache','stills','.git'].includes(entry.name))continue;
    const file=path.join(folder,entry.name);
    if(entry.isDirectory())inputHash(file,hash);
    else if(/\.(html|css|[cm]?js|svg|png|jpe?g|webp|ttf|woff2?)$/i.test(entry.name)){hash.update(path.relative(ROOT,file));hash.update(fs.readFileSync(file));}
  }
  return hash;
}
async function completed(child){const[code,signal]=await once(child,'close');if(code!==0)throw Error(`ffmpeg failed (${signal||code}). Cached frames are retained.`);}
const MIME={'.html':'text/html','.ttf':'font/ttf','.woff2':'font/woff2','.svg':'image/svg+xml','.js':'text/javascript'};
const server=http.createServer((req,res)=>{
  let file;
  try{file=path.resolve(ROOT,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));}catch{res.writeHead(400);res.end();return;}
  if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream'});
  fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
});
let browser,encoder;
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(flag('--serve')?8123:0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}/${PAGE}`;
  if(flag('--serve')){console.log(`preview: ${base}`);await new Promise(()=>{});}
  const executablePath=process.env.PERRY_BROWSER_PATH||process.env.PUPPETEER_EXECUTABLE_PATH;
  browser=await puppeteer.launch({...(executablePath?{executablePath}:{channel:'chrome'}),headless:true,args:['--autoplay-policy=no-user-gesture-required','--force-device-scale-factor=1']});
  const page=await browser.newPage();let pageFailure;
  page.on('console',m=>console.log('[page]',m.text()));
  page.on('pageerror',error=>{pageFailure=error;});
  await page.setViewport({width:1920,height:1080});
  await page.goto(`${base}?render`,{waitUntil:'load'});await page.evaluate(()=>window.ready);
  if(pageFailure)throw pageFailure;
  const{FPS,DUR,SUB}=await page.evaluate(()=>({FPS:window.FPS_||60,DUR:window.DUR_||15,SUB:window.SUB_||5}));
  if(![FPS,DUR,SUB].every(n=>Number.isFinite(n)&&n>0))throw Error('Invalid film timing or supersampling.');
  const stills=flag('--stills');
  if(stills){
    const times=String(stills===true?'0.5':stills).split(',').map(Number);
    if(times.some(t=>!Number.isFinite(t)||t<0||t>DUR))throw Error('Still times must be within the film duration.');
    fs.mkdirSync(path.join(ROOT,'stills'),{recursive:true});
    for(const t of times){
      const file=path.join(ROOT,'stills',`${t.toFixed(3)}.png`);
      const signature=inputHash().update(JSON.stringify({PAGE,t,SUB,browser:await browser.version()})).digest('hex');
      const receipt=file+'.json';
      let previous;try{previous=JSON.parse(fs.readFileSync(receipt,'utf8'));}catch{}
      if(fs.existsSync(file)&&previous?.signature===signature){console.log(`[SKIP] still ${t}`);continue;}
      const url=await page.evaluate((t,s)=>window.frameDataURL(t,s),t,SUB);
      const temporary=file+'.tmp';fs.writeFileSync(temporary,Buffer.from(url.split(',')[1],'base64'));fs.renameSync(temporary,file);
      fs.writeFileSync(receipt,JSON.stringify({signature}));console.log(`[OK] still ${t}`);
    }
  }else{
    const signature=inputHash().update(JSON.stringify({PAGE,FPS,DUR,SUB,audioOnly:!!flag('--audio'),browser:await browser.version()})).digest('hex');
    fs.mkdirSync(cache,{recursive:true});let manifest;
    try{manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));}catch{}
    const stat=fs.existsSync(output)?fs.statSync(output):null;
    if(manifest?.signature===signature&&manifest.complete&&stat?.size===manifest.output?.size&&stat?.mtimeMs===manifest.output?.mtimeMs){console.log(`[SKIP] completed ${OUT}`);}
    else{
      if(manifest?.signature!==signature){clearFrames();fs.rmSync(audio,{force:true});manifest={signature,complete:false,lastFrame:-1};persist(manifest);}
      if(!fs.existsSync(audio)){const wav=await page.evaluate(()=>window.audioWav());const temporary=audio+'.tmp';fs.writeFileSync(temporary,Buffer.from(wav,'base64'));fs.renameSync(temporary,audio);console.log('[SAVE] audio');}
      fs.mkdirSync(path.dirname(output),{recursive:true});
      const ffmpeg=process.env.PERRY_FFMPEG_PATH||'ffmpeg';
      if(flag('--audio')){
        encoder=spawn(ffmpeg,['-y','-loglevel','error','-i',output,'-i',audio,'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','320k','-shortest','-movflags','+faststart',temporaryVideo],{stdio:'inherit',windowsHide:true});
        await completed(encoder);
      }else{
        encoder=spawn(ffmpeg,['-y','-loglevel','error','-f','image2pipe','-framerate',String(FPS),'-i','-','-i',audio,'-c:v','libx264','-preset','slow','-crf','14','-pix_fmt','yuv420p','-tune','animation','-c:a','aac','-b:a','320k','-shortest','-movflags','+faststart',temporaryVideo],{stdio:['pipe','inherit','inherit'],windowsHide:true});
        const stop=new AbortController();const finished=completed(encoder).catch(error=>{stop.abort();throw error;});
        const total=Math.ceil(FPS*DUR);fs.mkdirSync(framesDir,{recursive:true});
        async function*frames(){for(let f=0;f<total;f++){
          stop.signal.throwIfAborted();const file=path.join(framesDir,`${f}.png`);
          if(!fs.existsSync(file)){const url=await page.evaluate((t,s)=>window.frameDataURL(t,s),f/FPS,SUB);const temporary=file+'.tmp';fs.writeFileSync(temporary,Buffer.from(url.split(',')[1],'base64'));fs.renameSync(temporary,file);manifest.lastFrame=f;persist(manifest);}
          if(f%60===0)console.log(`[SAVE] frame ${f+1}/${total}`);
          yield fs.readFileSync(file);
        }}
        await Promise.all([finished,pipeline(Readable.from(frames()),encoder.stdin,{signal:stop.signal})]);
      }
      if(pageFailure)throw pageFailure;
      fs.renameSync(temporaryVideo,output);fs.copyFileSync(audio,audioOutput);
      const saved=fs.statSync(output);manifest.complete=true;manifest.output={size:saved.size,mtimeMs:saved.mtimeMs};persist(manifest);
      clearFrames();fs.rmSync(audio,{force:true});console.log(`[OK] ${OUT}`);
    }
  }
}finally{
  if(encoder&&encoder.exitCode===null)encoder.kill();
  fs.rmSync(temporaryVideo,{force:true});
  try { await browser?.close(); }
  finally { await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}); }
}
