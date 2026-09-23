import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , outDir, dashboardKey] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${join(tmpdir(), "composer-e2e-profile")}`,
  "--window-size=1280,800", "--autoplay-policy=no-user-gesture-required", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch("http://127.0.0.1:9333/json/list")).json(); if (targets.some((t) => t.type === "page")) break; } catch {}
  await sleep(200);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const waiting = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  waiting.set(id, (msg) => msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const errors = [];
await send("Runtime.enable");
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
});
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

await send("Page.navigate", { url: base });
await sleep(1500);
await evaluate(`localStorage.setItem("perry.dashboard.key", ${JSON.stringify(dashboardKey)}); localStorage.removeItem("perry.activeChat"); true`);
await send("Page.navigate", { url: `${base}/chat` });
await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => document.querySelector('input[type=file]') ? resolve(true) : Date.now() - start > 30000 ? reject(new Error('composer never rendered')) : setTimeout(tick, 200); tick(); })`);

await sleep(4000);
await evaluate(`new Promise((resolve) => { const tick = () => document.body.innerText.includes('Loading chats') ? setTimeout(tick, 200) : resolve(true); tick(); })`);

// A draft chat: the picker's choice stays in the browser and nothing is sent or saved.
await evaluate(`document.querySelector('.chat-header-new').click(); true`);
const before = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const select = document.querySelector('select.chat-model');
    const groups = select ? [...select.querySelectorAll('optgroup')] : [];
    const gateway = groups.find((group) => group.label === 'AI Gateway');
    if (gateway && gateway.children.length > 1) return resolve({
      selected: select.value,
      title: select.title,
      insidePromptBox: !!select.closest('.chat-composer-box'),
      groups: groups.map((group) => ({ label: group.label, count: group.children.length, first: [...group.children].slice(0, 3).map((option) => ({ value: option.value, text: option.textContent })) })),
    });
    if (Date.now() - start > 30000) return reject(new Error('gateway models never loaded'));
    setTimeout(tick, 250);
  };
  tick();
})`);

const target = await evaluate(`(() => {
  const option = [...document.querySelectorAll('select.chat-model optgroup[label="AI Gateway"] option')].find((item) => item.value.startsWith('gateway:openai/')) ?? document.querySelector('select.chat-model optgroup[label="AI Gateway"] option:last-child');
  return option.value;
})()`);
const after = await evaluate(`(async () => {
  const select = document.querySelector('select.chat-model');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(target)});
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { selected: select.value, title: select.title, draft: !location.pathname.startsWith('/chat/') };
})()`);

const composer = await evaluate(`(() => { const r = document.querySelector('.chat-composer-wrap').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: composer.x - 16, y: composer.y - 16, width: composer.width + 32, height: composer.height + 32, scale: 1 } });
writeFileSync(join(outDir, "composer-model-picker.png"), Buffer.from(shot.data, "base64"));

const codex = before.groups.find((group) => group.label === "Codex subscription");
const gateway = before.groups.find((group) => group.label === "AI Gateway");
const pass = before.insidePromptBox && Boolean(codex) && codex.count >= 1 && Boolean(gateway) && gateway.count > 1
  && before.selected.startsWith("codex:") && after.selected === target && after.title.startsWith("AI Gateway") && after.draft
  && errors.length === 0;
const result = { ranAt: new Date().toISOString(), url: `${base}/chat`, before, picked: target, after, pageErrors: errors, nothingSent: true, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
ws.close(); chrome.kill();
process.exit(pass ? 0 : 1);
