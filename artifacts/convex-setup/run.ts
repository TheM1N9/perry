import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// bun artifacts/convex-setup/run.ts <outDir>
// Setup's first step, Convex, without the Convex CLI's own onboarding. The
// flows run setup.ts in a scratch copy of the scripts against a stand-in for
// the Convex CLI that records each call and the environment it got, because
// the real one would need a browser login and would create real projects.
// One check runs the real CLI, logged out, which creates nothing.
//
// Ways step 1 could still put people through Convex's onboarding, or go wrong:
//   1. The real CLI still makes a local deployment when there is no terminal:
//      with CONVEX_ALLOW_ANONYMOUS=false, logged out, an anonymous deployment
//      in .env.local and stdin not a terminal, it must not start one, and
//      .env.local must be left as it was.
//   2. A leftover local deployment wins: after step 1, .env.local must name a
//      .convex.cloud deployment, and no CLI call may have been given the old
//      CONVEX_DEPLOYMENT through the environment Bun loaded at start.
//   3. Convex's prompts reach the person: login must pass --device-name and
//      --no-open, every call must carry CONVEX_ALLOW_ANONYMOUS=false, and
//      project creation must pass --configure new, --team, --project and
//      --dev-deployment cloud with no terminal to prompt in.
//   4. Someone logged in is asked to log in again: no login call.
//   5. With several teams, the wrong one is used: setup asks, and the team
//      picked is the one passed.
//   6. A failed creation is not explained: setup must stop with the CLI's error.
//
// Telegram is optional (step 2), and could go wrong these ways:
//   7. Skipping it stops setup: pressing Enter must carry setup to the end.
//   8. A bot is half set up: with none, no TELEGRAM_BOT_TOKEN may be set on
//      the deployment or written to .env.local, and nothing may be paired.
//   9. A bot cannot be added later: the webhook secret the Keys page needs to
//      register one must still be made and set, with the dashboard key.
//  10. Settings break without pairing, which is what makes the installation
//      row: setup must make it (installation:ensure).
//  11. A token Telegram rejects ends setup: it must say so and ask again,
//      and Enter must still skip. (A made-up token, checked against Telegram's
//      real getMe; no real bot is touched.)
//
// Codex is signed in during setup (step 3), since every reply is a Codex turn
// and a first chat must not start without it. Against a stand-in Codex CLI:
//  12. Someone signed in is asked again: no login call.
//  13. Sign-in is only reported, not done: signed out, `codex login` must run
//      and the status be checked again.
//  14. A browser sign-in that does not finish strands them: setup must fall
//      back to `codex login --device-auth`.
//  15. No browser to open (a server, or over SSH): straight to --device-auth,
//      never the browser flow.
//  16. A failed sign-in stops setup, or passes silently: setup must finish,
//      saying Perry cannot answer until Codex is signed in, and how.
//  17. Codex missing is waved through: setup must stop with how to install
//      it, before anything is pushed to the deployment.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/convex-setup/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const repo = resolve(".");
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const STUB = `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, allowAnonymous: process.env.CONVEX_ALLOW_ANONYMOUS ?? null, deploymentInEnv: process.env.CONVEX_DEPLOYMENT ?? null, stdinIsTTY: !!process.stdin.isTTY }) + "\\n");
const state = process.env.STUB_STATE;
const loggedIn = fs.existsSync(state + "/logged-in");
const teams = process.env.STUB_TEAMS.split(",");
if (args[0] === "login" && args[1] === "status") {
  console.log(loggedIn ? "Status: Logged in\\nTeams: " + teams.length + " teams accessible\\n" + teams.map((t) => "  - " + t + " Team (" + t + ")").join("\\n") : "Status: Not logged in");
} else if (args[0] === "login") {
  console.log("Visit https://auth.convex.dev/activate?user_code=WXYZ-1234 to finish logging in.\\nYou should see the following code which expires in 15 minutes: WXYZ-1234");
  fs.writeFileSync(state + "/logged-in", "");
} else if (args[0] === "dev" && args.includes("--configure")) {
  if (process.env.STUB_FAIL) { console.error("✖ Error: Unable to create project: team limit reached"); process.exit(1); }
  const env = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
  const kept = env.split("\\n").filter((l) => !/^(CONVEX_DEPLOYMENT|NEXT_PUBLIC_CONVEX_URL)=/.test(l)).join("\\n");
  fs.writeFileSync(".env.local", kept + "\\nCONVEX_DEPLOYMENT=dev:happy-otter-123 # team: x, project: perry\\nNEXT_PUBLIC_CONVEX_URL=https://happy-otter-123.convex.cloud\\n");
}
`;

