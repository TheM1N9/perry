import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/turn-watchdog/run.ts <outDir>
// The runner's turn watchdog stops a reply that is stuck, not one that is long:
// quiet (no words, no step, no approval waiting) for PERRY_TURN_IDLE_MS, or past
// PERRY_TURN_TIMEOUT_MS, unless the agent asked for longer with take_longer. And
// Stop ends an engine too stuck to hear it. A fresh Perry (production build, `pnpm
// build` first) and the real runner, with the fake ACP agent playing Grok Build
// (artifacts/engine-acp/fake-agent.ts), whose SLOW, HANG, QUIET, LONGER and RUN do
// the same thing every time; limits of seconds here instead of minutes.
//
// Ways it could fail, written down before the checks:
//   1. A reply that keeps working past the idle limit is stopped anyway.
//   2. A reply that goes quiet is never stopped, or its engine is left running,
//      so the next message never gets an answer.
//   3. take_longer does not reach the runner through Perry's MCP server, or the
//      runner does not honour it, and quiet work it asked time for is stopped.
//   4. Waiting for the owner's approval counts as quiet, and the reply is stopped
//      while it waits.
//   5. A busy reply runs past the overall cap.
//   6. Stop on an engine that ignores it leaves the reply running, or it is saved
//      as failed instead of stopped.
//   7. The owner is not told why a reply was stopped.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/turn-watchdog/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const IDLE_MS = 6_000;
let capMs = 30_000;
/** Off for the last check, which runs on real Codex with the limits Perry ships with. */
let shortLimits = true;
let fakeHome = "";
const p = await perry({
  name: "turn-watchdog",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    // Signed in already: sign-in is engine-grok's to check.
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    return {
      PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`,
      FAKE_ACP_HOME: fakeHome,
      ...(shortLimits ? { PERRY_TURN_IDLE_MS: String(IDLE_MS), PERRY_TURN_TIMEOUT_MS: String(capMs) } : {}),
      // The ACP engine's own hang check stays out of the way: the runner's watchdog is what is checked.
      PERRY_ACP_IDLE_MS: "600000",
    };
  },
});
const { KEY, call, check, notes, until, turnsOf, computers, exchange, fakeLog } = p;
const log = () => fakeLog(fakeHome);
type Turn = { _id: string; status: string; error?: string; stopped?: boolean; response?: string; patienceUntil?: number; createdAt: number; finishedAt?: number; startedAt?: number };
const last = (chat: string) => turnsOf(chat).at(-1) as Turn | undefined;
const ended = (chat: string, seconds: number) => until(() => { const turn = last(chat); return Boolean(turn && turn.status !== "queued" && turn.status !== "running"); }, "the reply to end", seconds);
const send = (chat: string, text: string) => call("dashboard:sendChat", { key: KEY, id: chat, text });
let runner: ReturnType<typeof p.start> | null = null;

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  runner = p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  const newChat = async () => { const id = await call<string>("dashboard:createChat", { key: KEY }); await call("dashboard:setChatModel", { key: KEY, id, model: "grok-fake-heavy", engine: "grok" }); return id; };
  const chat = await newChat();

  // --- 1. Busy for longer than the idle limit: it runs on ------------------------------------------------
  const busy = await exchange(chat, "SLOW count for me", 60);
  const busyTurn = last(chat);
  check("busyReplyRunsOn", busyTurn?.status === "done" && !busyTurn.error && busy.reply.includes("step 30."), { status: busyTurn?.status, error: busyTurn?.error, reply: busy.reply.slice(-60) });

  // --- 2, 7. Quiet: stopped, the engine ended, and the next message answered ----------------------------
  const hungAt = Date.now();
  await send(chat, "HANG for the test");
  await ended(chat, 90);
  const hung = last(chat)!;
  check("quietReplyStopped", hung.status === "error" && /went quiet for more than 6 seconds/.test(hung.error ?? ""), { status: hung.status, error: hung.error, tookSeconds: Math.round((Date.now() - hungAt) / 1000) });
  const after = await exchange(chat, "Hello again after the hang", 90);
  check("chatAnswersAfterIt", after.reply.includes("Hello again after the hang"), after.reply.slice(0, 120));

  // --- 3. take_longer, from the agent, through Perry's MCP server: quiet work finishes ------------------
  const longer = await exchange(chat, "LONGER 1 20", 120);
  const longerTurn = last(chat)!;
  const asked = log().find((entry) => entry.tookLonger);
  check("takeLongerLetsQuietWorkFinish", longerTurn.status === "done" && !longerTurn.error && longer.reply.includes("Done after 20 quiet seconds") && String(asked?.tookLonger).startsWith("ok")
    && (longerTurn.patienceUntil ?? 0) > (longerTurn.startedAt ?? longerTurn.createdAt) + 50_000, { status: longerTurn.status, error: longerTurn.error, asked: asked?.tookLonger, patienceUntil: longerTurn.patienceUntil });
  // Without it, the same quiet step is stopped.
  await send(chat, "QUIET 20");
  await ended(chat, 90);
  const quiet = last(chat)!;
  check("quietWorkWithoutAskingIsStopped", quiet.status === "error" && /went quiet/.test(quiet.error ?? ""), { status: quiet.status, error: quiet.error });

  // --- 4. Waiting for the owner's approval is not quiet ---------------------------------------------------
  const asking = await newChat();
  await send(asking, "RUN echo approved-after-a-wait");
  await until(async () => (await call<Array<{ id: string; kind: string }>>("approvals:pending", { key: KEY })).length > 0, "the approval", 60);
  await sleep(IDLE_MS * 2.5);
  const stillRunning = last(asking)?.status === "running";
  const pending = (await call<Array<{ id: string }>>("approvals:pending", { key: KEY }))[0];
  await call("approvals:decide", { key: KEY, id: pending.id, approved: true });
  await ended(asking, 60);
  const approved = last(asking)!;
  check("approvalWaitIsNotQuiet", stillRunning && approved.status === "done" && !approved.error, { stillRunning, status: approved.status, error: approved.error });

  // --- 5. The overall cap: busy, but past it -------------------------------------------------------------------
  p.stop(runner);
  await sleep(3_000);
  capMs = 8_000;
  runner = p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner again, with an 8-second cap", 120);
  const capped = await newChat();
  await send(capped, "SLOW past the cap");
  await ended(capped, 90);
  const cap = last(capped)!;
  check("capStopsABusyReply", cap.status === "error" && /ran for more than 8 seconds/.test(cap.error ?? ""), { status: cap.status, error: cap.error });

  // --- 6. Stop, on an engine that ignores it: ended, and saved as stopped --------------------------------------------
  const stopping = await newChat();
  await send(stopping, "LONGER 2 120");
  await until(() => log().filter((entry) => entry.quietFor === 120).length > 0, "the quiet step to start", 60);
  const stopAt = Date.now();
  await call("dashboard:stopChat", { key: KEY, id: stopping });
  await ended(stopping, 90).catch(() => {});
  const stopped = last(stopping)!;
  check("stopEndsAnEngineThatIgnoresIt", stopped.status !== "running" && stopped.stopped === true && !stopped.error && Date.now() - stopAt < 60_000,
    { status: stopped.status, stopped: stopped.stopped, error: stopped.error, tookSeconds: Math.round((Date.now() - stopAt) / 1000) });
  // --- 8. The agent itself, on real Codex: told to wait on something slow outside, it does not wait in the reply ---------
  // (PERRY_E2E_MODEL picks the model.) It sets up a job to check back, or one on the app's event, and ends its reply.
  p.stop(runner);
  await sleep(3_000);
  shortLimits = false;
  runner = p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "the runner again, with its usual limits", 120);
  const codex = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: codex, model: process.env.PERRY_E2E_MODEL ?? "gpt-6-luna", engine: "codex" });
  const jobsBefore = (await call<Array<{ builtin?: string }>>("jobs:list")).filter((job) => !job.builtin).length;
  const askedAt = Date.now();
  const waiting = await exchange(codex, "I just started an export in my accounting app. It sends a webhook when it's done, in about two hours. Wait for it and tell me when the export is ready.", 300);
  const jobs = (await call<Array<{ builtin?: string; name: string; runAt?: number; trigger?: unknown }>>("jobs:list")).filter((job) => !job.builtin);
  check("agentDoesNotWaitInTheReply", Date.now() - askedAt < 240_000 && last(codex)?.status === "done" && (jobs.length > jobsBefore || /check (back|again|in)|trigger|let you know|remind/i.test(waiting.reply)),
    { seconds: Math.round((Date.now() - askedAt) / 1000), jobs: jobs.map((job) => ({ name: job.name, runAt: job.runAt, trigger: Boolean(job.trigger) })), reply: waiting.reply.slice(0, 400) });

  notes.runnerLines = p.logs.runner.split("\n").filter((line) => /quiet|ran past|did not stop|stopping/.test(line)).slice(-12);
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}

const passed = await p.finish({ engine: "grok", agent: "fake (artifacts/engine-acp/fake-agent.ts --profile grok)", idleMs: IDLE_MS });
process.exit(passed ? 0 : 1);
