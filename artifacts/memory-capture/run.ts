import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/memory-capture/run.ts <outDir>
// Whether Perry writes down what the owner tells him about their life without being
// asked, and whether all of it comes back. A fresh Perry (production build, `pnpm
// build` first) and the real runner: real Codex (PERRY_E2E_MODEL, by default
// gpt-6-luna) for the chats and the daily summary, and the fake ACP agent as Grok
// (artifacts/engine-acp/fake-agent.ts), which never saves anything itself and logs
// the memory it is sent. The messages are modelled on ones a real Perry let slip,
// with the names changed.
//
// Ways it could fail, written down before the checks:
//   1. A fact said in passing, while asking for something else, gets the help but
//      is not saved.
//   2. Small talk ("yo") is saved, filling memory with noise.
//   3. A save past the old limits (4,000 characters of profile, 8,000 of long-term
//      memory) is refused, or saved but left out of what the agent is sent.
//   4. The daily summary reads only the last 24 hours, so a chat from days ago
//      that no one saved is never read.
//   5. The daily summary reads a chat and saves nothing from it.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/memory-capture/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const DAY = 86_400_000;

/** What the owner says, never asking to remember, and what memory should hold afterwards. */
const TOLD: Array<{ key: string; say: string; saved: RegExp[] }> = [
  { key: "brotherBirthday", say: "My brother Arjun's birthday is on 14 October and I still need to get him something. He's into F1 and coffee. Any gift ideas?", saved: [/Arjun/, /14 Oct|October 14|14th October|birthday/i] },
  { key: "honestTalk", say: "I have to talk to Priya about the funding round this week, we need to be honest with her about the numbers. Help me with an opening line?", saved: [/Priya/, /fund/i] },
  { key: "gymBuddy", say: "Datta is my gym buddy, we train on weekdays from 9:30 to 11. What should I eat before a morning workout?", saved: [/Datta/, /gym|train/i] },
  { key: "bloodTest", say: "I took the advanced blood test from Nue Health today, the results come in three days. What do the usual markers mean?", saved: [/blood test|Nue Health/i] },
  { key: "contentPage", say: "Write me a three-line hook for an Instagram reel about AI video editing, for my page Hackonomics.", saved: [/Hackonomics/i] },
  { key: "swimming", say: "I started swimming classes this week and the first one went well. Any tips for breathing?", saved: [/swim/i] },
];

