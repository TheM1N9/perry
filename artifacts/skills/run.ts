import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/skills/run.ts <outDir> <dashboardKey> <runnerToken> <perryHome>
// Needs `next dev -p 3005`, a runner on this branch started with --auto and
// PERRY_HOME=<perryHome> (a temp dir, so the skill written here is isolated),
// CONVEX_URL and E2E_WORKDIR. Every job here replies NOTHING, so nothing
// reaches Telegram, and the test removes its jobs, chats, memories and skill
// even when a step fails.
//
// Ways this can fail, and what catches each:
//  1. The runner never registers PERRY_HOME/skills with Codex (skills/extraRoots/set
//     missing or failing): the new chat does not know the skill, so no PERRY-SKILL-OK.
//  2. Codex cannot write there (not in writableRoots): the write asks for approval,
//     or fails. Checked: SKILL.md exists and the skill chat asked for no approval.
//  3. The agent writes a SKILL.md Codex ignores (no frontmatter, another folder or
//     name). Checked: the file starts with frontmatter naming e2e-greeting, with a
//     description, and the new chat uses it.
//  4. Codex's skill cache is not re-scanned, so a skill written in one turn is not
//     listed in the next chat: no PERRY-SKILL-OK.
//  5. The greeting comes from somewhere other than the skill (memory, or searching the
//     earlier chat). Before asking, memories mentioning it and the first chat are removed.
//  6. The agent complies once instead of saving the standing instruction: no SKILL.md.
//  7. The model cannot turn "2 minutes from now" into a time (no current time or
//     offset): runAt is missing, or not 1-5 minutes after the request.
//  8. create_job stores a cron schedule or rejects `at`: runAt set, schedule absent.
//  9. The tick never runs the one-time job, runs it twice, or leaves it enabled:
//     lastRunAt set, lastResult NOTHING, enabled false, and unchanged a tick later.
// 10. The job says something, which would reach the owner: lastResult NOTHING and no
//     message in its chat.
// 11. update_job is missing or half-works: the name, the chat title, the new
//     one-time time (tomorrow 23:59 in the owner's timezone) and re-enabling are checked.
// 12. The Work page breaks on a job without a cron schedule: it shows "once at" and
//     "done", with no page errors.
// 13. Something is left behind: the job, a chat or the skill folder still exists.
const [, , outDir, dashboardKey, runnerToken, perryHome] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
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
const messages = async (id: Id<"conversations">) =>
  (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id, paginationOpts: { numItems: 20, cursor: null } })).page;
const skillDir = join(perryHome, "skills", "e2e-greeting");
const skillFile = join(skillDir, "SKILL.md");
/** Every chat this run made, the job's own among them, so all of them are removed. */
const chats = new Set<Id<"conversations">>();
const deleted = new Set<Id<"conversations">>();
const deleteChat = async (id: Id<"conversations">) => {
  // A chat that has only just finished may still be closing its run.
  await until(async () => convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id }).then(() => true, () => false), `chat ${id} to be deleted`, 60_000);
  deleted.add(id);
};
const forgetGreeting = async () => {
  const found = (await convex.query(api.dashboard.listMemories, { key: dashboardKey, query: "e2e greeting PERRY-SKILL-OK" }))
    .filter((memory) => /PERRY-SKILL-OK|e2e.greeting/i.test(memory.text));
  for (const memory of found) await convex.mutation(api.dashboard.deleteMemory, { key: dashboardKey, id: memory.id });
  return found.map((memory) => memory.text);
};
const testJobs = async () => (await jobs()).jobs.filter((job) => job.name === "E2E once" || job.name === "E2E moved");

