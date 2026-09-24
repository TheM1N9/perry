import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/agent-tasks/run.ts <outDir> <dashboardKey>
// Needs this branch pushed with `convex dev`, `next dev -p 3005`, CONVEX_URL,
// the Convex CLI signed in to the deployment, and a live runner signed in to
// Codex (the web chat uses the most recently seen one). Uses about six Codex
// turns. Everything is asked in plain words, as the owner would, in one new
// web chat.
//
// It seeds an "E2E watch" on example.com, an "E2E goal", an "E2E task" and an
// "E2E quiet job" whose prompt only speaks if 2 + 2 is 5, so running it sends
// nothing. The chat, the job and the watch are deleted at the end. Goals and
// tasks have no delete, so "E2E goal" (done or not) and "E2E task" (cancelled)
// stay on the Tasks page.
//
// Ways Perry could fail to reach what the Tasks page shows, and what catches each:
//   1. It cannot say why a job failed (list_jobs hid lastError): asked why the
//      Daily summary failed, the reply must use the words of its last error.
//   2. It cannot run a job now (no run_job): asked to run "E2E quiet job" now,
//      that job's last run must move to after the question.
//   3. It cannot record goal progress (no update_goal): asked to tick "First
//      step" on "E2E goal", that milestone must be done and "Second step" not.
//   4. It cannot cancel a task: asked to cancel "E2E task", it must be cancelled.
//   5. It cannot check a watch on demand (no check_watches): asked to check
//      "E2E watch" now, its last check must move to after the question.
//   6. It cannot pause a watch (no update_watch): asked to pause it, it must
//      end up paused.
//   7. It cannot delete a watch (no delete_watch): asked to delete it (and
//      confirming if Perry asks), the watch must be gone.
//   8. A reply never comes, or comes as an error: every turn must end in a reply.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/agent-tasks/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const cli = (fn: string, args: object = {}) => JSON.parse(execFileSync("node", ["node_modules/convex/bin/main.js", "run", fn, JSON.stringify(args)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "null");
type Snapshot = {
  tasks: Array<{ id: string; title: string; status: string }>;
  goals: Array<{ id: string; title: string; status: string; milestones: Array<{ title: string; done: boolean }> }>;
  monitors: Array<{ id: string; title: string; active: boolean; lastCheckedAt?: number; lastObservation?: string }>;
};
type Job = { id: string; name: string; lastRunAt?: number; lastError?: string; builtin?: string };
const snapshot = (): Snapshot => cli("work:snapshot");
const jobs = (): Job[] => cli("jobs:list");

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const turns: Array<{ asked: string; reply: string | null; error: string | null; approvals: number }> = [];

// Seeds.
const watchId: string = cli("work:createMonitor", { title: "E2E watch", url: "https://example.com", condition: "change", intervalMinutes: 10080 });
const goalId: string = cli("work:createGoal", { title: "E2E goal", description: "Seeded by artifacts/agent-tasks.", milestones: ["First step", "Second step"] });
const taskId: string = cli("work:createTask", { title: "E2E task", prompt: "Seeded by artifacts/agent-tasks." });
const job: { id: string } = cli("jobs:create", { name: "E2E quiet job", at: "2027-01-01T09:00:00+05:30", prompt: "Only tell me if 2 + 2 equals 5. Otherwise, say nothing at all." });
notes.seeded = { watchId, goalId, taskId, jobId: job.id };
const dailyError = jobs().find((item) => item.builtin === "daily-summary")?.lastError ?? null;
notes.dailySummaryLastError = dailyError;

const browser = await openChat(base, dashboardKey);
const { evaluate, send } = browser;
let chatId = "";

