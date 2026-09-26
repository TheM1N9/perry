#!/usr/bin/env bun
/**
 * `perry` — Perry's one command.
 *
 *   perry setup     set Perry up, or check it, and leave it running: your bot
 *                   and Codex, the dashboard built, Perry running in the
 *                   background from login on, and the dashboard opened,
 *                   already unlocked
 *   perry start     start Perry in the background (installing the service if need be)
 *   perry stop      stop it
 *   perry status    whether it is running, and where the dashboard is
 *   perry logs [-f] what it has been saying
 *   perry open      open the dashboard, already unlocked
 *   perry update    pull the latest Perry, install, rebuild, restart
 *   perry migrate   bring chats and memory over from Convex, where Perry used to keep them
 *   perry doctor    check this machine and the deployment
 *   perry pair      a new pairing code for Telegram
 *   perry run       run Perry in this terminal instead of the background
 *   perry uninstall stop starting Perry at login; your settings and data stay
 *
 * The runner (Codex on this machine) and the dashboard (a production build of
 * the Next.js app, on PERRY_PORT, 3000 unless set) run together under `perry
 * run`, which restarts either if it dies. The service installed at login runs
 * exactly that. The `perry` on PATH is a small launcher in ~/.perry/bin that
 * runs this file from its checkout, whatever folder you are in.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, readRunnerConfig } from "../runner/home";
import { bold, dim, green, red, yellow } from "./lib";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.PERRY_PORT ?? 3000);
const BIN_DIR = join(HOME, "bin");
const WORKSPACE = join(HOME, "workspace");
const NEXT_CLI = join(REPO, "node_modules", "next", "dist", "bin", "next");
const BUILD_ID = join(REPO, ".next", "BUILD_ID");

const say = (text = "") => console.log(text);

// --- Small helpers ---------------------------------------------------------

/** Run a command in the checkout; streamed to this terminal unless quiet. */
function exec(argv: string[], { quiet = false, env }: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
    windowsHide: true,
  });
  return { code: result.status ?? (result.error ? 127 : 1), output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || String(result.error?.message ?? "") };
}

/** A tool installed as a .cmd on Windows (pnpm, git from some installers) only starts through cmd.exe. */
function tool(name: string, args: string[]) {
  return process.platform === "win32"
    ? [process.env.COMSPEC || "cmd.exe", "/d", "/s", "/c", [name, ...args].join(" ")]
    : [name, ...args];
}

const bunScript = (script: string, args: string[] = []) => [process.execPath, join(REPO, "scripts", script), ...args];

function readEnvFile(): Record<string, string> {
  const file = join(REPO, ".env.local");
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.trimStart().startsWith("#")) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

const dashboardUrl = (host = "localhost") => `http://${host}:${PORT}`;

/**
 * The dashboard on this machine's other addresses, for opening it from a phone
 * or another computer: its LAN addresses, and its Tailscale one (100.64.0.0/10)
 * marked as such. The dashboard listens on all of them.
 */
function networkUrls(): string[] {
  const urls: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    // Adapters only this machine can reach: Hyper-V and WSL, Docker, VirtualBox, VMware, and bridges.
    if (/^(vEthernet|docker|br-|veth|virbr|vboxnet|VirtualBox|VMware)/i.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      const [a, b] = address.address.split(".").map(Number);
      const tailscale = a === 100 && b >= 64 && b <= 127;
      urls.push(`${dashboardUrl(address.address)}${tailscale ? dim("  (Tailscale)") : ""}`);
    }
  }
  return urls;
}

/** Where the dashboard is, on this machine and on the network, one address per line. */
function sayWhere(label: string) {
  say(`  ${label}  ${dashboardUrl()}`);
  const pad = " ".repeat(label.replace(/\x1b\[[0-9;]*m/g, "").length);
  for (const url of networkUrls()) say(`  ${pad}  ${url}`);
}

async function dashboardUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return check();
}