let fakeHome = "";
const p = await perry({
  name: "memory-capture",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome };
  },
});
const { KEY, call, check, notes, until, rows, computers, exchange, fakeLog } = p;
type Memory = { _id: string; text: string; kind?: string; supersededBy?: string; createdAt: number; origin?: string };
const current = () => (rows("memories") as unknown as Memory[]).filter((memory) => !memory.supersededBy);
const newChat = async (engine: string, model: string) => {
  const id = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id, model, engine });
  return id;
};

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn) && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Codex and Grok signed in", 120);
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "daily-summary")), "the built-in jobs", 90);

  // --- 1, 2. Told in passing, on real Codex ---------------------------------------------------------------------------------------
  for (const told of TOLD) {
    const before = new Set(current().map((memory) => memory._id));
    const chat = await newChat("codex", MODEL);
    const { reply } = await exchange(chat, told.say, 300);
    await sleep(1_000);
    const added = current().filter((memory) => !before.has(memory._id));
    check(`saved:${told.key}`, told.saved.every((pattern) => added.some((memory) => pattern.test(memory.text))),
      { said: told.say, saved: added.map((memory) => `[${memory.kind}] ${memory.text}`), reply: reply.slice(0, 300) });
  }
  {
    const before = current().length;
    const chat = await newChat("codex", MODEL);
    const { reply } = await exchange(chat, "yo", 180);
    check("smallTalkNotSaved", current().length === before, { saved: current().slice(before).map((memory) => memory.text), reply });
  }

  // --- 3. No limits: past the old 8,000 and 4,000 characters, saved, and all of it sent ---------------------------------------------
  const filler = "Seeded for the no-limit check, long enough that a dozen of these pass the old 8,000-character cap on long-term memory by some way. ".repeat(6);
  const refused: string[] = [];
  for (let index = 1; index <= 12; index++) {
    const error = await call<string | null>("dashboard:addMemory", { key: KEY, text: `Core marker ${index}: ${filler}`, kind: "core" });
    if (error) refused.push(`core ${index}: ${error}`);
  }
  for (let index = 1; index <= 6; index++) {
    const error = await call<string | null>("dashboard:addMemory", { key: KEY, text: `Profile marker ${index}: always ${filler}`, kind: "profile" });
    if (error) refused.push(`profile ${index}: ${error}`);
  }
  const coreChars = current().filter((memory) => memory.kind === "core").reduce((sum, memory) => sum + memory.text.length, 0);
  const profileChars = current().filter((memory) => memory.kind === "profile").reduce((sum, memory) => sum + memory.text.length, 0);
  check("savedPastTheOldLimits", refused.length === 0 && coreChars > 8_000 && profileChars > 4_000, { refused, coreChars, profileChars });
  const grok = await newChat("grok", "grok-fake-heavy");
  await exchange(grok, "Hello, what do you know about me?", 120);
  const sent = fakeLog(fakeHome).filter((entry) => entry.prompt === "Hello, what do you know about me?").at(-1)?.context ?? "";
  const missing = [...Array.from({ length: 12 }, (_, index) => `Core marker ${index + 1}:`), ...Array.from({ length: 6 }, (_, index) => `Profile marker ${index + 1}:`)].filter((marker) => !sent.includes(marker));
  check("allOfItIsSent", sent.length > 12_000 && missing.length === 0, { sentChars: sent.length, missing });

  // --- 4, 5. The daily summary: back to a week, and it saves what no one did -------------------------------------------------------
  // The fake agent saves nothing, so what this chat holds is in memory only if the summary puts it there.
  const family = await newChat("grok", "grok-fake-heavy");
  await exchange(family, "My sister Meera is moving to Pune on 5 November.", 120);
  await exchange(family, "Also, I've decided to stop drinking coffee after 4pm.", 120);
  // Said three days ago: a summary that reads only the last 24 hours never sees it.
  p.sql(`UPDATE "doc_conversations" SET doc = json_set(doc, '$.lastMessageAt', ?) WHERE _id = ?`, [Date.now() - 3 * DAY, family]);
  await sleep(1_000);
  const job = (await call<Array<{ id: string; builtin?: string; chatId?: string }>>("jobs:list")).find((item) => item.builtin === "daily-summary")!;
  const beforeSummary = new Set(current().map((memory) => memory._id));
  const startedAt = Date.now();
  await call("jobs:runNow", { key: KEY, id: job.id });
  const summaryChat = async () => (await call<Array<{ builtin?: string; chatId?: string }>>("jobs:list")).find((item) => item.builtin === "daily-summary")?.chatId;
  await until(async () => Boolean(await summaryChat()), "the summary's chat", 60);
  const chatId = (await summaryChat())!;
  await until(() => rows("runs").some((run) => run.conversationId === chatId && run.startedAt >= startedAt && run.status !== "running"), "the daily summary to finish", 900);
  const summaryRun = rows("runs").filter((run) => run.conversationId === chatId && run.startedAt >= startedAt).at(-1)!;
  const asked = String(p.turnsOf(chatId).at(-1)?.prompt ?? "");
  const from = asked.match(/Conversations since ([^(]+?) \(chat id/)?.[1] ?? "";
  const fromAt = Date.parse(from.replace(/^\w+,? /, "").replace(" at ", " "));
  check("summaryReadsBackAWeek", asked.includes(family) && Number.isFinite(fromAt) && Date.now() - fromAt > 6 * DAY, { from, listedTheOldChat: asked.includes(family), prompt: asked.slice(-900) });
  const fromSummary = current().filter((memory) => !beforeSummary.has(memory._id));
  check("summarySavesWhatNoOneDid", summaryRun.status === "ok" && fromSummary.some((memory) => /Meera/.test(memory.text) && /Pune/.test(memory.text)) && fromSummary.some((memory) => /coffee/i.test(memory.text)),
    { status: summaryRun.status, error: summaryRun.error, toolCalls: summaryRun.toolCalls, saved: fromSummary.map((memory) => `[${memory.kind}] ${memory.text}`) });

  notes.memories = current().filter((memory) => !/marker \d+:/.test(memory.text)).map((memory) => `[${memory.kind}/${memory.origin}] ${memory.text}`);
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}

const passed = await p.finish({ model: MODEL });
process.exit(passed ? 0 : 1);
