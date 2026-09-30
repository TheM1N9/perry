import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// bun artifacts/claude-warm/stand-in.ts <workDir> [outDir]
// The Claude Code engine (runner/engines/claude.ts) after #145 met #147, on a
// stand-in `claude` (fake-claude.js) that speaks the SDK's stream-json
// protocol: for when the owner's Claude Code cannot be used (rate-limited),
// and so none of it is. The real Claude Agent SDK starts the stand-in the way
// it would start Claude Code, from a claude.cmd first on a PATH that holds
// nothing else of the owner's, in a home (USERPROFILE, CLAUDE_CONFIG_DIR,
// CODEX_HOME, PERRY_HOME) under <workDir>. It stops before any turn unless
// the engine found the stand-in and `claude auth status` is the stand-in's.
//
// Ways it could fail, written down before the checks:
//   1. Every turn still starts a `claude` of its own, or a later turn loses
//      the session (a resumed process does not recall the first turn).
//   2. A message sent mid-turn does not join it on a kept process.
//   3. An access change mid-reply is not taken at once: a reply put on Full
//      access still asks the owner, or one put on Ask still goes ahead.
//   4. An access change restarts the process, mid-reply or at the next turn,
//      where only the permission mode needed switching (on Windows, where
//      Claude Code has no sandbox, it never needs a new one).
//   5. A kept process runs a later turn on the old mode (the change between
//      turns is not switched), or its instructions still describe the old
//      access and nothing tells it otherwise; or it is told at every turn.
//   6. A changed model or instructions is ignored: the kept process goes on.
//   7. After a stop the chat is broken.
//   8. Kept processes pile up: none is closed when idle or when too many run.
//   9. What main added stops working: the plan's limits (usage), the CLI's
//      version and update command, the skills folder among Claude Code's
//      directories.

