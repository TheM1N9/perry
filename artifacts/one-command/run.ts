import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// bun artifacts/one-command/run.ts <outDir>
// Windows only. Run from a checkout whose .env.local points at a deployment
// that is set up (the owner's own dev deployment), with the Convex CLI signed
// in, Chrome installed, this branch committed, and no "Perry runner" task
// registered yet. Uses port 3007 and a throwaway PERRY_HOME and PERRY_DIR, so
// the owner's ~/.perry and any runner they run by hand are left alone. The
// runner it connects is revoked at the end.
//
// Ways the one-command install could fail, and what catches each:
//   1. The installer does not get Perry: it must clone this branch into
//      PERRY_DIR (a path with a space) and install its packages.
//   2. No perry command, or one that only works inside the checkout: the
//      launcher in PERRY_HOME/bin must run `perry help` from another folder.
//   3. Running the installer again breaks: a second run must succeed.
//   4. `perry start` does not really start Perry: it must register the task,
//      the dashboard must answer on PERRY_PORT, and the runner must check in
//      with the deployment under the token it saved.
//   5. `perry status` misreports: it must say running, with the dashboard URL.
//   6. A crash stays down: killing the dashboard's process must bring a new
//      one up and answering, noted in the log.
//   7. The logs miss half of Perry: `perry logs` must show runner and dashboard lines.
//   8. `perry open`'s link does not unlock, or leaves the key showing: a fresh
//      browser opening /#key=<key> must land in the dashboard, with the key
//      stored and gone from the address.
//   9. `perry stop` leaves processes behind (Windows ends a process without
//      its children): the dashboard must stop answering and no process from
//      PERRY_DIR may remain.
//  10. It does not start again: a second `perry start` must bring it back.
//  11. `perry uninstall` leaves things behind: the task, the processes and the
//      launcher must all be gone.
//  12. The owner's own setup is touched: ~/.perry/runner.json must be byte-for-byte the same.

const [outDir] = process.argv.slice(2);
if (!outDir || process.platform !== "win32") throw new Error("usage (Windows): bun artifacts/one-command/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const worktree = resolve(".");
const scratch = mkdtempSync(join(tmpdir(), "perry-one-command-"));
const perryDir = join(scratch, "perry install");
const perryHome = join(scratch, "home");
const port = 3007;
const env = {
  ...process.env,
  PERRY_REPO: worktree,
  PERRY_BRANCH: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
  PERRY_DIR: perryDir,
  PERRY_HOME: perryHome,
  PERRY_PORT: String(port),
  PERRY_NO_PATH: "1",
  PERRY_NO_BROWSER: "1",
  PERRY_NO_SETUP: "1",
};
const ownConfig = join(process.env.USERPROFILE ?? "", ".perry", "runner.json");
const ownBefore = existsSync(ownConfig) ? readFileSync(ownConfig) : null;

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const transcript: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sh(argv: string[], { cwd = scratch, timeout = 600_000 }: { cwd?: string; timeout?: number } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8", timeout, windowsHide: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  transcript.push(`$ ${argv.join(" ")}\n${output.trim()}\n(exit ${result.status})\n`);
  return { code: result.status ?? 1, output };
}
const perry = (...args: string[]) => sh(["cmd.exe", "/d", "/c", join(perryHome, "bin", "perry.cmd"), ...args]);
const convex = (...args: string[]) => JSON.parse(execFileSync("node", ["node_modules/convex/bin/main.js", "run", ...args], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "null");
const taskRegistered = () => spawnSync("schtasks", ["/Query", "/TN", "Perry runner"], { stdio: "ignore" }).status === 0;
const up = async () => { try { return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })).status < 500; } catch { return false; } };
const waitUntil = async (test: () => Promise<boolean> | boolean, seconds: number) => { for (let i = 0; i < seconds; i++) { if (await test()) return true; await sleep(1000); } return await test(); };
/** Processes started from the throwaway checkout, by their command lines. */
function processesFromInstall(): Array<{ ProcessId: number; Name: string; CommandLine: string }> {
  const ps = `$d = '${perryDir.replace(/'/g, "''")}'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($d) } | Select-Object ProcessId, Name, CommandLine) | ConvertTo-Json -Compress`;
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).stdout.trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}
const installer = () => sh(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `iex (Get-Content -Raw -LiteralPath '${join(worktree, "install.ps1").replace(/'/g, "''")}')`], { timeout: 900_000 });

