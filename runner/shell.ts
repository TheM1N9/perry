import { readFileSync } from "node:fs";
import { arch, release, userInfo } from "node:os";
import { basename } from "node:path";

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
