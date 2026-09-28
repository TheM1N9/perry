import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/parallel-turns/run.ts <outDir>
// Perry working on several things at once: a fresh Perry (production build,
// `pnpm build` first) and the real runner on real Codex (PERRY_E2E_MODEL, by
// default gpt-6-luna), on Full access so the long commands run without asking.
//
//   1. Chat L runs a 40-second command; chat Q, asked meanwhile, is answered
//      before L is done.
//   2. Chat R runs a 25-second command beside L; the owner stops L, and R
//      still finishes with its answer.
//   3. Chats T1 and T2 each call take_longer at the same time: each call lands
//      on its own chat's turn.
//   4. Two background tasks queued together run at the same time.
//
// Ways it could fail, written down before the checks:
//   1. The second chat still waits for the first chat's turn (the runner takes
//      one turn at a time), so Q is answered only after L.
//   2. A tool call from one chat acts on another's turn: T1's take_longer
//      lands on T2's turn, or both on one.
//   3. A tool call is refused as "cannot tell which chat" although Codex named
//      its thread (the chat's session not yet recorded when Codex calls).
//   4. Stopping one turn ends the engine (the Codex app-server) and fails every
//      other turn running on it: R ends with an error, not its answer.
//   5. Background tasks still run one after another.
//   6. A turn is claimed twice, or two turns of one chat run at once.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/parallel-turns/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";

