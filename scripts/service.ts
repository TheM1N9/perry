#!/usr/bin/env bun
/**
 * `pnpm run service <install|uninstall|start|stop|status|logs>` — keep Perry
 * (the runner and the dashboard, under `perry run`) running in the
 * background, and start it again when you log in. `perry start`, `stop`,
 * `status` and `logs` use this.
 *
 * Each OS's own service manager does the work, as a per-user service that
 * needs no admin rights:
 *
 *   macOS    a launchd agent        ~/Library/LaunchAgents/com.perry.runner.plist
 *   Linux    a systemd user unit    ~/.config/systemd/user/perry-runner.service
 *   Windows  a Task Scheduler task  "Perry runner", at logon
 *
 * The service runs `bun scripts/perry.ts run` from this checkout. Perry's
 * server connects this computer the first time it starts, writing
 * ~/.perry/runner.json. A service has no terminal, so approvals are answered in the
 * dashboard. The names still say "runner", so an older install is replaced in
 * place rather than left running beside the new one.
 *
 * --dry-run prints the files and commands instead of writing or running them.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, PATHS } from "../runner/home";
import { bold, dim, green, red, yellow } from "./lib";

export const LABEL = "com.perry.runner";
export const UNIT = "perry-runner.service";
export const TASK = process.env.PERRY_SERVICE_TASK ?? "Perry runner";

/** Settings a service does not inherit from the shell it was installed from. */
const CARRIED_ENV = ["PERRY_HOME", "PERRY_PORT", "PERRY_HOST", "PERRY_SERVICE_TASK", "PERRY_CODEX_SANDBOX", "PERRY_CODEX_WINDOWS_SANDBOX", "CODEX_HOME"];

type Step = { argv: string[]; mayFail?: boolean; retries?: number };
export type ServiceFile = { path: string; content: string; encoding?: "utf8" | "utf16le" };
export type ServiceState = { installed: boolean; running: boolean; detail: string };

/** Everything a service needs to know about this machine and checkout; the plan is built from it alone. */
export type ServiceContext = {
  platform: NodeJS.Platform;
  repo: string;
  bun: string;
  home: string;
  userHome: string;
  logFile: string;
  env: Record<string, string>;
  /** DOMAIN\user on Windows, the uid elsewhere. */
  user: string;
};

export type ServicePlan = {
  manager: string;
  files: ServiceFile[];
  install: Step[];
  uninstall: Step[];
  start: Step[];
  stop: Step[];
  /** The service manager's own log command, where it keeps one; otherwise the log file is read. */
  logs?: (follow: boolean) => string[];
};