/** The runner already running with this token, if another process holds its lock. */
function runnerHeldBy(token: string): number | null {
  const lock = join(HOME, `runner-${createHash("sha256").update(token).digest("hex").slice(0, 12)}.lock`);
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    process.kill(pid, 0);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// --- The dashboard build ---------------------------------------------------

function build(): boolean {
  say(`\n${bold("Building the dashboard")}  ${dim("(a production build; a minute or so)")}`);
  const built = exec([nodePath(), NEXT_CLI, "build"], { quiet: true });
  if (built.code !== 0) {
    say(red("  The build failed:"));
    say(dim(built.output.split(/\r?\n/).slice(-15).join("\n")));
    return false;
  }
  say(`  ${green("built")}`);
  return true;
}

/** Node runs the dashboard; Next.js is not built for Bun's runtime. */
function nodePath(): string {
  const found = process.platform === "win32" ? exec(["where", "node"], { quiet: true }) : exec(["which", "node"], { quiet: true });
  const first = found.code === 0 ? found.output.split(/\r?\n/)[0].trim() : "";
  return first || "node";
}

// --- perry run: the runner and the dashboard, kept running ------------------

type Managed = { name: string; argv: string[]; env: NodeJS.ProcessEnv; proc?: ChildProcess; failures: number; startedAt: number };

/** End a process and everything it started; on Windows a plain kill leaves the children. */
export function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else try { process.kill(pid, "SIGTERM"); } catch {}
}

