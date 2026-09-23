import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat } from "../browser";

// bun artifacts/streaming/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test. Count from 1 to 80, one number per line, and nothing else.");
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// Keep the test runner the freshest Codex runner until the chat is bound to it.
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);

// Sample the page while the reply arrives: the growing text, then the final message.
const observed = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const samples = [];
  let screenshotAt = null;
  const tick = () => {
    const streaming = document.querySelector('.chat-streaming');
    if (streaming) samples.push({ at: Date.now() - start, chars: streaming.innerText.length, caret: !!streaming.querySelector('.chat-markdown') });
    const final = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')].at(-1);
    const error = document.querySelector('.chat-turn-error, .chat-error');
    if (final && !streaming) return resolve({ samples, final: final.innerText.trim() });
    if (error && Date.now() - start > 5000) return resolve({ samples, error: error.innerText });
    if (Date.now() - start > 300000) return reject(new Error('no reply within 5 minutes'));
    setTimeout(tick, 150);
  };
  tick();
})`);
clearInterval(heartbeat);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "streamed-reply.png"), Buffer.from(full.data, "base64"));

const lengths: number[] = observed.samples.map((sample: { chars: number }) => sample.chars);
const distinct = [...new Set(lengths)];
const growing = lengths.every((length, index) => index === 0 || length >= lengths[index - 1]);
const numbers = (observed.final ?? "").split(/\s+/).filter(Boolean);
const pass = !observed.error && distinct.length >= 3 && growing && numbers.length === 80 && numbers[79] === "80" && errors.length === 0;
const result = {
  ranAt: new Date().toISOString(),
  chatId,
  streamedSteps: distinct.length,
  growing,
  firstPartialAtMs: observed.samples[0]?.at ?? null,
  samples: observed.samples.slice(0, 40),
  finalLines: numbers.length,
  error: observed.error ?? null,
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
close();
process.exit(pass ? 0 : 1);
