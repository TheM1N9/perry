import type { Definition } from "./interactive";

/** Generated JavaScript computes markup in a disposable worker; it never runs in the DOM. */
export function sandboxDocument(view: Extract<Definition["view"], { kind: "sandbox" }>, identity: { id: string; revision: number; nonce: string }, hostOrigin: string): string {
  const data = JSON.stringify({ view, identity, hostOrigin }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${identity.nonce}'; style-src 'unsafe-inline'; worker-src blob:; connect-src 'none'; img-src data:; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>body{font:16px system-ui;margin:12px;color:#172033}*{box-sizing:border-box;max-width:100%}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body><main id="output" aria-live="polite"></main><script nonce="${identity.nonce}">
  const {view,identity,hostOrigin}=${data};
  const output=document.getElementById('output');
  const style=document.createElement('style');style.textContent=view.css;document.head.append(style);
  let worker, timer, url;
  function stop(){if(worker)worker.terminate();clearTimeout(timer);if(url)URL.revokeObjectURL(url);}
  function send(type){parent.postMessage({...identity,type},hostOrigin);}
  function show(html){
    const template=document.createElement('template');template.innerHTML=html;
    template.content.querySelectorAll('script,iframe,frame,object,embed,link,meta,base,form,audio,video,a,animate,animateMotion,animateTransform,set,foreignObject').forEach(el=>el.remove());
    template.content.querySelectorAll('*').forEach(el=>{for(const attr of [...el.attributes])if(/^on/i.test(attr.name)||['href','src','srcset','action','formaction','target','download','nonce','http-equiv','xlink:href'].includes(attr.name.toLowerCase()))el.removeAttribute(attr.name);});
    output.replaceChildren(template.content);send('perry:ready');
  }
  window.addEventListener('message',event=>{
    const m=event.data;
    if(event.source!==parent||event.origin!==hostOrigin||!m||m.type!=='perry:state'||m.id!==identity.id||m.revision!==identity.revision||m.nonce!==identity.nonce)return;
    stop();
    if(!view.js.trim()){show(view.html);return;}
    const source=view.js+'\\n;self.onmessage=({data})=>{try{const result=render(data);self.postMessage({html:result});}catch{self.postMessage({error:true});}};';
    url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    try{worker=new Worker(url);}catch{send('perry:error');return;}
    timer=setTimeout(()=>{stop();send('perry:error');},1000);
    worker.onerror=()=>{stop();send('perry:error');};
    worker.onmessage=event=>{const value=event.data;stop();if(value&&typeof value.html==='string'&&value.html.length<=30000)show(value.html);else send('perry:error');};
    worker.postMessage(m.values);
  });
  // Only declared controls are understood by the host; generated code has no prompt/tool bridge.
  document.addEventListener('change',event=>{const el=event.target;if(!(el instanceof HTMLInputElement||el instanceof HTMLSelectElement))return;const input=el.dataset.perryInput;if(!input)return;const value=el.type==='checkbox'?el.checked:el.type==='number'||el.type==='range'?Number(el.value):el.value;parent.postMessage({...identity,type:'perry:input',input,value},hostOrigin);});
  send('perry:mounted');
  </script></body></html>`;
}
