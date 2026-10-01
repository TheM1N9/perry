import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { FAKE_AGENT, REPO, perry, redact, sleep } from "../engine-acp/harness";

// bun artifacts/choose-engine/run.ts <outDir> [--setup-only]
// Issue #190: Perry never chooses its default engine for the owner. `perry setup`'s questions (scripts/setup.ts)
// with scripted answers, the engine named on the command line or through PERRY_ENGINE, and refused with neither;
// then, unless --setup-only (what CI runs on each OS, with no build and no browser), three fresh Perrys from the
// production build (`pnpm build` first) on spare ports, each with a temp PERRY_HOME, the real runner and
// headless Chrome:
//   A. a new install: nothing answers before a choice, the welcome page asks (and signs in), Settings changes it;
//   B. an install from before the choice, made by taking askEngine off a new one: it keeps Codex, written down;
//   C. the choice `perry setup` made while Perry was stopped, taken when it starts, and one made while it runs.
// Every CLI is a stand-in (fake-cli.ts for Codex, Claude Code and npm; the fake ACP agent for Grok Build) first
// on a PATH with every folder holding a real codex, claude or grok taken out, and HOME, USERPROFILE, CODEX_HOME
// and CLAUDE_CONFIG_DIR in this run's folder: nothing reaches the owner's CLIs, sign-ins or Perry. Shims for
// powershell, curl and bash only refuse, so no installer runs for real.
//
// Ways it could fail, written down before the checks:
//   1. Setup picks an engine on its own: with no flag and no one to answer it goes on with Codex (or any), or
//      writes .env.local or a choice before stopping.
//   2. A named engine is refused or misread: --engine or PERRY_ENGINE with a good name stops, a label ("Claude
//      Code") is not understood, or an unknown name is taken.
//   3. The list misreports an engine (installed or signed in when it is not, or the reverse), or its order
//      favours Codex rather than what is ready.
//   4. With exactly one engine ready it is chosen without being confirmed, is not offered first, or is taken when
//      there is no one to confirm it.
//   5. Answers piped in before their question are lost (readline drops them), so scripted answers hang or land
//      on the wrong question.
//   6. Offering to install runs a real installer, installs another engine than the one chosen, or does not find
//      the engine it just installed.
//   7. Signing in runs another CLI's sign-in, or a run with no one there waits on a sign-in nobody can finish.
//   8. The choice made with Perry stopped never reaches its server (default-engine.json not taken, or kept
//      after), or with Perry running it waits in a file instead of reaching it at once; a re-run asks again or
//      changes it.
//   9. A new install with no default starts a turn anyway, on Codex by the old fallback, for a chat or a
//      schedule, or the refusal never reaches the chat.
//  10. The welcome page does not ask, preselects with more than one ready, lets Continue go without a pick, or
//      its sign-in cannot be reached.
//  11. A turn after the choice runs on another engine; a chat started before the choice runs on Codex anyway.
//  12. Settings cannot change the default, or changing it moves a web chat already started, or new chats and
//      schedules ignore it.
//  13. An install from before loses Codex: it is asked again, its chats or a job's model move engine, or its
//      Codex thread is not resumed.
//  14. A command resolves to the owner's real codex, claude or grok, or a test Perry touches the owner's home.
//  15. The pages throw.

const argv = process.argv.slice(2);
const outDir = argv.find((arg) => !arg.startsWith("--")) ?? "";
if (!outDir) throw new Error("usage: bun artifacts/choose-engine/run.ts <outDir> [--setup-only]");
const setupOnly = argv.includes("--setup-only");
mkdirSync(outDir, { recursive: true });
const FAKE_CLI = join(REPO, "artifacts", "choose-engine", "fake-cli.ts");
// Its real path: macOS reaches its temp folder through a link, and where codex resolves is checked against it.
const ROOT = realpathSync(mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), "perry-choose-engine-")));
process.env.PERRY_E2E_DIR ??= ROOT;
const WINDOWS = process.platform === "win32";
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
const NO_ENGINE = "Perry has no default engine yet. Choose one in Settings → Engines & usage, or pick a model for this chat, then send it again.";

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
/** What setup printed, without the throwaway dashboard key it made. */
const transcript = (name: string, text: string) => writeFileSync(join(outDir, `${name}.txt`), redact(text).replace(/dashboard key: \S+/g, "dashboard key: (this run's own)"));
const tailOf = (text: string, lines = 6) => text.trim().split("\n").slice(-lines);

// --- A world of stand-in CLIs -------------------------------------------------------------------------------

type Standing = "missing" | "signed-out" | "signed-in";
type World = { root: string; bin: string; state: string; acp: string; env: Record<string, string> };
const PATH_KEY = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
const ENGINE_CLIS = ["codex", "claude", "grok"];
/** This machine's PATH without any folder that holds a real codex, claude or grok. */
const cleanPath = (process.env[PATH_KEY] ?? "").split(delimiter).filter((dir) => dir && !ENGINE_CLIS.some((name) =>
  ["", ".cmd", ".exe", ".bat", ".ps1"].some((ext) => existsSync(join(dir, name + ext))))).join(delimiter);
