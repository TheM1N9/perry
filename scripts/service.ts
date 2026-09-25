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
 * The service runs `bun scripts/perry.ts run` from this checkout with the
 * settings in ~/.perry/runner.json, so connect once first (`perry setup` does
 * it all). A service has no terminal, so approvals are answered in the
 * dashboard. The names still say "runner", so an older install is replaced in
 * place rather than left running beside the new one.
 *
 * --dry-run prints the files and commands instead of writing or running them.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, PATHS, readRunnerConfig } from "../runner/home";
import { bold, dim, green, red, yellow } from "./lib";

export const LABEL = "com.perry.runner";
export const UNIT = "perry-runner.service";
export const TASK = "Perry runner";

/** Settings a service does not inherit from the shell it was installed from. */
const CARRIED_ENV = ["PERRY_HOME", "PERRY_PORT", "PERRY_CODEX_SANDBOX", "PERRY_CODEX_WINDOWS_SANDBOX", "CODEX_HOME"];

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
/** A batch-file string: % is the only character a quoted path cannot hold as it is. */
const batch = (s: string) => `"${s.replace(/%/g, "%%")}"`;

export function servicePlan(ctx: ServiceContext): ServicePlan {
  // The target OS's separators, so a plan for any OS can be built and checked on any other.
  const { join } = ctx.platform === "win32" ? win32 : posix;
  // The runner and the dashboard together. No policy flag: the one chosen on the dashboard's Computer page stands across restarts.
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
    const launcher = join(dir, "runner.cmd");
    const taskXml = join(dir, "task.xml");
    // Ending a task does not end the processes it started, so `perry run` notes its PID for `perry stop`.
    const env = { ...ctx.env, PERRY_SERVICE_PID_FILE: join(dir, "runner.pid") };
    const envLines = Object.entries(env).map(([k, v]) => `set "${k}=${v.replace(/%/g, "%%")}"`);
    // PowerShell only hides the console window; the launcher does the rest.
    const psArgs = `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${launcher.replace(/'/g, "''")}'"`;
    return {
      manager: "Task Scheduler",
      files: [
        {
          path: launcher,
          content: [
            "@echo off",
            `rem Perry, its runner and dashboard, started at logon by the "${TASK}" task. Written by perry start.`,
            "chcp 65001 >nul",
            ...envLines,
            `cd /d ${batch(ctx.repo)}`,
            `${[ctx.bun, ...args].map(batch).join(" ")} >> ${batch(ctx.logFile)} 2>&1`,
            "",
          ].join("\r\n"),
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
      <Command>powershell.exe</Command>
      <Arguments>${xml(psArgs)}</Arguments>
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

/** The Windows service's `perry run`, if it is alive, by the PID its launcher asked it to write. */
function servicePid(): number | null {
  try {
    const pid = Number(readFileSync(join(HOME, "service", "runner.pid"), "utf8"));
    process.kill(pid, 0);
    return pid > 0 ? pid : null;
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
    const pid = servicePid();
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

export function runSteps(steps: Step[], dryRun: boolean): boolean {
  for (const step of steps) {
    console.log(dim(`  $ ${step.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`));
    if (dryRun) continue;
    let result = exec(step.argv);
    for (let retry = 0; result.code !== 0 && retry < (step.retries ?? 0); retry++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      result = exec(step.argv);
    }
    if (result.code !== 0 && !step.mayFail) {
      console.error(red(`  failed (${result.code}): ${result.output}`));
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
  const config = readRunnerConfig();
  if (!dryRun && (!config.url || !config.token)) {
    console.error(`\n${red("This computer is not connected yet.")} Run ${bold("perry setup")} first.\n`);
    return false;
  }
  const plan = servicePlan(ctx);
  console.log(`\n${bold(`Installing Perry as a ${plan.manager} service`)}${dryRun ? dim("  (dry run: nothing is written or run)") : ""}`);
  for (const file of plan.files) {
    console.log(dim(`  write ${file.path}`));
    if (dryRun) {
      console.log(file.content.split(/\r?\n/).map((line) => dim(`  | ${line}`)).join("\n"));
      continue;
    }
    mkdirSync(dirname(file.path), { recursive: true });
    const content = file.encoding === "utf16le" ? Buffer.from(`\ufeff${file.content}`, "utf16le") : file.content;
    writeFileSync(file.path, content);
  }
  if (!dryRun) {
    mkdirSync(dirname(ctx.logFile), { recursive: true });
    if (ctx.platform === "win32") endServiceProcess();
  }
  if (!runSteps(plan.install, dryRun)) return false;
  if (dryRun) return true;

  console.log(green(`  installed.`) + dim(` It starts now and whenever you log in.`));
  console.log(dim(`  Approve what Codex asks for in the dashboard; there is no terminal to ask in.`));
  console.log(dim(`  perry status | logs | stop | start | uninstall`));
  if (ctx.platform === "linux") {
    const linger = exec(["loginctl", "show-user", userInfo().username, "-p", "Linger"]);
    if (/Linger=no/.test(linger.output)) {
      console.log(yellow(`\n  It stops when you log out. To keep it running, and start it at boot:`));
      console.log(`    loginctl enable-linger ${userInfo().username}`);
    }
  }
  console.log("");
  return true;
}

export function uninstall({ dryRun = false } = {}): boolean {
  const ctx = serviceContext();
  const plan = servicePlan(ctx);
  console.log(`\n${bold(`Removing the ${plan.manager} service`)}`);
  runSteps(plan.uninstall, dryRun);
  for (const file of plan.files) {
    console.log(dim(`  remove ${file.path}`));
    if (!dryRun) rmSync(file.path, { force: true });
  }
  if (!dryRun && ctx.platform === "win32") endServiceProcess();
  if (!dryRun && ctx.platform === "linux") exec(["systemctl", "--user", "daemon-reload"]);
  console.log(dim(`  Perry no longer starts on its own. Its settings in ${PATHS.runnerConfig} are kept.\n`));
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

  if (command === "install") process.exit(install({ dryRun }) ? 0 : 1);
  if (command === "uninstall") process.exit(uninstall({ dryRun }) ? 0 : 1);
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
