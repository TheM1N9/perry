import type { Definition } from "./interactive";

/** Generated JavaScript computes markup in a disposable worker; it never runs in the DOM. */
export function sandboxDocument(view: Extract<Definition["view"], { kind: "sandbox" }>, identity: { id: string; revision: number; nonce: string }, hostOrigin: string): string {
  const data = JSON.stringify({ view, identity, hostOrigin }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${identity.nonce}'; style-src 'unsafe-inline'; worker-src blob:; connect-src 'none'; img-src data:; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.5 system-ui;margin:0;padding:12px;color:var(--foreground,#1d1d1f);background:transparent}#output{display:flow-root}*{box-sizing:border-box;max-width:100%}button,input,select{font:inherit}button:focus-visible,input:focus-visible,select:focus-visible{outline-color:var(--ring,currentColor)}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body><main id="output" aria-live="polite"></main><script nonce="${identity.nonce}">
  const {view,identity,hostOrigin}=${data};
  const output=document.getElementById('output');
  const style=document.createElement('style');style.textContent=view.css;document.head.append(style);
  let worker, timer, url, resizeTimer, lastHeight, rendered=false;
  function stop(){if(worker)worker.terminate();clearTimeout(timer);if(url)URL.revokeObjectURL(url);}
  function send(type){parent.postMessage({...identity,type},hostOrigin);}
  function resize(){if(!rendered)return;const styles=getComputedStyle(document.body);const height=Math.ceil(output.getBoundingClientRect().height+parseFloat(styles.paddingTop)+parseFloat(styles.paddingBottom));if(height!==lastHeight){lastHeight=height;parent.postMessage({...identity,type:'perry:resize',height},hostOrigin);}}
  const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,80);});observer.observe(output);
  function show(html){
    const template=document.createElement('template');template.innerHTML=html;
    template.content.querySelectorAll('script,iframe,frame,object,embed,link,meta,base,form,audio,video,a,animate,animateMotion,animateTransform,set,foreignObject').forEach(el=>el.remove());
    template.content.querySelectorAll('*').forEach(el=>{for(const attr of [...el.attributes])if(/^on/i.test(attr.name)||['href','src','srcset','action','formaction','target','download','nonce','http-equiv','xlink:href'].includes(attr.name.toLowerCase()))el.removeAttribute(attr.name);});
    output.replaceChildren(template.content);rendered=true;resize();send('perry:ready');
  }
  function receive(event){
    const m=event.data;
    if(event.source!==parent||event.origin!==hostOrigin||!m||m.type!=='perry:state'||m.id!==identity.id||m.revision!==identity.revision||m.nonce!==identity.nonce)return;
    if(m.theme&&typeof m.theme==='object')for(const [name,value] of Object.entries(m.theme))if(/^--[a-z0-9-]+$/.test(name)&&typeof value==='string')document.documentElement.style.setProperty(name,value);
    if(m.colorScheme==='light'||m.colorScheme==='dark')document.documentElement.style.colorScheme=m.colorScheme;
    stop();
    if(!view.js.trim()){show(view.html);return;}
    const source=view.js+'\\n;self.onmessage=({data})=>{try{const result=render(data);self.postMessage({html:result});}catch{self.postMessage({error:true});}};';
    url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    try{worker=new Worker(url);}catch{send('perry:error');return;}
    timer=setTimeout(()=>{stop();send('perry:error');},1000);
    worker.onerror=()=>{stop();send('perry:error');};
    worker.onmessage=event=>{const value=event.data;stop();if(value&&typeof value.html==='string'&&value.html.length<=30000)show(value.html);else send('perry:error');};
    worker.postMessage(m.values);
  }
  window.addEventListener('message',receive);
  // Only declared controls are understood by the host; generated code has no prompt/tool bridge.
  function change(event){const el=event.target;if(!(el instanceof HTMLInputElement||el instanceof HTMLSelectElement))return;const input=el.dataset.perryInput;if(!input)return;const value=el.type==='checkbox'?el.checked:el.type==='number'||el.type==='range'?Number(el.value):el.value;parent.postMessage({...identity,type:'perry:input',input,value},hostOrigin);}
  document.addEventListener('change',change);
  window.addEventListener('pagehide',()=>{stop();clearTimeout(resizeTimer);observer.disconnect();window.removeEventListener('message',receive);document.removeEventListener('change',change);},{once:true});
  send('perry:mounted');
  </script></body></html>`;
}
