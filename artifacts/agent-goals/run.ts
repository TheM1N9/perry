import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/agent-goals/run.ts <outDir> <dashboardKey>
// Needs this branch pushed with `convex dev`, `next dev -p 3005`, CONVEX_URL,
// the Convex CLI signed in to the deployment, at least one goal saved, and a
// live runner signed in to Codex. Uses one Codex turn per question; the chats
// are deleted at the end.
//
// The owner asked "what are your goals?" and Perry described itself, calling
// no tool, though goals were saved. Ways that could still happen, and what
// catches each:
//   1. Perry answers from its self-image instead of the data: each question's
//      run must call status_report.
//   2. It reads the data but leaves goals out: each reply must name every
//      active goal's title.
//   3. It only recognises one phrasing: both "what are your goals?" and "what
//      goals am I working toward?" are asked, each in a new chat.
//   4. No reply, or an error: each turn must end in a reply.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/agent-goals/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const cli = (fn: string, args: object = {}) => JSON.parse(execFileSync("node", ["node_modules/convex/bin/main.js", "run", fn, JSON.stringify(args)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "null");
type Run = { sessionId: string; prompt: string; status: string; toolCalls?: string[] };

const goals: Array<{ title: string; status: string }> = cli("work:snapshot").goals;
const active = goals.filter((goal) => goal.status === "active").map((goal) => goal.title);
if (active.length === 0) throw new Error("Save at least one active goal first; this test asks about goals.");

const checks: Record<string, boolean> = {};
const asked: Array<{ question: string; reply: string | null; toolCalls: string[]; namesEveryGoal: boolean }> = [];
const chats: string[] = [];

const browser = await openChat(base, dashboardKey);
const { evaluate, send } = browser;

async function askInNewChat(question: string) {
  await evaluate(`[...document.querySelectorAll('.sidebar-actions button')].find((b) => b.innerText.includes('New chat')).click(); true`);
  await sleep(1000);
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(question)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  const reply: string | null = await evaluate(`new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
      if (!document.querySelector('.chat-thinking') && replies.length > 0) return resolve(replies.at(-1).innerText);
      if (Date.now() - start > 300000) return resolve(null);
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 3000);
  })`);
  const chatId: string = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
  if (chatId) chats.push(chatId);
  const run = (cli("runs:recent", { limit: 10, conversationId: chatId }) as Run[])[0];
  const toolCalls = run?.toolCalls ?? [];
  const namesEveryGoal = Boolean(reply) && active.every((title) => reply!.toLowerCase().includes(title.toLowerCase()));
  asked.push({ question, reply, toolCalls, namesEveryGoal });
}

try {
  await askInNewChat("what are your goals?");
  await askInNewChat("What goals am I working toward?");
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "chat.png"), Buffer.from(shot.data, "base64")));
  checks.readsTheGoals = asked.every((item) => item.toolCalls.includes("status_report"));
  checks.namesEveryActiveGoal = asked.every((item) => item.namesEveryGoal);
  checks.everyTurnReplied = asked.every((item) => item.reply);
  checks.noPageErrors = browser.errors.length === 0;
} finally {
  browser.close();
  for (const id of chats) await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id: id as Id<"conversations"> }).catch(() => {});
}

const result = { ranAt: new Date().toISOString(), activeGoals: active, checks, asked, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