const p = await perry({ name: "parallel-turns", outDir, runnerEnv: () => ({}) });
const { KEY, call, check, notes, until, computers, turnsOf, rows, lastReply } = p;
type Turn = { _id: string; status: string; createdAt: number; startedAt?: number; finishedAt?: number; stopped?: boolean; error?: string; response?: string; patienceWhy?: string };
const turns = (chat: string) => turnsOf(chat) as unknown as Turn[];
const lastTurn = (chat: string) => turns(chat).at(-1);
const overlap = (a?: Turn, b?: Turn) => Boolean(a?.startedAt && b?.startedAt && a.finishedAt && b.finishedAt && a.startedAt < b.finishedAt && b.startedAt < a.finishedAt);
const brief = (turn?: Turn) => turn && { status: turn.status, queuedMs: turn.startedAt ? turn.startedAt - turn.createdAt : null, ranMs: turn.startedAt && turn.finishedAt ? turn.finishedAt - turn.startedAt : null,
  stopped: turn.stopped ?? false, error: turn.error?.slice(0, 200), response: turn.response?.slice(0, 200), patienceWhy: turn.patienceWhy };

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "the runner with Codex signed in", 120);
  const newChat = async () => {
    const id = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id, model: MODEL, engine: "codex" });
    return id;
  };
  const send = (id: string, text: string) => call("dashboard:sendChat", { key: KEY, id, text });
  const finished = (chat: string) => { const turn = lastTurn(chat); return Boolean(turn && turn.status !== "queued" && turn.status !== "running"); };
  const running = (chat: string) => lastTurn(chat)?.status === "running";
  const sleepCommand = (seconds: number, word: string) =>
    `This is an automated test. Run exactly this shell command, and nothing else first: Start-Sleep -Seconds ${seconds}. When it has finished, reply with the single word ${word}.`;

  // 1. A reply does not wait for another chat's long turn.
  const L = await newChat();
  const Q = await newChat();
  const R = await newChat();
  await send(L, sleepCommand(40, "SLEPT"));
  await until(() => running(L), "chat L's turn to start", 60);
  await sleep(6_000);
  await send(Q, "This is an automated test. Reply with the single word PONG.");
  await until(() => finished(Q), "chat Q's reply", 120);
  const qTurn = lastTurn(Q);
  check("replyNotHeldUpByAnotherChat", running(L) && qTurn?.status === "done" && /PONG/i.test(qTurn.response ?? "") && (qTurn.startedAt! - qTurn.createdAt) < 3_000,
    { q: brief(qTurn), lStillRunning: running(L) });

  // 2. Stopping one turn leaves the other running on the same Codex app-server.
  await send(R, sleepCommand(25, "RESTED"));
  await until(() => running(R), "chat R's turn to start", 60);
  await sleep(5_000);
  const lWasRunning = running(L);
  await call("dashboard:stopChat", { key: KEY, id: L });
  await until(() => finished(L), "chat L to stop", 120);
  await until(() => finished(R), "chat R's reply", 180);
  const lTurn = lastTurn(L);
  const rTurn = lastTurn(R);
  check("stoppingOneLeavesTheOther", lWasRunning && Boolean(lTurn?.stopped) && rTurn?.status === "done" && !rTurn.error && /RESTED/i.test(rTurn.response ?? ""),
    { l: brief(lTurn), r: brief(rTurn) });

  // 3. Tool calls from two chats at once each reach their own chat's turn.
  const T1 = await newChat();
  const T2 = await newChat();
  const toolPrompt = (name: string) =>
    `This is an automated test. First call your take_longer tool with minutes 7 and why "from ${name}". Then run exactly this shell command: Start-Sleep -Seconds 10. Then reply with the single word DONE.`;
  await Promise.all([send(T1, toolPrompt("T1")), send(T2, toolPrompt("T2"))]);
  await until(() => finished(T1) && finished(T2), "chats T1 and T2", 240);
  const t1 = lastTurn(T1);
  const t2 = lastTurn(T2);
  // What each turn did and how long each step took, from its trace.
  const stepsOf = (chat: string) => {
    const runIds = new Set(rows("runs").filter((run) => run.conversationId === chat).map((run) => run._id));
    const start = lastTurn(chat)?.startedAt ?? 0;
    return rows("runSpans").filter((span) => runIds.has(span.runId)).sort((x, y) => x.startedAt - y.startedAt)
      .map((span) => ({ kind: span.kind, name: String(span.name).slice(0, 80), status: span.status, atMs: span.startedAt - start, durationMs: span.durationMs }));
  };
  notes.steps = { T1: stepsOf(T1), T2: stepsOf(T2) };
  check("toolCallsReachTheirOwnChat", t1?.patienceWhy === "from T1" && t2?.patienceWhy === "from T2", { t1: brief(t1), t2: brief(t2) });
  check("chatsT1andT2RanTogether", overlap(t1, t2), { t1: brief(t1), t2: brief(t2) });
  const spans = rows("runSpans").filter((span) => /cannot tell which one/i.test(String(span.output ?? "")));
  check("noToolCallRefusedAsUnknown", spans.length === 0, spans.map((span) => ({ name: span.name, output: String(span.output).slice(0, 200) })));

  // 4. Two background tasks run at the same time.
  const task = (name: string) => call<string>("tasks:queueFromDashboard", { key: KEY, title: `Parallel test ${name}`,
    prompt: `This is an automated test. Run exactly this shell command: Start-Sleep -Seconds 20. Then call finish_task with outcome done and result "task ${name} slept".` });
  const [a, b] = [await task("A"), await task("B")];
  const taskRow = (id: string) => rows("tasks").find((row) => row._id === id);
  const ended = (id: string) => { const row = taskRow(id); return ["done", "failed", "blocked", "cancelled"].includes(row?.status) && Boolean(row?.conversationId) && finished(row!.conversationId); };
  // A task is done when it calls finish_task; its turn ends a moment later.
  await until(() => ended(a) && ended(b), "both background tasks and their turns to end", 360);
  const [ta, tb] = [taskRow(a)!, taskRow(b)!];
  const aTurn = ta.conversationId ? turns(ta.conversationId)[0] : undefined;
  const bTurn = tb.conversationId ? turns(tb.conversationId)[0] : undefined;
  check("backgroundTasksRanTogether", ta.status === "done" && tb.status === "done" && overlap(aTurn, bTurn),
    { a: { status: ta.status, result: String(ta.result ?? "").slice(0, 120), turn: brief(aTurn) }, b: { status: tb.status, result: String(tb.result ?? "").slice(0, 120), turn: brief(bTurn) } });

  // A chat's turns never ran side by side, and no turn ran twice.
  const all = rows("codexTurns") as unknown as Array<Turn & { conversationId: string }>;
  const clash = all.flatMap((one) => all.filter((other) => other._id > one._id && other.conversationId === one.conversationId && overlap(one, other)).map((other) => [one._id, other._id]));
  check("aChatsTurnsNeverOverlap", clash.length === 0, clash);
  notes.replies = { L: await lastReply(L), Q: await lastReply(Q), R: await lastReply(R), T1: await lastReply(T1), T2: await lastReply(T2) };
  notes.model = MODEL;
  // The most turns running at once, from the turns' own times.
  const edges = all.filter((turn) => turn.startedAt && turn.finishedAt).flatMap((turn) => [[turn.startedAt!, 1], [turn.finishedAt!, -1]] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let now = 0;
  notes.mostTurnsAtOnce = edges.reduce((most, [, step]) => Math.max(most, (now += step)), 0);
  await p.finish();
} catch (error) {
  check("ran", false, String(error));
  await p.finish();
}
process.exit(0);
