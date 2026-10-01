import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { FAKE_AGENT, REPO, perry, sleep } from "../engine-acp/harness";

// bun artifacts/engine-update/run.ts <outDir>
// Updating an engine's CLI from Settings → Engines (convex/engineUpdates.ts, runner/index.ts handleUpdate,
// runner/versions.ts updatePlan). A fresh Perry from the production build (`pnpm build` first) on a spare
// port, its home, CODEX_HOME and CLAUDE_CONFIG_DIR under PERRY_E2E_DIR (W:\perry-tests\engine-update), the
// real runner, and headless Chrome clicking Update. Run it with TEMP and TMP on W: (W:\perry-tests\tmp).
//
// The CLIs are stand-ins first on the runner's PATH, shaped as the cli-versions run settled on, so the
// owner's own are neither run nor changed: codex.cmd beside an npm node_modules (updated by a stand-in
// npm.cmd), claude.cmd pointing at a readable claude-code/cli.js (as the runner reads a shim; one it
// cannot read is passed over for ~/.local/bin/claude.exe) whose `claude update` updates itself, and
// grok.cmd running the fake ACP agent from a folder this user may not write in. npm's registry is a local
// server answering @openai/codex 0.159.1, @anthropic-ai/claude-code 2.1.285 and @xai-official/grok 1.0.44.
// Before anything runs, every engine is checked to resolve to its stand-in, and the owner's own CLIs are
// fingerprinted, to be compared at the end.
//
// Ways it could fail, written down before the checks:
//   1. The update reaches the owner's own CLIs or npm: a stand-in not found first, the runner resolving
//      another copy than the one on PATH (as the earlier run's skipped .cmd did), or the update run where
//      the shell finds the real one (another folder first on PATH, cmd.exe's current folder).
//   2. Something other than the dashboard owner can start an update, or Antigravity, which Perry pins
//      itself, offers one Perry cannot do.
//   3. The Update button does nothing, or the command does not fit how the CLI was installed.
//   4. The update runs while a reply is running on that engine and cuts it off, or a new reply starts
//      on the engine during the update, on a CLI half replaced.
//   5. The wait is not said, or the update never starts once the reply ends.
//   6. No progress while it runs, or what it printed is lost or out of order.
//   7. Afterwards the old version is still reported (a version kept, the old app-server still running),
//      so "Update required" stays and the engine's replies are still refused, or the reply held for the
//      update runs on the old CLI.
//   8. A failing update is reported as done, or without what it printed; one that hangs is never
//      stopped, or its processes outlive it.
//   9. An update that needs admin rights is run anyway, or elevation is tried, instead of the command
//      being shown.
//  10. A failed or hung update leaves the engine unusable, or its replies held for good.
//  11. The pages throw.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engine-update/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const ROOT = process.env.PERRY_E2E_DIR ?? "W:\\perry-tests\\engine-update";
mkdirSync(ROOT, { recursive: true });
process.env.PERRY_E2E_DIR = ROOT;
const FAKE_CLI = join(REPO, "artifacts", "cli-versions", "fake-cli.ts");
const FAKE_NPM = join(REPO, "artifacts", "engine-update", "fake-npm.ts");
const LATEST: Record<string, string> = { "@openai/codex": "0.159.1", "@anthropic-ai/claude-code": "2.1.285", "@xai-official/grok": "1.0.44" };
const NAME = "Test PC";
const PATH_KEY = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
const ORIGINAL_PATH = process.env[PATH_KEY] ?? "";

