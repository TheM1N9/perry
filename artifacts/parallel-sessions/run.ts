import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { replayRunnerLifecycle } from "./runner-lifecycle";

const out = resolve("artifacts/parallel-sessions");
const scratch = resolve("node_modules/.cache/perry-parallel-sessions", `run-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
process.env.PERRY_HOME = join(scratch, "home");
process.env.DASHBOARD_KEY = "parallel-sessions-synthetic";
process.env.PERRY_CREDENTIAL_KEY = "77".repeat(32);
process.env.PERRY_EMBED_MODEL = "parallel-fixture";
(globalThis as any).__perryEmbedders = new Map([["parallel-fixture", Promise.resolve(async (texts: string[]) => texts.map(() => [1, 0]))]]);
(globalThis as any).__perryEmbeddersReady = new Set(["parallel-fixture"]);
globalThis.fetch = async () => { throw new Error("Network blocked in parallel session fixture"); };
const [{ Runtime }, { default: schema }, { modules }, { default: http }] = await Promise.all([
  import("../../server/runtime"), import("../../convex/schema"), import("../../server/modules"), import("../../convex/http"),
]);
const sql = new DatabaseSync(join(scratch, "fixture.sqlite"));
const rt = new Runtime(sql, schema as never, modules, { storageDir: join(scratch, "storage"), http: http as never });
await rt.stop();
const db = rt.store;
const call = async (path: string, args: object = {}) => (await rt.call(path, args, { internal: true })).value as any;
const key = process.env.DASHBOARD_KEY;
const token = "parallel-sessions-fake-runner";
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
function check(name: string, pass: boolean) { checks[name] = pass; console.log(`${pass ? "PASS" : "FAIL"} ${name}`); }
const rows = async (table: string) => await db.query(table).collect() as any[];
let runnerId: string;
async function running(name: string) {
  const chat = await call("dashboard:createChat", { key });
  const runId = await call("runs:start", { conversationId: chat, prompt: name });
  const turn = await call("codex:enqueueTurn", { conversationId: chat, runId, engine: "codex", prompt: name, instructions: "Fixture only", policy: "queue" });
  const claimed = await call("codex:claimTurn", { token, id: turn });
  if (!claimed) throw new Error(`Could not claim ${name}`);
  await call("codex:setResume", { token, id: turn, cursor: `native-${name}` });
  return { chat, turn, runId };
}
async function mcp(threads?: string[], chat?: string, why = "session isolation fixture") {
  const meta = threads ? { "x-codex-turn-metadata": { thread_id: threads[0], session_id: threads[1] } } : undefined;
  const response = await rt.runHttp("/mcp", new Request("http://fixture.local/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(chat ? { "x-perry-chat": chat } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "take_longer", arguments: { minutes: 7, why }, ...(meta ? { _meta: meta } : {}) } }) }));
  return await response.json() as any;
}
try {
  await rt.exclusive(() => {
    db.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now() });
    runnerId = db.insert("runners", { name: "Fake runner", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  });
  const sole = await running("sole");
  const stale = await mcp(["finished-native-session"]);
  check("explicit stale native identity cannot act on another session", Boolean(stale.error || stale.result?.isError) && !db.get(sole.turn)?.patienceWhy);
  const staleChat = await mcp(undefined, "finished-perry-chat");
  check("explicit stale chat identity cannot act on another session", Boolean(staleChat.error || staleChat.result?.isError) && !db.get(sole.turn)?.patienceWhy);
  await mcp(undefined, undefined, "legacy single-session caller");
  check("single-session legacy callers remain compatible", db.get(sole.turn)?.patienceWhy === "legacy single-session caller");
  const activeTask = await call("tasks:queueFromDashboard", { key, title: "Task to cancel", prompt: "Keep working" });
  await rt.exclusive(() => { db.patch(activeTask, { status: "running", turns: 1, conversationId: sole.chat }); db.patch(sole.chat, { taskId: activeTask }); });
  await call("dashboard:cancelTask", { key, taskId: activeTask });
  check("task cancellation interrupts its running turn", db.get(sole.turn)?.stopRequested === true);
  const stoppedCall = await mcp(["native-sole"]);
  check("stopped native session cannot continue calling tools", Boolean(stoppedCall.result?.isError) && db.get(sole.turn)?.patienceWhy === "legacy single-session caller");
  try { await call("work:updateTask", { taskId: activeTask, status: "done", result: "Late completion" }); } catch {}
  check("late completion cannot overwrite task cancellation", db.get(activeTask)?.status === "cancelled");

  const duplicate = await call("tasks:queueFromDashboard", { key, title: "Duplicate-start fixture", prompt: "Do this once" });
  await call("tasks:tick");
  const beforeThreads = (await rows("agentThreads")).length;
  await Promise.all([call("tasks:work", { id: duplicate }), call("tasks:work", { id: duplicate })]);
  const duplicateChat = db.get(duplicate)?.conversationId;
  const starts = (sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn'").all() as { args: string }[]).map(row => JSON.parse(row.args)).filter(args => args.externalId === db.get(String(duplicateChat))?.externalId);
  check("duplicate task starts schedule one preparation", starts.length === 1);
  check("duplicate task starts create one history session", (await rows("agentThreads")).length === beforeThreads + 1);
  evidence.duplicateStarts = starts.length;

  // Replay production hard-stop selection after a real backend Stop request.
  const sibling = await running("sibling");
  const peer = await running("peer");
  check("different assistant chats may claim concurrently", db.get(sibling.turn)?.status === "running" && db.get(peer.turn)?.status === "running");
  const extraRun = await call("runs:start", { conversationId: sibling.chat, prompt: "same-chat queued message" });
  const extraTurn = await call("codex:enqueueTurn", { conversationId: sibling.chat, runId: extraRun, engine: "codex", prompt: "same-chat queued message", instructions: "Fixture only", policy: "queue" });
  check("same assistant chat cannot claim a second concurrent turn", await call("codex:claimTurn", { token, id: extraTurn }) === null);
  await mcp(["native-child-of-peer", "native-peer"], undefined, "native child routed to peer");
  check("native child root metadata resolves its own parent", db.get(peer.turn)?.patienceWhy === "native child routed to peer" && !db.get(sibling.turn)?.patienceWhy);
  const conflict = await mcp(["native-sibling"], peer.chat);
  check("conflicting native and Perry identities are refused", Boolean(conflict.error) && !db.get(sibling.turn)?.patienceWhy);
  const ambiguous = await mcp(["native-sibling", "native-peer"]);
  check("multiple matching native sessions are refused", Boolean(ambiguous.error) && !db.get(sibling.turn)?.patienceWhy);
  const unnamed = await mcp();
  check("unnamed calls cannot select an arbitrary parallel session", Boolean(unnamed.error));
  await call("dashboard:setChatModel", { key, id: peer.chat, model: "fixture-claude", engine: "claude" });
  await mcp(["native-child-of-peer", "native-peer"], undefined, "old turn survives engine switch");
  check("engine switch cannot detach an already running native session", db.get(peer.turn)?.patienceWhy === "old turn survives engine switch" && db.get(peer.turn)?.sessionCursor === "native-peer");
  await call("codex:finishTurn", { token, id: sibling.turn, response: "First native session turn done" });
  await call("codex:finalizeTurn", { id: sibling.turn });
  const resumed = await call("codex:claimTurn", { token, id: extraTurn });
  check("resumed turns snapshot their native session at claim time", resumed?.resumeCursor === "native-sibling" && db.get(extraTurn)?.sessionCursor === "native-sibling");
  const engine = { kill() { evidence.engineKilled = true; } };
  const active = new Map<string, any>([
    [sole.turn, { jobId: sole.turn, conversationId: sole.chat, engine, handle: { cursor: "native-sole", turnId: "sole-turn" }, abandon() { evidence.originalAbandoned = true; } }],
    [extraTurn, { jobId: extraTurn, conversationId: sibling.chat, engine }],
  ]);
  await call("dashboard:stopChat", { key, id: sole.chat });
  const stopped = await call("codex:stopRequests", { token });
  const source = readFileSync("runner/index.ts", "utf8");
  const start = source.indexOf("  const endTurn = (jobId: string)");
  const end = source.indexOf("  const interruptIfAsked", start);
  if (start < 0 || end < 0) throw new Error("Runner stop-selection boundary changed");
  const selection = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const endTurn = new Function("active", `${selection}; return endTurn;`)(active);
  if (stopped.includes(sole.turn)) endTurn(sole.turn);
  check("hard Stop preserves a sibling still starting on the shared engine", evidence.originalAbandoned === true && evidence.engineKilled !== true && db.get(extraTurn)?.status === "running");
  await call("codex:finishTurn", { token, id: sole.turn });
  await call("codex:finalizeTurn", { id: sole.turn });
  await call("dashboard:cancelTask", { key, taskId: duplicate });
  const preparation = starts[0]?.preparingId;
  check("task cancellation cancels its preparing session", Boolean(preparation) && db.get(preparation)?.status === "done" && db.get(preparation)?.stopped === true);
  if (preparation) {
    await call("brain:handleTurn", starts[0]);
    await call("codex:finalizeTurn", { id: preparation });
  }
  check("cancelled task preparations cannot restart or leak pending count", db.get(duplicate)?.status === "cancelled" && db.get(String(duplicateChat))?.pendingTurns === 0);
  check("task cancellation leaves sibling sessions and queued turns alone", db.get(extraTurn)?.status === "running" && !db.get(extraTurn)?.stopRequested && db.get(peer.turn)?.status === "running" && !db.get(peer.turn)?.stopRequested);
  const background: string[] = [];
  for (let i = 0; i < 3; i++) background.push(await call("tasks:queueFromDashboard", { key, title: `parallel task ${i}`, prompt: `Complete background fixture task ${i}.` }));
  await Promise.all([call("tasks:tick"), call("tasks:tick")]);
  const admitted = (await rows("tasks")).filter(task => background.includes(task._id) && task.status === "running");
  check("concurrent task ticks admit only two background tasks", admitted.length === 2);
  await call("dashboard:cancelTask", { key, taskId: admitted[0]._id });
  await call("tasks:tick");
  check("cancelled tasks release their background slot", (await rows("tasks")).filter(task => background.includes(task._id) && task.status === "running").length === 2 && (await rows("tasks")).filter(task => background.includes(task._id) && task.status === "queued").length === 0);
  const finalTasks = (await rows("tasks")).filter(task => background.includes(task._id) && task.status === "running");
  await Promise.all(finalTasks.map(task => call("tasks:work", { id: task._id })));
  const preparations = [];
  for (const task of finalTasks) {
    const conversationId = db.get(task._id)?.conversationId;
    const preparation = (await rows("codexTurns")).find(turn => turn.conversationId === conversationId && turn.preparing);
    if (!preparation) throw new Error("Missing task preparation reservation");
    const scheduled = (sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn'").all() as { args: string }[]).map(row => JSON.parse(row.args)).find(args => args.preparingId === preparation._id);
    await call("brain:handleTurn", scheduled);
    preparations.push(db.get(preparation._id)!);
  }
  const claims = await Promise.all(preparations.map(turn => call("codex:claimTurn", { token, id: turn._id })));
  check("two real task preparation pipelines reach distinct concurrent sessions", claims.every(Boolean) && claims[0].conversationId !== claims[1].conversationId);
  for (const [index, turn] of preparations.entries()) await call("codex:setResume", { token, id: turn._id, cursor: `native-task-${index}` });
  check("task native-session cursors remain isolated", db.get(preparations[0]._id)?.sessionCursor === "native-task-0" && db.get(preparations[1]._id)?.sessionCursor === "native-task-1");
  for (const [index, turn] of preparations.entries()) {
    await call("work:updateTask", { taskId: finalTasks[index]._id, turnId: turn._id, status: "done", result: `Result from task ${index}` });
    await call("codex:finishTurn", { token, id: turn._id, response: `Task ${index} complete` });
    await call("codex:finalizeTurn", { id: turn._id });
  }
  check("parallel task completion preserves independent results and releases pending counts", finalTasks.every((task, index) => db.get(task._id)?.result === `Result from task ${index}` && db.get(String(db.get(task._id)?.conversationId))?.pendingTurns === 0));
  await replayRunnerLifecycle({ source, call, db, token, key: key!, running, check });
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
} finally {
  const passed = !evidence.error && Object.values(checks).every(Boolean);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, process.argv.includes("--baseline") ? "baseline.json" : "result.json"), JSON.stringify({ passed, checks, evidence }, null, 2) + "\n");
  await rt.stop(); sql.close();
  if (!passed) process.exitCode = 1;
}
