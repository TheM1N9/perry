import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/engine-cursor/run.ts <outDir>
// Cursor as Perry's engine, over the generic ACP client (runner/engines/acp.ts,
// runner/engines/cursor.ts). Cursor's CLI is not installed on this machine, so the
// runner's `cursor-agent` is the fake ACP agent playing Cursor
// (artifacts/engine-acp/fake-agent.ts --profile cursor) through PERRY_CURSOR_COMMAND:
// `agent about`, `agent models`, `agent login/logout`, `agent mcp enable`, and an ACP
// server that ignores session/new's MCP servers and reads the approved ones from
// .cursor/mcp.json where it was started, resumes only with session/load (replaying
// the chat), has agent/plan/ask modes and allow-once/allow-always/reject-once.
// Everything else is real: a fresh Perry from the production build, the real runner,
// this machine's real Codex on the same runner, and headless Chrome.
//
// Ways it could fail, written down before the checks:
//   1. Settings does not list Cursor beside Codex (and Grok, not installed here), or a
//      probe starts the agent.
//   2. Signing in does not show the command to run, or never turns to Signed in once the
//      owner has run it; the account's email and plan are not shown.
//   3. Cursor's models are not offered beside Codex's.
//   4. A reply does not stream or is not saved; the model does not reach the session.
//   5. Perry's tools do not reach Cursor: .cursor/mcp.json is not written in Perry's
//      workspace, holds the runner's token, the server is not approved, the agent is not
//      started in that folder, or `remember` does not work through the stdio bridge.
//   6. The session is not resumed with session/load, or its replay leaks into a reply.
//   7. On Ask a command's request does not reach the dashboard; a decline does not
//      reach Cursor as reject-once; an allow is not allow-once.
//   8. On Full access the owner is asked, or the answer is not allow-once.
//   9. Stop does not cancel.
//  10. A message sent mid-reply is lost: Cursor takes one message at a time, so it must
//      wait and become the next turn.
//  11. /compress is not sent as Cursor's own prompt.
//  12. A hung reply runs forever, or the chat does not resume after the agent is ended.
//  13. Switching the chat to Codex and back breaks either engine.
//  14. Signing out does not reach Cursor.
//  15. The owner's own ~/.cursor is touched, the dashboard throws, the runner logs
//      failures, or an agent process outlives the runner.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engine-cursor/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const NONCE = `cursor-${Date.now().toString(36)}`;
const USER_CURSOR = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cursor", "mcp.json");
const userCursorBefore = existsSync(USER_CURSOR) ? readFileSync(USER_CURSOR, "utf8") : null;
let fakeHome = "";
const p = await perry({
  name: "engine-cursor",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-cursor");
    return {
      PERRY_CURSOR_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile cursor`,
      FAKE_ACP_HOME: fakeHome,
      PERRY_ACP_IDLE_MS: "8000",
    };
  },
});
const { KEY, call, check, notes, until, rows, turnsOf, getChat, conversation, computers, exchange, fakeLog, alive, runsOf } = p;
const log = () => fakeLog(fakeHome);
let runner: ReturnType<typeof p.start> | null = null;

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "cursor" && engine.installed)), "the runner to report Cursor", 120);
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "Codex signed in beside it", 120);
  const computer = (await computers()).find((item) => item.online)!;
  const workspace = JSON.parse(readFileSync(join(p.home, "runner.json"), "utf8")).dir as string;

  // --- 1, 2. Settings, and signing in -----------------------------------------------------------------
  await p.openBrowser();
  const before = await p.settingsText();
  const cursorBefore = computer.engines.find((engine) => engine.kind === "cursor")!;
  check("settingsListsAll", /Codex/.test(before) && /Cursor/.test(before) && /Grok Build/.test(before) && /Sign in with Cursor/.test(before) && cursorBefore.version === "2026.09.18-fake" && !cursorBefore.signedIn,
    { cursor: cursorBefore, text: before.slice(0, 700) });
  const clicked = await p.browser()!.evaluate(`(() => { const row = document.querySelector('[aria-label="Cursor on ${computer.name}"]'); const button = [...(row?.querySelectorAll('button') ?? [])].find((b) => /Sign in with Cursor/.test(b.textContent)); button?.click(); return Boolean(button); })()`);
  await until(() => p.browser()!.evaluate(`document.querySelector('section[aria-label="Engines"]').innerText.includes("Run this in a terminal")`), "the command in Settings", 60);
  await p.shot("settings-cursor-sign-in.png");
  const steps = await p.browser()!.evaluate(`document.querySelector('section[aria-label="Engines"]').innerText`) as string;
  // The owner runs it in a terminal on the computer, as Settings says.
  spawnSync(process.execPath, [FAKE_AGENT, "--profile", "cursor", "login"], { env: { ...process.env, FAKE_ACP_HOME: fakeHome, FAKE_ACP_LOGIN_MS: "500" }, windowsHide: true });
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "cursor" && engine.signedIn)), "Cursor signed in", 60);
  const cursorAfter = (await computers()).find((item) => item.online)!.engines.find((engine) => engine.kind === "cursor")!;
  check("signInByCommand", clicked === true && /Run this in a terminal/.test(steps) && cursorAfter.auth.label === "Cursor" && cursorAfter.auth.plan === "pro",
    { clicked, auth: cursorAfter.auth, text: steps.slice(0, 300) });
  await p.settingsText();
  await until(() => p.browser()!.evaluate(`document.querySelector('section[aria-label="Engines"]').innerText.split("Signed in").length > 2`), "both signed in on Settings", 30).catch(() => {});
  await p.shot("settings-engines.png");

  // --- 3. Models from both -----------------------------------------------------------------------------
  const options = await call<{ models: Array<{ id: string; engine?: string }>; engines: Array<{ kind: string }> }>("models:options", { key: KEY });
  check("modelsFromBoth", options.engines.map((engine) => engine.kind).join(",") === "codex,cursor" && options.models.some((model) => model.engine === "cursor" && model.id === "cursor-fake-sonnet")
    && options.models.some((model) => model.engine === "codex" && model.id === MODEL), { engines: options.engines, cursor: options.models.filter((model) => model.engine === "cursor") });

  // --- 4, 5. A reply, and Perry's tools through .cursor/mcp.json ------------------------------------------
  const firstTurnAt = Date.now();
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "cursor-fake-sonnet", engine: "cursor" });
  const first = await exchange(chat, `Hello Cursor ${NONCE}`);
  check("replyStreams", first.streamed.length >= 3 && first.streamed.some((text) => text.length < first.reply.length), { snapshots: first.streamed.length });
  check("replySaved", first.reply.includes(`Fake cursor reply to: Hello Cursor ${NONCE}`), first.reply);
  const [firstRun] = await runsOf(chat);
  const sets = log().filter((entry) => entry.method === "session/set_config_option").map((entry) => `${entry.configId}=${entry.value}`);
  check("modelSent", sets.includes("model=cursor-fake-sonnet") && firstRun?.model?.startsWith("cursor/cursor-fake-sonnet") === true
    && log().find((entry) => entry.prompt === `Hello Cursor ${NONCE}`)?.mode === "agent", { sets, run: firstRun?.model });
  const agentStarts = log().filter((entry) => entry.acp);
  check("probesStartNothing", agentStarts.length > 0 && agentStarts.every((entry) => entry.at >= firstTurnAt) && agentStarts[0].acp.join(" ") === "--approve-mcps acp",
    { starts: agentStarts.length, launchedWith: agentStarts[0]?.acp });

  const remembered = await exchange(chat, `REMEMBER Cursor check ${NONCE}: tools reach Cursor.`);
  const memory = rows("memories").find((row) => String(row.text).includes(`Cursor check ${NONCE}`));
  const mcpFile = join(workspace, ".cursor", "mcp.json");
  const mcpText = existsSync(mcpFile) ? readFileSync(mcpFile, "utf8") : "";
  const token = JSON.parse(readFileSync(join(p.home, "runner.json"), "utf8")).token as string;
  const newSession = log().find((entry) => entry.method === "session/new");
  check("mcpThroughProjectFile", Boolean(memory) && remembered.reply.includes("remembered over stdio") && mcpText.includes("mcp-bridge.ts") && !mcpText.includes(token)
    && newSession?.mcpServers?.length === 0 && newSession?.processCwd === workspace && log().some((entry) => entry.cli === "mcp enable" && entry.name === "assistant"),
    { memory: memory?.text, reply: remembered.reply, file: mcpText ? JSON.parse(mcpText) : null, tokenInFile: mcpText.includes(token), sessionNewServers: newSession?.mcpServers, agentCwd: newSession?.processCwd, workspace });

  // --- 7. Ask: decline, then allow ------------------------------------------------------------------------
  type Pending = { id: string; title: string; chat?: { id: string } };
  const ask = async (command: string, approved: boolean) => {
    await call("dashboard:sendChat", { key: KEY, id: chat, text: `RUN ${command}` });
    let asked: Pending | undefined;
    await until(async () => { asked = (await call<Pending[]>("approvals:pending", { key: KEY })).find((item) => item.chat?.id === chat); return Boolean(asked); }, "the approval to reach the dashboard", 60);
    await call("approvals:decide", { key: KEY, id: asked!.id, approved });
    await until(async () => !(await getChat(chat)).isRunning, "the turn to finish", 60);
    return { asked, reply: await p.lastReply(chat), outcome: log().filter((entry) => entry.permission === "execute" && entry.command === command).at(-1)?.outcome };
  };
  const declined = await ask(`rm -rf ./build-${NONCE}`, false);
  check("approvalDeclineReachesCursor", /rm -rf/.test(declined.asked?.title ?? "") && declined.outcome?.optionId === "reject-once" && /declined/.test(declined.reply), { title: declined.asked?.title, outcome: declined.outcome });
  const allowed = await ask(`echo allowed-${NONCE}`, true);
  check("approvalAllowIsOnce", allowed.outcome?.optionId === "allow-once" && /I ran/.test(allowed.reply), { outcome: allowed.outcome });

  // --- 8. Full access ------------------------------------------------------------------------------------------
  await call("dashboard:setChatAccess", { key: KEY, id: chat, access: "full" });
  const approvalsBefore = rows("approvals").filter((row) => row.conversationId === chat).length;
  const full = await exchange(chat, `RUN echo full-${NONCE}`);
  const fullOutcome = log().filter((entry) => entry.permission === "execute" && entry.command === `echo full-${NONCE}`).at(-1)?.outcome;
  check("fullAccessAllowsOnce", fullOutcome?.optionId === "allow-once" && rows("approvals").filter((row) => row.conversationId === chat).length === approvalsBefore && /I ran/.test(full.reply), { outcome: fullOutcome });

  // --- 9. Stop --------------------------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "SLOW count for me" });
  await until(async () => ((await getChat(chat)).streaming ?? "").includes("step 3"), "the slow reply", 60);
  await call("dashboard:stopChat", { key: KEY, id: chat });
  await until(async () => !(await getChat(chat)).isRunning, "the stopped turn to end", 60);
  const stopped = turnsOf(chat).at(-1)!;
  check("stopCancels", stopped.stopped === true && /_Stopped\._/.test(await p.lastReply(chat)) && log().some((entry) => entry.finished === "SLOW count for me" && entry.stopReason === "cancelled"),
    { stopped: stopped.stopped, ranMs: stopped.finishedAt - stopped.startedAt });

  // --- 10. A message mid-reply waits its turn ---------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "SLOW again" });
  await until(async () => ((await getChat(chat)).streaming ?? "").includes("step 2"), "the second slow reply", 60);
  const busyTurn = turnsOf(chat).at(-1)!;
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `Then mention pineapple ${NONCE}` });
  await until(() => rows("codexSteers").some((steer) => steer.turnId === busyTurn._id && steer.status !== "pending"), "the steer to be answered", 60);
  await until(async () => (await p.messagesOf(chat)).some((message) => message.role === "assistant" && message.text.includes(`pineapple ${NONCE}`)), "the queued message's reply", 120);
  await until(async () => !(await getChat(chat)).isRunning, "the chat to go idle", 60);
  const steer = rows("codexSteers").find((item) => item.turnId === busyTurn._id)!;
  const busyReply = (await p.messagesOf(chat)).filter((message) => message.role === "assistant").find((message) => /step 30/.test(message.text));
  check("steerQueuesAsNextTurn", steer.status !== "applied" && Boolean(busyReply) && !busyReply!.text.includes("pineapple") && turnsOf(chat).at(-1)!.prompt.includes(`pineapple ${NONCE}`),
    { steer: { status: steer.status, error: steer.error }, lastTurn: turnsOf(chat).at(-1)!.prompt });

  // --- 11. /compress ----------------------------------------------------------------------------------------------
  const compaction = await call<string | null>("dashboard:compactChat", { key: KEY, id: chat });
  const compacted = { status: "none", error: undefined as string | undefined };
  if (compaction) await until(async () => { Object.assign(compacted, await call<{ status: string; error?: string }>("dashboard:getCompaction", { key: KEY, id: compaction })); return compacted.status === "done" || compacted.status === "error"; }, "the compaction", 90);
  check("compactSlashCommand", compacted.status === "done" && log().find((entry) => entry.prompt === "/compress")?.blocks?.join(",") === "text", compacted);

  // --- 6, 12. A hung reply; the next message loads the session (its replay kept out of the reply) -------------------
  const cursorBeforeHang = (await conversation(chat)).resume?.cursor;
  const pidBefore = log().filter((entry) => entry.acp).at(-1)!.pid as number;
  const hungAt = Date.now();
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "HANG please" });
  await until(async () => !(await getChat(chat)).isRunning, "the hung turn to be ended", 90);
  const hung = turnsOf(chat).at(-1)!;
  await sleep(4_000);
  const recall = await exchange(chat, "RECALL what I said");
  check("hungReplyWatchdog", /stopped responding/.test(hung.error ?? "") && !alive(pidBefore), { error: hung.error, oldAgentAlive: alive(pidBefore) });
  check("resumeByLoad", log().some((entry) => entry.method === "session/load" && entry.at > hungAt && entry.sessionId === cursorBeforeHang) && recall.reply.includes(`Hello Cursor ${NONCE}`)
    && !recall.reply.includes("LATE-REPLAY") && !recall.reply.includes("Fake cursor reply") && (await conversation(chat)).resume?.cursor === cursorBeforeHang,
    { recall: recall.reply.slice(0, 200) });

  // --- 13. Codex and back -----------------------------------------------------------------------------------------
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: MODEL, engine: "codex" });
  const onCodex = await exchange(chat, "Reply with exactly: switched-ok", 240);
  const codexTurn = turnsOf(chat).at(-1)!;
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "cursor-fake-auto", engine: "cursor" });
  const back = await exchange(chat, `Back on Cursor ${NONCE}`);
  const backPrompt = log().find((entry) => entry.prompt === `Back on Cursor ${NONCE}`);
  check("switchCodexAndBack", codexTurn.engine === "codex" && /switched-ok/.test(onCodex.reply) && back.reply.includes(`Back on Cursor ${NONCE}`) && Boolean(backPrompt?.preamble?.includes("switched-ok")),
    { codex: onCodex.reply.slice(0, 60), cursor: back.reply.slice(0, 60) });

  // --- 14. Sign out -----------------------------------------------------------------------------------------------
  await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "cursor", kind: "logout" });
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "cursor" && engine.installed && !engine.signedIn)), "Cursor signed out", 60);
  check("signOut", log().some((entry) => entry.cli === "logout"), true);

  check("userCursorUntouched", (existsSync(USER_CURSOR) ? readFileSync(USER_CURSOR, "utf8") : null) === userCursorBefore, { path: USER_CURSOR, existed: userCursorBefore !== null });
  check("noPageErrors", p.browser()!.errors.length === 0, p.browser()!.errors);
  check("runnerLogClean", !/turn failed:|could not report the engines|could not ask about/i.test(p.logs.runner), p.logs.runner.split("\n").filter((line) => /fail|error/i.test(line)).slice(-10));
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}
const pids = [...new Set(log().filter((entry) => entry.acp).map((entry) => entry.pid as number))];
p.stop(runner);
await sleep(5_000);
check("agentsEndWithRunner", pids.length > 0 && pids.every((pid) => !alive(pid)), { agents: pids.length, stillRunning: pids.filter((pid) => alive(pid)) });
const passed = await p.finish({ engine: "cursor", agent: "fake (artifacts/engine-acp/fake-agent.ts --profile cursor)", codexModel: MODEL });
process.exit(passed ? 0 : 1);