// --- The owner's own CLIs, as they are before the run -------------------------------------------------
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** Every codex, claude, grok and npm on the owner's PATH and where their installers put them, and the global packages, by content. */
function ownCLIs(): Record<string, string> {
  const found: Record<string, string> = {};
  const dirs = [...ORIGINAL_PATH.split(delimiter).filter(Boolean), join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")];
  for (const dir of dirs) {
    for (const name of ["codex", "claude", "grok", "npm"]) {
      for (const ext of ["", ".exe", ".cmd", ".ps1"]) {
        const file = join(dir, name + ext);
        try { if (statSync(file).isFile()) found[file] = `${statSync(file).size} ${statSync(file).mtimeMs} ${sha(file)}`; } catch {}
      }
    }
  }
  const npmGlobal = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
  for (const pkg of Object.keys(LATEST)) {
    const file = join(npmGlobal, ...pkg.split("/"), "package.json");
    if (existsSync(file)) found[file] = `${statSync(file).mtimeMs} ${sha(file)}`;
  }
  const versions = join(homedir(), ".local", "share", "claude", "versions");
  if (existsSync(versions)) found[versions] = readdirSync(versions).sort().join(",");
  return found;
}
const ownBefore = ownCLIs();

// --- npm's registry -----------------------------------------------------------------------------------
const registry = createServer((request, response) => {
  const name = decodeURIComponent(request.url ?? "").replace(/^\/|\/latest$/g, "");
  if (!LATEST[name]) { response.writeHead(404).end("{}"); return; }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name, version: LATEST[name] }));
});
await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
const REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;

// --- The stand-ins, first on PATH -------------------------------------------------------------------------
const root = mkdtempSync(join(ROOT, "run-"));
const bin = join(root, "bin");
const locked = join(root, "locked");
const state = join(root, "state");
const acpHome = join(root, "fake-grok");
const npmPrefix = join(root, "npm-prefix-never-used");
const codexHome = join(root, "codex-home");
const claudeConfig = join(root, "claude-config");
for (const dir of [bin, locked, state, acpHome, codexHome, claudeConfig, join(bin, "node_modules", "@openai", "codex"), join(bin, "claude-code")]) mkdirSync(dir, { recursive: true });
// Codex as npm installs it on Windows: a shim beside node_modules, so its update is npm's.
writeFileSync(join(bin, "node_modules", "@openai", "codex", "package.json"), JSON.stringify({ name: "@openai/codex", version: "fake" }));
writeFileSync(join(bin, "codex.cmd"), `@"${process.execPath}" "${FAKE_CLI}" codex %*\r\n`);
writeFileSync(join(bin, "npm.cmd"), `@"${process.execPath}" "${FAKE_NPM}" %*\r\n`);
// Claude Code as its native installer leaves it, through a shim the runner can read.
writeFileSync(join(bin, "claude-code", "cli.js"), `const { spawnSync } = require("node:child_process");
const ran = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE_CLI)}, "claude", ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
process.exit(ran.status ?? 1);
`);
writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "%~dp0\\claude-code\\cli.js" %*\r\n`);
// Grok Build in a folder this user may not write in, as one installed for all users would be.
writeFileSync(join(locked, "grok.cmd"), `@"${process.execPath}" "${FAKE_AGENT}" --profile grok %*\r\n`);
writeFileSync(join(acpHome, "grok-signed-in"), "");
const account = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${userInfo().username}`;
const icacls = (...args: string[]) => spawnSync("icacls", [locked, ...args], { encoding: "utf8", windowsHide: true });
const denied = icacls("/deny", `${account}:(WD,AD)`);
const setState = (name: string, value: string) => writeFileSync(join(state, name), value);
setState("codex-version", "0.150.0");
setState("codex-latest", LATEST["@openai/codex"]);
setState("claude-version", "2.1.100");
setState("claude-latest", LATEST["@anthropic-ai/claude-code"]);
const RUNNER_PATH = `${bin}${delimiter}${locked}${delimiter}${ORIGINAL_PATH}`;
const fakeLog = (dir = state): Array<Record<string, any>> => existsSync(join(dir, "log.jsonl"))
  ? readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

