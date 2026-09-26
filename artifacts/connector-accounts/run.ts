import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Composio } from "@composio/core";
import { openChat, sleep } from "../browser";

// bun artifacts/connector-accounts/run.ts <outDir> [composio key]
// The Connectors page against a real Composio account: the key is the
// argument, or else the one in ~/.perry (read-only, never printed). A fresh
// PERRY_HOME and the production build (`pnpm build` first) on a free port.
// It only reads the account: no disconnect is confirmed and no sign-in begun.
//
// Ways it could fail:
//   1. Connected does not show each account: every connection Composio has,
//      duplicates and expired ones too, must have a row.
//   2. A row does not say which account: Gmail and Google Calendar, asked
//      "who am I", must show an address.
//   3. It asks every time: a second load must not ask again (the answer is
//      kept), and so be quicker.
//   4. An expired account cannot be renewed: it must say Expired and offer
//      Reconnect.
//   5. Search does not search: "calendar" must narrow Connected and the apps
//      to calendars; a word nothing has must say so.
//   6. The catalogue is bare: Popular must show logos that load, All apps a
//      page of apps and "Show more".
//   7. Disconnect acts without asking: it must ask, and "Keep it" must leave the
//      account connected.
//   8. Any page throws: no uncaught errors in the browser.

const [outDir, given] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/connector-accounts/run.ts <outDir> [composio key]");
mkdirSync(outDir, { recursive: true });
// Read with Node's own SQLite, read-only; the key goes from its output straight into this process.
const apiKey = given ?? (spawnSync("node", ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(join(homedir(), ".perry", "perry.sqlite"))}, { readOnly: true }); const row = db.prepare("SELECT doc FROM doc_secrets WHERE json_extract(doc, '$.name') = 'COMPOSIO_API_KEY'").get(); process.stdout.write(row ? JSON.parse(row.doc).value : "");`], { encoding: "utf8" }).stdout.trim() || undefined);
if (!apiKey) throw new Error("No Composio key: pass one, or connect Composio in ~/.perry first.");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "connectors-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-connectors-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
delete env.TELEGRAM_BOT_TOKEN;
delete env.COMPOSIO_API_KEY;
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

async function call<T>(path: string, args: object = {}, admin = false): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${admin ? "admin" : "call"}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { "x-perry-key": KEY } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 30) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
type Account = { id: string; toolkit: string; name: string; status: string; account?: string; logo?: string };
const composio = new Composio({ apiKey });
const truth = async () => ((await composio.connectedAccounts.list({ userIds: ["owner"], limit: 100 } as never)) as unknown as { items: Array<{ id: string; status: string; toolkit: { slug: string } }> }).items;

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("secrets:set", { name: "COMPOSIO_API_KEY", value: apiKey }, true);
  const expected = await truth();
  notes.composio = expected.map((item) => `${item.toolkit.slug} ${item.status}`);

  // 2 and 3: the accounts, asked once and then kept.
  let started = Date.now();
  const first = await call<{ accounts: Account[]; error?: string }>("dashboard:getConnectedAccounts", { key: KEY });
  const firstMs = Date.now() - started;
  started = Date.now();
  const second = await call<{ accounts: Account[] }>("dashboard:getConnectedAccounts", { key: KEY });
  const secondMs = Date.now() - started;
  notes.loads = { firstMs, secondMs, error: first.error };
  notes.accounts = first.accounts.map((item) => `${item.name} | ${item.status} | ${item.account ?? "-"}`);
  const address = (slug: string) => first.accounts.filter((item) => item.toolkit === slug && item.status === "ACTIVE").every((item) => /@/.test(item.account ?? ""));
  checks.showsEveryAccount = first.accounts.length === expected.length && expected.every((item) => first.accounts.some((row) => row.id === item.id));
  checks.namesTheAccount = first.accounts.some((item) => item.toolkit === "gmail") ? address("gmail") && address("googlecalendar") : true;
  checks.askedOnceThenKept = JSON.stringify(second.accounts.map((item) => item.account)) === JSON.stringify(first.accounts.map((item) => item.account)) && secondMs < firstMs;

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const has = (expression: string) => evaluate(`!!(${expression})`) as Promise<boolean>;
  const text = (expression: string) => evaluate(`(${expression})?.innerText ?? ""`) as Promise<string>;
  // The artifact is committed: real addresses are checked above, then shown as you@example.com in screenshots.
  const maskAndShoot = async (name: string) => {
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.replace(/[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g, "you@example.com"); return true; })()`);
    await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64")));
  };
  const connectedList = `document.querySelector('[aria-label="Connected accounts"]')`;
  await send("Page.navigate", { url: `${BASE}/connectors` });
  await until(() => has(connectedList), "the Connected section", 60);
  await until(() => has(`document.querySelector('[aria-label="Popular apps"]')`), "the catalogue", 60);
  await sleep(1_500);

  // 1, 2 and 4 on the page.
  const rows = await evaluate(`[...${connectedList}.querySelectorAll("li")].map((li) => li.innerText.replace(/\\n+/g, " | "))`) as string[];
  notes.rows = rows;
  checks.pageShowsEachAccount = rows.length === expected.length;
  checks.pageShowsAddresses = expected.some((item) => item.toolkit.slug === "gmail") ? rows.some((row) => /^Gmail \| [^|]*@/.test(row)) : true;
  const expired = rows.filter((row) => row.includes("Expired"));
  checks.expiredOffersReconnect = expired.length === expected.filter((item) => item.status === "EXPIRED").length && expired.every((row) => row.includes("Reconnect"));
  await maskAndShoot("connectors.png");

  // 6. Logos and paging.
  const logos = await evaluate(`[...document.querySelectorAll('[aria-label="Popular apps"] img')].map((img) => img.complete && img.naturalWidth > 0)`) as boolean[];
  notes.popularLogos = `${logos.filter(Boolean).length}/${logos.length}`;
  const allApps = await evaluate(`document.querySelectorAll('[aria-label="All apps"] > li').length`) as number;
  checks.catalogueHasLogosAndPages = logos.length >= 6 && logos.filter(Boolean).length >= logos.length - 1 && allApps === 40 && await has(`[...document.querySelectorAll("button")].some((b) => b.innerText.startsWith("Show more"))`);

  // 5. Search.
  const typeSearch = (value: string) => evaluate(`(() => { const el = document.querySelector('input[aria-label="Search apps"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await typeSearch("calendar");
  await until(() => has(`document.querySelector('[aria-label="Matching apps"]')`), "search results");
  const narrowed = await evaluate(`[...(${connectedList}?.querySelectorAll("li") ?? [])].map((li) => li.innerText.split("\\n")[0])`) as string[];
  const appsFound = await evaluate(`[...document.querySelectorAll('[aria-label="Matching apps"] > li')].map((li) => li.innerText.split("\\n")[0])`) as string[];
  notes.search = { narrowed, apps: appsFound.slice(0, 8), count: appsFound.length };
  checks.searchNarrows = narrowed.every((name) => /calendar/i.test(name)) && appsFound.some((name) => name.startsWith("Google Calendar")) && appsFound.length < allApps + 10;
  await maskAndShoot("connectors-search.png");
  await typeSearch("zzqqxxnothing");
  await until(async () => (await text(`document.querySelector("main")`)).includes("No app by that name"), "the empty search");
  checks.searchSaysNothing = (await text(`document.querySelector("main")`)).includes("No connected account matches");
  await typeSearch("");
  await until(() => has(connectedList), "the full page again");

  // 7. Disconnect asks, and Cancel keeps it.
  await evaluate(`[...${connectedList}.querySelectorAll("button")].find((b) => b.innerText.trim() === "Disconnect").click(); true`);
  await until(() => has(`document.querySelector('[role="alertdialog"], [role="dialog"]')`), "the confirmation");
  const dialog = await text(`document.querySelector('[role="alertdialog"], [role="dialog"]')`);
  notes.dialog = dialog.replace(/\n+/g, " | ");
  await evaluate(`[...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find((b) => b.innerText.trim() === "Keep it").click(); true`);
  await until(async () => !(await has(`document.querySelector('[role="alertdialog"], [role="dialog"]')`)), "the dialog to close");
  checks.disconnectAsksAndCancelKeeps = /Disconnect/.test(dialog) && (await truth()).length === expected.length;

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (server.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill("SIGTERM");
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), log.replaceAll(KEY, "<key>").replaceAll(apiKey, "<composio key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

// Addresses stay out of the committed result too.
const redacted = JSON.parse(JSON.stringify(notes).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "you@example.com"));
const result = { ranAt: new Date().toISOString(), checks, notes: redacted, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
