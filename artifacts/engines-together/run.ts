import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/engines-together/run.ts <outDir>
// Issue: several engines at once. Each engine has its own turn queue on the
// runner, so a turn of one engine never waits behind another engine's turn in
// another chat, and the owner's default engine is what new chats, new
// messaging chats and jobs without a model start on. A fresh Perry (production
// build, `pnpm build` first) on a spare port with a temp PERRY_HOME, the real
// runner with this machine's real signed-in Codex (PERRY_E2E_MODEL, gpt-6-luna
// by default), and, as the second engine, the scripted engine in
// runner/engines/fake.ts in Grok Build's place (PERRY_E2E_FAKE_ENGINE=grok,
// which only artifacts set). Headless Chrome for Settings. One real Codex turn
// (about 45 seconds of sleeping), quick turns naming the chats, and, when this
// machine's real Claude Code is signed in, one short Haiku turn beside Codex's.
// Nothing touches the owner's own Perry.
//
// Ways it could fail, written down before the checks:
//   1. The second engine's turn waits behind the first engine's turn in another chat.
//   2. A chat gets two turns running at once, when its next turn is on another
//      engine than the running one; or its turns run out of order.
//   3. Stop or a steer meant for one turn reaches the other engine's turn.
//   4. Streamed text crosses between the two turns running at once.
//   5. Traces are mixed: one turn's items recorded under the other's run.
//   6. Quick turns (chat names) wait behind a long turn.
//   7. With no default picked, new chats don't start on Codex (the first signed-in engine).
//   8. The Settings picker doesn't save the default engine.
//   9. A new web chat, a new messaging chat (WhatsApp here, as no Telegram bot
//      token is set; Telegram runs the same code), a job without a model, or the
//      heartbeat does not use the default engine.
//  10. The composer's model for a new chat is not the default engine's default model.
//  11. /status does not name the chat's engine.
//  12. With the default engine signed out everywhere, new chats don't fall back
//      to a signed-in one.
//  13. A chat whose engine is signed out everywhere silently moves to another
//      engine, or fails without saying what to do.
//  14. The dashboard throws, or the runner logs a failed turn.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engines-together/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "engines-together-e2e-key";
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const NONCE = `e2e${Date.now().toString(36)}`;
const home = mkdtempSync(join(tmpdir(), "perry-engines-together-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

// --- Perry ----------------------------------------------------------------------
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const logs = { server: "", runner: "" };
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child = spawn(command, args, { cwd: REPO, env: name === "runner" ? { ...env, PERRY_E2E_FAKE_ENGINE: "grok" } : env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  return child;
}
const stop = (child: ChildProcess | null) => {
  if (!child?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}

// The documents themselves, as Perry keeps them in SQLite, through Node (Bun has no node:sqlite).
const SQL = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
const statement = db.prepare(process.argv[2]); const params = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? statement.all(...params) : (statement.run(...params), [])));`;
function sql<T>(statement: string, params: Array<string | number> = []): T[] {
  const ran = spawnSync("node", ["-e", SQL, join(home, "perry.sqlite"), statement, JSON.stringify(params)], { encoding: "utf8", windowsHide: true });
  if (ran.status !== 0) throw new Error(`sqlite: ${ran.stderr}`);
  return JSON.parse(ran.stdout || "[]");
}
type Row = Record<string, any> & { _id: string };
const rows = (table: string): Row[] => sql<{ _id: string; doc: string }>(`SELECT _id, doc FROM "doc_${table}"`)
  .map((row) => ({ _id: row._id, ...JSON.parse(row.doc) }));
const edit = (table: string, id: string, change: string, ...params: Array<string | number>) =>
  sql(`UPDATE "doc_${table}" SET doc = ${change} WHERE _id = ?`, [...params, id]);
const turnsOf = (chat: string) => rows("codexTurns").filter((turn) => turn.conversationId === chat).sort((a, b) => a.createdAt - b.createdAt);
const spansOf = (runId: string) => rows("runSpans").filter((span) => span.runId === runId);

type Chat = { isRunning: boolean; streaming?: string; lastError?: string; engine: string; model?: string; title: string };
const getChat = (id: string) => call<Chat>("dashboard:getChat", { key: KEY, id });
const messagesOf = async (id: string) => (await call<{ page: Array<{ role: string; text: string; createdAt: number }> }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 30, cursor: null } }))
  .page.sort((a, b) => a.createdAt - b.createdAt);
const replyOf = async (id: string) => (await messagesOf(id)).filter((message) => message.role === "assistant").at(-1)?.text ?? "";
const conversation = (id: string) => call<Row>("conversations:getById", { id });
type Computer = { id: string; name: string; online: boolean; engines: Array<{ kind: string; signedIn: boolean }> };
const computers = () => call<Computer[]>("engines:list", { key: KEY });
type Default = { picked?: string; engine: string; choices: Array<{ kind: string; label: string; online: boolean }> };
const getDefault = () => call<Default>("engines:getDefault", { key: KEY });
const send = (id: string, text: string) => call("dashboard:sendChat", { key: KEY, id, text });
type JobRow = { id: string; name: string; builtin?: string; lastResult?: string; lastError?: string; chatId?: string; lastRunAt?: number };
const jobs = async () => (await call<{ jobs: JobRow[] }>("jobs:listForDashboard", { key: KEY })).jobs;

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  const both = async () => (await computers()).some((item) => item.online && ["codex", "grok"].every((kind) => item.engines.some((engine) => engine.kind === kind && engine.signedIn)));
  await until(both, "the runner to report Codex and the second engine signed in", 120);
  const real = (await computers()).find((item) => item.online)!;
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });

  // --- 7. No default picked: Codex, the first signed-in engine ---------------------------------------------
  const before = await getDefault();
  const firstChat = await call<string>("dashboard:createChat", { key: KEY });
  check("fallbackPrefersCodex", !before.picked && before.engine === "codex" && (await conversation(firstChat)).engine === "codex"
    && before.choices[0]?.kind === "codex" && before.choices.some((choice) => choice.kind === "grok"), before);

  // --- 8. Settings: pick Grok Build as the default engine -----------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send: cdp } = browser;
  const shot = async (name: string) => {
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.replace(${EMAIL}, "owner@example.com"); return true; })()`);
    const image = await cdp("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  /** A real click at the middle of the first element matching the selector (and, when given, holding the text). */
  const click = async (selector: string, text?: string) => {
    const box = await evaluate(`(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => ${text ? `item.innerText.includes(${JSON.stringify(text)})` : "true"}); if (!found) return null; found.scrollIntoView({ block: "center" }); const r = found.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number } | null;
    if (!box) throw new Error(`nothing to click: ${selector} ${text ?? ""}`);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  await cdp("Page.navigate", { url: `${BASE}/settings` });
  await until(() => evaluate(`Boolean(document.querySelector('button[aria-label="Default engine"], [role="combobox"][aria-label="Default engine"]'))`), "the default engine picker", 30);
  await click('button[aria-label="Default engine"], [role="combobox"][aria-label="Default engine"]');
  await until(() => evaluate(`[...document.querySelectorAll('[role="option"]')].some((item) => item.innerText.includes("Grok Build"))`), "the picker's options", 10);
  await click('[role="option"]', "Grok Build");
  await until(async () => (await getDefault()).picked === "grok", "the pick to be saved", 15).catch(() => {});
  await sleep(1000);
  await evaluate(`document.querySelector('section[aria-label="Engines"]').scrollIntoView(); true`);
  await shot("settings-default-engine.png");
  const picked = await getDefault();
  const pickerText = await evaluate(`document.querySelector('[aria-label="Default engine"]')?.innerText ?? ""`) as string;
  check("settingsPickerSaves", picked.picked === "grok" && picked.engine === "grok" && pickerText.includes("Grok Build"), { picked, pickerText });

  // --- 9, 10. New chats, a messaging chat, a job without a model and the heartbeat take the default ----------------
  const options = await call<{ defaultEngine: string; models: Array<{ id: string; engine?: string }> }>("models:options", { key: KEY });
  const lastPicks = await call<{ engine?: string; model?: string }>("dashboard:getLastPicks", { key: KEY });
  await cdp("Page.navigate", { url: `${BASE}/chat` });
  await until(() => evaluate(`document.body.innerText.includes("Fake Small")`), "the composer to show the default engine's model", 30).catch(() => {});
  const composerShowsDefault = await evaluate(`document.body.innerText.includes("Fake Small")`) as boolean;
  check("pickersDefaultToDefaultEngine", options.defaultEngine === "grok" && lastPicks.engine === "grok" && !lastPicks.model && composerShowsDefault,
    { defaultEngine: options.defaultEngine, lastPicks, composerShowsDefault });

  const webChat = await call<string>("dashboard:createChat", { key: KEY });
  await send(webChat, `Hello tag:web-${NONCE}`);
  await until(async () => (await replyOf(webChat)).includes(`web-${NONCE}`), "the web chat's reply", 60).catch(() => {});
  const webTurn = turnsOf(webChat)[0];
  check("newWebChatUsesDefault", (await conversation(webChat)).engine === "grok" && webTurn?.engine === "grok" && webTurn.requestedModel === "fake-small"
    && (await replyOf(webChat)).startsWith(`FAKE grok/fake-small web-${NONCE}`),
    { chat: (await conversation(webChat)).engine, turn: webTurn && { engine: webTurn.engine, model: webTurn.requestedModel }, reply: (await replyOf(webChat)).slice(0, 80) });

  const phone = "15550002222@s.whatsapp.net";
  edit("installation", rows("installation")[0]._id, "json_set(doc, '$.whatsappOwner', ?)", phone);
  await call("brain:handleTurn", { channel: "whatsapp", externalId: phone, text: "/status" });
  await until(() => rows("whatsappOutbox").some((row) => String(row.text ?? "").includes("engine ")), "the /status reply", 30).catch(() => {});
  const status = rows("whatsappOutbox").map((row) => String(row.text ?? "")).find((text) => text.includes("engine ")) ?? "";
  const phoneChat = rows("conversations").find((row) => row.channel === "whatsapp" && row.externalId === phone);
  check("messagingChatUsesDefault", phoneChat?.engine === "grok", { engine: phoneChat?.engine });
  check("statusShowsEngine", /engine\s+Grok Build/.test(status) && /model\s+grok default \(fake-small\)/.test(status), status);

  const job = await call<string>("jobs:saveFromDashboard", { key: KEY, name: "Default engine check", prompt: `Reply. tag:job-${NONCE}`, schedule: "0 3 1 1 *" });
  await call("jobs:runNow", { key: KEY, id: job });
  const heartbeat = (await jobs()).find((item) => item.builtin === "heartbeat")!;
  await call("jobs:runNow", { key: KEY, id: heartbeat.id });
  let ranJob: JobRow | undefined;
  let ranBeat: JobRow | undefined;
  await until(async () => {
    const all = await jobs();
    ranJob = all.find((item) => item.id === job);
    ranBeat = all.find((item) => item.id === heartbeat.id);
    return Boolean((ranJob?.lastResult || ranJob?.lastError) && ranBeat?.chatId && turnsOf(ranBeat.chatId).some((turn) => turn.status === "done"));
  }, "the job and the heartbeat to run", 120).catch(() => {});
  const jobTurn = ranJob?.chatId ? turnsOf(ranJob.chatId).at(-1) : undefined;
  const beatTurn = ranBeat?.chatId ? turnsOf(ranBeat.chatId).at(-1) : undefined;
  check("jobUsesDefault", jobTurn?.engine === "grok" && jobTurn.requestedModel === "fake-small" && (ranJob?.lastResult ?? "").includes(`job-${NONCE}`),
    { turn: jobTurn && { engine: jobTurn.engine, model: jobTurn.requestedModel }, result: ranJob?.lastResult?.slice(0, 80), error: ranJob?.lastError });
  check("heartbeatUsesDefault", beatTurn?.engine === "grok" && beatTurn.requestedModel === "fake-small" && beatTurn.status === "done",
    { turn: beatTurn && { engine: beatTurn.engine, model: beatTurn.requestedModel, status: beatTurn.status, error: beatTurn.error } });

  // --- 1-6. Two engines at once ------------------------------------------------------------------------------------
  // Chat A on Codex: one real turn that sleeps for 45 seconds.
  const chatA = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chatA, model: MODEL, engine: "codex" });
  await send(chatA, `Run this PowerShell command exactly, then reply with exactly: codex-done ${NONCE}\nStart-Sleep -Seconds 45`);
  await until(() => Boolean(turnsOf(chatA)[0]?.codexTurnId), "Codex to start chat A's turn", 120);
  let chatB = "";
  let chatC = "";
  const snapshots = { A: [] as string[], C: [] as string[] };
  // When chats B and C got their names from a quick turn: the first message stands in until then.
  const named: { B?: number; C?: number } = {};
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      for (const [name, id] of [["A", chatA], ["B", chatB], ["C", chatC]] as const) {
        if (!id) continue;
        const now = await getChat(id).catch(() => null);
        if (name !== "A" && now && !now.title.includes(NONCE) && now.title !== "New chat") named[name] ??= Date.now();
        if (name !== "B" && now?.streaming && snapshots[name].at(-1) !== now.streaming) snapshots[name].push(now.streaming);
      }
      await sleep(150);
    }
  })();

  // Chat D, on this machine's real Claude Code when it is signed in here: one short Haiku turn while Codex's runs.
  const realClaude = (await computers()).find((item) => item.id === real.id)?.engines.some((engine) => engine.kind === "claude" && engine.signedIn) ?? false;
  let chatD = "";
  if (realClaude) {
    chatD = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id: chatD, model: "haiku", engine: "claude" });
    await send(chatD, "Say hello in five words or fewer.");
  }

  // Chat B, on the default engine, runs its whole turn while A's runs.
  chatB = await call<string>("dashboard:createChat", { key: KEY });
  await send(chatB, `Beside Codex tag:B-${NONCE} fake-seconds:3`);
  await until(() => turnsOf(chatB)[0]?.status === "done", "chat B's turn", 60).catch(() => {});
  const turnA = () => turnsOf(chatA)[0];
  const turnB = turnsOf(chatB)[0];
  check("otherEngineRunsBeside", turnB?.status === "done" && turnB.startedAt >= turnA().startedAt && turnA().status === "running" && turnB.finishedAt - turnB.createdAt < 15_000,
    { waitedMs: turnB && turnB.startedAt - turnB.createdAt, ranMs: turnB && turnB.finishedAt - turnB.startedAt, codexStill: turnA().status });

  // Chat C, a long turn on the default engine: steered, then stopped, while A's runs on.
  chatC = await call<string>("dashboard:createChat", { key: KEY });
  await send(chatC, `Long one tag:C-${NONCE} fake-seconds:40`);
  await until(() => Boolean(turnsOf(chatC)[0]?.codexTurnId), "chat C's turn to start", 30);
  const turnC = turnsOf(chatC)[0];
  await send(chatC, `steer-C-${NONCE}`);
  await until(() => rows("codexSteers").some((steer) => steer.turnId === turnC._id && steer.status !== "pending"), "the steer to be answered", 30).catch(() => {});
  await until(async () => {
    const streaming = (await getChat(chatC)).streaming;
    if (streaming && snapshots.C.at(-1) !== streaming) snapshots.C.push(streaming);
    return streaming?.includes(`[steered: steer-C-${NONCE}]`) ?? false;
  }, "the steer to show in C's reply", 15).catch(() => {});
  await call("dashboard:stopChat", { key: KEY, id: chatC });
  await until(() => turnsOf(chatC)[0]?.status === "done", "chat C's turn to stop", 30).catch(() => {});
  const stoppedC = turnsOf(chatC)[0];
  const replyC = await replyOf(chatC);
  const steerC = rows("codexSteers").find((steer) => steer.turnId === turnC._id);
  check("steerAndStopHitTheirTurn", steerC?.status === "applied" && replyC.includes(`[steered: steer-C-${NONCE}]`) && stoppedC.stopped === true && /_Stopped\._/.test(replyC)
    && stoppedC.finishedAt - stoppedC.startedAt < 40_000 && turnA().status === "running" && !turnA().stopRequested
    && !rows("codexSteers").some((steer) => steer.turnId === turnA()._id),
    { steer: steerC?.status, cRanMs: stoppedC.finishedAt - stoppedC.startedAt, cReply: replyC.slice(-120), codex: { status: turnA().status, stopRequested: Boolean(turnA().stopRequested) } });

  if (realClaude) {
    await until(() => ["done", "error"].includes(turnsOf(chatD)[0]?.status), "Claude Code's turn", 120).catch(() => {});
    const turnD = turnsOf(chatD)[0];
    const replyD = await replyOf(chatD);
    const codexNow = turnA();
    check("realClaudeRunsBesideCodex", turnD?.status === "done" && turnD.engine === "claude" && turnD.startedAt >= codexNow.startedAt
      && (codexNow.status === "running" || turnD.finishedAt <= codexNow.finishedAt) && replyD.trim().length > 0 && !turnD.error,
      { waitedMs: turnD && turnD.startedAt - turnD.createdAt, ranMs: turnD && turnD.finishedAt - turnD.startedAt, model: turnD?.requestedModel, codexStill: codexNow.status, reply: replyD.slice(0, 80), error: turnD?.error });
  } else {
    notes.realClaudeRunsBesideCodex = "skipped: Claude Code isn't signed in on this computer";
  }

  // Chat A moves to the default engine while its Codex turn runs: its next turn waits for that one.
  await call("dashboard:setChatModel", { key: KEY, id: chatA, model: "fake-small", engine: "grok" });
  await send(chatA, `After Codex tag:A2-${NONCE}`);
  await sleep(3000);
  const waitingA2 = turnsOf(chatA)[1];
  const heldBack = waitingA2?.status === "queued" && turnA().status === "running";
  await until(() => turnsOf(chatA)[1]?.status === "done", "chat A's two turns", 180);
  watching = false;
  await watcher;
  const [firstA, secondA] = turnsOf(chatA);
  const replyA = (await messagesOf(chatA)).filter((message) => message.role === "assistant").map((message) => message.text);
  check("oneTurnPerChat", heldBack && secondA.engine === "grok" && secondA.startedAt >= firstA.finishedAt && firstA.engine === "codex",
    { heldBack, codex: { startedAt: firstA.startedAt, finishedAt: firstA.finishedAt }, next: { engine: secondA.engine, startedAt: secondA.startedAt } });
  check("codexTurnCompletes", firstA.status === "done" && !firstA.error && !firstA.stopped && replyA.some((text) => text.startsWith("codex-done")),
    { error: firstA.error, replies: replyA.map((text) => text.slice(0, 80)) });
  // Chat A's own later turn (A2, on the second engine) streams into it too, and only its own text.
  const streamedA = snapshots.A.filter((text) => !text.startsWith(`FAKE grok/fake-small A2-${NONCE}`));
  check("streamsStayApart", snapshots.C.length >= 1 && snapshots.C.every((text) => text.startsWith(`FAKE grok/fake-small C-${NONCE}`))
    && streamedA.every((text) => !text.includes("FAKE")) && !replyA.some((text) => text.includes(`C-${NONCE}`)) && !replyC.includes("codex-done"),
    { snapshotsA: snapshots.A.length, codexSnapshotsA: streamedA.map((text) => text.slice(0, 80)), snapshotsC: snapshots.C.length, lastC: snapshots.C.at(-1)?.slice(0, 120) });
  // The chats were named by Codex's quick turns while its long turn and the other engine's ran.
  check("quickTurnsBeside", Boolean((named.B && named.B < firstA.finishedAt) || (named.C && named.C < firstA.finishedAt)),
    { namedBeforeCodexFinishedMs: { B: named.B && firstA.finishedAt - named.B, C: named.C && firstA.finishedAt - named.C }, titles: { B: (await getChat(chatB)).title, C: (await getChat(chatC)).title } });
  const spansA = spansOf(firstA.runId);
  const spansC = spansOf(stoppedC.runId);
  check("tracesStayApart", spansA.some((span) => /Start-Sleep/.test(`${span.name} ${span.input ?? ""}`)) && !spansA.some((span) => /fake/.test(`${span.name}`))
    && spansC.some((span) => span.name.includes(`fake step C-${NONCE}`)) && spansC.every((span) => !/Start-Sleep/.test(`${span.name} ${span.input ?? ""}`)),
    { spansA: spansA.map((span) => span.name.slice(0, 60)), spansC: spansC.map((span) => span.name.slice(0, 60)) });

  // --- 12, 13. The default engine signed out everywhere ----------------------------------------------------------
  await call("engines:requestAuth", { key: KEY, runnerId: real.id, engine: "grok", kind: "logout" });
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "grok" && !engine.signedIn)), "the second engine to sign out", 60);
  const fallen = await getDefault();
  const afterChat = await call<string>("dashboard:createChat", { key: KEY });
  check("unavailableDefaultFallsBack", fallen.picked === "grok" && fallen.engine === "codex" && (await conversation(afterChat)).engine === "codex", { fallen, newChat: (await conversation(afterChat)).engine });
  await send(chatB, "Are you there?");
  await until(async () => Boolean((await getChat(chatB)).lastError), "chat B to say why it can't answer", 30).catch(() => {});
  const saysB = await getChat(chatB);
  check("unavailableChatEngineSaysSo", saysB.engine === "grok" && saysB.lastError === "Grok Build isn't signed in on any computer. Sign in to it in Settings, or pick another engine's model.",
    { engine: saysB.engine, lastError: saysB.lastError });
  await cdp("Page.navigate", { url: `${BASE}/settings` });
  await until(() => evaluate(`(document.querySelector('[aria-label="Default engine"]')?.innerText ?? "").includes("for now")`), "the fallback note", 30).catch(() => {});
  await evaluate(`document.querySelector('section[aria-label="Engines"]').scrollIntoView(); true`);
  await shot("settings-default-fallback.png");
  notes.settingsFallback = await evaluate(`document.querySelector('section[aria-label="Engines"]').innerText`);

  check("noPageErrors", browser.errors.length === 0, browser.errors);
  check("runnerLogClean", !/turn failed:|could not report the engines/i.test(logs.runner), logs.runner.split("\n").filter((line) => /fail|error/i.test(line)).slice(-10));
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  await sleep(3_000);
  notes.runnerLog = logs.runner.split("\n").filter(Boolean).slice(-40);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), model: MODEL, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2).replace(EMAIL, "owner@example.com")}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