const p = await perry({
  name: "engine-update",
  outDir,
  runnerEnv: () => ({
    [PATH_KEY]: RUNNER_PATH,
    PERRY_NPM_REGISTRY: REGISTRY,
    FAKE_CLI_HOME: state,
    FAKE_ACP_HOME: acpHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    // Were the real npm ever reached, it would install nowhere that matters, from a registry with no packages.
    npm_config_prefix: npmPrefix,
    npm_config_registry: REGISTRY,
    PERRY_ENGINE_UPDATE_MS: "20000",
  }),
});
const { KEY, BASE, call, check, notes, until, turnsOf, rows, alive } = p;
// The computer's name on the page, rather than this machine's.
writeFileSync(join(p.home, "runner.json"), JSON.stringify({ name: NAME }));

type Updating = { status: string; command?: string; waitingFor?: string; from?: string; to?: string; output?: string; error?: string; finishedAt?: number };
type Engine = { kind: string; label: string; installed: boolean; signedIn: boolean; version?: string; update?: { need: string; version: string; latest?: string; command: string }; updating?: Updating };
const engines = async () => {
  const computer = (await call<Array<{ id: string; name: string; online: boolean; engines: Engine[] }>>("engines:list", { key: KEY })).find((item) => item.online);
  return { id: computer?.id ?? "", all: Object.fromEntries((computer?.engines ?? []).map((engine) => [engine.kind, engine])) as Record<string, Engine> };
};
const lastRun = async (chat: string) => (await call<Array<{ status: string; error?: string }>>("dashboard:listRuns", { key: KEY, conversationId: chat }))[0];
const shots: string[] = [];

