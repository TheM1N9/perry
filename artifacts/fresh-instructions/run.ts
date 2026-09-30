import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/fresh-instructions/run.ts <outDir> [--acp]
// A chat that is already going hears what changed in its instructions (issue
// #141): a fresh Perry (production build, `pnpm build` first), the real runner
// on real Codex (PERRY_E2E_MODEL, by default gpt-6-luna), and the fake ACP agent
// as Grok beside it (artifacts/engine-acp/fake-agent.ts).
//
// Codex, in one chat: the assistant is renamed between messages, then the chat's
// access changes, then the runner restarts and it is renamed again, then the
// chat's record of what its thread was told is lost (as for a chat from before).
// Each time, the thread's own saved history (its rollout in CODEX_HOME) shows
// what it was told. Grok (ACP), in one chat: renamed between messages too, and
// the fake agent's log shows each prompt. Then the owner's USER.md gets two
// paragraphs and they swap places, and prompts the agent turns away are
// followed by one it takes. `--acp` runs the ACP part alone, with no Codex turns
// (Codex signed out, in an empty CODEX_HOME).
//
// Ways it could fail, written down before the checks:
//   1. A resumed Codex chat still answers with the old name: its thread kept the
//      instructions it started with.
//   2. The change is told again with every message, or the whole instructions
//      are, so the chat's context grows each turn for nothing.
//   3. What changed is told, but not what no longer applies (the sandbox rules
//      once the chat is on Full access).
//   4. After the runner restarts, the change is missed (what the thread was told
//      was only in memory) or everything is told again.
//   5. A chat whose record is gone never hears its current instructions, or
//      fails.
//   6. An ACP session gets the whole preamble again with every message, or
//      never hears the change.
//   7. Paragraphs that only swap places are not told, so a later one that
//      qualifies an earlier one no longer does.
//   8. A prompt the agent turned away counts as having told the session its
//      instructions, so the next one leaves them out.

const [outDir, part] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/fresh-instructions/run.ts <outDir> [--acp]");
const ACP_ONLY = part === "--acp";
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const CHANGED = "# Your instructions changed";
const IN_FULL = "# Your instructions, as they are now";
let fakeHome = "";
const p = await perry({
  name: "fresh-instructions",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    // Signed in already: sign-in is artifacts/engine-grok's to check.
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "");
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, ...(ACP_ONLY ? { CODEX_HOME: join(home, "no-codex") } : {}) };
  },
});
const { KEY, call, check, notes, until, computers, exchange, fakeLog, conversation, getChat } = p;

