// Usage:
//   node render.mjs                     full render of perry.html -> perry.mp4
//   node render.mjs --stills 0.5,2.1    write stills/<t>.png for inspection
//   node render.mjs --serve             serve the interactive preview on :8123
//   --page social.html --out social.mp4 render a different piece (DUR/FPS/SUB read from the page)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1] ?? true; };
const PAGE = flag('--page') || 'perry.html', OUT = flag('--out') || 'perry.mp4';
const AUDIO = OUT.replace(/\.mp4$/, '.wav');

const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const port = flag('--serve') ? 8123 : 0;
await new Promise(r => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/${PAGE}`;
if (flag('--serve')) { console.log(`preview: ${base}`); await new Promise(() => {}); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
page.on('console', m => console.log('[page]', m.text()));
page.on('pageerror', e => console.error('[page error]', e.message));
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(`${base}?render`, { waitUntil: 'load' });
await page.evaluate(() => window.ready);
const { FPS, DUR, SUB } = await page.evaluate(() => ({ FPS: window.FPS_ || 60, DUR: window.DUR_ || 15, SUB: window.SUB_ || 5 }));

const stills = flag('--stills');
if (stills) {
  fs.mkdirSync(path.join(ROOT, 'stills'), { recursive: true });
  for (const t of String(stills).split(',').map(Number)) {
    const url = await page.evaluate((t, s) => window.frameDataURL(t, s), t, SUB);
    fs.writeFileSync(path.join(ROOT, 'stills', `${t.toFixed(3)}.png`), Buffer.from(url.split(',')[1], 'base64'));
    console.log('still', t);
  }
} else {
  const t0 = Date.now();
  const wav = await page.evaluate(() => window.audioWav());
  fs.writeFileSync(path.join(ROOT, AUDIO), Buffer.from(wav, 'base64'));
  console.log(`audio rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (flag('--audio')) {   // remux fresh audio onto the existing video
    const r = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(ROOT, OUT), '-i', path.join(ROOT, AUDIO),
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', path.join(ROOT, 'reel_tmp.mp4')], { stdio: 'inherit' });
    await new Promise(res => r.on('close', res));
    fs.renameSync(path.join(ROOT, 'reel_tmp.mp4'), path.join(ROOT, OUT));
    console.log('audio remuxed'); await browser.close(); server.close(); process.exit(0);
  }
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-i', path.join(ROOT, AUDIO),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-tune', 'animation',
    '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart',
    path.join(ROOT, OUT),
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = FPS * DUR;
  for (let f = 0; f < total; f++) {
    const url = await page.evaluate((t, s) => window.frameDataURL(t, s), f / FPS, SUB);
    if (!ff.stdin.write(Buffer.from(url.split(',')[1], 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 60 === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${OUT}`);
}
await browser.close();
server.close();
