import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FAKE_AGENT, REPO, perry, sleep } from "../engine-acp/harness";
import type { TurnHandle, TurnInput, TurnSink } from "../../runner/engine";
import { boardLink } from "../../lib/board-links";

/** Real SDK/stdio recovery checks; no server, real engine, login or installer. */
async function protocolRecovery(outDir: string): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), "perry-engine-protocol-"));
  const provider = join(home, "provider");
  const cwd = join(home, "workspace");
  const checks: Array<{ name: string; pass: boolean; error?: string }> = [];
  const details: Record<string, unknown> = {};
  let kill = () => {};
  const deadline = <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Protocol recovery deadline elapsed")), ms); })]).finally(() => clearTimeout(timer));
  };
  try {
    process.env.PERRY_HOME = home;
    process.env.FAKE_ACP_HOME = provider;
    process.env.PERRY_GROK_COMMAND = `"${process.execPath}" "${FAKE_AGENT}" --profile grok`;
    mkdirSync(provider); mkdirSync(cwd);
    writeFileSync(join(provider, "grok-signed-in"), "synthetic");
    const { GrokEngine } = await import("../../runner/engines/grok");
    const warnings: string[] = [];
    const engine = new GrokEngine(message => warnings.push(message));
    kill = () => engine.kill();
    const input: TurnInput = { instructions: "Synthetic protocol verification.", prompt: "RECALL", attachments: [], cwd, access: "supervised" };
    let handle: TurnHandle | undefined;
    const sink: TurnSink = {
      onSession: async () => {}, onStarted: value => { handle = value; },
      onRequest: async request => { const choice = request.options.find(option => option.kind === "decline"); assert.ok(choice); return choice.id; },
    };
    const log = (): Array<Record<string, any>> => existsSync(join(provider, "log.jsonl"))
      ? readFileSync(join(provider, "log.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const check = async (name: string, run: () => Promise<void>) => {
      try { await run(); checks.push({ name, pass: true }); }
      catch (error) { checks.push({ name, pass: false, error: String(error) }); }
    };
    await check("Removed model refuses dispatch instead of silently using another model", async () => {
      const before = log().filter(item => item.prompt).length;
      let failure: string | undefined;
      try { await engine.runTurn({ ...input, model: "model-that-was-removed" }, sink); }
      catch (error) { failure = String(error); }
      details.removedModel = { failure, dispatched: log().filter(item => item.prompt).length - before };
      assert.match(failure ?? "", /model.*(available|offer|choose)|choose.*model/i);
      assert.equal(log().filter(item => item.prompt).length, before);
    });
    await check("Valid model and native defaults retain their actual selection", async () => {
      const selected = await engine.runTurn({ ...input, model: "grok-fake-heavy", prompt: 'SAY "Selected heavy model"' }, sink);
      assert.equal(log().filter(item => item.prompt).at(-1)?.model, "grok-fake-heavy");
      await engine.runTurn({ ...input, resumeCursor: selected.cursor, prompt: 'SAY "Keep session model"' }, sink);
      assert.equal(log().filter(item => item.prompt).at(-1)?.model, "grok-fake-heavy");
      await engine.runTurn({ ...input, prompt: 'SAY "Fresh native default"' }, sink);
      assert.equal(log().filter(item => item.prompt).at(-1)?.model, "grok-fake-fast");
    });
    for (const kind of ["missing", "boolean"]) await check(`Explicit model refuses a ${kind} model option; native default still runs`, async () => {
      const control = join(provider, "model-option-kind");
      writeFileSync(control, kind);
      try {
        const before = log().filter(item => item.prompt).length;
        let failure: string | undefined;
        try { await engine.runTurn({ ...input, model: "grok-fake-heavy" }, sink); }
        catch (error) { failure = String(error); }
        assert.match(failure ?? "", /choose.*model|model.*(offer|select|available)/i);
        assert.equal(log().filter(item => item.prompt).length, before);
        const native = await engine.runTurn({ ...input, prompt: 'SAY "Native selection without a model option"' }, sink);
        assert.equal(native.state, "completed");
        const defaultSelection = await engine.runTurn({ ...input, model: "default", prompt: 'SAY "Explicit native default without a model option"' }, sink);
        assert.equal(defaultSelection.state, "completed");
      } finally { rmSync(control, { force: true }); }
    });
    await check("Answered and throwing permissions release cancellation listeners", async () => {
      const listeners: number[] = [];
      let lastSignal: AbortSignal | undefined;
      let requested = 0;
      let began!: () => void;
      const started = new Promise<void>(done => { began = done; });
      const requests: TurnSink = {
        ...sink, onStarted: value => { handle = value; began(); },
        onRequest: async request => {
          requested++; assert.ok(handle);
          const connection = Reflect.get(engine, "conn") as { sessions: Map<string, { turn: { stop: AbortController } }> };
          lastSignal = connection.sessions.get(handle.cursor)!.turn.stop.signal;
          listeners.push(getEventListeners(lastSignal, "abort").length);
          if (requested % 2 === 0) throw new Error("Synthetic permission UI closed");
          const choice = request.options.find(option => option.kind === "decline"); assert.ok(choice); return choice.id;
        },
      };
      const running = engine.runTurn({ ...input, prompt: "RUN primary synthetic command" }, requests);
      await deadline(started, 15_000); assert.ok(handle);
      for (let index = 0; index < 20; index++) await engine.steer(handle, { prompt: `RUN synthetic approval ${index}`, attachments: [] });
      const result = await running;
      const after = lastSignal ? getEventListeners(lastSignal, "abort").length : -1;
      details.permissionListeners = { requested, max: Math.max(...listeners), after, state: result.state };
      assert.equal(requested, 21); assert.ok(Math.max(...listeners) <= 1); assert.equal(after, 0);
    });
    await check("Stop concurrent with approval returns cancelled to the agent", async () => {
      const stopping: TurnSink = { ...sink, onRequest: request => {
        assert.ok(handle); void engine.interrupt(handle);
        const choice = request.options.find(option => option.kind === "accept"); assert.ok(choice); return Promise.resolve(choice.id);
      } };
      const result = await engine.runTurn({ ...input, prompt: "RUN stop-approval-race" }, stopping);
      const outcome = log().filter(item => item.command === "stop-approval-race" && item.permission).at(-1);
      details.stopApproval = { state: result.state, outcome: outcome?.outcome };
      assert.equal(outcome?.outcome?.outcome, "cancelled");
    });
    await check("Restart resumes sessions; missing session receives history once", async () => {
      const first = await engine.runTurn({ ...input, prompt: 'SAY "Persistent fixture memory"' }, sink);
      engine.reload();
      const resumed = await engine.runTurn({ ...input, prompt: "RECALL", resumeCursor: first.cursor }, sink);
      assert.equal(resumed.cursor, first.cursor); assert.match(resumed.text, /Persistent fixture memory/);
      const replaced = await engine.runTurn({ ...input, resumeCursor: "lost-session-fixture", history: "Earlier owner request: HISTORY-RECOVERY-FIXTURE" }, sink);
      assert.notEqual(replaced.cursor, "lost-session-fixture");
      assert.equal(log().filter(item => item.context?.includes("HISTORY-RECOVERY-FIXTURE")).length, 1);
    });
    await check("Engine crash retains partial text and the next turn resumes", async () => {
      let received!: () => void;
      const firstChunk = new Promise<void>(done => { received = done; });
      const running = engine.runTurn({ ...input, prompt: "SLOW crash recovery" }, { ...sink, onEvent: event => { if (event.type === "text" && event.stream === "assistant") received(); } });
      await deadline(firstChunk, 15_000); assert.ok(handle);
      const previous = handle.cursor;
      const connection = Reflect.get(engine, "conn") as { child: import("node:child_process").ChildProcess };
      const { killTree } = await import("../../runner/engines/process");
      killTree(connection.child, "SIGKILL");
      const failed = await deadline(running, 15_000);
      assert.equal(failed.state, "failed"); assert.ok(failed.text.length > 0);
      const recovered = await engine.runTurn({ ...input, resumeCursor: previous, prompt: "RECALL", history: "The interrupted reply already started." }, sink);
      details.crashRecovery = { failed, recovered, warnings: warnings.slice(-3) };
      assert.equal(recovered.state, "completed"); assert.equal(recovered.cursor, previous);
    });
    await check("Ignored cancellation is bounded and a hung session recovers", async () => {
      const previousIdle = process.env.PERRY_ACP_IDLE_MS;
      process.env.PERRY_ACP_IDLE_MS = "100";
      const hanging = new GrokEngine(message => warnings.push(message));
      if (previousIdle === undefined) delete process.env.PERRY_ACP_IDLE_MS; else process.env.PERRY_ACP_IDLE_MS = previousIdle;
      try {
        const began = Date.now();
        const result = await deadline(hanging.runTurn({ ...input, prompt: "HANG" }, sink), 40_000);
        assert.equal(result.errorCode, "idle_timeout"); assert.ok(result.text.includes("Working"));
        assert.ok(Date.now() - began < 35_000);
        const recovered = await hanging.runTurn({ ...input, resumeCursor: result.cursor, prompt: "RECALL" }, sink);
        assert.equal(recovered.state, "completed"); assert.equal(recovered.cursor, result.cursor);
      } finally { hanging.kill(); }
    });
    await check("Previously advertised thinking level refuses before dispatch when the live select removes it", async () => {
      const advertised = (await engine.status()).models.find(model => model.id === "grok-fake-fast");
      assert.ok(advertised);
      assert.ok(advertised.efforts?.includes("high"));
      const control = join(provider, "effort-option-kind");
      writeFileSync(control, "remove-high");
      try {
        const before = log().filter(item => item.prompt).length;
        let failure: string | undefined;
        try { await engine.runTurn({ ...input, model: "grok-fake-fast", effort: "high" }, sink); }
        catch (error) { failure = String(error); }
        const dispatched = log().filter(item => item.prompt).length - before;
        details.staleEffort = { advertised: advertised.efforts, requested: "high", failure, dispatched };
        assert.match(failure ?? "", /no longer offers.*high.*Default/);
        assert.equal(dispatched, 0);
        assert.equal((await engine.runTurn({ ...input, effort: "medium" }, sink)).state, "completed");
      } finally { rmSync(control, { force: true }); }
    });
    await check("Missing and boolean effort controls keep native replies without inventing offered levels", async () => {
      const control = join(provider, "effort-option-kind");
      try {
        for (const kind of ["missing", "boolean"]) {
          writeFileSync(control, kind);
          const result = await engine.runTurn(input, sink);
          const reported = (await engine.status()).models.find(model => model.id === "grok-fake-fast");
          assert.equal(result.state, "completed");
          assert.deepEqual(reported?.efforts, []);
          assert.equal(reported?.defaultEffort, undefined);
        }
      } finally { rmSync(control, { force: true }); }
    });
    await check("Changed effort defaults remain offered and valid explicit choices still execute", async () => {
      const cache = join(home, "engines", "grok.json");
      writeFileSync(cache, JSON.stringify({ models: [
        { id: "grok-fake-fast", name: "grok-fake-fast", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
        { id: "grok-fake-heavy", name: "grok-fake-heavy", efforts: ["low", "medium", "high"], defaultEffort: "high" },
      ] }));
      const defaults = new GrokEngine(message => warnings.push(message));
      const control = join(provider, "effort-option-kind");
      try {
        assert.equal((await defaults.status()).models.find(model => model.id === "grok-fake-heavy")?.defaultEffort, "high");
        writeFileSync(control, "remove-high");
        await defaults.runTurn({ ...input, model: "grok-fake-heavy" }, sink);
        const reported = (await defaults.status()).models.find(model => model.id === "grok-fake-heavy");
        details.changedEffortDefault = reported;
        assert.equal(reported?.defaultEffort, "medium");
        assert.ok(reported.efforts?.includes(reported.defaultEffort));
        rmSync(control, { force: true });
        assert.equal((await defaults.runTurn({ ...input, model: "grok-fake-heavy", effort: "high" }, sink)).state, "completed");
        assert.equal(log().filter(item => item.prompt).at(-1)?.effort, "high");
      } finally { defaults.kill(); rmSync(control, { force: true }); }
    });
  } catch (error) { checks.push({ name: "Protocol journey completed", pass: false, error: String(error) }); }
  finally {
    kill();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "result.json"), JSON.stringify({ pass: checks.every(check => check.pass), checks, details }, null, 2));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
  console.log(JSON.stringify({ checks, details }, null, 2));
  return checks.length > 0 && checks.every(check => check.pass);
}

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
if (process.argv.includes("--protocol-only")) process.exit(await protocolRecovery(outDir) ? 0 : 1);
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
  env: { PERRY_EMBED_MODEL: "choose-engine-fixture", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(REPO, "artifacts", "choose-engine", "embedding.mjs")).href}` },
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
      PERRY_GROK_COMMAND: `"${process.execPath}" "${FAKE_AGENT}" --profile grok`,
      PERRY_ANTIGRAVITY_RELEASE: releaseFile,
      FAKE_ACP_HOME: fakeHome,
      CODEX_HOME: join(home, "codex-empty"),
      CLAUDE_CONFIG_DIR: join(home, "claude-empty"),
      PERRY_OPENCODE_COMMAND: JSON.stringify(join(home, "missing-opencode")),
    };
  },
});
const { BASE, KEY, call, check, notes, until, rows, getChat, computers, exchange, messagesOf, fakeLog } = p;
const log = () => fakeLog(fakeHome);

async function inspectRunRoute(browser: Awaited<ReturnType<typeof p.openBrowser>>, runId: string) {
  const { evaluate, send } = browser;
  const pane = `[data-pane="run:${runId}"]`;
  const wait = (test: string, reason: string) => until(() => evaluate(`Boolean(${test})`), reason, 25);
  const photo = async (name: string) => {
    await evaluate(`(() => { const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); for(let node;(node=walk.nextNode());) node.nodeValue=node.nodeValue.split(${JSON.stringify(hostname())}).join('THIS-PC'); })()`);
    const shot = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64"));
  };
  await send("Page.navigate", { url: BASE + boardLink({ channel: "chats", tab: "all", thread: `run:${runId}` }) });
  await wait(`!!document.querySelector('${pane} [data-route] summary')`, "the saved run's routing disclosure");
  notes.routeFocusBefore = await evaluate(`({ focused:document.hasFocus(),active:document.activeElement?.tagName })`);
  await send("Page.bringToFront", {});
  await wait("document.hasFocus()", "the routing page's native keyboard focus");
  await evaluate(`document.querySelector('${pane} [data-route] summary').focus(); true`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  notes.routeFocusAfter = await evaluate(`({ focused:document.hasFocus(),active:document.activeElement?.tagName,open:document.querySelector('${pane} [data-route]').open })`);
  await wait(`document.querySelector('${pane} [data-route]').open`, "keyboard-opened routing disclosure");
  check("runDetailsKeyboardAccessible", Boolean(await evaluate(`document.activeElement===document.querySelector('${pane} [data-route] summary') && document.activeElement.getBoundingClientRect().height>=44`)));
  const details = String(await evaluate(`document.querySelector('${pane}').innerText`));
  notes.runDetails = details;
  check("runDetailsSayWhy", /Antigravity · gemini-fake-pro at medium/.test(details) && /Moved from Grok Build to Antigravity/.test(details) && /Grok Build refused it for its plan's limit/.test(details) && /recovered from a usage limit/.test(details));
  await photo("run-details.png");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await wait(`!!document.querySelector('[role="dialog"][aria-label="Thread"] [data-route] summary')`, "the phone routing disclosure");
  await wait(`!!document.querySelector('[role="dialog"] [data-work-timeline]') && !document.querySelector('[role="dialog"] [aria-label="Loading activity"]')`, "the phone run's loaded activity");
  await send("Page.bringToFront", {});
  await evaluate(`document.querySelector('[role="dialog"] [data-route] summary').scrollIntoView({block:'center',behavior:'instant'}); true`);
  const tap = await evaluate(`(() => { const summary=document.querySelector('[role="dialog"] [data-route] summary'); const box=summary.getBoundingClientRect(); const x=box.x+box.width/2,y=box.y+box.height/2; return {x,y,open:summary.parentElement.open,hit:document.elementFromPoint(x,y)?.outerHTML,viewport:{width:innerWidth,height:innerHeight},box:{width:box.width,height:box.height}}; })()`) as { x: number; y: number; open: boolean };
  notes.routeTouchBefore = tap;
  try {
    notes.touchActivation = "Unverified: native CDP touch gestures did not activate the disclosure; keyboard and 44px target are verified separately.";
    if (!tap.open) {
      await evaluate(`document.querySelector('[role="dialog"] [data-route] summary').focus(); true`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
    await wait(`document.querySelector('[role="dialog"] [data-route]').open`, "keyboard-opened phone routing disclosure");
    check("runDetailsPhoneReadable", Boolean(await evaluate(`(() => { const pane=document.querySelector('[role="dialog"][aria-label="Thread"]'); return pane.scrollWidth<=pane.clientWidth+1 && document.body.scrollWidth<=innerWidth+1 && pane.innerText.includes('recovered from a usage limit') && pane.querySelector('[data-route] summary').getBoundingClientRect().height>=44; })()`)));
  } finally {
    notes.routeTouchAfter = await evaluate(`({open:document.querySelector('[role="dialog"] [data-route]')?.open,focused:document.hasFocus(),active:document.activeElement?.tagName})`);
    await photo("run-details-phone.png");
  }
  await send("Emulation.clearDeviceMetricsOverride", {});
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

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
  await call("jobs:tick"); // Initialize fixture schedules without waiting for the minute cron.
  await until(async () => ["heartbeat", "daily-summary", "consolidate", "brain-review"].every(kind => (rows("jobs")).some(job => job.builtin === kind)), "the built-in jobs", 90);
  // Nothing runs by the clock while this runs: each job here is run when the check says.
  for (const job of await jobs()) await call("jobs:update", { id: job.id, enabled: false });
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)
    && item.engines.some((engine) => engine.kind === "antigravity")), "the runner to report Grok signed in and Antigravity", 120);
  await sleep(5_000);

  // --- 12. No real engine: stop here, before anything is sent, if Codex or Claude Code is signed in -------------
  const real = (await computers()).flatMap((item) => item.engines).filter((engine) => !["grok", "antigravity"].includes(engine.kind) && engine.signedIn);
  notes.realEngines = (await computers()).flatMap((item) => item.engines).map((engine) => `${engine.kind}: ${engine.signedIn ? "signed in" : "not signed in"}`);
  if (real.length) {
    aborted = true;
    check("noRealEngineSignedIn", false, real.map((engine) => engine.kind));
    throw new Error(`a real engine is signed in (${real.map((engine) => engine.kind).join(", ")}): stopped before anything was sent`);
  }
  check("noRealEngineSignedIn", true);

  if (process.argv.includes("--readiness-only")) {
    const heartbeat = (await jobs()).find(job => job.builtin === "heartbeat")!;
    const before = rows("codexTurns").length;
    const refused = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path: "jobs:run", args: { id: heartbeat.id } }) });
    const reply = await refused.json() as { error?: string };
    const saved = (await jobs()).find(job => job.id === heartbeat.id)!;
    check("readinessRefusalIsActionable400", refused.status === 400 && /Sign in to Codex or Claude Code/.test(reply.error ?? ""));
    check("readinessRefusalIsDurable", /Sign in to Codex or Claude Code/.test(saved.lastError ?? "") && !saved.waiting);
    check("readinessRefusalNeverStartsUnsafeTurn", rows("codexTurns").length === before && !rows("conversations").some(chat => chat.jobId === heartbeat.id && chat.pendingTurns > 0));
    notes.readiness = { status: refused.status, reply, saved, newTurns: rows("codexTurns").length - before };
    notes.readinessThread = await call("board:thread", { key: KEY, id: `job:${heartbeat.id}` });
    const browser = await p.openBrowser();
    await browser.send("Page.navigate", { url: `${BASE}/board?channel=heartbeat&tab=all&thread=job:${heartbeat.id}` });
    try {
      await until(() => browser.evaluate(`Boolean(document.querySelector('[data-pane="job:${heartbeat.id}"]')?.innerText.includes('Sign in to Codex or Claude Code'))`), "durable job recovery shown in Work", 30);
    } finally {
      notes.readinessPageErrors = browser.errors;
      notes.readinessPane = await browser.evaluate(`document.querySelector('[data-pane="job:${heartbeat.id}"]')?.innerText ?? document.body?.innerText`);
      const shot = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      writeFileSync(join(outDir, "job-readiness.png"), Buffer.from(shot.data, "base64"));
    }
    check("readinessRecoveryVisibleInWork", true);
    check("readinessRecoveryNoPageErrors", browser.errors.length === 0);
    check("completed", true);
  } else if (process.argv.includes("--model-recovery-only")) {
    // A stale CLI catalog still offers heavy, but a newly opened ACP session no longer does.
    // Failure inventory: silent default dispatch, running chat stuck, hidden error, model picker
    // unusable after refusal, successful repair sent twice, and a different model used after repair.
    const chat = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id: chat, engine: "grok", model: "grok-fake-heavy" });
    const control = join(fakeHome, "model-option-kind");
    writeFileSync(control, "remove-heavy");
    try {
      const before = log().filter(item => item.prompt).length;
      await call("dashboard:sendChat", { key: KEY, id: chat, text: "Unchanged owner request before model repair" });
      await until(async () => { const state = await getChat(chat); return !state.isRunning && Boolean(state.lastError); }, "the refused model to finish idle", 45);
      const state = await getChat(chat);
      check("removedModelIsIdleWithRecovery", !state.isRunning && /no longer offers.*grok-fake-heavy.*Choose another model/.test(state.lastError ?? ""));
      check("removedModelNeverDispatchesDefault", log().filter(item => item.prompt).length === before);
      const browser = await p.openBrowser();
      const { evaluate, send } = browser;
      await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
      await until(() => evaluate(`Boolean(document.querySelector('[data-turn-error-code] summary'))`), "failed turn details", 30);
      await evaluate(`document.querySelector('[data-turn-error-code] summary').click(); true`);
      await until(() => evaluate(`Boolean(document.body?.innerText.includes('Choose another model for this chat'))`), "owner-visible model recovery", 30);
      check("removedModelRecoveryVisible", true);
      const failedShot = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
      writeFileSync(join(outDir, "model-refused.png"), Buffer.from(failedShot.data, "base64"));
      await evaluate(`document.querySelector('button[aria-label="Reply options"]').click(); true`);
      await until(() => evaluate(`Boolean(document.querySelector('button[aria-label="Model"]'))`), "model chooser");
      await evaluate(`document.querySelector('button[aria-label="Model"]').click(); true`);
      await until(() => evaluate(`[...document.querySelectorAll('[role="option"]')].some(item => item.innerText.includes('grok-fake-fast'))`), "valid model choice");
      await evaluate(`[...document.querySelectorAll('[role="option"]')].find(item => item.innerText.includes('grok-fake-fast')).click(); true`);
      await until(async () => (await getChat(chat)).model === "grok-fake-fast", "saved valid owner model");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
      await evaluate(`(() => { const editor = document.querySelector('[contenteditable="true"]'); editor.focus(); const range=document.createRange(); range.selectNodeContents(editor); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; })()`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
      await send("Input.insertText", { text: "SAY \"Recovered after owner model repair\"" });
      await until(() => evaluate(`Boolean(document.querySelector('button[aria-label="Send message"]:not(:disabled)'))`), "enabled composer after repair");
      await evaluate(`document.querySelector('button[aria-label="Send message"]').click(); true`);
      await until(async () => !(await getChat(chat)).isRunning && (await messagesOf(chat)).some(message => message.role === "assistant" && message.text.includes("Recovered after owner model repair")), "repaired owner reply", 45);
      const repaired = await getChat(chat);
      notes.modelRecovery = { refused: state, repaired, providerCalls: log().filter(item => item.prompt).slice(before), pageErrors: browser.errors };
      check("ownerCanChooseAndResubmit", !repaired.isRunning && !repaired.lastError && repaired.model === "grok-fake-fast");
      check("modelRepairDispatchesExactlyOnce", log().filter(item => item.prompt).length === before + 1 && log().filter(item => item.prompt).at(-1)?.model === "grok-fake-fast");
      check("modelRecoveryNoPageErrors", browser.errors.length === 0);
      const repairedShot = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
      writeFileSync(join(outDir, "model-recovered.png"), Buffer.from(repairedShot.data, "base64"));
    } finally { rmSync(control, { force: true }); }
    check("completed", true);
  } else {

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
  if (process.argv.includes("--routing-ui-only")) {
    const chat = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });
    limited("grok", true);
    const reply = await exchange(chat, "hello after the limit");
    const run = runsIn(chat)[0];
    check("routingUiUsesRealRetry", run.status === "ok" && run.route?.retried === true && run.route.engine === "antigravity" && reply.reply.includes("Fake antigravity reply"));
    const browser = await p.openBrowser();
    await inspectRunRoute(browser, run._id);
    notes.pageErrors = browser.errors;
    check("noPageErrors", browser.errors.length === 0);
    check("onlyFakeEnginesRan", rows("codexTurns").every(turn => ["grok", "antigravity"].includes(turn.engine)));
    check("completed", true);
  } else {
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
  const heartbeatJob = await jobNamed(heartbeat);
  const beforeHeartbeat = rows("codexTurns").length;
  let heartbeatRefusal = "";
  try { await call("jobs:run", { id: heartbeatJob.id }); }
  catch (error) { heartbeatRefusal = String(error); }
  notes.heartbeatReadiness = { refusal: heartbeatRefusal, job: await jobNamed(heartbeat), newTurns: rows("codexTurns").length - beforeHeartbeat };
  check("heartbeatRequiresNativeToolLockdown", Boolean(heartbeatRefusal) && rows("codexTurns").length === beforeHeartbeat);
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
  check("automaticQuickTier", quickReminder);
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
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  await send("Page.navigate", { url: `${BASE}/chat/${pinnedChat}` });
  await send("Page.bringToFront", {});
  await until(() => evaluate(`Boolean(document.querySelector('button[aria-label="Reply options"]'))`), "the owner command composer", 30);
  // Let the real UI resolve its reported model/effort catalog before validating a command.
  await evaluate(`document.querySelector('button[aria-label="Reply options"]').click(); true`);
  await until(() => evaluate(`!!document.querySelector('button[aria-label="Model"]:not(:disabled)') && document.querySelector('button[aria-label="Model"]').innerText.includes('grok-fake-heavy')`), "the selected model catalog", 30);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  const beforeInvalidEffort = log().filter(item => item.prompt).length;
  await evaluate(`(() => { const editor=document.querySelector('[contenteditable="true"]'); editor.focus(); const range=document.createRange(); range.selectNodeContents(editor); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; })()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  await send("Input.insertText", { text: "/think unsupported-effort-fixture" });
  await until(() => evaluate(`!!document.querySelector('button[aria-label="Send message"]:not(:disabled)')`), "the command submit control", 30);
  await evaluate(`document.querySelector('button[aria-label="Send message"]').click(); true`);
  await until(() => evaluate(`document.body.innerText.includes('has no thinking level')`), "the unsupported thinking level explanation", 30);
  const invalidEffort = String(await evaluate(`document.body.innerText`));
  notes.unsupportedEffort = { reply: invalidEffort.match(/[^\n]*has no thinking level[^\n]*/)?.[0], effort: (await getChat(pinnedChat) as { effort?: string }).effort };
  check("unsupportedThinkingLevelRefused", /has no thinking level.*unsupported-effort-fixture/.test(invalidEffort)
    && /low.*medium.*high/.test(invalidEffort) && (await getChat(pinnedChat) as { effort?: string }).effort === "low"
    && log().filter(item => item.prompt).length === beforeInvalidEffort);
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
  // Without a provider reset timestamp, the existing engine fallback remains available.
  await call("usage:report", { token, engine: "grok", limits: { windows: [], at: Date.now() }, hit: { at: Date.now(), message: "usage limit reached" } });
  const movedReply = await exchange(pinnedChat, "grok is used up now");
  const movedRun = runsIn(pinnedChat).at(-1);
  const movedChat = await getChat(pinnedChat) as Awaited<ReturnType<typeof getChat>> & { moved?: { from: string; why: string } };
  notes.chatMoved = { route: summary(movedRun?.route), chat: { engine: movedChat.engine, moved: movedChat.moved }, reply: movedReply.reply.slice(0, 80) };
  check("chatMovesWhenUsedUp", movedRun?.route?.engine === "antigravity" && movedRun.route.movedFrom?.engine === "grok" && movedChat.engine === "antigravity"
    && movedChat.moved?.from === "grok" && /plan's limit/.test(movedChat.moved.why) && /Fake antigravity reply to: grok is used up now/.test(movedReply.reply));
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
  check("chatSaysItMoved", /Moved to Antigravity/.test(chatNote) && /Grok Build refused a reply for its plan's limit/.test(chatNote), chatNote);

  notes.modelsAfterMove = await modelsNow();
  notes.learned = ["grok", "antigravity"].map((engine) => { try { return readFileSync(join(p.home, "engines", `${engine}.json`), "utf8"); } catch { return `${engine}: none`; } });
  // --- 8. Every engine used up: a job waits for the first reset, then runs --------------------------------------
  const resetAt = Date.now() + 15_000;
  await seed("grok", 100, 75_000);
  await call("usage:report", { token, engine: "antigravity", limits: WINDOW(100, resetAt), hit: null });
  const briefing = await jobNamed("Morning briefing");
  const runsBefore = runsIn(briefing.chatId).length;
  await call("jobs:trigger", { id: briefing.id });
  await until(async () => Boolean((await jobNamed("Morning briefing")).waiting), "the briefing to wait", 30);
  const waiting = (await jobNamed("Morning briefing")).waiting!;
  const ranEarly = runsIn(briefing.chatId).length > runsBefore;
  await send("Page.navigate", { url: BASE + boardLink({ channel: "jobs", tab: "all", thread: `job:${briefing.id}` }) });
  await waitFor(`document.querySelector('[data-pane="job:${briefing.id}"]')?.innerText.includes('No engine has room')`, "the Board job pane's waiting reason");
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

  // A real runner transports completed work and partial words through a late limit.
  limited("grok", false);
  await seed("grok", 20);
  await seed("antigravity", 40);
  const progressChat = await call<string>("dashboard:createChat", { key: KEY });
  const continued = await exchange(progressChat, "HANDOFF-CHECK finish the remaining synthetic work");
  const progressRuns = runsIn(progressChat);
  const progressTurns = rows("codexTurns").filter(turn => turn.conversationId === progressChat);
  check("mainAgentProgressContinues", continued.reply.includes("The action count is 1") && progressRuns.length === 1
    && progressRuns[0].status === "ok" && progressTurns.length === 2 && progressTurns[1].engine === "antigravity"
    && progressTurns[1].history?.includes("HANDOFF_COMPLETED_ACTION_ONCE") && progressTurns[1].history.includes("The synthetic action completed once.")
    && readFileSync(join(fakeHome, "handoff-completed-count"), "utf8") === "1");
  notes.mainAgentHandoff = { reply: continued.reply, route: summary(progressRuns[0]?.route), attempts: progressTurns.map(turn => turn.engine) };
  // A late limit with a known reset keeps the selected engine and native session.
  await seed("grok", 20);
  const resetChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: resetChat, text: "RESET-CHECK finish after the subscription reset" });
  await until(() => log().some(entry => entry.awaitingResetSeed), "the completed step before the usage reset", 60);
  const mainResetAt = Date.now() + 5_000;
  await call("usage:report", { token, engine: "grok", limits: WINDOW(100, mainResetAt), hit: null });
  await until(async () => Boolean((await getChat(resetChat) as any).waiting), "the main chat to wait for its reset", 30);
  await send("Page.navigate", { url: `${BASE}/chat/${resetChat}` });
  await waitFor(`!!document.querySelector('[data-reset-wait]')`, "the reset-wait note");
  await photo("main-reset-waiting.png");
  check("resetWaitVisible", String(await evaluate(`document.querySelector('[data-reset-wait]').innerText`)).includes("resumes automatically"));
  await until(() => Date.now() >= mainResetAt, "the provider reset", 30);
  check("noMainCallBeforeReset", rows("codexTurns").filter(turn => turn.conversationId === resetChat).length === 1);
  await until(async () => !(await getChat(resetChat)).isRunning && runsIn(resetChat).at(-1)?.status === "ok", "the main agent to resume after reset", 90);
  const resetTurns = rows("codexTurns").filter(turn => turn.conversationId === resetChat);
  check("mainResumesSelectedEngine", resetTurns.length === 2 && resetTurns.every(turn => turn.engine === "grok")
    && Boolean(resetTurns[0].sessionCursor) && resetTurns[1].sessionCursor === resetTurns[0].sessionCursor
    && resetTurns[1].startedAt >= mainResetAt + 15_000 && (await getChat(resetChat)).engine === "grok"
    && readFileSync(join(fakeHome, "reset-completed-count"), "utf8") === "1"
    && (await messagesOf(resetChat)).some(message => message.text.includes("Resumed after reset on the same engine")));
  notes.mainReset = { resetAt: mainResetAt, attempts: resetTurns.map(turn => ({ engine: turn.engine, sessionCursor: turn.sessionCursor, startedAt: turn.startedAt, resetResumes: turn.resetResumes })) };
  limited("grok", true);

  // --- 10. A job that failed on a limit waits for the reset, runs on the engine with room, and the owner hears once ---
  await call("usage:report", { token, engine: "grok", hit: null });
  const sweepReset = Date.now() + 5_000;
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
  await send("Page.navigate", { url: BASE + boardLink({ channel: "jobs", tab: "all", thread: `job:${sweepJob.id}` }) });
  await waitFor(`document.querySelector('[data-pane="job:${sweepJob.id}"]')?.innerText.includes('To Antigravity')`, "the Board job pane's moved note");
  await sleep(500);
  const movedRow = await evaluate(`document.querySelector('[data-pane="job:${sweepJob.id}"]').innerText`) as string;
  await photo("work-moved.png");
  await evaluate(`[...document.querySelector('[data-pane="job:${sweepJob.id}"]').querySelectorAll('button')].find(button => button.innerText === 'Keep on Grok Build').click(); true`);
  await until(async () => Boolean((await jobNamed("Inbox sweep")).stay), "Keep on Grok Build to save", 20);
  const kept = await jobNamed("Inbox sweep");
  await waitFor(`document.body.innerText.includes('It stays on Grok Build now.') && !document.querySelector('[data-pane="job:${sweepJob.id}"]').innerText.includes('Keep on Grok Build')`, "the saved owner pin confirmation");
  await photo("work-kept.png");
  notes.workPage = { movedRow, kept: { engine: kept.engine, model: kept.model, stay: kept.stay } };
  check("workPageShowsMove", /To Antigravity: Grok Build refused a reply for its plan's limit/.test(movedRow) && /Keep on Grok Build/.test(movedRow) && /antigravity.*gemini-fake/i.test(movedRow));
  check("keepOnPinsItBack", kept.stay === true && kept.engine === "grok" && kept.model === "grok-fake-fast");

  // A persisted Keep on choice must affect the next scheduling decision, even while another engine is free.
  await seed("grok", 100);
  await seed("antigravity", 20);
  const beforePinnedWait = runsIn(kept.chatId).length;
  await call("jobs:trigger", { id: kept.id });
  await until(async () => Boolean((await jobNamed("Inbox sweep")).waiting), "the pinned job to wait instead of moving", 30);
  const pinnedWait = await jobNamed("Inbox sweep");
  check("keptEngineWaitsRatherThanMoves", pinnedWait.stay === true && pinnedWait.engine === "grok"
    && /you asked to keep it there/.test(pinnedWait.waiting?.why ?? "") && runsIn(kept.chatId).length === beforePinnedWait);
  await waitFor(`document.querySelector('[data-pane="job:${sweepJob.id}"]')?.innerText.includes('you asked to keep it there')`, "the persisted pin waiting reason");
  notes.keptWait = { waiting: pinnedWait.waiting, engine: pinnedWait.engine, newRuns: runsIn(kept.chatId).length - beforePinnedWait };
  await call("jobs:update", { id: kept.id, enabled: false });

  // Neither provider reports when it resets. Work must wait conservatively without dispatching a speculative prompt.
  const unknownResetAt = Date.now();
  for (const engine of ["grok", "antigravity"]) await call("usage:report", { token, engine, limits: { windows: [], at: unknownResetAt }, hit: { at: unknownResetAt, message: "usage limit reached without reset information" } });
  await call("jobs:create", { name: "Unknown reset hold", schedule: "0 8 * * *", prompt: "Keep this synthetic work pending until an engine has room." });
  const unknownReset = await jobNamed("Unknown reset hold");
  const beforeUnknownReset = rows("codexTurns").length;
  await call("jobs:trigger", { id: unknownReset.id });
  await until(async () => Boolean((await jobNamed("Unknown reset hold")).waiting), "the unknown-reset job to wait", 30);
  const unknownWait = (await jobNamed("Unknown reset hold")).waiting!;
  check("allExhaustedUnknownResetWaitsWithoutDispatch", unknownWait.until >= unknownResetAt + 3_600_000
    && /No engine has room/.test(unknownWait.why) && rows("codexTurns").length === beforeUnknownReset);
  notes.unknownReset = { waiting: unknownWait, newTurns: rows("codexTurns").length - beforeUnknownReset };
  await call("jobs:update", { id: unknownReset.id, enabled: false });

  // The same real Board/keyboard/touch journey is also runnable without unrelated quota cases.
  await inspectRunRoute(browser, retryRuns[0]._id);
  notes.pageErrors = browser.errors;
  check("noPageErrors", browser.errors.length === 0);
  check("screenshots", ["chat-moved.png", "work-waiting.png", "work-moved.png", "work-kept.png", "run-details.png", "run-details-phone.png"].every((name) => existsSync(join(outDir, name))));

  // --- 12. Only the fake engines ran anything --------------------------------------------------------------------
  const turnEngines = [...new Set(rows("codexTurns").map((turn) => turn.engine ?? "codex"))];
  notes.turnEngines = turnEngines;
  notes.modelCacheEntries = existsSync(join(p.home, "models")) ? readdirSync(join(p.home, "models")) : [];
  check("onlyFakeEnginesRan", turnEngines.every((engine) => engine === "grok" || engine === "antigravity")
    && (await computers()).flatMap((item) => item.engines).every((engine) => ["grok", "antigravity"].includes(engine.kind) || !engine.signedIn));
  check("completed", true);
  }
  }
} catch (error) {
  notes.stoppedAt = String(error);
  if (!aborted) check("completed", false);
} finally {
  notes.modelCacheEntries = existsSync(join(p.home, "models")) ? readdirSync(join(p.home, "models")) : [];
  files.close();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
const passed = await p.finish();
process.exit(passed ? 0 : 1);
