// Failure inventory: adapter-failure-cases.md. Native adapters, synthetic provider transports only.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const out = resolve(process.argv[2] ?? "node_modules/.cache/whatsapp-progress-adapters");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), "perry-progress-adapters-"));
process.env.PERRY_HOME = home;
globalThis.fetch = async () => { throw Error("External network disabled in progress adapter replay"); };
const claudeUrl = pathToFileURL(resolve("runner/engines/claude.ts")).href;
let sdkScenario;
const sdkQueries = [];
let activeIterators = 0;
globalThis.__progressSdk = {
  query({ prompt }) {
    const scenario = sdkScenario;
    let release;
    const stopped = new Promise(done => { release = done; });
    const q = {
      closed: false, interrupted: false,
      supportedModels: async () => [],
      setPermissionMode: async () => {},
      close() { q.closed = true; release(); },
      async interrupt() { q.interrupted = true; release(); },
      async *[Symbol.asyncIterator]() {
        activeIterators++;
        try {
          await prompt[Symbol.asyncIterator]().next();
          yield { type: "system", subtype: "init", session_id: "synthetic-claude" };
          for (const event of scenario.events ?? []) yield event;
          if (scenario.fail) throw Error("Synthetic provider ended");
          if (scenario.hold) await stopped;
          yield { type: "result", subtype: "success", result: "Final synthetic answer", is_error: false, usage: {}, duration_ms: 1 };
          await stopped;
        } finally { activeIterators--; }
      },
    };
    sdkQueries.push(q);
    return q;
  },
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === claudeUrl && specifier === "@anthropic-ai/claude-agent-sdk") return { url: "fixture:progress-sdk", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "fixture:progress-sdk") return { format: "module", shortCircuit: true, source: "export const query = input => globalThis.__progressSdk.query(input);" };
    if (url === claudeUrl) {
      const source = readFileSync(new URL(url), "utf8");
      const parsed = ts.createSourceFile("claude.ts", source, ts.ScriptTarget.Latest, true);
      const find = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "findClaude");
      assert.ok(find?.body, "Claude binary discovery boundary must exist");
      return { format: "module-typescript", shortCircuit: true, source: source.slice(0, find.body.pos) + '{ return { command: "synthetic-claude", sdkPath: "synthetic-sdk" }; }' + source.slice(find.body.end) };
    }
    return next(url, context);
  },
});
const [{ CodexEngine }, { ClaudeEngine }, { TurnTrace }] = await Promise.all([
  import("../../runner/engines/codex.ts"), import("../../runner/engines/claude.ts"), import("../../runner/trace.ts"),
]);
const report = { at: new Date().toISOString(), passed: false, results: [], modelTurns: 0, networkCalls: 0, homeRemoved: false };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2));
save();
async function check(name, work) {
  let timer;
  try { await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Synthetic adapter replay exceeded 10 seconds")), 10_000); })]); report.results.push({ name, passed: true }); }
  catch (error) { report.results.push({ name, passed: false, error: String(error.stack ?? error) }); }
  finally { clearTimeout(timer); }
  save(); console.log(JSON.stringify(report.results.at(-1)));
}
const input = { prompt: "Synthetic progress replay", instructions: "Synthetic fixture only", history: "Earlier synthetic chat", cwd: home, access: "full", attachments: [], model: "synthetic", effort: "low" };
function sink() {
  const events = []; const trace = new TurnTrace();
  let started;
  const begun = new Promise(done => { started = done; });
  return { events, trace, begun,
    onSession: async () => {}, onRequest: async () => "decline",
    onStarted: handle => started(handle),
    onEvent(event) {
      events.push(event);
      if (event.type === "text" && event.stream === "assistant") trace.text(event.itemId, event.text, Date.now());
      if (event.type === "progress") trace.progress(event.itemId, event.text, event.atMs);
    },
  };
}
class App extends EventEmitter {
  constructor(scenario) { super(); this.scenario = scenario; this.closed = false; this.interrupted = false; }
  reloadSkills = async () => [];
  skillPaths = async () => [];
  request = async (method) => {
    if (method === "thread/start") return { thread: { id: "synthetic-thread" } };
    if (method === "turn/start") {
      for (const event of this.scenario.early ?? []) this.emit(event.name, event.value);
      return { turn: { id: "synthetic-turn" } };
    }
    return {};
  };
  async waitForTurn() {
    for (const event of this.scenario.events ?? []) this.emit(event.name, event.value);
    if (this.scenario.fail) throw Error("Synthetic native provider failed");
    if (this.scenario.hold) await new Promise(done => { this.release = done; });
    return { text: "Final synthetic answer", images: [], interrupted: this.interrupted };
  }
  async interrupt() { this.interrupted = true; this.release?.(); }
}
const completed = (item, extra = {}) => ({ name: "item/completed", value: { threadId: "synthetic-thread", turnId: "synthetic-turn", item, completedAtMs: Date.now(), ...extra } });
const progress = { type: "agentMessage", id: "progress-1", phase: "commentary", text: "I found the source; checking its figures." };
async function codex(scenario, work) {
  const engine = new CodexEngine(); const app = new App(scenario); const output = sink();
  engine.app = app;
  engine.ensure = async () => app;
  try {
    const pending = engine.runTurn(input, output);
    if (scenario.hold) { const handle = await output.begun; await new Promise(done => setImmediate(done)); await engine.interrupt(handle); }
    const result = await pending;
    await work({ result, output });
  } finally {
    assert.equal(app.eventNames().length, 0, "native event listeners released");
    assert.equal(engine.turns.size, 0, "native active turn released");
  }
}
const textBlock = text => ({ type: "text", text });
const claudeMessage = (id, content, extra = {}) => ({ type: "assistant", uuid: `${id}-uuid`, message: { id, role: "assistant", content }, ...extra });
async function claude(scenario, work) {
  sdkScenario = scenario; const engine = new ClaudeEngine(); const output = sink();
  try {
    const pending = engine.runTurn(input, output);
    if (scenario.hold) { const handle = await output.begun; await new Promise(done => setImmediate(done)); await engine.interrupt(handle); }
    const result = await pending;
    await work({ result, output });
  } finally {
    engine.reload();
    await new Promise(done => setImmediate(done));
    assert.equal(engine.live.size, 0, "Claude live sessions released");
    assert.equal(activeIterators, 0, "Claude iterator released");
  }
}
try {
  await check("Codex early completed commentary crosses native session and trace once", () => codex({ early: [completed(progress)], events: [completed(progress)] }, async ({ result, output }) => {
    assert.equal(result.state, "completed");
    const spans = output.trace.take().spans;
    assert.equal(spans.length, 1); assert.equal(spans[0].progress, true); assert.equal(spans[0].status, "ok");
    output.trace.drain(Date.now()); assert.equal(output.trace.take(), null);
  }));
  await check("Codex partial/final/reasoning/foreign thread/stale turn never publish progress", () => codex({ events: [
    { name: "item/agentMessage/delta", value: { threadId: "synthetic-thread", itemId: "partial", delta: "An unfinished sentence" } },
    completed({ type: "agentMessage", id: "final", phase: "final_answer", text: "Final synthetic answer" }),
    completed({ type: "reasoning", id: "private", summary: ["Private reasoning"] }),
    completed({ ...progress, id: "child" }, { threadId: "child-thread" }),
    completed({ ...progress, id: "stale" }, { turnId: "old-turn" }),
  ] }, async ({ output }) => assert.equal(output.events.filter(event => event.type === "progress").length, 0)));
  await check("Codex late delta cannot reopen completed progress", () => codex({ events: [completed(progress),
    { name: "item/agentMessage/delta", value: { threadId: "synthetic-thread", itemId: "progress-1", delta: "late incorrect text" } },
  ] }, async ({ output }) => { const span = output.trace.take().spans[0]; assert.equal(span.output, progress.text); assert.equal(span.status, "ok"); }));
  await check("Codex interruption releases event listeners and native turn", () => codex({ hold: true }, async ({ result }) => assert.equal(result.state, "interrupted")));
  await check("Codex provider failure releases event listeners and native turn", async () => { await assert.rejects(codex({ fail: true }, async () => {}), /Synthetic native provider failed/); });
  await check("Claude completed parent text plus tool use emits progress through native iterator", () => claude({ events: [
    { type: "stream_event", event: { type: "message_start", message: { id: "parent" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking the original figures." } } },
    claudeMessage("parent", [textBlock("Checking the original figures."), { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "synthetic.txt" } }]),
  ] }, async ({ result, output }) => {
    assert.equal(result.state, "completed");
    const events = output.events.filter(event => event.type === "progress"); assert.equal(events.length, 1); assert.equal(events[0].text, "Checking the original figures.");
    assert.equal(output.trace.take().spans[0].progress, true);
  }));
  await check("Claude child text/tool use and pure final answer never emit owner progress", () => claude({ events: [
    claudeMessage("child", [textBlock("Child private update"), { type: "tool_use", id: "child-read", name: "Read", input: {} }], { parent_tool_use_id: "agent-1" }),
    claudeMessage("final", [textBlock("Final synthetic answer")]),
  ] }, async ({ output }) => assert.equal(output.events.filter(event => event.type === "progress").length, 0)));
  await check("Claude interrupted turn releases kept session and iterator", () => claude({ hold: true }, async ({ result }) => assert.equal(result.state, "interrupted")));
  await check("Claude failed provider releases session and reports failure", () => claude({ fail: true }, async ({ result }) => assert.equal(result.state, "failed")));
} finally {
  for (const query of sdkQueries) query.close();
  await rm(home, { recursive: true, force: true });
  report.homeRemoved = true;
  report.passed = report.results.length === 9 && report.results.every(row => row.passed);
  save();
}
process.exitCode = report.passed ? 0 : 1;