type Call = { args: string[]; allowAnonymous: string | null; deploymentInEnv: string | null; stdinIsTTY: boolean };

/** Run setup, answering each prompt when it appears, as a person would; input sent early would be dropped. */
function runSetup(dir: string, env: NodeJS.ProcessEnv, answers: Record<string, string>): Promise<{ status: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(dir, "scripts", "setup.ts")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const answered = new Set<string>();
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      for (const [prompt, answer] of Object.entries(answers)) {
        if (!answered.has(prompt) && output.includes(prompt)) { answered.add(prompt); child.stdin.write(answer); }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (status) => { clearTimeout(timer); done({ status, output }); });
  });
}

/** A stand-in for the Codex CLI: records its arguments, and signs in only as the scenario says. */
const CODEX_STUB = `
const fs = require("fs");
const args = process.argv.slice(2);
const state = process.env.CODEX_STATE;
fs.appendFileSync(process.env.CODEX_LOG, JSON.stringify(args) + "\\n");
if (process.env.CODEX_MISSING) { console.error("'codex' is not recognized as an internal or external command"); process.exit(1); }
const signedIn = fs.existsSync(state + "/codex-signed-in");
if (args[0] === "--version") console.log("codex-cli 9.9.9");
else if (args[0] === "login" && args[1] === "status") { if (signedIn) console.log("Logged in using ChatGPT"); else { console.log("Not logged in"); process.exit(1); } }
else if (args[0] === "login" && args[1] === "--device-auth") {
  console.log("Visit https://auth.openai.com/codex/device and enter ABCD-1234");
  if (process.env.CODEX_DEVICE_OK) fs.writeFileSync(state + "/codex-signed-in", ""); else process.exit(1);
} else if (args[0] === "login") {
  if (process.env.CODEX_BROWSER_OK) fs.writeFileSync(state + "/codex-signed-in", ""); else { console.error("Login was not completed"); process.exit(1); }
}
`;
type CodexState = { signedIn?: boolean; browserOk?: boolean; deviceOk?: boolean; missing?: boolean };