async function runForeground() {
  if (!readEnvFile().DASHBOARD_KEY) {
    say(`\n${red("Perry is not set up yet.")} Run ${bold("perry setup")} first.\n`);
    process.exit(1);
  }
  // The Windows service stops this process by the PID it notes here; the runner must not note its own.
  const pidFile = process.env.PERRY_SERVICE_PID_FILE;
  const childEnv = { ...process.env };
  delete childEnv.PERRY_SERVICE_PID_FILE;
  if (pidFile) {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid));
  }
  if (!existsSync(BUILD_ID) && !build()) process.exit(1);

  const stamp = () => new Date().toISOString().slice(11, 19);
  const children: Managed[] = [
    { name: "runner", argv: [process.execPath, join(REPO, "runner", "index.ts")], env: childEnv, failures: 0, startedAt: 0 },
    { name: "dashboard", argv: [nodePath(), NEXT_CLI, "start", "-p", String(PORT)], env: { ...childEnv, NODE_ENV: "production", PERRY_PORT: String(PORT) }, failures: 0, startedAt: 0 },
  ];
  let stopping = false;

  const launch = (child: Managed) => {
    child.startedAt = Date.now();
    const proc = spawn(child.argv[0], child.argv.slice(1), { cwd: REPO, env: child.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.proc = proc;
    const prefix = (chunk: Buffer) => chunk.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => `${stamp()} [${child.name}] ${line}\n`).join("");
    proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
    proc.stderr?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
    proc.on("error", (error) => process.stdout.write(`${stamp()} [${child.name}] could not start: ${error.message}\n`));
    proc.on("exit", (code) => {
      if (stopping) return;
      // One that ran a while and then died starts again at once; one that keeps dying backs off, to 5 minutes.
      child.failures = Date.now() - child.startedAt > 60_000 ? 0 : child.failures + 1;
      const wait = Math.min(300, 2 ** child.failures) * 1000;
      process.stdout.write(`${stamp()} [perry] ${child.name} exited (${code ?? "signal"}); starting it again in ${wait / 1000}s\n`);
      setTimeout(() => { if (!stopping) launch(child); }, wait);
    });
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${stamp()} [perry] stopping\n`);
    for (const child of children) if (child.proc?.pid && child.proc.exitCode === null) killTree(child.proc.pid);
    if (pidFile) rmSync(pidFile, { force: true });
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.stdout.write(`${stamp()} [perry] starting the runner and the dashboard on ${dashboardUrl()}\n`);
  for (const child of children) launch(child);
}

// --- The launcher on PATH ----------------------------------------------------

/** Put `perry` on PATH: a launcher in ~/.perry/bin that runs this checkout's CLI from anywhere. */
function link(): boolean {
  mkdirSync(BIN_DIR, { recursive: true });
  const script = join(REPO, "scripts", "perry.ts");
  // A Node the installer put in ~/.perry/node (the owner's was missing or too old) comes first for Perry alone.
  const ownNode = join(HOME, "node", "bin");
  const sh = `#!/bin/sh\n# Perry's command. Written by \`perry setup\`; runs ${REPO}.\n` +
    (existsSync(ownNode) ? `PATH="${ownNode}:$PATH"; export PATH\n` : "") +
    `exec "${process.execPath}" --cwd "${REPO}" "${script}" "$@"\n`;
  writeFileSync(join(BIN_DIR, "perry"), sh, { mode: 0o755 });
  if (process.platform === "win32") {
    const cmd = `@echo off\r\nrem Perry's command. Written by perry setup; runs ${REPO}.\r\n"${process.execPath}" --cwd "${REPO}" "${script}" %*\r\n`;
    writeFileSync(join(BIN_DIR, "perry.cmd"), cmd);
  }
  if (process.env.PERRY_NO_PATH === "1") return true;
  const onPath = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").some((dir) => resolve(dir) === resolve(BIN_DIR));
  if (onPath) return true;

  if (process.platform === "win32") {
    // The user's own PATH in the registry, read and written raw, so %VARIABLES% in it stay unexpanded and
    // its type is kept ([Environment]::SetEnvironmentVariable would expand them and write a plain string).
    // Setting and clearing a throwaway variable through .NET then tells Windows, so new terminals see it.
    const ps = [
      `$dir = '${BIN_DIR.replace(/'/g, "''")}'`,
      `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)`,
      `$path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
      `$kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }`,
      `if (-not (($path -split ';') -contains $dir)) { $key.SetValue('Path', $(if ($path) { $path.TrimEnd(';') + ';' + $dir } else { $dir }), $kind) }`,
      `$key.Close()`,
      `[Environment]::SetEnvironmentVariable('PERRY_PATH_CHANGED', '1', 'User'); [Environment]::SetEnvironmentVariable('PERRY_PATH_CHANGED', $null, 'User')`,
    ].join("; ");
    const set = exec(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { quiet: true });
    if (set.code !== 0) {
      say(yellow(`  Could not add ${BIN_DIR} to your PATH: ${set.output}`));
      return false;
    }
  } else {
    const line = `export PATH="${BIN_DIR}:$PATH"  # added by Perry`;
    const shell = process.env.SHELL ?? "";
    const files = [shell.endsWith("zsh") ? ".zshrc" : shell.endsWith("bash") ? ".bashrc" : ".profile", ".profile"];
    for (const name of new Set(files)) {
      const file = join(homedir(), name);
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!current.includes(BIN_DIR)) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
    }
  }
  say(dim(`  Added ${BIN_DIR} to your PATH. Open a new terminal to use ${bold("perry")} anywhere.`));
  return true;
}

function unlink() {
  rmSync(join(BIN_DIR, "perry"), { force: true });
  rmSync(join(BIN_DIR, "perry.cmd"), { force: true });
}

// --- Opening the dashboard ----------------------------------------------------

/** Open the dashboard with its key in the fragment, which the page stores and removes; a fragment is never sent to a server. */
async function open(): Promise<boolean> {
  const key = readEnvFile().DASHBOARD_KEY;
  if (!key) {
    say(`\n${red("No dashboard key in .env.local.")} Run ${bold("perry setup")} first.\n`);
    return false;
  }
  const { openUrl } = await import("./lib");
  if (!(await openUrl(`${dashboardUrl()}/#key=${encodeURIComponent(key)}`))) {
    say(`  Open the dashboard and use this key: ${key}`);
    sayWhere("       ");
  } else {
    say(`  ${green("opened")} ${dashboardUrl()}`);
  }
  return true;
}

// --- The commands ---------------------------------------------------------------

