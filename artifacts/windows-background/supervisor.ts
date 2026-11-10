/** Real production dashboard + runner, in a fresh home. No engine turns or external messages. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const output = resolve(process.argv[2] ?? "artifacts/windows-background/supervisor-macos");
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "Perry background ü "));
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: "7384", PERRY_HOST: "127.0.0.1", PERRY_NO_BROWSER: "1" };
delete env.TELEGRAM_BOT_TOKEN;
delete env.COMPOSIO_API_KEY;
delete env.PERRY_RUNNER_TOKEN;
delete env.PERRY_SERVER_URL;
delete env.PERRY_SERVICE_PID_FILE;
const evidence: Record<string, unknown> = { platform: process.platform, home, port: 7384 };
const expect = (ok: unknown, what: string) => { if (!ok) throw new Error(what); evidence[what] = true; };
const wait = async (check: () => boolean | Promise<boolean>, seconds = 90) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Timed out waiting for runtime state");
};
const status = () => { try { return JSON.parse(readFileSync(join(home, "service", "status.json"), "utf8")); } catch { return {}; } };
const runnerPid = () => {
  const { token } = JSON.parse(readFileSync(join(home, "runner.json"), "utf8"));
  return Number(readFileSync(join(home, `runner-${createHash("sha256").update(token).digest("hex").slice(0, 12)}.lock`), "utf8"));
};
expect(existsSync(join(repo, ".next", "BUILD_ID")), "production build exists");
try {
  await fetch("http://127.0.0.1:7384", { signal: AbortSignal.timeout(1000) });
  throw new Error("Port 7384 is already in use; refusing to touch it");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Port")) throw error;
}
const handoff = spawnSync(process.execPath, [join(repo, "scripts", "perry.ts"), "run", "--background"], {
  cwd: repo, env: { ...env, PERRY_SERVICE_PID_FILE: join(home, "unclaimed.pid") }, encoding: "utf8", windowsHide: true, timeout: 15_000,
});
expect(handoff.status === 1 && handoff.stderr.includes("did not establish process ownership"), "missing native ownership handoff fails within 10 seconds");
expect(!existsSync(join(home, "runner.json")), "failed handoff starts no runner");
const supervisor = spawn(process.execPath, [join(repo, "scripts", "perry.ts"), "run", "--background"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let log = "";
supervisor.stdout.on("data", (chunk) => { log += chunk; });
supervisor.stderr.on("data", (chunk) => { log += chunk; });
try {
  await wait(() => status().state === "ready");
  evidence.initialStatus = status();
  expect(true, "dashboard and live runner become ready");
  const before = runnerPid();
  const duplicate = spawnSync(process.execPath, [join(repo, "scripts", "perry.ts"), "run"], { cwd: repo, env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  expect(duplicate.status === 1 && duplicate.stdout.includes("already running"), "foreground refuses an existing supervisor");
  expect(runnerPid() === before, "repeated launch preserves one runner");
  process.kill(before, "SIGKILL");
  await wait(() => status().state === "failed", 10);
  evidence.crashStatus = status();
  await wait(() => { try { return runnerPid() !== before && status().state === "ready"; } catch { return false; } }, 30);
  expect(true, "runner crash is reported and recovers");
  expect(!log.includes("Assistant runner") && !log.includes("directory  "), "private detailed child stdout is omitted in background");
  expect(log.includes("version ") && log.includes("[perry] ready:"), "lifecycle log contains version and readiness");
  supervisor.kill("SIGTERM");
  await new Promise((done) => supervisor.once("exit", done));
  expect(status().state === "stopped" && !existsSync(join(home, "perry.pid")), "shutdown reports stopped and releases supervisor lock");
  // Same configuration deliberately works in the foreground after the first instance stops.
  const debug = spawn(process.execPath, [join(repo, "scripts", "perry.ts"), "run"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let debugLog = "";
  debug.stdout.on("data", (chunk) => { debugLog += chunk; });
  debug.stderr.on("data", (chunk) => { debugLog += chunk; });
  try {
    await wait(() => status().state === "ready" && status().pid === debug.pid);
    expect(debugLog.includes("Assistant runner"), "foreground exposes detailed child output");
  } finally {
    debug.kill("SIGTERM");
    await new Promise((done) => debug.once("exit", done));
  }
  evidence.pass = true;
} catch (error) {
  evidence.pass = false;
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  if (supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill("SIGTERM");
    await new Promise((done) => supervisor.once("exit", done));
  }
  writeFileSync(join(output, "supervisor.txt"), log);
  writeFileSync(join(output, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
