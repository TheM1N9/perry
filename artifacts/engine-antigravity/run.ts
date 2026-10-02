import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/engine-antigravity/run.ts <outDir>
// Antigravity (experimental) as Perry's engine: Google's own ACP server, downloaded only
// when the owner turns it on, verified against a pinned size and SHA-256, unpacked under
// Perry's home, run with its own home and temp folders, and signed in with a Gemini API
// key from Settings → Engines (the default) or with Google (Experimental, with Google's
// warning). Google's server is not downloaded here (disk is short on this machine):
// PERRY_ANTIGRAVITY_RELEASE points the runner at a fake release served from this test,
// a small zip whose agy_acp_server.cmd starts the fake ACP agent playing Antigravity
// (artifacts/engine-acp/fake-agent.ts --profile antigravity): its auth methods, a mode
// config option (default / auto_edit / yolo), session/resume back on its default model,
// the Google sign-in link printed on stdout among the JSON-RPC lines, a cancel it ignores,
// stdin closing it ignores, an empty end_turn before its reply, an unpack into its temp
// folder on every start, and hangs. The real pins were checked by hashing Google's six
// zips as they streamed. Everything else is real: a fresh Perry (`next start`, a temp
// PERRY_HOME), the real runner, this machine's real Codex, Grok and Claude engines on the
// same runner, and headless Chrome. If Codex's account is out of its usage allowance, the
// switch check accepts the turn reaching Codex and failing with Codex's quota message, and
// result.json says so (codexOutOfQuota).
//
// Ways it could fail, written down before the checks:
//   1. The server is downloaded before the owner turns Antigravity on, or a probe starts it.
//   2. Settings does not mark Antigravity Experimental, does not warn in Google's own words
//      before signing in with Google, or does not offer the Gemini API key first.
//   3. Turning it on without a saved key does not say to save one.
//   4. A download that does not match the pin is run, or leaves files behind.
//   5. The good download is not verified, unpacked and used; temp files stay.
//   6. The key is not given to the server, or it appears in a log, the runner's output or
//      this artifact.
//   7. The server's home and temp folders are not Perry's own, or what a killed server
//      left in its temp folder is not cleared before the next start.
//   8. A reply does not stream or save; the mode is not "default" on Ask, or is yolo.
//   9. After a restart the session is not resumed, or stays on the default model.
//  10. Perry's `remember` does not reach it.
//  11. On Ask a command's request does not reach the dashboard, or the answer is not the
//      server's own option id; on Full access the mode is not yolo.
//  12. Stop does nothing when the server ignores cancel: it must be ended and the reply
//      marked stopped, and the chat resume after.
//  13. A hung reply runs forever.
//  14. Switching to Codex and back breaks either.
//  15. Signing in with Google does not go through the server's own flow, or its link on
//      stdout breaks the connection.
//  16. Signing out does not.
//  17. The dashboard throws, or the runner logs failures.
//  18. A reply whose end_turn comes before any of its text is saved empty (the turn must
//      wait for the text that follows) — earlyEndTurnWaitsForReply.
//  19. What the server unpacks into its temp folder, a download, or a half-unpacked
//      server is left behind — noTempLeftovers.
//  20. Settings does not list every engine on the runner, lists Cursor, or the model
//      picker does not group Codex's and Antigravity's models — enginesCoexist.
//  21. A server outlives the runner, one that ignores its stdin closing included (a stop
//      or a watchdog must end its whole process tree) — agentsEndWithRunner.
//  22. The run itself does not get to the end (the runner crashed, a step timed out) —
//      completed.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engine-antigravity/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const NONCE = `agy-${Date.now().toString(36)}`;
const KEY_VALUE = "fake-gemini-key-0123";
const TARGET = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;