async function status() {
  const { serviceState, servicePlan, serviceContext } = await import("./service");
  const ctx = serviceContext();
  const state = serviceState(ctx);
  const up = await dashboardUp();
  say(`\n${bold("Perry")}  ${dim(REPO)}`);
  say(`  service    ${state.running ? green("running") : state.installed ? yellow("stopped") : dim("not installed")}${state.installed ? dim(`  ${state.detail}`) : ""}`);
  if (up) sayWhere(`dashboard`);
  else say(`  dashboard  ${yellow(`not answering on ${dashboardUrl()}`)}`);
  const config = readRunnerConfig();
  say(`  computer   ${config.token ? `${config.name ?? hostname()}${dim(`, working in ${config.dir ?? "?"}`)}` : yellow("not connected")}`);
  say(dim(`  logs       ${servicePlan(ctx).logs ? "perry logs" : ctx.logFile}\n`));
}

async function start(): Promise<boolean> {
  const { install, serviceState, serviceContext, servicePlan, runSteps } = await import("./service");
  if (!readEnvFile().DASHBOARD_KEY) {
    say(`\n${red("Perry is not set up yet.")} Run ${bold("perry setup")} first.\n`);
    return false;
  }
  if (!existsSync(BUILD_ID) && !build()) return false;
  const ctx = serviceContext();
  const state = serviceState(ctx);
  const ok = state.installed ? state.running || runSteps(servicePlan(ctx).start, false) : install();
  if (!ok) return false;
  say(dim("  Waiting for the dashboard…"));
  const up = await waitFor(dashboardUp, 90);
  if (up) sayWhere(green("running"));
  else say(yellow(`  Started, but the dashboard is not answering yet. ${bold("perry logs")} says why.`));
  return up;
}

async function stop() {
  const { serviceContext, servicePlan, runSteps, endServiceProcess } = await import("./service");
  const ctx = serviceContext();
  runSteps(servicePlan(ctx).stop, false);
  if (ctx.platform === "win32") endServiceProcess();
  say(`  ${green("stopped")}`);
}

/** Perry's backend as this machine's CLI calls it: the running server, with the dashboard key. */
async function backend() {
  const { BackendClient } = await import("../client/backend");
  return new BackendClient(`http://127.0.0.1:${PORT}`, { adminKey: readEnvFile().DASHBOARD_KEY });
}

/** With a bot nobody has claimed, a code to claim it with, from the running server. */
async function pairTelegram() {
  const env = readEnvFile();
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const client = await backend();
  const status = await client.call<{ claimed: boolean }>("installation:status").catch(() => null);
  if (!status || status.value.claimed) return;
  const bot = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`).then((r) => r.json(), () => null) as { result?: { username?: string } } | null;
  const code = await client.call<{ code: string }>("installation:startPairing").then((result) => result.value.code, () => null);
  if (!code) { say(yellow(`  Could not make a pairing code; ${bold("perry pair")} tries again.`)); return; }
  say(`
${bold("Claim it")}`);
  say(`  Message ${bold(`@${bot?.result?.username ?? "your bot"}`)} on Telegram with:`);
  say(`
      ${bold(green(code))}
`);
  say(dim("  It expires in an hour. Whoever sends it first owns this Perry;"));
  say(dim("  everyone else is ignored from then on."));
}

async function setup() {
  const configured = exec(bunScript("setup.ts", ["--from-perry"]));
  if (configured.code !== 0) process.exit(configured.code);

  say(`
${bold("This computer")}`);
  say(dim(`  Your chats, memory and files stay on this computer, in ${HOME}. Nothing listens
  on the internet for Perry: it asks Telegram for messages, and Codex runs here.`));
  if (!build()) process.exit(1);

  say(`
${bold("Running in the background")}`);
  const { endServiceProcess } = await import("./service");
  if (process.platform === "win32") endServiceProcess();
  if (!(await start())) process.exit(1);
  await pairTelegram();

  // An install that kept its data on Convex brings it over once, now that Perry runs here.
  if (readEnvFile().CONVEX_DEPLOYMENT) {
    say(`
${bold("Your data on Convex")}`);
    say(dim("  Perry used to keep your chats and memory on Convex; it keeps them here now."));
    const answer = process.stdin.isTTY ? (await ask("  Bring them over? [Y/n] ")).trim().toLowerCase() : "n";
    if (answer === "" || answer === "y" || answer === "yes") exec(bunScript("migrate.ts"));
    else say(dim(`  Skipped. ${bold("perry migrate")} brings them over whenever you like.`));
  }

  say(`
${bold("The perry command")}`);
  link();
  say(`
${bold("Dashboard")}`);
  await open();
  const { runCodex } = await import("./lib");
  const codex = await runCodex(["login", "status"]);
  if (codex.code !== 0) say(yellow(`
  Codex is not signed in yet, so Perry cannot answer: run ${bold("codex login")}, or sign in from the dashboard's Settings page.`));
  say(dim(`
  perry status | logs | stop | start | open | update | doctor
`));
}

