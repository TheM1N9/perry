import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { release } from "node:os";
import type { Runtime } from "./runtime";

/**
 * Waking the computer for what is due (issue #109), with the system's own
 * timers rather than a server somewhere else: nothing of Perry runs while the
 * computer sleeps.
 *
 * On Windows (and from WSL, through powershell.exe) a Task Scheduler task
 * with "Wake the computer to run this task" is set for a minute before the
 * next job or to-do reminder (convex/wake.ts), and moved whenever that
 * changes. It runs nothing; waking is its whole job. macOS (pmset) and Linux
 * (rtcwake) let only an administrator set a wake time, so there the Work page
 * says so instead.
 *
 * Awake again, the computer would soon sleep, so from a few minutes before
 * something is due, and while any turn runs, a small process holds it awake
 * (SetThreadExecutionState on Windows, caffeinate on a Mac, systemd-inhibit on
 * Linux) and lets go after.
 */

const WINDOWS = process.platform === "win32" || (process.platform === "linux" && /microsoft/i.test(release()));
/**
 * The task's name. A Perry with its own PERRY_HOME (a second checkout, a
 * test) gets its own, as the pet's login entry does, so it never moves another's.
 */
export const WAKE_TASK = `Perry wake${process.env.PERRY_HOME ? `-${createHash("sha256").update(process.env.PERRY_HOME).digest("hex").slice(0, 8)}` : ""}`;
/** Woken this long before, so the server and runner are back when it comes due. */
const EARLY_MS = 60_000;
/** Held awake from this long before something is due. */
const AHEAD_MS = 3 * 60_000;
const internal = { internal: true } as const;

function powershell(script: string, input?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.stdin.on("error", () => {});
    child.on("error", (error) => resolve({ ok: false, out: String(error) }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
    child.stdin.end(input ?? "");
  });
}

/** The task, as Task Scheduler takes it: once, at `at`, waking the computer, doing nothing. */
function taskXml(at: number): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Wakes the computer for Perry's next scheduled job or reminder. Set by Perry; turn it off on Perry's Work page.</Description></RegistrationInfo>
  <Triggers><TimeTrigger><StartBoundary>${new Date(at).toISOString().slice(0, 19)}Z</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><WakeToRun>true</WakeToRun><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable><ExecutionTimeLimit>PT1M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>/c exit</Arguments></Exec></Actions>
</Task>`;
}

/**
 * Set the wake timer for `at`, or with null take it away. Returns why it
 * could not be set, or null.
 */
export async function setWakeTimer(at: number | null): Promise<string | null> {
  if (!WINDOWS) {
    if (at === null) return null;
    return process.platform === "darwin"
      ? "macOS lets only an administrator set a wake time (pmset), so Perry can't wake this Mac; what is due runs when it wakes."
      : "Linux lets only root set the wake alarm (rtcwake), so Perry can't wake this computer; what is due runs when it wakes.";
  }
  const name = WAKE_TASK.replace(/'/g, "''");
  if (at === null) {
    const removed = await powershell(`Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false -ErrorAction SilentlyContinue`);
    return removed.ok ? null : `Windows would not remove the wake timer: ${removed.out.split(/\r?\n/)[0]}`;
  }
  const set = await powershell(`$x = [Console]::In.ReadToEnd(); Register-ScheduledTask -TaskName '${name}' -Xml $x -Force | Out-Null`, taskXml(at));
  if (!set.ok) return `Windows would not set a wake timer: ${set.out.split(/\r?\n/)[0]}`;
  // The power plan decides whether timers may wake the computer at all: plugged in, then on battery.
  const plan = await powershell("powercfg.exe /q SCHEME_CURRENT SUB_SLEEP RTCWAKE");
  const [plugged] = plan.out.match(/0x[0-9a-f]{8}/gi)?.slice(-2).map((hex) => Number.parseInt(hex, 16)) ?? [];
  if (plugged === 0) return "Windows is set to ignore wake timers. Turn them on in Power Options → Change plan settings → Change advanced power settings → Sleep → Allow wake timers.";
  return null;
}

/** A process holding the computer awake until it is stopped, or null where there is none to be had. */
function keepAwake(): ChildProcess | null {
  const [command, args]: [string, string[]] = WINDOWS
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PerryAwake { [DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags); }'; " +
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held until Perry closes this process's input.
      "[PerryAwake]::SetThreadExecutionState(0x80000001) | Out-Null; [Console]::In.ReadLine() | Out-Null"]]
    : process.platform === "darwin"
      ? ["caffeinate", ["-i", "-w", String(process.pid)]]
      : ["systemd-inhibit", ["--what=sleep:idle", "--who=Perry", "--why=Perry is working on something", "--mode=block", "sleep", "infinity"]];
  try {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    return child;
  } catch {
    return null;
  }
}

function letGo(child: ChildProcess) {
  child.stdin?.end();
  if (!WINDOWS) child.kill();
}

/** Keep the wake timer and staying awake up to date; returns a function that stops. */
export function runWake(runtime: Runtime): () => void {
  let stopped = false;
  let timerFor: number | null | undefined;
  let error: string | null = null;
  let keeper: ChildProcess | null = null;
  let busy = false;
  let again = false;
  let soon: ReturnType<typeof setTimeout> | null = null;

  const reconcile = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const next = (await runtime.runQuery("wake:next", {}, internal)).value as { at: number; what: string } | null;
      // To the minute, so a job's next time moving by seconds does not set it again.
      const target = next ? Math.floor((next.at - EARLY_MS) / 60_000) * 60_000 : null;
      if (target !== timerFor && !stopped) {
        timerFor = target;
        error = await setWakeTimer(target);
      }
      const working = (await runtime.runQuery("wake:busy", {}, internal)).value as boolean;
      const due = next !== null && next.at - Date.now() < AHEAD_MS;
      if ((working || due) && !keeper && !stopped) keeper = keepAwake();
      else if (!working && !due && keeper) { letGo(keeper); keeper = null; }
      await runtime.runMutation("wake:report", { ...(next ? { at: next.at, what: next.what } : {}), ...(error ? { error } : {}), awake: keeper !== null }, internal);
    } catch (cause) {
      console.error(`[perry] could not set the wake timer: ${String(cause)}`);
    } finally {
      busy = false;
      if (again && !stopped) { again = false; void reconcile(); }
    }
  };

  // Soon after what it depends on changes (a burst of writes counts once), and every minute.
  const onChange = (tables: string[]) => {
    if (!["jobs", "todos", "installation", "codexTurns"].some((table) => tables.includes(table)) || soon) return;
    soon = setTimeout(() => { soon = null; void reconcile(); }, 2_000);
  };
  runtime.events.on("change", onChange);
  const every = setInterval(() => void reconcile(), 60_000);
  void reconcile();
  return () => {
    stopped = true;
    runtime.events.off("change", onChange);
    clearInterval(every);
    if (soon) clearTimeout(soon);
    if (keeper) letGo(keeper);
  };
}
