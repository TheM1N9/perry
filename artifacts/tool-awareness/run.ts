import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";
import { ALL_TOOLS } from "../../convex/tools";

// bun artifacts/tool-awareness/run.ts <outDir>
// Every tool Perry has, and whether he knows to use it: a fresh Perry (production
// build, `pnpm build` first) and the real runner on real Codex (PERRY_E2E_MODEL, by
// default gpt-6-luna), asked in the owner's words for things each tool is for, and
// the tools he called read from the run's trace. He is also asked to name his tools,
// on Codex and on Claude Code when it is signed in. Approvals are all declined, so
// nothing runs on this computer beyond what needs none.
//
// Ways it could fail, written down before the checks:
//   1. A tool is served but never picked: he answers from what he knows, or says he
//      cannot, when the tool was there (the instructions never name it, or name it
//      for something else).
//   2. He picks the wrong tool: memory for a to-do, a job for a background task,
//      the shell or computer use for the web or the screen.
//   3. He goes ahead where the instructions say to stop: installs a skill before
//      the owner said yes, creates a job before confirming its time.
//   4. An engine is not given the tools at all, so asked to name them, it cannot.
//   5. A tool is named in the instructions but is not served, or the other way round.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/tool-awareness/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
/** PERRY_AWARENESS_ONLY=list,remember,...: only those checks ("list" is naming the tools). */
const ONLY = process.env.PERRY_AWARENESS_ONLY?.split(",").map((key) => key.trim()).filter(Boolean);
const runs = (key: string) => !ONLY || ONLY.includes(key);
const SERVED = [...Object.keys(ALL_TOOLS), "share_file", "take_longer", "look_at_screen"];

/** What the owner says, and the tools that should follow: each entry one tool, or any of several. */
type Scenario = { key: string; chat: string; say: string; expect: Array<string | string[]>; yes?: boolean; not?: string[]; orReply?: RegExp };
const SCENARIOS: Scenario[] = [
  // Memory and who the owner is
  { key: "remember", chat: "memory", say: "From now on, always spell things the British way in your replies.", expect: ["remember"] },
  { key: "recall", chat: "memory2", say: "What do you remember about me and how I like things?", expect: [["recall", "read_memory"]], orReply: /British/i },
  { key: "forget", chat: "memory", say: "Please forget the British spelling rule entirely, I don't want it kept.", expect: ["forget"], yes: true },
  { key: "update_user_md", chat: "me", say: "Some news: I moved to Bangalore last month and I run my own startup now, Prostack Labs.", expect: ["update_user_md"] },
  { key: "update_identity", chat: "me", say: "I'd like to call you Jarvis from now on.", expect: ["update_identity"] },
  // Keys
  { key: "save_secret", chat: "keys", say: "Here's my OpenWeather API key so you can check the weather for me: 0a1b2c3d4e5f60718293a4b5c6d7e8f9", expect: ["save_secret"] },
  { key: "list_secrets", chat: "keys2", say: "Which logins and keys do you have saved for me?", expect: ["list_secrets"] },
  { key: "use_secret", chat: "keys2", say: "Use my OpenWeather key to tell me the weather in Bangalore right now.", expect: ["use_secret"] },
  // Earlier chats (the Kyoto chat is sent first, below)
  { key: "search_chats", chat: "recall-chat", say: "What budget did we settle on for my Kyoto trip?", expect: ["search_chats", "read_chat"] },
  // The web and the screen
  { key: "read_page", chat: "web", say: "What does https://example.com say?", expect: ["read_page"] },
  { key: "browser", chat: "web", say: "Go to https://httpbin.org/forms/post and order a medium pizza with bacon for Sam, then tell me what the page shows after you submit it.", expect: ["browser"] },
  { key: "browser_submit", chat: "web", say: "Yes, submit it.", expect: ["browser"] },
  { key: "look_at_screen", chat: "screen", say: "What's this error on my screen?", expect: ["look_at_screen"] },
  { key: "share_file", chat: "files", say: "Write me a short haiku about the monsoon in a text file and show it to me here.", expect: ["share_file"] },
  // Connected accounts: none are connected in a fresh Perry
  { key: "list_connectors", chat: "apps", say: "Is there anything new in my Gmail from my bank?", expect: ["list_connectors"] },
  { key: "trigger", chat: "apps2", say: "Whenever a new email from my bank arrives, tell me what it says.", expect: [["list_connectors", "find_triggers"]] },
  // To-dos
  { key: "add_todo", chat: "todos", say: "Remind me to call Sam at 5pm today.", expect: ["add_todo"] },
  { key: "add_todo_2", chat: "todos", say: "Add milk to my list.", expect: ["add_todo"] },
  { key: "list_todos", chat: "todos2", say: "What's on my list?", expect: ["list_todos"] },
  { key: "update_todo", chat: "todos2", say: "I called Sam, that one's done.", expect: ["update_todo"] },
  { key: "delete_todo", chat: "todos2", say: "Take milk off the list, I don't need it after all.", expect: ["delete_todo"] },
  // Jobs
  { key: "create_job", chat: "jobs", say: "Every weekday at 8am, send me a short briefing of the top tech news.", expect: ["create_job"], yes: true },
  { key: "list_jobs", chat: "jobs2", say: "What's scheduled?", expect: [["list_jobs", "status_report"]] },
  { key: "update_job", chat: "jobs2", say: "Move the tech briefing to 9am.", expect: ["update_job"], yes: true },
  { key: "run_job", chat: "jobs2", say: "Run the tech briefing now, I want it today.", expect: ["run_job"] },
  { key: "delete_job", chat: "jobs2", say: "Actually, delete the tech briefing altogether.", expect: ["delete_job"], yes: true },
  // Goals, plans, watches
  { key: "set_goal", chat: "goals", say: "I want to run a half marathon by December. Keep track of it with me: a first 10k, then 15k, then the race.", expect: ["set_goal"] },
  { key: "update_goal", chat: "goals2", say: "I ran my first 10k this morning!", expect: ["update_goal"] },
  { key: "status_report", chat: "status", say: "What are you working on for me at the moment?", expect: ["status_report"] },
  { key: "watch_page", chat: "watch", say: "Let me know when https://example.com changes.", expect: ["watch_page"] },
  { key: "check_watches", chat: "watch2", say: "Check that example.com watch now.", expect: ["check_watches"] },
  { key: "update_watch", chat: "watch2", say: "Pause the example.com watch for now.", expect: ["update_watch"] },
  { key: "delete_watch", chat: "watch2", say: "Actually, stop watching example.com altogether.", expect: ["delete_watch"] },
  { key: "task_plan", chat: "plan", say: "Plan my wife's birthday dinner end to end: find three restaurants in Indiranagar, Bangalore that take groups of 20, compare them on price and reviews, pick the best, and draft the invitation text.", expect: ["start_task", "set_plan"] },
  // Skills, time, background work
  { key: "review_skill", chat: "skills", say: "Install this skill for me: https://github.com/anthropics/skills/tree/main/skills/pdf", expect: ["review_skill"], not: ["install_skill"] },
  { key: "install_skill", chat: "skills", say: "Looks fine, yes, install it.", expect: ["install_skill"] },
  { key: "queue_task", chat: "background", say: "No rush on this one: in the background, write me a three-line comparison of Notion and Obsidian, and get back to me here when it's done.", expect: ["queue_task"] },
];
// Tools no message here can reach: an app must be connected for these, or a background task must be stuck on a question.
const UNREACHABLE: Record<string, string> = {
  find_action: "needs a connected app (a fresh Perry has none, and no Composio key)",
  run_action: "needs a connected app",
  resume_task: "needs a background task stuck on a question",
  take_longer: "needs work that is really quiet for 15 minutes; artifacts/turn-watchdog checks it, on the fake agent",
};

