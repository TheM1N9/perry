#!/usr/bin/env bun
/**
 * `pnpm run smoke` — the runner's own parts on this OS, with no deployment,
 * no Codex and no secrets, so CI can run it on Windows, macOS and Linux.
 *
 * Ways the multi-platform runner could break, and the check that catches each:
 *
 *   - The runner does not load here (an import, a Node API, a path)  → `runner --help` exits 0
 *   - Perry's home cannot be made where PERRY_HOME points, with a space
 *     or non-ASCII in the path, or runner.json does not round-trip   → home
 *   - The OS shell is wrong or missing, loses the exit code, or
 *     mangles a cwd or file name with spaces or unicode              → shell
 *   - Codex is told the wrong OS or shell                            → machine
 *   - PERRY_CODEX_SANDBOX accepts a typo, or rejects a real mode     → sandbox
 *   - share_file or an upload rejects a POSIX or Windows absolute
 *     path, accepts a relative one, or misnames a unicode file       → media paths
 *   - A service file breaks on spaces, %, $, &, quotes or unicode
 *     in paths, or keeps Task Scheduler's 72-hour limit              → service plans
 *   - This OS's service manager rejects the file it would install    → service lint
 *     (plutil on macOS, systemd-analyze on Linux; on Windows, with
 *     --register on a throwaway machine such as CI, schtasks
 *     registers, reads back and deletes a copy of the task)
 *   - `pnpm run service install --dry-run` fails or writes anything  → service dry run
 *   - The `perry` command does not load here, or `perry run` starts
 *     with no connection instead of saying to run `perry setup`      → perry command
 *
 * Not covered here: Codex itself, its sandbox and sign-in (`pnpm run doctor
 * -- --machine`), and a real chat turn (artifacts/multi-platform/run.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dim, green, red } from "./lib";

const register = process.argv.includes("--register");
const scratch = mkdtempSync(join(tmpdir(), "perry-smoke-"));
// Set before anything reads it: runner/home.ts fixes its paths on import.
process.env.PERRY_HOME = join(scratch, "perry home ü");
const { ensureHome, HOME, PATHS, readRunnerConfig, writeRunnerConfig } = await import("../runner/home");
const { describeMachine, runShell } = await import("../runner/shell");
const { sandboxMode } = await import("../runner/codex");
const { ABSOLUTE_PATH, describePath } = await import("../convex/media");
const { serviceContext, servicePlan, TASK } = await import("./service");

type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    const detail = await run();
    checks.push({ name, pass: true, detail });
    console.log(`${green("ok")}    ${name}${detail === undefined ? "" : dim(`  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`)}`);
  } catch (error) {
    checks.push({ name, pass: false, detail: (error as Error).message });
    console.log(`${red("fail")}  ${name}  ${(error as Error).message}`);
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const exec = (argv: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};
const has = (tool: string) => exec(process.platform === "win32" ? ["where", tool] : ["sh", "-c", `command -v ${tool}`]).code === 0;

console.log(`\n${process.platform} ${process.arch}, bun ${process.versions.bun}, scratch ${scratch}\n`);

await check("runner --help", () => {
  const ran = exec([process.execPath, resolve("runner", "index.ts"), "--help"]);
  expect(ran.code === 0, `exit ${ran.code}: ${ran.output}`);
  expect(ran.output.includes("Assistant runner") && ran.output.includes(HOME), "help does not name the runner and its home");
  expect(!existsSync(PATHS.runnerConfig), "--help wrote a config");
});

await check("home", () => {
  ensureHome();
  for (const dir of [PATHS.uploads, PATHS.files, PATHS.codexResults]) expect(existsSync(dir), `${dir} was not made`);
  writeRunnerConfig({ url: "https://example.convex.cloud", token: "t", dir: scratch, name: "smoke ü", auto: false });
  const back = readRunnerConfig();
  expect(back.name === "smoke ü" && back.dir === scratch, "runner.json did not round-trip");
  return HOME;
});

await check("shell", async () => {
  const cwd = join(scratch, "work dir ü");
  mkdirSync(cwd, { recursive: true });
  const echo = await runShell("echo perry-smoke", cwd);
  expect(echo.exitCode === 0 && echo.output.includes("perry-smoke"), `echo: ${JSON.stringify(echo)}`);
  const failed = await runShell("exit 3", cwd);
  expect(failed.exitCode === 3, `exit code ${failed.exitCode}, not 3`);
  const write = await runShell(process.platform === "win32" ? `echo hi> "ü file.txt"` : `printf hi > "ü file.txt"`, cwd);
  expect(write.exitCode === 0, `write: ${write.output}`);
  const written = readdirSync(cwd);
  expect(written.includes("ü file.txt"), `files: ${written.join(", ")}`);
  expect(readFileSync(join(cwd, "ü file.txt"), "utf8").trim() === "hi", "the file does not hold what was written");
  return process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
});

await check("machine", () => {
  const machine = describeMachine();
  const expected = { win32: /^Windows /, darwin: /^macOS /, linux: /\(Linux / }[process.platform as "win32" | "darwin" | "linux"];
  expect(!expected || expected.test(machine.os), `os is "${machine.os}"`);
  expect(machine.shell && machine.open, "no shell or opener");
  if (process.platform === "win32") expect(machine.shell === "PowerShell", `shell is ${machine.shell}`);
  return machine;
});

await check("sandbox", () => {
  expect(sandboxMode(undefined) === "workspace-write", "the default is not workspace-write");
  expect(sandboxMode("danger-full-access") === "danger-full-access", "danger-full-access is refused");
  let refused = false;
  try { sandboxMode("workspace"); } catch { refused = true; }
  expect(refused, "a typo is accepted");
});

await check("media paths", () => {
  for (const path of ["/Users/me/My Files/ü photo.png", "/home/me/.perry/files/a b.png", "C:\\Users\\me\\a b.png", "D:/x.png", "\\\\server\\share\\x.png"]) {
    expect(ABSOLUTE_PATH.test(path), `${path} is refused`);
  }
  for (const path of ["files/x.png", "~/x.png", "./x.png"]) expect(!ABSOLUTE_PATH.test(path), `${path} is accepted`);
  const posix = describePath("/Users/me/My Files/ü photo.PNG");
  expect(posix.fileName === "ü photo.PNG" && posix.contentType === "image/png", JSON.stringify(posix));
  const windows = describePath("C:\\Users\\me\\report final.pdf");
  expect(windows.fileName === "report final.pdf" && windows.contentType === "application/pdf", JSON.stringify(windows));
});

// Paths as awkward as a real machine can make them.
const nasty = (platform: NodeJS.Platform) => {
  const root = platform === "win32" ? "C:\\Users\\O'Neil Müller" : platform === "darwin" ? "/Users/o'neil müller" : "/home/o'neil müller";
  const j = (...parts: string[]) => [root, ...parts].join(platform === "win32" ? "\\" : "/");
  return {
    platform,
    repo: j("code", "me bot 100% & $HOME"),
    bun: j(".bun", "bin", platform === "win32" ? "bun.exe" : "bun"),
    home: j(".perry"),
    userHome: root,
    logFile: j(".perry", "logs", "runner.log"),
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", PERRY_CODEX_SANDBOX: "workspace-write" },
    user: platform === "win32" ? "DESKTOP\\O'Neil Müller" : "501",
  };
};

await check("service plans", () => {
  const mac = servicePlan(nasty("darwin"));
  const plist = mac.files[0].content;
  expect(mac.files[0].path.endsWith("/Library/LaunchAgents/com.perry.runner.plist"), mac.files[0].path);
  expect(plist.includes("<string>/Users/o&apos;neil müller/code/me bot 100% &amp; $HOME/scripts/perry.ts</string>\n    <string>run</string>"), "plist does not run `perry run`, or paths are not escaped");
  expect(!plist.includes("--auto") && plist.includes("<key>PATH</key>"), "plist passes --auto, or lacks PATH");
  expect(mac.install.some((step) => step.argv.join(" ") === `launchctl bootstrap gui/501 ${mac.files[0].path}`), "no launchctl bootstrap");

  const linux = servicePlan(nasty("linux"));
  const unit = linux.files[0].content;
  expect(unit.includes(`ExecStart="/home/o'neil müller/.bun/bin/bun" "/home/o'neil müller/code/me bot 100%% & $$HOME/scripts/perry.ts" "run"\n`), `ExecStart does not run perry run, or is not quoted: ${unit}`);
  expect(unit.includes(`WorkingDirectory=/home/o'neil müller/code/me bot 100%% & $HOME`), "WorkingDirectory is not escaped");
  expect(unit.includes(`Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"`) && unit.includes("WantedBy=default.target"), "unit lacks PATH or [Install]");

  // A logon task gets the owner's own PATH, so serviceContext carries none on Windows.
  const windows = servicePlan({ ...nasty("win32"), env: { PERRY_CODEX_SANDBOX: "workspace-write" } });
  const [launcher, task] = windows.files;
  expect(launcher.content.includes(`set "PERRY_CODEX_SANDBOX=workspace-write"`), "launcher does not carry PERRY_CODEX_SANDBOX");
  expect(launcher.content.includes(`cd /d "C:\\Users\\O'Neil Müller\\code\\me bot 100%% & $HOME"`), `launcher cd: ${launcher.content}`);
  expect(launcher.content.includes(`\\scripts\\perry.ts" "run" >> "C:\\Users\\O'Neil Müller\\.perry\\logs\\runner.log" 2>&1`), "launcher does not run perry run, or does not log");
  expect(launcher.content.includes(`set "PERRY_SERVICE_PID_FILE=C:\\Users\\O'Neil Müller\\.perry\\service\\runner.pid"`), "launcher sets no PID file");
  expect(task.encoding === "utf16le" && task.content.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"), "task keeps the 72-hour limit");
  expect(task.content.includes("<UserId>DESKTOP\\O&apos;Neil Müller</UserId>") && task.content.includes("O&apos;&apos;Neil"), "task XML is not escaped");
  return { launchd: mac.files[0].path, systemd: linux.files[0].path, taskScheduler: TASK };
});

await check("service lint", () => {
  const ctx = { ...nasty(process.platform), repo: resolve("."), bun: process.execPath, home: HOME, userHome: join(scratch, "user home"), logFile: join(HOME, "logs", "runner.log"), env: { PATH: process.env.PATH ?? "" },
    // Task Scheduler checks the account exists, so on Windows the lint registers under this machine's own user.
    user: process.platform === "win32" ? serviceContext().user : "501" };
  const plan = servicePlan(ctx);
  const file = join(scratch, "lint", plan.files.at(-1)!.path.split(/[\\/]/).pop()!);
  mkdirSync(join(scratch, "lint"), { recursive: true });
  const last = plan.files.at(-1)!;
  writeFileSync(file, last.encoding === "utf16le" ? Buffer.from(`\ufeff${last.content}`, "utf16le") : last.content);

  if (process.platform === "darwin") {
    const linted = exec(["plutil", "-lint", file]);
    expect(linted.code === 0, linted.output);
    return linted.output.trim();
  }
  if (process.platform === "win32") {
    if (!register) {
      // Well-formed at least; only Task Scheduler itself can say more, and that means registering it.
      const parsed = exec(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `[xml](Get-Content -Raw -Encoding Unicode -LiteralPath '${file.replace(/'/g, "''")}') | Out-Null`]);
      expect(parsed.code === 0, `task XML does not parse: ${parsed.output}`);
      return "well-formed; pass --register to have Task Scheduler read it (CI only)";
    }
    const name = `${TASK} smoke`;
    const created = exec(["schtasks", "/Create", "/TN", name, "/XML", file, "/F"]);
    expect(created.code === 0, `schtasks /Create: ${created.output}`);
    const read = exec(["schtasks", "/Query", "/TN", name, "/XML"]);
    exec(["schtasks", "/Delete", "/TN", name, "/F"]);
    expect(read.code === 0 && read.output.includes("PT0S") && read.output.includes("powershell.exe"), `schtasks /Query: ${read.output}`);
    return "registered, read back and deleted";
  }
  if (!has("systemd-analyze")) return "skipped: no systemd-analyze";
  // systemd-analyze exits 0 even for a line it ignores, so any complaint naming the unit fails it;
  // complaints about the host's other units (system mode, without a user manager) do not.
  let verified = exec(["systemd-analyze", "--user", "verify", file]);
  if (verified.code !== 0 && !verified.output.includes(file)) verified = exec(["systemd-analyze", "verify", file]);
  const problems = verified.output.split("\n").filter((line) => line.includes(file) || line.includes("perry-runner"));
  expect(problems.length === 0, problems.join("\n"));
  return "systemd-analyze verify: clean";
});

await check("service dry run", () => {
  const ran = exec([process.execPath, resolve("scripts", "service.ts"), "install", "--dry-run"], { XDG_CONFIG_HOME: join(scratch, "xdg") });
  expect(ran.code === 0, `exit ${ran.code}: ${ran.output}`);
  expect(ran.output.includes("dry run"), "not a dry run");
  expect(!existsSync(join(scratch, "xdg")) && !existsSync(join(HOME, "service")), "a dry run wrote files");
  return ran.output.split("\n").find((line) => line.includes("Installing"))?.replace(/\x1b\[[0-9;]*m/g, "").trim();
});

await check("perry command", () => {
  const help = exec([process.execPath, resolve("scripts", "perry.ts"), "help"]);
  expect(help.code === 0 && help.output.includes("setup") && help.output.includes("uninstall"), `perry help: exit ${help.code}: ${help.output}`);
  // PERRY_HOME is the scratch home, with no runner.json in it.
  rmSync(PATHS.runnerConfig, { force: true });
  const ran = exec([process.execPath, resolve("scripts", "perry.ts"), "run"]);
  expect(ran.code === 1 && ran.output.includes("perry setup"), `perry run with no connection: exit ${ran.code}: ${ran.output}`);
  return "help lists the commands; run without a connection points at perry setup";
});

rmSync(scratch, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(`\n${failed.length ? red(`${failed.length} of ${checks.length} checks failed.`) : green(`All ${checks.length} checks passed.`)}\n`);
console.log(JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform, arch: process.arch, bun: process.versions.bun, pass: failed.length === 0, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
