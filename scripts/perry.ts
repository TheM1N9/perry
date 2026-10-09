#!/usr/bin/env bun
/**
 * `perry` — Perry's one command.
 *
 *   perry setup     set Perry up, or check it, and leave it running: your bot
 *                   and the engine you choose to think with (--engine names
 *                   it where there is no one to ask), the dashboard built,
 *                   Perry running in the background from login on, and the
 *                   dashboard opened, already unlocked
 *   perry start     start Perry in the background (installing the service if need be)
 *   perry stop      stop it
 *   perry status    whether it is running, and where the dashboard is
 *   perry logs [-f] what it has been saying
 *   perry open      open the dashboard, already unlocked
 *   perry update    pull the latest Perry, install, rebuild, restart
 *   perry migrate   bring chats and memory over from Convex, where Perry used to keep them
 *   perry doctor    check this machine and Perry's server
 *   perry pair      a new pairing code for Telegram
 *   perry pet       Perry on your desktop, with your to-dos (scripts/pet.ts)
 *   perry run       run Perry in this terminal instead of the background
 *   perry uninstall stop Perry starting at login, keeping its files or removing them from this computer
 *
 * The runner (the engines on this machine) and the dashboard (a production build of
 * the Next.js app, on PERRY_PORT, 7377 unless set) run together under `perry
 * run`, which restarts either if it dies, and does the updates the dashboard
 * asks for (selfUpdate). The service installed at login runs
 * exactly that. The `perry` on PATH is a small launcher in ~/.perry/bin that
 * runs this file from its checkout, whatever folder you are in.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { standing, type UpdateRequest, type UpdateResult } from "../convex/lib/checkout";
import { reachableAddresses } from "../convex/lib/devices";
import { HOME, PATHS, readRunnerConfig, writeRunnerConfig } from "../runner/home";
import { bold, dim, done, green, red, run, spinner, tail, yellow } from "./lib";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.PERRY_PORT ?? 7377);
const BIN_DIR = join(HOME, "bin");
const WORKSPACE = join(HOME, "workspace");
const NEXT_CLI = join(REPO, "node_modules", "next", "dist", "bin", "next");
const BUILD_ID = join(REPO, ".next", "BUILD_ID");

const say = (text = "") => console.log(text);

// --- Small helpers ---------------------------------------------------------

/** Run a command in the checkout; streamed to this terminal unless quiet. */
export function exec(argv: string[], { quiet = false, env }: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}) {
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
export function tool(name: string, args: string[]) {
  return process.platform === "win32"
    ? [process.env.COMSPEC || "cmd.exe", "/d", "/s", "/c", [name, ...args].join(" ")]
    : [name, ...args];
}

/** A command in the checkout, in the background, so a spinner can turn meanwhile. */
const runIn = ([command, ...args]: string[]) => run(command, args, { cwd: REPO });

const bunScript = (script: string, args: string[] = []) => [process.execPath, join(REPO, "scripts", script), ...args];

export function readEnvFile(): Record<string, string> {
  const file = join(REPO, ".env.local");
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.trimStart().startsWith("#")) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

/**
 * Where the dashboard listens. By default on every address this computer
 * has, as Next.js does, so a phone, and another computer's runner or desktop
 * pet, can reach it over the local network or Tailscale, each with its own
 * key. PERRY_HOST (in .env.local, or the environment) narrows it:
 * 127.0.0.1 for this computer alone. Perry's own runner and pet reach it at
 * 127.0.0.1, so that, or 0.0.0.0, are the two that make sense.
 */
const HOST = process.env.PERRY_HOST ?? readEnvFile().PERRY_HOST;
const loopbackOnly = () => /^(127\.0\.0\.1|localhost|::1)$/.test(HOST ?? "");

const dashboardUrl = (host = "localhost") => `http://${host}:${PORT}`;

/**
 * The dashboard on this machine's other addresses, for opening it from a phone
 * or another computer: its Tailscale one (100.64.0.0/10) marked as such, and
 * its LAN addresses. The dashboard listens on all of them, unless PERRY_HOST
 * has it listen on this computer alone.
 */
function networkUrls(): string[] {
  if (loopbackOnly()) return [];
  return reachableAddresses().map(({ address, tailscale }) => `${dashboardUrl(address)}${tailscale ? dim(" (Tailscale)") : ""}`);
}

/** Where the dashboard is: on this machine, then its other addresses on one line, for a phone or another computer. */
function sayWhere(label: string) {
  say(`  ${label}  ${dashboardUrl()}`);
  sayAlso(" ".repeat(label.replace(/\x1b\[[0-9;]*m/g, "").length + 2));
}

function sayAlso(indent: string) {
  const others = networkUrls();
  if (others.length) say(`  ${indent}${dim("also")} ${others.join(dim(", "))}`);
}

export async function dashboardUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => Promise<boolean>, seconds: number): Promise<boolean> {
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

/** Run in the background, so the spinner turns while Next.js builds. What it said on failing also goes in `log`, when given. */
async function build(log?: string[]): Promise<boolean> {
  const building = await spinner("Building the dashboard, a minute or so…");
  const built = await run(nodePath(), [NEXT_CLI, "build"], { cwd: REPO });
  if (built.code !== 0) {
    building.fail(red("The dashboard build failed:"));
    say(dim(tail(built.output)));
    log?.push(tail(built.output));
    return false;
  }
  building.succeed("dashboard built");
  return true;
}

/** Node runs the dashboard; Next.js is not built for Bun's runtime. */
export function nodePath(): string {
  const found = process.platform === "win32" ? exec(["where", "node"], { quiet: true }) : exec(["which", "node"], { quiet: true });
  const first = found.code === 0 ? found.output.split(/\r?\n/)[0].trim() : "";
  return first || "node";
}

// --- perry run: the runner and the dashboard, kept running ------------------

type Managed = { name: string; argv: string[]; env: NodeJS.ProcessEnv; proc?: ChildProcess; failures: number; startedAt: number; retry?: ReturnType<typeof setTimeout> };

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
  if (!existsSync(BUILD_ID) && !(await build())) process.exit(1);
  // A runner.json from before Perry's port moved (3000) names this computer at the old one: the runner
  // would start there, fail, and wait on the server to put it right (server/index.ts pairThisMachine).
  const runnerConfig = readRunnerConfig();
  const here = `http://127.0.0.1:${PORT}`;
  if (runnerConfig.url && runnerConfig.url !== here && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(runnerConfig.url)) {
    writeRunnerConfig({ ...runnerConfig, url: here });
  }

  const stamp = () => new Date().toISOString().slice(11, 19);
  const children: Managed[] = [
    { name: "runner", argv: [process.execPath, join(REPO, "runner", "index.ts")], env: childEnv, failures: 0, startedAt: 0 },
    // PERRY_BUN: the dashboard can start `perry pet` itself (Settings → Desktop pet), and Bun runs it.
    // PERRY_SUPERVISOR: this process, which does the updates the dashboard asks for (convex/updates.ts).
    { name: "dashboard", argv: [nodePath(), NEXT_CLI, "start", "-p", String(PORT), ...(HOST ? ["-H", HOST] : [])], env: { ...childEnv, NODE_ENV: "production", PERRY_PORT: String(PORT), PERRY_BUN: process.execPath, PERRY_SUPERVISOR: String(process.pid) }, failures: 0, startedAt: 0 },
  ];
  let stopping = false;
  // Stopped for an update: not started again until it is done.
  let paused = false;
  let updating = false;

  const launch = (child: Managed) => {
    child.startedAt = Date.now();
    const proc = spawn(child.argv[0], child.argv.slice(1), { cwd: REPO, env: child.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.proc = proc;
    const prefix = (chunk: Buffer) => chunk.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => `${stamp()} [${child.name}] ${line}\n`).join("");
    proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
    proc.stderr?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
    proc.on("error", (error) => process.stdout.write(`${stamp()} [${child.name}] could not start: ${error.message}\n`));
    proc.on("exit", (code) => {
      if (stopping || paused) return;
      // One that ran a while and then died starts again at once; one that keeps dying backs off, to 5 minutes.
      child.failures = Date.now() - child.startedAt > 60_000 ? 0 : child.failures + 1;
      const wait = Math.min(300, 2 ** child.failures) * 1000;
      process.stdout.write(`${stamp()} [perry] ${child.name} exited (${code ?? "signal"}); starting it again in ${wait / 1000}s\n`);
      child.retry = setTimeout(() => { if (!stopping && !paused) launch(child); }, wait);
    });
  };

  /** Both stopped, and gone: an update replaces files they have open. */
  const pause = () => {
    paused = true;
    return Promise.all(children.map((child) => new Promise<void>((resolveEnded) => {
      clearTimeout(child.retry);
      const proc = child.proc;
      if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return resolveEnded();
      const timer = setTimeout(() => { try { process.kill(proc.pid!, "SIGKILL"); } catch {} resolveEnded(); }, 15_000);
      proc.once("exit", () => { clearTimeout(timer); resolveEnded(); });
      killTree(proc.pid);
    })));
  };
  const resume = () => {
    paused = false;
    for (const child of children) {
      child.failures = 0;
      launch(child);
    }
  };
  // An update the dashboard asked for, looked for every couple of seconds.
  setInterval(() => {
    if (updating || stopping || !existsSync(PATHS.updateRequest)) return;
    updating = true;
    const note = (line: string) => process.stdout.write(`${stamp()} [perry] ${line}\n`);
    void selfUpdate({ pause, resume, note })
      .catch((error) => note(`the update stopped: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        updating = false;
        if (paused && !stopping) resume();
      });
  }, 2_000);

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

// --- Updates Perry does on himself ---------------------------------------------

/** A request this old, found as `perry run` starts, is from long ago: no surprise update now. */
const REQUEST_TTL_MS = 10 * 60_000;

/**
 * An update the dashboard asked for (update-request.json, written by
 * convex/updates.ts), done here rather than by the dashboard's server, which
 * it stops. It is `perry update`, in steps: first, while Perry still runs,
 * whether there is anything to do; then the runner and the dashboard stopped,
 * the checkout moved forward to what was checked, packages installed, the
 * dashboard built, and both started again; then the desktop pet. How it went
 * is left in update-result.json before the dashboard starts, for it to show.
 *
 * If installing or building fails, the checkout goes back to the commit it was
 * on (git reset --keep, which never touches changes of the owner's), with that
 * commit's packages and the build it was running, set aside before the new one
 * was made (built again only if that is gone): Perry comes back as he was, and
 * the dashboard says what failed.
 *
 * This process's own code stays what it was until it next starts (the next
 * login, or perry stop and perry start); the runner and the dashboard are new.
 */
async function selfUpdate({ pause, resume, note }: { pause: () => Promise<unknown>; resume: () => void; note: (line: string) => void }) {
  let request: UpdateRequest | null = null;
  try { request = JSON.parse(readFileSync(PATHS.updateRequest, "utf8")); } catch {}
  // Taken now, so whatever happens it is not done twice.
  rmSync(PATHS.updateRequest, { force: true });
  if (!request?.id) return note("left an update request that could not be read");
  const asked = request;
  const log: string[] = [];
  const say = (line: string) => { note(line); log.push(line); };
  const record = (outcome: Omit<UpdateResult, "id" | "by" | "at" | "log">) => {
    const result: UpdateResult = { id: asked.id, by: asked.by, at: Date.now(), ...outcome, log: tail(log.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), 40) };
    writeFileSync(PATHS.updateResult, `${JSON.stringify(result, null, 2)}\n`);
  };
  if (Date.now() - asked.at > REQUEST_TTL_MS) return record({ ok: false, error: "The update was asked for too long ago, so Perry left it. Ask again." });

  say(asked.by === "nightly" ? "updating Perry, as planned for the night" : "updating Perry, as asked from the dashboard");
  // Nothing stops for an update that cannot happen.
  const before = await standing(REPO);
  if (before.problem) {
    say(before.problem);
    return record({ ok: false, from: before.head, error: before.problem });
  }
  if (!before.behind || !before.head || !before.latest) {
    say("already the latest");
    return record({ ok: true, from: before.head, to: before.head });
  }
  const from = before.head;
  const target = before.latest;
  say(`${before.behind} new ${before.behind === 1 ? "change" : "changes"}, the newest "${target.title}"; stopping the runner and the dashboard`);

  /** A step, its output kept for the record: null when it went well, else what failed. */
  const step = async (what: string, argv: string[]): Promise<string | null> => {
    say(what);
    const ran = await runIn(argv);
    if (ran.code === 0) return null;
    log.push(tail(ran.output));
    return `${what[0].toUpperCase()}${what.slice(1)} failed`;
  };
  const install = () => step("installing packages", tool("pnpm", ["install", "--frozen-lockfile"]));
  const rebuild = async () => (await build(log)) ? null : "The dashboard didn't build";
  // The build Perry runs now is set aside, not copied (a rename costs no disk), with its compiler
  // cache left for the new build; a failed build is undone by putting it back rather than building again.
  const running = join(REPO, ".next");
  const kept = join(REPO, "node_modules", ".cache", "perry-previous-build");
  const setAside = () => {
    try {
      rmSync(kept, { recursive: true, force: true });
      if (!existsSync(join(running, "BUILD_ID"))) return false;
      mkdirSync(dirname(kept), { recursive: true });
      renameSync(running, kept);
    } catch {
      // Left where it is, the build is made over it, and going back builds again.
      return false;
    }
    try {
      if (existsSync(join(kept, "cache"))) {
        mkdirSync(running, { recursive: true });
        renameSync(join(kept, "cache"), join(running, "cache"));
      }
    } catch {}
    return true;
  };
  const putBack = () => {
    try {
      rmSync(running, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      renameSync(kept, running);
      say("put the build Perry was running back");
      return true;
    } catch (error) {
      say(`could not put the old build back: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  let outcome: Omit<UpdateResult, "id" | "by" | "at" | "log"> = { ok: false, from, to: target.sha, title: target.title };
  await pause();
  let asideNow = false;
  try {
    // To the commit that was checked, and only forward; it was fetched, so this needs no network.
    const moved = await step("moving to the latest", tool("git", ["merge", "--ff-only", target.sha]));
    const failed = moved ?? (await install()) ?? ((asideNow = setAside()), await rebuild());
    if (moved) {
      outcome.error = `${moved}. Nothing was changed.`;
    } else if (failed) {
      say(failed);
      // The old code, its packages, and its build: the one set aside, or one made again if that is gone.
      const back = (await step(`going back to ${from.slice(0, 7)}`, tool("git", ["reset", "--keep", from]))) ?? (await install())
        ?? ((asideNow && putBack()) || existsSync(BUILD_ID) ? null : await rebuild());
      outcome.error = back ? `${failed}, and going back failed too (${back}). Run perry update in Perry's folder.` : `${failed}. Perry went back to the version he was on.`;
    } else {
      rmSync(kept, { recursive: true, force: true });
      outcome = { ...outcome, ok: true };
      say(`updated to ${target.sha.slice(0, 7)}; perry run itself keeps its old code until Perry next starts`);
    }
  } catch (error) {
    outcome.error = `The update stopped: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // Before the dashboard starts, so the first thing it reads is how this went.
    record(outcome);
    resume();
  }
  if (!outcome.ok) return;
  // The desktop pet, when there is one, is its own install, and shows the page just rebuilt.
  await waitFor(dashboardUp, 120);
  try {
    const pet = await import("./pet");
    await pet.refresh({ restart: pet.changedSince(from) });
  } catch (error) {
    note(`could not update the desktop pet: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  say(dim(`  Open a new terminal to use the ${bold("perry")} command anywhere.`));
  return true;
}

function unlink() {
  rmSync(join(BIN_DIR, "perry"), { force: true });
  rmSync(join(BIN_DIR, "perry.cmd"), { force: true });
}

/** Take out what put Perry on PATH: the installer's and link()'s lines in shell files, or the entry in the user's PATH on Windows. */
function unlinkPath() {
  if (process.platform === "win32") {
    // Read and written raw, as link() does, so the rest of PATH is kept exactly as it was.
    const ps = [
      `$dir = '${BIN_DIR.replace(/'/g, "''")}'`,
      `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)`,
      `$path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
      `$kept = @($path -split ';' | Where-Object { $_ -and $_ -ne $dir })`,
      `if ($kept.Count -ne @($path -split ';' | Where-Object { $_ }).Count) { $key.SetValue('Path', ($kept -join ';'), $key.GetValueKind('Path')) }`,
      `$key.Close()`,
      `[Environment]::SetEnvironmentVariable('PERRY_PATH_CHANGED', '1', 'User'); [Environment]::SetEnvironmentVariable('PERRY_PATH_CHANGED', $null, 'User')`,
    ].join("; ");
    const cleared = exec(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { quiet: true });
    if (cleared.code !== 0) say(yellow(`  Could not take ${BIN_DIR} off your PATH: ${cleared.output}`));
    return;
  }
  for (const name of [".zshrc", ".bashrc", ".profile"]) {
    const file = join(homedir(), name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const kept = text.split("\n").filter((line) => !line.includes("# added by Perry"));
    if (kept.length === text.split("\n").length) continue;
    writeFileSync(file, kept.join("\n"));
    say(dim(`  remove Perry's PATH line from ~/${name}`));
  }
}

/** Changes or commits in the checkout that exist nowhere else, described; null when there are none. */
function localWork(): string | null {
  if (!existsSync(join(REPO, ".git"))) return null;
  const changed = exec(tool("git", ["status", "--porcelain"]), { quiet: true });
  if (changed.code === 0 && changed.output) return "changes that are not committed";
  // No upstream (a branch never pushed) counts as unpushed too.
  const ahead = exec(tool("git", ["rev-list", "--count", "@{upstream}..HEAD"]), { quiet: true });
  if (ahead.code !== 0 || Number(ahead.output) > 0) return "commits that are not pushed";
  return null;
}

/** Delete a folder, saying so; on Windows a file still open elsewhere can keep it, which is reported rather than fatal. */
function removeFolder(dir: string, what: string): boolean {
  if (!existsSync(dir)) return true;
  say(dim(`  remove ${dir}  (${what})`));
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    return true;
  } catch (error) {
    say(yellow(`  Could not remove all of ${dir}: ${(error as Error).message}. Delete it yourself once nothing is using it.`));
    return false;
  }
}

/**
 * `perry uninstall`. The owner picks: keep Perry's files, so `perry start`
 * (from the checkout) brings it back as it was, or remove them from this
 * computer too, which deletes everything Perry knows: its database is in
 * ~/.perry. Neither touches the tools Perry uses (Node, pnpm, Bun, Codex), nor
 * a Convex deployment an install from before the local backend still has.
 */
async function uninstall(args: string[]): Promise<boolean> {
  const home = HOME.replace(homedir(), "~");
  const repo = REPO.replace(homedir(), "~");
  // Read before anything is deleted: an install never moved off Convex still has its data there.
  const convex = readEnvFile().CONVEX_DEPLOYMENT?.replace(/\s+#.*$/, "");
  let choice = args.includes("--keep-files") ? "1" : args.includes("--remove-files") ? "2" : "";

  say(`\n${bold("Uninstall Perry")}`);
  say(`\n  ${bold("1")}  Stop Perry, and keep everything`);
  say(dim(`     It stops starting at login and the perry command goes. Perry itself (${repo}) and all`));
  say(dim(`     it knows (${home}) stay, so it can be started again as it was.`));
  say(`\n  ${bold("2")}  Remove Perry from this computer, and everything it knows`);
  say(dim(`     The same, and deletes ${repo} (with .env.local, which holds your dashboard key) and`));
  say(dim(`     ${home}, which is ${yellow("all of Perry's data")}: your chats, memory, USER.md, tasks and jobs,`));
  say(dim(`     files Perry made, files you attached in chat, its skills, logs and workspace, and any`));
  say(dim(`     Node or npm packages installed just for Perry. There is no other copy; to keep one,`));
  say(dim(`     back up ${home} first.`));
  say(dim(`\n  Either way Node, pnpm, Bun and Codex stay installed.`));
  if (convex) say(dim(`  This install still has data on Convex (${convex}); neither choice touches it.`));

  if (!choice) {
    if (!process.stdin.isTTY) {
      say(red(`\n  Choose one: perry uninstall --keep-files, or perry uninstall --remove-files.\n`));
      return false;
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (choice !== "1" && choice !== "2") {
        choice = (await rl.question(`\n  Choose 1 or 2 (Ctrl+C to cancel): `)).trim();
      }
      if (choice === "2") {
        const sure = (await rl.question(`  This deletes ${repo} and ${home}, with all your chats and memory, for good. Type ${bold("remove")} to go ahead: `)).trim().toLowerCase();
        if (sure !== "remove") {
          say(`\n  Nothing was changed.\n`);
          return false;
        }
      }
    } finally {
      rl.close();
    }
  }

  const { uninstall: removeService } = await import("./service");
  removeService();
  const pet = await import("./pet");
  if (pet.installed()) await pet.off();
  // The computer no longer needs waking for Perry.
  const wakeLeft = await (await import("../server/wake")).setWakeTimer(null);
  if (wakeLeft) say(yellow(`  ${wakeLeft}`));
  unlink();
  if (choice === "1") {
    say(dim(`  Removed the perry command from ${BIN_DIR}. Perry itself is kept at ${REPO}, and its data in ${HOME}.`));
    say(dim(`  To start it again: bun --cwd "${REPO}" scripts/perry.ts start\n`));
    return true;
  }

  // A checkout with work in it (someone developing Perry) is never deleted: only what git already has elsewhere goes.
  const unsaved = localWork();
  if (unsaved) say(yellow(`  Keeping ${REPO}: it has ${unsaved}. Delete it yourself if you do not need it.`));
  // Nothing may be working inside what is about to go (Windows will not delete a folder that is a process's cwd).
  process.chdir(homedir());
  unlinkPath();
  const removed = [unsaved ? true : removeFolder(REPO, "Perry itself"), removeFolder(HOME, "its data on this computer")].every(Boolean);
  say(!removed ? `\n  ${yellow("Perry is mostly removed; see above for what is left.")}`
    : unsaved ? `\n  ${green("Perry is removed from this computer,")} except its checkout at ${REPO}, kept for your work in it.`
      : `\n  ${green("Perry is removed from this computer.")}`);
  if (convex) say(dim(`  Its Convex deployment (${convex}) is still there. Delete it at dashboard.convex.dev if you want it gone.`));
  say(dim(`  Open a new terminal so it no longer has Perry on its PATH.\n`));
  return removed;
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
    await done("dashboard opened");
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

async function start({ pet = true } = {}): Promise<boolean> {
  const { install, serviceState, serviceContext, servicePlan, runSteps } = await import("./service");
  if (!readEnvFile().DASHBOARD_KEY) {
    say(`\n${red("Perry is not set up yet.")} Run ${bold("perry setup")} first.\n`);
    return false;
  }
  if (!existsSync(BUILD_ID) && !(await build())) return false;
  const ctx = serviceContext();
  const state = serviceState(ctx);
  const ok = state.installed ? state.running || runSteps(servicePlan(ctx).start, false) : install();
  if (!ok) return false;
  const waiting = await spinner("Starting Perry…");
  const up = await waitFor(dashboardUp, 90);
  if (!up) {
    waiting.fail(yellow(`Started, but the dashboard is not answering yet. ${bold("perry logs")} says why.`));
    return false;
  }
  waiting.succeed(`running at ${dashboardUrl()}${state.installed ? "" : dim(", and from every login on")}`);
  // The desktop pet starts with Perry (and stops with him), unless `perry pet off` sent him away.
  if (pet) await (await import("./pet")).resume();
  sayAlso("  ");
  return true;
}

/** `pet: false` leaves the desktop pet as it is: `perry update` restarts Perry under him and reloads his page. */
async function stop({ quiet = false, pet = true } = {}) {
  const { serviceContext, servicePlan, runSteps, endServiceProcess } = await import("./service");
  const ctx = serviceContext();
  runSteps(servicePlan(ctx).stop, false);
  if (ctx.platform === "win32") endServiceProcess();
  if (pet) await (await import("./pet")).quit();
  if (!quiet) await done("stopped");
}

/** Perry's backend as this machine's CLI calls it: the running server, with the dashboard key. */
async function backend() {
  const { BackendClient } = await import("../client/backend");
  return new BackendClient(`http://127.0.0.1:${PORT}`, { adminKey: readEnvFile().DASHBOARD_KEY });
}

/**
 * Memories and pages (issue #210): move-back puts every memory moved into a
 * page back as it was before, for going back to a Perry from before pages;
 * move-in moves them into pages again. Perry must be running.
 */
async function brain(args: string[]): Promise<boolean> {
  const [what] = args;
  if (what !== "move-back" && what !== "move-in") {
    say("  perry brain move-back   put memories back as they were before pages");
    say("  perry brain move-in     move them into pages again");
    return what === undefined;
  }
  const client = await backend();
  try {
    if (what === "move-back") {
      const done = (await client.call<{ movedBack: number; pagesDeleted: number; journalLines?: number }>("pages:undoMigration")).value;
      const days = done.journalLines ? ` ${done.journalLines} lines of projects' Journeys are back on their own journal days.` : "";
      say(`  ${green("Done.")} ${done.movedBack} memories are back as they were; ${done.pagesDeleted} empty pages went.${days} Perry leaves them there until ${bold("perry brain move-in")}.`);
    } else {
      const done = (await client.call<{ moved: number; kept: number }>("pages:migrate", { again: true })).value;
      say(`  ${green("Done.")} ${done.moved} memories moved into pages${done.kept ? `; ${done.kept} kept as they were` : ""}.`);
    }
    return true;
  } catch (error) {
    say(`  ${red("Couldn't:")} ${error instanceof Error ? error.message : String(error)}. Is Perry running? ${bold("perry start")}`);
    return false;
  }
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
  say(`\n  To make Perry yours, send ${bold(`@${bot?.result?.username ?? "your bot"}`)} this code on Telegram ${dim("(it expires in an hour)")}:`);
  say(`\n      ${bold(green(code))}\n`);
}

/** `args` go on to setup.ts: `--engine <kind>` names the default engine without asking. */
async function setup(args: string[]) {
  const configured = exec(bunScript("setup.ts", ["--from-perry", ...args]));
  if (configured.code !== 0) process.exit(configured.code);

  if (!(await build())) process.exit(1);
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

  // An engine not signed in was said by setup.ts, where it was checked.
  link();
  await open();
  say(dim(`  perry status | logs | stop | start | open | update | doctor\n`));
}

/** One question on this terminal. */
async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

async function update() {
  say(`\n${bold("Updating Perry")}`);
  // Where it was, to tell afterwards whether the desktop pet's own files changed.
  const from = existsSync(join(REPO, ".git")) ? exec(tool("git", ["rev-parse", "HEAD"]), { quiet: true }).output?.trim() : undefined;
  if (existsSync(join(REPO, ".git"))) {
    const pulling = await spinner("Getting the latest Perry…");
    const pulled = await runIn(tool("git", ["pull", "--ff-only"]));
    if (pulled.code !== 0) {
      pulling.fail(red("git pull failed; commit or stash local changes, then try again."));
      say(dim(tail(pulled.output, 6)));
      process.exit(1);
    }
    pulling.succeed(/Already up to date/i.test(pulled.output) ? "already the latest" : "got the latest");
  }
  const installing = await spinner("Installing packages…");
  const installed = await runIn(tool("pnpm", ["install", "--frozen-lockfile"]));
  if (installed.code !== 0) {
    installing.fail(red("pnpm install failed:"));
    say(dim(tail(installed.output)));
    process.exit(1);
  }
  installing.succeed("packages installed");
  // The backend is part of the dashboard's server, so the new build is all there is to deploy;
  // its database moves forward on its own when the server starts.
  // The running dashboard serves from the build, so it stops while a new one is made.
  const { serviceState } = await import("./service");
  const wasRunning = serviceState().running;
  if (wasRunning) await stop({ quiet: true, pet: false });
  if (!(await build())) process.exit(1);
  if (wasRunning && !(await start({ pet: false }))) process.exit(1);
  // The desktop pet, when there is one, is its own install, and shows the page just rebuilt, or starts again on his new files.
  const pet = await import("./pet");
  await pet.refresh({ restart: pet.changedSince(from) });
  if (!wasRunning) say(dim(`  Perry was not running; ${bold("perry start")} starts it.`));
  say("");
}

const HELP = `
  ${bold("perry")} setup | start | stop | status | logs [-f] | open | update | migrate | doctor | pair | pet | brain | run | uninstall

  ${bold("setup")}      set Perry up (or check it), start it in the background, open the dashboard;
             ${bold("--engine")} codex|claude|grok|antigravity picks the default engine without asking
  ${bold("start")}      start Perry in the background, from now on at every login
  ${bold("stop")}       stop it
  ${bold("status")}     whether it is running, and where
  ${bold("logs")}       what it has been saying; -f to follow
  ${bold("open")}       open the dashboard, already unlocked
  ${bold("update")}     pull the latest Perry, install, rebuild, restart
  ${bold("migrate")}    bring chats and memory over from Convex, where Perry used to keep them
  ${bold("doctor")}     check this machine and Perry's server
  ${bold("pair")}       a new code to claim Perry on Telegram
  ${bold("pet")}        Perry on your desktop, with your to-dos; ${bold("pet off")} to stop him
  ${bold("brain")}      ${bold("brain move-back")} puts memories back as they were before pages; ${bold("brain move-in")} moves them in again
  ${bold("run")}        run Perry in this terminal instead of the background
  ${bold("uninstall")}  stop Perry; keep its files, or remove them from this computer
`;

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  switch (command) {
    case "setup": return setup(rest);
    case "start": return process.exit((await start()) ? 0 : 1);
    case "stop": return stop();
    case "status": return status();
    case "logs": return process.exit(exec(bunScript("service.ts", ["logs", ...rest])).code);
    case "open": return process.exit((await open()) ? 0 : 1);
    case "update": return update();
    case "doctor": return process.exit(exec(bunScript("doctor.ts", rest)).code);
    case "pair": return process.exit(exec(bunScript("pair.ts")).code);
    case "migrate": return process.exit(exec(bunScript("migrate.ts", rest)).code);
    case "pet": return process.exit((await (await import("./pet")).pet(rest)) ? 0 : 1);
    case "brain": return process.exit((await brain(rest)) ? 0 : 1);
    case "run": return runForeground();
    case "link": return process.exit(link() ? 0 : 1);
    case "uninstall": return process.exit((await uninstall(rest)) ? 0 : 1);
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