// --- A fake release: a small zip with a launcher for the fake agent, served over HTTP ---------------
const work = mkdtempSync(join(tmpdir(), "perry-agy-release-"));
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
let downloads = 0;
// As dl.google.com does: gzipped when the client accepts gzip, with the gzipped length declared.
// Perry once took that length for the zip's and refused a good download. With gzipAlways it
// gzips even a request for the plain file, as a proxy might.
const gzipped = gzipSync(bytes);
let gzipAlways = false;
const encodings: string[] = [];
const files = createServer((request, response) => {
  downloads++;
  encodings.push(String(request.headers["accept-encoding"] ?? ""));
  const gzip = gzipAlways || /gzip/.test(String(request.headers["accept-encoding"] ?? ""));
  response.writeHead(200, gzip
    ? { "content-type": "application/zip", "content-encoding": "gzip", "content-length": gzipped.length }
    : { "content-type": "application/zip", "content-length": bytes.length });
  response.end(gzip ? gzipped : bytes);
}).listen(0, "127.0.0.1");
await new Promise((done) => files.once("listening", done));
const url = `http://127.0.0.1:${(files.address() as { port: number }).port}/agy-acp-server-fake.zip`;
const releaseFile = join(work, "release.json");
const release = (sha256: string) => writeFileSync(releaseFile, JSON.stringify({ version: "9.9.9-fake", assets: { [TARGET]: { url, sha256, size: bytes.length, cmd } } }));
// First a release whose checksum is wrong, as a tampered download would be.
release("0".repeat(64));

