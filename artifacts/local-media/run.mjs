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
await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const option = document.querySelector('select.chat-model optgroup[label="Codex subscription"] option');
    if (option && option.value !== 'codex:') {
      const select = document.querySelector('select.chat-model');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return resolve(option.value);
    }
    if (Date.now() - start > 30000) return reject(new Error('Codex models never listed'));
    setTimeout(tick, 250);
  };
  tick();
})`);

// A picture with an unmistakable answer: a blue square on a yellow background.
await evaluate(`(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffd400'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#0033cc'; g.fillRect(64, 64, 128, 128);
  const png = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const files = new DataTransfer(); files.items.add(new File([png], 'square.png', { type: 'image/png' }));
  const input = document.querySelector('input[type=file]');
  input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test. 1) In one short sentence, say what shape and colours are in the attached image. 2) Generate a small, simple image of a red circle on a white background. 3) Save a text file named hello.txt containing the word hi in your own files folder, and show it in the chat with share_file.");
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// Keep the test runner the freshest Codex runner until the chat is bound to it.
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);
const reply = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending)')];
    const error = document.querySelector('.chat-turn-error');
    const thinking = document.querySelector('.chat-thinking');
    if (!thinking && replies.length > 0) {
      const last = replies.at(-1);
      return resolve({
        text: last.querySelector('.chat-bubble').innerText,
        images: [...last.querySelectorAll('img')].map((img) => ({ src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth })),
        files: [...last.querySelectorAll('a.chat-attachment-file')].map((link) => ({ name: link.innerText, href: link.getAttribute('href') })),
      });
    }
    if (!thinking && error && Date.now() - start > 5000) return resolve({ error: error.innerText });
    const composerError = document.querySelector('.chat-error');
    if (composerError) return resolve({ error: composerError.innerText });
    if (Date.now() - start > 480000) return reject(new Error('no reply within 8 minutes'));
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 3000);
})`);
clearInterval(heartbeat);
await sleep(2000);
const sent = await evaluate(`(() => {
  const turn = [...document.querySelectorAll('.chat-turn.from-user')].at(-1);
  const img = turn?.querySelector('img');
  return img ? { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 } : null;
})()`);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);

// Access rules of the local media server.
const generated = reply.images?.[0]?.src;
const probe = async (path, cookie) => (await fetch(`${base}${path}`, cookie === undefined ? {} : { headers: { cookie: `perry_media=${cookie}` } })).status;
const access = generated ? {
  withKey: await probe(generated, encodeURIComponent(dashboardKey)),
  noCookie: await probe(generated),
  wrongKey: await probe(generated, "wrong-key"),
  unknownId: await probe("/api/media/ks700000000000000000000000000000", encodeURIComponent(dashboardKey)),
  traversal: await probe("/api/media/..%2F..%2F.perry%2Frunner.json", encodeURIComponent(dashboardKey)),
  sharedFile: reply.files?.[0] ? await (await fetch(`${base}${reply.files[0].href}`, { headers: { cookie: `perry_media=${encodeURIComponent(dashboardKey)}` } })).text() : null,
} : null;

const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "local-media-chat.png"), Buffer.from(full.data, "base64"));
const result = { ranAt: new Date().toISOString(), chatId, sentImage: sent, reply, access, pageErrors: errors };
writeFileSync(join(outDir, "chat.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
ws.close(); chrome.kill();
const local = (src) => typeof src === "string" && src.startsWith("/api/media/");
const pass = local(sent?.src) && sent.loaded && local(generated) && reply.images[0].loaded
  && access.withKey === 200 && access.noCookie === 401 && access.wrongKey === 403 && access.unknownId === 404 && access.traversal === 404
  && typeof access.sharedFile === "string" && access.sharedFile.trim().toLowerCase().startsWith("hi");
process.exit(pass ? 0 : 1);
