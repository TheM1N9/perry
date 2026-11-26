// Failure inventory: acp-failure-cases.md. Real subclasses and SDK/stdio, no providers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const out = resolve(process.argv[2] ?? "node_modules/.cache/whatsapp-progress-acp");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), "perry-progress-acp-"));
process.env.PERRY_HOME = home;
const logPath = join(home, "agent.jsonl");
globalThis.fetch = async () => { throw Error("External network is disabled in ACP progress replay"); };
const [{ GrokEngine }, { OpenCodeEngine }, { AntigravityEngine }, { TurnTrace }] = await Promise.all([
  import("../../runner/engines/grok.ts"), import("../../runner/engines/opencode.ts"), import("../../runner/engines/antigravity.ts"), import("../../runner/trace.ts"),
]);
const report = { at: new Date().toISOString(), passed: false, results: [], modelTurns: 0, externalCalls: 0, homeRemoved: false };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2));
save();
async function check(name, work) {
  let timer;
  try { await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("ACP replay exceeded 15 seconds")), 15_000); })]); report.results.push({ name, passed: true }); }
  catch (error) { report.results.push({ name, passed: false, error: String(error.stack ?? error) }); }
  finally { clearTimeout(timer); }
  save(); console.log(JSON.stringify(report.results.at(-1)));
}
const input = scenario => ({ prompt: `SCENARIO:${scenario}`, instructions: "Synthetic progress fixture only", cwd: home, access: "full", attachments: [] });
async function run(Engine, scenario, inspect) {
  const engine = new Engine();
  engine.launch = () => ({ command: process.execPath, args: [resolve("artifacts/whatsapp-progress/fake-agent.mjs")], env: { PERRY_PROGRESS_ACP_LOG: logPath } });
  const events = []; const trace = new TurnTrace();
  let started; const begun = new Promise(done => { started = done; });
  const sink = { onSession: async () => {}, onRequest: async () => "decline", onStarted: started,
    onEvent(event) {
      events.push(event);
      if (event.type === "text" && event.stream === "assistant") trace.text(event.itemId, event.text, Date.now());
      if (event.type === "progress") trace.progress(event.itemId, event.text, event.atMs);
    },
  };
  const children = [];
  try {
    const pending = engine.runTurn(input(scenario), sink);
    if (scenario === "hold") {
      const handle = await begun;
      await new Promise(done => setTimeout(done, 30));
      await engine.interrupt(handle);
    }
    const result = await pending;
    const conn = engine.conn;
    if (conn) {
      children.push(conn.child);
      assert.ok([...conn.sessions.values()].every(session => !session.turn), "no active ACP turn after completion");
    }
    await inspect({ result, events, trace });
  } finally {
    for (const child of engine.children) if (!children.includes(child)) children.push(child);
    const exited = children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(done => { child.once("exit", done); child.once("error", done); }));
    engine.kill();
    let timeout;
    try { await Promise.race([Promise.all(exited), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("ACP child did not exit after kill")), 5_000); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(engine.children.size, 0); assert.equal(engine.conn, null);
  }
}
try {
  for (const Engine of [GrokEngine, OpenCodeEngine, AntigravityEngine]) {
    const label = Engine.name;
    await check(`${label}: final-only chunks and reasoning never publish progress`, () => run(Engine, "final", async ({ result, events }) => {
      assert.equal(result.state, "completed"); assert.equal(result.text, "Final answer."); assert.equal(events.filter(event => event.type === "progress").length, 0);
    }));
    await check(`${label}: two tool boundaries preserve distinct progress and final-only result`, () => run(Engine, "two", async ({ result, events, trace }) => {
      assert.equal(result.state, "completed"); assert.equal(result.text, "Final answer.");
      const progress = events.filter(event => event.type === "progress");
      assert.deepEqual(progress.map(event => event.text), ["Checking the first source.", "Comparing the second source."]);
      assert.notEqual(progress[0].itemId, progress[1].itemId);
      const spans = trace.take().spans;
      assert.equal(spans.filter(span => span.progress).length, 2);
      assert.ok(!spans.some(span => span.progress && span.output.includes("Final")));
    }));
    await check(`${label}: tools/reasoning/output without assistant text produce no progress`, () => run(Engine, "tools-only", async ({ result, events }) => {
      assert.equal(result.state, "completed"); assert.equal(result.text, ""); assert.equal(events.filter(event => event.type === "progress").length, 0);
    }));
    await check(`${label}: missing final text retains the last assistant segment`, () => run(Engine, "no-final", async ({ result, events }) => {
      assert.equal(result.text, "Checking the original source."); assert.equal(events.filter(event => event.type === "progress").length, 1);
    }));
    await check(`${label}: an update-only tool cannot publish a partial final`, () => run(Engine, "update-only", async ({ result, events }) => {
      assert.equal(result.text, "An unfinished final sentence"); assert.equal(events.filter(event => event.type === "progress").length, 0);
    }));
    await check(`${label}: native cancellation leaves no progress or active child`, () => run(Engine, "hold", async ({ result, events }) => {
      assert.equal(result.state, "interrupted"); assert.equal(events.filter(event => event.type === "progress").length, 0);
    }));
    await check(`${label}: provider failure leaves no progress or active child`, () => run(Engine, "failure", async ({ result, events }) => {
      assert.equal(result.state, "failed"); assert.equal(events.filter(event => event.type === "progress").length, 0);
    }));
  }
  report.protocol = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line)).reduce((counts, row) => { counts[row.event] = (counts[row.event] ?? 0) + 1; return counts; }, {});
} finally {
  await rm(home, { recursive: true, force: true }); report.homeRemoved = true;
  report.passed = report.results.length === 21 && report.results.every(row => row.passed); save();
}
process.exitCode = report.passed ? 0 : 1;
