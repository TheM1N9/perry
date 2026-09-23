import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

// The chat binds to the most recently seen Codex runner, so check the test runner in right before sending.
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const option = document.querySelector('select.chat-model option');
    if (option && option.value !== '') {
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
const probe = async (path: string, cookie?: string) => (await fetch(`${base}${path}`, cookie === undefined ? {} : { headers: { cookie: `perry_media=${cookie}` } })).status;
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
close();
const local = (src: unknown) => typeof src === "string" && src.startsWith("/api/media/");
const pass = local(sent?.src) && sent.loaded && local(generated) && reply.images[0].loaded && access !== null
  && access.withKey === 200 && access.noCookie === 401 && access.wrongKey === 403 && access.unknownId === 404 && access.traversal === 404
  && typeof access.sharedFile === "string" && access.sharedFile.trim().toLowerCase().startsWith("hi");
process.exit(pass ? 0 : 1);
