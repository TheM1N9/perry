import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/slash-commands/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

const type = (text: string) => evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const suggestions = async () => { await sleep(300); return evaluate(`[...document.querySelectorAll('.chat-commands button span')].map((item) => item.textContent)`) as Promise<string[]>; };
const enter = async () => {
  await evaluate(`document.querySelector('.chat-composer-box textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(600);
  return evaluate(`({ notice: document.querySelector('.chat-notice pre')?.textContent ?? null, draft: document.querySelector('.chat-composer-box textarea').value, model: document.querySelector('select.chat-model').value, sentAnything: document.querySelectorAll('.chat-turn.from-user').length > 0 })`);
};

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await type("/");
const commands = await suggestions();
await type("/model ");
const models = await suggestions();
await type("/model luna");
const ambiguous = await enter();
await type("/model gpt-5.5");
const switched = await enter();
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "model-switched.png"), Buffer.from(shot.data, "base64"));

// The switch applies to the next message.
await type("This is an automated test. Reply with the single word pong.");
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);
const reply = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const final = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')].at(-1);
    if (final && !document.querySelector('.chat-streaming') && !document.querySelector('.chat-thinking')) return resolve(final.innerText.trim());
    if (Date.now() - start > 240000) return reject(new Error('no reply'));
    setTimeout(tick, 500);
  };
  tick();
})`);
clearInterval(heartbeat);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const runs = await convex.query(api.dashboard.listRuns, { key: dashboardKey });
const run = runs.find((item) => item.sessionId === chatId);
await type("/model");
const listed = await enter();

const pass = commands.join(",") === "/model,/set model,/stop,/compact" && models.length >= 2
  && (ambiguous.notice ?? "").includes("matches") && ambiguous.draft === "/model luna" && !ambiguous.sentAnything
  && (switched.notice ?? "").includes("gpt-5.5") && switched.model === "gpt-5.5" && switched.draft === "" && !switched.sentAnything
  && run?.model === "codex/gpt-5.5" && /• gpt-5\.5/.test(listed.notice ?? "") && errors.length === 0;
const result = { ranAt: new Date().toISOString(), chatId, commands, models, ambiguous, switched, reply, runModel: run?.model, listed, pageErrors: errors, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