let worlds = 0;

/** A shim the way a CLI is installed: a .cmd on Windows, a script elsewhere, that runs `command`. */
function shim(bin: string, name: string, command: string[]) {
  if (WINDOWS) writeFileSync(join(bin, `${name}.cmd`), `@${command.map((word) => `"${word}"`).join(" ")} %*\r\n`);
  else { writeFileSync(join(bin, name), `#!/bin/sh\nexec ${command.map((word) => `"${word}"`).join(" ")} "$@"\n`); chmodSync(join(bin, name), 0o755); }
}

function world(engines: { codex?: Standing; claude?: Standing; grok?: Standing }): World {
  const root = join(ROOT, `world-${++worlds}`);
  const [bin, state, acp, home] = ["bin", "state", "acp", "home"].map((dir) => join(root, dir));
  for (const dir of [bin, state, acp, home, join(root, "perry-home"), join(home, ".codex"), join(home, ".claude")]) mkdirSync(dir, { recursive: true });
  const fake = (cli: string) => [process.execPath, FAKE_CLI, cli];
  if ((engines.codex ?? "missing") !== "missing") shim(bin, "codex", fake("codex"));
  if (engines.codex === "signed-in") writeFileSync(join(state, "codex-signed-in"), "yes");
  if ((engines.claude ?? "missing") !== "missing") {
    // Shaped as the runner reads a shim (runner/engines/claude.ts, findClaude): its target is a cli.js it can read.
    mkdirSync(join(bin, "claude-code"), { recursive: true });
    writeFileSync(join(bin, "claude-code", "cli.js"), `const { spawnSync } = require("node:child_process");
const ran = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE_CLI)}, "claude", ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
process.exit(ran.status ?? 1);
`);
    if (WINDOWS) writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "%~dp0\\claude-code\\cli.js" %*\r\n`);
    else shim(bin, "claude", [process.execPath, join(bin, "claude-code", "cli.js")]);
  }
  if (engines.claude === "signed-in") writeFileSync(join(state, "claude-signed-in"), "yes");
  if ((engines.grok ?? "missing") !== "missing") shim(bin, "grok", [process.execPath, FAKE_AGENT, "--profile", "grok"]);
  if (engines.grok === "signed-in") writeFileSync(join(acp, "grok-signed-in"), "yes");
  shim(bin, "npm", fake("npm"));
  // A real installer is never reached: these answer in its place, and refuse.
  for (const name of WINDOWS ? ["powershell"] : ["curl", "bash"]) shim(bin, name, fake("installer"));
  const env: Record<string, string> = {
    [PATH_KEY]: `${bin}${delimiter}${cleanPath}`,
    PERRY_HOME: join(root, "perry-home"),
    HOME: home, USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    FAKE_CLI_HOME: state, FAKE_CLI_BIN: bin, FAKE_ACP_HOME: acp, FAKE_ACP_LOGIN_MS: "500", FAKE_CLI_LOGIN_MS: "4000",
    // npm's registry for the newest releases: a port nothing listens on, so nothing is looked up for real.
    PERRY_NPM_REGISTRY: "http://127.0.0.1:9",
    NO_COLOR: "1",
  };
  return { root, bin, state, acp, env };
}
/** A world for a test Perry's runner: everything but PERRY_HOME, which is that Perry's own. */
const forRunner = (w: World) => { const { PERRY_HOME: _home, ...env } = w.env; return env; };

const logOf = (dir: string): Array<Record<string, any>> => existsSync(join(dir, "log.jsonl"))
  ? readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

/** Where codex, claude and grok resolve with this world's PATH: only its own stand-ins, or nowhere. */
function resolved(w: World): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const name of ENGINE_CLIS) {
    const ran = WINDOWS
      ? spawnSync("where", [name], { env: { ...process.env, ...w.env }, encoding: "utf8", windowsHide: true })
      : spawnSync("/bin/sh", ["-c", `command -v ${name} || true`], { env: { ...process.env, ...w.env }, encoding: "utf8" });
    found[name] = (ran.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return found;
}
const onlyStandIns = (w: World) => Object.values(resolved(w)).flat().every((path) => path.toLowerCase().startsWith(w.root.toLowerCase()));

/** The runner's own findClaude, with this world's PATH and home: the stand-in's cli.js, or nothing. */
function claudeFound(w: World): { sdkPath?: string } | null {
  const ran = spawnSync(process.execPath, ["-e", `const { findClaude } = await import(${JSON.stringify(join(REPO, "runner", "engines", "claude.ts"))}); console.log(JSON.stringify(findClaude() ?? null));`],
    { env: { ...process.env, ...w.env }, encoding: "utf8", windowsHide: true });
  try { return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "null"); } catch { return null; }
}

// --- perry setup ---------------------------------------------------------------------------------------------

type Ran = { code: number | null; output: string; ms: number };
type Answer = [RegExp, string | ((output: string) => string)];
/**
 * scripts/setup.ts in a folder of its own with this world, as `perry setup` runs it. Each answer is written when
 * its question shows; with allAtOnce, every answer goes in before the first question. Then stdin ends; with no
 * answers at all there is no one to ask.
 */
function setup(w: World, options: { cwd?: string; args?: string[]; env?: Record<string, string>; answers?: Answer[]; allAtOnce?: boolean } = {}): Promise<Ran> {
  const cwd = options.cwd ?? join(w.root, "checkout");
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, ...w.env, ...options.env };
  for (const name of Object.keys(env)) {
    if (/^(TELEGRAM|CONVEX)/.test(name) || name === "DASHBOARD_KEY" || name === "PERRY_PORT" || name === "ELECTRON_RUN_AS_NODE" || (name === "PERRY_ENGINE" && !options.env?.PERRY_ENGINE)) delete env[name];
  }
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(REPO, "scripts", "setup.ts"), ...(options.args ?? [])], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const answers = [...(options.answers ?? [])];
    let from = 0;
    if (options.allAtOnce) { child.stdin.end(answers.map(([, answer]) => `${typeof answer === "string" ? answer : ""}\n`).join("")); answers.length = 0; }
    else if (!answers.length) child.stdin.end();
    const answerWhenAsked = () => {
      while (answers.length && answers[0][0].test(strip(output.slice(from)))) {
        const [, answer] = answers.shift()!;
        from = output.length;
        child.stdin.write(`${typeof answer === "string" ? answer : answer(strip(output))}\n`);
        if (!answers.length) child.stdin.end();
      }
    };
    const read = (chunk: Buffer) => { output += chunk; answerWhenAsked(); };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const timer = setTimeout(() => {
      output += "\n[timed out]";
      if (WINDOWS && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else child.kill("SIGKILL");
    }, 150_000);
    child.on("close", (code) => { clearTimeout(timer); done({ code, output: strip(output), ms: Date.now() - started }); });
  });
}
const choiceFile = (home: string) => join(home, "default-engine.json");
const choiceIn = (home: string): string | undefined => existsSync(choiceFile(home)) ? JSON.parse(readFileSync(choiceFile(home), "utf8")).engine : undefined;
const envWritten = (w: World) => existsSync(join(w.root, "checkout", ".env.local"));
/** The list as setup shows it: "    3  Codex        0.177.7, signed in with ChatGPT Plus". */
const listOf = (output: string) => [...output.matchAll(/^ {4}(\d+) {2}(\S.*?) {2,}(\S.*)$/gm)].map((match) => ({ n: match[1], engine: match[2].trim(), standing: match[3].trim() }));
const numberOf = (output: string, engine: string) => listOf(output).find((item) => item.engine === engine)?.n ?? "";

/** The test Perrys' homes: each names its own wake timer (server/wake.ts), taken away at the end if one is left. */
const testHomes: string[] = [];

/** What `perry setup` chose with Perry stopped, kept for the third Perry to take. */
let chosenWhileStopped: { home: string; engine?: string } | undefined;

async function terminal() {
  // --- 1, 14. No flag and no one to answer: it stops, and writes nothing ----------------------------------------
  const two = world({ codex: "signed-in", claude: "signed-in" });
  const refused = await setup(two);
  transcript("setup-refused", refused.output);
  check("refusesWithoutChoice", refused.code === 1 && refused.output.includes("there is no one here to answer") && refused.output.includes("--engine <codex|claude|grok|antigravity>")
    && !envWritten(two) && choiceIn(two.env.PERRY_HOME) === undefined && !/default engine (Codex|Claude Code|Grok Build|Antigravity)/.test(refused.output)
    && !logOf(two.state).some((entry) => entry.cli === "npm" || entry.cli === "installer" || (entry.args ?? []).includes("login") && (entry.args ?? [])[1] !== "status"),
    tailOf(refused.output));
  const claude = claudeFound(two);
  check("isolated", onlyStandIns(two) && Boolean(claude?.sdkPath?.toLowerCase().startsWith(two.root.toLowerCase()))
    && /Codex\s+0\.177\.7, signed in/.test(refused.output) && /Claude Code\s+2\.1\.277, signed in/.test(refused.output),
    { resolved: resolved(two), claude });

  // --- 4. One ready: offered first, but taken only when someone confirms it --------------------------------------
  const one = world({ codex: "signed-in", claude: "signed-out" });
  const alone = await setup(one);
  transcript("setup-one-ready-no-one-there", alone.output);
  check("oneReadyNotTakenUnconfirmed", alone.code === 1 && alone.output.includes("Enter for Codex") && !envWritten(one) && choiceIn(one.env.PERRY_HOME) === undefined, tailOf(alone.output, 4));

  // --- 2. A name that is not an engine; the flag; a label through PERRY_ENGINE -----------------------------------
  const unknown = await setup(one, { args: ["--engine", "gemini"] });
  check("unknownEngineRefused", unknown.code === 1 && unknown.output.includes(`"gemini" is not an engine Perry runs`) && !envWritten(one), tailOf(unknown.output, 2));

  const grokOnly = world({ grok: "signed-in" });
  const flagged = await setup(grokOnly, { args: ["--engine", "grok"] });
  transcript("setup-flag", flagged.output);
  check("flagChoosesWithoutAsking", flagged.code === 0 && !flagged.output.includes("Which should Perry use") && /default engine Grok Build, 1\.0\.42-fake, signed in/.test(flagged.output)
    && envWritten(grokOnly) && choiceIn(grokOnly.env.PERRY_HOME) === "grok", tailOf(flagged.output, 4));

  const claudeOut = world({ claude: "signed-out" });
  const byEnv = await setup(claudeOut, { env: { PERRY_ENGINE: "Claude Code" } });
  transcript("setup-env", byEnv.output);
  check("envLabelChoosesNoSignInAlone", byEnv.code === 0 && choiceIn(claudeOut.env.PERRY_HOME) === "claude" && byEnv.output.includes("Claude Code isn't signed in, so Perry can't answer yet")
    && !logOf(claudeOut.state).some((entry) => entry.cli === "claude" && entry.args?.[0] === "auth" && entry.args?.[1] === "login"),
    tailOf(byEnv.output, 4));

  // --- 3, 6, 7. Asked: the list, then the one chosen installed and signed in ---------------------------------------
  const fresh = world({ claude: "signed-out", grok: "signed-in" });
  const asked = await setup(fresh, {
    answers: [
      [/Bot token, or Enter to skip: $/, ""],
      [/Which should Perry use by default\? \[[^\]]+\] $/, (output) => numberOf(output, "Codex")],
      [/Install it now\? It runs: .* \[Y\/n\] $/, "y"],
      [/Sign in now\? \[Y\/n\] $/, ""],
    ],
  });
  transcript("setup-asked", asked.output);
  const list = listOf(asked.output);
  const npm = logOf(fresh.state).filter((entry) => entry.cli === "npm");
  check("listSaysHowEachStands", list.map((item) => item.engine).join(",") === "Grok Build,Antigravity,Claude Code,Codex"
    && /^1\.0\.42-fake, signed in with Grok account/.test(list[0]?.standing ?? "") && list[1]?.standing.startsWith("experimental, not turned on")
    && list[2]?.standing === "2.1.277, not signed in" && list[3]?.standing === "not installed"
    && asked.output.includes("[1-4, Enter for Grok Build]"), list);
  check("installsTheChosenOne", asked.code === 0 && npm.some((entry) => entry.args.join(" ") === "install -g @openai/codex")
    && !logOf(fresh.state).some((entry) => entry.cli === "installer") && existsSync(join(fresh.bin, WINDOWS ? "codex.cmd" : "codex")),
    { npm: npm.map((entry) => entry.args.join(" ")) });
  const logins = logOf(fresh.state).filter((entry) => (entry.args ?? [])[0] === "login" && (entry.args ?? [])[1] !== "status");
  check("signsInToTheChosenOne", asked.code === 0 && logins.length >= 1 && logins.every((entry) => entry.cli === "codex")
    && /default engine Codex, 0\.177\.7, signed in with ChatGPT Plus/.test(asked.output) && choiceIn(fresh.env.PERRY_HOME) === "codex" && envWritten(fresh),
    { logins: logins.map((entry) => `${entry.cli} ${entry.args.join(" ")}`), last: tailOf(asked.output, 4) });
  chosenWhileStopped = { home: fresh.env.PERRY_HOME, engine: choiceIn(fresh.env.PERRY_HOME) };

  // --- 8. Run again with Perry still stopped: the choice waiting for it is kept, nothing asked -----------------------
  const again = await setup(fresh);
  check("rerunKeepsChoice", again.code === 0 && !again.output.includes("Which should Perry use") && again.output.includes("default engine Codex") && choiceIn(fresh.env.PERRY_HOME) === "codex", tailOf(again.output, 3));

  // --- 4, 5. Enter takes the one ready engine; answers piped before their questions are kept -----------------------
  const enter = world({ codex: "signed-out", grok: "signed-in" });
  const confirmed = await setup(enter, { answers: [[/Bot token, or Enter to skip: $/, ""], [/Which should Perry use by default\? \[[^\]]+\] $/, ""]] });
  transcript("setup-enter", confirmed.output);
  check("enterConfirmsTheOneReady", confirmed.code === 0 && confirmed.output.includes("Enter for Grok Build") && choiceIn(enter.env.PERRY_HOME) === "grok", tailOf(confirmed.output, 3));
  const piped = world({ codex: "signed-out", grok: "signed-in" });
  const atOnce = await setup(piped, { answers: [[/x/, ""], [/x/, "2"], [/x/, "n"]], allAtOnce: true });
  transcript("setup-piped", atOnce.output);
  const second = listOf(atOnce.output).find((item) => item.n === "2")?.engine;
  check("pipedAnswersKept", atOnce.code === 0 && second === "Antigravity" && choiceIn(piped.env.PERRY_HOME) === "antigravity" && atOnce.output.includes("Antigravity is turned on in Settings"),
    { second, last: tailOf(atOnce.output, 4) });
  check("setupInstalledNothingForReal", [two, one, grokOnly, claudeOut, fresh, enter, piped].every((w) => !logOf(w.state).some((entry) => entry.cli === "installer")));
}

// --- The dashboard ---------------------------------------------------------------------------------------------

/** This computer's name, as Settings shows it, never in a picture: THIS-PC instead. */
const maskHost = `(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.split(${JSON.stringify(hostname())}).join("THIS-PC"); return true; })()`;
type Shooter = { browser(): { evaluate(expression: string): Promise<unknown> } | null; shot(name: string, selector?: string): Promise<void> };
const shoot = async (p: Shooter, name: string, selector?: string) => { await p.browser()?.evaluate(maskHost); await p.shot(name, selector); };

/** Click the element a selector names, in the page. */
const click = (selector: string) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`;
const clickText = (tag: string, text: string) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(tag)})].find((item) => item.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`;

async function dashboard() {
  // --- A. A new install ------------------------------------------------------------------------------------------
  const runnerWorld = world({ codex: "signed-out", claude: "signed-out", grok: "signed-in" });
  const a = await perry({ name: "choose-engine", outDir, runnerEnv: () => forRunner(runnerWorld) });
  testHomes.push(a.home);
  const stops: Array<() => void> = [];
  try {
    const server = a.start("server");
    stops.push(() => a.stop(server));
    await a.until(() => fetch(`${a.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
    await a.call("wake:set", { key: a.KEY, enabled: false });
    const install = await a.call<Record<string, unknown> | null>("installation:get");
    const before = await a.call<string | null>("dashboard:getDefaultEngine", { key: a.KEY });
    check("newInstallHasNoDefault", before === null && install?.askEngine === true && !install?.defaultEngine, install);

    const runner = a.start("runner");
    stops.push(() => a.stop(runner));
    await a.until(async () => {
      const engines = (await a.computers()).find((computer) => computer.online)?.engines ?? [];
      return ["codex", "claude", "grok", "antigravity"].every((kind) => engines.some((engine) => engine.kind === kind && (kind === "antigravity" || engine.version)));
    }, "the runner to report its engines", 120);
    const reported = Object.fromEntries(((await a.computers()).find((computer) => computer.online)?.engines ?? []).map((engine) => [engine.kind, engine]));
    check("runnerOnStandIns", onlyStandIns(runnerWorld) && reported.codex.version === "0.177.7" && !reported.codex.signedIn && reported.claude.version === "2.1.277" && !reported.claude.signedIn
      && reported.grok.version === "1.0.42-fake" && reported.grok.signedIn, Object.fromEntries(Object.entries(reported).map(([kind, engine]) => [kind, { version: engine.version, signedIn: engine.signedIn }])));

    // 9. Nothing answers before a choice: not a chat, not a schedule.
    const early = await a.call<string>("dashboard:createChat", { key: a.KEY });
    await a.call("dashboard:sendChat", { key: a.KEY, id: early, text: "Hello before choosing" });
    await a.until(async () => (await a.runsOf(early))[0]?.status === "error", "the message to be refused", 60);
    type Job = { id: string; builtin?: string; chatId?: string };
    let heartbeat: Job | undefined;
    await a.until(async () => Boolean(heartbeat = (await a.call<Job[]>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
    if (heartbeat) await a.call("jobs:runNow", { key: a.KEY, id: heartbeat.id });
    let heartbeatChat: string | undefined;
    if (heartbeat) await a.until(async () => Boolean(heartbeatChat = (await a.call<Job[]>("jobs:list")).find((job) => job.id === heartbeat!.id)?.chatId), "the schedule's chat", 60);
    if (heartbeatChat) await a.until(async () => (await a.runsOf(heartbeatChat!))[0]?.status === "error", "the schedule to be refused", 60);
    const earlyRun = (await a.runsOf(early))[0] as { status: string; error?: string; model?: string };
    const turnsBefore = a.rows("codexTurns");
    check("noTurnWithoutChoice", earlyRun.error === NO_ENGINE && earlyRun.model === "no engine" && turnsBefore.length === 0
      && !logOf(runnerWorld.state).some((entry) => entry.method === "turn/start") && !logOf(runnerWorld.acp).some((entry) => entry.prompt !== undefined)
      && Boolean(heartbeatChat) && (await a.runsOf(heartbeatChat!))[0]?.status === "error",
      { earlyRun, turns: turnsBefore.length, heartbeatChat: heartbeatChat ? (await a.runsOf(heartbeatChat))[0] : null });

    // 10. The welcome page asks first.
    const browser = await a.openBrowser();
    await browser.send("Page.navigate", { url: `${a.BASE}/chat/${early}` });
    await a.until(() => browser.evaluate(`document.body.innerText.includes("Choose the engine")`), "the chat to ask for an engine", 30);
    const chatAsks = await browser.evaluate(`[...document.querySelectorAll('[role="alert"]')].map((el) => el.innerText).join("\\n")`) as string;
    await shoot(a, "chat-no-engine.png", "main");
    check("chatAsksForEngine", chatAsks.includes("doesn't pick one for you") && chatAsks.includes("Perry has no default engine yet"), chatAsks);

    await browser.send("Page.navigate", { url: a.BASE });
    await a.until(() => browser.evaluate(`location.pathname === "/welcome" && Boolean(document.querySelector('[role="radiogroup"][aria-label="Default engine"]'))`), "the welcome page's engine step", 60);
    await sleep(800);
    const cards = await browser.evaluate(`[...document.querySelectorAll('[role="radiogroup"][aria-label="Default engine"] [role="radio"]')].map((el) => ({ label: el.getAttribute("aria-label"), checked: el.getAttribute("aria-checked") === "true", text: el.innerText }))`) as Array<{ label: string; checked: boolean; text: string }>;
    const heading = await browser.evaluate(`document.querySelector("h1")?.innerText`) as string;
    await shoot(a, "onboarding-engine.png", "main");
    check("welcomeAsksWithOneOffered", heading === "Choose an engine" && cards.map((card) => card.label).join(",") === "Grok Build,Antigravity,Claude Code,Codex"
      && cards.filter((card) => card.checked).map((card) => card.label).join(",") === "Grok Build"
      && /Signed in with Grok account/.test(cards[0].text) && /not signed in/.test(cards[3].text), { heading, cards });

    // The owner picks Codex, which is not signed in, and signs in from here.
    await browser.evaluate(click('[role="radio"][aria-label="Codex"]'));
    await a.until(() => browser.evaluate(`Boolean(document.querySelector('[aria-label="Sign in to Codex"] button'))`), "Codex's sign-in on the welcome page", 15);
    await browser.evaluate(clickText('[aria-label="Sign in to Codex"] button', "Sign in with ChatGPT"));
    await a.until(() => browser.evaluate(`document.body.innerText.includes("FAKE-CODE")`), "the device code", 60);
    await shoot(a, "onboarding-sign-in.png", "main");
    await a.until(() => browser.evaluate(`(document.querySelector('[role="radio"][aria-label="Codex"]')?.innerText ?? "").includes("Signed in")`), "Codex to be signed in", 60);
    const signedIn = await browser.evaluate(`document.querySelector('[role="radio"][aria-label="Codex"]').innerText`) as string;
    check("welcomeSignsIn", /Signed in with ChatGPT Plus/.test(signedIn) && logOf(runnerWorld.state).some((entry) => entry.method === "account/login/start"), signedIn);
    await browser.evaluate(clickText("button", "Continue"));
    await a.until(async () => (await a.call<string | null>("dashboard:getDefaultEngine", { key: a.KEY })) === "codex", "Codex to be the default", 30);
    await a.until(() => browser.evaluate(`document.querySelector("h1")?.innerText === "Meet your assistant"`), "the next step", 15);
    check("welcomeSavesChoice", true);

    // 11. After the choice, turns run on it: the welcome chat, and the chat that was refused before.
    await browser.evaluate(clickText("button", "I'd rather just chat"));
    await a.until(() => browser.evaluate(`location.pathname.startsWith("/chat/")`), "the welcome chat", 30);
    const welcome = await browser.evaluate(`location.pathname.split("/").pop()`) as string;
    await a.until(async () => (await a.lastReply(welcome)).startsWith("Fake Codex reply to:"), "the welcome chat's reply", 90);
    const retried = await a.exchange(early, "Hello after choosing");
    check("turnsRunOnTheChoice", a.turnsOf(welcome).every((turn) => turn.engine === "codex") && retried.reply === "Fake Codex reply to: Hello after choosing"
      && (await a.conversation(early)).engine === "codex" && (await a.conversation(welcome)).engine === "codex",
      { welcome: a.turnsOf(welcome).map((turn) => turn.engine), early: (await a.conversation(early)).engine, reply: retried.reply });

    // 12. Settings changes it: new chats and schedules follow, chats already started keep theirs.
    await browser.send("Page.navigate", { url: `${a.BASE}/settings/engines` });
    await a.until(() => browser.evaluate(`Boolean(document.querySelector('section[aria-label="Default engine"] [role="radio"][aria-label="Codex"]'))`), "Settings' default engine", 30);
    await sleep(500);
    const marked = await browser.evaluate(`document.querySelector('section[aria-label="Default engine"] [role="radio"][aria-checked="true"]')?.innerText ?? ""`) as string;
    await shoot(a, "settings-default-engine.png", 'section[aria-label="Default engine"]');
    await browser.evaluate(click('section[aria-label="Default engine"] [role="radio"][aria-label="Grok Build"]'));
    await a.until(async () => (await a.call<string | null>("dashboard:getDefaultEngine", { key: a.KEY })) === "grok", "Grok Build to be the default", 30);
    await a.until(() => browser.evaluate(`document.body.innerText.includes("Perry now uses Grok Build by default.")`), "the toast", 15);
    await sleep(500);
    await shoot(a, "settings-default-engine-changed.png", 'section[aria-label="Default engine"]');
    check("settingsShowsDefault", marked.startsWith("Codex") && marked.includes("Default"), marked);
    const later = await a.call<string>("dashboard:createChat", { key: a.KEY });
    const grokReply = await a.exchange(later, "Hello Grok by default");
    const earlyAgain = await a.exchange(early, "Still on Codex?");
    const runsBefore = heartbeatChat ? (await a.runsOf(heartbeatChat)).length : 0;
    if (heartbeat) await a.call("jobs:runNow", { key: a.KEY, id: heartbeat.id });
    if (heartbeatChat) await a.until(async () => (await a.runsOf(heartbeatChat!)).length > runsBefore && (await a.runsOf(heartbeatChat!))[0].status !== "running", "the schedule to run", 90);
    const heartbeatTurn = heartbeatChat ? a.turnsOf(heartbeatChat).at(-1) : undefined;
    check("settingsChangesDefault", (await a.conversation(later)).engine === "grok" && /Fake grok reply to: Hello Grok by default/.test(grokReply.reply)
      && earlyAgain.reply === "Fake Codex reply to: Still on Codex?" && (await a.conversation(early)).engine === "codex"
      && heartbeatTurn?.engine === "grok" && !(await a.conversation(heartbeatChat!)).engine,
      { later: (await a.conversation(later)).engine, grok: grokReply.reply.slice(0, 80), early: earlyAgain.reply, heartbeat: heartbeatTurn?.engine });
    check("noPageErrorsNewInstall", browser.errors.length === 0, browser.errors);
  } catch (error) {
    notes.stoppedAt = `new install: ${String(error)}`;
    checks.completed = false;
  } finally {
    a.browser()?.close();
    for (const stop of stops.reverse()) stop();
    await sleep(2_500);
    notes.runnerLogNew = a.logs.runner.split("\n").filter(Boolean).slice(-30);
    try { rmSync(a.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }

  // --- B. An install from before the choice ------------------------------------------------------------------------
  const oldWorld = world({ codex: "signed-in" });
  const b = await perry({ name: "choose-engine-upgrade", outDir, runnerEnv: () => forRunner(oldWorld) });
  testHomes.push(b.home);
  const stopsB: Array<() => void> = [];
  try {
    let server = b.start("server");
    await b.until(() => fetch(`${b.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
    await b.call("wake:set", { key: b.KEY, enabled: false });
    const old = await b.call<string>("dashboard:createChat", { key: b.KEY });
    let heartbeat: { id: string; builtin?: string } | undefined;
    await b.until(async () => Boolean(heartbeat = (await b.call<Array<{ id: string; builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
    b.stop(server);
    await sleep(3_000);
    // As it was before Perry asked: no default, no askEngine; a chat with a Codex thread and no engine; a job with a bare model.
    b.sql(`UPDATE "doc_installation" SET doc = json_remove(doc, '$.askEngine', '$.defaultEngine')`);
    b.sql(`UPDATE "doc_conversations" SET doc = json_set(json_remove(doc, '$.engine'), '$.codexThreadId', 'fake-thread-legacy') WHERE _id = ?`, [old]);
    if (heartbeat) b.sql(`UPDATE "doc_jobs" SET doc = json_set(json_remove(doc, '$.engine'), '$.model', 'gpt-fake') WHERE _id = ?`, [heartbeat.id]);
    const seeded = b.rows("installation")[0];
    server = b.start("server");
    stopsB.push(() => b.stop(server));
    await b.until(() => fetch(`${b.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start again", 120);
    const install = b.rows("installation")[0];
    const job = heartbeat ? b.rows("jobs").find((row) => row._id === heartbeat!.id) : undefined;
    const status = await b.call<{ defaultEngine?: string; onboarding: string }>("dashboard:getStatus", { key: b.KEY });
    check("upgradeKeepsCodex", !("askEngine" in seeded) && !seeded.defaultEngine && install.defaultEngine === "codex" && !install.askEngine && status.defaultEngine === "codex"
      && (await b.conversation(old)).engine === "codex" && job?.engine === "codex" && job?.model === "gpt-fake",
      { seeded: { askEngine: seeded.askEngine, defaultEngine: seeded.defaultEngine }, after: { defaultEngine: install.defaultEngine, askEngine: install.askEngine }, chat: (await b.conversation(old)).engine, job: job && { model: job.model, engine: job.engine } });
    const runner = b.start("runner");
    stopsB.push(() => b.stop(runner));
    await b.until(async () => Boolean((await b.computers()).find((computer) => computer.online)?.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "the runner", 120);
    const reply = await b.exchange(old, "Hello after the upgrade");
    check("upgradeChatGoesOnOnCodex", reply.reply === "Fake Codex reply to: Hello after the upgrade" && b.turnsOf(old).every((turn) => turn.engine === "codex")
      && logOf(oldWorld.state).some((entry) => entry.method === "thread/resume" && entry.threadId === "fake-thread-legacy"),
      { reply: reply.reply, resumed: logOf(oldWorld.state).filter((entry) => entry.method?.startsWith("thread/")).map((entry) => `${entry.method} ${entry.threadId ?? ""}`) });
  } catch (error) {
    notes.stoppedAt = `${notes.stoppedAt ?? ""} upgrade: ${String(error)}`;
    checks.completed = false;
  } finally {
    for (const stop of stopsB.reverse()) stop();
    await sleep(2_500);
    try { rmSync(b.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }

  // --- C. perry setup's choice reaching Perry ---------------------------------------------------------------------
  const setupWorld = world({ codex: "signed-in", grok: "signed-in" });
  const c = await perry({ name: "choose-engine-setup", outDir, runnerEnv: () => forRunner(setupWorld) });
  testHomes.push(c.home);
  const stopsC: Array<() => void> = [];
  try {
    // 8. Made while Perry was stopped: waiting in its home, taken as it starts.
    if (chosenWhileStopped?.engine) copyFileSync(choiceFile(chosenWhileStopped.home), choiceFile(c.home));
    const server = c.start("server");
    stopsC.push(() => c.stop(server));
    await c.until(() => fetch(`${c.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
    await c.call("wake:set", { key: c.KEY, enabled: false });
    const taken = await c.call<string | null>("dashboard:getDefaultEngine", { key: c.KEY });
    check("stoppedChoiceTakenOnStart", Boolean(chosenWhileStopped?.engine) && taken === chosenWhileStopped?.engine && !existsSync(choiceFile(c.home)), { chosen: chosenWhileStopped?.engine, taken });

    // Made while it runs: straight to the server, and a re-run with no one there keeps it.
    const checkout = join(setupWorld.root, "running");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, ".env.local"), `DASHBOARD_KEY=${c.KEY}\nPERRY_PORT=${new URL(c.BASE).port}\n`);
    // A choice left waiting from before would undo this one at the next start: it goes once the server has this one.
    writeFileSync(choiceFile(c.home), JSON.stringify({ engine: "codex" }));
    const switched = await setup(setupWorld, { cwd: checkout, args: ["--engine=grok"], env: { PERRY_HOME: c.home } });
    transcript("setup-while-running", switched.output);
    const now = await c.call<string | null>("dashboard:getDefaultEngine", { key: c.KEY });
    check("runningChoiceReachesServer", switched.code === 0 && now === "grok" && !existsSync(choiceFile(c.home)), { now, last: tailOf(switched.output, 3) });
    const kept = await setup(setupWorld, { cwd: checkout, env: { PERRY_HOME: c.home } });
    check("rerunWithServerKeeps", kept.code === 0 && !kept.output.includes("Which should Perry use") && kept.output.includes("default engine Grok Build")
      && (await c.call<string | null>("dashboard:getDefaultEngine", { key: c.KEY })) === "grok", tailOf(kept.output, 3));
  } catch (error) {
    notes.stoppedAt = `${notes.stoppedAt ?? ""} setup handoff: ${String(error)}`;
    checks.completed = false;
  } finally {
    for (const stop of stopsC.reverse()) stop();
    await sleep(2_500);
    try { rmSync(c.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }
  // The test Perrys' wake timers were turned off; a task one left anyway, by its own name, goes too, and no other.
  if (WINDOWS) {
    notes.wakeTasksLeft = testHomes.map((home) => `Perry wake-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`).filter((name) => {
      const found = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if (Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false; 'removed' }`], { encoding: "utf8", windowsHide: true });
      return found.stdout.includes("removed");
    });
  }
}

try {
  await terminal();
  if (!setupOnly) await dashboard();
} catch (error) {
  notes.stoppedAt = `${notes.stoppedAt ?? ""} ${String(error)}`;
  checks.completed = false;
}
try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
notes.tempRemoved = !existsSync(ROOT);
const passed = Object.values(checks).every(Boolean) && Object.keys(checks).length > 0;
writeFileSync(join(outDir, "result.json"), `${redact(JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform, setupOnly, checks, notes, passed }, null, 2))}\n`);
console.log(JSON.stringify({ checks, passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(passed ? 0 : 1);
