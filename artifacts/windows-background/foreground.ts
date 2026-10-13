/** Real installed foreground launch from a relative script path, then duplicate launch. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const output = resolve(process.argv[2]);
const state = JSON.parse(readFileSync(join(output, "state.json"), "utf8"));
const env = { ...process.env, PERRY_HOME: state.home, PERRY_PORT: String(state.port), PERRY_HOST: "127.0.0.1" };
const debug = spawn(process.execPath, ["scripts/perry.ts", "run"], { cwd: state.checkout, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
debug.stdout.on("data", chunk => { log += chunk; }); debug.stderr.on("data", chunk => { log += chunk; });
const result: Record<string, unknown> = { relativeScript: "scripts/perry.ts" };
try {
  const deadline = Date.now() + 90000;
  while (true) {
    const status = JSON.parse(readFileSync(join(state.home, "service/status.json"), "utf8"));
    if (status.pid === debug.pid && status.state === "ready") break;
    if (Date.now() > deadline || debug.exitCode !== null) throw new Error(`Foreground failed: ${log}`);
    await new Promise(done => setTimeout(done, 200));
  }
  const duplicate = spawn(process.execPath, [join(state.checkout, "scripts/perry.ts"), "run"], { cwd: state.checkout, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let duplicateLog = "";
  duplicate.stdout.on("data", chunk => { duplicateLog += chunk; }); duplicate.stderr.on("data", chunk => { duplicateLog += chunk; });
  const code = await new Promise(done => duplicate.once("exit", done));
  assert.equal(code, 1); assert.match(duplicateLog, /already running/);
  const status = JSON.parse(readFileSync(join(state.home, "service/status.json"), "utf8"));
  assert.equal(status.pid, debug.pid); assert.equal(status.state, "ready");
  assert.match(readFileSync(join(state.home, "perry.pid"), "utf8"), new RegExp(`^${debug.pid} \\d+$`));
  result.passed = true; result.duplicate = duplicateLog.trim(); result.record = readFileSync(join(state.home, "perry.pid"), "utf8");
} catch (error) { result.passed = false; result.error = String(error); process.exitCode = 1; }
finally { if (debug.pid) spawnSync("taskkill", ["/PID", String(debug.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); writeFileSync(join(output, "foreground-result.json"), JSON.stringify(result, null, 2)); console.log(result); }