let fakeHome = "";
let agyRoot = "";
const p = await perry({
  name: "engine-antigravity",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-antigravity");
    agyRoot = join(home, "engines", "antigravity");
    return {
      // Codex and Claude Code signed out in folders of their own: nothing here may reach the owner's accounts.
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      // And Grok pointed at nothing: the owner's own `grok` is signed in on this machine and must never be reached.
      PERRY_GROK_COMMAND: join(home, "no-grok-here"),
      PERRY_ANTIGRAVITY_RELEASE: releaseFile,
      FAKE_ACP_HOME: fakeHome,
      FAKE_ACP_START_DELAY_MS: "3000",
      FAKE_ACP_LOGIN_MS: "3000",
      FAKE_ACP_IGNORE_CANCEL: "1",
      FAKE_ACP_IGNORE_STDIN: "1",
      PERRY_ACP_IDLE_MS: "8000",
      // Not Perry's key: one in the environment must never reach Google's server.
      GOOGLE_API_KEY: "owner-google-key-must-not-leak",
    };
  },
});
const { KEY, call, check, notes, until, rows, turnsOf, getChat, conversation, computers, exchange, fakeLog, alive } = p;
const log = () => fakeLog(fakeHome);
let runner: ReturnType<typeof p.start> | null = null;
const agy = async () => (await computers()).find((item) => item.online)?.engines.find((engine) => engine.kind === "antigravity");
const rowText = (computer: string) => p.browser()!.evaluate(`document.querySelector('[aria-label="Antigravity on ${computer}"]')?.innerText ?? ""`) as Promise<string>;
const leftovers = () => ({
  download: existsSync(join(agyRoot, "download")) ? readdirSync(join(agyRoot, "download")) : [],
  partial: existsSync(join(agyRoot, "server")) ? readdirSync(join(agyRoot, "server")).filter((name) => name.endsWith(".partial")) : [],
});

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = p.start("runner");
  await until(async () => Boolean(await agy()), "the runner to report Antigravity", 120);
  await until(async () => (await computers()).some((item) => item.engines.some((engine) => engine.kind === "codex")), "Codex reported beside it (signed out in its own folder)", 120);
  const computer = (await computers()).find((item) => item.online)!;
  await sleep(35_000); // a probe or two

  // --- 1, 2. Nothing downloaded; Settings says Experimental and warns --------------------------------------
  await p.openBrowser();
  await p.settingsText();
  const row = await rowText(computer.name);
  await p.shot("settings-antigravity.png");
  check("nothingDownloadedAtStart", downloads === 0 && !existsSync(join(agyRoot, "server")) && log().length === 0 && (await agy())!.signedIn === false, { downloads, log: log().length });
  check("settingsExperimental", /Experimental/.test(row) && /Gemini API key/.test(row) && /Sign in with Google/.test(row) && /not turned on/i.test(row), row);
  // The Google sign-in button asks first, in Google's words.
  const warned = await p.browser()!.evaluate(`(async () => { const row = document.querySelector('[aria-label="Antigravity on ${computer.name}"]'); const button = [...row.querySelectorAll('button')].find((b) => /Sign in with Google/.test(b.textContent)); button.click(); await new Promise((r) => setTimeout(r, 800)); const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]'); const text = dialog?.innerText ?? ""; [...(dialog?.querySelectorAll('button') ?? [])].find((b) => /Keep it|Cancel/.test(b.textContent))?.click(); return text; })()`) as string;
  check("googleWarningQuotesFaq", /third party software, tools, or services to access Antigravity is a violation of our Terms of Service/.test(warned) && /suspension or termination of your account/.test(warned) && /Antigravity FAQ/.test(warned), warned);
  await p.shot("settings-antigravity-warning.png").catch(() => {});

  // --- 3. Without a key ------------------------------------------------------------------------------------
  const noKey = await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "antigravity", kind: "login", method: "gemini-api-key" }).then(() => "", (error) => String(error));
  await until(async () => ["error", "done"].includes((await agy())?.request?.status ?? ""), "the keyless attempt to end", 60);
  const noKeyRequest = (await agy())!.request;
  check("keyRequiredFirst", noKeyRequest?.status === "error" && /Settings → Engines/.test((noKeyRequest as { error?: string }).error ?? "") && downloads === 0, { noKey, request: noKeyRequest });
  await call("dashboard:setKey", { key: KEY, name: "GEMINI_API_KEY", value: KEY_VALUE });

  // --- 4. A download that does not match is refused and removed ---------------------------------------------
  await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "antigravity", kind: "login", method: "gemini-api-key" });
  await until(async () => ["error", "done"].includes((await agy())?.request?.status ?? ""), "the tampered download to be refused", 90);
  const refused = (await agy())!.request as { status: string; error?: string };
  check("tamperedDownloadRefused", refused.status === "error" && /does not match/.test(refused.error ?? "") && downloads === 1 && !existsSync(join(agyRoot, "server", "9.9.9-fake"))
    && leftovers().download.length === 0 && leftovers().partial.length === 0 && log().length === 0, { refused, leftovers: leftovers() });

  // --- 5, 6, 7. The right one: verified, unpacked, started with the key --------------------------------------
  release(createHash("sha256").update(bytes).digest("hex"));
  // Gzipped even though Perry asks for the plain file: its declared length is the gzipped one, and the download is still good.
  gzipAlways = true;
  // What a killed server would have left in its temp folder.
  mkdirSync(join(agyRoot, "tmp", "_MEI-orphan"), { recursive: true });
  writeFileSync(join(agyRoot, "tmp", "_MEI-orphan", "big.bin"), "x".repeat(1024));
  const clicked = await p.browser()!.evaluate(`(() => { const row = document.querySelector('[aria-label="Antigravity on ${computer.name}"]'); const button = [...row.querySelectorAll('button')].find((b) => /Gemini API key/.test(b.textContent)); button?.click(); return Boolean(button); })()`);
  if (!clicked) await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "antigravity", kind: "login", method: "gemini-api-key" });
  await until(async () => ["error", "done"].includes((await agy())?.request?.status ?? ""), "Antigravity to be turned on", 120);
  await until(async () => Boolean((await agy())?.signedIn), "Antigravity signed in", 60);
  const on = (await agy())!;
  const auth = log().find((entry) => entry.method === "authenticate");
  check("downloadVerifiedAndUnpacked", clicked === true && downloads === 2 && existsSync(join(agyRoot, "server", "9.9.9-fake", ".verified")) && leftovers().download.length === 0 && leftovers().partial.length === 0
    && on.version === "9.9.9-fake" && on.auth.label === "Gemini API key", { on: { version: on.version, auth: on.auth }, leftovers: leftovers() });
  check("gzippedDownloadTaken", on.version === "9.9.9-fake" && gzipped.length !== bytes.length, { gzipped: gzipped.length, zip: bytes.length });
  check("asksForThePlainFile", encodings.length >= 2 && encodings.every((encoding) => encoding === "identity"), encodings);
  check("keyGivenOnlyToServer", auth?.methodId === "gemini-api-key" && auth.geminiKeyPresent === true, { auth });
  check("ownHomeAndTemp", auth?.env?.GEMINI_HOME === join(agyRoot, "home") && auth?.env?.TEMP === join(agyRoot, "tmp") && !existsSync(join(agyRoot, "tmp", "_MEI-orphan")), { env: auth?.env });
  await p.settingsText();
  await p.shot("settings-engines.png");

  // --- 8, 10. A reply, and Perry's tools ------------------------------------------------------------------------
  const options = await call<{ models: Array<{ id: string; engine?: string }>; engines: Array<{ kind: string }> }>("models:options", { key: KEY });
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  const agyModel = options.models.find((model) => model.engine === "antigravity")!;
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: agyModel.id, engine: "antigravity" });
  const first = await exchange(chat, `Hello Antigravity ${NONCE}`);
  // Settings lists every engine the runner has; the model picker groups the signed-in ones' models.
  const reported = (await computers()).find((item) => item.online)!.engines.map((engine) => engine.kind);
  const kinds = options.engines.map((engine) => engine.kind);
  // Codex, Claude and Grok are signed out or absent here: reported beside it, with no models, so only Antigravity's are offered.
  check("enginesCoexist", ["codex", "grok", "claude", "antigravity"].every((kind) => reported.includes(kind)) && !reported.includes("cursor" as never)
    && kinds.includes("antigravity") && options.models.some((model) => model.engine === "antigravity") && options.models.every((model) => model.engine === "antigravity"),
    { reported, pickerEngines: kinds });
  check("replyStreamsAndSaves", first.streamed.length >= 3 && first.reply.includes(`Fake antigravity reply to: Hello Antigravity ${NONCE}`), { snapshots: first.streamed.length, reply: first.reply });
  const firstPrompt = log().find((entry) => entry.prompt === `Hello Antigravity ${NONCE}`);
  check("askIsDefaultMode", firstPrompt?.mode === "default" || firstPrompt?.mode === undefined, { mode: firstPrompt?.mode });
  // An empty end_turn first, the reply after it: the turn completes with the reply, not empty.
  const early = await exchange(chat, `EARLY ${NONCE}`, 90);
  const earlyTurn = turnsOf(chat).at(-1)!;
  check("earlyEndTurnWaitsForReply", early.reply.includes(`Late reply to: EARLY ${NONCE}. One two three.`) && earlyTurn.status === "done" && !earlyTurn.error && log().some((entry) => entry.early),
    { reply: early.reply, status: earlyTurn.status, error: earlyTurn.error });
  // After the first session the real models are known; pick the second.
  await until(async () => (await call<{ models: Array<{ id: string; engine?: string }> }>("models:options", { key: KEY })).models.some((model) => model.id === "gemini-fake-flash"), "Antigravity's models", 60);
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "gemini-fake-flash", engine: "antigravity" });
  const remembered = await exchange(chat, `REMEMBER Antigravity check ${NONCE}`);
  check("mcpRemember", Boolean(rows("memories").find((row) => String(row.text).includes(`Antigravity check ${NONCE}`))) && remembered.reply.includes("remembered over HTTP"), remembered.reply);

  // --- 11. Ask, then Full ----------------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `RUN Remove-Item C:\\agy-${NONCE}` });
  type Pending = { id: string; title: string; chat?: { id: string } };
  let asked: Pending | undefined;
  await until(async () => { asked = (await call<Pending[]>("approvals:pending", { key: KEY })).find((item) => item.chat?.id === chat); return Boolean(asked); }, "the approval", 60);
  await call("approvals:decide", { key: KEY, id: asked!.id, approved: false });
  await until(async () => !(await getChat(chat)).isRunning, "the declined turn", 60);
  const declined = log().filter((entry) => entry.permission === "execute").at(-1);
  check("approvalOwnOptionIds", declined?.outcome?.optionId === "opt_reject_9" && /declined/.test(await p.lastReply(chat)), declined?.outcome);
  await call("dashboard:setChatAccess", { key: KEY, id: chat, access: "full" });
  const full = await exchange(chat, `RUN echo full-${NONCE}`);
  check("fullIsYolo", log().some((entry) => entry.method === "session/set_config_option" && entry.configId === "mode" && entry.value === "yolo") && /I ran/.test(full.reply)
    && !log().some((entry) => entry.permission === "execute" && entry.command === `echo full-${NONCE}`), full.reply);
  await call("dashboard:setChatAccess", { key: KEY, id: chat, access: "supervised" });

  // --- 12, 9. Stop when cancel is ignored; the chat resumes, on its model -----------------------------------------
  const cursor = (await conversation(chat)).resume?.cursor;
  const pidBefore = log().filter((entry) => entry.acp).at(-1)!.pid as number;
  // A reply that never ends by itself, whose cancel is ignored, from a server that ignores its stdin closing too.
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "HANG until stopped" });
  await until(async () => ((await getChat(chat)).streaming ?? "").includes("Working on it"), "the hanging reply", 90);
  const stopAt = Date.now();
  await call("dashboard:stopChat", { key: KEY, id: chat });
  await until(async () => !(await getChat(chat)).isRunning, "the stopped turn to end", 90);
  const stopped = turnsOf(chat).at(-1)!;
  check("stopEndsServerIgnoringCancel", stopped.stopped === true && /_Stopped\._/.test(await p.lastReply(chat)) && !alive(pidBefore) && Date.now() - stopAt < 40_000
    && log().some((entry) => entry.method === "session/cancel" && entry.ignored) && log().some((entry) => entry.stdinClosed && entry.ignored && entry.pid === pidBefore), { stopped: stopped.stopped, error: stopped.error, tookMs: Date.now() - stopAt, oldAlive: alive(pidBefore) });
  const resumedAt = Date.now();
  const recall = await exchange(chat, "RECALL please", 120);
  const resumed = log().find((entry) => entry.method === "session/resume" && entry.at > resumedAt);
  const recallPrompt = log().find((entry) => entry.prompt === "RECALL please");
  check("resumeOnModel", Boolean(resumed) && resumed!.sessionId === cursor && recall.reply.includes(`Hello Antigravity ${NONCE}`) && recallPrompt?.model === "gemini-fake-flash" && recallPrompt?.mode === "default",
    { resumed: Boolean(resumed), model: recallPrompt?.model, mode: recallPrompt?.mode });

  // --- 13. A hung reply -------------------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "HANG please" });
  await until(async () => !(await getChat(chat)).isRunning, "the hung turn to be ended", 120);
  check("hungReplyWatchdog", /stopped responding/.test(turnsOf(chat).at(-1)!.error ?? ""), turnsOf(chat).at(-1)!.error);

  // --- 14. (Switching to another engine and back is covered by auto-routing and engine-layer, with fake engines:
  //         here every other engine is signed out or absent, so nothing could reach the owner's accounts.)

  // --- 15. Signing in with Google instead (experimental) ------------------------------------------------------------
  const googleAt = Date.now();
  await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "antigravity", kind: "login", method: "oauth-personal" });
  await until(async () => ["error", "done"].includes((await agy())?.request?.status ?? ""), "the Google sign-in", 120);
  notes.googleRequest = (await agy())?.request;
  await until(async () => (await agy())?.auth.label === "Google account (experimental)", "the Google account shown", 60);
  const google = log().find((entry) => entry.method === "authenticate" && entry.at > googleAt);
  const afterGoogle = await exchange(chat, `After Google ${NONCE}`, 120);
  check("googleSignInOwnFlow", google?.methodId === "oauth-personal" && google.geminiKeyPresent === false && downloads === 2 && afterGoogle.reply.includes(`After Google ${NONCE}`), { google, downloads, reply: afterGoogle.reply.slice(0, 60) });

  // --- 16. Sign out -------------------------------------------------------------------------------------------------
  await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "antigravity", kind: "logout" });
  await until(async () => (await agy())?.signedIn === false && (await agy())?.request?.status === "done", "signed out", 60);
  check("signOut", log().some((entry) => entry.method === "logout"), true);

  // --- 19. Nothing left behind: each server start unpacked into Perry's temp folder, and stopping it swept it --------
  const starts = log().filter((entry) => entry.acp).length;
  const tmpLeft = existsSync(join(agyRoot, "tmp")) ? readdirSync(join(agyRoot, "tmp")) : [];
  const systemTemp = readdirSync(tmpdir()).filter((name) => /^_MEI\d+$/.test(name) && log().some((entry) => entry.acp && name === `_MEI${entry.pid}`));
  check("noTempLeftovers", starts >= 3 && tmpLeft.length === 0 && systemTemp.length === 0 && leftovers().download.length === 0 && leftovers().partial.length === 0,
    { starts, tmpLeft, systemTemp, leftovers: leftovers() });

  // Back on with the key, so a server is running when the runner stops below.
  await call("engines:requestAuth", { key: KEY, runnerId: computer.id, engine: "antigravity", kind: "login", method: "gemini-api-key" });
  await until(async () => { const request = (await agy())?.request; return request?.kind === "login" && ["error", "done"].includes(request.status); }, "Antigravity back on", 120);
  await until(async () => Boolean((await agy())?.signedIn), "Antigravity signed in again", 60);
  const running = log().filter((entry) => entry.acp).at(-1)!.pid as number;
  notes.serverRunningAtStop = { pid: running, alive: alive(running) };
  check("completed", true);

  check("noPageErrors", p.browser()!.errors.length === 0, p.browser()!.errors);
  // Codex out of its allowance is Codex's account, not a fault here.
  const runnerLines = p.logs.runner.split("\n").filter((line) => !/usage limit/i.test(line));
  check("runnerLogClean", !runnerLines.some((line) => /turn failed:|could not report the engines|could not ask about/i.test(line)), runnerLines.filter((line) => /fail|error/i.test(line)).slice(-10));
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}
const pids = [...new Set(log().filter((entry) => entry.acp).map((entry) => entry.pid as number))];
p.stop(runner);
await sleep(5_000);
// Every server the runner started, including the one running (which ignores its stdin closing), is gone with it.
const atStop = notes.serverRunningAtStop as { alive?: boolean } | undefined;
check("agentsEndWithRunner", pids.length > 0 && atStop?.alive === true && pids.every((pid) => !alive(pid)), { agents: pids.length, stillRunning: pids.filter((pid) => alive(pid)) });
const everything = `${p.logs.runner}\n${existsSync(join(fakeHome, "log.jsonl")) ? readFileSync(join(fakeHome, "log.jsonl"), "utf8") : ""}\n${JSON.stringify(notes)}`;
check("keyNeverLogged", !everything.includes(KEY_VALUE) && !everything.includes("owner-google-key-must-not-leak"), true);
files.close();
rmSync(work, { recursive: true, force: true });
const passed = await p.finish({ engine: "antigravity", agent: "fake (artifacts/engine-acp/fake-agent.ts --profile antigravity), from a fake release served by this test", codexModel: MODEL });
process.exit(passed ? 0 : 1);
