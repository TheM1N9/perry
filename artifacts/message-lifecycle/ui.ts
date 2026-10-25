import { readFileSync, writeFileSync } from "node:fs";
import { openChat, sleep } from "../browser";

// The stopped Runtime/SQLite production fixture from artifacts/batch-1/README.md.
const fixture = JSON.parse(readFileSync(".batch-work/batch-1/coordinator/ui/fixture.json", "utf8"));
const base = "http://127.0.0.1:17483";
const key = "batch-ui-synthetic";
const browser = await openChat(base, key);
const { evaluate, send } = browser;
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
function check(name: string, ok: boolean) { checks[name] = ok; if (!ok) throw new Error(name); }
const call = async (path: string, args: object) => {
  const response = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(body.error);
  return body.value;
};
const type = (text: string) => evaluate(`(() => { const box = document.querySelector('#composer'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)}); box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const screenshot = async (name: string) => writeFileSync(`artifacts/message-lifecycle/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
try {
  await send("Page.navigate", { url: fixture.url });
  await sleep(1500);
  await type("Keep this draft while I stop");
  await sleep(150);
  check("Stop stays available with a typed draft", await evaluate(`Boolean(document.querySelector('button[aria-label="Stop the reply"]'))`));
  check("explicit Queue is available", await evaluate(`Boolean(document.querySelector('button[aria-label="Queue message after the reply"]'))`));
  await screenshot("desktop-controls");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(200);
  evidence.mobile = await evaluate(`({ width: innerWidth, scroll: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('[data-composer] button')].filter(b => /Stop|Queue|Send/.test(b.getAttribute('aria-label') || '')).map(b => ({label:b.getAttribute('aria-label'),rect:{x:b.getBoundingClientRect().x,right:b.getBoundingClientRect().right,width:b.getBoundingClientRect().width}})) })`);
  check("mobile controls fit the viewport", (evidence.mobile as any).scroll <= 390 && (evidence.mobile as any).buttons.every((b: any) => b.rect.x >= 0 && b.rect.right <= 390));
  await screenshot("mobile-controls");
  await evaluate(`document.querySelector('button[aria-label="Queue message after the reply"]').click()`);
  await sleep(400);
  const page = await call("dashboard:getChatMessages", { key, id: fixture.conversationId, paginationOpts: { cursor: null, numItems: 30 } });
  const queued = page.page.find((m: any) => m.text === "Keep this draft while I stop");
  check("Queue creates a durable removable message", Boolean(queued?.queued?.id));
  const reservation = await call("codex:preparation", { id: queued.queued.id });
  check("Queue records separate-turn intent", reservation?.preparing === true && !reservation.steerTarget);
  await type("Draft survives Stop");
  await sleep(100);
  await evaluate(`document.querySelector('button[aria-label="Stop the reply"]').click()`);
  await sleep(300);
  check("Stop preserves the unsent draft", await evaluate(`document.querySelector('#composer').value === 'Draft survives Stop'`));
  const original = await call("codex:getTurn", { id: fixture.turnId });
  const stoppedQueue = await call("codex:getTurn", { id: queued.queued.id });
  check("Stop requests interruption of the active turn", original.job.stopRequested === true);
  check("Stop cancels queued preparation", stoppedQueue.job.status === "done" && stoppedQueue.job.stopped === true);
  const other = await call("codex:getTurn", { id: fixture.taskTurn });
  check("Stop leaves the other chat running", other.job.status === "running" && !other.job.stopRequested);
  await screenshot("stopped-draft");
  const uploadChat = await call("dashboard:createChat", { key });
  await send("Page.navigate", { url: `${base}/chat/${uploadChat}` });
  await sleep(800);
  await type("Unsent media message");
  await evaluate(`(() => {
    const realFetch = window.fetch;
    window.__uploadStarted = false;
    window.fetch = (input, options) => {
      if (input === '/api/media') {
        window.__uploadStarted = true;
        return new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once:true});
        });
      }
      return realFetch(input, options);
    };
    const files = new DataTransfer(); files.items.add(new File(['fixture bytes'], 'fixture.txt', {type:'text/plain'}));
    const picker = document.querySelector('input[type=file]'); picker.files = files.files; picker.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await sleep(100);
  await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
  await sleep(200);
  check("Stop is available during a media upload", await evaluate(`window.__uploadStarted && Boolean(document.querySelector('button[aria-label="Stop the reply"]'))`));
  await type("Newer draft");
  await sleep(100);
  await evaluate(`document.querySelector('button[aria-label="Stop the reply"]').click()`);
  await sleep(300);
  check("cancelled upload restores media and preserves newer typing", await evaluate(`document.querySelector('#composer').value === 'Unsent media message\\n\\nNewer draft' && document.body.innerText.includes('fixture.txt')`));
  const unsent = await call("dashboard:getChatMessages", { key, id: uploadChat, paginationOpts: { cursor: null, numItems: 30 } });
  check("stopped media upload cannot submit afterwards", unsent.page.length === 0);
  await screenshot("cancelled-upload");
  await evaluate(`localStorage.setItem('perry.pet.chat', ${JSON.stringify(fixture.taskChat)})`);
  await send("Page.navigate", { url: `${base}/pet` });
  await sleep(700);
  const petButton = await evaluate(`(() => { const r=document.querySelector('button[aria-label^="Perry. Click to open him"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...petButton, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...petButton, button: "left", clickCount: 1 });
  await evaluate(`new Promise((resolve, reject) => {
    const started = Date.now(); const tick = () => document.querySelector('textarea[aria-label="Message Perry"]') ? resolve(true) : Date.now() - started > 5000 ? reject(new Error('Pet input did not open: ' + document.body.innerText)) : setTimeout(tick, 100); tick();
  })`);
  await evaluate(`(() => {
    const box = document.querySelector('textarea[aria-label="Message Perry"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Pet draft survives rejection');
    box.dispatchEvent(new Event('input', {bubbles:true}));
    window.__petSendCalls = 0;
    const realFetch = window.fetch;
    window.fetch = (input, options) => {
      if (input === '/api/backend/call' && JSON.parse(options.body || '{}').path === 'dashboard:sendChat') {
        window.__petSendCalls++;
        return Promise.resolve(new Response(JSON.stringify({error:'Fixture send rejected'}), {status:500,headers:{'content-type':'application/json'}}));
      }
      return realFetch(input, options);
    };
  })()`);
  await sleep(100);
  check("pet keeps Stop available with a draft", await evaluate(`Boolean(document.querySelector('button[aria-label="Stop"]'))`));
  await evaluate(`(() => { const send = document.querySelector('button[aria-label="Send"]'); send.click(); send.click(); })()`);
  await sleep(300);
  check("pet prevents duplicate submissions", await evaluate(`window.__petSendCalls === 1`));
  check("pet retains rejected message", await evaluate(`document.querySelector('textarea[aria-label="Message Perry"]').value === 'Pet draft survives rejection' && document.body.innerText.includes('Fixture send rejected')`));
  await screenshot("pet-rejected-draft");
  check("no browser exceptions", browser.errors.length === 0);
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  writeFileSync("artifacts/message-lifecycle/ui-result.json", JSON.stringify({ passed: !evidence.error && Object.values(checks).every(Boolean), checks, evidence, errors: browser.errors }, null, 2) + "\n");
  console.log(JSON.stringify({ checks, evidence, errors: browser.errors }, null, 2));
  browser.close();
}
