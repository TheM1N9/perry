import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * An engine's CLI as a child process whose whole tree can be ended. On
 * Windows the CLI is a .cmd shim, so it runs under cmd.exe, and killing
 * cmd.exe alone would leave the engine running; taskkill /T ends the tree. On
 * macOS and Linux it leads a process group of its own, which is ended
 * together. Either way it still exits when the runner's pipe to it closes.
 */
export function spawnEngine(command: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const windows = process.platform === "win32";
  return spawn(
    windows ? process.env.COMSPEC || "cmd.exe" : command,
    windows ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args,
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !windows, env: env ?? process.env },
  );
}

/** End a process and everything it started: asked to on macOS and Linux (SIGTERM), or at once (SIGKILL, and always on Windows). */
export function killTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone, or not a group leader after all.
    try { child.kill(signal); } catch {}
  }
}
