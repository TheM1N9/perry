import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/summaries/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
// Runs the daily summary and the memory consolidation now. Both must work
// quietly (NOTHING, no chat messages, nothing sent), and the summary must
// leave today's notes in memory.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
const jobs = () => convex.query(api.jobs.listForDashboard, { key: dashboardKey });
const until = async <T>(check: () => Promise<T | undefined | false>, what: string, ms = 600_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(3000);
  }
};
const memories = async () => (await Promise.all((["daily", "profile", "core"] as const).map((kind) => convex.query(api.dashboard.listMemories, { key: dashboardKey, kind }))))
  .flat();

// The minute tick creates the built-in jobs.
const builtins = await until(async () => {
  const list = (await jobs()).jobs;
  const summary = list.find((job) => job.builtin === "daily-summary");
  const consolidate = list.find((job) => job.builtin === "consolidate");
  return summary && consolidate && { summary, consolidate };
}, "the built-in jobs", 120_000);

const runJob = async (id: typeof builtins.summary.id) => {
  const before = await memories();
  const startedAt = Date.now();
  await convex.mutation(api.jobs.runNow, { key: dashboardKey, id });
  const job = await until(async () => {
    const found = (await jobs()).jobs.find((item) => item.id === id);
    return found && (found.lastRunAt ?? 0) >= startedAt - 60_000 && (found.lastResult || found.lastError) ? found : undefined;
  }, "the job to finish");
  const known = new Set(before.map((memory) => memory.id));
  const added = (await memories()).filter((memory) => !known.has(memory.id));
  const messages = job.chatId ? (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: job.chatId, paginationOpts: { numItems: 10, cursor: null } })).page : [];
  return { job, added, messages };
};

const summary = await runJob(builtins.summary.id);
const consolidate = await runJob(builtins.consolidate.id);
clearInterval(heartbeat);

const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
await evaluate(`[...document.querySelectorAll('.chat-nav-grid a')].find((link) => link.textContent.includes('Work')).click(); true`);
await sleep(2000);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "work-page.png"), Buffer.from(shot.data, "base64"));

const quiet = (run: typeof summary) => run.job.lastResult?.trim() === "NOTHING" && !run.job.lastError && run.messages.length === 0;
const pass = quiet(summary) && summary.added.some((memory) => memory.kind === "daily") && quiet(consolidate) && errors.length === 0;
const describe = (run: typeof summary) => ({
  schedule: run.job.schedule,
  lastResult: run.job.lastResult,
  lastError: run.job.lastError,
  messagesInItsChat: run.messages.length,
  memoriesAdded: run.added.map((memory) => ({ kind: memory.kind, text: memory.text.slice(0, 160) })),
});
const result = {
  ranAt: new Date().toISOString(),
  dailySummary: describe(summary),
  consolidation: describe(consolidate),
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
