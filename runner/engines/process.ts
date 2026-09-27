import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

/** One argument as cmd.exe reads it: quoted when it has spaces or characters cmd would act on. */
const cmdArg = (arg: string) => /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;

/**
 * An engine's CLI as a child process whose whole tree can be ended. On
 * Windows the CLI is a .cmd shim, so it runs under cmd.exe, and killing
 * cmd.exe alone would leave the engine running; taskkill /T ends the tree. On
 * macOS and Linux it leads a process group of its own, which is ended
 * together. Either way it still exits when the runner's pipe to it closes.
 */
export function spawnEngine(command: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string): ChildProcessWithoutNullStreams {
  const windows = process.platform === "win32";
  return spawn(
    windows ? process.env.COMSPEC || "cmd.exe" : command,
    // As Node's own `shell: true` does it, so a path with spaces stays one argument.
    windows ? ["/d", "/s", "/c", `"${[command, ...args].map(cmdArg).join(" ")}"`] : args,
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: windows, detached: !windows, env: env ?? process.env, ...(cwd ? { cwd } : {}) },
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

/**
 * The command that starts an engine's CLI: its usual name, or what an
 * environment variable says instead (PERRY_GROK_COMMAND="bun C:\fake-agent.ts
 * --profile grok", say), split into words as a shell would, quotes kept
 * together. Tests point the runner at a stand-in agent this way, and an owner
 * whose CLI is not on PATH can name it.
 */
export function commandOf(variable: string, fallback: string): { command: string; args: string[] } {
  const words = (process.env[variable]?.trim() || fallback).match(/"[^"]*"|'[^']*'|\S+/g) ?? [fallback];
  const [command, ...args] = words.map((word) => /^(["']).*\1$/.test(word) ? word.slice(1, -1) : word);
  return { command, args };
}

/** Run a CLI to its end and keep what it printed; a probe, so it never waits long. */
export function runCli(command: { command: string; args: string[] }, args: string[], timeoutMs = 20_000, env?: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnEngine(command.command, [...command.args, ...args], env, cwd); } catch (error) { fail(error); return; }
    let stdout = "";
    let stderr = "";
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 100_000) stderr += chunk; });
    const timer = setTimeout(() => { killTree(child, "SIGKILL"); fail(new Error(`${command.command} ${args.join(" ")} did not answer in ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); fail(error); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
