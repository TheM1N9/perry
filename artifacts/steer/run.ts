import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { COMPACTED } from "../../convex/lib/commands";
import { openChat, sleep } from "../browser";

// bun artifacts/steer/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
// Uses a new web chat only; nothing is sent to Telegram.
//
// Ways steering and /compact can fail, and what this checks for each:
// - The composer still shows Stop while a reply runs, so nothing can be sent:
//   with a draft typed mid-reply, Send must be the button shown.
// - The steered message does not show until the reply ends: its bubble must
//   appear within two seconds of sending.
// - enqueueTurn queues the message as a second turn instead of steering: the
//   chat must end with exactly one reply turn, and one steer row, "applied",
//   pointing at it.
// - The runner never sees the steer, sends it before Codex has a turn id, or
//   sends turn/steer with wrong params, so Codex refuses and it is queued: the
//   same check (a refused steer is "queued" with a queuedTurnId), plus the
//   turn must have its Codex turn id recorded.
// - Codex takes the steer but the reply ignores it: the final reply must end
//   with DONE and count no higher than 20.
// - finalizeTurn drops the steered message, or saves it after the reply: the
//   history must read exactly [prompt, steer, reply], one assistant message.
// - An applied steer keeps the chat marked busy (pendingTurns not released),
//   or its run stays "running": the chat must stop running, both runs "ok".
// - /compact is sent as a message, is not recognised, calls the wrong Codex
//   method, never sees its turn start, or reports before Codex is done: the
//   notice must go from "Compacting" to the COMPACTED text, the compact turn
//   must be "done", and the history must not change.
// - Compaction leaves the thread unusable: a message after it must get a reply.
// - Any of this throws in the page: no page errors.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
// An empty table prints nothing at all.
const table = (name: string) => JSON.parse(cli("data", name, "--limit", "50", "--order", "desc", "--format", "jsonArray").trim() || "[]") as Array<Record<string, any>>;

const PROMPT = "This is an automated test. Count from 1 to 300, one number per line, and nothing else.";
const STEER = "Actually stop at 20 and then say DONE";
const type = (text: string) => evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const settled = (timeout: number) => evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const final = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')].at(-1);
    if (final && !document.querySelector('.chat-streaming') && !document.querySelector('.chat-thinking') && !document.querySelector('.chat-turn.from-user.pending')) return resolve(final.innerText.trim());
    if (Date.now() - start > ${timeout}) return reject(new Error('the reply never landed'));
    setTimeout(tick, 250);
  };
  tick();
})`);

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await type(PROMPT);
// Keep the test runner the freshest Codex runner until the chat is bound to it.
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);

// 1. While the count streams, send the steer with the composer's own button.
await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    if ((document.querySelector('.chat-streaming')?.innerText.length ?? 0) > 40) return resolve(true);
    if (Date.now() - start > 180000) return reject(new Error('never saw the reply streaming'));
    setTimeout(tick, 100);
  };
  tick();
})`);
const stopShownWhileEmpty = await evaluate(`!!document.querySelector('.chat-send.chat-stop')`);
await type(STEER);
await sleep(200);
const sendShownWithDraft = await evaluate(`!!document.querySelector('.chat-send:not(.chat-stop)') && !document.querySelector('.chat-send:not(.chat-stop)').disabled`);
await evaluate(`document.querySelector('.chat-send:not(.chat-stop)').click(); true`);
const steerShownMs = await evaluate(`new Promise((resolve) => {
  const start = Date.now();
  const tick = () => {
    const shown = [...document.querySelectorAll('.chat-turn.from-user .chat-bubble')].some((item) => item.innerText.trim() === ${JSON.stringify(STEER)});
    if (shown) return resolve(Date.now() - start);
    if (Date.now() - start > 5000) return resolve(null);
    setTimeout(tick, 50);
  };
  tick();
})`);
const midShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "steered-while-streaming.png"), Buffer.from(midShot.data, "base64"));

// 2. The reply lands once, having taken the steer.
const reply = await settled(300000) as string;
await sleep(1500);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const chat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: chatId });
const history = async () => (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: chatId, paginationOpts: { numItems: 50, cursor: null } })).page
  .sort((a, b) => a.createdAt - b.createdAt).map((message) => ({ role: message.role, text: message.text }));
