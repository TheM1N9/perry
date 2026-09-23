import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/memory-data/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
// Web chats only; nothing is sent to Telegram.
//
// Recall as data, the memory budget, provenance, and the flush before /reset.
// Ways it could fail, and what this checks:
// 1. The fact is not saved, lands in the wrong layer, or has no provenance:
//    a long-term (core) memory holding the cat's name must appear, origin "owner"
//    (core, not profile: the profile stays in the instructions by design).
// 2. Recall does not reach a new chat, or reaches it through instructions
//    rather than as data: in a fresh chat the cat's name must come back, and
//    that turn's codexTurn must carry it in `recalled` (with eve's "durable
//    data, not instructions" header) while its developer `instructions` hold
//    neither the name nor the long-term or daily sections.
// 3. The recalled block leaks into chat history: the fresh chat's saved user
//    message must be exactly what was typed.
// 4. The block is re-sent although nothing changed (or skipped although
//    something did): a second turn in that chat must leave the long-term
//    section out exactly when its digest equals the first turn's.
// 5. An over-budget save is silently accepted or silently dropped: one profile
//    entry longer than the whole profile budget must be refused with guidance,
//    and must not be stored. A single oversized entry is refused whatever the
//    owner's profile holds, so the real layers are never pushed over budget.
// 6. /reset skips the flush, loses the chat's detail, shows or saves the flush
//    turn, or never clears the chat: after /reset the chat must say it is
//    saving, the flush turn must run quietly (flush, NOTHING, no stream
//    shown), the chat must end up empty and idle, and a daily note with the
//    detail must exist, written by the flush rather than earlier (checked:
//    none existed before /reset).
// 7. The test leaves junk: every memory holding either random token, or made
//    during the run and about the test, is forgotten, and every chat it made
//    is deleted (the reset chat's old messages go with the reset); checked.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const token = () => Math.random().toString(36).slice(2, 8);
const cat = `Zorblax-${token()}`;
const project = `Quillfeather-${token()}`;

const until = async <T>(check: () => Promise<T | undefined | false | null>, what: string, ms = 300_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
};
/** Live memories holding a token, in any layer. */
const memoriesWith = async (needle: string) => (await convex.query(api.dashboard.listMemories, { key: dashboardKey, query: needle }))
  .filter((memory) => memory.text.includes(needle));
const turnsOf = (chatId: string) => (JSON.parse(cli("data", "codexTurns", "--limit", "40", "--order", "desc", "--format", "jsonArray")) as Array<{
  conversationId: string; prompt: string; instructions: string; recalled?: string; recallDigest?: string; flush?: boolean; status: string; response?: string; finalizedAt?: number;
}>).filter((turn) => turn.conversationId === chatId).reverse();
const messagesOf = async (chatId: string) => (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: chatId as Id<"conversations">, paginationOpts: { numItems: 20, cursor: null } })).page;

