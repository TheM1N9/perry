import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat } from "../browser";

// bun artifacts/approvals/run.ts <outDir> <dashboardKey> <runnerToken> <runnerLog>
// Needs `next dev -p 3005`, a runner on this branch started WITHOUT --auto, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken, runnerLog] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: false });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

/** Ask Codex to write outside its workspace, then answer the approval in the dashboard. */
async function attempt(answer: "Approve" | "Decline", target: string, screenshot?: string) {
  rmSync(target, { force: true });
  await evaluate(`document.querySelector('.chat-header-new').click(); true`);
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(`This is an automated test of approvals. Use your shell to write the word ok into the file ${target}. That path is outside your workspace, so request approval to write it; do not write anywhere else. Then reply in one short sentence saying whether it worked.`)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await checkIn();
  const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  const asked = await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const card = document.querySelector('.approval');
      if (card) return resolve({ head: card.querySelector('.approval-head').innerText, what: card.querySelector('.approval-what').innerText });
      if (Date.now() - start > 240000) return reject(new Error('no approval request appeared'));
      setTimeout(tick, 250);
    };
    tick();
  })`);
  if (screenshot) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, screenshot), Buffer.from(shot.data, "base64"));
  }
  await evaluate(`[...document.querySelector('.approval').querySelectorAll('button')].find((button) => button.innerText === ${JSON.stringify(answer)}).click(); true`);
  const reply = await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const final = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')].at(-1);
      if (final && !document.querySelector('.chat-streaming') && !document.querySelector('.chat-thinking')) return resolve({ text: final.innerText.trim(), cardGone: !document.querySelector('.approval') });
      if (Date.now() - start > 300000) return reject(new Error('no reply after the approval'));
      setTimeout(tick, 500);
    };
    tick();
  })`);
  clearInterval(heartbeat);
  const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
  const written = existsSync(target) ? readFileSync(target, "utf8").trim() : null;
  rmSync(target, { force: true });
  return { answer, chatId, asked, reply, written };
}

const approved = await attempt("Approve", join(tmpdir(), "perry-approval-approved.txt"), "approval-card.png");
const declined = await attempt("Decline", join(tmpdir(), "perry-approval-declined.txt"));
const log = readFileSync(runnerLog, "utf8");

const pass = approved.written === "ok" && declined.written === null
  && approved.reply.cardGone && declined.reply.cardGone
  && log.includes("approved in the dashboard") && log.includes("declined in the dashboard")
  && errors.length === 0;
const result = { ranAt: new Date().toISOString(), approved, declined, runnerLogSawDashboardAnswers: pass, pageErrors: errors, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
