import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, release, userInfo } from "node:os";
import { basename } from "node:path";

const COMMAND_TIMEOUT_MS = 120_000;

/** Run one command in this OS's own shell: cmd.exe on Windows, /bin/sh everywhere else. */
export function runShell(command: string, cwd: string): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
    // cmd.exe does not read the \" that Node would escape quotes with, so the
    // command goes to it as written, wrapped once, the way Node's own shell option does.
    const shellArgs = isWindows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];

    const child = spawn(shell, shellArgs, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PERRY_RUNNER: "1" },
    });

    let output = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, output: String(error), timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, output, timedOut: killed });
    });
  });
}

/**
 * This machine as Codex should picture it: the OS, the shell its commands run
 * in, and how to open a file or an app. Without it Codex guesses, and a guess
 * of PowerShell on a Mac (or zsh on Windows) costs a failed command.
 */
export function describeMachine(): { os: string; shell: string; open: string } {
  if (process.platform === "win32") {
    return { os: `Windows ${release()} (${arch()})`, shell: "PowerShell", open: "Start-Process" };
  }
  let shell = process.env.SHELL;
  try { shell ||= userInfo().shell ?? undefined; } catch {}
  const shellName = basename(shell || "/bin/sh");
  if (process.platform === "darwin") {
    return { os: `macOS (Darwin ${release()}, ${arch()})`, shell: shellName, open: "open" };
  }
  let name = process.platform === "linux" ? "Linux" : process.platform;
  try {
    name = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1] ?? name;
  } catch {}
  // WSL is Linux with Windows next door: its apps open through explorer.exe.
  const wsl = /microsoft/i.test(release());
  return {
    os: `${name}${wsl ? " under WSL" : ""} (Linux ${release()}, ${arch()})`,
    shell: shellName,
    open: wsl ? "explorer.exe or wslview" : "xdg-open",
  };
}
