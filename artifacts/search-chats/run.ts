import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat } from "../browser";

// bun artifacts/search-chats/run.ts <outDir> <dashboardKey> <runnerToken> <number>
// Needs an earlier chat where the owner asked the assistant to remember <number>
// (artifacts/regenerate-edit leaves one), plus the usual dev server, runner, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken, expected] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test. In an earlier conversation I asked you to remember a number. Search our earlier chats for it and reply with just that number.");
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
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const run = (await convex.query(api.dashboard.listRuns, { key: dashboardKey })).find((item) => item.sessionId === chatId);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "found-in-earlier-chat.png"), Buffer.from(shot.data, "base64"));

const pass = reply.includes(expected) && (run?.toolCalls ?? []).includes("search_chats") && errors.length === 0;
const result = { ranAt: new Date().toISOString(), chatId, reply, toolCalls: run?.toolCalls ?? [], pageErrors: errors, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