let runner: ReturnType<typeof p.start> | null = null;
try {
  // --- 1. Every engine resolves to its stand-in, before anything runs ------------------------------------
  check("lockedFolderDenied", denied.status === 0, denied.stdout.trim() || denied.stderr.trim());
  const where = (name: string) => spawnSync("where.exe", [name], { encoding: "utf8", env: { ...process.env, [PATH_KEY]: RUNNER_PATH }, cwd: root, windowsHide: true }).stdout.trim().split(/\r?\n/)[0];
  const firsts = { codex: where("codex"), npm: where("npm"), claude: where("claude"), grok: where("grok") };
  process.env[PATH_KEY] = RUNNER_PATH;
  const { findClaude } = await import("../../runner/engines/claude");
  const { updatePlan } = await import("../../runner/versions");
  const claudeFound = findClaude();
  const plans = { codex: updatePlan("codex", "codex"), claude: updatePlan("claude", claudeFound?.file ?? "claude"), grok: updatePlan("grok", "grok") };
  process.env[PATH_KEY] = ORIGINAL_PATH;
  const resolved = firsts.codex === join(bin, "codex.cmd") && firsts.npm === join(bin, "npm.cmd") && firsts.claude === join(bin, "claude.cmd") && firsts.grok === join(locked, "grok.cmd")
    && claudeFound?.file === join(bin, "claude.cmd") && claudeFound.sdkPath === join(bin, "claude-code", "cli.js")
    && plans.codex?.command === "npm install -g @openai/codex@latest" && plans.codex.folder === bin && plans.codex.locked.length === 0
    && plans.claude?.command === "claude update" && plans.claude.folder === bin && plans.claude.locked.length === 0
    && plans.grok?.command === "grok update" && plans.grok.folder === locked && plans.grok.locked.includes(locked);
  check("everyEngineResolvesToItsStandIn", resolved, { firsts, claude: claudeFound, plans });
  if (!resolved) throw new Error("an engine did not resolve to its stand-in; stopping before anything runs");

  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  runner = p.start("runner");
  await until(async () => { const { all } = await engines(); return Boolean(all.codex?.update?.latest && all.claude?.update?.latest && all.grok?.update?.latest); }, "the runner to report the three engines with the newest releases", 120);
  const start = (await engines()).all;
  const standIns = start.codex.version === "0.150.0" && start.claude.version === "2.1.100" && start.grok.version === "1.0.42-fake";
  check("runnerReportsTheStandIns", standIns && start.codex.update?.need === "available" && start.claude.update?.need === "required" && start.grok.update?.need === "available",
    { codex: start.codex.update, claude: start.claude.update, grok: start.grok.update });
  if (!standIns) throw new Error("the runner reported other CLIs than the stand-ins; stopping");

  // --- 2. Only the dashboard's owner, and not Antigravity --------------------------------------------------
  const { id: runnerId } = await engines();
  const stranger = await call("engineUpdates:request", { key: "not-the-dashboard-key", runnerId, engine: "codex" }).then(() => "accepted", (error: Error) => error.message);
  const antigravity = await call("engineUpdates:request", { key: KEY, runnerId, engine: "antigravity" }).then(() => "accepted", (error: Error) => error.message);
  check("onlyTheOwner", stranger !== "accepted" && rows("engineUpdates").length === 0, stranger);
  check("antigravityComesWithPerry", /comes with Perry/.test(antigravity), antigravity);

  // --- 3. Settings: an Update button on each engine that needs one ------------------------------------------
  await p.openBrowser();
  const browser = p.browser()!;
  await p.settingsText();
  const rowText = (label: string) => browser.evaluate(`document.querySelector('[aria-label="${label} on ${NAME}"]')?.innerText ?? ""`) as Promise<string>;
  const buttons = (label: string) => browser.evaluate(`[...(document.querySelector('[aria-label="${label} on ${NAME}"]')?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).filter(Boolean)`) as Promise<string[]>;
  const click = (label: string, text: string) => browser.evaluate(`(() => { const button = [...(document.querySelector('[aria-label="${label} on ${NAME}"]')?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) return false; button.click(); return true; })()`) as Promise<boolean>;
  const shot = async (name: string, label: string) => {
    await browser.evaluate(`document.querySelector('[aria-label="${label} on ${NAME}"]')?.scrollIntoView({ block: "center" }); true`);
    await sleep(300);
    const image = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
    shots.push(name);
  };
  const antigravityRow = await rowText("Antigravity");
  check("updateButtons", (await buttons("Codex")).includes("Update") && (await buttons("Claude Code")).includes("Update") && (await buttons("Grok Build")).includes("Update")
    && !(await buttons("Antigravity")).includes("Update"),
    { codex: await buttons("Codex"), claude: await buttons("Claude Code"), grok: await buttons("Grok Build"), antigravity: antigravityRow ? await buttons("Antigravity") : "not listed" });
  await shot("before.png", "Codex");

  // --- 4, 5. Codex: asked for mid-reply, it waits; the next reply waits for it --------------------------------
  const busyChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: busyChat, text: "SLOW 20 a long reply" });
  await until(() => turnsOf(busyChat).some((turn) => turn.status === "running") && fakeLog().some((entry) => entry.turn?.startsWith("SLOW 20")), "the slow reply to be running", 60);
  const clicked = await click("Codex", "Update");
  await until(async () => (await engines()).all.codex.updating?.status === "waiting" && Boolean((await engines()).all.codex.updating?.waitingFor), "the update to wait", 30);
  const heldChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: heldChat, text: "Hello after the update" });
  await until(async () => (await rowText("Codex")).includes("It starts once"), "the wait on the page", 15);
  await sleep(3_000);
  await shot("waiting.png", "Codex");
  const waitingText = await rowText("Codex");
  const npmWhileBusy = fakeLog().filter((entry) => entry.cli === "npm").length;
  const heldStatus = turnsOf(heldChat).map((turn) => turn.status);
  check("waitsForTheReply", clicked && npmWhileBusy === 0 && /It starts once a reply on Codex is done/.test(waitingText) && turnsOf(busyChat).some((turn) => turn.status === "running"),
    { waitingText, npmWhileBusy });
  check("newReplyHeld", heldStatus.length === 1 && heldStatus[0] === "queued" && !fakeLog().some((entry) => entry.turn === "Hello after the update"), heldStatus);

  await until(async () => (await engines()).all.codex.updating?.status === "running" && /npm http fetch/.test((await engines()).all.codex.updating?.output ?? ""), "the update to run", 60);
  await until(async () => /npm http fetch/.test(await rowText("Codex")), "its output on the page", 10);
  await shot("updating.png", "Codex");
  const progressText = await rowText("Codex");
  check("progressShown", progressText.includes("Updating Codex…") && progressText.includes("Running npm install -g @openai/codex@latest") && progressText.includes("npm http fetch"), progressText);

  await until(async () => (await engines()).all.codex.updating?.status === "done", "the Codex update to finish", 60);
  await until(async () => (await rowText("Codex")).includes("Updated Codex"), "the result on the page", 15);
  await shot("updated.png", "Codex");
  const codexAfter = (await engines()).all.codex;
  const log = fakeLog();
  const slowEnded = log.find((entry) => entry.turnEnded?.startsWith("SLOW 20"))?.at ?? Infinity;
  const npmStarted = log.find((entry) => entry.cli === "npm")?.at ?? 0;
  check("availableUpdated", codexAfter.version === "0.159.1" && !codexAfter.update && codexAfter.updating?.from === "0.150.0" && codexAfter.updating?.to === "0.159.1"
    && (await rowText("Codex")).includes("Updated Codex from 0.150.0 to 0.159.1"),
    { version: codexAfter.version, update: codexAfter.update ?? null, updating: { ...codexAfter.updating, output: undefined } });
  check("ranAfterTheReply", npmStarted > slowEnded && (await p.lastReply(busyChat)).startsWith("Fake Codex 0.150.0 reply to: SLOW 20"),
    { slowEnded, npmStarted, reply: await p.lastReply(busyChat) });
  await until(async () => (await p.lastReply(heldChat)).startsWith("Fake Codex"), "the held reply", 60);
  check("heldReplyRanOnTheNewCodex", (await p.lastReply(heldChat)) === "Fake Codex 0.159.1 reply to: Hello after the update", await p.lastReply(heldChat));
  check("npmCommandFitsTheInstall", log.filter((entry) => entry.cli === "npm").map((entry) => entry.args.join(" ")).join("|") === "install -g @openai/codex@latest",
    log.filter((entry) => entry.cli === "npm").map((entry) => entry.args));

  // --- 7, 8, 10. Claude Code, too old: refused; a hang is stopped, a failure says what it said; then it works -----
  const claudeChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: claudeChat, model: "sonnet", engine: "claude" });
  await call("dashboard:sendChat", { key: KEY, id: claudeChat, text: "Hello Claude" });
  await until(async () => (await lastRun(claudeChat))?.status === "error", "the Claude message to be refused", 60);
  const refused = (await lastRun(claudeChat)).error ?? "";
  check("claudeRefusedBefore", refused.startsWith("Claude Code 2.1.100 on Test PC is too old for Perry") && turnsOf(claudeChat).length === 0, refused);

  setState("claude-update", "hang");
  check("claudeUpdateClicked", await click("Claude Code", "Update"));
  await until(async () => (await engines()).all.claude.updating?.status === "error", "the hung update to be stopped", 60);
  const hung = (await engines()).all.claude.updating!;
  const hungPids = fakeLog().filter((entry) => entry.cli === "claude" && entry.update === "hang").map((entry) => entry.pid as number);
  await sleep(2_000);
  check("hangStopped", hung.error === "It didn't finish within 20 seconds, so Perry stopped it." && /Checking for updates/.test(hung.output ?? "") && hungPids.length === 1 && !alive(hungPids[0])
    && (await engines()).all.claude.version === "2.1.100" && (await engines()).all.claude.installed,
    { error: hung.error, output: hung.output, hungPids, alive: hungPids.map(alive) });

  setState("claude-update", "fail");
  await until(() => click("Claude Code", "Try again"), "Try again", 15);
  await until(async () => (await engines()).all.claude.updating?.status === "error" && /EBUSY/.test((await engines()).all.claude.updating?.output ?? ""), "the failing update", 60);
  await until(async () => (await rowText("Claude Code")).includes("It stopped with exit code 1"), "the failure on the page", 15);
  await click("Claude Code", "What it said");
  await sleep(500);
  await shot("failed.png", "Claude Code");
  const failedText = await rowText("Claude Code");
  check("failureShowsOutput", failedText.includes("The update didn't work. It stopped with exit code 1.") && failedText.includes("EBUSY: resource busy or locked")
    && failedText.includes("Update required") && (await buttons("Claude Code")).includes("Try again"), failedText);

  setState("claude-update", "ok");
  await click("Claude Code", "Try again");
  await until(async () => (await engines()).all.claude.updating?.status === "done", "the Claude Code update to work", 60);
  await until(async () => (await rowText("Claude Code")).includes("Updated Claude Code"), "the result on the page", 15);
  await shot("required-lifted.png", "Claude Code");
  const claudeAfter = (await engines()).all.claude;
  const liftedText = await rowText("Claude Code");
  const signIn = await call("engines:requestAuth", { key: KEY, runnerId, engine: "claude", kind: "login" }).then(() => "accepted", (error: Error) => error.message);
  await call("dashboard:sendChat", { key: KEY, id: claudeChat, text: "Hello again, Claude" });
  await until(() => turnsOf(claudeChat).length > 0, "the Claude message to be taken", 30);
  check("requiredLifted", claudeAfter.version === "2.1.285" && !claudeAfter.update && !liftedText.includes("Update required") && liftedText.includes("Updated Claude Code from 2.1.100 to 2.1.285")
    && signIn === "accepted" && turnsOf(claudeChat).length === 1,
    { version: claudeAfter.version, update: claudeAfter.update ?? null, signIn, turns: turnsOf(claudeChat).map((turn) => turn.status) });

  // --- 9. Grok Build, in a folder that needs admin rights: the command, not run ------------------------------
  check("grokUpdateClicked", await click("Grok Build", "Update"));
  await until(async () => (await engines()).all.grok.updating?.status === "elevate", "Grok's update to be left to the owner", 30);
  await until(async () => (await rowText("Grok Build")).includes("administrator rights"), "the command on the page", 15);
  await shot("elevate.png", "Grok Build");
  const grok = (await engines()).all.grok;
  const elevateText = await rowText("Grok Build");
  const grokRan = fakeLog(acpHome).filter((entry) => JSON.stringify(entry).includes("update"));
  check("elevationShowsTheCommand", grok.updating?.command === "grok update" && elevateText.includes("needs administrator rights") && elevateText.includes("Run this yourself on Test PC, in a terminal with those rights")
    && elevateText.includes("grok update") && !(await buttons("Grok Build")).includes("Update") && grokRan.length === 0 && grok.version === "1.0.42-fake",
    { elevateText, updating: grok.updating, grokRan });

  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  p.checks.completed = false;
}
p.stop(runner);
registry.close();
try { notes.updates = rows("engineUpdates").map(({ engine, status, command, from, to, error }) => ({ engine, status, command, from, to, error })); } catch {}
notes.standInLog = fakeLog().filter((entry) => entry.cli === "npm" || entry.update || entry.turn).map(({ at, cli, version, args, update, turn, mode }) => ({ at, cli, version, args, update, turn, mode }));
notes.screenshots = shots;
icacls("/remove:d", account);
// --- No real CLI touched -----------------------------------------------------------------------------------
const ownAfter = ownCLIs();
check("noRealCliTouched", JSON.stringify(ownAfter) === JSON.stringify(ownBefore) && !existsSync(npmPrefix),
  { files: Object.keys(ownBefore).length, changed: Object.keys({ ...ownBefore, ...ownAfter }).filter((file) => ownBefore[file] !== ownAfter[file]), npmPrefixUsed: existsSync(npmPrefix) });
const passed = await p.finish({ latest: LATEST });
try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
process.exit(passed ? 0 : 1);
