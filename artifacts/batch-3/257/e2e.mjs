import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const scratch = path.resolve('.batch-work/batch-3/257');
fs.mkdirSync(scratch, {recursive:true});
process.env.TEMP = process.env.TMP = scratch;
process.env.PERRY_HOME = path.join(scratch, 'synthetic-home');
process.env.PERRY_KEY = 'synthetic-voice-e2e';
const source = fs.readFileSync('components/pet/voice.tsx', 'utf8');
const compiled = ts.transpileModule(source, { fileName: 'voice.tsx', reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
assert.equal(compiled.diagnostics.length, 0);
const tick = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function harness(options={}) {
  const config = { amplitude: .08, decodedAmplitude: .08, duration: 1, ...options };
  let slots=[], cursor=0, effects=[], updates=0, mounted=true, now=0, nextId=1, progress;
  const timers=new Map(), frames=new Map(), streams=[], contexts=[], recorders=[], calls=[], automatic=[];
  const depsSame=(a,b)=>a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  const react={
    useState(initial) { const i=cursor++; if(!slots[i]) slots[i]={value:typeof initial==='function'?initial():initial}; return [slots[i].value, value=>{updates++;slots[i].value=typeof value==='function'?value(slots[i].value):value;}]; },
    useRef(value) { const i=cursor++; return slots[i]??=( {current:value} ); },
    useCallback(fn,deps) { const i=cursor++;if(!slots[i]||!depsSame(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn; },
    useEffect(fn,deps) { const i=cursor++; if(!slots[i]||!depsSame(slots[i].deps,deps)){const previous=slots[i];slots[i]={deps};effects.push(()=>{previous?.cleanup?.(); slots[i].cleanup=fn();});} },
    useEffectEvent(fn) {const i=cursor++; if(!slots[i]){const slot=slots[i]={fn};slot.call=(...args)=>slot.fn(...args);}slots[i].fn=fn;return slots[i].call;},
  };
  const stream=()=>{ const track={stops:0,stop(){this.stops++;}}; const value={track,getTracks:()=>[track]}; streams.push(value);return value; };
  class Context {
    constructor(opts){if(config.constructorError)throw Error('context constructor');this.decoder=!!opts;this.state=config.suspended?'suspended':'running';this.sampleRate=opts?.sampleRate??48000;this.closes=0;contexts.push(this);}
    async resume(){if(config.resumeError)throw Error('resume failed');if(config.resumeDeferred)await config.resumeDeferred.promise;this.state='running';}
    close(){this.closes++;this.state='closed';return Promise.resolve();}
    createAnalyser(){if(config.analyserError)throw Error('analyser failed');return {fftSize:2048,frequencyBinCount:1024,getFloatTimeDomainData(wave){for(let i=0;i<wave.length;i++)wave[i]=config.dc??config.amplitude*Math.sin(i*.14);},getByteFrequencyData(bins){for(let i=0;i<bins.length;i++)bins[i]=(i%100)*2;}};}
    createMediaStreamSource(){if(config.sourceError)throw Error('source failed');return {connect(){}};}
    async decodeAudioData(){if(config.decodeError)throw Error('decode failed');if(config.decodeDeferred)await config.decodeDeferred.promise;const length=Math.floor(config.duration*16000);return {length,numberOfChannels:config.channels??1,getChannelData(channel){const data=new Float32Array(length);for(let i=0;i<length;i++)data[i]=config.decodedDc??config.decodedAmplitude*Math.sin(i*.17)*(channel===1&&config.oppositeStereo?-1:1);if(config.nonfinite)data[0]=NaN;return data;}};}
  }
  class Recorder {
    constructor(){if(config.recorderError)throw Error('recorder constructor');this.state='inactive';this.mimeType='audio/fake';this.stops=0;recorders.push(this);}
    start(){if(config.startError)throw Error('start failed');this.state='recording';}
    stop(){this.stops++;if(config.stopError)throw Error('stop failed');this.state='inactive';queueMicrotask(()=>{if(!config.emptyChunks)this.ondataavailable?.({data:new Blob(['synthetic'])});this.onstop?.();});}
  }
  const bridge={onVoiceProgress(fn){progress=fn;return()=>{progress=undefined;};},voiceDone(){calls.push({kind:'done'});},async transcribe(samples){calls.push({kind:'transcribe',length:samples.length});if(config.transcribeDeferred)return config.transcribeDeferred.promise;if(config.transcribeError)throw Error('bridge failed');return config.result??{text:'synthetic words'};}};
  const exports={};
  const sandbox={exports,require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return {jsx:()=>null,jsxs:()=>null};if(['lucide-react','@/lib/utils','@/components/ui/button','@/components/ui/progress','./tip'].includes(name))return {};throw Error('Blocked import: '+name);},navigator:{mediaDevices:{async getUserMedia(){if(config.permissionError)throw new DOMException('denied','NotAllowedError');if(config.openDeferred)return config.openDeferred.promise;return stream();}}},AudioContext:Context,MediaRecorder:Recorder,Blob,DOMException,Float32Array,Uint8Array,performance:{now:()=>now},fetch(){throw Error('Network blocked');},window:{setInterval(fn,ms){const id=nextId++;timers.set(id,{fn,ms,repeat:true});return id;},clearInterval(id){timers.delete(id);},setTimeout(fn,ms){const id=nextId++;timers.set(id,{fn,ms,repeat:false});return id;},clearTimeout(id){timers.delete(id);},requestAnimationFrame(fn){const id=nextId++;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);}}};
  vm.runInNewContext(compiled.outputText,sandbox,{filename:'voice-compiled.cjs'});
  let voice;
  const render=()=>{cursor=0;voice=exports.useVoice(config.noBridge?undefined:bridge,promise=>automatic.push(promise));const pending=effects;effects=[];pending.forEach(fn=>fn());return voice;};
  render();
  const fire=(ms)=>{for(const [id,timer]of [...timers])if(timer.ms===ms){if(!timer.repeat)timers.delete(id);timer.fn();}};
  const unmount=()=>{mounted=false;slots.forEach(slot=>slot?.cleanup?.());};
  const clean=()=>{assert.equal(timers.size,0,'timers leaked');assert.equal(frames.size,0,'animation leaked');streams.forEach(s=>assert.ok(s.track.stops>0,'track leaked'));contexts.forEach(c=>assert.equal(c.closes,1,'context leaked/double closed'));};
  return {config,render,get voice(){return voice;},get updates(){return updates;},streams,contexts,recorders,calls,automatic,timers,frames,stream,fire,unmount,clean,progress:(p)=>progress?.(p),get subscribed(){return !!progress;},frame(){const batch=[...frames];frames.clear();batch.forEach(([,fn])=>fn());},setNow(value){now=value;},async finish(){await tick();render();},mounted};
}
const results=[];
async function scenario(name,run){await run();results.push({name,passed:true});}
await scenario('silent, muted, below-floor, DC audio rejected without decode or transcription',async()=>{
  for(const config of [{amplitude:0},{amplitude:.001},{dc:.1}]){const h=harness(config);assert.equal(await h.voice.start(),true);h.render();assert.equal(await h.voice.stop(),'');h.render();assert.match(h.voice.error,/didn't hear anything/);assert.equal(h.calls.length,0);assert.equal(h.contexts.length,1);h.unmount();h.clean();}
});
await scenario('valid recording resamples, transcribes and cleans resources',async()=>{const h=harness({channels:3});await h.voice.start();h.render();assert.equal(h.voice.state,'listening');assert.equal(await h.voice.stop(),'synthetic words');h.render();assert.equal(h.voice.state,'idle');assert.equal(h.calls.filter(x=>x.kind==='transcribe').length,1);h.unmount();h.clean();});
await scenario('waveform draws different FFT bands with zero meter-driven React state writes',async()=>{const h=harness();await h.voice.start();h.render();const bars=Array.from({length:28},()=>({style:{}}));h.voice.waveform.current={children:bars};const before=h.updates;for(let i=0;i<24;i++){h.fire(80);h.frame();}assert.equal(h.updates,before);assert.ok(new Set(bars.map(b=>b.style.transform)).size>10);h.voice.cancel();h.unmount();h.clean();});
await scenario('five-minute limit delivers one completion and immediately resets hotkey',async()=>{const h=harness();await h.voice.start();h.render();h.fire(300000);assert.equal(h.calls[0].kind,'done');assert.equal(h.automatic.length,1);assert.equal(await h.automatic[0],'synthetic words');h.fire(300000);assert.equal(h.automatic.length,1);assert.equal(h.recorders[0].stops,1);h.render();assert.match(h.voice.error,/five-minute/);h.unmount();h.clean();});
await scenario('background media-event duration backstop and decoded sample ceiling',async()=>{const h=harness({duration:301});await h.voice.start();h.render();h.setNow(300001);h.recorders[0].ondataavailable({data:new Blob(['slice'])});assert.equal(await h.automatic[0],'synthetic words');assert.equal(h.calls.find(x=>x.kind==='transcribe').length,4800000);h.unmount();h.clean();});
await scenario('short taps and decoded silence/DC/stereo cancellation are dropped',async()=>{for(const config of [{duration:.2},{decodedAmplitude:0},{decodedDc:.1},{channels:2,oppositeStereo:true}]){const h=harness(config);await h.voice.start();assert.equal(await h.voice.stop(),'');assert.equal(h.calls.length,0);h.unmount();h.clean();}});
await scenario('permission, recorder, analyser, source, resume and start failures release partial resources',async()=>{for(const config of [{permissionError:true},{constructorError:true},{recorderError:true},{analyserError:true},{sourceError:true},{suspended:true,resumeError:true},{startError:true}]){const h=harness(config);assert.equal(await h.voice.start(),false);h.render();assert.ok(h.voice.error);h.unmount();h.clean();}});
await scenario('cancel and unmount while permission pending release late streams',async()=>{for(const unmount of [false,true]){const openDeferred=deferred(),h=harness({openDeferred});const opening=h.voice.start();if(unmount)h.unmount();else h.voice.cancel();const updates=h.updates;openDeferred.resolve(h.stream());assert.equal(await opening,false);await tick();if(unmount)assert.equal(h.updates,updates);else h.unmount();h.clean();}});
await scenario('cancel while AudioContext resumes releases late context',async()=>{const resumeDeferred=deferred(),h=harness({suspended:true,resumeDeferred});const opening=h.voice.start();await tick();h.voice.cancel();assert.equal(h.contexts[0].closes,1,'suspended context not closed immediately');assert.equal(h.streams[0].track.stops,1,'pending track not closed immediately');resumeDeferred.resolve();assert.equal(await opening,false);h.unmount();h.clean();});
await scenario('rapid cancel/start does not attach stale stream or stop the new recording',async()=>{const openDeferred=deferred(),h=harness({openDeferred});const first=h.voice.start();const oldStop=h.voice.stop();h.voice.cancel();h.config.openDeferred=undefined;assert.equal(await h.voice.start(),true);openDeferred.resolve(h.stream());assert.equal(await first,false);assert.equal(await oldStop,'');h.render();assert.equal(h.voice.state,'listening');h.voice.cancel();h.unmount();h.clean();});
await scenario('duplicate start and stop during opening claim recording once',async()=>{const openDeferred=deferred(),h=harness({openDeferred});const first=h.voice.start();assert.equal(h.voice.start(),first);const a=h.voice.stop(),b=h.voice.stop();openDeferred.resolve(h.stream());assert.equal(await first,true);const texts=await Promise.all([a,b]);assert.equal(texts.filter(Boolean).length,1);assert.equal(h.calls.filter(x=>x.kind==='transcribe').length,1);h.unmount();h.clean();});
await scenario('cancel and unmount during decoding suppress bridge calls and late state',async()=>{for(const unmount of [false,true]){const decodeDeferred=deferred(),h=harness({decodeDeferred});await h.voice.start();const stopped=h.voice.stop();await tick();assert.equal(h.contexts.length,2);if(unmount)h.unmount();else h.voice.cancel();const updates=h.updates;decodeDeferred.resolve();assert.equal(await stopped,'');assert.equal(h.calls.length,0);if(unmount)assert.equal(h.updates,updates);else h.unmount();h.clean();}});
await scenario('cancel and unmount during transcription suppress late text and state',async()=>{for(const unmount of [false,true]){const transcribeDeferred=deferred(),h=harness({transcribeDeferred});await h.voice.start();const stopped=h.voice.stop();await tick();assert.equal(h.calls.length,1);assert.equal(h.contexts[1].closes,1,'decoder retained during transcription');if(unmount)h.unmount();else h.voice.cancel();const updates=h.updates;transcribeDeferred.resolve({text:'stale words'});assert.equal(await stopped,'');if(unmount)assert.equal(h.updates,updates);else h.unmount();h.clean();}});
await scenario('overlapping recording and transcription keep independent resources/state',async()=>{const transcribeDeferred=deferred(),h=harness({transcribeDeferred});await h.voice.start();const stopped=h.voice.stop();await tick();assert.equal(await h.voice.start(),true);transcribeDeferred.resolve({text:'first words'});assert.equal(await stopped,'first words');h.render();assert.equal(h.voice.state,'listening');assert.equal(h.contexts[2].closes,0);h.voice.cancel();h.unmount();h.clean();});
await scenario('decode, bridge and recorder failures show feedback and close all contexts',async()=>{for(const config of [{decodeError:true},{transcribeError:true},{result:{error:'fake error'}},{result:{text:''}},{nonfinite:true},{stopError:true}]){const h=harness(config);await h.voice.start();assert.equal(await h.voice.stop(),'');h.render();assert.ok(h.voice.error);h.unmount();h.clean();}});
await scenario('native unexpected stop/error completes once with useful feedback',async()=>{for(const error of [false,true]){const h=harness();await h.voice.start();h.render();if(error)h.recorders[0].onerror();else h.recorders[0].stop();await tick();assert.equal(h.automatic.length,1);await h.automatic[0];assert.equal(h.calls.filter(x=>x.kind==='done').length,1);h.unmount();h.clean();}});
await scenario('cancel tolerates stop throwing and cleanup unsubscribes progress',async()=>{const h=harness({stopError:true});await h.voice.start();assert.equal(h.subscribed,true);h.voice.cancel();h.unmount();assert.equal(h.subscribed,false);h.clean();});
await scenario('cancel before final recorder event suppresses transcription',async()=>{const h=harness();await h.voice.start();const stopped=h.voice.stop();h.voice.cancel();assert.equal(await stopped,'');assert.equal(h.calls.length,0);h.unmount();h.clean();});
await scenario('absent bridge and empty chunks release hardware without transcription',async()=>{for(const config of [{noBridge:true},{emptyChunks:true}]){const h=harness(config);await h.voice.start();assert.equal(await h.voice.stop(),'');assert.equal(h.calls.length,0);h.unmount();h.clean();}});
await scenario('idle progress is ignored and unmounted hook cannot reopen media',async()=>{const h=harness();const updates=h.updates;h.progress({file:'fake',loaded:1,total:10});assert.equal(h.updates,updates);h.unmount();assert.equal(await h.voice.start(),false);assert.equal(h.streams.length,0);h.clean();});
const evidence={suite:'voice hook fake-media lifecycle E2E',source:'components/pet/voice.tsx',network:'blocked in VM; no project bootstrap or real media/model calls',scenarios:results.length,results,limitations:['Synthetic React dispatcher, not browser React profiler','Native codec, Electron bridge and actual microphone behavior unrun','Consumer integration.patch not applied; coordinator acceptance required']};
fs.writeFileSync(path.join(scratch,'e2e-result.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({passed:results.length,artifact:path.join(scratch,'e2e-result.json')}));
