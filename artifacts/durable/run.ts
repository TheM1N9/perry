import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/durable/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner named e2e-durable on this branch, CONVEX_URL and E2E_WORKDIR.
// The runner dies mid-turn and never returns; the recovery sweep, run as if 20
// minutes had passed, must fail the turn with a clear error and free the chat,
// and running it again, or finalizing again, must not repeat anything.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const convexRun = (fn: string, args: object) => JSON.parse(cli("run", fn, JSON.stringify(args)).trim() || "null");

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "This is an automated test. Count from 1 to 2000, one number per line, and nothing else.");
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);

// 1. Kill the runner, and the Codex under it, once the reply is streaming.
await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    if ((document.querySelector('.chat-streaming')?.innerText.length ?? 0) > 40) return resolve(true);
    if (Date.now() - start > 180000) return reject(new Error('never saw the reply streaming'));
    setTimeout(tick, 100);
  };
  tick();
})`);
clearInterval(heartbeat);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
// Only this chat, so the real ones are left alone.
const sweep = () => convexRun("recovery:sweep", { now: Date.now() + 20 * 60_000, only: chatId });
execFileSync("powershell", ["-NoProfile", "-Command",
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'e2e-durable' -and $_.Name -match 'bun' } | ForEach-Object { taskkill /T /F /PID $_.ProcessId }"]);
await sleep(3000);
const stuck = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: chatId });

// 2. Twenty minutes later, as far as the sweep can tell.
const first = sweep();
const recovered = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    const chat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: chatId });
    if (chat && !chat.isRunning && chat.lastError) return chat;
    await sleep(1000);
  }
  throw new Error("the chat was never released");
})();
await sleep(2000);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "recovered-chat.png"), Buffer.from(shot.data, "base64"));
const banner = await evaluate(`document.querySelector('.chat-turn-error')?.innerText ?? null`);
const messages = async () => (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: chatId, paginationOpts: { numItems: 20, cursor: null } })).page;
const afterFirst = await messages();

// 3. Nothing repeats: a second sweep finds nothing, and finalizing again saves nothing.
const second = sweep();
const turns = JSON.parse(cli("data", "codexTurns", "--limit", "5", "--order", "desc", "--format", "jsonArray"));
const turn = turns.find((item: { conversationId: string }) => item.conversationId === chatId);
convexRun("codex:finalizeTurn", { id: turn._id });
await sleep(2000);
const afterRetry = await messages();

const pass = stuck?.isRunning === true && first.abandoned >= 1 && /runner stopped/i.test(recovered.lastError ?? "")
  && !recovered.isRunning && Boolean(banner) && afterFirst.filter((message) => message.role === "user").length === 1
  && second.abandoned === 0 && second.refinalized === 0 && afterRetry.length === afterFirst.length
  && Boolean(turn?.savedAt) && Boolean(turn?.finalizedAt) && turn?.status === "error" && errors.length === 0;
const result = {
  ranAt: new Date().toISOString(),
  chatId,
  runningWhenKilled: stuck?.isRunning,
  firstSweep: first,
  chatAfter: { isRunning: recovered.isRunning, lastError: recovered.lastError, banner },
  messages: afterFirst.map((message) => ({ role: message.role, text: message.text.slice(0, 120) })),
  secondSweep: second,
  turn: { status: turn?.status, savedAt: Boolean(turn?.savedAt), finalizedAt: Boolean(turn?.finalizedAt) },
  messagesAfterFinalizingAgain: afterRetry.length,
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
