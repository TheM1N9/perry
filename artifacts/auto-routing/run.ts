import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/auto-routing/run.ts <outDir>
// Issue #189: Perry picks the engine, model and thinking level for its work, and works around usage
// limits. A fresh Perry from the production build (`pnpm build` first) on a spare port, with its own
// PERRY_HOME under PERRY_E2E_DIR, the real runner, and two engines that are both the fake ACP agent
// (artifacts/engine-acp/fake-agent.ts): Grok Build through PERRY_GROK_COMMAND, and Antigravity
// through a fake release served from here (PERRY_ANTIGRAVITY_RELEASE), turned on with a fake Gemini
// key. Codex and Claude Code get empty CODEX_HOME and CLAUDE_CONFIG_DIR folders and no API keys, and
// the run stops before anything is sent if either reports being signed in: no real model is ever
// asked anything. Plans are seeded as the engine-usage and settings-sections runs do (usage:report
// with the runner's token); a refusal is the fake agent's own (a <profile>-limited file, or LIMIT).
// Headless Chrome photographs the run's details, the Work page and a moved chat. Grok Build is the owner's
// default engine (the harness starts this Perry with it chosen, issue #190): work runs there unless something
// names another engine or its plan has no room. With no default chosen, Perry asks instead
// (artifacts/choose-engine checks that).
//
// Ways it could fail, written down before the checks:
//   1. A job, task or chat with no pick runs on the engine's default for everything: the heartbeat and
//      a reminder must get the quick tier (the fast model at low), a recurring job and a short task
//      the standard tier, the memory consolidation and a long task the deep tier (the strongest model
//      at high), and the engine must actually be sent that model and level (the fake agent's log).
//   2. A new chat or job goes to another engine than the owner's default while the default has room (say,
//      the one with the most of its plan left), or to Codex, which is not signed in.
//   3. The run does not record what it ran on and why (runs.route), or says it wrongly.
//   4. The owner's pick does not win: a job's model from the Work page, or a chat's model and level,
//      is replaced by the tier's.
//   5. Perry's own pick through its tools (create_job's tier, queue_task's model and effort) is
//      refused, dropped, or loses to the tier's rule; list_engines does not answer.
//   6. Background work runs on an engine past the 90% cap instead of moving, or does not say it moved
//      (route.movedFrom); or a chat is moved off an engine that still has room (chats use it to 100%).
//   7. A chat whose engine is used up is not moved, or moves without saying so above its composer.
//   8. With every engine used up, a job fails or runs anyway instead of waiting; or it waits and never
//      runs after the reset; or it runs before the reset.
//   9. A turn refused part-way for a limit fails the chat instead of running once more on another
//      engine; or it runs twice, or the run is not one run, or the reply is lost.
//  10. A job that failed on a limit is not run again: it must wait for the reset when nothing has
//      room, then run on the engine that has, and the owner is told exactly once.
//  11. The Work page does not show the move, or "Keep on…" does not pin it back to the engine it left.
//  12. Any page throws, a screenshot is missing, or a real engine (Codex, Claude Code) is used at all.
//  13. The run itself does not get to the end (a step timed out, the runner crashed) — completed.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/auto-routing/run.ts <outDir>");
const BASE_DIR = process.env.PERRY_E2E_DIR ?? "W:/perry-tests/auto-routing";
mkdirSync(BASE_DIR, { recursive: true });
process.env.PERRY_E2E_DIR = BASE_DIR;
// No real engine may sign in through the environment either.
for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete process.env[name];
const TARGET = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;

// --- Antigravity's fake release: a zip whose launcher starts the fake agent as Antigravity ----------------
const work = mkdtempSync(join(BASE_DIR, "release-"));
const payload = join(work, "payload");
mkdirSync(payload);
const windows = process.platform === "win32";
const cmd = windows ? "agy_acp_server.cmd" : "agy_acp_server.par";
writeFileSync(join(payload, cmd), windows
  ? `@"${process.execPath}" "${FAKE_AGENT}" --profile antigravity %*\r\n`
  : `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" --profile antigravity "$@"\n`, { mode: 0o755 });