const afterSteer = await history();
const turns = table("codexTurns").filter((turn) => turn.conversationId === chatId);
const replyTurns = turns.filter((turn) => turn.kind !== "compact");
const steers = table("codexSteers").filter((steer) => steer.conversationId === chatId);
const runs = (await convex.query(api.dashboard.listRuns, { key: dashboardKey, conversationId: chatId })).map((run) => ({ prompt: run.prompt, status: run.status }));
const replyShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "steered-reply.png"), Buffer.from(replyShot.data, "base64"));

const numbers = (reply.match(/\d+/g) ?? []).map(Number);
const steerChecks = {
  stopShownWhileEmpty,
  sendShownWithDraft,
  steerShownMs,
  replyEndsWithDone: /DONE\W*$/.test(reply),
  highestNumberInReply: numbers.length ? Math.max(...numbers) : 0,
  historyInOrder: afterSteer.length === 3 && afterSteer[0].role === "user" && afterSteer[0].text === PROMPT
    && afterSteer[1].role === "user" && afterSteer[1].text === STEER && afterSteer[2].role === "assistant",
  assistantMessages: afterSteer.filter((message) => message.role === "assistant").length,
  replyTurns: replyTurns.length,
  steer: steers.map((steer) => ({ status: steer.status, joinedReplyTurn: steer.turnId === replyTurns[0]?._id, error: steer.error ?? null })),
  codexTurnIdRecorded: Boolean(replyTurns[0]?.codexTurnId),
  chatStillRunning: chat?.isRunning,
  runs,
};

// 3. /compact, from the composer, reported when Codex is done.
await type("/compact");
await evaluate(`document.querySelector('.chat-composer-box textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
await sleep(800);
const compactStarted = await evaluate(`document.querySelector('.chat-notice pre')?.textContent ?? null`);
const compactNotice = await evaluate(`new Promise((resolve) => {
  const start = Date.now();
  const tick = () => {
    const notice = document.querySelector('.chat-notice pre')?.textContent ?? '';
    if (notice && !notice.startsWith('Compacting')) return resolve(notice);
    if (Date.now() - start > 300000) return resolve(null);
    setTimeout(tick, 500);
  };
  tick();
})`);
const compactShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "compacted.png"), Buffer.from(compactShot.data, "base64"));
const compactTurn = table("codexTurns").find((turn) => turn.conversationId === chatId && turn.kind === "compact");
const afterCompact = await history();

// 4. The compacted thread still answers.
await type("This is an automated test. Reply with the single word pong.");
await evaluate(`document.querySelector('.chat-send').click(); true`);
const pong = await settled(240000) as string;
clearInterval(heartbeat);

const compactChecks = {
  compactStarted,
  compactNotice,
  compactTurn: compactTurn ? { status: compactTurn.status, error: compactTurn.error ?? null } : null,
  historyUnchanged: JSON.stringify(afterCompact) === JSON.stringify(afterSteer),
  replyAfterCompact: pong,
};

const pass = stopShownWhileEmpty && sendShownWithDraft && steerShownMs !== null && (steerShownMs as number) < 2000
  && steerChecks.replyEndsWithDone && steerChecks.highestNumberInReply <= 20
  && steerChecks.historyInOrder && steerChecks.assistantMessages === 1
  && replyTurns.length === 1 && steers.length === 1 && steers[0].status === "applied" && steers[0].turnId === replyTurns[0]._id
  && steerChecks.codexTurnIdRecorded && chat?.isRunning === false
  && runs.length === 2 && runs.every((run) => run.status === "ok")
  && (compactStarted ?? "").startsWith("Compacting") && compactNotice === COMPACTED
  && compactTurn?.status === "done" && compactChecks.historyUnchanged && /pong/i.test(pong)
  && errors.length === 0;
const result = {
  ranAt: new Date().toISOString(),
  chatId,
  reply: reply.slice(-400),
  steering: steerChecks,
  compaction: compactChecks,
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
