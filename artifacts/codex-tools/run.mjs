import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , outDir, dashboardKey, runnerToken] = process.argv;
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

// The chat binds to the most recently seen Codex runner, so check the test runner in right before sending.
const { ConvexHttpClient } = await import("convex/browser");
const { makeFunctionReference } = await import("convex/server");
const convex = new ConvexHttpClient(process.env.CONVEX_URL);
const checkIn = () => convex.mutation(makeFunctionReference("runner:checkIn"), { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
const picker = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const options = [...document.querySelectorAll('select.chat-model optgroup[label="Codex subscription"] option')];
    if (options.length > 1) return resolve(options.map((option) => ({ value: option.value, text: option.textContent })));
    if (Date.now() - start > 30000) return reject(new Error('Codex models never listed'));
    setTimeout(tick, 250);
  };
  tick();
})`);
await evaluate(`(() => {
  const select = document.querySelector('select.chat-model');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(picker[0].value)});
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

async function ask(text) {
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const before = await evaluate(`document.querySelectorAll('.chat-turn.from-assistant:not(.pending)').length`);
  await checkIn();
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  return await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
      const error = document.querySelector('.chat-turn-error');
      const thinking = document.querySelector('.chat-thinking');
      if (!thinking && replies.length > ${before}) return resolve({ reply: replies.at(-1).innerText, error: null });
      if (!thinking && error && Date.now() - start > 5000) return resolve({ reply: null, error: error.innerText });
      if (Date.now() - start > 300000) return reject(new Error('no reply within 5 minutes'));
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 3000);
  })`);
}

const first = await ask("This is an automated end-to-end test. Using your assistant tools: 1) call list_connectors and name the connected accounts; 2) call find_action for 'get the current date and time from Google Calendar', then run_action with the matching slug, and report the date it returned; 3) call remember with kind daily and the text 'E2E test note: Codex reached connectors and memory over MCP.' Reply in three short lines.");
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
// A second message in the same chat after a reload resumes the same Codex thread.
await send("Page.reload");
await sleep(5000);
const second = await ask("Reply with the single word OK.");

const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "codex-tools-chat.png"), Buffer.from(full.data, "base64"));
const result = { ranAt: new Date().toISOString(), chatId, codexModels: picker, picked: picker[0].value, first, second, pageErrors: errors };
writeFileSync(join(outDir, "chat.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
ws.close(); chrome.kill();
process.exit(first.reply && second.reply ? 0 : 1);
