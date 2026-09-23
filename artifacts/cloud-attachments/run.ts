import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat } from "../browser";

// bun artifacts/cloud-attachments/run.ts <outDir> <dashboardKey> <runnerToken> <perryHome>
// Attachments that live in Convex storage (a Telegram photo, or any upload with
// PERRY_MEDIA=convex) must reach Codex as local files. Run with the dev server
// started with PERRY_MEDIA=convex and PERRY_HOME=<perryHome>, and a runner on this branch.
const [, , outDir, dashboardKey, runnerToken, perryHome] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const uploads = () => readdirSync(join(perryHome, "uploads"));
const before = uploads();
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
// A picture with one clear answer: a red circle on white.
await evaluate(`(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#e01010'; g.beginPath(); g.arc(128, 128, 80, 0, Math.PI * 2); g.fill();
  const png = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const files = new DataTransfer(); files.items.add(new File([png], 'shape.png', { type: 'image/png' }));
  const input = document.querySelector('input[type=file]');
  input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test. What shape and colour is in the attached image? Answer in three words or fewer.");
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);
const reply = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const final = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')].at(-1);
    if (final && !document.querySelector('.chat-streaming') && !document.querySelector('.chat-thinking')) return resolve(final.innerText.trim());
    if (Date.now() - start > 300000) return reject(new Error('no reply'));
    setTimeout(tick, 500);
  };
  tick();
})`);
clearInterval(heartbeat);
const sentImage = await evaluate(`document.querySelector('.chat-turn.from-user img')?.getAttribute('src') ?? null`);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const downloaded = uploads().filter((name) => !before.includes(name));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "cloud-attachment.png"), Buffer.from(shot.data, "base64"));

const pass = /convex\.cloud\/api\/storage\//.test(sentImage ?? "") && downloaded.length === 1
  && /red/i.test(reply) && /circle/i.test(reply) && errors.length === 0;
const result = { ranAt: new Date().toISOString(), chatId, sentImage, downloadedByRunner: downloaded, reply, pageErrors: errors, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
