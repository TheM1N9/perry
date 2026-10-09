import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { FAKE_AGENT, REPO, perry, sleep } from "../engine-acp/harness";

// bun artifacts/cli-versions/run.ts <outDir>
// Each engine's CLI against the newest release and the minimum Perry works with
// (convex/lib/engines.ts, runner/versions.ts). A fresh Perry from the production
// build (`pnpm build` first) on a spare port with a temp PERRY_HOME, the real
// runner, and headless Chrome for Settings, a chat and the pet. The CLIs are
// stand-ins first on the runner's PATH, so the owner's own are neither run nor
// changed: codex.cmd and claude.cmd run fake-cli.ts at a version this run
// writes (Codex beside an npm node_modules, as npm installs it; Claude Code as
// its native installer does), and grok.cmd runs the fake ACP agent
// (artifacts/engine-acp). npm's registry is a local server this run turns
// down, hangs or answers with @openai/codex 0.159.1, @anthropic-ai/claude-code
// 2.1.285 and @xai-official/grok 1.0.44.
//
// Ways it could fail, written down before the checks:
//   1. A version is misread or compared as text (0.99 above 0.136), so an old
//      CLI passes or a current one is refused.
//   2. Offline, the look-up breaks the engines' report, or a CLI too old for
//      Perry is let through because nothing could be looked up.
//   3. A registry that hangs holds up the engines' report or a reply.
//   4. The newest releases are not kept in Perry's home, or are looked up at
//      every probe.
//   5. The update command does not fit how the CLI was installed: npm's shim
//      folder not seen as npm, a native install given npm's command.
//   6. Settings does not say which engine must be updated and which only could
//      be, with the command; or an engine too old can still be signed in.
//   7. A message on an engine too old is queued and runs, failing half-way, or
//      its refusal does not reach the dashboard's chat, the pet, or fit what
//      the phone is sent (300 characters) with the command in it.
//   8. After the owner updates, Perry goes on refusing (the old app-server or
//      the old version kept) instead of noticing within a probe or two.
//   9. An engine only behind the newest release is refused, or its reply breaks.
//  10. perry doctor does not fail on a CLI too old or warn on one behind;
//      perry setup goes on with a Codex too old, or says nothing of a newer one.
//  11. The pages throw.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/cli-versions/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const FAKE_CLI = join(REPO, "artifacts", "cli-versions", "fake-cli.ts");
const LATEST = { "@openai/codex": "0.159.1", "@anthropic-ai/claude-code": "2.1.285", "@xai-official/grok": "1.0.44" } as Record<string, string>;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

// --- npm's registry, as this run wants it ----------------------------------------------------------
let mode: "down" | "hang" | "up" = "down";
const hits: Array<{ at: number; mode: string; url: string }> = [];
const hanging: ServerResponse[] = [];
const registry = createServer((request, response) => {
  hits.push({ at: Date.now(), mode, url: request.url ?? "" });
  if (mode === "down") { request.socket.destroy(); return; }
  if (mode === "hang") { hanging.push(response); return; }
  const name = decodeURIComponent(request.url ?? "").replace(/^\/|\/latest$/g, "");
  if (!LATEST[name]) { response.writeHead(404).end("{}"); return; }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name, version: LATEST[name] }));
});
await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
const REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;