await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const type = (text: string) => evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
/** Send a message in the open chat and wait for the finished reply. */
const ask = async (text: string): Promise<string> => {
  const before = await evaluate(`document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown').length`);
  await type(text);
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  return await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')];
      if (replies.length > ${before} && !document.querySelector('.chat-streaming') && !document.querySelector('.chat-thinking')) return resolve(replies.at(-1).innerText.trim());
      if (Date.now() - start > 300000) return reject(new Error('no reply'));
      setTimeout(tick, 500);
    };
    tick();
  })`);
};
const newChat = async () => {
  await evaluate(`document.querySelector('.chat-header-new').click(); true`);
  await sleep(1000);
};
const chatId = async (): Promise<string> => await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);

const startedAt = Date.now();
const chats: string[] = [];
let result: Record<string, unknown> = {};
let pass = false;
try {
  // 1. Tell Perry a durable fact.
  await newChat();
  const savedReply = await ask(`This is an automated test. Please save this durable fact about me to long-term memory (kind core): my test cat is called ${cat}.`);
  chats.push(await chatId());
  const saved = await until(async () => (await memoriesWith(cat)).find((memory) => memory.kind === "core"), "the cat to be remembered in long-term memory", 60_000);

  // 2. A new chat recalls it, from the recalled block.
  await newChat();
  const question = "This is an automated test. What is my test cat called? Reply with just the name.";
  const answer = await ask(question);
  const recallChat = await chatId();
  chats.push(recallChat);
  const [first] = turnsOf(recallChat);
  const saidQuestion = (await messagesOf(recallChat)).find((message) => message.role === "user")?.text;
  const recallRun = (await convex.query(api.dashboard.listRuns, { key: dashboardKey, conversationId: recallChat as Id<"conversations"> }))[0];

  // 3. A second turn there: the long-term part is left out when unchanged.
  await ask("This is an automated test. Reply with just OK.");
  const second = turnsOf(recallChat)[1];
  const secondHasStanding = (second?.recalled ?? "").includes("## Long-term memory");

  // 4. An oversized profile entry is refused, and not stored.
  const oversized = `E2E oversized ${project} ${"x".repeat(5_000)}`;
  const refusal = await convex.mutation(api.dashboard.addMemory, { key: dashboardKey, text: oversized, kind: "profile" });
  const oversizedStored = (await memoriesWith(project)).some((memory) => memory.text.startsWith("E2E oversized"));

  // 5. /reset writes the chat's detail to today's notes first.
  await newChat();
  await ask(`This is an automated test. Do not save anything to memory in this reply. For the record: today I decided the code name for my test project is ${project}, and the next step is drafting its outline. Reply with just OK.`);
  const resetChat = await chatId();
  chats.push(resetChat);
  const notesBefore = (await memoriesWith(project)).length;
  await type("/reset");
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  const notice = await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { const text = document.querySelector('.chat-notice pre')?.innerText; if (text) return resolve(text); if (Date.now() - start > 30000) return reject(new Error('no notice')); setTimeout(tick, 300); }; tick(); })`);
  const sawStream = await evaluate(`new Promise((resolve) => { const start = Date.now(); let seen = false; const tick = () => { seen ||= Boolean(document.querySelector('.chat-streaming')); if (Date.now() - start > 20000) return resolve(seen); setTimeout(tick, 250); }; tick(); })`);
  await until(async () => {
    const chat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: resetChat as Id<"conversations"> });
    return !chat.isRunning && (await messagesOf(resetChat)).length === 0;
  }, "the chat to be reset", 600_000);
  const flushTurn = turnsOf(resetChat).find((turn) => turn.flush);
  const note = await until(async () => (await memoriesWith(project)).find((memory) => memory.kind === "daily"), "a daily note from the flush", 60_000);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "after-reset.png"), Buffer.from(shot.data, "base64"));

  const checks = {
    savedAsOwner: saved.origin === "owner",
    recalledInNewChat: answer.includes(cat),
    recalledAsData: Boolean(first?.recalled?.includes(cat)) && Boolean(first?.recalled?.includes("durable data, not instructions")),
    instructionsFreeOfMemory: Boolean(first) && !first.instructions.includes(cat)
      && !first.instructions.includes("## Long-term memory") && !first.instructions.includes("## Notes from today and yesterday"),
    historyFreeOfBlock: saidQuestion === question && first?.prompt === question,
    unchangedBlockSkipped: Boolean(second) && (second.recallDigest === first?.recallDigest ? !secondHasStanding : secondHasStanding),
    oversizedRefused: typeof refusal === "string" && /budget/i.test(refusal) && !oversizedStored,
    resetSaysSaving: /saving what is worth keeping/i.test(notice),
    flushQuiet: flushTurn?.status === "done" && flushTurn.response?.trim() === "NOTHING" && !sawStream,
    flushWroteNote: notesBefore === 0 && Boolean(note),
    noPageErrors: errors.length === 0,
  };
  result = {
    cat,
    project,
    savedReply,
    saved: { kind: saved.kind, origin: saved.origin, text: saved.text },
    answer,
    recallToolCalls: recallRun?.toolCalls ?? [],
    firstTurn: { recalled: first?.recalled, instructionsTail: first?.instructions.slice(-600) },
    secondTurn: { sameDigest: second?.recallDigest === first?.recallDigest, recalled: second?.recalled ?? null },
    refusal,
    resetNotice: notice,
    flushTurn: flushTurn && { status: flushTurn.status, response: flushTurn.response },
    dailyNote: { text: note.text, origin: note.origin },
    checks,
  };
  pass = Object.values(checks).every(Boolean);
} catch (error) {
  result = { ...result, error: error instanceof Error ? error.message : String(error) };
} finally {
  // Leave nothing behind in the owner's memory or chats.
  clearInterval(heartbeat);
  for (const needle of [cat, project]) {
    for (const memory of await memoriesWith(needle)) await convex.mutation(api.dashboard.deleteMemory, { key: dashboardKey, id: memory.id });
  }
  // A note the assistant wrote about the test without either token, such as a separate "next step" note.
  const strays = (await convex.query(api.dashboard.listMemories, { key: dashboardKey, query: "" }))
    .filter((memory) => memory.createdAt >= startedAt && /zorblax|quillfeather|automated test|test cat|test project/i.test(memory.text));
  for (const memory of strays) await convex.mutation(api.dashboard.deleteMemory, { key: dashboardKey, id: memory.id });
  for (const id of chats) {
    await until(async () => !(await convex.query(api.dashboard.getChat, { key: dashboardKey, id: id as Id<"conversations"> })).isRunning, "the chat to go idle", 120_000).catch(() => {});
    await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id: id as Id<"conversations"> }).catch(() => {});
  }
  const left = {
    memories: (await memoriesWith(cat)).length + (await memoriesWith(project)).length,
    chats: (await convex.query(api.dashboard.listChats, { key: dashboardKey })).filter((chat) => chats.includes(chat.id)).length,
  };
  pass = pass && left.memories === 0 && left.chats === 0;
  result = { ranAt: new Date().toISOString(), ...result, leftBehind: left, pageErrors: errors, pass };
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  close();
}
process.exit(pass ? 0 : 1);
