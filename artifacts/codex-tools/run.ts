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
const picker = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const options = [...document.querySelectorAll('select.chat-model option')];
    if (options.length > 1) return resolve(options.map((option) => ({ value: option.value, text: option.textContent })));
    if (Date.now() - start > 30000) return reject(new Error('Codex models never listed'));
    setTimeout(tick, 250);
  };
  tick();
})`);
await evaluate(`(() => {
  const select = document.querySelector('select.chat-model');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(picker[0].value)});
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

async function ask(text: string): Promise<{ reply: string | null; error: string | null }> {
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const before = await evaluate(`document.querySelectorAll('.chat-turn.from-assistant:not(.pending)').length`);
  await checkIn();
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  return await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
      const error = document.querySelector('.chat-turn-error');
      const thinking = document.querySelector('.chat-thinking');
      if (!thinking && replies.length > ${before}) return resolve({ reply: replies.at(-1).innerText, error: null });
      if (!thinking && error && Date.now() - start > 5000) return resolve({ reply: null, error: error.innerText });
      if (Date.now() - start > 300000) return reject(new Error('no reply within 5 minutes'));
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 3000);
  })`);
}

const first = await ask("This is an automated end-to-end test. Using your assistant tools: 1) call list_connectors and name the connected accounts; 2) call find_action for 'get the current date and time from Google Calendar', then run_action with the matching slug, and report the date it returned; 3) call remember with kind daily and the text 'E2E test note: Codex reached connectors and memory over MCP.' Reply in three short lines.");
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
// A second message in the same chat after a reload resumes the same Codex thread.
await send("Page.reload");
await sleep(5000);
const second = await ask("Reply with the single word OK.");

const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "codex-tools-chat.png"), Buffer.from(full.data, "base64"));
const result = { ranAt: new Date().toISOString(), chatId, codexModels: picker, picked: picker[0].value, first, second, pageErrors: errors };
writeFileSync(join(outDir, "chat.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(first.reply && second.reply ? 0 : 1);