writeFileSync(join(payload, "localharness_external"), "fake harness");
const zip = join(work, "agy-acp-server-fake.zip");
const zipped = windows
  ? spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", zip, "-C", payload, cmd, "localharness_external"], { windowsHide: true })
  : spawnSync("zip", ["-q", "-j", zip, join(payload, cmd), join(payload, "localharness_external")]);
if (zipped.status !== 0) throw new Error(`could not make the fake release: ${zipped.stderr}`);
const bytes = readFileSync(zip);
const files = createServer((_, response) => { response.writeHead(200, { "content-type": "application/zip", "content-length": bytes.length }); response.end(bytes); }).listen(0, "127.0.0.1");
await new Promise((done) => files.once("listening", done));
const releaseFile = join(work, "release.json");
writeFileSync(releaseFile, JSON.stringify({ version: "9.9.9-fake", assets: { [TARGET]: { url: `http://127.0.0.1:${(files.address() as { port: number }).port}/agy.zip`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, cmd } } }));

let fakeHome = "";
const p = await perry({
  name: "auto-routing",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-acp");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    // What Antigravity's sessions offer, as the runner would have learned them from one.
    mkdirSync(join(home, "engines"), { recursive: true });
    const efforts = { efforts: ["low", "medium", "high"], defaultEffort: "medium" };
    writeFileSync(join(home, "engines", "antigravity.json"), JSON.stringify({ models: [
      { id: "gemini-fake-pro", name: "gemini-fake-pro", isDefault: true, ...efforts },
      { id: "gemini-fake-flash", name: "gemini-fake-flash", isDefault: false, ...efforts },
    ] }));
    for (const dir of ["codex-empty", "claude-empty"]) mkdirSync(join(home, dir), { recursive: true });
    return {
      PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`,
      PERRY_ANTIGRAVITY_RELEASE: releaseFile,
      FAKE_ACP_HOME: fakeHome,
      CODEX_HOME: join(home, "codex-empty"),
      CLAUDE_CONFIG_DIR: join(home, "claude-empty"),
    };
  },
});
const { BASE, KEY, call, check, notes, until, rows, getChat, computers, exchange, messagesOf, fakeLog } = p;
const log = () => fakeLog(fakeHome);

type Route = { engine: string; model?: string; effort?: string; tier: string; by: string; why: string; movedFrom?: { engine: string; model?: string; why: string }; retried?: boolean };
type Job = { id: string; name: string; builtin?: string; chatId?: string; lastResult?: string; lastError?: string; route?: Route; waiting?: { until: number; why: string }; stay?: boolean; model?: string; engine: string; pick?: Record<string, string> };
const jobs = () => call<Job[]>("jobs:list");
const jobNamed = async (name: string) => (await jobs()).find((job) => job.name === name)!;
const runsIn = (chat?: string) => rows("runs").filter((run) => run.conversationId === chat).sort((a, b) => a.startedAt - b.startedAt);
/** Run a job now and wait for that run to end; the run. */
async function runJob(name: string, seconds = 90) {
  const before = Date.now();
  const job = await jobNamed(name);
  await call("jobs:trigger", { id: job.id });
  await until(async () => { const chat = (await jobNamed(name)).chatId; return runsIn(chat).some((run) => run.startedAt >= before && run.status !== "running"); }, `${name} to run`, seconds);
  return runsIn((await jobNamed(name)).chatId).filter((run) => run.startedAt >= before).at(-1)!;
}
/** What the fake agent was last sent for a prompt that starts with this. */
const sent = (start: string) => log().filter((entry) => typeof entry.prompt === "string" && entry.prompt.startsWith(start) && !entry.limit).at(-1);
let token = "";
const WINDOW = (usedPercent: number, resetsAt: number) => ({ windows: [{ id: "five_hour", label: "5-hour", usedPercent, resetsAt, minutes: 300 }], at: Date.now() });
/** An engine's plan as the runner would report it: the fullest window, and no limit hit. */
const seed = (engine: string, usedPercent: number, resetsIn = 2 * 3_600_000) => call("usage:report", { token, engine, limits: WINDOW(usedPercent, Date.now() + resetsIn), hit: null });
const limited = (engine: string, on: boolean) => { const file = join(fakeHome, `${engine}-limited`); if (on) writeFileSync(file, "yes"); else rmSync(file, { force: true }); };
const summary = (route?: Route) => route && { engine: route.engine, model: route.model, effort: route.effort, tier: route.tier, by: route.by, why: route.why, movedFrom: route.movedFrom?.engine, retried: route.retried };

let aborted = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => (await jobs()).filter((job) => job.builtin).length === 3, "the built-in jobs", 90);
  // Nothing runs by the clock while this runs: each job here is run when the check says.
  for (const job of await jobs()) await call("jobs:update", { id: job.id, enabled: false });
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)
    && item.engines.some((engine) => engine.kind === "antigravity")), "the runner to report Grok signed in and Antigravity", 120);
  await sleep(5_000);

  // --- 12. No real engine: stop here, before anything is sent, if Codex or Claude Code is signed in -------------
  const real = (await computers()).flatMap((item) => item.engines).filter((engine) => (engine.kind === "codex" || engine.kind === "claude") && engine.signedIn);
  notes.realEngines = (await computers()).flatMap((item) => item.engines).map((engine) => `${engine.kind}: ${engine.signedIn ? "signed in" : "not signed in"}`);
  if (real.length) {
    aborted = true;
    check("noRealEngineSignedIn", false, real.map((engine) => engine.kind));
    throw new Error(`a real engine is signed in (${real.map((engine) => engine.kind).join(", ")}): stopped before anything was sent`);
  }
  check("noRealEngineSignedIn", true);

  // Antigravity on, with a fake Gemini key.
  const computer = (await computers()).find((item) => item.online)!;
  await call("dashboard:setKey", { key: KEY, name: "GEMINI_API_KEY", value: "fake-gemini-key-0123" });
  await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "antigravity", kind: "login", method: "gemini-api-key" });
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "antigravity" && engine.signedIn)), "Antigravity to be turned on", 120);
  await until(async () => {
    const options = await call<{ models: Array<{ id: string; engine?: string }> }>("models:options", { key: KEY });
    return ["grok", "antigravity"].every((engine) => options.models.some((model) => model.engine === engine && model.id !== "default"));
  }, "both engines' models", 60);
  token = String(rows("runners").find((row) => !row.revoked)?.token);
  // Grok has more of its plan left, so new work goes there first.
  await seed("grok", 20);
  await seed("antigravity", 40);
  const notesChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: notesChat, title: "Notes" });

  // --- 1, 3. Automatic choices, by the kind of work -------------------------------------------------------------
  const heartbeat = (await jobs()).find((job) => job.builtin === "heartbeat")!.name;
  const consolidate = (await jobs()).find((job) => job.builtin === "consolidate")!.name;
  await call("jobs:create", { name: "Pay rent reminder", at: new Date(Date.now() + 3_600_000).toISOString(), prompt: "Remind the owner to pay the rent today." });
  await call("jobs:create", { name: "Morning briefing", schedule: "0 8 * * *", prompt: "Write the owner a short morning briefing.", origin: notesChat });
  const auto: Record<string, unknown> = {};
  const expect = async (name: string, want: { tier: string; model: string; effort: string }, prompt: string) => {
    const run = await runJob(name);
    const fake = sent(prompt);
    auto[name] = { route: summary(run.route), sent: fake && { profile: fake.profile, model: fake.model, effort: fake.effort } };
    return run.route?.tier === want.tier && run.route.engine === "grok" && run.route.model === want.model && run.route.effort === want.effort && run.route.by === "auto"
      && fake?.profile === "grok" && fake.model === want.model && fake.effort === want.effort && run.status === "ok";
  };
  const quickHeartbeat = await expect(heartbeat, { tier: "quick", model: "grok-fake-fast", effort: "low" }, "⏰ Heartbeat");
  const quickReminder = await expect("Pay rent reminder", { tier: "quick", model: "grok-fake-fast", effort: "low" }, "⏰ Pay rent reminder");
  const standardJob = await expect("Morning briefing", { tier: "standard", model: "grok-fake-fast", effort: "medium" }, "⏰ Morning briefing");
  const deepConsolidation = await expect(consolidate, { tier: "deep", model: "grok-fake-heavy", effort: "high" }, "⏰ Memory consolidation");
  // Background tasks: a short brief and a long one.
  const runTask = async (title: string, prompt: string, pick?: object) => {
    const before = Date.now();
    const id = await call<string>("tasks:queue", { title, prompt, ...(pick ? { pick } : {}) });
    await until(() => { const task = rows("tasks").find((row) => row._id === id); return Boolean(task?.conversationId) && runsIn(task!.conversationId).some((run) => run.startedAt >= before && run.status !== "running"); }, `the task "${title}" to take a turn`, 90);
    // One turn shows what it ran on; it is done with there, so it does not carry on.
    await call("work:updateTask", { taskId: id, status: "done", result: "checked" });
    const task = rows("tasks").find((row) => row._id === id)!;
    return { task, run: runsIn(task.conversationId)[0] };
  };
  const short = await runTask("Find a dentist", "Find a dentist near the owner's office.");
  const long = await runTask("Compare three flats", `Compare three flats near the owner's work on rent, commute, light and noise, and write it up. ${"Look at each one's listing, the street at night, the bus lines, and what neighbours say. ".repeat(6)}`);
  auto.shortTask = summary(short.run.route);
  auto.longTask = summary(long.run.route);
  // A new chat: on the owner's default engine, not Codex.
  const fresh = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: fresh, title: "A new chat" });
  const freshReply = await exchange(fresh, "hello, which engine is this");
  const freshRun = runsIn(fresh)[0];
  auto.newChat = { route: summary(freshRun?.route), reply: freshReply.reply.slice(0, 80), engine: (await getChat(fresh)).engine };
  notes.automatic = auto;
  check("automaticQuickTier", quickHeartbeat && quickReminder);
  check("automaticStandardTier", standardJob && short.run.route?.tier === "standard" && short.run.route.model === "grok-fake-fast" && short.run.route.effort === "medium");
  check("automaticDeepTier", deepConsolidation && long.run.route?.tier === "deep" && long.run.route.model === "grok-fake-heavy" && long.run.route.effort === "high"
    && sent("🧩 Background task: Compare three flats")?.model === "grok-fake-heavy" && sent("🧩 Background task: Compare three flats")?.effort === "high");
  check("newChatOnTheDefaultEngine", freshRun?.route?.engine === "grok" && freshRun.route.by === "auto" && /your default engine/.test(freshRun.route.why)
    && (await getChat(fresh)).engine === "grok" && /Fake grok reply/.test(freshReply.reply));

  // --- 2. The owner's default engine wins while it has room --------------------------------------------------------
  // Antigravity has more of its plan left now, but Grok Build, the default, still has room: work stays on it.
  await seed("grok", 60);
  await seed("antigravity", 10);
  await call("jobs:create", { name: "Plant watering", schedule: "0 9 * * *", prompt: "Remind the owner to water the plants.", origin: notesChat });
  const onDefault = await runJob("Plant watering");
  const defaultChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: defaultChat, title: "Default chat" });
  await exchange(defaultChat, "which engine while the default has room");
  const defaultChatRun = runsIn(defaultChat)[0];
  notes.defaultWins = { job: summary(onDefault.route), chat: summary(defaultChatRun?.route) };
  check("defaultWinsWhileItHasRoom", onDefault.route?.engine === "grok" && onDefault.route.by === "auto" && !onDefault.route.movedFrom && /your default engine, which has room/.test(onDefault.route.why)
    && sent("⏰ Plant watering")?.profile === "grok" && onDefault.status === "ok"
    && defaultChatRun?.route?.engine === "grok" && !defaultChatRun.route.movedFrom && sent("which engine while the default has room")?.profile === "grok");
  await seed("grok", 20);
  await seed("antigravity", 40);

  // --- 4. The owner's pick wins ----------------------------------------------------------------------------------
  await call("jobs:setModel", { key: KEY, id: (await jobNamed("Morning briefing")).id, model: "gemini-fake-flash", engine: "antigravity" });
  const pinnedRun = await runJob("Morning briefing");
  const pinnedChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: pinnedChat, title: "Pinned chat" });
  await call("dashboard:setChatModel", { key: KEY, id: pinnedChat, model: "grok-fake-heavy", engine: "grok" });
  await call("dashboard:setChatEffort", { key: KEY, id: pinnedChat, effort: "low" });
  await exchange(pinnedChat, "pinned hello");
  const pinnedChatRun = runsIn(pinnedChat)[0];
  notes.ownerPick = { job: summary(pinnedRun.route), chat: summary(pinnedChatRun?.route), sent: sent("pinned hello") && { model: sent("pinned hello")!.model, effort: sent("pinned hello")!.effort } };
  check("ownerPickWinsForJob", pinnedRun.route?.by === "owner" && pinnedRun.route.engine === "antigravity" && pinnedRun.route.model === "gemini-fake-flash" && sent("⏰ Morning briefing")?.profile === "antigravity" && sent("⏰ Morning briefing")?.model === "gemini-fake-flash");
  check("ownerPickWinsForChat", pinnedChatRun?.route?.by === "owner" && pinnedChatRun.route.model === "grok-fake-heavy" && pinnedChatRun.route.effort === "low"
    && sent("pinned hello")?.model === "grok-fake-heavy" && sent("pinned hello")?.effort === "low");
  // Back to automatic for what follows.
  await call("jobs:setModel", { key: KEY, id: (await jobNamed("Morning briefing")).id });

  // --- 5. Perry's own pick, through its tools ---------------------------------------------------------------------
  const engines = await exchange(pinnedChat, "TOOL list_engines {}");
  const listed = log().filter((entry) => entry.tool === "list_engines").at(-1);
  await exchange(pinnedChat, `TOOL create_job ${JSON.stringify({ name: "Weekly research", schedule: "0 7 * * 1", prompt: "Research this week's papers on sleep and write a summary.", tier: "deep" })}`);
  await exchange(pinnedChat, `TOOL queue_task ${JSON.stringify({ title: "Sort the receipts", prompt: "Sort the receipts in Downloads into folders by month.", model: "antigravity/gemini-fake-flash", effort: "low" })}`);
  await exchange(pinnedChat, `TOOL create_job ${JSON.stringify({ name: "Bad pick", schedule: "0 7 * * 2", prompt: "Something that names a model nobody offers.", model: "grok/no-such-model" })}`);
  const refusedPick = log().filter((entry) => entry.tool === "create_job").at(-1);
  const research = await runJob("Weekly research");
  const receipts = rows("tasks").find((task) => task.title === "Sort the receipts");
  await until(() => { const task = rows("tasks").find((row) => row.title === "Sort the receipts"); return Boolean(task?.conversationId) && runsIn(task!.conversationId).some((run) => run.status !== "running"); }, "the receipts task to take a turn", 90);
  const receiptsRun = runsIn(rows("tasks").find((row) => row.title === "Sort the receipts")!.conversationId)[0];
  await call("work:updateTask", { taskId: receipts!._id, status: "done", result: "sorted" });
  notes.perryPick = { listEngines: String(listed?.answer ?? "").slice(0, 600), engines: engines.reply, research: summary(research.route), receipts: summary(receiptsRun?.route), refused: String(refusedPick?.answer ?? "").slice(0, 300) };
  check("listEnginesAnswers", /grok-fake-heavy/.test(String(listed?.answer)) && /antigravity/.test(String(listed?.answer)) && /room/.test(String(listed?.answer)));
  check("perryPickUsed", (await jobNamed("Weekly research")).pick?.tier === "deep" && research.route?.by === "perry" && research.route.tier === "deep" && research.route.model === "grok-fake-heavy" && research.route.effort === "high"
    && receiptsRun?.route?.by === "perry" && receiptsRun.route.engine === "antigravity" && receiptsRun.route.model === "gemini-fake-flash" && receiptsRun.route.effort === "low");
  check("unknownPickRefused", !(await jobs()).some((job) => job.name === "Bad pick") && /no-such-model/.test(String(refusedPick?.answer)));

  const modelsNow = async () => (await call<{ models: Array<{ id: string; engine?: string; isDefault: boolean; defaultEffort?: string }> }>("models:options", { key: KEY })).models
    .map((model) => `${model.engine}/${model.id}${model.isDefault ? "*" : ""}:${model.defaultEffort ?? "-"}`);
  notes.modelsAfterPicks = await modelsNow();
  // --- 6. Background work moves off an engine past the cap; a chat stays until its engine is used up ------------
  await seed("grok", 95);
  // The reminder follows the default, Grok Build.
  const moved = await runJob("Pay rent reminder");
  await exchange(pinnedChat, "still on grok at 95");
  const stayed = runsIn(pinnedChat).at(-1);
  notes.movedAtCap = { job: summary(moved.route), chat: summary(stayed?.route) };
  check("backgroundMovesPastCap", moved.route?.engine === "antigravity" && moved.route.movedFrom?.engine === "grok" && /95% of Grok Build's 5-hour limit is used/.test(moved.route.movedFrom.why)
    && moved.status === "ok" && sent("⏰ Pay rent reminder")?.profile === "antigravity");
  check("chatKeepsEngineWithRoom", stayed?.route?.engine === "grok" && !stayed.route.movedFrom && sent("still on grok at 95")?.profile === "grok");

  // --- 7. A chat whose engine is used up moves, and says so -------------------------------------------------------
  await seed("grok", 100);
  const movedReply = await exchange(pinnedChat, "grok is used up now");
  const movedRun = runsIn(pinnedChat).at(-1);
  const movedChat = await getChat(pinnedChat) as Awaited<ReturnType<typeof getChat>> & { moved?: { from: string; why: string } };
  notes.chatMoved = { route: summary(movedRun?.route), chat: { engine: movedChat.engine, moved: movedChat.moved }, reply: movedReply.reply.slice(0, 80) };
  check("chatMovesWhenUsedUp", movedRun?.route?.engine === "antigravity" && movedRun.route.movedFrom?.engine === "grok" && movedChat.engine === "antigravity"
    && movedChat.moved?.from === "grok" && /used up/.test(movedChat.moved.why) && /Fake antigravity reply to: grok is used up now/.test(movedReply.reply));
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const photo = async (name: string) => {
    // This computer's name stays out of the pictures, as redact() keeps it out of result.json.
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.split(${JSON.stringify(hostname())}).join("THIS-PC"); return true; })()`);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  // A page still loading has no body yet: that is "not yet", not a failure.
  const waitFor = (test: string, what: string, ms = 20_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { let ok = false; try { ok = Boolean(${test}); } catch {} ok ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); }; tick(); })`);
  await send("Page.navigate", { url: `${BASE}/chat/${pinnedChat}` });
  await waitFor(`document.body.innerText.includes("Moved to Antigravity")`, "the chat's moved note");
  const chatNote = await evaluate(`[...document.querySelectorAll('[role="alert"], [role="status"]')].map((el) => el.innerText).find((text) => text.includes("Moved to")) ?? document.body.innerText.match(/Moved to[^\\n]*/)?.[0] ?? ""`) as string;
  await photo("chat-moved.png");
  check("chatSaysItMoved", /Moved to Antigravity/.test(chatNote) && /Grok Build's 5-hour limit is used up/.test(chatNote), chatNote);

  notes.modelsAfterMove = await modelsNow();
  notes.learned = ["grok", "antigravity"].map((engine) => { try { return readFileSync(join(p.home, "engines", `${engine}.json`), "utf8"); } catch { return `${engine}: none`; } });
  // --- 8. Every engine used up: a job waits for the first reset, then runs --------------------------------------
  const resetAt = Date.now() + 60_000;
  await seed("grok", 100, 75_000);
  await call("usage:report", { token, engine: "antigravity", limits: WINDOW(100, resetAt), hit: null });
  const briefing = await jobNamed("Morning briefing");
  const runsBefore = runsIn(briefing.chatId).length;
  await call("jobs:trigger", { id: briefing.id });
  await until(async () => Boolean((await jobNamed("Morning briefing")).waiting), "the briefing to wait", 30);
  const waiting = (await jobNamed("Morning briefing")).waiting!;
  await sleep(5_000);
  const ranEarly = runsIn(briefing.chatId).length > runsBefore;
  await send("Page.navigate", { url: `${BASE}/work?tab=schedules` });
  await waitFor(`!!document.querySelector('[data-waiting]')`, "the Work page's waiting note");
  await evaluate(`document.querySelector('[data-waiting]').scrollIntoView({ block: "center" }); true`);
  await sleep(500);
  await photo("work-waiting.png");
  await until(() => runsIn(briefing.chatId).length > runsBefore && runsIn(briefing.chatId).at(-1)!.status !== "running", "the briefing to run after the reset", 150);
  const afterReset = runsIn(briefing.chatId).at(-1)!;
  const toldWait = (await messagesOf(notesChat)).filter((message) => message.role === "assistant" && /Morning briefing/.test(message.text) && /waiting/i.test(message.text));
  notes.allLimited = { waiting, ranEarly, run: { startedAt: afterReset.startedAt, resetAt, status: afterReset.status, route: summary(afterReset.route) }, told: toldWait.map((message) => message.text) };
  check("allLimitedWaits", !ranEarly && waiting.until >= resetAt && waiting.until < resetAt + 60_000 && /No engine has room/.test(waiting.why));
  check("runsAfterReset", afterReset.startedAt >= resetAt && afterReset.status === "ok" && !(await jobNamed("Morning briefing")).waiting && toldWait.length === 1);

  // --- 9. A turn refused part-way runs once more, on another engine ---------------------------------------------
  await seed("grok", 20);
  await seed("antigravity", 40);
  const retryChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: retryChat, title: "Retry chat" });
  await call("dashboard:setChatModel", { key: KEY, id: retryChat, model: "grok-fake-fast", engine: "grok" });
  limited("grok", true);
  const retried = await exchange(retryChat, "hello after the limit");
  const retryRuns = runsIn(retryChat);
  const retryTurns = rows("codexTurns").filter((turn) => turn.conversationId === retryChat);
  const refusedOnGrok = log().some((entry) => entry.limit && entry.profile === "grok" && String(entry.prompt).startsWith("hello after the limit"));
  notes.midTurn = { reply: retried.reply.slice(0, 100), runs: retryRuns.map((run) => ({ status: run.status, route: summary(run.route) })), turns: retryTurns.map((turn) => ({ engine: turn.engine, status: turn.status, retryOf: Boolean(turn.retryOf) })), refusedOnGrok };
  check("refusedTurnRetriedElsewhere", refusedOnGrok && retryRuns.length === 1 && retryRuns[0].status === "ok" && retryRuns[0].route?.retried === true
    && retryRuns[0].route.engine === "antigravity" && retryRuns[0].route.movedFrom?.engine === "grok"
    && retryTurns.length === 2 && retryTurns.filter((turn) => turn.retryOf).length === 1
    && /Fake antigravity reply to: hello after the limit/.test(retried.reply) && (await getChat(retryChat)).engine === "antigravity");

  // --- 10. A job that failed on a limit waits for the reset, runs on the engine with room, and the owner hears once ---
  await call("usage:report", { token, engine: "grok", hit: null });
  const sweepReset = Date.now() + 60_000;
  await call("usage:report", { token, engine: "antigravity", limits: WINDOW(100, sweepReset), hit: null });
  await call("jobs:create", { name: "Inbox sweep", schedule: "0 6 * * *", prompt: "Sweep the owner's inbox and say what needs a reply.", origin: notesChat });
  const sweepJob = await jobNamed("Inbox sweep");
  await call("jobs:trigger", { id: sweepJob.id });
  await until(async () => Boolean((await jobNamed("Inbox sweep")).waiting), "the failed sweep to wait for the reset", 60);
  const afterFailure = await jobNamed("Inbox sweep");
  const failedRun = runsIn(afterFailure.chatId)[0];
  limited("grok", false);
  await until(async () => { const job = await jobNamed("Inbox sweep"); return Boolean(job.lastResult) && !job.waiting; }, "the sweep to run again after the reset", 150);
  const recovered = await jobNamed("Inbox sweep");
  const sweepRuns = runsIn(recovered.chatId);
  await sleep(3_000);
  const told = (await messagesOf(notesChat)).filter((message) => message.role === "assistant" && /Inbox sweep/.test(message.text) && /didn't run/.test(message.text));
  notes.recovery = {
    failedRun: { status: failedRun?.status, error: failedRun?.error, route: summary(failedRun?.route) },
    waiting: afterFailure.waiting, rerun: summary(recovered.route), runs: sweepRuns.map((run) => ({ status: run.status, startedAt: run.startedAt })), sweepReset, told: told.map((message) => message.text),
  };
  check("failedJobRerunAfterReset", failedRun?.status === "error" && /rate limit for your plan/.test(failedRun.error ?? "") && sweepRuns.length === 2 && sweepRuns[1].status === "ok" && sweepRuns[1].startedAt >= sweepReset
    && recovered.route?.engine === "antigravity" && recovered.route.movedFrom?.engine === "grok" && !recovered.lastError);
  check("ownerToldOnce", told.length === 1 && /didn't run: Grok Build refused it for its plan's limit\. No engine has room: Antigravity's 5-hour limit is used up/.test(told[0].text));

  // --- 11. The Work page shows the move, and "Keep on…" pins it back ---------------------------------------------
  await send("Page.navigate", { url: `${BASE}/work?tab=schedules` });
  await waitFor(`[...document.querySelectorAll('[data-moved]')].some((el) => el.innerText.includes("Moved to Antigravity"))`, "the Work page's moved note");
  await evaluate(`[...document.querySelectorAll('[data-moved]')].find((el) => el.closest('li')?.innerText.includes("Inbox sweep")).scrollIntoView({ block: "center" }); true`);
  await sleep(500);
  const movedRow = await evaluate(`[...document.querySelectorAll('li')].find((el) => el.querySelector('h3')?.innerText === "Inbox sweep")?.innerText ?? ""`) as string;
  await photo("work-moved.png");
  await evaluate(`[...document.querySelectorAll('li')].find((el) => el.querySelector('h3')?.innerText === "Inbox sweep").querySelector('[data-moved] button').click(); true`);
  await until(async () => Boolean((await jobNamed("Inbox sweep")).stay), "Keep on Grok Build to save", 20);
  const kept = await jobNamed("Inbox sweep");
  await waitFor(`[...document.querySelectorAll('li')].find((el) => el.querySelector('h3')?.innerText === "Inbox sweep")?.querySelector('[data-kept]')`, "the kept note");
  await photo("work-kept.png");
  notes.workPage = { movedRow, kept: { engine: kept.engine, model: kept.model, stay: kept.stay } };
  check("workPageShowsMove", /Moved to Antigravity: Grok Build refused a reply for its plan's limit/.test(movedRow) && /Keep on Grok Build/.test(movedRow) && /Last run on Antigravity/.test(movedRow));
  check("keepOnPinsItBack", kept.stay === true && kept.engine === "grok" && kept.model === "grok-fake-fast");

  // --- 3, 12. The run's details say what it ran on and why --------------------------------------------------------
  await send("Page.navigate", { url: `${BASE}/activity` });
  await waitFor(`[...document.querySelectorAll('li')].some((el) => el.innerText.includes("hello after the limit"))`, "the retried run in Activity");
  await evaluate(`(() => { const row = [...document.querySelectorAll('li')].find((el) => el.innerText.includes("hello after the limit")); row.setAttribute("data-e2e-run", ""); row.querySelector('button').click(); return true; })()`);
  await waitFor(`!!document.querySelector('[data-e2e-run] [data-route]')?.offsetParent`, "the run's route");
  await evaluate(`document.querySelector('[data-e2e-run] [data-route]').scrollIntoView({ block: "center" }); true`);
  await sleep(500);
  const details = await evaluate(`document.querySelector('[data-e2e-run] [data-route]').innerText`) as string;
  await photo("run-details.png");
  notes.runDetails = details;
  check("runDetailsSayWhy", /Antigravity · gemini-fake-pro at medium/.test(details) && /Moved from Grok Build to Antigravity/.test(details) && /Grok Build refused it for its plan's limit/.test(details) && /ran there after its first engine refused it/.test(details));
  notes.pageErrors = browser.errors;
  check("noPageErrors", browser.errors.length === 0);
  check("screenshots", ["chat-moved.png", "work-waiting.png", "work-moved.png", "work-kept.png", "run-details.png"].every((name) => existsSync(join(outDir, name))));

  // --- 12. Only the fake engines ran anything --------------------------------------------------------------------
  const turnEngines = [...new Set(rows("codexTurns").map((turn) => turn.engine ?? "codex"))];
  notes.turnEngines = turnEngines;
  check("onlyFakeEnginesRan", turnEngines.every((engine) => engine === "grok" || engine === "antigravity")
    && (await computers()).flatMap((item) => item.engines).every((engine) => !((engine.kind === "codex" || engine.kind === "claude") && engine.signedIn)));
  check("completed", true);
} catch (error) {
  notes.stoppedAt = String(error);
  if (!aborted) check("completed", false);
} finally {
  files.close();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
const passed = await p.finish();
process.exit(passed ? 0 : 1);