// --- The stand-in CLIs, first on PATH ----------------------------------------------------------------
const root = mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), "perry-cli-versions-"));
const bin = join(root, "bin");
const state = join(root, "state");
const acpHome = join(root, "fake-grok");
for (const dir of [bin, state, acpHome, join(bin, "node_modules", "@openai", "codex")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(bin, "node_modules", "@openai", "codex", "package.json"), JSON.stringify({ name: "@openai/codex", version: "fake" }));
writeFileSync(join(bin, "codex.cmd"), `@"${process.execPath}" "${FAKE_CLI}" codex %*\r\n`);
// Shaped as the runner reads a shim (runner/engines/claude.ts, findClaude): one whose target it cannot read
// is passed over for the owner's own ~/.local/bin/claude.exe. Its cli.js sits outside node_modules, as a native install.
mkdirSync(join(bin, "claude-code"), { recursive: true });
writeFileSync(join(bin, "claude-code", "cli.js"), `const { spawnSync } = require("node:child_process");
const ran = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE_CLI)}, "claude", ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
process.exit(ran.status ?? 1);
`);
writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "%~dp0\\claude-code\\cli.js" %*\r\n`);
writeFileSync(join(bin, "grok.cmd"), `@"${process.execPath}" "${FAKE_AGENT}" --profile grok %*\r\n`);
writeFileSync(join(acpHome, "grok-signed-in"), "");
const setVersion = (cli: "codex" | "claude", version: string) => writeFileSync(join(state, `${cli}-version`), version);
setVersion("codex", "0.120.0");
setVersion("claude", "2.1.100");
const PATH_KEY = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
const onPath = { [PATH_KEY]: `${bin}${delimiter}${process.env[PATH_KEY]}` };
const fakeLog = (): Array<Record<string, any>> => existsSync(join(state, "log.jsonl"))
  ? readFileSync(join(state, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

const p = await perry({
  name: "cli-versions",
  outDir,
  runnerEnv: () => ({ ...onPath, PERRY_NPM_REGISTRY: REGISTRY, FAKE_CLI_HOME: state, FAKE_ACP_HOME: acpHome }),
});
const { KEY, BASE, call, check, notes, until, rows, turnsOf, getChat, computers, exchange } = p;
const CACHE = join(p.home, "engine-versions.json");
type Update = { need: "required" | "available"; version: string; minimum?: string; latest?: string; command: string };
type Engine = { kind: string; installed: boolean; signedIn: boolean; version?: string; update?: Update };
const enginesNow = async () => {
  const computer = (await computers()).find((item) => item.online);
  return { name: computer?.name ?? "", engines: Object.fromEntries((computer?.engines ?? []).map((engine) => [engine.kind, engine as Engine])) as Record<string, Engine> };
};
const lastRunError = async (chat: string) => (await call<Array<{ status: string; error?: string }>>("dashboard:listRuns", { key: KEY, conversationId: chat }))[0];
/** `perry doctor --machine` or `perry setup` against the stand-ins, with this run's Perry home and registry. */
const script = (name: "doctor" | "setup", cwd: string) => new Promise<{ code: number | null; output: string }>((done) => {
  // Setup checks Codex as the engine the owner chose (issue #190: it never picks one by itself).
  const env: NodeJS.ProcessEnv = { ...process.env, ...onPath, PERRY_HOME: p.home, PERRY_NPM_REGISTRY: REGISTRY, FAKE_CLI_HOME: state, FAKE_ACP_HOME: acpHome, NO_COLOR: "1", PERRY_ENGINE: "codex" };
  for (const variable of Object.keys(env)) if (variable.startsWith("TELEGRAM") || variable === "DASHBOARD_KEY") delete env[variable];
  const child = spawn(process.execPath, [join(REPO, "scripts", `${name}.ts`), ...(name === "doctor" ? ["--machine"] : [])], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk; });
  // Setup asks for a Telegram bot first: Enter skips it.
  child.stdin.end("\n");
  const timer = setTimeout(() => child.kill(), 120_000);
  child.on("close", (code) => { clearTimeout(timer); done({ code, output: strip(output) }); });
});
let runner: ReturnType<typeof p.start> | null = null;
const startRunner = () => { runner = p.start("runner"); return Date.now(); };
const restartRunner = async () => {
  p.stop(runner);
  await sleep(3_000);
  rmSync(CACHE, { force: true });
  return startRunner();
};

try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  // The owner's default engine, as the welcome page would have asked for it (issue #190).
  await call("dashboard:setDefaultEngine", { key: KEY, engine: "codex" });
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);

  // --- 1, 2. Offline: the registry refuses ------------------------------------------------------------
  let started = startRunner();
  await until(async () => { const { engines } = await enginesNow(); return Boolean(engines.codex?.version && engines.claude?.version && engines.grok?.version); }, "the runner to report the three engines", 120);
  const offlineMs = Date.now() - started;
  const offline = await enginesNow();
  // Anything but the stand-ins is the owner's own CLI: stop before a message could reach it.
  if (offline.engines.codex.version !== "0.120.0" || offline.engines.claude.version !== "2.1.100") throw new Error(`not the stand-in CLIs: codex ${offline.engines.codex.version}, claude ${offline.engines.claude.version}`);
  const cacheOffline = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
  check("offlineStillRefusesTooOld", offline.engines.codex.update?.need === "required" && offline.engines.codex.update.minimum === "0.136.0" && !offline.engines.codex.update.latest
    && offline.engines.claude.update?.need === "required" && offline.engines.claude.update.minimum === "2.1.111" && !offline.engines.grok.update
    && offline.engines.codex.version === "0.120.0" && offline.engines.claude.version === "2.1.100",
    { reportedMs: offlineMs, codex: offline.engines.codex.update, claude: offline.engines.claude.update, grok: offline.engines.grok.update ?? null });
  check("offlineLookUpRecorded", Boolean(cacheOffline) && ["codex", "claude", "grok"].every((kind) => cacheOffline[kind]?.found === false) && hits.some((hit) => hit.mode === "down"),
    { cache: cacheOffline, hits: hits.length });

  const codexChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: codexChat, text: "Hello while offline" });
  await until(async () => (await lastRunError(codexChat))?.status === "error", "the offline message to be refused", 60);
  const offlineRefusal = (await lastRunError(codexChat)).error ?? "";
  check("offlineMessageRefused", offlineRefusal === `Codex 0.120.0 on ${offline.name} is too old for Perry, which needs 0.136.0 or newer. Update it on that computer: npm install -g @openai/codex@latest`
    && turnsOf(codexChat).length === 0 && !fakeLog().some((entry) => entry.method === "turn/start"),
    { refusal: offlineRefusal, turnsQueued: turnsOf(codexChat).length });

  // --- 3. A registry that hangs holds nothing up ---------------------------------------------------------
  mode = "hang";
  started = await restartRunner();
  await until(async () => rows("runners").some((runner) => (runner.engines ?? []).some((engine: { kind: string; updatedAt: number }) => engine.kind === "grok" && engine.updatedAt > started)), "the engines reported again", 60);
  const hangReportMs = Date.now() - started;
  const grokChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: grokChat, model: "grok-fake-heavy", engine: "grok" });
  const replyStarted = Date.now();
  const grokReply = await exchange(grokChat, "Hello Grok while npm hangs");
  const replyMs = Date.now() - replyStarted;
  // The look-ups give up after 15 seconds; the report and the reply each came well before that, unanswered.
  const hungLookUps = hits.filter((hit) => hit.mode === "hang").length;
  check("hangingRegistryHoldsNothingUp", hangReportMs < 15_000 && replyMs < 15_000 && hungLookUps >= 3 && /Fake grok reply to: Hello Grok while npm hangs/.test(grokReply.reply),
    { hangReportMs, replyMs, hungLookUps, reply: grokReply.reply.slice(0, 80) });
  for (const response of hanging.splice(0)) response.destroy();

  // --- 4, 5. Online: the newest releases, and each CLI's command ------------------------------------------
  mode = "up";
  started = await restartRunner();
  await until(async () => (await enginesNow()).engines.codex?.update?.latest === "0.159.1" && (await enginesNow()).engines.grok?.update?.latest === "1.0.44", "the newest releases to be reported", 120);
  const online = await enginesNow();
  const cache = JSON.parse(readFileSync(CACHE, "utf8"));
  check("newestReleasesReported", online.engines.codex.update?.need === "required" && online.engines.codex.update.latest === "0.159.1"
    && online.engines.claude.update?.need === "required" && online.engines.claude.update.latest === "2.1.285"
    && online.engines.grok.update?.need === "available" && online.engines.grok.update.latest === "1.0.44" && online.engines.grok.update.version === "1.0.42-fake",
    { codex: online.engines.codex.update, claude: online.engines.claude.update, grok: online.engines.grok.update });
  const upHits = () => hits.filter((hit) => hit.mode === "up").length;
  const hitsThen = upHits();
  await sleep(35_000);
  check("newestReleasesKept", cache.codex?.latest === "0.159.1" && cache.claude?.latest === "2.1.285" && cache.grok?.latest === "1.0.44" && ["codex", "claude", "grok"].every((kind) => cache[kind].found === true)
    && hitsThen === 3 && upHits() === 3,
    { cache, lookUpsWhileUp: upHits() });
  check("commandFitsInstall", online.engines.codex.update?.command === "npm install -g @openai/codex@latest"
    && online.engines.claude.update?.command === "claude update" && online.engines.grok.update?.command === "grok update",
    { codex: online.engines.codex.update?.command, claude: online.engines.claude.update?.command, grok: online.engines.grok.update?.command });

  // --- 6. Settings ---------------------------------------------------------------------------------------------
  await p.openBrowser();
  const settings = await p.settingsText();
  await p.shot("settings-update-required.png");
  const signIn = await call("engines:requestAuth", { key: KEY, runnerId: (await computers())[0].id, engine: "codex", kind: "login" }).then(() => "accepted", (error: Error) => error.message);
  check("settingsSaysWhatToUpdate", settings.split("Update required").length === 3 && settings.includes("Update available")
    // Each command is folded under "Or run it yourself" since #192 (commandFitsInstall checks them); Update runs it.
    && settings.split("Or run it yourself").length === 4 && settings.split(/\nUpdate\n/).length === 4
    && settings.includes("Perry needs 0.136.0 or newer") && settings.includes("Grok Build 1.0.44 is out"),
    settings.slice(0, 1400));
  check("tooOldCannotSignIn", /Codex 0\.120\.0 on .* is too old for Perry/.test(signIn), signIn);

  // --- 7. Refused in the dashboard's chat, the pet, and what the phone gets --------------------------------------
  const browser = p.browser()!;
  await browser.send("Page.navigate", { url: `${BASE}/chat/${codexChat}` });
  await until(() => browser.evaluate(`document.body.innerText.includes("too old for Perry")`), "the refusal in the chat", 30);
  const chatText = await browser.evaluate(`document.querySelector('[role="alert"]')?.innerText ?? ""`) as string;
  const chatShot = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string };
  writeFileSync(join(outDir, "chat-refused.png"), Buffer.from(chatShot.data, "base64"));
  check("chatShowsRefusal", chatText.includes("Update it with the command below") && chatText.includes("npm install -g @openai/codex@latest"), chatText);

  const claudeChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: claudeChat, model: "sonnet", engine: "claude" });
  await call("dashboard:sendChat", { key: KEY, id: claudeChat, text: "Hello Claude" });
  await until(async () => (await lastRunError(claudeChat))?.status === "error", "the Claude message to be refused", 60);
  const claudeRefusal = (await lastRunError(claudeChat)).error ?? "";
  check("claudeRefused", claudeRefusal === `Claude Code 2.1.100 on ${online.name} is too old for Perry, which needs 2.1.111 or newer. Update it on that computer: claude update`
    && turnsOf(claudeChat).length === 0, claudeRefusal);
  check("phoneGetsAllOfIt", offlineRefusal.length <= 300 && claudeRefusal.length <= 300, { codex: offlineRefusal.length, claude: claudeRefusal.length });

  await browser.evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(codexChat)}); true`);
  await browser.send("Page.navigate", { url: `${BASE}/pet` });
  await until(() => browser.evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`), "the pet's page", 30);
  await sleep(1_500);
  // He opens on the pointer let go without dragging, so a mouse press and release, not a click event.
  const perryAt = await browser.evaluate(`(() => { const r = document.querySelector('button[aria-label^="Perry."]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number };
  for (const type of ["mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, x: perryAt.x, y: perryAt.y, button: "left", clickCount: 1 });
  await until(() => browser.evaluate(`Boolean(document.querySelector('textarea[aria-label="Message Perry"]'))`), "the pet's chat", 15);
  const petRunsBefore = (await call<unknown[]>("dashboard:listRuns", { key: KEY, conversationId: codexChat })).length;
  await browser.evaluate(`document.querySelector('textarea[aria-label="Message Perry"]').focus(); true`);
  await browser.send("Input.insertText", { text: "Hello from the pet" });
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until(async () => (await call<unknown[]>("dashboard:listRuns", { key: KEY, conversationId: codexChat })).length > petRunsBefore, "the pet's message to be refused", 60);
  await until(() => browser.evaluate(`[...document.querySelectorAll('p.text-destructive')].some((p) => p.textContent.includes("too old for Perry"))`), "the refusal in the pet", 30);
  const petText = await browser.evaluate(`[...document.querySelectorAll('p.text-destructive')].map((p) => p.textContent).join("\\n")`) as string;
  const petShot = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string };
  writeFileSync(join(outDir, "pet-refused.png"), Buffer.from(petShot.data, "base64"));
  check("petShowsRefusal", petText.includes("npm install -g @openai/codex@latest") && turnsOf(codexChat).length === 0 && !fakeLog().some((entry) => entry.method === "turn/start"),
    { petText, turnsQueued: turnsOf(codexChat).length });

  // --- 10. perry doctor and perry setup, before updating ---------------------------------------------------------
  const setupDir = join(root, "setup");
  mkdirSync(setupDir, { recursive: true });
  const doctorOld = await script("doctor", REPO);
  writeFileSync(join(outDir, "doctor-before.txt"), doctorOld.output);
  const setupOld = await script("setup", setupDir);
  writeFileSync(join(outDir, "setup-before.txt"), setupOld.output);
  check("doctorBefore", doctorOld.code === 1
    && doctorOld.output.includes("fail  codex  0.120.0 is too old for Perry, which needs 0.136.0 or newer. Update it: npm install -g @openai/codex@latest")
    && doctorOld.output.includes("fail  claude code  2.1.100 is too old for Perry, which needs 2.1.111 or newer. Update it: claude update")
    && doctorOld.output.includes("warn  grok build  1.0.42-fake; 1.0.44 is out. Update it: grok update"),
    doctorOld.output.split("\n").filter((line) => /codex|claude|grok/.test(line)));
  check("setupStopsOnTooOld", setupOld.code === 1 && setupOld.output.includes("Codex 0.120.0 is too old for Perry, which needs 0.136.0 or newer. Update it with: npm install -g @openai/codex@latest")
    && !existsSync(join(setupDir, ".env.local")), setupOld.output.trim().split("\n").slice(-4));

  // --- 8, 9. The owner updates: Codex to 0.150.0 (behind the newest), Claude Code to 2.1.285 ---------------------
  setVersion("codex", "0.150.0");
  setVersion("claude", "2.1.285");
  const updatedAt = Date.now();
  await until(async () => { const { engines } = await enginesNow(); return engines.codex?.version === "0.150.0" && engines.claude?.version === "2.1.285"; }, "the updates to be noticed", 90);
  const noticedMs = Date.now() - updatedAt;
  const updated = await enginesNow();
  check("updateNoticed", noticedMs < 70_000 && updated.engines.codex.update?.need === "available" && updated.engines.codex.update.latest === "0.159.1" && !updated.engines.claude.update,
    { noticedMs, codex: updated.engines.codex.update, claude: updated.engines.claude.update ?? null });
  const afterSettings = await p.settingsText();
  await p.shot("settings-after-update.png");
  check("settingsAfterUpdate", !afterSettings.includes("Update required") && afterSettings.split("Update available").length === 3 && afterSettings.includes("Codex 0.159.1 is out"), afterSettings.slice(0, 1200));
  const codexReply = await exchange(codexChat, "Hello after the update");
  check("replyAfterUpdate", codexReply.reply === "Fake Codex 0.150.0 reply to: Hello after the update" && fakeLog().filter((entry) => entry.method === "turn/start" && entry.version === "0.150.0").length >= 1
    && !fakeLog().some((entry) => entry.method === "turn/start" && entry.version !== "0.150.0"),
    { reply: codexReply.reply, turnsStarted: fakeLog().filter((entry) => entry.method === "turn/start").map((entry) => entry.version) });

  const doctorNew = await script("doctor", REPO);
  writeFileSync(join(outDir, "doctor-after.txt"), doctorNew.output);
  const setupNew = await script("setup", setupDir);
  writeFileSync(join(outDir, "setup-after.txt"), setupNew.output);
  check("doctorAfter", !/fail\s+(codex|claude|grok)/.test(doctorNew.output)
    && doctorNew.output.includes("warn  codex  0.150.0; 0.159.1 is out. Update it: npm install -g @openai/codex@latest")
    && doctorNew.output.includes("ok    claude code  2.1.285"),
    doctorNew.output.split("\n").filter((line) => /codex|claude|grok|problem|healthy/.test(line)));
  check("setupRecommendsNewer", setupNew.code === 0 && setupNew.output.includes("Codex 0.159.1 is out. To update: npm install -g @openai/codex@latest") && existsSync(join(setupDir, ".env.local")),
    setupNew.output.trim().split("\n").slice(-8));

  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}
p.stop(runner);
registry.close();
for (const response of hanging) response.destroy();
notes.registryLookUps = hits.map((hit) => `${hit.mode} ${hit.url}`);
const passed = await p.finish({ latest: LATEST });
try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
process.exit(passed ? 0 : 1);
