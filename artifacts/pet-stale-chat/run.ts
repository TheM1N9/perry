import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// pnpm exec bun artifacts/pet-stale-chat/run.ts
// Real pet page and backend in a disposable home; no runner or model calls.
// Cover a stale saved id, a valid saved id, deletion with the panel closed,
// opening the recovered panel, and a reload after recovery. Keep screenshots
// and result.json so each run is reviewable and repeatable.
// A new chat must also stay selected when refreshing the list is slow.
// Cleanup must stop the server on the host OS, stay inside the temporary
// home, and preserve result.json even when cleanup itself fails.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(repo, "artifacts/pet-stale-chat");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-stale-chat-"));
const port = await new Promise<number>((done) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const port = (probe.address() as { port: number }).port;
    probe.close(() => done(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const key = "pet-stale-chat-e2e";
const env = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(port), DASHBOARD_KEY: key };
for (const name of Object.keys(env)) if (/^(CONVEX|TELEGRAM|COMPOSIO|PERRY_ENGINE|ELECTRON_RUN_AS_NODE)/.test(name)) delete env[name as keyof typeof env];
const server = spawn("node", [join(repo, "node_modules/next/dist/bin/next"), "dev", "-p", String(port)], { cwd: repo, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (chunk) => { log += chunk; });
server.stderr.on("data", (chunk) => { log += chunk; });
const checks: Record<string, boolean> = {};
let failure: string | undefined;
let browser: Awaited<ReturnType<typeof openChat>> | undefined;
async function until(test: () => Promise<boolean>, seconds = 40) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await test().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error("Timed out waiting for pet state");
}
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${base}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args: { key, ...args } }) });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${path}: ${body.error}`);
  return body.value;
}
try {
  await until(() => fetch(`${base}/api/backend/http/health`).then((response) => response.ok), 120);
  await call("dashboard:skipOnboarding");
  const valid = await call<string>("dashboard:createChat");
  await call("dashboard:renameChat", { id: valid, title: "Still here" });
  // Compile before attaching Chrome so development reloads cannot interrupt
  // the browser helper's initial navigation and storage setup.
  for (const path of ["/", "/chat", "/pet"]) await fetch(`${base}${path}`);
  await sleep(1000);
  browser = await openChat(base, key);
  const pet = browser;
  const showPet = async (id: string | null) => {
    await pet.evaluate(`localStorage.${id ? `setItem("perry.pet.chat", ${JSON.stringify(id)})` : 'removeItem("perry.pet.chat")'}; true`);
    await pet.send("Page.navigate", { url: `${base}/pet` });
    await until(() => pet.evaluate(`!!document.querySelector('button[aria-label^="Perry."]')`));
  };
  const healthy = () => pet.evaluate(`!document.body.innerText.includes("Something went wrong")`);
  const openPanel = async () => {
    const point = await pet.evaluate(`(() => { const r = document.querySelector('button[aria-label^="Perry."]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await pet.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  };
  const screenshot = async (name: string) => {
    const image = await pet.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(image.data, "base64"));
  };
  await showPet("stale-chat-from-a-previous-install");
  await until(() => pet.evaluate(`localStorage.getItem("perry.pet.chat") === null`));
  checks.staleSelectionCleared = await healthy();
  await screenshot("stale-selection-recovered");
  await openPanel();
  await until(() => pet.evaluate(`!!document.querySelector('textarea')`));
  checks.recoveredPanelOpens = await healthy();
  await screenshot("recovered-chat-panel");
  // Exercise the actual composer, not just a saved id. Perry's mutation
  // promise waits for query refreshes before PetChat selects the new id.
  await pet.evaluate(`(() => {
    const original = window.fetch;
    window.__slowChatLists = 0;
    window.fetch = async (...args) => {
      const path = args[1]?.body ? JSON.parse(args[1].body).path : null;
      if (path === "dashboard:listChats" && window.__createdChatId) {
        window.__slowChatLists++;
        await new Promise((done) => setTimeout(done, 800));
      }
      const response = await original(...args);
      if (path === "dashboard:createChat") window.__createdChatId = (await response.clone().json()).value;
      return response;
    };
    const input = document.querySelector('textarea[aria-label="Message Perry"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Keep this new pet chat");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await until(() => pet.evaluate(`!document.querySelector('button[aria-label="Send"]').disabled`));
  await pet.evaluate(`document.querySelector('button[aria-label="Send"]').click(); true`);
  await until(() => pet.evaluate(`!!window.__createdChatId && localStorage.getItem("perry.pet.chat") === window.__createdChatId && [...document.querySelectorAll('[data-role="user"]')].some((item) => item.textContent.includes("Keep this new pet chat"))`));
  checks.newChatSurvivesSlowListRefresh = await pet.evaluate(`window.__slowChatLists > 0`) && await healthy();
  await screenshot("new-chat-selected");
  await showPet(valid);
  await openPanel();
  await until(() => pet.evaluate(`document.body.innerText.includes("Still here")`));
  checks.validSelectionRestored = await pet.evaluate(`localStorage.getItem("perry.pet.chat") === ${JSON.stringify(valid)}`) && await healthy();
  await showPet(valid); // Panel closed while its selected chat is deleted.
  await call("dashboard:deleteChat", { id: valid });
  await until(() => pet.evaluate(`localStorage.getItem("perry.pet.chat") === null`));
  checks.deletedSelectionClearedWhileClosed = await healthy();
  await showPet(null);
  await sleep(1000);
  checks.reloadStaysHealthy = await healthy();
  checks.noPageExceptions = pet.errors.length === 0;
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
} finally {
  try {
    browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit", { signal: AbortSignal.timeout(10_000) });
      if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else server.kill("SIGTERM"); // next dev forwards SIGTERM to its worker.
      await exited;
    }
    // Check the absolute target before recursively deleting only this run's home.
    const target = realpathSync(home);
    if (!target.startsWith(`${realpathSync(tmpdir())}${sep}perry-stale-chat-`)) throw new Error(`Unexpected test home: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    failure = [failure, `Cleanup failed: ${String(error)}`].filter(Boolean).join("\n");
  }
  writeFileSync(join(out, "server.log"), log);
}
const passed = !failure && Object.keys(checks).length === 7 && Object.values(checks).every(Boolean);
writeFileSync(join(out, "result.json"), JSON.stringify({ passed, checks, failure }, null, 2));
console.log(JSON.stringify({ passed, checks, failure }, null, 2));
process.exit(passed ? 0 : 1);
