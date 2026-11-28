import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, copyFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

if (!process.argv[2]) throw Error("Pass a disposable output directory");
const electron = process.env.PERRY_E2E_ELECTRON || createRequire(resolve("pet/package.json"))("electron");
if (typeof electron !== "string" || !existsSync(electron)) throw Error("The pet's Electron executable is unavailable");
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-pet-window-lifecycle-"));
const appDir = join(home, "app");
mkdirSync(appDir);
for (const name of readdirSync("pet")) if (/\.(js|cjs|png)$/.test(name)) copyFileSync(join("pet", name), join(appDir, name));
symlinkSync(resolve("node_modules"), join(home, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const baseline = process.argv.includes("--baseline");
if (baseline) {
  const old = spawnSync("git", ["show", "b297765b90a008a3598f8bdcc8b1518d85c1832e:pet/main.js"], { encoding: "utf8", windowsHide: true });
  if (old.status !== 0) throw Error(old.stderr);
  writeFileSync(join(appDir, "main.js"), old.stdout);
}
writeFileSync(join(appDir, "package.json"), JSON.stringify({ type: "module" }));
const keyStub = join(appDir, "node_modules", "uiohook-napi");
mkdirSync(keyStub, { recursive: true });
writeFileSync(join(keyStub, "index.js"), "module.exports = { UiohookKey: {} };\n");
writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 80, y: 80, ghost: true, hotkey: "CommandOrControl+Alt+Shift+F20", listenHotkey: "CommandOrControl+Alt+Shift+F21", pasteHotkey: "CommandOrControl+Alt+Shift+F22" }));
let holdHeads = false;
let heldHeads = 0;
const heldResponses = new Set();
const site = createServer((request, response) => {
  const path = new URL(request.url, "http://fixture.local").pathname;
  if (path === "/hold-heads") { holdHeads = true; heldHeads = 0; response.end("ok"); return; }
  if (path === "/release-heads") { holdHeads = false; for (const head of heldResponses) head.end(); heldResponses.clear(); response.end("ok"); return; }
  if (path === "/held-heads") { response.end(String(heldHeads)); return; }
  if (request.method === "HEAD" && holdHeads) { heldHeads++; heldResponses.add(response); response.once("close", () => heldResponses.delete(response)); return; }
  response.setHeader("content-type", "text/html");
  response.end("<!doctype html><title>Pet lifecycle fixture</title><body style='background:transparent;color:#246'>Synthetic pet page</body>");
});
await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${site.address().port}`;
const env = { ...process.env, PERRY_HOME: home, PERRY_URL: base, DASHBOARD_KEY: "synthetic-lifecycle-key", PERRY_PET_FAKE_KEYS: "1", PERRY_LIFECYCLE_MAIN: join(appDir, "main.js"), PERRY_LIFECYCLE_OUTPUT: output, PERRY_LIFECYCLE_BASELINE: baseline ? "1" : "", PERRY_MODELS_DIR: join(home, "models") };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [resolve("artifacts/pet-window-lifecycle/entry.mjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-8000); writeFileSync(join(output, "electron.log"), log); });
const exit = await new Promise(resolve => {
  const timeout = setTimeout(() => {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGKILL");
  }, 90_000);
  child.once("error", error => { clearTimeout(timeout); resolve({ error: error.message }); });
  child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
});
site.closeAllConnections();
await new Promise(resolve => site.close(resolve));
const resultPath = join(output, "result.json");
const report = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : { checks: {}, error: "Electron wrote no result", log };
report.exit = exit;
report.baseline = baseline;
try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
catch (error) { report.cleanupError = String(error); }
report.homeRemoved = !existsSync(home);
report.passed = exit.code === 0 && report.homeRemoved && !report.error && !report.cleanupError && Object.values(report.checks).every(Boolean);
writeFileSync(resultPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