async function scenario(name: string, opts: { loggedIn: boolean; teams: string[]; envFile?: string; answers: Record<string, string>; fail?: boolean; codex?: CodexState; env?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), `perry-convex-${name}-`));
  cpSync(join(repo, "scripts"), join(dir, "scripts"), { recursive: true });
  cpSync(join(repo, "runner"), join(dir, "runner"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "convex", "bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "convex", "bin", "main.js"), STUB);
  mkdirSync(join(dir, "state"));
  if (opts.loggedIn) writeFileSync(join(dir, "state", "logged-in"), "");
  if (opts.envFile) writeFileSync(join(dir, ".env.local"), opts.envFile);
  // The stand-in Codex goes first on PATH, so the real one is never asked; signed in unless the scenario says not.
  const codex: CodexState = { signedIn: true, ...opts.codex };
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex-stub.js"), CODEX_STUB);
  writeFileSync(join(bin, "codex.cmd"), `@"${process.execPath}" "${join(bin, "codex-stub.js")}" %*\r\n`);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "codex-stub.js")}" "$@"\n`, { mode: 0o755 });
  if (codex.signedIn) writeFileSync(join(dir, "state", "codex-signed-in"), "");
  const codexLog = join(dir, "codex.jsonl");
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const log = join(dir, "calls.jsonl");
  const ran = await runSetup(dir, {
    ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}`,
    STUB_LOG: log, STUB_STATE: join(dir, "state"), STUB_TEAMS: opts.teams.join(","), PERRY_NO_BROWSER: "1", PERRY_HOME: join(dir, "home"),
    CODEX_LOG: codexLog, CODEX_STATE: join(dir, "state"),
    ...(codex.browserOk ? { CODEX_BROWSER_OK: "1" } : {}), ...(codex.deviceOk ? { CODEX_DEVICE_OK: "1" } : {}), ...(codex.missing ? { CODEX_MISSING: "1" } : {}),
    ...(opts.fail ? { STUB_FAIL: "1" } : {}), ...opts.env,
  }, opts.answers);
  const codexCalls: string[] = existsSync(codexLog) ? readFileSync(codexLog, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as string[]).join(" ")) : [];
  const output = ran.output.replace(/\x1b\[[0-9;]*m/g, "");
  const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const envAfter = existsSync(join(dir, ".env.local")) ? readFileSync(join(dir, ".env.local"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  // Values set on the deployment are generated secrets, even in a scratch run, so the record shows only their names.
  const shown = calls.map((c) => c.args[0] === "env" && c.args[1] === "set" ? { ...c, args: [...c.args.slice(0, 3), "<value>"] } : c);
  writeFileSync(join(outDir, `${name}.txt`), `${output.replace(/dashboard key: \S+/g, "dashboard key: <key>")}\n--- calls ---\n${shown.map((c) => JSON.stringify(c)).join("\n")}\n--- codex ---\n${codexCalls.join("\n")}\n`);
  return { code: ran.status, output, calls, shown, envAfter, codexCalls };
}
const creation = (calls: Call[]) => calls.find((c) => c.args[0] === "dev" && c.args.includes("--configure"));
const flag = (call: Call | undefined, name: string) => call ? call.args[call.args.indexOf(name) + 1] : undefined;
const anonymousFile = "CONVEX_DEPLOYMENT=anonymous:anonymous-perry\nNEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210\nCONVEX_URL=http://127.0.0.1:3210\n";

// 1. The real CLI, logged out, with an anonymous deployment and no terminal.
{
  // Run from this checkout, for its Convex project files, with the anonymous deployment in a scratch env file.
  const dir = mkdtempSync(join(tmpdir(), "perry-convex-real-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const envFile = join(dir, "anonymous.env");
  writeFileSync(envFile, anonymousFile);
  const ran = spawnSync("node", [join(repo, "node_modules", "convex", "bin", "main.js"), "dev", "--once", "--env-file", envFile, "--configure", "new", "--team", "none", "--project", "perry", "--dev-deployment", "cloud"], {
    cwd: repo, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, USERPROFILE: home, CONVEX_ALLOW_ANONYMOUS: "false", CONVEX_DEPLOYMENT: "", CONVEX_URL: "", NEXT_PUBLIC_CONVEX_URL: "" },
  });
  const output = `${ran.stdout}${ran.stderr}`;
  notes.realCli = output.trim().split("\n").slice(0, 4);
  checks.realCliMakesNoLocalDeployment = !/local deployment|anonymous|Downloading|backend binary/i.test(output) && readFileSync(envFile, "utf8") === anonymousFile && ran.status !== 0;
  rmSync(dir, { recursive: true, force: true });
}

// 2, 3 and 5. Logged out, a leftover local deployment, two teams; the second is picked.
const moved = await scenario("local-to-cloud", { loggedIn: false, teams: ["first", "second"], envFile: anonymousFile, answers: { "Team [1]:": "2\n", "Enter to skip": "\n" } });
const made = creation(moved.calls);
notes.movedCalls = moved.shown.map((c) => c.args.join(" "));
checks.endsInTheCloud = /NEXT_PUBLIC_CONVEX_URL=https:\/\/happy-otter-123\.convex\.cloud/.test(moved.envAfter) && !/anonymous/.test(moved.envAfter) && moved.output.includes("created dev:happy-otter-123");
// A CLI run under Bun loads .env.local as it is when it starts, which is right; what must never reach it is the old local one.
checks.staleDeploymentNeverPassed = moved.calls.every((c) => !c.deploymentInEnv?.startsWith("anonymous")) && creation(moved.calls)?.deploymentInEnv === null;
checks.anonymousAlwaysOff = moved.calls.every((c) => c.allowAnonymous === "false");
const login = moved.calls.find((c) => c.args[0] === "login" && c.args[1] !== "status");
checks.loginAsksNothing = Boolean(login?.args.includes("--no-open") && flag(login, "--device-name")?.startsWith("Perry on ")) && moved.output.includes("Visit https://auth.convex.dev/activate");
checks.creationAsksNothing = Boolean(made && flag(made, "--configure") === "new" && flag(made, "--project") === "perry" && flag(made, "--dev-deployment") === "cloud" && !made.stdinIsTTY);
checks.teamQuestionPicksTeam = moved.output.includes("Which Convex team") && flag(made, "--team") === "second";
checks.noConvexPrompts = !/Device name:|Open the browser\?|Start without an account|Project name:/.test(moved.output);

// 4. Logged in, one team, nothing configured.
const direct = await scenario("logged-in", { loggedIn: true, teams: ["only"], answers: { "Enter to skip": "\n" } });
checks.noLoginWhenLoggedIn = !direct.calls.some((c) => c.args[0] === "login" && c.args[1] !== "status") && !direct.output.includes("Which Convex team") && flag(creation(direct.calls), "--team") === "only";

// 6. Creation fails.
const failed = await scenario("create-fails", { loggedIn: true, teams: ["only"], answers: {}, fail: true });
checks.failureExplained = failed.code === 1 && failed.output.includes("Creating the Convex project failed") && failed.output.includes("team limit reached");

// 7 to 11. No Telegram: a token Telegram rejects, then Enter.
const cloudFile = "CONVEX_DEPLOYMENT=dev:happy-otter-123\nNEXT_PUBLIC_CONVEX_URL=https://happy-otter-123.convex.cloud\n";
const skipped = await scenario("no-telegram", { loggedIn: true, teams: ["only"], envFile: cloudFile, answers: { "Enter to skip": "123456:not-a-real-token\n", "Telegram rejected that token": "\n" } });
const setKeys = skipped.calls.filter((c) => c.args[0] === "env" && c.args[1] === "set").map((c) => c.args[2]);
notes.noTelegramCalls = skipped.shown.map((c) => c.args.join(" "));
checks.skipFinishesSetup = skipped.code === 0 && skipped.output.includes("Skipped") && skipped.output.includes("[5/5]");
checks.noHalfBot = !setKeys.includes("TELEGRAM_BOT_TOKEN") && !/TELEGRAM_BOT_TOKEN=/.test(skipped.envAfter) && !skipped.calls.some((c) => c.args.includes("installation:startPairing")) && !/webhook\s+https/.test(skipped.output);
checks.botCanBeAddedLater = setKeys.includes("TELEGRAM_WEBHOOK_SECRET") && setKeys.includes("DASHBOARD_KEY") && /TELEGRAM_WEBHOOK_SECRET=[0-9a-f]{64}/.test(skipped.envAfter) && /DASHBOARD_KEY=\S{20,}/.test(skipped.envAfter);
checks.settingsRowMade = skipped.calls.some((c) => c.args[0] === "run" && c.args[1] === "installation:ensure");
checks.rejectedTokenAsksAgain = skipped.output.includes("Telegram rejected that token") && (skipped.output.match(/Bot token, or Enter to skip/g) ?? []).length === 2;

// 12 to 17. Codex sign-in, each with Telegram skipped and Convex already set up.
const codexScenario = (name: string, codex: CodexState, env: Record<string, string> = {}) =>
  scenario(name, { loggedIn: true, teams: ["only"], envFile: cloudFile, answers: { "Enter to skip": "\n" }, codex, env });
const logins = (calls: string[]) => calls.filter((c) => c.startsWith("login") && c !== "login status");

const already = await codexScenario("codex-signed-in", { signedIn: true });
checks.signedInNotAskedAgain = logins(already.codexCalls).length === 0 && /codex 9\.9\.9, signed in using ChatGPT/.test(already.output);

const browser = await codexScenario("codex-browser", { signedIn: false, browserOk: true });
notes.codexBrowserCalls = browser.codexCalls;
checks.signsInWithBrowser = JSON.stringify(logins(browser.codexCalls)) === JSON.stringify(["login"]) && browser.output.includes("browser window that opens") && /signed in using chatgpt/i.test(browser.output);

const fallback = await codexScenario("codex-device-fallback", { signedIn: false, deviceOk: true });
checks.fallsBackToDeviceCode = JSON.stringify(logins(fallback.codexCalls)) === JSON.stringify(["login", "login --device-auth"]) && fallback.output.includes("did not finish; signing in with a code") && /signed in using chatgpt/i.test(fallback.output);

const headless = await codexScenario("codex-headless", { signedIn: false, deviceOk: true }, { SSH_CONNECTION: "203.0.113.5 50000 203.0.113.9 22" });
checks.headlessUsesDeviceCode = JSON.stringify(logins(headless.codexCalls)) === JSON.stringify(["login --device-auth"]) && headless.output.includes("No browser here");

const unsigned = await codexScenario("codex-not-signed-in", { signedIn: false });
checks.failedSignInExplained = unsigned.code === 0 && unsigned.output.includes("Codex is not signed in, so Perry cannot answer yet") && unsigned.output.includes("[5/5]");

const missing = await codexScenario("codex-missing", { missing: true });
checks.missingCodexStops = missing.code === 1 && missing.output.includes("Codex is not installed here") && !missing.calls.some((c) => c.args[0] === "env");

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
