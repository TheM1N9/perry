/** Installed desktop E2E: actual Electron Tray/Menu/Shell objects and production Computers page.
 * Failure modes are recorded in README.md. Inspector only uses the disposable pet.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const output = resolve(process.argv[2]);
const state = JSON.parse(readFileSync(join(output, "state.json"), "utf8"));
assert.equal(state.phase, "installed-ready");
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: state.home, PERRY_PORT: String(state.port), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const program = join(state.checkout, "pet/node_modules/electron/dist/electron.exe");
const evidence: Record<string, unknown> = {};
const checks: Record<string, boolean> = {};
const save = () => writeFileSync(join(output, "desktop-result.json"), JSON.stringify({ checks, evidence, passed: checks.completed === true && Object.values(checks).every(Boolean) }, null, 2));
const check = (name: string, ok: unknown) => { checks[name] = Boolean(ok); save(); assert.ok(ok, name); console.log(`PASS ${name}`); };
const wait = async (predicate: () => unknown, seconds = 180) => {
  const deadline = Date.now() + seconds * 1000;
  while (!await Promise.resolve().then(predicate).catch(() => false)) { if (Date.now() > deadline) throw new Error("Desktop condition timed out"); await new Promise(done => setTimeout(done, 200)); }
};
const quit = spawn(program, [join(state.checkout, "pet"), "--quit"], { env, windowsHide: true, stdio: "ignore" });
await new Promise(done => quit.once("exit", done));
await new Promise(done => setTimeout(done, 2000));
const wrapper = join(state.scratch, "desktop-observer.cjs");
const nativeLog = join(output, "native-tray.jsonl");
writeFileSync(wrapper, `const e = require('electron'), fs = require('node:fs');
const file = ${JSON.stringify(nativeLog)};
const record = (data) => fs.appendFileSync(file, JSON.stringify({at:Date.now(),...data})+'\\n');
const menu = e.Tray.prototype.setContextMenu;
e.Tray.prototype.setContextMenu = function(value) {
  globalThis.acceptanceMenu = value; globalThis.acceptanceTray = this;
  record({menu:value.items.map(i=>({label:i.label,type:i.type,enabled:i.enabled})), bounds:this.getBounds()});
  return menu.call(this,value);
};
const open = e.shell.openPath;
e.shell.openPath = async function(path) { const result = await open.call(this,path); record({opened:path,result}); return result; };
import(${JSON.stringify(pathToFileURL(join(state.checkout, "pet/main.js")).href)}).catch(error=>{record({error:String(error)});e.app.exit(1)});`);
let inspector = "", diagnostics = "";
const pet = spawn(program, ["--inspect=127.0.0.1:0", wrapper], { cwd: join(state.checkout, "pet"), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
pet.stderr.on("data", chunk => { diagnostics += chunk; inspector ||= /Debugger listening on (ws:\/\/[^\s]+)/.exec(diagnostics)?.[1] ?? ""; });
let socket: WebSocket | undefined, browser: any;
const records = () => readFileSync(nativeLog, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
try {
  await wait(() => inspector);
  socket = new WebSocket(inspector);
  await new Promise(done => socket!.addEventListener("open", done, { once: true }));
  let nextId = 0;
  const call = (expression: string) => new Promise<any>((done, fail) => {
    const id = ++nextId;
    const receive = (event: MessageEvent) => { const message = JSON.parse(String(event.data)); if (message.id !== id) return; socket!.removeEventListener("message", receive); if (message.error || message.result?.exceptionDetails) fail(new Error(JSON.stringify(message))); else done(message.result?.result?.value); };
    socket!.addEventListener("message", receive);
    socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  await wait(() => records().some(row => row.menu?.[0].label === "Perry is ready"));
  evidence.readyMenu = records().reverse().find(row => row.menu?.[0].label === "Perry is ready");
  check("real native tray reports installed readiness", Boolean(evidence.readyMenu));
  check("native menu offers Open Perry and Open logs", await call("acceptanceMenu.items.some(i=>i.label==='Open Perry') && acceptanceMenu.items.some(i=>i.label==='Open logs')"));
  await call("acceptanceMenu.items.find(i=>i.label==='Open logs').click()");
  await wait(() => records().some(row => row.opened === join(state.home, "logs") && row.result === ""));
  check("native Open logs opens only the disposable home", true);
  const modulePath = process.env.PERRY_E2E_PLAYWRIGHT ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(modulePath).href);
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((key: string) => localStorage.setItem("perry.dashboard.key", key), state.key);
  await page.goto(`${state.base}/settings/computers`);
  await page.getByText("Online", { exact: true }).waitFor({ timeout: 30000 });
  check("installed Computers page shows one online Windows runner", await page.getByText("Online", { exact: true }).count() === 1 && (await page.locator("body").innerText()).includes("win32"));
  await page.screenshot({ path: join(output, "computers.png"), fullPage: true });
  writeFileSync(join(output, "installed-ready.done"), "native tray and Computers verified");
  await wait(() => records().some(row => row.menu?.[0].label === "Perry is unavailable"), 90);
  evidence.failureMenu = records().reverse().find(row => row.menu?.[0].label === "Perry is unavailable");
  check("real native tray reports runner failure", Boolean(evidence.failureMenu));
  writeFileSync(join(output, "failure-visible.done"), "native failure heading verified");
  await wait(() => JSON.parse(readFileSync(join(output, "state.json"), "utf8")).phase === "updated-ready", 600);
  await wait(() => records().reverse().find(row => row.menu)?.menu[0].label === "Perry is ready");
  check("native tray returns to ready after both update paths", true);
  writeFileSync(join(output, "updated-ready.done"), "native recovery and updates verified");
  checks.completed = true;
} catch (error) { checks.completed = false; evidence.error = String(error); process.exitCode = 1; console.error(error); }
finally { socket?.close(); await browser?.close(); evidence.diagnostics = diagnostics.slice(-1000); save(); }