export function serviceContext(): ServiceContext {
  const env: Record<string, string> = {};
  // launchd and systemd start services with a bare PATH, where bun and codex are not.
  if (process.platform !== "win32" && process.env.PATH) env.PATH = process.env.PATH;
  for (const name of CARRIED_ENV) if (process.env[name]) env[name] = process.env[name]!;
  return {
    platform: process.platform,
    repo: process.cwd(),
    bun: process.execPath,
    home: HOME,
    userHome: homedir(),
    logFile: join(PATHS.logs, "runner.log"),
    env,
    user: process.platform === "win32"
      ? `${process.env.USERDOMAIN ?? ""}${process.env.USERDOMAIN ? "\\" : ""}${process.env.USERNAME ?? userInfo().username}`
      : String(process.getuid?.() ?? userInfo().uid),
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** A quoted systemd word, with % doubled so it is not a specifier; ExecStart also expands $. */
const unitWord = (s: string, exec = false) => {
  const quoted = `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  return exec ? quoted.replace(/\$/g, "$$$$") : quoted;
};

export function servicePlan(ctx: ServiceContext): ServicePlan {
  // The target OS's separators, so a plan for any OS can be built and checked on any other.
  const { join } = ctx.platform === "win32" ? win32 : posix;
  // The runner and the dashboard together. No policy flag: the access chosen on the dashboard stands across restarts.
  const args = [join(ctx.repo, "scripts", "perry.ts"), "run"];

  if (ctx.platform === "darwin") {
    const plist = join(ctx.userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
    const domain = `gui/${ctx.user}`;
    const env = Object.entries(ctx.env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
    return {
      manager: "launchd",
      files: [{
        path: plist,
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Perry: its runner and dashboard. Written by \`perry start\`; removed by \`perry uninstall\`. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[ctx.bun, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(ctx.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restarted after a crash; a clean stop (exit 0) stays stopped. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(ctx.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(ctx.logFile)}</string>
</dict>
</plist>
`,
      }],
      install: [
        { argv: ["launchctl", "bootout", `${domain}/${LABEL}`], mayFail: true },
        // bootout returns before the old agent is gone, and bootstrap fails until it is.
        { argv: ["launchctl", "bootstrap", domain, plist], retries: 5 },
      ],
      uninstall: [{ argv: ["launchctl", "bootout", `${domain}/${LABEL}`], mayFail: true }],
      start: [{ argv: ["launchctl", "kickstart", `${domain}/${LABEL}`] }],
      stop: [{ argv: ["launchctl", "kill", "SIGTERM", `${domain}/${LABEL}`] }],
    };
  }

  if (ctx.platform === "win32") {
    const dir = join(ctx.home, "service");
    const launcher = join(dir, "runner.exe");
    const taskXml = join(dir, "task.xml");
    // Ending a task does not end the processes it started, so `perry run` notes its PID for `perry stop`.
    const env = { ...ctx.env, PERRY_SERVICE_PID_FILE: join(dir, "runner.pid") };
    const mutex = `Local\\Perry-${createHash("sha256").update(ctx.home.toLowerCase()).digest("hex").slice(0, 24)}`;
    return {
      manager: "Task Scheduler",
      files: [
        {
          path: join(dir, "runner.xml"),
          // Direct CreateProcess arguments: no cmd/PowerShell expansion of %, &, $ or Unicode paths.
          content: `<?xml version="1.0" encoding="UTF-8"?>
<Launcher>
  <Program>${xml(ctx.bun)}</Program>
  <Arguments>${xml(`"${args[0]}" run --background`)}</Arguments>
  <WorkingDirectory>${xml(ctx.repo)}</WorkingDirectory>
  <LogFile>${xml(ctx.logFile)}</LogFile>
  <Mutex>${xml(mutex)}</Mutex>
  <Environment>
${Object.entries(env).map(([k, v]) => `    <Variable name="${xml(k)}">${xml(v)}</Variable>`).join("\n")}
  </Environment>
</Launcher>
`,
        },
        {
          path: taskXml,
          encoding: "utf16le",
          // Task Scheduler's defaults would stop the runner after 72 hours and on battery.
          content: `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Perry: its runner, which lets Perry work on this machine, and its dashboard. Written by perry start.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(ctx.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(ctx.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(launcher)}</Command>
      <WorkingDirectory>${xml(ctx.repo)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`,
        },
      ],
      install: [
        { argv: ["schtasks", "/Create", "/TN", TASK, "/XML", taskXml, "/F"] },
        { argv: ["schtasks", "/Run", "/TN", TASK] },
      ],
      uninstall: [
        { argv: ["schtasks", "/End", "/TN", TASK], mayFail: true },
        { argv: ["schtasks", "/Delete", "/TN", TASK, "/F"], mayFail: true },
      ],
      start: [{ argv: ["schtasks", "/Run", "/TN", TASK] }],
      stop: [{ argv: ["schtasks", "/End", "/TN", TASK], mayFail: true }],
    };
  }

  // Linux, and anything else with systemd.
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(ctx.userHome, ".config"), "systemd", "user");
  const systemctl = (...rest: string[]) => ["systemctl", "--user", ...rest];
  return {
    manager: "systemd",
    files: [{
      path: join(unitDir, UNIT),
      content: [
        "# Perry: its runner and dashboard. Written by `perry start`; removed by `perry uninstall`.",
        "[Unit]",
        "Description=Perry (runner and dashboard)",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${ctx.repo.replace(/%/g, "%%")}`,
        `ExecStart=${[ctx.bun, ...args].map((word) => unitWord(word, true)).join(" ")}`,
        ...Object.entries(ctx.env).map(([k, v]) => `Environment=${unitWord(`${k}=${v}`)}`),
        // A crash restarts it; `perry stop` does not.
        "Restart=on-failure",
        "RestartSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    }],
    install: [
      { argv: systemctl("daemon-reload") },
      { argv: systemctl("enable", UNIT) },
      { argv: systemctl("restart", UNIT) },
    ],
    uninstall: [{ argv: systemctl("disable", "--now", UNIT), mayFail: true }],
    start: [{ argv: systemctl("start", UNIT) }],
    stop: [{ argv: systemctl("stop", UNIT) }],
    logs: (follow) => ["journalctl", "--user", "-u", UNIT, "-n", "200", "--no-pager", ...(follow ? ["-f"] : [])],
  };
}

function exec(argv: string[], quiet = true) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: quiet ? "pipe" : "inherit", windowsHide: true });
  return { code: result.status ?? (result.error ? 127 : 1), output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || String(result.error?.message ?? "") };
}

/** Windows process identity, shared by the service PID file and supervisor lock. */
export function supervisorIdentity(pid: number, ctx = serviceContext(), verifyCommand = true): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const command = !verifyCommand ? "" : ` -and $p.CommandLine.Contains(${quote(win32.join(ctx.repo, "scripts", "perry.ts"))}) -and $p.CommandLine -match '(?:^|\\s)"?run"?(?:\\s|$)'`;
  const script = `$ProgressPreference = 'SilentlyContinue'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p -and $p.ExecutablePath -eq ${quote(ctx.bun)}${command}) { '${pid} ' + $p.CreationDate.ToUniversalTime().Ticks }`;
  const found = exec(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  return found.code === 0 && /^\d+ \d+$/.test(found.output) ? found.output : null;
}

/** A live Windows supervisor, verified against its executable, script and birth time. */
export function servicePid(ctx = serviceContext(), file = join(ctx.home, "service", "runner.pid"), supervisorLock = false): number | null {
  try {
    const record = readFileSync(file, "utf8").trim();
    const parts = /^(\d+)(?: (\d+))?$/.exec(record);
    if (!parts) return null;
    const pid = Number(parts[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    // A timestamped supervisor lock identifies its exact owner even when the
    // foreground command used a relative script path. PID-only legacy locks
    // and service stop always require the absolute executable/script guard.
    const identity = supervisorIdentity(pid, ctx, !supervisorLock || !parts[2]);
    if (!identity) return null;
    // WMI's creation timestamp has microsecond precision; StartTime's FILETIME has 100 ns precision.
    if (parts[2]) {
      const delta = BigInt(identity.split(" ")[1]) - BigInt(parts[2]);
      if (delta <= -10n || delta >= 10n) return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/** What the service manager says, in a word or two. Reads only. */
export function serviceState(ctx = serviceContext()): ServiceState {
  const plan = servicePlan(ctx);
  const installed = existsSync(plan.files[0].path);
  if (ctx.platform === "darwin") {
    const printed = exec(["launchctl", "print", `gui/${ctx.user}/${LABEL}`]);
    if (printed.code !== 0) return { installed, running: false, detail: installed ? "installed, not loaded" : "not installed" };
    const state = printed.output.match(/^\s*state = (\S+)/m)?.[1] ?? "unknown";
    const pid = printed.output.match(/^\s*pid = (\d+)/m)?.[1];
    return { installed: true, running: state === "running", detail: pid ? `${state}, pid ${pid}` : state };
  }
  if (ctx.platform === "win32") {
    const registered = exec(["schtasks", "/Query", "/TN", TASK]).code === 0;
    // schtasks words its status in the system language; the runner's PID file does not.
    const pid = servicePid(ctx);
    return {
      installed: registered,
      running: registered && pid !== null,
      detail: !registered ? "not installed" : pid ? `running, pid ${pid}` : "installed, not running",
    };
  }
  const shown = exec(["systemctl", "--user", "show", UNIT, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID"]);
  if (shown.code !== 0) return { installed, running: false, detail: `systemctl --user is unavailable: ${shown.output.split("\n")[0]}` };
  const field = (name: string) => shown.output.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "";
  const loaded = field("LoadState") === "loaded";
  const pid = field("MainPID");
  return {
    installed: loaded,
    running: field("ActiveState") === "active",
    detail: loaded ? `${field("ActiveState")} (${field("SubState")})${pid && pid !== "0" ? `, pid ${pid}` : ""}` : "not installed",
  };
}

/** Run a plan's commands, quietly: a dry run lists them, and a failure says which one and why. */
export function runSteps(steps: Step[], dryRun: boolean): boolean {
  for (const step of steps) {
    const shown = `$ ${step.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;
    if (dryRun) { console.log(dim(`  ${shown}`)); continue; }
    let result = exec(step.argv);
    for (let retry = 0; result.code !== 0 && retry < (step.retries ?? 0); retry++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      result = exec(step.argv);
    }
    if (result.code !== 0 && !step.mayFail) {
      console.error(red(`  failed (${result.code}): ${shown}\n  ${result.output}`));
      return false;
    }
  }
  return true;
}

/**
 * End the Windows service's `perry run`, which outlives the task that started
 * it, with the runner, the dashboard and Codex under it: a plain kill would
 * leave those running.
 */
export function endServiceProcess() {
  const pid = servicePid();
  if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

export function install({ dryRun = false } = {}): boolean {
  const ctx = serviceContext();
  // Nothing to check for runner.json: on a new computer it does not exist yet. Perry's server writes it
  // the first time the service starts it (server/index.ts, pairThisMachine), and the runner waits for it.
  const plan = servicePlan(ctx);
  if (dryRun) console.log(`\n${bold(`Installing Perry as a ${plan.manager} service`)}${dim("  (dry run: nothing is written or run)")}`);
  if (ctx.platform === "win32") {
    const dir = join(ctx.home, "service");
    const compiled = join(dir, "runner-next.exe");
    const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
    if (!dryRun) mkdirSync(dir, { recursive: true });
    // Compile first: a missing/disabled compiler leaves the existing service and configuration intact.
    if (!runSteps([{ argv: [compiler, "/nologo", "/target:winexe", `/out:${compiled}`, join(ctx.repo, "scripts", "windows-launcher.cs")] }], dryRun)) return false;
    if (!dryRun) {
      endServiceProcess();
      runSteps(plan.stop, false);
      // Task Scheduler may return from /End just before the old executable's handle closes.
      for (let retry = 0; ; retry++) {
        try { renameSync(compiled, join(dir, "runner.exe")); break; }
        catch (error) {
          if (retry === 20) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
      rmSync(join(dir, "runner.cmd"), { force: true });
    }
  }
  for (const file of plan.files) {
    if (dryRun) {
      console.log(dim(`  write ${file.path}`));
      console.log(file.content.split(/\r?\n/).map((line) => dim(`  | ${line}`)).join("\n"));
      continue;
    }
    mkdirSync(dirname(file.path), { recursive: true });
    const content = file.encoding === "utf16le" ? Buffer.from(`\ufeff${file.content}`, "utf16le") : file.content;
    writeFileSync(file.path, content);
  }
  if (!dryRun) {
    mkdirSync(dirname(ctx.logFile), { recursive: true });
  }
  if (!runSteps(plan.install, dryRun)) return false;
  if (dryRun) return true;

  // Whoever started it says it is running; only what still needs doing is said here.
  if (ctx.platform === "linux") {
    const linger = exec(["loginctl", "show-user", userInfo().username, "-p", "Linger"]);
    if (/Linger=no/.test(linger.output)) {
      console.log(yellow(`\n  It stops when you log out. To keep it running, and start it at boot:`));
      console.log(`    loginctl enable-linger ${userInfo().username}`);
    }
  }
  return true;
}

export function uninstall({ dryRun = false } = {}): boolean {
  const ctx = serviceContext();
  const plan = servicePlan(ctx);
  if (dryRun) console.log(`\n${bold(`Removing the ${plan.manager} service`)}`);
  runSteps(plan.uninstall, dryRun);
  for (const file of plan.files) {
    if (dryRun) console.log(dim(`  remove ${file.path}`));
    else rmSync(file.path, { force: true });
  }
  if (!dryRun && ctx.platform === "win32") endServiceProcess();
  if (!dryRun && ctx.platform === "win32") {
    for (const name of ["runner.exe", "runner-next.exe", "runner.cmd", "runner.pid"]) rmSync(join(ctx.home, "service", name), { force: true });
  }
  if (!dryRun && ctx.platform === "linux") exec(["systemctl", "--user", "daemon-reload"]);
  return true;
}

function tail(file: string, follow: boolean) {
  if (!existsSync(file)) {
    console.log(dim(`  No log yet at ${file}.`));
    if (!follow) return;
  }
  let offset = 0;
  const show = () => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const text = readFileSync(file).subarray(offset).toString("utf8");
    offset = size;
    process.stdout.write(text);
  };
  if (existsSync(file)) {
    const lines = readFileSync(file, "utf8").split("\n");
    process.stdout.write(lines.slice(-200).join("\n"));
    offset = statSync(file).size;
  }
  if (follow) setInterval(show, 1000);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-")) ?? "status";
  const dryRun = args.includes("--dry-run");
  const ctx = serviceContext();
  const plan = servicePlan(ctx);

  if (command === "install" || command === "uninstall") {
    const ok = command === "install" ? install({ dryRun }) : uninstall({ dryRun });
    if (ok && !dryRun) console.log(`  ${green(command === "install" ? "installed" : "removed")}${dim(command === "install" ? ": it starts now and at every login" : `: Perry no longer starts on its own; ${PATHS.runnerConfig} is kept`)}`);
    process.exit(ok ? 0 : 1);
  }
  if (command === "start" || command === "stop") {
    const ok = runSteps(plan[command], dryRun);
    if (command === "stop" && !dryRun && ctx.platform === "win32") endServiceProcess();
    process.exit(ok ? 0 : 1);
  }
  if (command === "status") {
    const state = serviceState(ctx);
    console.log(`\n${bold("Perry service")}  ${dim(plan.manager)}`);
    const word = state.running ? green("running") : state.installed ? yellow("stopped") : dim("not installed");
    console.log(`  ${word}${state.detail === "not installed" ? "" : `  ${dim(state.detail)}`}`);
    console.log(dim(`  file  ${plan.files[0].path}`));
    console.log(dim(`  logs  ${plan.logs ? plan.logs(false).join(" ") : ctx.logFile}\n`));
    process.exit(0);
  }
  if (command === "logs") {
    const follow = args.includes("-f") || args.includes("--follow");
    if (plan.logs) {
      const result = exec(plan.logs(follow), false);
      process.exit(result.code);
    }
    tail(ctx.logFile, follow);
    return;
  }
  console.error(`\n  ${bold("pnpm run service")} install | uninstall | start | stop | status | logs [-f]  ${dim("[--dry-run]")}\n`);
  process.exit(1);
}

// Imported by connect, doctor and the smoke test for its parts; run only as a script.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
