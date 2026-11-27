/**
 * Coordinator: pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/trace-settlement/run.ts
 * No build, browser, live runner,
 * network, model or service required. Failure cases were recorded first in
 * artifacts/trace-settlement/failure-cases.md. This is a backend E2E: real schema,
 * SQLite Store, Runtime transactions, traceTurn, finishTurn, recovery.sweep and
 * markFinalized; only the runner and input documents are synthetic fixtures.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Doc, Id } from "../../convex/_generated/dataModel";

const scratch = resolve("node_modules/.cache/performance-backend");
const out = resolve(process.argv[2] ?? join(scratch, "results"));
const within = relative(scratch, out);
if (within.startsWith("..") || isAbsolute(within)) throw new Error("Output must stay inside performance-backend scratch.");
const baseline = process.argv.includes("--baseline");
const activityBaseline = process.argv.includes("--activity-baseline");
const sidebarBaseline = process.argv.includes("--sidebar-baseline");
// The baseline runs the previous query shapes in a child process, never edits
// project files, and keeps the same Runtime, schema, fixtures and assertions.
if (baseline || activityBaseline || sidebarBaseline) registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const replacements = !baseline ? [] : url.endsWith("/convex/lib/settle-traces.ts") ? [
      ['.withIndex("by_run_status", (q) => q.eq("runId", runId).eq("status", "running"))', '.withIndex("by_run", (q) => q.eq("runId", runId))'],
      ['for (const span of spans) {', 'for (const span of spans) {\n    if (span.status !== "running") continue;'],
    ] : url.endsWith("/convex/dashboard.ts") ? [[
      '(await Promise.all((["error", "queued"] as const).map(status => ctx.db.query("codexTurns")\n      .withIndex("by_conversation_status", q => q.eq("conversationId", args.id).eq("status", status)).collect()))).flat()',
      '(await ctx.db.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", args.id)).collect())',
    ]] : [];
    if (activityBaseline && url.endsWith("/convex/dashboard.ts")) replacements.push([
      'await ctx.db.query("runs").withIndex("by_status_started", (q) => q.eq("status", "running")).order("desc").first()',
      '(await ctx.db.query("runs").withIndex("by_started").order("desc").take(20)).find((item) => item.status === "running") ?? null',
    ]);
    if (sidebarBaseline && url.endsWith("/convex/dashboard.ts")) replacements.push([
      'const riffChats = new Set<Id<"conversations">>();\n    // Linked chats sort ahead of notes without one in this descending index.\n    for await (const note of ctx.db.query("notes").withIndex("by_live_chat").order("desc")) {\n      if (note.liveChatId === undefined) break;\n      riffChats.add(note.liveChatId);\n    }',
      'const riffChats = new Set((await ctx.db.query("notes").withIndex("by_live_chat").filter((q) => q.neq(q.field("liveChatId"), undefined)).collect()).map((note) => note.liveChatId));',
    ]);
    if (!replacements.length) return loaded;
    let source = (typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source as Uint8Array)).replace(/\r\n/g, "\n");
    for (const [before, after] of replacements) {
      if (!source.includes(before)) throw new Error(`Baseline source no longer matches ${url}`);
      source = source.replace(before, after);
    }
    return { ...loaded, source };
  },
});
process.env.PERRY_HOME = join(out, "home");
process.env.DASHBOARD_KEY = "trace-settlement-synthetic-key";
process.env.PERRY_CREDENTIAL_KEY = "22".repeat(32);
process.env.CODEX_HOME = join(out, "fake-codex");
process.env.CLAUDE_CONFIG_DIR = join(out, "fake-claude");
process.env.PERRY_ENGINE = "";
mkdirSync(out, { recursive: true });
globalThis.fetch = async () => { throw new Error("Network disabled in trace settlement E2E"); };

// No project runtime imports before isolation environment is installed.
const [{ Runtime }, { default: schema }, { modules }, { settleRunSpans }, { TurnTrace }] = await Promise.all([
  import("../../server/runtime"), import("../../convex/schema"),
  import("../../server/modules"),
  import("../../convex/lib/settle-traces"), import("../../runner/trace"),
]);
const sql = new DatabaseSync(":memory:");
// Reproduce an old, nonempty table before Runtime creates new schema indexes.
sql.exec("CREATE TABLE doc_runSpans (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, doc TEXT NOT NULL)");
const oldSpan = JSON.stringify({ runId: "pre-index-run", callId: "old", kind: "command", name: "old completed row", status: "ok", startedAt: 1, output: "preserve this row" });
sql.prepare("INSERT INTO doc_runSpans VALUES (?, ?, ?)").run("pre-index-span", 1, oldSpan);
const runtime = new Runtime(sql, schema as never, {
  ...modules,
  fixture: {
    settle: { perryFunction: true, visibility: "internal", kind: "mutation",
      handler: async (ctx: Parameters<typeof settleRunSpans>[0], args: { runId: Id<"runs">; endedAt: number }) => settleRunSpans(ctx, args.runId, args.endedAt) },
    rollback: { perryFunction: true, visibility: "internal", kind: "mutation",
      handler: async (ctx: Parameters<typeof settleRunSpans>[0], args: { runId: Id<"runs">; endedAt: number }) => {
        await settleRunSpans(ctx, args.runId, args.endedAt);
        throw new Error("fixture rollback");
      } },
  },
}, { storageDir: join(out, "storage") });
// Prevent automatic finalization/actions: only the mutations explicitly called
// below may execute. Scheduling still persists, as in production transactions.
await runtime.stop();
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
const check = (name: string, ok: boolean) => {
  checks[name] = ok;
  if (!ok) throw new Error(name);
};
const call = (name: string, args: object) => runtime.runMutation(name, args, { internal: true });
const token = "trace-fixture-runner-token";
const now = Date.now();
const insert = <T extends "runners" | "conversations" | "runs" | "codexTurns" | "runSpans">(table: T, row: Record<string, unknown>) => runtime.store.insert(table, row) as Id<T>;
const runnerId = insert("runners", { name: "trace fake", token, createdAt: now, lastSeenAt: now });
const rows = async (runId: Id<"runs">) => (await runtime.store.query("runSpans").withIndex("by_run", (q) => q.eq("runId", runId)).collect()) as Doc<"runSpans">[];
const snapshot = (value: unknown) => JSON.stringify(value);
const performanceCheck = (name: string, ok: boolean) => {
  checks[name] = ok;
  if (!ok && !baseline) throw new Error(name);
};
type Hydration = { rows: number; bytes: number; queries: number; sql: string[] };
const hydration = new Map<string, Hydration>();
const originalRows = runtime.store.rows.bind(runtime.store);
let measuring = false;
runtime.store.rows = (text, parameters) => {
  const source = originalRows(text, parameters);
  const table = /FROM "doc_(\w+)"/.exec(text)?.[1];
  const measure = measuring && table ? hydration.get(table) ?? { rows: 0, bytes: 0, queries: 0, sql: [] } : undefined;
  if (measure && table) {
    measure.queries++;
    if (!measure.sql.includes(text)) measure.sql.push(text);
    hydration.set(table, measure);
  }
  return (function* () {
    for (const doc of source) {
      if (measure) {
        measure.rows++;
        measure.bytes += Buffer.byteLength(JSON.stringify(doc));
      }
      yield doc;
    }
  })();
};
async function measured<T>(work: () => Promise<T>) {
  hydration.clear();
  measuring = true;
  try {
    const value = await work();
    return { value, hydration: Object.fromEntries(hydration) };
  } finally { measuring = false; }
}

function fixture(label: string, startedAt = now - 1000) {
  const conversationId = insert("conversations", {
    channel: "web", externalId: `trace-${label}`, threadId: `trace-${label}`,
    createdAt: startedAt, lastMessageAt: startedAt, pendingTurns: 1,
  });
  const runId = insert("runs", { conversationId, prompt: label, status: "running", startedAt });
  const turnId = insert("codexTurns", {
    runnerId, conversationId, runId, engine: "codex", prompt: label,
    instructions: "synthetic", status: "running", createdAt: startedAt, startedAt,
  });
  return { conversationId, runId, turnId, startedAt };
}
async function start(f: ReturnType<typeof fixture>) {
  await call("codex:traceTurn", { token, id: f.turnId, spans: [
    { callId: "open", kind: "command", name: "fake unfinished command", status: "running", startedAt: f.startedAt, output: "partial fixture output" },
    { callId: "done", kind: "command", name: "fake completed command", status: "ok", startedAt: f.startedAt, durationMs: 10, output: "complete fixture output" },
    { callId: "failed", kind: "mcpToolCall", name: "fake failed call", status: "error", startedAt: f.startedAt, durationMs: 20, output: "original failure" },
    { callId: "declined", kind: "command", name: "fake declined command", status: "declined", startedAt: f.startedAt, durationMs: 0 },
  ] });
  return rows(f.runId);
}

try {
  check("index:creates-on-existing-table", Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='i_runSpans_by_run_status'").get()));
  check("index:preserves-existing-row", (sql.prepare("SELECT doc FROM doc_runSpans WHERE _id='pre-index-span'").get() as { doc: string }).doc === oldSpan);
  const plan = sql.prepare("EXPLAIN QUERY PLAN SELECT _id, _creationTime, doc FROM doc_runSpans WHERE json_extract(doc,'$.runId') IS ? AND json_extract(doc,'$.status') IS ? ORDER BY json_extract(doc,'$.runId'), json_extract(doc,'$.status'), _creationTime").all("pre-index-run", "running") as Array<{ detail: string }>;
  check("index:sqlite-uses-run-status-bounds", plan.some(row => row.detail.includes("i_runSpans_by_run_status") && row.detail.includes("<expr>=? AND <expr>=?")));
  evidence.indexPlan = plan;
  for (const [label, result] of [
    ["success", { response: "Synthetic finished reply." }],
    ["failure", { error: "Synthetic engine failure.", errorCode: "engine_failed" }],
    ["cancelled", { stopped: true }],
    ["timeout", { error: "Synthetic watchdog timed out.", errorCode: "max_time" }],
    ["restart", { error: "Perry restarted during this reply, so it ended early.", errorCode: "restarted" }],
  ] as const) {
    const f = fixture(label);
    const before = await start(f);
    check(`${label}:actually-open-before-end`, before.find((s) => s.callId === "open")?.status === "running");
    // Old start arrives after completion while the turn itself is still live.
    await call("codex:traceTurn", { token, id: f.turnId, spans: [
      { callId: "done", kind: "command", name: "stale update", status: "running", startedAt: f.startedAt },
    ] });
    check(`${label}:old-start-does-not-reopen`, snapshot((await rows(f.runId)).find((s) => s.callId === "done")) === snapshot(before.find((s) => s.callId === "done")));
    // Intentionally no runner drain: the persisted step is still running here.
    await call("codex:finishTurn", { token, id: f.turnId, ...result });
    const ended = await rows(f.runId);
    const step = ended.find((s) => s.callId === "open")!;
    const end = (step as typeof step & { endedAt?: number }).endedAt;
    const turn = runtime.store.get(f.turnId)!;
    check(`${label}:server-settles-before-finalize`, !turn.finalizedAt && step.status === "error" && typeof end === "number" && end === turn.finishedAt && step.durationMs === end - step.startedAt);
    check(`${label}:preserves-partial-output`, step.output === "partial fixture output");
    check(`${label}:preserves-terminal-siblings`, ended.filter((s) => s.callId !== "open").every((s) => snapshot(s) === snapshot(before.find((old) => old.callId === s.callId))));
    await call("codex:traceTurn", { token, id: f.turnId, spans: [
      { callId: "open", kind: "command", name: "late success", status: "ok", startedAt: f.startedAt, durationMs: 2000 },
      { callId: "late", kind: "command", name: "late start", status: "running", startedAt: now },
    ] });
    await call("codex:finishTurn", { token, id: f.turnId, response: "late replacement" });
    await call("codex:markFinalized", { id: f.turnId });
    await call("codex:markFinalized", { id: f.turnId });
    await call("recovery:sweep", { only: f.conversationId, now: now + 20 * 60_000 });
    check(`${label}:late-events-and-repeated-settlement-immutable`, snapshot(await rows(f.runId)) === snapshot(ended));
    const run = runtime.store.get(f.runId)!;
    check(`${label}:truthful-parent-status`, run.status === (label === "success" ? "ok" : "error") && run.finishedAt === turn.finishedAt);
    evidence[label] = { before, after: ended, run };
  }

  const lost = fixture("runner disappeared", now - 60 * 60_000);
  await start(lost);
  const untouched = fixture("unrelated active run");
  await start(untouched);
  const untouchedBefore = snapshot(await rows(untouched.runId));
  const swept = await call("recovery:sweep", { only: lost.conversationId, now: now + 60 * 60_000 });
  check("recovery:abandoned-before-finalize", runtime.store.get(lost.turnId)?.status === "error" && !runtime.store.get(lost.turnId)?.finalizedAt && (await rows(lost.runId)).every((s) => s.status !== "running"));
  check("recovery:unrelated-run-untouched", snapshot(await rows(untouched.runId)) === untouchedBefore);
  const recovered = snapshot(await rows(lost.runId));
  await call("codex:traceTurn", { token, id: lost.turnId, spans: [
    { callId: "open", kind: "command", name: "late after recovery", status: "ok", startedAt: lost.startedAt, durationMs: 100 },
  ] });
  await call("recovery:sweep", { only: lost.conversationId, now: now + 120 * 60_000 });
  check("recovery:repeat-keeps-first-end", snapshot(await rows(lost.runId)) === recovered);
  evidence.recovery = { swept, spans: await rows(lost.runId) };

  const orphan = fixture("orphan", now - 60 * 60_000);
  await start(orphan);
  runtime.store.delete(orphan.turnId);
  await call("recovery:sweep", { only: orphan.conversationId, now });
  check("orphan:run-and-spans-close", runtime.store.get(orphan.runId)?.status === "error" && (await rows(orphan.runId)).every((s) => s.status !== "running"));

  const legacy = fixture("legacy finalized", now - 60 * 60_000);
  await start(legacy);
  runtime.store.patch(legacy.turnId, { status: "error", finishedAt: now - 10000, finalizedAt: now - 9000 });
  await call("recovery:sweep", { only: legacy.conversationId, now });
  check("legacy:repair-original-end", (await rows(legacy.runId)).find((s) => s.callId === "open")?.durationMs === now - 10000 - legacy.startedAt);

  const retry = fixture("old attempt", now - 60000);
  runtime.store.patch(retry.turnId, { status: "error", finishedAt: now - 50000, finalizedAt: now - 49000 });
  insert("codexTurns", { runnerId, conversationId: retry.conversationId, runId: retry.runId, engine: "codex", prompt: "new attempt", instructions: "synthetic", status: "running", createdAt: now, startedAt: now, retryOf: retry.turnId });
  insert("runSpans", { runId: retry.runId, callId: "new attempt open", kind: "command", name: "new attempt", status: "running", startedAt: now });
  await call("recovery:sweep", { only: retry.conversationId, now });
  check("retry:old-attempt-cannot-close-new-work", (await rows(retry.runId))[0]?.status === "running");

  const refused = fixture("retryable plan limit");
  await call("codex:traceTurn", { token, id: refused.turnId, spans: [
    { callId: "reasoning", kind: "reasoning", name: "fake reasoning", status: "running", startedAt: refused.startedAt },
  ] });
  // #244 makes the stable wire code authoritative; plain legacy error text
  // intentionally falls back to engine_failed rather than triggering retries.
  await call("codex:finishTurn", { token, id: refused.turnId, error: "Usage limit reached", errorCode: "limit" });
  const refusedSpans = await rows(refused.runId);
  evidence.refusal = { turn: runtime.store.get(refused.turnId), run: runtime.store.get(refused.runId), spans: refusedSpans };
  check("retry:refusal-closes-attempt-but-keeps-run-active", runtime.store.get(refused.turnId)?.retrying === true && runtime.store.get(refused.runId)?.status === "running" && refusedSpans[0]?.status === "error" && refusedSpans[0]?.durationMs !== undefined);
  check("retry:safe-fallback-for-missing-output", refusedSpans[0]?.output === "The turn failed before this step finished.");

  const legacyLimit = fixture("legacy uncoded limit");
  await call("codex:traceTurn", { token, id: legacyLimit.turnId, spans: [
    { callId: "reasoning", kind: "reasoning", name: "fake reasoning", status: "running", startedAt: legacyLimit.startedAt },
  ] });
  await call("codex:finishTurn", { token, id: legacyLimit.turnId, error: "Usage limit reached" });
  const legacyLimitTurn = runtime.store.get(legacyLimit.turnId)!;
  check("retry:uncoded-limit-settles-without-guessing-retry", !legacyLimitTurn.retrying && legacyLimitTurn.errorCode === "engine_failed" && (await rows(legacyLimit.runId))[0]?.status === "error");

  const many = fixture("large trace");
  const openSpans = Array.from({ length: 125 }, (_, i) => ({ callId: `open-${i}`, kind: "reasoning", name: "fake open step", status: "running", startedAt: many.startedAt }));
  await call("codex:traceTurn", { token, id: many.turnId, spans: openSpans });
  await call("codex:finishTurn", { token, id: many.turnId, response: "Synthetic response" });
  check("large-trace:all-spans-close", (await rows(many.runId)).length === 125 && (await rows(many.runId)).every((s) => s.status === "error" && s.durationMs !== undefined));

  const skew = fixture("clock skew", now + 60000);
  await start(skew);
  await call("codex:finishTurn", { token, id: skew.turnId, stopped: true });
  check("clock-skew:nonnegative-duration", (await rows(skew.runId)).find((s) => s.callId === "open")?.durationMs === 0);

  const rollback = fixture("rollback");
  await start(rollback);
  const rollbackBefore = snapshot(await rows(rollback.runId));
  try { await call("fixture:rollback", { runId: rollback.runId, endedAt: now }); } catch (error) {
    check("transaction:expected-rollback-error", error instanceof Error && error.message === "fixture rollback");
  }
  check("transaction:settlement-rolls-back", snapshot(await rows(rollback.runId)) === rollbackBefore);

  // The production runner's trace adapter also receives out-of-order events.
  const trace = new TurnTrace();
  const item = { id: "local", type: "command_execution" as const, title: "fake local", status: "running" as const, raw: null };
  trace.item("started", item, now);
  trace.drain(now + 10);
  const drained = trace.take()!;
  check("runner:late-events-ignored", !trace.item("completed", { ...item, status: "completed" }, now + 20) && !trace.item("started", { ...item, id: "new late step" }, now + 30));
  trace.drain(now + 100);
  trace.addUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningTokens: 0 });
  check("runner:repeat-drain-does-not-change-time", trace.take() === null);
  trace.retry(drained);
  check("runner:failed-report-retries-terminal-state", snapshot(trace.take()) === snapshot(drained));
  evidence.runner = drained;

  const payload = fixture("completed payload cost");
  const completedIds = Array.from({ length: 256 }, (_, i) => insert("runSpans", {
    runId: payload.runId, callId: `complete-${i}`, kind: "command", name: "large completed fixture",
    status: i % 2 ? "ok" : "error", startedAt: payload.startedAt, endedAt: now, output: "x".repeat(8192),
  }));
  const completedBefore = completedIds.map(id => snapshot(runtime.store.get(id)));
  for (let i = 0; i < 3; i++) insert("runSpans", { runId: payload.runId, callId: `open-${i}`, kind: "command", name: "small open fixture", status: "running", startedAt: payload.startedAt });
  const firstSettlement = await measured(() => call("fixture:settle", { runId: payload.runId, endedAt: now }));
  check("performance:settlement-closes-open-steps", firstSettlement.value === 3);
  performanceCheck("performance:settlement-hydrates-only-open-spans", firstSettlement.hydration.runSpans?.rows === 3 && firstSettlement.hydration.runSpans.bytes < 2000);
  check("performance:large-terminal-siblings-unchanged", completedIds.every((id, i) => snapshot(runtime.store.get(id)) === completedBefore[i]));
  const repeatSettlement = await measured(() => call("fixture:settle", { runId: payload.runId, endedAt: now + 1000 }));
  check("performance:repeated-settlement-changes-nothing", repeatSettlement.value === 0);
  performanceCheck("performance:repeated-settlement-hydrates-no-spans", !repeatSettlement.hydration.runSpans?.rows);
  evidence.settlementHydration = { first: firstSettlement.hydration.runSpans, repeat: repeatSettlement.hydration.runSpans ?? { rows: 0, bytes: 0 }, completedRows: completedIds.length };

  const waitingChat = fixture("waiting lookup");
  runtime.store.patch(waitingChat.conversationId, { pendingTurns: 0, engine: "codex" });
  runtime.store.patch(waitingChat.turnId, { status: "done", finalizedAt: now });
  runtime.store.patch(waitingChat.runId, { status: "ok", finishedAt: now });
  for (let i = 0; i < 300; i++) insert("codexTurns", {
    runnerId, conversationId: waitingChat.conversationId, runId: waitingChat.runId, engine: "codex", prompt: "x".repeat(4096), instructions: "synthetic",
    status: "done", createdAt: now - 5000 - i, finalizedAt: now,
  });
  const addWaiting = (status: "queued" | "error", fields: Record<string, unknown> = {}) => insert("codexTurns", {
    runnerId, conversationId: waitingChat.conversationId, runId: waitingChat.runId, engine: "codex", prompt: "small waiting fixture", instructions: "synthetic",
    status, createdAt: now, queueOrder: 10, waiting: { until: now + 60000, why: status }, ...fields,
  });
  const errorWait = addWaiting("error", { retrying: true, queueOrder: 20 });
  const queuedWait = addWaiting("queued");
  const finalizedWait = addWaiting("queued", { finalizedAt: now, queueOrder: -10 });
  const nonRetrying = addWaiting("error", { queueOrder: -20 });
  const readWaiting = async () => (await runtime.runQuery("dashboard:getChat", { key: process.env.DASHBOARD_KEY, id: waitingChat.conversationId })).value as { waiting?: { why: string }; isRunning: boolean };
  const waitingRead = await measured(readWaiting);
  check("waiting:queued-before-retrying-error", waitingRead.value.waiting?.why === "queued");
  performanceCheck("performance:waiting-excludes-completed-history", waitingRead.hydration.codexTurns?.rows === 4 && waitingRead.hydration.codexTurns.bytes < 5000);
  runtime.store.patch(errorWait, { queueOrder: 0 });
  check("waiting:retrying-error-before-queued", (await readWaiting()).waiting?.why === "error");
  runtime.store.patch(errorWait, { queueOrder: 10 });
  check("waiting:equal-position-keeps-creation-order", (await readWaiting()).waiting?.why === "error");
  const errorCreatedAt = runtime.store.get(errorWait)!._creationTime;
  sql.prepare("UPDATE doc_codexTurns SET _creationTime = ? WHERE _id = ?").run(runtime.store.get(queuedWait)!._creationTime, errorWait);
  check("waiting:identical-imported-positions-preserve-index-order", (await readWaiting()).waiting?.why === "error");
  sql.prepare("UPDATE doc_codexTurns SET _creationTime = ? WHERE _id = ?").run(errorCreatedAt, errorWait);
  runtime.store.patch(errorWait, { retrying: true, queueOrder: 20 });
  runtime.store.patch(queuedWait, { waiting: undefined });
  check("waiting:ordinary-queue-suppresses-later-wait", (await readWaiting()).waiting === undefined);
  runtime.store.patch(errorWait, { retrying: false });
  runtime.store.patch(queuedWait, { finalizedAt: now });
  check("waiting:finalized-and-nonretrying-excluded", (await readWaiting()).waiting === undefined);
  runtime.store.patch(queuedWait, { status: "running", finalizedAt: undefined });
  runtime.store.patch(waitingChat.conversationId, { pendingTurns: 1 });
  runtime.store.patch(errorWait, { retrying: true });
  const activeRead = await measured(readWaiting);
  check("waiting:active-running-suppresses-wait", activeRead.value.isRunning && activeRead.value.waiting === undefined);
  performanceCheck("performance:running-reads-one-turn", activeRead.hydration.codexTurns?.rows === 1);
  evidence.waitingHydration = { idle: waitingRead.hydration.codexTurns, running: activeRead.hydration.codexTurns, completedRows: 301, excluded: [finalizedWait, nonRetrying].length };

  for (const run of await runtime.store.query("runs").collect()) runtime.store.patch(run._id, { status: "ok", finishedAt: now });
  const activity = async (id?: Id<"conversations">) => (await runtime.runQuery("dashboard:getActivity", {
    key: process.env.DASHBOARD_KEY, ...(id ? { id } : {}),
  })).value as import("../../convex/dashboard").Activity | null;
  check("activity:idle-without-running-runs", await activity() === null);
  const oldActive = fixture("long-running activity", now - 7_200_000);
  const activitySpan = insert("runSpans", { runId: oldActive.runId, callId: "active-step", kind: "command", name: "echo activity", status: "running", startedAt: oldActive.startedAt });
  const newerRunCount = 30;
  for (let i = 0; i < newerRunCount; i++) insert("runs", {
    conversationId: oldActive.conversationId, prompt: "completed history ".repeat(400),
    status: (["ok", "error", "rejected"] as const)[i % 3], startedAt: now - 1000 + i, finishedAt: now,
  });
  const oldActivity = await measured(() => activity());
  check("activity:completed-history-does-not-hide-long-running-work", oldActivity.value?.conversationId === oldActive.conversationId && oldActivity.value.running);
  check("activity:live-step-preserved", oldActivity.value?.step?.live === true && oldActivity.value.summary === "");
  check("activity:only-active-run-hydrated", oldActivity.hydration.runs?.rows === 1);
  const laterStart = fixture("later activity start", oldActive.startedAt + 2000);
  const laterInsert = fixture("later activity insertion", oldActive.startedAt + 1000);
  check("activity:latest-start-wins-over-insertion-order", (await activity())?.conversationId === laterStart.conversationId);
  runtime.store.patch(laterStart.runId, { status: "error", finishedAt: now });
  check("activity:error-run-no-longer-selected", (await activity())?.conversationId === laterInsert.conversationId);
  runtime.store.patch(laterInsert.runId, { status: "rejected", finishedAt: now });
  check("activity:rejected-run-no-longer-selected", (await activity())?.conversationId === oldActive.conversationId);
  runtime.store.patch(oldActive.runId, { status: "ok", finishedAt: now });
  runtime.store.patch(activitySpan, { status: "ok", endedAt: now, durationMs: now - oldActive.startedAt });
  check("activity:terminal-only-history-is-idle", await activity() === null);
  const scoped = await activity(oldActive.conversationId);
  check("activity:chat-specific-completed-run-still-visible", scoped?.running === false && scoped.startedAt === now - 1000 + newerRunCount - 1);
  const planActive = sql.prepare("EXPLAIN QUERY PLAN SELECT _id FROM doc_runs WHERE json_extract(doc,'$.status') IS ? ORDER BY json_extract(doc,'$.status') DESC, json_extract(doc,'$.startedAt') DESC, _creationTime DESC LIMIT 1").all("running") as Array<{ detail: string }>;
  check("activity:sqlite-uses-status-start-index", planActive.some(row => row.detail.includes("i_runs_by_status_started")));
  evidence.activityHydration = oldActivity.hydration.runs;

  const listChats = async () => await runtime.runQuery("dashboard:listChats", { key: process.env.DASHBOARD_KEY });
  const initialChats = await measured(listChats);
  const originalChats = initialChats.value.value as import("../../convex/dashboard").ChatSummary[];
  check("sidebar:empty-notes-have-no-hydration", !initialChats.hydration.notes?.rows);
  check("sidebar:empty-notes-keep-invalidation-dependency", initialChats.value.reads.includes("notes"));
  const addNote = (title: string, liveChatId?: Id<"conversations">) => runtime.store.insert("notes", {
    title, content: liveChatId ? "Riff fixture" : "Ordinary note body ".repeat(1800), search: title, revision: 1, by: "owner", createdAt: now, updatedAt: now,
    ...(liveChatId ? { liveChatId } : {}),
  });
  for (let index = 0; index < 120; index++) addNote(`Ordinary sidebar fixture ${index}`);
  const ordinaryChats = await measured(listChats);
  check("sidebar:ordinary-notes-preserve-chats", snapshot(ordinaryChats.value.value) === snapshot(originalChats));
  checks["sidebar:no-riffs-hydrate-at-most-one-note"] = (ordinaryChats.hydration.notes?.rows ?? 0) <= 1;
  const hidden = new Set(originalChats.slice(0, 2).map(chat => chat.id));
  for (const id of hidden) addNote("Linked Riff", id);
  addNote("Duplicate Riff reference", originalChats[0].id);
  const sidebarOrphan = insert("conversations", { channel: "web", externalId: "orphan-sidebar-fixture", threadId: "orphan-sidebar-fixture", lastMessageAt: now });
  runtime.store.delete(sidebarOrphan);
  addNote("Orphan Riff reference", sidebarOrphan);
  const sidebarRead = await measured(listChats);
  check("sidebar:riff-exclusion-preserves-full-summary-and-order", snapshot(sidebarRead.value.value) === snapshot(originalChats.filter(chat => !hidden.has(chat.id))));
  checks["sidebar:hydrates-only-riffs-and-one-boundary-note"] = sidebarRead.hydration.notes?.rows === 5;
  checks["sidebar:does-not-read-ordinary-note-payloads"] = (sidebarRead.hydration.notes?.bytes ?? Infinity) < 40_000;
  check("sidebar:one-notes-query", sidebarRead.hydration.notes?.queries === 1);
  const malformed = addNote("Malformed imported null reference");
  sql.prepare("UPDATE doc_notes SET doc=json_set(doc,'$.liveChatId',null) WHERE _id=?").run(malformed);
  check("sidebar:malformed-null-does-not-hide-a-chat", snapshot((await listChats()).value) === snapshot(sidebarRead.value.value));
  const sidebarPlan = sql.prepare("EXPLAIN QUERY PLAN SELECT _id, _creationTime, doc FROM doc_notes ORDER BY json_extract(doc,'$.liveChatId') DESC, _creationTime DESC").all() as Array<{ detail: string }>;
  check("sidebar:descending-index-without-temporary-sort", sidebarPlan.some(row => row.detail.includes("i_notes_by_live_chat")) && !sidebarPlan.some(row => row.detail.includes("TEMP B-TREE")));
  evidence.sidebarHydration = { noRiffs: ordinaryChats.hydration.notes, withRiffs: sidebarRead.hydration.notes, ordinaryNoteCount: 120, riffNoteCount: 4 };

  const cursorHome = mkdtempSync(join(tmpdir(), "perry-sidebar-cursor-"));
  let cursorSql: DatabaseSync | undefined, peer: DatabaseSync | undefined, cursorRuntime: InstanceType<typeof Runtime> | undefined;
  try {
    cursorSql = new DatabaseSync(join(cursorHome, "perry.sqlite"));
    cursorSql.exec("PRAGMA journal_mode=WAL");
    cursorRuntime = new Runtime(cursorSql, schema as never, modules, { storageDir: join(cursorHome, "storage") });
    await cursorRuntime.stop();
    const id = cursorRuntime.store.insert("notes", { title: "Cursor boundary", content: "", search: "", revision: 1, by: "owner", createdAt: now, updatedAt: now });
    await cursorRuntime.runQuery("dashboard:listChats", { key: process.env.DASHBOARD_KEY });
    peer = new DatabaseSync(join(cursorHome, "perry.sqlite"));
    peer.prepare("UPDATE doc_notes SET doc=json_set(doc,'$.title','Peer write') WHERE _id=?").run(id);
    cursorRuntime.store.patch(id, { title: "Original connection write" });
    check("sidebar:early-break-releases-reader-for-peer-and-original-writes", cursorRuntime.store.get(id)?.title === "Original connection write");
    const checkpoint = peer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    check("sidebar:early-break-does-not-block-wal-checkpoint", checkpoint.busy === 0);
  } finally {
    await cursorRuntime?.stop(); peer?.close(); cursorSql?.close(); rmSync(cursorHome, { recursive: true, force: true });
  }
} catch (error) {
  checks.completed = false;
  evidence.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  await runtime.stop();
  sql.close();
  const result = { scope: "Backend E2E: production mutation handlers and SQLite runtime; fake data, no network, no models, no UI", baseline, activityBaseline, sidebarBaseline, checks, pass: Object.values(checks).every(Boolean), evidence };
  if (!result.pass) process.exitCode = 1;
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ pass: result.pass, checks, result: join(out, "result.json") }, null, 2));
}
