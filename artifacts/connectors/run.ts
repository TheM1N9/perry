import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Composio } from "@composio/core";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/connectors/run.ts <outDir> <dashboardKey>
// Needs this branch pushed with `convex dev`, `next dev -p 3005`, CONVEX_URL,
// a Composio key on the deployment, and at least one ACTIVE Composio account
// for the owner. The Convex CLI reads the key; nothing is connected for real.
// Every link the test starts is deleted before it ends.
//
// Ways this could fail, and what catches each:
//   1. The list reads one page of the catalogue (20 of ~1,500 toolkits), so a
//      real connection outside that page never shows: every toolkit Composio
//      reports ACTIVE for the owner must be in the dashboard's list.
//   2. The callback URL is dropped before Composio: an old deployment rejects
//      the extra argument, and a new one must return a connect link for it.
//   3. Sign-in opens a new tab, so nothing brings you back: clicking a
//      suggestion must send this same tab to connect.composio.dev.
//   4. Coming back does nothing: /connectors?connected=<active>&status=success
//      must say that account is connected, and the query must be cleared.
//   5. A failed sign-in reads as success: ?connected=<slug>&status=failed for
//      an unconnected toolkit must say it didn't finish.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/connectors/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const composio = new Composio({ apiKey: JSON.parse(cli("run", "secrets:get", JSON.stringify({ name: "COMPOSIO_API_KEY" }))) });

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

// Accounts made while this runs are the test's own, and are removed at the end.
const accounts = async () => (await composio.connectedAccounts.list({ userIds: ["owner"], limit: 200 })).items;
const before = new Set((await accounts()).map((account) => account.id));
const cleanUp = async () => {
  for (const account of await accounts()) if (!before.has(account.id)) await composio.connectedAccounts.delete(account.id);
};

try {
  // 1. Every active account shows.
  const active = [...new Set((await accounts()).filter((account) => account.status === "ACTIVE").map((account) => account.toolkit.slug))].sort();
  const listed = await convex.action(api.dashboard.getConnectors, { key: dashboardKey });
  const shown = listed.connectors.filter((item) => item.connected).map((item) => item.slug).sort();
  notes.active = active;
  notes.shown = shown;
  checks.everyActiveAccountListed = active.length > 0 && active.every((slug) => shown.includes(slug));

  // 2. The callback URL is accepted and a link comes back.
  const link = await convex.action(api.dashboard.connectToolkit, { key: dashboardKey, toolkit: "slack", callbackUrl: `${base}/connectors?connected=slack` });
  checks.callbackAccepted = typeof link.redirectUrl === "string" && link.redirectUrl.startsWith("https://connect.composio.dev/");

  const browser = await openChat(base, dashboardKey);
  try {
    const waitFor = (test: string, what: string) => browser.evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > 30000 ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 200); tick(); })`);
    const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await browser.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

    // 4. Coming back from a sign-in that worked.
    const returnedSlug = active[0]!;
    const returnedName = listed.connectors.find((item) => item.slug === returnedSlug)!.name;
    await browser.send("Page.navigate", { url: `${base}/connectors?connected=${returnedSlug}&status=success&connected_account_id=ca_test` });
    await waitFor(`document.body.innerText.includes(${JSON.stringify(`${returnedName} is connected`)})`, "no success notice after returning");
    checks.returnSaysConnected = true;
    checks.returnClearsQuery = await browser.evaluate(`location.pathname === "/connectors" && location.search === ""`);
    await shot("returned-success.png");

    // 5. Coming back from a sign-in that failed.
    await browser.send("Page.navigate", { url: `${base}/connectors?connected=youtube&status=failed` });
    await waitFor(`document.body.innerText.includes("Signing in to youtube didn't finish")`, "no failure notice after returning");
    checks.returnSaysFailed = true;
    await shot("returned-failed.png");

    // 3. Connecting goes to Composio in this tab.
    await browser.send("Page.navigate", { url: `${base}/connectors` });
    await waitFor(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Slack")`, "no Slack suggestion");
    const targetsBefore = (await (await fetch("http://127.0.0.1:9333/json/list")).json() as Array<{ type: string }>).filter((t) => t.type === "page").length;
    await browser.evaluate(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Slack").click(); true`);
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      const href = await browser.evaluate(`location.href`).catch(() => "");
      if (String(href).startsWith("https://connect.composio.dev/") || String(href).includes("slack.com")) break;
    }
    const targetsAfter = (await (await fetch("http://127.0.0.1:9333/json/list")).json() as Array<{ type: string }>).filter((t) => t.type === "page").length;
    const landed = String(await browser.evaluate(`location.href`));
    notes.connectLanded = landed.split("?")[0];
    checks.connectUsesSameTab = targetsAfter === targetsBefore && (landed.startsWith("https://connect.composio.dev/") || landed.includes("slack.com"));
    await shot("connect-redirect.png");

    notes.pageErrors = browser.errors;
  } finally {
    browser.close();
  }
} finally {
  await cleanUp();
  checks.cleanedUp = (await accounts()).every((account) => before.has(account.id));
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