async function ask(text: string) {
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const before = await evaluate(`document.querySelectorAll('.chat-turn.from-assistant:not(.pending)').length`);
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  let approvals = 0;
  const deadline = Date.now() + 300000;
  for (;;) {
    await sleep(1500);
    // A supervised chat may ask before acting; the test approves once per card.
    if (await evaluate(`(() => { const b = document.querySelector('.approval-approve:not(:disabled)'); if (b) { b.click(); return true; } return false; })()`)) approvals++;
    const state = await evaluate(`(() => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
      const error = document.querySelector('.chat-turn-error');
      const thinking = document.querySelector('.chat-thinking');
      return { count: replies.length, last: replies.at(-1)?.innerText ?? null, error: error?.innerText ?? null, thinking: !!thinking };
    })()`);
    if (!state.thinking && state.count > before) { turns.push({ asked: text, reply: state.last, error: null, approvals }); break; }
    if (!state.thinking && state.error && Date.now() > deadline - 290000) { turns.push({ asked: text, reply: null, error: state.error, approvals }); break; }
    if (Date.now() > deadline) { turns.push({ asked: text, reply: null, error: "no reply within 5 minutes", approvals }); break; }
  }
  if (!chatId) chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
  return turns.at(-1)!;
}

try {
  await evaluate(`[...document.querySelectorAll('.sidebar-actions button')].find((b) => b.innerText.includes('New chat')).click(); true`);
  await sleep(1000);

  // 1. Why a job failed.
  const why = await ask("Why did my Daily summary job fail the last time it ran? Answer in one or two sentences.");
  const errorWords = (dailyError ?? "").toLowerCase().match(/[a-z]{5,}/g) ?? [];
  const echoed = errorWords.filter((word) => why.reply?.toLowerCase().includes(word));
  notes.errorWordsEchoed = echoed;
  checks.explainsJobFailure = dailyError === null ? Boolean(why.reply) : echoed.length >= 2;

  // 2. Run a job now.
  const beforeRun = Date.now();
  await ask("Run the job called “E2E quiet job” now.");
  const ran = jobs().find((item) => item.id === job.id);
  checks.runsJobNow = (ran?.lastRunAt ?? 0) >= beforeRun;

  // 3 and 4. Goal progress and cancelling a task.
  await ask("On my goal “E2E goal”, mark the milestone “First step” as reached. Then cancel the task called “E2E task”.");
  const afterGoal = snapshot();
  const goal = afterGoal.goals.find((item) => item.id === goalId);
  notes.goalAfter = goal;
  checks.ticksMilestone = goal?.milestones.find((m) => m.title === "First step")?.done === true && goal?.milestones.find((m) => m.title === "Second step")?.done === false;
  checks.cancelsTask = afterGoal.tasks.find((item) => item.id === taskId)?.status === "cancelled";

  // 5 and 6. Checking a watch now, then pausing it.
  const beforeCheck = Date.now();
  await ask("Check the watch called “E2E watch” right now and tell me what it saw. After that, pause that watch.");
  const watch = snapshot().monitors.find((item) => item.id === watchId);
  notes.watchAfter = watch;
  checks.checksWatchNow = (watch?.lastCheckedAt ?? 0) >= beforeCheck;
  checks.pausesWatch = watch?.active === false;

  // 7. Deleting a watch, confirming if asked.
  await ask("Delete the watch called “E2E watch”.");
  if (snapshot().monitors.some((item) => item.id === watchId)) await ask("Yes, delete it.");
  checks.deletesWatch = !snapshot().monitors.some((item) => item.id === watchId);

  checks.everyTurnReplied = turns.every((turn) => turn.reply && !turn.error);
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "chat.png"), Buffer.from(shot.data, "base64")));
  notes.pageErrors = browser.errors;
} finally {
  browser.close();
  // Cleanup: the chat, the chat the job's run opened (once that run has finished), the job, and the watch if Perry left it.
  if (chatId) await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id: chatId as Id<"conversations"> }).catch(() => {});
  type Run = { sessionId: string; chatTitle: string; status: string };
  const jobRuns = () => (cli("runs:recent", { limit: 50 }) as Run[]).filter((run) => run.chatTitle === "⏰ E2E quiet job");
  for (let i = 0; i < 40 && jobRuns().some((run) => run.status === "running"); i++) await sleep(3000);
  for (const run of jobRuns()) await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id: run.sessionId as Id<"conversations"> }).catch(() => {});
  cli("jobs:remove", { id: job.id });
  cli("work:deleteMonitor", { monitorId: watchId });
  checks.cleanedUp = !snapshot().monitors.some((item) => item.id === watchId) && !jobs().some((item) => item.id === job.id);
}

const result = { ranAt: new Date().toISOString(), checks, turns, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