/** One question on this terminal. */
async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

async function update() {
  say(`\n${bold("Updating Perry")}`);
  if (existsSync(join(REPO, ".git"))) {
    const pulled = exec(tool("git", ["pull", "--ff-only"]));
    if (pulled.code !== 0) {
      say(red("  git pull failed; commit or stash local changes, then try again."));
      process.exit(1);
    }
  }
  if (exec(tool("pnpm", ["install", "--frozen-lockfile"])).code !== 0) process.exit(1);
  // The backend is part of the dashboard's server, so the new build is all there is to deploy;
  // its database moves forward on its own when the server starts.
  // The running dashboard serves from the build, so it stops while a new one is made.
  const { serviceState } = await import("./service");
  const wasRunning = serviceState().running;
  if (wasRunning) await stop();
  if (!build()) process.exit(1);
  if (wasRunning && !(await start())) process.exit(1);
  if (!wasRunning) say(dim(`  Perry was not running; ${bold("perry start")} starts it.`));
  say(`  ${green("up to date")}\n`);
}

const HELP = `
  ${bold("perry")} setup | start | stop | status | logs [-f] | open | update | migrate | doctor | pair | run | uninstall

  ${bold("setup")}      set Perry up (or check it), start it in the background, open the dashboard
  ${bold("start")}      start Perry in the background, from now on at every login
  ${bold("stop")}       stop it
  ${bold("status")}     whether it is running, and where
  ${bold("logs")}       what it has been saying; -f to follow
  ${bold("open")}       open the dashboard, already unlocked
  ${bold("update")}     pull the latest Perry, install, rebuild, restart
  ${bold("migrate")}    bring chats and memory over from Convex, where Perry used to keep them
  ${bold("doctor")}     check this machine and your deployment
  ${bold("pair")}       a new code to claim Perry on Telegram
  ${bold("run")}        run Perry in this terminal instead of the background
  ${bold("uninstall")}  stop starting Perry at login; settings and data stay
`;

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  switch (command) {
    case "setup": return setup();
    case "start": return process.exit((await start()) ? 0 : 1);
    case "stop": return stop();
    case "status": return status();
    case "logs": return process.exit(exec(bunScript("service.ts", ["logs", ...rest])).code);
    case "open": return process.exit((await open()) ? 0 : 1);
    case "update": return update();
    case "doctor": return process.exit(exec(bunScript("doctor.ts", rest)).code);
    case "pair": return process.exit(exec(bunScript("pair.ts")).code);
    case "migrate": return process.exit(exec(bunScript("migrate.ts", rest)).code);
    case "run": return runForeground();
    case "link": return process.exit(link() ? 0 : 1);
    case "uninstall": {
      const { uninstall } = await import("./service");
      uninstall();
      unlink();
      say(dim(`  Removed the perry command from ${BIN_DIR}. Your checkout at ${REPO} and your data in ${HOME} are kept.\n`));
      return;
    }
    case "help": case "--help": case "-h": return say(HELP);
    default:
      say(`\n  ${red(`Unknown command: ${command}`)}`);
      say(HELP);
      process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