const [workArg, outArg] = process.argv.slice(2);
if (!workArg) throw new Error("usage: bun artifacts/claude-warm/stand-in.ts <workDir> [outDir]");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = resolve(workArg, `run-${Date.now()}`);
const OUT = resolve(outArg ?? join(REPO, "artifacts", "claude-warm", "stand-in"));
const bin = join(WORK, "bin");
const fakeHome = join(WORK, "fake-claude");
const perryHome = join(WORK, "perry");
const userHome = join(WORK, "user");
for (const dir of [join(bin, "claude-code"), fakeHome, perryHome, userHome, join(WORK, "claude-config"), join(WORK, "codex-home"), join(WORK, "chat")]) mkdirSync(dir, { recursive: true });
const cli = join(bin, "claude-code", "cli.js");
copyFileSync(join(REPO, "artifacts", "claude-warm", "fake-claude.js"), cli);
// As npm's shim for a cli.js, which findClaude reads through.
writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "%~dp0\\claude-code\\cli.js" %*\r\n`);

// Nothing of the owner's: the stand-in first, then only the runtimes and Windows.
const system = process.env.SystemRoot ?? "C:\\Windows";
const node = process.platform === "win32" ? "C:\\Program Files\\nodejs" : "/usr/bin";
process.env.PATH = [bin, dirname(process.execPath), node, join(system, "System32"), system].join(process.platform === "win32" ? ";" : ":");
Object.assign(process.env, {
  PERRY_HOME: perryHome, USERPROFILE: userHome, HOME: userHome, CLAUDE_CONFIG_DIR: join(WORK, "claude-config"), CODEX_HOME: join(WORK, "codex-home"),
  FAKE_CLAUDE_HOME: fakeHome, PERRY_CLAUDE_IDLE_MIN: "0.25", PERRY_CLAUDE_LIVE: "2",
});
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) delete process.env[name];

const { ClaudeEngine, findClaude } = await import("../../runner/engines/claude");
const { PATHS } = await import("../../runner/home");
const { updateOf } = await import("../../convex/lib/engines");
type Engine = InstanceType<typeof ClaudeEngine>;

const found = findClaude();
if (homedir() !== userHome || found?.sdkPath !== cli) {
  console.error(`stopped: the engine would run ${found?.sdkPath ?? found?.command ?? "nothing"} (home ${homedir()}), not the stand-in`);
  process.exit(1);
}
const engine: Engine = new ClaudeEngine((line) => console.log(`warn: ${line}`));
const status = await engine.status();
if (status.auth.email !== "stand-in@example.com") {
  console.error(`stopped: signed in as ${status.auth.email ?? "nobody"}, not the stand-in`);
  process.exit(1);
}

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks[name] = ok;
  if (detail !== undefined) notes[name] = detail;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
type Entry = { at: number; pid: number; event: string; [key: string]: any };
const entries = (): Entry[] => existsSync(join(fakeHome, "log.jsonl")) ? readFileSync(join(fakeHome, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

type Chat = { cursor?: string; instructions: string; model?: string };
type Ran = { state: string; text: string; pid?: number; asked: string[]; handle?: { cursor: string; turnId: string }; blocks: string[]; since: number };
const INSTRUCTIONS = "You are Perry, the owner's assistant (stand-in instructions one).";
/** One turn on a chat, answering the owner's requests with `answer`, and `during` once it has started. */
async function turn(chat: Chat, prompt: string, access: "supervised" | "auto" | "full", options: { answer?: string; during?: (handle: { cursor: string; turnId: string }, asked: string[]) => Promise<void> } = {}): Promise<Ran> {
  const since = Date.now();
  const asked: string[] = [];
  let handle: Ran["handle"];
  let during: Promise<void> | undefined;
  const result = await engine.runTurn({
    resumeCursor: chat.cursor, instructions: chat.instructions, prompt, attachments: [], cwd: join(WORK, "chat"), model: chat.model, access,
  }, {
    onSession: async (cursor) => { chat.cursor = cursor; },
    onStarted: (started) => { handle = started; if (options.during) during = options.during(started, asked); },
    onRequest: async (request) => {
      asked.push(String((request.raw as { tool?: string }).tool));
      return options.answer ?? "allow";
    },
  });
  await during;
  const mine = entries().filter((entry) => entry.at >= since && entry.event === "turn" && entry.session === chat.cursor);
  const last = mine.at(-1);
  return { state: result.state, text: result.text, pid: last?.pid, asked, handle, blocks: last?.blocks ?? [], since };
}
const startsOf = (session: string) => entries().filter((entry) => entry.event === "start" && entry.session === session);
const controlsOf = (pid: number | undefined, since: number, subtype: string) => entries().filter((entry) => entry.pid === pid && entry.at >= since && entry.event === "control" && entry.subtype === subtype);
const steps = (pid: number | undefined, since: number) => entries().filter((entry) => entry.pid === pid && entry.at >= since && entry.event === "step").map((entry) => `${entry.tool}:${entry.got}@${entry.mode}`);
const until = async (test: () => boolean, ms: number) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (test()) return true; return test(); };
const noted = (ran: Ran) => ran.blocks.some((block) => block.startsWith("The owner changed this chat's access"));

try {
  const a: Chat = { instructions: INSTRUCTIONS };

  // 1. Three turns, one process, one session.
  const one = await turn(a, "REMEMBER 7481", "supervised");
  const two = await turn(a, "RECALL", "supervised");
  const three = await turn(a, "SAY OK", "supervised");
  check("laterTurnsUseTheSameProcess", Boolean(one.pid) && one.pid === two.pid && two.pid === three.pid && startsOf(a.cursor!).length === 1, { pids: [one.pid, two.pid, three.pid], starts: startsOf(a.cursor!).length });
  check("itRemembersTheFirstTurn", one.text === "NOTED" && two.text === "7481" && three.text === "OK", [one.text, two.text, three.text]);
  const start = startsOf(a.cursor!)[0];
  check("skillsFolderIsAmongItsDirectories", start.addDirs.includes(PATHS.skills) && start.addDirs.includes(PATHS.files) && start.addDirs.includes(PATHS.uploads), start.addDirs);

  // 2. A message mid-turn joins it.
  const steered = await turn(a, "SLOW PEAR", "supervised", { during: async (handle) => { await sleep(1_000); await engine.steer!(handle, { prompt: "BANANA", attachments: [] }); } });
  check("aMessageMidTurnJoinsIt", steered.text === "PEAR BANANA" && steered.pid === one.pid, { reply: steered.text, pid: steered.pid });

  // 3. Ask, put on Full access mid-reply: from its next step nothing waits for the owner, on the same process.
  const toFull = await turn(a, "STEPS ONE", "supervised", {
    during: async (handle, asked) => { await until(() => asked.length >= 1, 5_000); await engine.setAccess!(handle, "full"); },
  });
  check("askThenFullMidReplyGoesAhead", toFull.asked.join() === "Write" && toFull.text === "Write:allow Write:mode Bash:allow" && toFull.pid === one.pid
    && controlsOf(one.pid, toFull.since, "set_permission_mode").map((entry) => entry.mode).join() === "acceptEdits",
    { askedOwner: toFull.asked, reply: toFull.text, steps: steps(toFull.pid, toFull.since), pid: toFull.pid });

  // 4. The next turn on Full access: the same process, already in its mode, told once that the access changed.
  const afterFull = await turn(a, "SAY STILL", "full");
  check("theNextTurnKeepsTheProcessAndIsTold", afterFull.text === "STILL" && afterFull.pid === one.pid && noted(afterFull)
    && controlsOf(one.pid, afterFull.since, "set_permission_mode").length === 0, { pid: afterFull.pid, blocks: afterFull.blocks });

  // 5. Full access, put on Ask mid-reply: its later steps wait for the owner, who declines.
  const askFrom = Date.now();
  const toAsk = await turn(a, "STEPS TWO", "full", {
    answer: "deny",
    during: async (handle) => {
      await until(() => entries().some((entry) => entry.at >= askFrom && entry.event === "step" && entry.got === "mode"), 5_000);
      await engine.setAccess!(handle, "supervised");
    },
  });
  check("fullThenAskMidReplyAsks", toAsk.text === "Write:mode Write:deny Bash:deny" && toAsk.asked.join() === "Write,Bash" && toAsk.pid === one.pid && !noted(toAsk)
    && controlsOf(one.pid, toAsk.since, "set_permission_mode").map((entry) => entry.mode).join() === "default",
    { askedOwner: toAsk.asked, reply: toAsk.text, steps: steps(toAsk.pid, toAsk.since), pid: toAsk.pid });

  // 6. Changed between turns (Ask to Auto): switched before the message, on the same process; told once.
  const toAuto = await turn(a, "STEPS THREE", "auto");
  const autoAgain = await turn(a, "SAY AGAIN", "auto");
  check("aChangeBetweenTurnsSwitchesTheKeptProcess", toAuto.text === "Write:mode Write:mode Bash:allow" && toAuto.asked.join() === "Bash" && toAuto.pid === one.pid
    && controlsOf(one.pid, toAuto.since, "set_permission_mode").map((entry) => entry.mode).join() === "acceptEdits" && noted(toAuto) && !noted(autoAgain) && autoAgain.pid === one.pid,
    { askedOwner: toAuto.asked, reply: toAuto.text, note: toAuto.blocks.find((block) => block.startsWith("The owner changed")), laterNote: noted(autoAgain) });
  check("accessNeverRestartedIt", startsOf(a.cursor!).length === 1, { starts: startsOf(a.cursor!).length });

  // 7. Another model: a new process, resuming the session.
  a.model = "stand-in-b";
  const modelled = await turn(a, "RECALL", "auto");
  const modelStart = startsOf(a.cursor!).at(-1)!;
  check("aChangedModelStartsANewProcess", modelled.pid !== one.pid && modelled.text === "7481" && modelStart.resumed && modelStart.model === "stand-in-b" && modelStart.mode === "acceptEdits"
    && await until(() => !alive(one.pid!), 5_000), { pid: modelled.pid, reply: modelled.text, start: { resumed: modelStart.resumed, model: modelStart.model, mode: modelStart.mode }, oldGone: !alive(one.pid!) });

  // 8. Other instructions: a new process, started with them and the access's own words.
  a.instructions = "You are Perry (stand-in instructions two).";
  const instructed = await turn(a, "SAY FRESH", "auto");
  const append = controlsOf(instructed.pid, instructed.since, "initialize")[0]?.append as string | undefined;
  check("changedInstructionsStartANewProcess", instructed.pid !== modelled.pid && instructed.text === "FRESH" && Boolean(append?.includes("stand-in instructions two")) && Boolean(append?.includes("checked by a reviewer")) && !noted(instructed),
    { pid: instructed.pid, appendStarts: append?.slice(0, 60) });

  // 9. Stopped, then asked again.
  const stopped = await turn(a, "SLEEP", "auto", { during: async (handle) => { await sleep(1_000); await engine.interrupt(handle); } });
  const again = await turn(a, "RECALL", "auto");
  check("aStoppedTurnLeavesTheChatWorking", stopped.state === "interrupted" && again.state === "completed" && again.text === "7481", { stopped: stopped.state, again: again.text, pids: [stopped.pid, again.pid] });

  // 10. At most PERRY_CLAUDE_LIVE (2) at once: a third chat closes the one idle longest.
  const b: Chat = { instructions: INSTRUCTIONS };
  const c: Chat = { instructions: INSTRUCTIONS };
  const onB = await turn(b, "SAY B", "full");
  const onC = await turn(c, "SAY C", "full");
  check("tooManyCloseTheIdlest", onB.text === "B" && onC.text === "C" && await until(() => !alive(again.pid!), 5_000) && alive(onB.pid!) && alive(onC.pid!),
    { a: [again.pid, alive(again.pid!)], b: [onB.pid, alive(onB.pid!)], c: [onC.pid, alive(onC.pid!)] });

  // 11. Left alone (PERRY_CLAUDE_IDLE_MIN 0.25 here), each is closed.
  const idleClosed = await until(() => !alive(onB.pid!) && !alive(onC.pid!), 30_000);
  check("anIdleProcessIsClosed", idleClosed, { closedWithin: "15 s idle + 15 s" });

  // 12. What main added: the plan's limits, and the CLI's version with its update.
  const limits = await engine.limits!();
  check("limitsAreRead", limits?.plan === "max" && limits.windows.some((window) => window.id === "five_hour" && window.usedPercent === 42), limits);
  // Asked afresh, as a runner starting would (the engine keeps a version it read for ten minutes).
  writeFileSync(join(fakeHome, "version"), "2.0.0");
  const old = await new ClaudeEngine().status();
  check("aCliTooOldIsSeen", old.version === "2.0.0" && updateOf({ kind: "claude", version: old.version })?.need === "required" && Boolean(old.update),
    { version: old.version, need: updateOf({ kind: "claude", version: old.version })?.need, update: old.update });

  // None but the stand-in ran: every process the engine started logged itself.
  const pids = new Set(entries().filter((entry) => entry.event === "start").map((entry) => entry.pid));
  notes.processesStarted = pids.size;
} catch (error) {
  check("ran", false, String(error instanceof Error ? error.stack : error));
} finally {
  engine.kill();
}

mkdirSync(OUT, { recursive: true });
const passed = Object.values(checks).filter(Boolean).length;
writeFileSync(join(OUT, "result.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform, runtime: `${process.release.name} ${process.version}`, stand_in: "artifacts/claude-warm/fake-claude.js", passed: `${passed} of ${Object.keys(checks).length}`, checks, notes }, null, 2)}\n`);
writeFileSync(join(OUT, "fake-claude-log.jsonl"), readFileSync(join(fakeHome, "log.jsonl"), "utf8"));
console.log(`${passed} of ${Object.keys(checks).length}; ${join(OUT, "result.json")}`);
process.exit(0);
