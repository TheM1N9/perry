// One bounded fixture embedder, following artifacts/message-lifecycle/run.ts.
// This preload runs before Next bootstrap so warmUp cannot download a model.
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const originalRealpath=fs.realpathSync.native;
const forbidden=process.env.PERRY_SOAK_FORBIDDEN_BUILD;
const snapshotRoot=process.env.PERRY_SOAK_SNAPSHOT_ROOT;
let sourceBuildReads=0,externalWrites=0;
const normalize=path=>resolve(path).toLowerCase();
const inside=(path,root)=>path===root||path.startsWith(root+sep);
const canonical=value=>{
  if(typeof value==='number')return null;
  let path=value instanceof URL?fileURLToPath(value):String(value);
  path=resolve(path);let existing=path,tail=[];
  while(true){try{return normalize(resolve(originalRealpath(existing),...tail));}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;const parent=dirname(existing);if(parent===existing)return normalize(path);tail.unshift(path.slice(parent.length+1));path=existing=parent;}}
};
if(forbidden){
  const blockedRoot=normalize(forbidden),allowed=[process.env.PERRY_SOAK_SCRATCH,process.env.PERRY_SOAK_OUTPUT].map(normalize);
  const guard=(path,write=false)=>{
    const resolved=canonical(path);if(resolved===null)return;
    if(inside(resolved,blockedRoot)){sourceBuildReads++;throw Error('Shared build access forbidden in snapshot soak');}
    if(write&&!allowed.some(root=>inside(resolved,root))){externalWrites++;throw Error('Writes outside owned snapshot/output are forbidden');}
  };
  const writes=new Set(['writeFile','appendFile','mkdir','rm','rmdir','unlink','truncate','chmod','chown','utimes','lutimes']);
  const wrap=(target,name)=>{
    if(typeof target[name]!=='function')return;const original=target[name],base=name.replace(/Sync$/,'');
    const wrapped=function(...args){
      const flags=args[1];const opening=base==='open';
      const writing=opening&&(typeof flags==='number'?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))!==0:/[wa+]/.test(String(flags??'r')));
      guard(args[0],writes.has(base)||writing);
      if(['rename','copyFile','cp','link'].includes(base)){guard(args[1],true);if(['rename','link'].includes(base))guard(args[0],true);}
      if(base==='symlink')guard(args[1],true);
      return Reflect.apply(original,this,args);
    };
    if(original.native)wrapped.native=function(...args){guard(args[0]);return Reflect.apply(original.native,this,args);};
    target[name]=wrapped;
  };
  for(const base of ['readFile','readdir','stat','lstat','realpath','access','exists','watch','open',...writes,'rename','copyFile','cp','link','symlink']){
    wrap(fs,base);wrap(fs,base+'Sync');wrap(fs.promises,base);
  }
  syncBuiltinESMExports();
}
const model=process.env.PERRY_EMBED_MODEL;
if(!model?.startsWith('session-soak-fixture'))throw Error('Expected isolated fixture embedding model');
globalThis.__perryEmbedders=new Map([[model,Promise.resolve(async texts=>texts.map(()=>[1,0]))]]);
globalThis.__perryEmbeddersReady=new Set([model]);
const nativeFetch=globalThis.fetch;
let blocked=0;
globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,'http://127.0.0.1');
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){blocked++;throw Error('External fetch disabled in session soak');}
  return nativeFetch(input,options);
};
const sample=async()=>{
  const runtime=globalThis.__perry?.runtime;
  const state=runtime?await runtime.exclusive(()=>({
    changeListeners:runtime.events.listenerCount('change'),
    runningActions:runtime.running?.size??null,
    pendingTurns:runtime.store.all('codexTurns').filter(row=>['queued','running'].includes(row.status)).length,
    pendingMachines:runtime.store.all('machineRequests').filter(row=>['queued','running'].includes(row.status)).length,
    scheduled:runtime.sql.prepare('SELECT COUNT(*) AS count FROM _scheduled').get().count,
  })):null;
  const resources={};for(const type of process.getActiveResourcesInfo())resources[type]=(resources[type]??0)+1;
  const compiled=Object.keys(require.cache).filter(path=>path.includes(`${sep}.next${sep}server${sep}`));
  if(snapshotRoot&&compiled.some(path=>!inside(normalize(path),normalize(snapshotRoot))))throw Error('A compiled module loaded from outside the snapshot');
  fs.appendFileSync(process.env.PERRY_SOAK_SERVER_METRICS,JSON.stringify({at:Date.now(),pid:process.pid,memory:process.memoryUsage(),resources,state,blockedExternalFetches:blocked,embedders:globalThis.__perryEmbedders?.size,readyEmbedders:globalThis.__perryEmbeddersReady?.size,...(snapshotRoot?{snapshot:{cwd:process.cwd(),distDir:JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG??'{}').distDir,compiledModules:compiled.length,compiledExample:compiled[0],sourceBuildReads,externalWrites}}:{})})+'\n');
};
setInterval(()=>void sample().catch(()=>{}),30000).unref();
