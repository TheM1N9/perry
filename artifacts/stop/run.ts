import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/stop/run.ts <outDir> <dashboardKey> <runnerToken> <runnerLog>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken, runnerLog] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test. Count from 1 to 400, one number per line, and nothing else.");
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// Keep the test runner the freshest Codex runner until the chat is bound to it.
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);

// Stop once the reply is visibly streaming.
const beforeStop = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const streaming = document.querySelector('.chat-streaming');
    const stop = document.querySelector('.chat-stop');
    if (streaming && stop && streaming.innerText.length > 40) {
      const chars = streaming.innerText.length;
      stop.click();
      return resolve({ chars, stopButtonShown: true });
    }
    if (Date.now() - start > 180000) return reject(new Error('never saw the reply streaming'));
    setTimeout(tick, 100);
  };
  tick();
})`);
clearInterval(heartbeat);

const after = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const final = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')].at(-1);
    if (final && !document.querySelector('.chat-streaming') && !document.querySelector('.chat-thinking')) return resolve({
      text: final.innerText.trim(),
      errorBanner: document.querySelector('.chat-turn-error')?.innerText ?? null,
      sendButtonBack: !!document.querySelector('.chat-send:not(.chat-stop)'),
    });
    if (Date.now() - start > 120000) return reject(new Error('the stopped reply never landed'));
    setTimeout(tick, 250);
  };
  tick();
})`);
await sleep(500);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "stopped-reply.png"), Buffer.from(full.data, "base64"));

const lines = after.text.split("\n").map((line: string) => line.trim()).filter(Boolean);
const numbers = lines.filter((line: string) => /^\d+$/.test(line));
const interrupted = readFileSync(runnerLog, "utf8").includes("stopping the Codex turn");
const pass = numbers.length > 0 && numbers.length < 400 && lines.at(-1) === "Stopped." && after.errorBanner === null
  && after.sendButtonBack && interrupted && errors.length === 0;
const result = {
  ranAt: new Date().toISOString(),
  chatId,
  stoppedAtChars: beforeStop.chars,
  keptNumbers: numbers.length,
  lastLine: lines.at(-1),
  errorBanner: after.errorBanner,
  sendButtonBack: after.sendButtonBack,
  runnerInterruptedCodex: interrupted,
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
