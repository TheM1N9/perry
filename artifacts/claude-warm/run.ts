import { spawnSync } from "node:child_process";
import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/claude-warm/run.ts <outDir>
// A chat's Claude Code kept running between its turns (issue #140): a fresh
// Perry (production build, `pnpm build` first) and the real runner on the
// owner's own Claude Code, signed in with their subscription. Which `claude`
// answered each turn is read from the runner's own child processes.
//
//   1. Three messages in one chat: the first starts Claude Code, the next two
//      go to the same process, sooner, and it remembers the first.
//   2. A message sent while a turn runs joins it (steering), on a kept process.
//   3. A stopped turn: the next message still gets its answer.
//   4. The chat's access changes (Full to Auto): its next turn runs on the same
//      process, switched to the new mode (#147). Its model changes: the next
//      turn runs on a new process.
//   5. Left alone, the chat's process is closed (PERRY_CLAUDE_IDLE_MIN, short here).
//
// Ways it could fail, written down before the checks:
//   1. Every turn still starts a `claude` of its own, so nothing is faster.
//   2. A kept process loses the conversation, or hands one turn's words to
//      another turn (a reply shows up a turn late, or twice).
//   3. A message sent mid-turn is dropped, or answered as a turn of its own.
//   4. After a stop the kept process is broken, and the next message fails.
//   5. A change the process was started with (the model) is ignored: the kept
//      process goes on with the old one. Or one it can switch (access) starts
//      a new process for nothing.
//   6. A kept process is never closed, and they pile up.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/claude-warm/run.ts <outDir>");
const IDLE_MIN = 0.75;

const p = await perry({ name: "claude-warm", outDir, runnerEnv: () => ({ PERRY_CLAUDE_IDLE_MIN: String(IDLE_MIN) }) });
const { KEY, call, check, notes, until, computers, getChat, lastReply, turnsOf } = p;

