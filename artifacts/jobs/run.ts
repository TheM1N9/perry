import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/jobs/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await checkIn();
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const browserTimezone = await evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
const jobs = () => convex.query(api.jobs.listForDashboard, { key: dashboardKey });
const until = async <T>(check: () => Promise<T | undefined | false>, what: string, ms = 300_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
};

// 1. The dashboard reported this browser's timezone.
const timezone = await until(async () => { const data = await jobs(); return data.timezone === browserTimezone && data.timezone; }, "the timezone");

// 2. Ask for a job in chat; the assistant creates it with create_job.
await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test, and I confirm the schedule. Create a scheduled job named 'E2E ping' that runs every day at 23:59, with the prompt: Reply with exactly the word NOTHING. Then tell me when it will next run.");
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// A separate step, so React has the typed text before Send reads it.
await evaluate(`document.querySelector('.chat-send').click(); true`);
const created = await until(async () => (await jobs()).jobs.find((job) => job.name === "E2E ping"), "the job to be created");
const setupChatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
await until(async () => (await evaluate(`!document.querySelector('.chat-streaming, .chat-thinking, .chat-turn.pending')`)) || undefined, "the setup reply");

// 3. Run it now from the Work page.
await evaluate(`[...document.querySelectorAll('.chat-nav-grid a')].find((link) => link.textContent.includes('Work')).click(); true`);
await sleep(1500);
await evaluate(`(() => {
  const item = [...document.querySelectorAll('.item')].find((row) => row.textContent.includes('E2E ping'));
  [...item.querySelectorAll('button')].find((button) => button.textContent === 'Run now').click();
  return true;
})()`);
const ran = await until(async () => { const job = (await jobs()).jobs.find((item) => item.id === created.id); return job && job.lastRunAt && (job.lastResult || job.lastError) ? job : undefined; }, "the job to run");
const workShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "work-page.png"), Buffer.from(workShot.data, "base64"));
const jobChat = (await convex.query(api.dashboard.listChats, { key: dashboardKey })).find((chat) => chat.id === ran.chatId);
const jobMessages = ran.chatId ? (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: ran.chatId, paginationOpts: { numItems: 10, cursor: null } })).page : [];

// 4. The heartbeat exists and is scheduled. It is not run here: when it has
// something to say it messages the owner on Telegram.
const heartbeatJob = (await jobs()).jobs.find((job) => job.builtin === "heartbeat");
clearInterval(heartbeat);

// 5. Clean up the test job.
await convex.mutation(api.jobs.removeFromDashboard, { key: dashboardKey, id: created.id });

const pass = timezone === browserTimezone && Boolean(created.schedule?.replace(/\s+/g, " ").startsWith("59 23"))
  && ran.lastResult?.trim() === "NOTHING" && !ran.lastError && jobChat?.title === "⏰ E2E ping" && jobMessages.length === 0
  && Boolean(heartbeatJob?.enabled) && (heartbeatJob?.nextRunAt ?? 0) > Date.now()
  && errors.length === 0;
const result = {
  ranAt: new Date().toISOString(),
  timezone,
  created: { name: created.name, schedule: created.schedule, nextRunAt: new Date(created.nextRunAt).toISOString() },
  run: { lastRunAt: new Date(ran.lastRunAt!).toISOString(), lastResult: ran.lastResult, lastError: ran.lastError, chat: jobChat?.title, messagesInItsChat: jobMessages.length },
  heartbeat: { schedule: heartbeatJob?.schedule, enabled: heartbeatJob?.enabled, nextRunAt: heartbeatJob && new Date(heartbeatJob.nextRunAt).toISOString() },
  cleanup: { chats: [setupChatId, ran.chatId] },
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
