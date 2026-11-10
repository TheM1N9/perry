/**
 * Coordinator: pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/trace-settlement/run.ts
 * No build, browser, live runner,
 * network, model or service required. Failure cases were recorded first in
 * artifacts/trace-settlement/failure-cases.md. This is a backend E2E: real schema,
 * SQLite Store, Runtime transactions, traceTurn, finishTurn, recovery.sweep and
 * markFinalized; only the runner and input documents are synthetic fixtures.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Doc, Id } from "../../convex/_generated/dataModel";

const scratch = resolve(".batch-work/batch-1/245");
const out = resolve(process.argv[2] ?? join(scratch, "results"));
const within = relative(scratch, out);
if (within.startsWith("..") || isAbsolute(within)) throw new Error("Output must stay inside #245 scratch.");
process.env.PERRY_HOME = join(out, "home");
process.env.DASHBOARD_KEY = "trace-settlement-synthetic-key";
process.env.PERRY_CREDENTIAL_KEY = "22".repeat(32);
process.env.CODEX_HOME = join(out, "fake-codex");
process.env.CLAUDE_CONFIG_DIR = join(out, "fake-claude");
process.env.PERRY_ENGINE = "";
mkdirSync(out, { recursive: true });

// No project runtime imports before isolation environment is installed.
const [{ Runtime }, { default: schema }, codex, recovery, routing, { settleRunSpans }, { TurnTrace }] = await Promise.all([
  import("../../server/runtime"), import("../../convex/schema"),
  import("../../convex/codex"), import("../../convex/recovery"), import("../../convex/routing"),
  import("../../convex/lib/settle-traces"), import("../../runner/trace"),
]);
const sql = new DatabaseSync(":memory:");
const runtime = new Runtime(sql, schema as never, {
  codex, recovery, routing,
  fixture: {
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
} catch (error) {
  checks.completed = false;
  evidence.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  await runtime.stop();
  sql.close();
  const result = { scope: "Backend E2E: production mutation handlers and SQLite runtime; fake data, no network, no models, no UI", checks, pass: Object.values(checks).every(Boolean), evidence };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ pass: result.pass, checks, result: join(out, "result.json") }, null, 2));
}
