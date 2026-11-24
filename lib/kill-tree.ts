import { spawnSync } from "node:child_process";

/** End an owned child and its subprocesses. POSIX children should be group leaders. */
export function killTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}
