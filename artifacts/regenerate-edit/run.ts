import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/regenerate-edit/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await checkIn();

/** The chat as shown: every turn's role and text, in order. */
const transcript = () => evaluate(`[...document.querySelectorAll('.chat-thread > .chat-turn:not(.pending)')].map((turn) => ({ role: turn.classList.contains('from-user') ? 'user' : 'assistant', text: turn.querySelector('.chat-bubble')?.innerText.trim() ?? '' }))`) as Promise<Array<{ role: string; text: string }>>;
/** Wait until a reply has landed and nothing is running. */
const settled = () => evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  let quiet = 0;
  const tick = () => {
    const busy = document.querySelector('.chat-streaming, .chat-thinking, .chat-turn.pending');
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 4) return resolve(true);
    if (Date.now() - start > 240000) return reject(new Error('the reply never settled'));
    setTimeout(tick, 500);
  };
  setTimeout(tick, 1500);
})`);
const say = async (text: string) => {
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.chat-send').click();
    return true;
  })()`);
  await settled();
};
const lastReply = async () => (await transcript()).filter((turn) => turn.role === "assistant").at(-1)?.text ?? "";

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await say("This is an automated test. Remember the number 7 for this chat. Reply with just OK.");
await say("What number did I ask you to remember? Reply with just the number.");
const beforeEdit = await transcript();
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);

// Edit the first message: everything after it goes, and Codex must forget the 7.
await evaluate(`(() => {
  document.querySelector('.chat-thread > .chat-turn.from-user .chat-turn-actions button[title^="Edit"]').click();
  return true;
})()`);
await sleep(300);
await evaluate(`(() => {
  const box = document.querySelector('.chat-edit textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test. Remember the number 3 for this chat. Reply with just OK.");
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.chat-edit-save').click();
  return true;
})()`);
await settled();
const afterEdit = await transcript();
await say("What number did I ask you to remember? Reply with just the number.");
const recalled = await lastReply();

// Regenerate the last reply: replaced in place, still 3.
const runsBefore = (await convex.query(api.dashboard.listRuns, { key: dashboardKey })).filter((run) => run.sessionId === chatId).length;
await evaluate(`[...document.querySelectorAll('.chat-turn-actions button')].find((button) => button.textContent.includes('Regenerate')).click(); true`);
await settled();
const afterRegenerate = await transcript();
const runsAfter = (await convex.query(api.dashboard.listRuns, { key: dashboardKey })).filter((run) => run.sessionId === chatId).length;
clearInterval(heartbeat);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "after-regenerate.png"), Buffer.from(shot.data, "base64"));

const pass = beforeEdit.length === 4 && beforeEdit[3].text.includes("7")
  && afterEdit.length === 2 && afterEdit[0].text.includes("number 3")
  && recalled.includes("3") && !recalled.includes("7")
  && afterRegenerate.length === 4 && afterRegenerate[3].role === "assistant" && afterRegenerate[3].text.includes("3")
  && runsAfter === runsBefore + 1 && errors.length === 0;
const result = { ranAt: new Date().toISOString(), chatId, beforeEdit, afterEdit, recalled, afterRegenerate, runsBefore, runsAfter, pageErrors: errors, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
