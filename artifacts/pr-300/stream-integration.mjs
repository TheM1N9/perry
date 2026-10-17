// Actual streamBrowser + native ReadableStream + a bounded in-memory CDP host.
// Read failure-cases.md first. No Chromium, config, credentials or external IO.
import fs from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const repo = resolve(import.meta.dirname, "../..");
const target = pathToFileURL(resolve(repo, "server/browser-stream.ts")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === target && ["../convex/lib/browser", "./browser-host"].includes(specifier)) return { url: `fixture:${specifier.endsWith("browser-host") ? "host" : "browser"}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "fixture:browser") return { format: "module", shortCircuit: true, source: `
      export const browserControl=(scope)=>globalThis.__streamFixture.control(scope);
      export const identity=(scope)=>globalThis.__streamFixture.identity(scope);
      export const withBrowserView=async(scope,run)=>{await Promise.resolve();return run();};
      export const hostWatch=(listener)=>globalThis.__streamFixture.watch(listener);
    ` };
    if (url === "fixture:host") return { format: "module", shortCircuit: true, source: `export const browserStatus=(scope)=>globalThis.__streamFixture.status(scope);` };
    return next(url, context);
  },
});
const { streamBrowser } = await import(target);
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 250 ? 10 : ms, ...args);
const pause = (ms = 35) => new Promise(r => nativeTimeout(r, ms));
const report = { checks: {}, notes: {} };
const check = (name, condition, note) => { report.checks[name] = Boolean(condition); if (note !== undefined) report.notes[name] = note; };
function driver() {
  const d = { listeners:new Set(), starts:0, stops:0, controls:0, revision:1, active:0, maxActive:0, hold:null,
    control() { d.controls++; return {current:{targetId:"tab"},controller:"agent",downloads:new Map()}; },
    identity() { return {sessionId:"fake",tabId:"tab",revision:d.revision}; },
    async status() { if (d.hold) await d.hold; return {identity:d.identity(),state:"live"}; },
    watch(listener) { d.listeners.add(listener); return {tabId:"tab",stop(){d.listeners.delete(listener);},async send(method) {
      if(method === "Page.startScreencast") {d.starts++;d.active++;d.maxActive=Math.max(d.maxActive,d.active);}
      if(method === "Page.stopScreencast") {d.stops++;d.active--;}
    }}; },
    emit(image) { for(const listener of [...d.listeners]) listener("Page.screencastFrame",{sessionId:1,data:image}); },
  }; globalThis.__streamFixture=d; return d;
}
const decode = packet => packet.done ? null : JSON.parse(new TextDecoder().decode(packet.value));
try {
  {
    const d=driver(); const abort=new AbortController();
    const stream=streamBrowser("slow",false,640,abort.signal); await pause();
    for(let i=0;i<600;i++) d.emit(String(i));
    const reader=stream.getReader(); const first=decode(await reader.read()); const second=decode(await reader.read());
    check("slowReaderKeepsLatestFrame", Boolean(first?.state) && second?.frame?.image === "599", {first:first?.frame?.image ?? "state",second:second?.frame?.image});
    abort.abort(); await reader.cancel(); await pause();
    check("lastReaderStopsCast", d.listeners.size===0 && d.active===0, {listeners:d.listeners.size,active:d.active});
  }
  {
    const d=driver(); let release; d.hold=new Promise(r=>{release=r;});
    const stream=streamBrowser("cancel-await",false,640,new AbortController().signal);
    await stream.cancel(); release(); await pause(); const count=d.controls; await pause();
    check("cancelDuringStatusStopsPolling",d.controls===count && d.listeners.size===0,{before:count,after:d.controls});
  }
  {
    const d=driver(); const abort=new AbortController();
    const reader=streamBrowser("identity",false,640,abort.signal).getReader();
    await reader.read(); await pause();
    d.revision=2; d.emit("stale"); await pause(); d.emit("fresh");
    let stale=false,fresh=false;
    for(let i=0;i<3;i++) {
      const packet=await Promise.race([reader.read().then(decode),pause(60).then(()=>null)]);
      if(!packet) break;
      stale ||= packet.frame?.image === "stale";
      fresh ||= packet.frame?.image === "fresh" && packet.frame.identity.revision===2;
      if(fresh) break;
    }
    check("oldFrameNeverGetsNewIdentity",!stale && fresh,{stale,fresh}); abort.abort(); await reader.cancel(); await pause();
  }
  {
    const d=driver(); const one=new AbortController(),two=new AbortController();
    const a=streamBrowser("shared",false,640,one.signal),b=streamBrowser("shared",false,640,two.signal);
    await pause(); check("oneCastForConcurrentReaders",d.maxActive===1,{maxActive:d.maxActive,starts:d.starts});
    one.abort(); await a.cancel(); await pause(); check("oneReaderLeavingKeepsOther",d.listeners.size===1 && d.active===1);
    two.abort(); await b.cancel(); await pause(); check("allReadersLeavingStopSharedCast",d.listeners.size===0 && d.active===0);
  }
  {
    const d=driver(); const abort=new AbortController();abort.abort();
    const reader=streamBrowser("already-aborted",false,640,abort.signal).getReader();
    const result=await Promise.race([reader.read(),pause(60).then(()=>({done:false}))]);
    check("alreadyAbortedCloses",result.done===true && d.listeners.size===0); await reader.cancel();
  }
} finally {
  globalThis.setTimeout=nativeTimeout;
  report.ok=Object.values(report.checks).every(Boolean);
  fs.writeFileSync(new URL("./stream-result.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
  // Bound any pre-fix leaked timer; no native/network resource exists in this driver.
  process.exit(report.ok ? 0 : 1);
}
