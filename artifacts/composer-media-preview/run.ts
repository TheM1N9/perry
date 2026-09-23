import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openChat, sleep } from "../browser";

const [, , outDir, dashboardKey] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const attached = await evaluate(`(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
  const g = canvas.getContext('2d'); g.font = 'bold 40px sans-serif';
  const grad = g.createLinearGradient(0, 0, 320, 200); grad.addColorStop(0, '#6d8a71'); grad.addColorStop(1, '#e0b060');
  g.fillStyle = grad; g.fillRect(0, 0, 320, 200); g.fillStyle = '#101313'; g.fillText('IMG', 115, 115);
  const png = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' }); const chunks = [];
  recorder.ondataavailable = e => chunks.push(e.data); recorder.start();
  for (let i = 0; i < 15; i++) { g.fillStyle = 'hsl(' + (200 + i * 6) + ',55%,40%)'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.fillText('VID', 110, 115); await new Promise(r => setTimeout(r, 50)); }
  const stopped = new Promise(r => recorder.onstop = r); recorder.stop(); await stopped;
  const files = new DataTransfer();
  files.items.add(new File([png], 'sunset.png', { type: 'image/png' }));
  files.items.add(new File(chunks, 'clip.webm', { type: 'video/webm' }));
  files.items.add(new File(['hello'], 'notes-for-the-assistant.txt', { type: 'text/plain' }));
  const input = document.querySelector('input[type=file]');
  input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1500));
  const box = document.querySelector('.chat-composer-box');
  return {
    previewsInsidePromptBox: !!box.querySelector('.chat-picked-files'),
    oldChipsOutsideBox: !!document.querySelector('.chat-composer-wrap > .chat-picked-files'),
    items: [...box.querySelectorAll('.chat-picked-file')].map(el => {
      const media = el.firstElementChild; const rect = media.getBoundingClientRect();
      return { title: el.title, element: media.tagName, blobUrl: (media.getAttribute('src') ?? '').startsWith('blob:'), width: rect.width, height: rect.height,
        decoded: media.tagName === 'IMG' ? media.naturalWidth > 0 : media.tagName === 'VIDEO' ? media.readyState >= 1 : null };
    }),
  };
})()`);

const composer = await evaluate(`(() => { const r = document.querySelector('.chat-composer-wrap').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: composer.x - 16, y: composer.y - 16, width: composer.width + 32, height: composer.height + 32, scale: 1 } });
writeFileSync(join(outDir, "composer-with-media.png"), Buffer.from(shot.data, "base64"));
const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "chat-with-media.png"), Buffer.from(full.data, "base64"));

const afterRemove = await evaluate(`(async () => {
  document.querySelector('.chat-picked-file[title="sunset.png"] button').click();
  await new Promise(r => setTimeout(r, 500));
  return [...document.querySelectorAll('.chat-composer-box .chat-picked-file')].map(el => el.title);
})()`);

const pass = attached.previewsInsidePromptBox && !attached.oldChipsOutsideBox
  && attached.items.length === 3
  && attached.items[0].element === "IMG" && attached.items[0].decoded && attached.items[0].blobUrl
  && attached.items[1].element === "VIDEO" && attached.items[1].decoded && attached.items[1].blobUrl
  && attached.items[2].element === "SPAN"
  && afterRemove.length === 2 && !afterRemove.includes("sunset.png");
const result = { ranAt: new Date().toISOString(), url: `${base}/chat`, attached, afterRemovingImage: afterRemove, pageErrors: errors, nothingSent: true, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
