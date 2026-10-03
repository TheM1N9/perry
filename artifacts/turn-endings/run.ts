import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/turn-endings/run.ts <outDir>   (PERRY_E2E_ROOT: where the temp home goes)
// Needs `pnpm build` first. A fresh Perry in a temp folder, served by `next start`; the runner is
// played by its own calls, so no engine runs. Each case is a chat of its own.
//
// Ways a turn's ending could go wrong, and the check that catches each:
//   1. The runner restarts mid-reply and the streamed text is thrown away   â†’ restartKeepsPartial
//   2. That restart is told with the old "Gateway fallback" line, or not at all â†’ restartSaysWhatHappened
//   3. A turn finishes with no text and no files, and the chat shows nothing â†’ emptyReplyIsAnError
//   4. A reply that is only the line naming memories counts as an answer    â†’ memoriesLineAloneIsEmpty
//   5. An ordinary reply is mistaken for an empty one                        â†’ ordinaryReplyUntouched
//   6. A turn stopped before it wrote anything is called a failure           â†’ stoppedEmptyIsNotAnError
//   7. Finalizing again saves the messages twice                             â†’ nothingRepeats
//   8. The dashboard does not show it: no error banner, no kept text, or a page error â†’ shown in the chat
const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/turn-endings/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "turn-endings-e2e-key";
const NONCE = `e2e-${Date.now().toString(36)}`;
const root = process.env.PERRY_E2E_ROOT ?? tmpdir();
const home = mkdtempSync(join(root, "perry-turn-endings-"));
const temp = join(home, "tmp");
mkdirSync(temp, { recursive: true });
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = { home };
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks[name] = pass;
  if (detail !== undefined) notes[name] = detail;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}`);
};

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex", TEMP: temp, TMP: temp };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
let serverLog = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { serverLog += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk; });
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

type Chat = { isRunning: boolean; lastError?: string };
type Message = { role: string; text: string };
const token = `turn-endings-${NONCE}`;
const getChat = (id: string) => call<Chat>("dashboard:getChat", { key: KEY, id });
const messages = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 20, cursor: null } })).page;

/** A chat with one message, its turn claimed by the pretend runner: what the runner then does is up to the case. */
async function turnFor(text: string): Promise<{ chat: string; turn: string }> {
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: chat, text });
  let turn: { _id: string } | undefined;
  await until(async () => {
    turn = (await call<Array<{ _id: string; conversationId: string }>>("codex:queuedTurns", { token })).find((item) => item.conversationId === chat);
    return Boolean(turn);
  }, "the turn to queue", 30);
  if (!(await call("codex:claimTurn", { token, id: turn!._id }))) throw new Error("could not claim the turn");
  return { chat, turn: turn!._id };
}
/** The chat once its turn is finalized: no longer running, and its messages saved. */
async function settled(chat: string) {
  await until(async () => !(await getChat(chat)).isRunning, "the turn to finish", 30);
  await sleep(1500);
  return { chat: await getChat(chat), messages: await messages(chat) };
}

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("runner:createToken", { name: "E2E runner", token });
  await call("runner:checkIn", { token, platform: platform(), hostname: hostname(), workdir: home });
  await call("engines:report", { token, engines: [{
    kind: "codex", installed: true, version: "999.0.0", signedIn: true, auth: { type: "chatgpt", label: "ChatGPT" },
    models: [{ id: "gpt-e2e", name: "GPT E2E", isDefault: true, efforts: ["low"], defaultEffort: "low" }],
  }] });

  // 1â€“2. Streaming, then the runner restarts: on start it ends the turn with only an error (runner/index.ts, recoverTurns).
  const restart = await turnFor(`Count to fifty ${NONCE}`);
  const streamed = "1\n2\n3\n4\n5\n6\n7\n8";
  await call("codex:streamTurn", { token, id: restart.turn, text: streamed });
  const running = await call<Array<{ _id: string }>>("codex:runningTurns", { token });
  const RESTARTED = "Perry restarted during this reply, so it ended early. Send the message again to finish it.";
  for (const job of running) await call("codex:finishTurn", { token, id: job._id, error: RESTARTED });
  const restartEnd = await settled(restart.chat);
  const restartReply = restartEnd.messages.find((message) => message.role === "assistant")?.text ?? "";
  check("restartKeepsPartial", restartReply.startsWith(streamed), restartEnd);
  check("restartSaysWhatHappened", restartEnd.chat.lastError === RESTARTED && !/gateway/i.test(restartEnd.chat.lastError ?? ""));

  // 3. Done, with nothing to show.
  const empty = await turnFor(`Say something ${NONCE}`);
  await call("codex:finishTurn", { token, id: empty.turn, response: "" });
  const emptyEnd = await settled(empty.chat);
  check("emptyReplyIsAnError", /without writing a reply/.test(emptyEnd.chat.lastError ?? "")
    && emptyEnd.messages.filter((message) => message.role === "user").length === 1
    && !emptyEnd.messages.some((message) => message.role === "assistant"), emptyEnd);

  // 4. Only the line naming memories, which finishTurn takes off.
  const cited = await turnFor(`Recall something ${NONCE}`);
  await call("codex:finishTurn", { token, id: cited.turn, response: "\nmemories: abc123" });
  const citedEnd = await settled(cited.chat);
  check("memoriesLineAloneIsEmpty", /without writing a reply/.test(citedEnd.chat.lastError ?? ""), citedEnd);

  // 5. An ordinary reply.
  const ordinary = await turnFor(`Say pong ${NONCE}`);
  await call("codex:finishTurn", { token, id: ordinary.turn, response: "pong" });
  const ordinaryEnd = await settled(ordinary.chat);
  check("ordinaryReplyUntouched", !ordinaryEnd.chat.lastError
    && ordinaryEnd.messages.some((message) => message.role === "assistant" && message.text === "pong"), ordinaryEnd);

  // 6. Stopped by the owner before it wrote anything.
  const stopped = await turnFor(`Start something long ${NONCE}`);
  await call("codex:finishTurn", { token, id: stopped.turn, stopped: true });
  const stoppedEnd = await settled(stopped.chat);
  check("stoppedEmptyIsNotAnError", !stoppedEnd.chat.lastError, stoppedEnd);

  // 7. Finalizing the restarted and the empty turns again saves nothing more.
  for (const turn of [restart.turn, empty.turn]) await call("codex:finalizeTurn", { id: turn }).catch((error) => { notes.refinalize = String(error); });
  await sleep(2000);
  check("nothingRepeats", (await messages(restart.chat)).length === restartEnd.messages.length
    && (await messages(empty.chat)).length === emptyEnd.messages.length);

  // 8. What the dashboard shows for each.
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const look = async (chat: string, file: string) => {
    await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
    await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => document.querySelector('[role=alert]') ? resolve(true) : Date.now() - start > 20000 ? reject(new Error('no error banner')) : setTimeout(tick, 200); tick(); })`);
    await sleep(800);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, file), Buffer.from(shot.data, "base64"));
    return await evaluate(`({ banner: document.querySelector('[role=alert]')?.innerText ?? null, text: document.querySelector('main')?.innerText ?? '' })`) as { banner: string | null; text: string };
  };
  const restartPage = await look(restart.chat, "restart.png");
  check("restartShownInChat", /restarted during this reply/.test(restartPage.banner ?? "") && restartPage.text.includes("8"), restartPage.banner);
  const emptyPage = await look(empty.chat, "empty-reply.png");
  check("emptyShownInChat", /without writing a reply/.test(emptyPage.banner ?? ""), emptyPage.banner);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  check("ran", false, String(error));
  notes.serverLog = serverLog.slice(-4000);
} finally {
  browser?.close();
  if (server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1500);
  for (let attempt = 0; attempt < 10; attempt++) {
    try { rmSync(home, { recursive: true, force: true }); break; } catch { await sleep(1000); }
  }
}

const passed = Object.values(checks).every(Boolean) && Object.keys(checks).length > 0;
const result = { ranAt: new Date().toISOString(), passed, checks, notes };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(passed ? "PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
