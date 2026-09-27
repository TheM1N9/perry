import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/engine-grok/run.ts <outDir>
// Grok Build as Perry's engine, over the generic ACP client (runner/engines/acp.ts,
// runner/engines/grok.ts). Grok is not installed on this machine, so the runner's
// `grok` is the fake ACP agent playing Grok Build (artifacts/engine-acp/fake-agent.ts
// --profile grok), through PERRY_GROK_COMMAND. Everything else is real: a fresh
// Perry from the production build on a spare port with a temp PERRY_HOME, the real
// runner, this machine's real signed-in Codex on the same runner (PERRY_E2E_MODEL,
// gpt-6-luna by default), and headless Chrome for Settings.
//
// Ways it could fail, written down before the checks:
//   1. The Grok probe starts an agent or a session to see whether Grok works, or two
//      probes overlap.
//   2. Settings does not list Grok beside Codex, or not as signed out before signing in.
//   3. Signing in does not show Grok's device code in Settings, is not marked as
//      Perry's (GROK_OAUTH2_REFERRER), or never turns to Signed in.
//   4. Grok's models are not offered, or not beside Codex's, grouped by engine.
//   5. A reply on Grok does not stream, is not saved, or leaks the agent's replay.
//   6. The chat's model and effort do not reach Grok's session config options, or the
//      run's label is not grok/<model> · <effort> · <access>.
//   7. The session is not stored as the chat's resume cursor, or not resumed (after
//      the agent is restarted) so the chat loses its context.
//   8. Perry's `remember` tool is not reachable from Grok over HTTP MCP, or asking
//      permission for it blocks on the owner.
//   9. On Ask, a command's permission request does not reach the dashboard; declining
//      it does not reach Grok as its reject-once option; allowing picks "always".
//  10. On Full access the owner is asked anyway, or the answer is not allow-once.
//  11. Stop does not cancel the reply, or the stopped reply is lost.
//  12. A message sent mid-reply is dropped, or not answered in the same reply.
//  13. /compact is not sent to Grok as its own prompt, or does not finish.
//  14. A hung reply runs forever: the idle watchdog must cancel, end the agent (whose
//      process must be gone), fail the turn, and the next message resume the session.
//  15. Switching a chat to Codex and back breaks either engine: Codex must answer on
//      the same runner, and Grok start a new session seeded with the chat's history.
//  16. Signing out does not reach Grok, or its models stay offered.
//  17. The dashboard throws, the runner logs failures, or the agent is left running.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engine-grok/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const NONCE = `grok-${Date.now().toString(36)}`;
let fakeHome = "";
const p = await perry({
  name: "engine-grok",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    return {
      PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`,
      FAKE_ACP_HOME: fakeHome,
      FAKE_ACP_LOGIN_MS: "8000",
      // A hung reply is noticed after 8 seconds here, not five minutes.
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
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.installed)), "the runner to report Grok", 120);
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "Codex signed in beside it", 120);
  const computer = (await computers()).find((item) => item.online)!;

  // --- 1, 2. Settings before signing in; probes start nothing --------------------------------------
  await p.openBrowser();
  const before = await p.settingsText();
  const grokBefore = computer.engines.find((engine) => engine.kind === "grok")!;
  check("settingsListsBoth", /Codex/.test(before) && /Grok Build/.test(before) && /Signed out/.test(before) && /Sign in with Grok/.test(before) && grokBefore.version === "1.0.42-fake",
    { grok: grokBefore, text: before.slice(0, 600) });

  // --- 3. Signing in from Settings, by device code ----------------------------------------------------
  const clicked = await p.browser()!.evaluate(`(() => { const row = document.querySelector('[aria-label="Grok Build on ${computer.name}"]'); const button = [...(row?.querySelectorAll('button') ?? [])].find((b) => /Sign in with Grok/.test(b.textContent)); button?.click(); return Boolean(button); })()`);
  if (!clicked) await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "grok", kind: "login" });
  await until(() => p.browser()!.evaluate(`document.querySelector('section[aria-label="Engines"]').innerText.includes("FAKE-1234")`), "the device code in Settings", 60);
  await p.shot("settings-grok-sign-in.png");
  const codeText = await p.browser()!.evaluate(`document.querySelector('section[aria-label="Engines"]').innerText`) as string;
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "Grok signed in", 90);
  const login = log().find((entry) => entry.cli === "login");
  check("signInDeviceCode", clicked === true && codeText.includes("FAKE-1234") && codeText.includes("Open sign-in page") && login?.args.includes("--device-auth") && login?.referrer === "perry",
    { clicked, login, text: codeText.slice(0, 400) });
  const after = await p.settingsText();
  await until(() => p.browser()!.evaluate(`document.querySelector('section[aria-label="Engines"]').innerText.split("Signed in").length > 2`), "both engines signed in on Settings", 30).catch(() => {});
  await p.shot("settings-engines.png");
  notes.settingsAfter = after.slice(0, 800);

  // --- 4. Models from both engines -------------------------------------------------------------------------
  const options = await call<{ models: Array<{ id: string; engine?: string; efforts?: string[] }>; engines: Array<{ kind: string }> }>("models:options", { key: KEY });
  check("modelsFromBoth", options.engines.map((engine) => engine.kind).join(",") === "codex,grok"
    && options.models.some((model) => model.engine === "grok" && model.id === "grok-fake-heavy") && options.models.some((model) => model.engine === "codex" && model.id === MODEL),
    { engines: options.engines, grok: options.models.filter((model) => model.engine === "grok") });

  // --- 5, 6, 7. A reply on Grok -----------------------------------------------------------------------------
  const firstTurnAt = Date.now();
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-heavy", engine: "grok" });
  await call("dashboard:setChatEffort", { key: KEY, id: chat, effort: "high" });
  const first = await exchange(chat, `Hello Grok ${NONCE}`);
  check("replyStreams", first.streamed.length >= 3 && first.streamed.some((text) => text.length < first.reply.length), { snapshots: first.streamed.length });
  check("replySaved", first.reply.includes(`Fake grok reply to: Hello Grok ${NONCE}`) && !first.reply.includes("LATE-REPLAY"), first.reply);
  const sets = log().filter((entry) => entry.method === "session/set_config_option").map((entry) => `${entry.configId}=${entry.value}`);
  const [firstRun] = await runsOf(chat);
  check("modelAndEffortSent", sets.includes("model=grok-fake-heavy") && sets.includes("reasoning_effort=high") && firstRun?.model === "grok/grok-fake-heavy · high",
    { sets, run: firstRun?.model });
  const firstPrompt = log().find((entry) => entry.prompt === `Hello Grok ${NONCE}`);
  check("instructionsInFirstPrompt", Boolean(firstPrompt?.preamble?.startsWith("<perry-instructions>")) && /The owner approves your commands/.test(firstPrompt?.preamble ?? ""), firstPrompt?.preamble?.slice(0, 200));
  const afterFirst = await conversation(chat);
  check("resumeCursorRecorded", afterFirst.engine === "grok" && afterFirst.resume?.engine === "grok" && String(afterFirst.resume?.cursor).startsWith("fake-grok-") && !afterFirst.codexThreadId,
    { resume: afterFirst.resume });
  const agentStarts = log().filter((entry) => entry.acp);
  const modelsCalls = log().filter((entry) => entry.cli === "models").sort((a, b) => a.started - b.started);
  const overlap = modelsCalls.some((entry, index) => index > 0 && entry.started < modelsCalls[index - 1].ended);
  check("probesStartNothing", agentStarts.length > 0 && agentStarts.every((entry) => entry.at >= firstTurnAt) && log().filter((entry) => entry.method === "session/new").every((entry) => entry.at >= firstTurnAt)
    && modelsCalls.length >= 2 && !overlap && agentStarts[0].acp.join(" ") === "--permission-mode default agent --no-leader stdio",
    { agentStarts: agentStarts.length, launchedWith: agentStarts[0]?.acp, modelsProbes: modelsCalls.length, overlap });

  // --- 8. Perry's remember tool over HTTP MCP ----------------------------------------------------------------
  const remembered = await exchange(chat, `REMEMBER Grok check ${NONCE}: the remember tool works.`);
  const memory = rows("memories").find((row) => String(row.text).includes(`Grok check ${NONCE}`));
  const mcpNew = log().find((entry) => entry.method === "session/new");
  const mcpPermission = log().find((entry) => entry.permission === "mcp");
  check("mcpRememberOverHttp", Boolean(memory) && remembered.reply.includes("remembered over HTTP") && mcpNew?.mcpServers?.[0]?.type === "http"
    && mcpNew.mcpServers[0].headers?.some((header: { name: string }) => header.name === "Authorization") && mcpPermission?.outcome?.optionId === "allow-once"
    && !rows("approvals").some((row) => row.conversationId === chat),
    { memory: memory?.text, reply: remembered.reply, server: mcpNew?.mcpServers?.[0] && { type: mcpNew.mcpServers[0].type, url: mcpNew.mcpServers[0].url }, permission: mcpPermission?.outcome });

  // --- 9. Ask: the request reaches the dashboard; decline, then allow -------------------------------------------
  type Pending = { id: string; title: string; chat?: { id: string } };
  const ask = async (command: string, approved: boolean) => {
    await call("dashboard:sendChat", { key: KEY, id: chat, text: `RUN ${command}` });
    let asked: Pending | undefined;
    await until(async () => { asked = (await call<Pending[]>("approvals:pending", { key: KEY })).find((item) => item.chat?.id === chat); return Boolean(asked); }, "the approval to reach the dashboard", 60);
    await call("approvals:decide", { key: KEY, id: asked!.id, approved });
    await until(async () => !(await getChat(chat)).isRunning, "the turn to finish", 60);
    return { asked, reply: await p.lastReply(chat), outcome: log().filter((entry) => entry.permission === "execute" && entry.command === command).at(-1)?.outcome };
  };
  const declined = await ask(`Remove-Item C:\\perry-grok-${NONCE}`, false);
  const declinedRow = rows("approvals").filter((row) => row.conversationId === chat).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  check("approvalDeclineReachesGrok", /Remove-Item/.test(declined.asked?.title ?? "") && declinedRow?.status === "declined" && declinedRow.decidedBy === "dashboard"
    && declined.outcome?.optionId === "reject-once" && /declined/.test(declined.reply),
    { title: declined.asked?.title, status: declinedRow?.status, outcome: declined.outcome, reply: declined.reply });
  const allowed = await ask(`echo allowed-${NONCE}`, true);
  check("approvalAllowIsOnce", allowed.outcome?.optionId === "allow-once" && /I ran/.test(allowed.reply), { outcome: allowed.outcome, reply: allowed.reply });

  // --- 10. Full access: Grok still asks; Perry answers allow-once itself ------------------------------------------
  await call("dashboard:setChatAccess", { key: KEY, id: chat, access: "full" });
  const approvalsBefore = rows("approvals").filter((row) => row.conversationId === chat).length;
  const full = await exchange(chat, `RUN echo full-${NONCE}`);
  const fullOutcome = log().filter((entry) => entry.permission === "execute" && entry.command === `echo full-${NONCE}`).at(-1)?.outcome;
  const fullRun = (await runsOf(chat))[0];
  check("fullAccessAllowsOnce", fullOutcome?.optionId === "allow-once" && rows("approvals").filter((row) => row.conversationId === chat).length === approvalsBefore
    && /I ran/.test(full.reply) && fullRun?.model === "grok/grok-fake-heavy · high · full access",
    { outcome: fullOutcome, reply: full.reply, run: fullRun?.model });

  // --- 11. Stop ------------------------------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "SLOW count for me" });
  await until(async () => ((await getChat(chat)).streaming ?? "").includes("step 3"), "the slow reply to stream", 60);
  await call("dashboard:stopChat", { key: KEY, id: chat });
  await until(async () => !(await getChat(chat)).isRunning, "the stopped turn to end", 60);
  const stopped = turnsOf(chat).at(-1)!;
  const stoppedReply = await p.lastReply(chat);
  check("stopCancels", stopped.stopped === true && /step 3/.test(stoppedReply) && /_Stopped\._/.test(stoppedReply) && stopped.finishedAt - stopped.startedAt < 11_000
    && log().some((entry) => entry.method === "session/cancel") && log().some((entry) => entry.finished === "SLOW count for me" && entry.stopReason === "cancelled"),
    { stopped: stopped.stopped, ranMs: stopped.finishedAt - stopped.startedAt, reply: stoppedReply.slice(-80) });

  // --- 12. A message mid-reply ---------------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "SLOW again" });
  await until(async () => ((await getChat(chat)).streaming ?? "").includes("step 2"), "the second slow reply", 60);
  const steeredTurn = turnsOf(chat).at(-1)!;
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `Also mention pineapple ${NONCE}` });
  await until(() => rows("codexSteers").some((steer) => steer.turnId === steeredTurn._id && steer.status !== "pending"), "the steer to be answered", 60);
  await until(async () => !(await getChat(chat)).isRunning, "the steered turn to end", 90);
  const steer = rows("codexSteers").find((item) => item.turnId === steeredTurn._id)!;
  const steeredReply = await p.lastReply(chat);
  check("steerJoinsReply", steer.status === "applied" && steer.engine === "grok" && /step 30/.test(steeredReply) && steeredReply.includes(`pineapple ${NONCE}`),
    { steer: { status: steer.status, engine: steer.engine, error: steer.error }, reply: steeredReply.slice(-160) });

  // --- 13. /compact --------------------------------------------------------------------------------------------------
  const compaction = await call<string | null>("dashboard:compactChat", { key: KEY, id: chat });
  const compacted = { status: "none", error: undefined as string | undefined };
  if (compaction) await until(async () => { Object.assign(compacted, await call<{ status: string; error?: string }>("dashboard:getCompaction", { key: KEY, id: compaction })); return compacted.status === "done" || compacted.status === "error"; }, "the compaction", 90);
  const compactPrompt = log().find((entry) => entry.prompt === "/compact");
  check("compactSlashCommand", compacted.status === "done" && compactPrompt?.blocks?.join(",") === "text", { compacted, blocks: compactPrompt?.blocks });

  // --- 14. A hung reply: the watchdog ends the agent, and the next message resumes -----------------------------------
  const pidBefore = log().filter((entry) => entry.acp).at(-1)!.pid as number;
  const hungAt = Date.now();
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "HANG please" });
  await until(async () => !(await getChat(chat)).isRunning, "the hung turn to be ended", 90);
  const hung = turnsOf(chat).at(-1)!;
  await sleep(4_000);
  const recall = await exchange(chat, "RECALL what I said");
  const restarted = log().filter((entry) => entry.acp && entry.at > hungAt);
  check("hungReplyWatchdog", /stopped responding/.test(hung.error ?? "") && !alive(pidBefore) && restarted.length === 1
    && log().some((entry) => entry.method === "session/resume" && entry.at > hungAt && entry.sessionId === afterFirst.resume?.cursor)
    && recall.reply.includes(`Hello Grok ${NONCE}`) && (await conversation(chat)).resume?.cursor === afterFirst.resume?.cursor,
    { error: hung.error, ranMs: hung.finishedAt - hung.startedAt, oldAgentAlive: alive(pidBefore), restarted: restarted.length, recall: recall.reply.slice(0, 200) });

  // --- 15. Switching the chat to Codex and back ---------------------------------------------------------------------
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: MODEL, engine: "codex" });
  const onCodex = await exchange(chat, "Reply with exactly: switched-ok", 240);
  const codexTurn = turnsOf(chat).at(-1)!;
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });
  const back = await exchange(chat, `Back on Grok ${NONCE}`);
  const backPrompt = log().find((entry) => entry.prompt === `Back on Grok ${NONCE}`);
  const backChat = await conversation(chat);
  check("switchCodexAndBack", codexTurn.engine === "codex" && /switched-ok/.test(onCodex.reply) && back.reply.includes(`Back on Grok ${NONCE}`)
    && Boolean(backPrompt?.preamble?.includes("switched-ok")) && backChat.engine === "grok" && backChat.resume?.cursor !== afterFirst.resume?.cursor,
    { codex: { engine: codexTurn.engine, reply: onCodex.reply.slice(0, 80), error: codexTurn.error }, grok: { reply: back.reply.slice(0, 80), historySeeded: Boolean(backPrompt?.preamble?.includes("switched-ok")), newSession: backChat.resume?.cursor } });

  // --- 16. Signing out ---------------------------------------------------------------------------------------------------
  await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "grok", kind: "logout" });
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "grok" && engine.installed && !engine.signedIn)), "Grok signed out", 60);
  const afterLogout = await call<{ models: Array<{ engine?: string }> }>("models:options", { key: KEY });
  check("signOut", log().some((entry) => entry.cli === "logout") && !afterLogout.models.some((model) => model.engine === "grok") && afterLogout.models.some((model) => model.engine === "codex"),
    { engines: [...new Set(afterLogout.models.map((model) => model.engine))] });

  check("noPageErrors", p.browser()!.errors.length === 0, p.browser()!.errors);
  check("runnerLogClean", !/turn failed:|could not report the engines|could not ask about/i.test(p.logs.runner),
    p.logs.runner.split("\n").filter((line) => /fail|error/i.test(line)).slice(-10));
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}
// The runner stopped: every agent process it started must be gone with it.
const pids = [...new Set(log().filter((entry) => entry.acp).map((entry) => entry.pid as number))];
p.stop(runner);
await sleep(5_000);
check("agentsEndWithRunner", pids.length > 0 && pids.every((pid) => !alive(pid)), { agents: pids.length, stillRunning: pids.filter((pid) => alive(pid)) });
const passed = await p.finish({ engine: "grok", agent: "fake (artifacts/engine-acp/fake-agent.ts --profile grok)", codexModel: MODEL });
process.exit(passed ? 0 : 1);