const p = await perry({ name: "tool-awareness", outDir, runnerEnv: () => ({}) });
const { KEY, call, check, notes, until, rows, computers, exchange } = p;
type Span = { runId: string; kind: string; name: string; status: string; input?: string; output?: string };
const toolsIn = (chat: string, since: number) => {
  const runs = new Set(rows("runs").filter((run) => run.conversationId === chat && run.startedAt >= since).map((run) => run._id));
  return (rows("runSpans") as unknown as Span[]).filter((span) => runs.has(span.runId));
};
const declined: string[] = [];

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "the runner with Codex signed in", 120);
  // Every approval is declined: the test is about which tool he picks, not about running it.
  const decliner = setInterval(async () => {
    try {
      for (const item of await call<Array<{ id: string; kind: string; title?: string; detail?: string }>>("approvals:pending", { key: KEY })) {
        declined.push(`${item.kind}: ${String(item.title ?? item.detail ?? "").slice(0, 120)}`);
        await call("approvals:decide", { key: KEY, id: item.id, approved: false });
      }
    } catch {}
  }, 1_000);
  const chats = new Map<string, string>();
  const chatFor = async (name: string, engine = "codex", model = MODEL) => {
    if (chats.has(name)) return chats.get(name)!;
    const id = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id, model, engine });
    chats.set(name, id);
    return id;
  };

  // --- Asked to name them ---------------------------------------------------------------------------------------------
  const nameThem = "List every one of your own tools from your `assistant` MCP server, by exact name, one per line, and nothing else.";
  const named = (reply: string) => SERVED.filter((tool) => new RegExp(`(^|[^a-z_]|__)${tool}([^a-z_]|$)`).test(reply));
  let codexNamed: string[] = [];
  if (runs("list")) {
  const codexList = await exchange(await chatFor("list"), nameThem, 240);
  codexNamed = named(codexList.reply);
  check("codexNamesEveryTool", codexNamed.length === SERVED.length, { named: codexNamed.length, of: SERVED.length, missing: SERVED.filter((tool) => !codexNamed.includes(tool)), reply: codexList.reply.slice(0, 3000) });
  const options = await call<{ models: Array<{ id: string; engine?: string; isDefault?: boolean }> }>("models:options", { key: KEY });
  const claudeModel = options.models.find((model) => model.engine === "claude" && model.isDefault)?.id ?? options.models.find((model) => model.engine === "claude")?.id;
  if (claudeModel) {
    const claudeList = await exchange(await chatFor("list-claude", "claude", claudeModel), nameThem, 240).catch((error) => ({ reply: String(error) }));
    const claudeNamed = named(claudeList.reply);
    check("claudeNamesEveryTool", claudeNamed.length === SERVED.length, { model: claudeModel, named: claudeNamed.length, of: SERVED.length, missing: SERVED.filter((tool) => !claudeNamed.includes(tool)), reply: claudeList.reply.slice(0, 3000) });
  } else {
    notes.claudeNamesEveryTool = "Claude Code is not signed in on this computer: not asked";
  }
  }

  // --- Asked for things, in the owner's words -------------------------------------------------------------------------------
  if (runs("search_chats")) await exchange(await chatFor("kyoto"), "Let's plan my Kyoto trip in March: a ryokan in Gion, and let's keep the whole trip under ₹2.4 lakh.", 240).catch(() => {});
  const results: Array<Record<string, unknown>> = [];
  const used = new Set<string>();
  for (const scenario of SCENARIOS.filter((item) => runs(item.key))) {
    const chat = await chatFor(scenario.chat);
    const since = Date.now();
    let reply = "";
    try {
      reply = (await exchange(chat, scenario.say, 300)).reply;
      const called = () => toolsIn(chat, since).filter((span) => span.kind === "mcpToolCall").map((span) => span.name);
      // A memory Perry recalled into the prompt by itself needs no tool to answer from.
      const met = () => scenario.expect.every((want) => (Array.isArray(want) ? want : [want]).some((tool) => called().includes(tool))) || Boolean(scenario.orReply?.test(reply));
      const heldBack = (scenario.not ?? []).filter((tool) => called().includes(tool));
      // Where the instructions say to confirm first (a job's time), the owner's yes is the next message.
      await sleep(2_000);
      if (!met() && scenario.yes) reply += `\n[owner: Yes, go ahead.]\n${(await exchange(chat, "Yes, go ahead.", 300)).reply}`;
      const spans = toolsIn(chat, since);
      for (const name of spans.filter((span) => span.kind === "mcpToolCall").map((span) => span.name)) used.add(name);
      check(`uses:${scenario.key}`, met() && heldBack.length === 0, {
        said: scenario.say, expected: scenario.expect, called: called(), ...(heldBack.length ? { wentAheadWith: heldBack } : {}),
        otherSteps: spans.filter((span) => span.kind !== "mcpToolCall" && span.kind !== "reasoning").map((span) => `${span.kind}: ${span.name.slice(0, 80)}`),
        reply: reply.slice(0, 500),
        ...(met() ? {} : { runs: rows("runs").filter((run) => run.conversationId === chat).map((run) => ({ id: run._id, startedAt: run.startedAt, since, status: run.status, toolCalls: run.toolCalls, spans: (rows("runSpans") as unknown as Span[]).filter((span) => span.runId === run._id).map((span) => `${span.kind}:${span.name}`) })) }),
      });
      results.push({ key: scenario.key, called: called(), passed: p.checks[`uses:${scenario.key}`] });
    } catch (error) {
      check(`uses:${scenario.key}`, false, { said: scenario.say, error: String(error), reply: reply.slice(0, 300) });
    }
    await sleep(500);
  }
  clearInterval(decliner);

  // --- The map --------------------------------------------------------------------------------------------------------------------------
  const instructions = (await import("../../convex/assistant")).INSTRUCTIONS;
  const map = SERVED.map((tool) => ({
    tool,
    inInstructions: new RegExp(`(^|[^a-z_])${tool}([^a-z_]|$)`).test(instructions),
    namedByCodex: codexNamed.includes(tool),
    usedWhenAsked: used.has(tool) ? true : UNREACHABLE[tool] ? `not reached: ${UNREACHABLE[tool]}` : false,
  }));
  if (!ONLY) writeFileSync(join(outDir, "map.json"), `${JSON.stringify(map, null, 2)}\n`);
  notes.neverUsed = map.filter((row) => row.usedWhenAsked === false).map((row) => row.tool);
  notes.declinedApprovals = declined;
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}

const passed = await p.finish({ engine: "codex", model: MODEL, served: SERVED.length });
process.exit(passed ? 0 : 1);