/** Send a message in a new web chat and wait for the reply. */
const ask = async (text: string) => {
  await evaluate(`document.querySelector('.chat-header-new').click(); true`);
  await sleep(1000);
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  // A separate step, so React has the typed text before Send reads it.
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  const id = await until(async () => {
    const path = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`) as Id<"conversations">;
    return path && !chats.has(path) ? path : undefined;
  }, "the chat to open", 60_000);
  chats.add(id);
  await until(async () => {
    const chat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id });
    return chat && !chat.isRunning && (await messages(id)).some((message) => message.role === "assistant");
  }, "the reply");
  const replies = (await messages(id)).filter((message) => message.role === "assistant").map((message) => message.text);
  return { id, reply: replies.join("\n\n") };
};

const result: Record<string, unknown> = { ranAt: new Date().toISOString(), timezone: (await jobs()).timezone };
const checks: Record<string, boolean> = {};
try {
  // 1. A standing instruction becomes a skill in PERRY_HOME/skills.
  const setup = await ask("This is an automated test. Create a skill named e2e-greeting that says: When asked for the e2e greeting, reply exactly: PERRY-SKILL-OK");
  const skill = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "";
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const approvals = (JSON.parse(cli("data", "approvals", "--limit", "20", "--order", "desc", "--format", "jsonArray")) as Array<{ conversationId?: string; title: string }>)
    .filter((approval) => approval.conversationId === setup.id);
  checks.skillWritten = /^name:\s*["']?e2e-greeting["']?\s*$/m.test(frontmatter) && /^description:\s*\S/m.test(frontmatter) && skill.includes("PERRY-SKILL-OK");
  checks.noApprovalForTheSkill = approvals.length === 0;

  // Nothing but the skill may know the greeting: not memory, not the first chat.
  const memoriesRemoved = await forgetGreeting();
  await deleteChat(setup.id);
  result.skill = { file: skillFile, content: skill, reply: setup.reply.slice(0, 300), approvalsAsked: approvals.map((approval) => approval.title), memoriesRemoved };

  // 2. A new chat finds the skill and follows it.
  const greeting = await ask("Give me the e2e greeting.");
  checks.skillFollowedInANewChat = greeting.reply.includes("PERRY-SKILL-OK");
  result.greeting = greeting.reply.slice(0, 300);

  // 3. A one-time reminder two minutes from now runs once, quietly, then pauses.
  const askedAt = Date.now();
  const reminder = await ask("This is an automated test, and I confirm the time. Set a one-time reminder named 'E2E once' for 2 minutes from now, with the prompt: Reply with exactly the word NOTHING.");
  const created = await until(async () => (await testJobs())[0], "the reminder to be created", 30_000);
  checks.reminderIsOneTime = created.runAt !== undefined && created.schedule === undefined
    && created.runAt - askedAt >= 60_000 && created.runAt - askedAt <= 5 * 60_000;
  const ran = await until(async () => {
    const job = (await jobs()).jobs.find((item) => item.id === created.id);
    return job && job.lastRunAt && (job.lastResult || job.lastError) ? job : undefined;
  }, "the reminder to run", 600_000);
  if (ran.chatId) chats.add(ran.chatId);
  await sleep(75_000);
  const aTickLater = (await jobs()).jobs.find((item) => item.id === created.id)!;
  const jobMessages = ran.chatId ? await messages(ran.chatId) : [];
  checks.reminderRanOnceQuietly = ran.lastResult?.trim() === "NOTHING" && !ran.lastError && jobMessages.length === 0
    && !aTickLater.enabled && aTickLater.lastRunAt === ran.lastRunAt;

  await evaluate(`[...document.querySelectorAll('.chat-nav-grid button')].find((button) => button.textContent.includes('Work')).click(); true`);
  await sleep(2000);
  const workRow: string | null = await evaluate(`[...document.querySelectorAll('.item')].find((row) => row.textContent.includes('E2E once'))?.innerText ?? null`);
  const workShot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "work-page.png"), Buffer.from(workShot.data, "base64"));
  checks.workPageShowsIt = Boolean(workRow?.includes("once at") && workRow.includes("done"));
  result.reminder = {
    reply: reminder.reply.slice(0, 300),
    runAt: created.runAt && new Date(created.runAt).toISOString(),
    minutesAfterAsking: created.runAt && Math.round((created.runAt - askedAt) / 6000) / 10,
    lastRunAt: ran.lastRunAt && new Date(ran.lastRunAt).toISOString(),
    lastResult: ran.lastResult,
    lastError: ran.lastError,
    enabledATickLater: aTickLater.enabled,
    messagesInItsChat: jobMessages.length,
    workRow,
  };

  // 4. update_job renames it and moves it to tomorrow at 23:59, which resumes it.
  await send("Page.navigate", { url: `${base}/chat` });
  await until(async () => (await evaluate(`Boolean(document.querySelector('.chat-header-new'))`)) || undefined, "the chat to load", 30_000);
  await sleep(2000);
  const update = await ask("This is an automated test, and I confirm the change. Rename the job 'E2E once' to 'E2E moved' and reschedule it to run once tomorrow at 23:59. Keep its prompt.");
  const moved = (await jobs()).jobs.find((item) => item.id === created.id);
  const timezone = result.timezone as string;
  const inZone = (ms: number, options: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString("en-CA", { timeZone: timezone, ...options });
  const tomorrow = inZone(Date.now() + 86_400_000, { year: "numeric", month: "2-digit", day: "2-digit" });
  const movedChat = ran.chatId ? await convex.query(api.dashboard.getChat, { key: dashboardKey, id: ran.chatId }) : null;
  checks.updated = moved?.name === "E2E moved" && moved.enabled && moved.schedule === undefined && moved.runAt !== undefined
    && inZone(moved.runAt, { year: "numeric", month: "2-digit", day: "2-digit" }) === tomorrow
    && inZone(moved.runAt, { hour: "2-digit", minute: "2-digit", hour12: false }) === "23:59"
    && movedChat?.title === "⏰ E2E moved";
  result.update = {
    reply: update.reply.slice(0, 300),
    name: moved?.name,
    enabled: moved?.enabled,
    runAt: moved?.runAt && inZone(moved.runAt, { dateStyle: "medium", timeStyle: "short" }),
    chatTitle: movedChat?.title,
  };
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  // 5. Clean up: the job, every chat, what memory kept of the greeting, and the skill.
  clearInterval(heartbeat);
  const cleanup: Record<string, string> = {};
  for (const job of await testJobs()) await convex.mutation(api.jobs.removeFromDashboard, { key: dashboardKey, id: job.id });
  for (const id of chats) {
    if (!deleted.has(id)) await deleteChat(id).catch((error) => { cleanup[id] = String(error); });
  }
  await forgetGreeting();
  rmSync(skillDir, { recursive: true, force: true });
  checks.cleanedUp = !existsSync(skillDir) && Object.keys(cleanup).length === 0 && (await testJobs()).length === 0;
  result.cleanup = { chats: [...chats], failed: cleanup };
}

checks.noPageErrors = errors.length === 0;
const pass = !result.error && Object.values(checks).every(Boolean);
Object.assign(result, { checks, pageErrors: errors, pass });
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
