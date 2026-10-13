/** Installed Windows E2E. Failure checklist: README.md. Real installer, task, CLI and updates; disposable data. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? "artifacts/windows-background/installed-windows");
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "Perry installed Windows ü "));
const seed = join(scratch, "seed"), upstream = join(scratch, "upstream.git"), checkout = join(scratch, "Perry checkout ü");
const home = join(scratch, "Perry home ü");
const task = `Perry verification ${randomUUID()}`;
const key = `fixture-only-${randomUUID()}`;
const probe = createServer().listen(0, "127.0.0.1");
await new Promise<void>((done) => probe.once("listening", done));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((done) => probe.close(() => done()));
const base = `http://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_SERVICE_TASK: task, PERRY_PORT: String(port), PERRY_HOST: "127.0.0.1", CODEX_HOME: join(scratch, "codex"), PERRY_NO_BROWSER: "1", PERRY_NO_PATH: "1", PERRY_TELEMETRY_DISABLED: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PERRY_PET_HOTKEY: "CommandOrControl+Shift+F11" };
for (const name of Object.keys(env)) if (/CONVEX|TELEGRAM|COMPOSIO|ANTHROPIC_API_KEY|OPENAI_API_KEY|PERRY_RUNNER_TOKEN|PERRY_SERVER_URL|PERRY_SUPERVISOR|PERRY_SERVICE_PID_FILE|ELECTRON_RUN_AS_NODE/.test(name)) delete env[name];
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = { platform: process.platform, scratch, checkout, home, task, port, testedCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout.trim() };
let recorder: ChildProcess | undefined, desktop: ChildProcess | undefined, sentinel: ChildProcess | undefined;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify({ at: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) }, null, 2));
const check = (name: string, ok: unknown, detail?: unknown) => { checks[name] = Boolean(ok); if (detail !== undefined) notes[name] = detail; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); save(); assert.ok(ok, name); };
const phase = (name: string) => { writeFileSync(join(output, "state.json"), JSON.stringify({ phase: name, scratch, checkout, home, task, port, base, key, output })); console.log(`PHASE ${name}`); };
async function run(command: string, args: string[], cwd = checkout, extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; text: string }>((done) => {
    const child = spawn(command, args, { cwd, env: { ...env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; });
    child.once("error", (error) => done({ code: 127, text: String(error) }));
    child.once("close", (code) => done({ code, text }));
  });
}
async function required(command: string, args: string[], cwd = checkout, extra: NodeJS.ProcessEnv = {}) {
  const result = await run(command, args, cwd, extra);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.text.slice(-5000)}`);
  return result.text.trim();
}
const git = (...args: string[]) => required("git", ["-c", "user.name=Perry verification", "-c", "user.email=verification@perry.invalid", ...args], seed);
const cli = (...args: string[]) => run(process.execPath, [join(checkout, "scripts/perry.ts"), ...args]);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const status = () => { try { return JSON.parse(readFileSync(join(home, "service/status.json"), "utf8")); } catch { return {}; } };
const runnerPid = () => {
  const config = JSON.parse(readFileSync(join(home, "runner.json"), "utf8"));
  return Number(readFileSync(join(home, `runner-${createHash("sha256").update(config.token).digest("hex").slice(0, 12)}.lock`), "utf8"));
};
async function until(test: () => boolean | Promise<boolean>, label: string, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { if (await Promise.resolve().then(test).catch(() => false)) return; await sleep(250); }
  throw new Error(`Timed out: ${label}`);
}
async function call(path: string, args: object = {}) {
  const response = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args }), signal: AbortSignal.timeout(5000) });
  const result = await response.json() as { error?: string; value: any }; if (result.error) throw new Error(result.error); return result.value;
}
async function nextCommit(title: string) {
  writeFileSync(join(seed, "acceptance-version.txt"), title);
  await git("add", "acceptance-version.txt"); await git("commit", "-m", title); await git("push", "origin", "main");
  return git("rev-parse", "HEAD");
}
async function handoff(name: string) {
  phase(name);
  await until(() => existsSync(join(output, `${name}.done`)), `desktop verification ${name}`, 900);
}
const taskBefore = spawnSync("schtasks", ["/Query", "/TN", "Perry runner", "/XML"], { encoding: "utf8", windowsHide: true }).stdout;
notes.ownerTaskHashBefore = createHash("sha256").update(taskBefore).digest("hex");
try {
  mkdirSync(seed, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(env.CODEX_HOME!, { recursive: true });
  const files = (await required("git", ["ls-files"], repo)).split(/\r?\n/).filter((file) => file && !/^(artifacts|film|site)\//.test(file));
  for (const file of files) { mkdirSync(dirname(join(seed, file)), { recursive: true }); copyFileSync(join(repo, file), join(seed, file)); }
  await required("git", ["init", "--bare", "-b", "main", upstream], scratch);
  await git("init", "-b", "main"); await git("add", "-A"); await git("commit", "-m", "Windows acceptance baseline"); await git("remote", "add", "origin", upstream); await git("push", "-u", "origin", "main");
  phase("installing");
  const installed = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(repo, "install.ps1")], repo, { PERRY_REPO: upstream, PERRY_BRANCH: "main", PERRY_DIR: checkout, PERRY_NO_SETUP: "1" });
  writeFileSync(join(output, "installer.txt"), installed.text);
  check("real installer succeeds in spaces and Unicode paths", installed.code === 0 && existsSync(join(checkout, "node_modules/next/package.json")));
  check("installer links only the disposable home", readFileSync(join(home, "bin/perry.cmd"), "utf8").includes(checkout));
  writeFileSync(join(checkout, ".env.local"), `DASHBOARD_KEY=${key}\nPERRY_PORT=${port}\nPERRY_TELEMETRY_DISABLED=1\n`);
  sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const chrome = process.env.PERRY_E2E_BROWSER ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  desktop = spawn(chrome, [`--user-data-dir=${join(scratch, "recording-browser")}`, "--no-first-run", "--start-maximized", "--app=data:text/html,<title>Perry Windows acceptance</title><body style='font:24px system-ui;background:%23fff;padding:40px'>Perry Windows acceptance<br>Disposable installation</body>"], { windowsHide: true, stdio: "ignore" });
  await handoff("recording-ready");
  const movie = join(scratch, "installed-lifecycle.mp4"); notes.recording = movie;
  recorder = spawn("ffmpeg", ["-y", "-f", "gdigrab", "-framerate", "30", "-i", "desktop", "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27", movie], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let captureLog = ""; recorder.stderr!.on("data", (chunk) => { captureLog = (captureLog + chunk).slice(-3000); });
  await sleep(2000); check("recording starts before service launch", recorder.exitCode === null);
  const petStarted = await cli("pet"); writeFileSync(join(output, "pet-start.txt"), petStarted.text);
  check("installed desktop pet starts with an isolated login entry", petStarted.code === 0, petStarted.text.slice(-1500));
  phase("starting");
  const started = await cli("start"); writeFileSync(join(output, "start.txt"), started.text);
  check("real perry start installs and reaches readiness", started.code === 0, started.text.slice(-1500));
  await until(() => status().state === "ready", "installed readiness");
  const first = status(); notes.first = first;
  const taskXml = await required("schtasks", ["/Query", "/TN", task, "/XML"]);
  writeFileSync(join(output, "task.xml"), taskXml);
  const runLevel = await required("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').GetTask('${task}').Definition.Principal.RunLevel`]);
  check("scheduled task uses native GUI launcher with least privilege", /runner.exe<\/Command>/.test(taskXml) && runLevel === "0" && !/powershell.exe|runner.cmd/.test(taskXml), { runLevel });
  const repeat = await cli("start"); check("repeated CLI launch preserves the supervisor and runner", repeat.code === 0 && status().pid === first.pid);
  const repeated = await run(join(home, "service/runner.exe"), []); check("repeated native launch exits without another supervisor", repeated.code === 0 && status().pid === first.pid);
  phase("installed-ready"); await handoff("installed-ready");
  const oldRunner = runnerPid(); await required("taskkill", ["/PID", String(oldRunner), "/F"]);
  await until(() => status().state === "failed", "runner failure reported", 30);
  await handoff("failure-visible");
  await until(() => runnerPid() !== oldRunner && status().state === "ready", "runner recovery", 60);
  check("installed service reports runner crash and recovers", true);
  const cliVersion = await nextCommit("CLI update fixture");
  phase("cli-update"); const updated = await cli("update"); writeFileSync(join(output, "cli-update.txt"), updated.text);
  check("real CLI update restarts the installed native service", updated.code === 0 && (await required("git", ["rev-parse", "HEAD"])) === cliVersion && status().state === "ready", updated.text.slice(-2000));
  const dashboardVersion = await nextCommit("Dashboard update fixture");
  await call("updates:check", { key });
  const beforeDashboard = status().pid;
  await call("updates:update", { key });
  phase("dashboard-update");
  await until(() => { const result = JSON.parse(readFileSync(join(home, "update-result.json"), "utf8")); return result.ok && result.to === dashboardVersion && status().state === "ready"; }, "dashboard update completes", 600);
  check("dashboard update preserves native supervision and readiness", status().pid === beforeDashboard && (await required("git", ["rev-parse", "HEAD"])) === dashboardVersion);
  await handoff("updated-ready");
  writeFileSync(join(seed, "package.json"), "{ invalid JSON fixture");
  await git("add", "package.json"); await git("commit", "-m", "Deliberately broken update fixture"); await git("push", "origin", "main");
  await call("updates:check", { key }); await call("updates:update", { key });
  phase("failed-update");
  await until(() => { const result = JSON.parse(readFileSync(join(home, "update-result.json"), "utf8")); return result.ok === false && result.from === dashboardVersion && status().state === "ready"; }, "failed update rolls back", 600);
  check("failed dashboard update rolls back and restores readiness", (await required("git", ["rev-parse", "HEAD"])) === dashboardVersion);
  const stopped = await cli("stop"); await until(() => !alive(status().pid), "installed stop", 30);
  check("CLI stop releases the installed process tree and preserves unrelated process", stopped.code === 0 && alive(sentinel.pid!));
  const debug = spawn(process.execPath, [join(checkout, "scripts/perry.ts"), "run"], { cwd: checkout, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let debugLog = ""; debug.stdout.on("data", (chunk) => { debugLog += chunk; }); debug.stderr.on("data", (chunk) => { debugLog += chunk; });
  try { await until(() => status().state === "ready" && status().pid === debug.pid, "foreground debug readiness"); check("foreground debug exposes detailed runner output", /Assistant runner/.test(debugLog)); }
  finally { if (debug.pid) await run("taskkill", ["/PID", String(debug.pid), "/T", "/F"]); }
  writeFileSync(join(home, "perry.pid"), String(sentinel.pid));
  const restarted = await cli("start"); check("service clears a stale supervisor lock naming an unrelated live process", restarted.code === 0 && status().state === "ready" && alive(sentinel.pid!));
  await cli("stop"); await until(() => !alive(status().pid), "final service shutdown", 30);
  check("final shutdown leaves unrelated process alive", alive(sentinel.pid!));
  await handoff("recording-review");
  checks.completed = true;
} catch (error) { checks.completed = false; notes.error = error instanceof Error ? error.stack : String(error); console.error(notes.error); process.exitCode = 1; }
finally {
  if (recorder?.exitCode === null) { recorder.stdin!.write("q"); await new Promise((done) => recorder!.once("exit", done)); }
  await run("schtasks", ["/End", "/TN", task]).catch(() => {}); await run("schtasks", ["/Delete", "/TN", task, "/F"]).catch(() => {});
  if (existsSync(join(checkout, "pet/node_modules/electron"))) await cli("pet", "off").catch(() => {});
  if (sentinel?.pid) sentinel.kill();
  if (desktop?.pid) await run("taskkill", ["/PID", String(desktop.pid), "/T", "/F"]).catch(() => {});
  const taskAfter = spawnSync("schtasks", ["/Query", "/TN", "Perry runner", "/XML"], { encoding: "utf8", windowsHide: true }).stdout;
  checks.ownerTaskUnchanged = notes.ownerTaskHashBefore === createHash("sha256").update(taskAfter).digest("hex");
  phase("finished"); save();
}