/** The `claude` processes the runner started, by process id. */
function claudes(runner: number): number[] {
  if (process.platform !== "win32") {
    const out = spawnSync("pgrep", ["-P", String(runner), "-f", "claude"], { encoding: "utf8" }).stdout;
    return out.split("\n").map(Number).filter(Boolean);
  }
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${runner}" | Where-Object { $_.CommandLine -match 'claude' } | ForEach-Object { $_.ProcessId }`;
  const out = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout;
  return out.split(/\s+/).map(Number).filter(Boolean);
}

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const runner = p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "claude" && engine.signedIn)), "the runner with Claude Code signed in", 120);
  const options = await call<{ models: Array<{ id: string; engine?: string; isDefault?: boolean }> }>("models:options", { key: KEY });
  const model = options.models.find((item) => item.engine === "claude" && item.isDefault)?.id ?? options.models.find((item) => item.engine === "claude")?.id;
  if (!model) throw new Error("no Claude Code model offered");
  notes.model = model;
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model, engine: "claude" });

  /** Send, and time the first streamed words and the reply; which `claude` ran it, seen while it ran. */
  type Asked = { reply: string; firstWordsMs?: number; finishedMs: number; pids: number[] };
  const ask = async (text: string, during?: () => Promise<void>): Promise<Asked> => {
    const replies = (await p.messagesOf(chat)).filter((item) => item.role === "assistant").length;
    const sent = Date.now();
    await call("dashboard:sendChat", { key: KEY, id: chat, text });
    let firstWordsMs: number | undefined;
    const pids = new Set<number>();
    let duringDone = !during;
    for (let i = 0; ; i++) {
      const now = await getChat(chat);
      if (now.streaming && firstWordsMs === undefined) firstWordsMs = Date.now() - sent;
      if (i % 10 === 0 && now.isRunning) for (const pid of claudes(runner.pid!)) pids.add(pid);
      if (!duringDone && now.isRunning && Date.now() - sent > 4_000) { duringDone = true; await during!(); }
      const done = (await p.messagesOf(chat)).filter((item) => item.role === "assistant").length > replies;
      if (!now.isRunning && done) break;
      if (Date.now() - sent > 240_000) throw new Error(`no reply to "${text.slice(0, 40)}"`);
      await sleep(100);
    }
    return { reply: await lastReply(chat), firstWordsMs, finishedMs: Date.now() - sent, pids: [...pids] };
  };

  // 1. Three messages, one process.
  const one = await ask("This is an automated test. Remember the number 7481. Reply with the single word NOTED.");
  const two = await ask("This is an automated test. What number did I ask you to remember? Reply with only the number.");
  const three = await ask("This is an automated test. Reply with the single word OK.");
  const same = one.pids.length > 0 && two.pids.length > 0 && three.pids.length > 0 && two.pids.every((pid) => one.pids.includes(pid)) && three.pids.every((pid) => one.pids.includes(pid));
  check("laterTurnsUseTheSameProcess", same, { one: one.pids, two: two.pids, three: three.pids });
  check("itRemembersTheFirstTurn", /7481/.test(two.reply) && /NOTED/i.test(one.reply) && /\bOK\b/i.test(three.reply), { one: one.reply, two: two.reply, three: three.reply });
  notes.firstWordsMs = { first: one.firstWordsMs, second: two.firstWordsMs, third: three.firstWordsMs };
  notes.finishedMs = { first: one.finishedMs, second: two.finishedMs, third: three.finishedMs };

  // 2. A message sent while the turn runs joins it.
  const steered = await ask("This is an automated test. Run exactly this shell command: sleep 12 (Start-Sleep -Seconds 12 in PowerShell). Then reply with the single word SLEPT.", async () => {
    await call("dashboard:sendChat", { key: KEY, id: chat, text: "Also add the word BANANA at the end of your reply." });
  });
  await until(async () => !(await getChat(chat)).isRunning, "the steered reply to end", 120);
  const afterSteer = await lastReply(chat);
  check("aMessageMidTurnJoinsIt", /BANANA/i.test(afterSteer) && steered.pids.every((pid) => one.pids.includes(pid)), { reply: afterSteer, pids: steered.pids });

  // 3. Stopped, then asked again.
  const stopped = ask("This is an automated test. Run exactly this shell command: sleep 60 (Start-Sleep -Seconds 60 in PowerShell). Then reply with the single word DONE.", async () => {
    await sleep(5_000);
    await call("dashboard:stopChat", { key: KEY, id: chat });
  });
  await stopped.catch(() => {});
  await until(async () => !(await getChat(chat)).isRunning, "the stopped turn to end", 120);
  const wasStopped = turnsOf(chat).at(-1)?.stopped === true;
  const afterStop = await ask("This is an automated test. Reply with the single word AGAIN.");
  check("aStoppedTurnLeavesTheChatWorking", wasStopped && /AGAIN/i.test(afterStop.reply), { stopped: wasStopped, reply: afterStop.reply, pids: afterStop.pids });

  // 4. Another access: the same process, switched. Another model: a new one.
  const before = afterStop.pids;
  await call("dashboard:setChatAccess", { key: KEY, id: chat, access: "auto" });
  const changed = await ask("This is an automated test. Reply with the single word CHANGED.");
  check("aChangedAccessKeepsTheProcess", /CHANGED/i.test(changed.reply) && changed.pids.length > 0 && changed.pids.every((pid) => before.includes(pid)), { before, after: changed.pids });
  const other = options.models.find((item) => item.engine === "claude" && item.id !== model)?.id;
  if (!other) throw new Error("no second Claude Code model offered");
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: other, engine: "claude" });
  const remodelled = await ask("This is an automated test. Reply with the single word MODEL.");
  // The old one is closed as the new one starts, and may take a moment to exit.
  const fresh = remodelled.pids.filter((pid) => !before.includes(pid));
  let oldGone = false;
  for (let i = 0; i < 30 && !oldGone; i++) { oldGone = !claudes(runner.pid!).some((pid) => before.includes(pid)); if (!oldGone) await sleep(500); }
  check("aChangedModelStartsANewProcess", /MODEL/i.test(remodelled.reply) && fresh.length > 0 && oldGone, { model: other, before, after: remodelled.pids, oldGone });

  // 5. Left alone, it is closed.
  const idle = fresh;
  await until(() => !claudes(runner.pid!).some((pid) => idle.includes(pid)), "the idle process to close", IDLE_MIN * 60 + 60);
  check("anIdleProcessIsClosed", true, { closedAfterMin: IDLE_MIN });
  await p.finish();
} catch (error) {
  check("ran", false, String(error));
  await p.finish();
}
process.exit(0);
