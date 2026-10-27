// E2E failure inventory: README.md. Uses the existing isolated connector/browser workflow.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChat, sleep } from "../browser";
import { KEY, startStandIn } from "../connector-accounts/stand-in";

const output = resolve("artifacts/connector-details/results");
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-connector-details-"));
const provider = await startStandIn();
provider.connections.find((item) => item.id === "ca_slack")!.workspace = "Design team";
provider.connections.push({ id: "ca_slack_other", toolkit: "slack", status: "ACTIVE", createdAt: "2026-09-10T09:00:00Z", identity: "alex", workspace: "Engineering team" });
const longEmail = `${"long-account-name-".repeat(6)}@example.com`;
provider.connections.push({ id: "ca_gmail_long", toolkit: "gmail", status: "ACTIVE", createdAt: "2026-09-10T09:00:00Z", identity: longEmail });
const port = await new Promise<number>((done) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const address = probe.address() as { port: number };
    probe.close(() => done(address.port));
  });
});
const base = `http://127.0.0.1:${port}`;
const key = "connector-details-fixture";
const server = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PERRY_HOME: home, DASHBOARD_KEY: key, PERRY_PORT: String(port), PERRY_CREDENTIAL_KEY: "11".repeat(32), COMPOSIO_API_KEY: KEY, COMPOSIO_BASE_URL: provider.url, TELEMETRY_DISABLED: "true" },
});
let log = "";
server.stdout?.on("data", (chunk) => { log += chunk; });
server.stderr?.on("data", (chunk) => { log += chunk; });
const checks: string[] = [];
let browser: Awaited<ReturnType<typeof openChat>> | undefined;
async function until(test: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await test().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`Timed out: ${label}`);
}
async function call(path: string, args: object = {}, admin = false): Promise<any> {
  const response = await fetch(`${base}/api/backend/${admin ? "admin" : "call"}`, {
    method: "POST", headers: { "content-type": "application/json", ...(admin ? { "x-perry-key": key } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body = await response.json() as { value?: unknown; error?: string };
  if (body.error) throw new Error(body.error);
  return body.value;
}
let failure: string | undefined;
try {
  await until(() => fetch(`${base}/api/backend/http/health`).then((r) => r.ok), "server health");
  // Older installs already have identities without richer profiles.
  await call("connectorAccounts:remember", { accountId: "ca_gmail_sam", toolkit: "gmail", identity: "sam@example.com" }, true);
  const first = await call("dashboard:getConnectedAccounts", { key });
  assert.ok(!first.error, first.error);
  const sam = first.accounts.find((item: any) => item.id === "ca_gmail_sam");
  assert.deepEqual(sam.profile, { email: "sam@example.com", username: "sam", displayName: "Sam Taylor" });
  assert.equal(first.accounts.find((item: any) => item.id === "ca_gmail_long").account, longEmail);
  assert.ok(!JSON.stringify(first).includes("fixture-token-never-display"));
  checks.push("Existing identities gain name, email and username; full long identities survive; token fields excluded");
  const cached = await call("connectorAccounts:identities", { accountIds: ["ca_gmail_sam"] }, true);
  await call("dashboard:getConnectedAccounts", { key });
  const again = await call("connectorAccounts:identities", { accountIds: ["ca_gmail_sam"] }, true);
  assert.equal(again.ca_gmail_sam.checkedAt, cached.ca_gmail_sam.checkedAt);
  provider.set("ca_gmail_sam", "EXPIRED");
  const expired = await call("dashboard:getConnectedAccounts", { key });
  assert.deepEqual(expired.accounts.find((item: any) => item.id === "ca_gmail_sam").profile, sam.profile);
  checks.push("Profiles cached between loads and retained after expiration");

  browser = await openChat(base, key);
  const { evaluate, send } = browser;
  await send("Page.navigate", { url: `${base}/apps/connectors` });
  await until(() => evaluate(`!!document.querySelector('[aria-label="Connected apps"]')`) as Promise<boolean>, "connected apps");
  const connected = () => evaluate(`document.querySelector('[aria-label="Connected apps"]').innerText`) as Promise<string>;
  assert.match(await connected(), /Sam Taylor/);
  assert.match(await connected(), /Design team/);
  assert.match(await connected(), /Engineering team/);
  assert.match(await connected(), /Added/);
  const slackRows = await evaluate(`document.querySelector('[aria-label="Slack accounts"]').children.length`);
  assert.equal(slackRows, 2);
  assert.match(await connected(), /Connected 2 times/);
  checks.push("Dashboard shows account details, dates, separate workspaces, and duplicate connection controls");
  const search = async (value: string) => {
    await evaluate(`(() => { const input = document.querySelector('input[aria-label="Search apps"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(400);
  };
  await search("Taylor");
  assert.match(await connected(), /sam@example.com/);
  assert.doesNotMatch(await connected(), /alex@example.com/);
  await search("Engineering team");
  assert.match(await connected(), /Engineering team/);
  assert.doesNotMatch(await connected(), /Design team/);
  checks.push("Search finds display names and workspaces");
  await search("");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const clip = await evaluate(`(() => { const r = document.querySelector('section[aria-label="Connected"]').getBoundingClientRect(); return { x: r.x - 16, y: r.y, width: r.width + 32, height: r.height, scale: 1 }; })()`);
  writeFileSync(join(output, "desktop.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip })).data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  const longVisible = await evaluate(`document.querySelector('[aria-label="Connected apps"]').innerText.includes(${JSON.stringify(longEmail)})`);
  assert.equal(longVisible, true);
  writeFileSync(join(output, "mobile.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(300);
  writeFileSync(join(output, "mobile-dark.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  assert.deepEqual(browser.errors, []);
  checks.push("375px layout has no horizontal overflow, long identity remains complete, no browser errors");
} catch (error) {
  failure = String(error);
} finally {
  browser?.close();
  if (server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await provider.close();
  await sleep(1000);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows may hold the isolated SQLite file briefly. */ }
  writeFileSync(join(output, "server.log"), log);
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: !failure, checks, failure }, null, 2));
}
console.log(JSON.stringify({ passed: !failure, checks, failure }, null, 2));
process.exit(failure ? 1 : 0);