/** Open a URL in a fresh headless Chrome and read the page back. */
async function freshBrowser(url: string, probe: string): Promise<unknown> {
  const profile = join(scratch, "chrome profile");
  const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  try {
    let page: { type: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && !page; i++) {
      try { page = ((await (await fetch("http://127.0.0.1:9334/json/list")).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"); } catch {}
      await sleep(200);
    }
    if (!page) throw new Error("Chrome did not open");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const send = (method: string, params: object = {}) => new Promise<any>((done) => {
      const mine = ++id;
      const onMessage = (event: MessageEvent) => { const message = JSON.parse(String(event.data)); if (message.id === mine) { ws.removeEventListener("message", onMessage); done(message.result); } };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
    await send("Page.enable");
    await send("Page.navigate", { url });
    const deadline = Date.now() + 60_000;
    let value: any;
    while (Date.now() < deadline) {
      await sleep(1000);
      value = (await send("Runtime.evaluate", { expression: probe, returnByValue: true }))?.result?.value;
      if (value?.done) break;
    }
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, "opened-with-key.png"), Buffer.from(shot.data, "base64"));
    ws.close();
    return value;
  } finally {
    chrome.kill();
  }
}

let runnerId: string | null = null;
try {
  // 1 and 2. Install, then the launcher from another folder.
  const first = installer();
  checks.installerClonesAndInstalls = first.code === 0 && existsSync(join(perryDir, ".git")) && existsSync(join(perryDir, "node_modules", "next", "package.json"))
    && execFileSync("git", ["-C", perryDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim() === env.PERRY_BRANCH;
  const help = perry("help");
  checks.perryCommandWorksAnywhere = existsSync(join(perryHome, "bin", "perry.cmd")) && help.code === 0 && help.output.includes("setup") && help.output.includes("uninstall");

  // 3. Again.
  checks.installerRunsAgain = installer().code === 0;

  // 4. Start, on the owner's deployment.
  copyFileSync(join(worktree, ".env.local"), join(perryDir, ".env.local"));
  const started = perry("start");
  const config = JSON.parse(readFileSync(join(perryHome, "runner.json"), "utf8"));
  const runners: Array<{ _id: string; token: string; lastSeenAt?: number }> = convex("runner:listRunners");
  const mine = runners.find((runner) => runner.token === config.token);
  runnerId = mine?._id ?? null;
  notes.start = { exit: started.code, workdir: config.dir, lastSeenSecondsAgo: mine?.lastSeenAt ? Math.round((Date.now() - mine.lastSeenAt) / 1000) : null };
  checks.startRunsEverything = started.code === 0 && taskRegistered() && (await up()) && Boolean(mine?.lastSeenAt && Date.now() - mine.lastSeenAt < 120_000);

  // 5. Status.
  const status = perry("status");
  checks.statusSaysRunning = /service\s+running/.test(status.output) && status.output.includes(`http://localhost:${port}`);

  // 6. A crash.
  const dashboard = () => processesFromInstall().find((p) => p.CommandLine.includes("next") && p.CommandLine.includes(`start -p ${port}`));
  const before = dashboard();
  if (before) spawnSync("taskkill", ["/PID", String(before.ProcessId), "/F"], { stdio: "ignore" });
  await sleep(1500);
  const recovered = await waitUntil(async () => { const now = dashboard(); return Boolean(now && now.ProcessId !== before?.ProcessId && (await up())); }, 60);
  notes.crash = { killed: before?.ProcessId ?? null, replacedBy: dashboard()?.ProcessId ?? null };
  checks.crashRestarts = Boolean(before) && recovered && readFileSync(join(perryHome, "logs", "runner.log"), "utf8").includes("dashboard exited");

  // 7. Logs.
  const logs = perry("logs");
  checks.logsShowBoth = logs.output.includes("[runner]") && logs.output.includes("[dashboard]");

  // 8. The unlocked link.
  const key = readFileSync(join(perryDir, ".env.local"), "utf8").match(/^DASHBOARD_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  const opened = await freshBrowser(`http://localhost:${port}/#key=${encodeURIComponent(key)}`,
    `({ done: !!document.querySelector('.sidebar'), gate: !!document.querySelector('.gate-page'), hash: location.hash, stored: localStorage.getItem('perry.dashboard.key') === ${JSON.stringify(key)} })`) as { done: boolean; gate: boolean; hash: string; stored: boolean } | undefined;
  notes.opened = opened && { inDashboard: opened.done, gate: opened.gate, hashLeft: opened.hash !== "", stored: opened.stored };
  checks.openLinkUnlocks = Boolean(opened?.done && !opened.gate && opened.hash === "" && opened.stored);

  // 9. Stop.
  const stopped = perry("stop");
  const quiet = await waitUntil(async () => !(await up()) && processesFromInstall().length === 0, 20);
  notes.stop = { exit: stopped.code, left: processesFromInstall().map((p) => p.Name) };
  checks.stopEndsEverything = stopped.code === 0 && quiet;

  // 10. Start again.
  checks.startsAgain = perry("start").code === 0 && (await up());

  // 11. Uninstall.
  perry("uninstall");
  const gone = await waitUntil(() => !taskRegistered() && processesFromInstall().length === 0, 20);
  checks.uninstallRemovesAll = gone && !existsSync(join(perryHome, "bin", "perry.cmd"));
} finally {
  // Whatever happened above, leave nothing behind.
  if (taskRegistered()) spawnSync("schtasks", ["/Delete", "/TN", "Perry runner", "/F"], { stdio: "ignore" });
  for (const p of processesFromInstall()) spawnSync("taskkill", ["/PID", String(p.ProcessId), "/T", "/F"], { stdio: "ignore" });
  if (runnerId) convex("runner:revokeRunner", JSON.stringify({ runnerId }));
  notes.revokedRunner = runnerId;
  // 12. The owner's own config.
  const ownAfter = existsSync(ownConfig) ? readFileSync(ownConfig) : null;
  checks.ownerConfigUntouched = (ownBefore === null && ownAfter === null) || Boolean(ownBefore && ownAfter && ownBefore.equals(ownAfter));
  writeFileSync(join(outDir, "transcript.txt"), transcript.join("\n").replaceAll(scratch, "<scratch>"));
  await sleep(1000);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