/** What a Codex thread's saved history holds: the developer messages Perry put there, in order. */
const SESSIONS = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
function developerMessages(thread: string): string[] {
  const file = readdirSync(SESSIONS, { recursive: true, encoding: "utf8" }).find((name) => name.endsWith(`${thread}.jsonl`));
  if (!file) return [];
  return readFileSync(join(SESSIONS, file), "utf8").split("\n").filter(Boolean).flatMap((line) => {
    const entry = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: Array<{ text?: string }> } };
    if (entry.type !== "response_item" || entry.payload?.type !== "message" || entry.payload.role !== "developer") return [];
    const text = (entry.payload.content ?? []).map((part) => part.text ?? "").join("\n");
    return text.includes(CHANGED) || text.includes(IN_FULL) ? [text] : [];
  });
}
const rename = (name: string) => call("persona:writeIdentity", { name, by: "owner" });

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  let runner = p.start("runner");
  const ready = () => until(async () => (await computers()).some((item) => item.online && (ACP_ONLY || item.engines.some((engine) => engine.kind === "codex" && engine.signedIn))
    && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Codex and Grok signed in", 120);
  await ready();
  const askName = "This is an automated test. What is your name? Reply with only your name.";

  // --- Codex -------------------------------------------------------------------------------------------
  if (ACP_ONLY) notes.codex = "not run: --acp";
  else {
    const chat = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id: chat, model: MODEL, engine: "codex" });
    const first = await exchange(chat, askName, 180);
    const thread = (await conversation(chat)).resume?.cursor as string;
    notes.thread = thread;

    await rename("Jarvis-Nine");
    const renamed = await exchange(chat, askName, 180);
    const afterRename = developerMessages(thread);
    check("codexHearsTheNewName", /Jarvis-Nine/i.test(renamed.reply) && afterRename.length === 1 && afterRename[0].includes("Jarvis-Nine") && !afterRename[0].includes(IN_FULL),
      { first: first.reply, renamed: renamed.reply, told: afterRename.map((text) => text.slice(0, 600)) });

    await exchange(chat, "This is an automated test. Reply with the single word OK.", 180);
    check("nothingToldWhenNothingChanged", developerMessages(thread).length === 1, { told: developerMessages(thread).length });

    await call("dashboard:setChatAccess", { key: KEY, id: chat, access: "full" });
    await exchange(chat, "This is an automated test. Reply with the single word OK.", 180);
    const afterAccess = developerMessages(thread);
    const accessUpdate = afterAccess.at(-1) ?? "";
    check("accessChangeSaysWhatNoLongerApplies", afterAccess.length === 2 && /No longer part of your instructions/.test(accessUpdate) && /sandbox/i.test(accessUpdate),
      { told: accessUpdate.slice(0, 1500) });

    // A new runner and app-server: what the thread was told is kept in Perry's home.
    p.stop(runner);
    await sleep(3_000);
    runner = p.start("runner");
    await ready();
    await rename("Orion-Two");
    const restarted = await exchange(chat, askName, 180);
    const afterRestart = developerMessages(thread);
    check("afterARestartOnlyTheChangeIsTold", /Orion-Two/i.test(restarted.reply) && afterRestart.length === 3 && afterRestart[2].includes("Orion-Two") && !afterRestart[2].includes(IN_FULL),
      { reply: restarted.reply, told: afterRestart.at(-1)?.slice(0, 600) });

    // A chat from before Perry kept track: told all of its instructions, once.
    rmSync(join(p.home, "codex-instructions", `${thread}.md`), { force: true });
    const unknown = await exchange(chat, askName, 180);
    await exchange(chat, "This is an automated test. Reply with the single word OK.", 180);
    const afterLoss = developerMessages(thread);
    check("aChatWithNoRecordIsToldEverythingOnce", /Orion-Two/i.test(unknown.reply) && afterLoss.length === 4 && afterLoss[3].includes(IN_FULL),
      { reply: unknown.reply, told: afterLoss.length });
  }

  // --- ACP (the fake agent as Grok) ------------------------------------------------------------------------
  await rename("Perry");
  const grok = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: grok, model: "grok-fake-heavy", engine: "grok" });
  const prompts = () => fakeLog(fakeHome).filter((entry) => typeof entry.prompt === "string" && String(entry.prompt).includes("automated ACP"));
  await exchange(grok, "This is an automated ACP test, one.", 120);
  await exchange(grok, "This is an automated ACP test, two.", 120);
  await rename("Nova-Three");
  await exchange(grok, "This is an automated ACP test, three.", 120);
  const [one, two, three] = prompts().map((entry) => String(entry.context ?? ""));
  check("acpFirstPromptHasTheInstructions", /<perry-instructions>/.test(one ?? "") && !(one ?? "").includes(CHANGED), { context: one?.slice(0, 300) });
  check("acpNothingWhenNothingChanged", !/<perry-instructions>/.test(two ?? ""), { context: two?.slice(0, 300) });
  check("acpHearsOnlyTheChange", (three ?? "").includes(CHANGED) && (three ?? "").includes("Nova-Three") && (three ?? "").length < (one ?? "").length / 2,
    { context: three?.slice(0, 800), firstLength: one?.length, thirdLength: three?.length });

  // The same paragraphs, reordered: a later one can qualify an earlier one, so all of them are told again.
  await call("persona:writeUser", { text: "I live in Lisbon.\n\nI work nights, so mornings are for sleep.", by: "owner" });
  await exchange(grok, "This is an automated ACP test, four.", 120);
  await call("persona:writeUser", { text: "I work nights, so mornings are for sleep.\n\nI live in Lisbon.", by: "owner" });
  await exchange(grok, "This is an automated ACP test, five.", 120);
  const [four = "", five = ""] = prompts().slice(3).map((entry) => String(entry.context ?? ""));
  const owner = five.indexOf("## About the owner");
  check("acpHearsAReorder", four.includes(CHANGED) && four.includes("I live in Lisbon.") && five.includes(IN_FULL) && owner >= 0
    && five.indexOf("I work nights", owner) < five.indexOf("I live in Lisbon.", owner),
    { four: four.slice(0, 600), five: five.slice(0, 200), fiveAboutTheOwner: five.slice(owner, owner + 200) });

  // A prompt the agent turns away has told the session nothing: the next one carries it again.
  const rejected = () => fakeLog(fakeHome).filter((entry) => typeof entry.rejected === "string");
  const turnedAway = async (chat: string, text: string) => {
    const before = rejected().length;
    await call("dashboard:sendChat", { key: KEY, id: chat, text });
    await until(async () => rejected().length > before && !(await getChat(chat)).isRunning, `"${text}" to be turned away`, 60);
    return String(rejected().at(-1)?.context ?? "");
  };
  await rename("Vega-Four");
  const away = await turnedAway(grok, "REJECT This is an automated ACP test, six.");
  await exchange(grok, "This is an automated ACP test, seven.", 120);
  const seven = String(prompts().at(-1)?.context ?? "");
  check("acpUpdateToldAgainAfterARejectedPrompt", away.includes("Vega-Four") && seven.includes(CHANGED) && seven.includes("Vega-Four"),
    { rejected: away.slice(0, 400), seven: seven.slice(0, 600) });
  const fresh = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: fresh, model: "grok-fake-heavy", engine: "grok" });
  const awayFirst = await turnedAway(fresh, "REJECT This is an automated ACP test, eight.");
  await exchange(fresh, "This is an automated ACP test, nine.", 120);
  const nine = String(prompts().at(-1)?.context ?? "");
  check("acpPreambleToldAgainAfterARejectedFirstPrompt", /<perry-instructions>/.test(awayFirst) && /<perry-instructions>/.test(nine) && nine.includes("Your name is Vega-Four.") && !nine.includes(CHANGED),
    { rejected: awayFirst.slice(0, 200), nine: nine.slice(0, 300), nineLength: nine.length });
  notes.model = ACP_ONLY ? "grok-fake-heavy (the fake ACP agent)" : MODEL;
  process.exit(await p.finish() ? 0 : 1);
} catch (error) {
  check("ran", false, String(error));
  await p.finish();
  process.exit(1);
}
