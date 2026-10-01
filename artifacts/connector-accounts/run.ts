import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Composio } from "@composio/core";
import { openChat, sleep } from "../browser";
import { startStandIn } from "./stand-in";

// bun artifacts/connector-accounts/run.ts <outDir> [composio key | --stand-in]
// The Connectors page, grouped by app, on a fresh PERRY_HOME (in
// PERRY_E2E_HOMES, else the temp folder) and the production build
// (`pnpm build` first) on a free port.
//
// Against the owner's real Composio account by default: the key is the
// argument, or else the one in ~/.perry (read-only, never printed). It only
// reads the account: no disconnect is confirmed and no sign-in begun.
//
// With --stand-in, against stand-in.ts instead (COMPOSIO_BASE_URL, which the
// Composio SDK reads, so Perry's code is unchanged): made-up connections with
// the cases the real account may not have today, a duplicate sign-in, an
// account that expired after it was named, one never finished. There the
// removals and sign-ins are carried out, since nothing real is touched.
//
// Ways it could fail:
//   1. A connection goes missing: every one Composio has must be on the page,
//      as an account or counted as a spare of one ("Connected 2 times").
//   2. It is still a row per connection: each app must be one card, holding
//      its accounts, with how many and how many need attention.
//   3. The same address shows twice: one account per address per app; with
//      the spare noted, and the working connection the one shown.
//   4. Accounts with no address are merged: nothing says two of them are the
//      same account, so each must stay its own, told apart by when added.
//   5. A row does not say which account: Gmail and Google Calendar, asked
//      "who am I", must show an address; an account that expires later keeps it.
//   6. It asks every time: a second load must not ask again (the answer is
//      kept), and so be quicker.
//   7. Something broken hides: an expired account must say Expired and offer
//      Reconnect, its card must say it needs reconnecting, and cards needing
//      attention come first, then by name. A working account says nothing
//      about its state (no "Connected" on every row), only Disconnect.
//   8. "Add another account" connects something else: it must start a sign-in
//      for that card's app, coming back to this page.
//   9. Removing spares removes the account, or disconnecting leaves a spare
//      behind: Remove extras must delete only the spares, and Disconnect every
//      connection of that account, each after asking.
//  10. Disconnect acts without asking: "Keep it" must leave everything connected.
//  11. Search does not search: an app's name must narrow to its card whole, an
//      address to the accounts with it; a word nothing has must say so.
//  12. The catalogue counts connections, not accounts: "N connected" must count
//      each working account once however many times it was signed in to.
//  13. The catalogue is bare: Popular must show logos that load, All apps a
//      page of apps and "Show more" (real account only: the stand-in has 8).
//  14. Any page throws: no uncaught errors in the browser. With the stand-in,
//      no call it was not built for.

const [outDir, given] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/connector-accounts/run.ts <outDir> [composio key | --stand-in]");
mkdirSync(outDir, { recursive: true });
const standIn = given === "--stand-in" ? await startStandIn() : null;
// Read with Node's own SQLite, read-only; the key goes from its output straight into this process.
const apiKey = standIn ? "stand-in-key" : given ?? (spawnSync("node", ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(join(homedir(), ".perry", "perry.sqlite"))}, { readOnly: true }); const row = db.prepare("SELECT doc FROM doc_secrets WHERE json_extract(doc, '$.name') = 'COMPOSIO_API_KEY'").get(); process.stdout.write(row ? JSON.parse(row.doc).value : "");`], { encoding: "utf8" }).stdout.trim() || undefined);
if (!apiKey) throw new Error("No Composio key: pass one, or connect Composio in ~/.perry first.");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "connectors-e2e-key";
const homes = process.env.PERRY_E2E_HOMES ?? tmpdir();
mkdirSync(homes, { recursive: true });
const home = mkdtempSync(join(homes, "perry-connectors-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = { mode: standIn ? "stand-in" : "real account" };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
delete env.TELEGRAM_BOT_TOKEN;
delete env.COMPOSIO_API_KEY;
delete env.COMPOSIO_BASE_URL;
if (standIn) env.COMPOSIO_BASE_URL = standIn.url;
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
/** A card as the page shows it: the app, its summary line, and each account row. */
type Card = { name: string; summary: string; add: string; rows: Array<{ label: string; times: number; status: string; reconnect: boolean; actions: string; text: string }> };
const truth = standIn
  ? async () => standIn.connections.map((item) => ({ id: item.id, status: item.status, toolkit: { slug: item.toolkit } }))
  : async () => ((await new Composio({ apiKey }).connectedAccounts.list({ userIds: ["owner"], limit: 100 } as never)) as unknown as { items: Array<{ id: string; status: string; toolkit: { slug: string } }> }).items;

/** Each real address seen, as a made-up one: the same address always the same, two different ones different. */
const aliases: Record<string, string> = {};
const alias = (address?: string) => { if (address?.includes("@")) aliases[address.toLowerCase()] ??= `account${Object.keys(aliases).length + 1}@example.com`; };
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("secrets:set", { name: "COMPOSIO_API_KEY", value: apiKey }, true);

  // 5 and 6: the accounts, asked once and then kept.
  let started = Date.now();
  const first = await call<{ accounts: Account[]; error?: string }>("dashboard:getConnectedAccounts", { key: KEY });
  const firstMs = Date.now() - started;
  started = Date.now();
  const second = await call<{ accounts: Account[] }>("dashboard:getConnectedAccounts", { key: KEY });
  const secondMs = Date.now() - started;
  notes.loads = { firstMs, secondMs, error: first.error };
  const address = (slug: string) => first.accounts.filter((item) => item.toolkit === slug && item.status === "ACTIVE").every((item) => /@/.test(item.account ?? ""));
  checks.namesTheAccount = first.accounts.some((item) => item.toolkit === "gmail") ? address("gmail") && address("googlecalendar") : true;
  checks.askedOnceThenKept = JSON.stringify(second.accounts.map((item) => item.account)) === JSON.stringify(first.accounts.map((item) => item.account)) && secondMs < firstMs;

  // Later, at the stand-in: the second Gmail and the old Calendar sign-in expire, their addresses already known.
  if (standIn) {
    standIn.set("ca_gmail_sam", "EXPIRED");
    standIn.set("ca_cal_old", "EXPIRED");
  }
  const expected = await truth();
  notes.composio = expected.map((item) => `${item.toolkit.slug} ${item.status}`);
  const now = await call<{ accounts: Account[] }>("dashboard:getConnectedAccounts", { key: KEY });
  for (const item of [...first.accounts, ...now.accounts]) alias(item.account);
  notes.accounts = now.accounts.map((item) => `${item.name} | ${item.status} | ${item.account ?? "-"}`);
  checks.showsEveryAccount = now.accounts.length === expected.length && expected.every((item) => now.accounts.some((row) => row.id === item.id));

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const has = (expression: string) => evaluate(`!!(${expression})`) as Promise<boolean>;
  const text = (expression: string) => evaluate(`(${expression})?.innerText ?? ""`) as Promise<string>;
  // The artifact is committed: real addresses are checked, then each shown as a made-up one of its own
  // (two different Google accounts stay two different addresses) in screenshots.
  const mask = () => standIn ? Promise.resolve() : evaluate(`(() => { const aliases = ${JSON.stringify(aliases)}; const swap = (text) => text.replace(/[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g, (found) => aliases[found.toLowerCase()] ?? "someone@example.com"); const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = swap(n.nodeValue); for (const input of document.querySelectorAll("input")) input.value = swap(input.value); return true; })()`);
  /** A screenshot of the page, or of one part of it however far down it reaches. */
  const shoot = async (name: string, selector?: string) => {
    await mask();
    // A part taller than the window: make the window as tall as the page, measure it there, then put the window back.
    if (selector) await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: Math.max(800, await evaluate(`document.documentElement.scrollHeight`) as number), deviceScaleFactor: 1, mobile: false });
    await sleep(selector ? 400 : 0);
    const clip = selector ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 16), width: r.width + 32, height: r.height + 32, scale: 1 }; })()`) : undefined;
    const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64"));
    if (selector) await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    // React keeps the masked text in rows it doesn't redraw, so the checks after this read a fresh page.
    if (!standIn) {
      await send("Page.reload");
      await until(() => has(`document.querySelector('[aria-label="Connected apps"]') && document.querySelector('[aria-label="Popular apps"]')`), "the page after a screenshot", 60);
      await sleep(1_500);
    }
  };
  const cardsList = `document.querySelector('[aria-label="Connected apps"]')`;
  const cards = () => evaluate(`[...(${cardsList}?.children ?? [])].map((li) => ({
    name: li.getAttribute("aria-label"),
    summary: li.querySelector(":scope > div p:nth-of-type(2)")?.innerText ?? "",
    add: li.querySelector(":scope > div button")?.getAttribute("aria-label") ?? "",
    rows: [...li.querySelectorAll(":scope > ul > li")].map((row) => ({
      label: row.querySelector("p")?.innerText ?? "",
      times: Number(row.innerText.match(/Connected (\\d+) times/)?.[1] ?? 1),
      // A state is shown only when the account isn't working; none shown means it works.
      status: row.querySelector(":scope > div:last-child > span")?.innerText || "Connected",
      actions: row.querySelector(":scope > div:last-child")?.innerText.replace(/\\n+/g, " | ") ?? "",
      reconnect: [...row.querySelectorAll("button")].some((b) => b.innerText.trim() === "Reconnect"),
      text: row.innerText.replace(/\\n+/g, " | "),
    })),
  }))`) as Promise<Card[]>;
  const typeSearch = (value: string) => evaluate(`(() => { const el = document.querySelector('input[aria-label="Search apps"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const dialog = `document.querySelector('[role="alertdialog"], [role="dialog"]')`;
  const clickIn = (scope: string, label: string) => evaluate(`(() => { const b = [...${scope}.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)}); b.click(); return true; })()`);
  const card = (name: string) => `${cardsList}.querySelector(':scope > li[aria-label=${JSON.stringify(name)}]')`;
  const row = (name: string, label: string) => `[...${card(name)}.querySelectorAll(":scope > ul > li")].find((li) => li.querySelector("p")?.innerText === ${JSON.stringify(label)})`;
  const catalogueNote = (list: string, name: string) => evaluate(`[...document.querySelectorAll('[aria-label="${list}"] > li')].find((li) => li.querySelector("p")?.firstChild?.textContent === ${JSON.stringify(name)})?.querySelector("p span")?.innerText ?? ""`) as Promise<string>;

  await send("Page.navigate", { url: `${BASE}/connectors` });
  await until(() => has(cardsList), "the Connected section", 60);
  await until(() => has(`document.querySelector('[aria-label="Popular apps"]')`), "the catalogue", 60);
  await sleep(1_500);

  // 1 to 4 and 7 on the page, whatever the account holds.
  const shown = await cards();
  notes.cards = shown.map((item) => ({ name: item.name, summary: item.summary, rows: item.rows.map((entry) => entry.text) }));
  const names = shown.map((item) => item.name);
  const toolkits = new Set(expected.map((item) => item.toolkit.slug));
  const rows = shown.flatMap((item) => item.rows);
  checks.everyConnectionAccountedFor = rows.reduce((sum, entry) => sum + entry.times, 0) === expected.length;
  checks.oneCardPerApp = names.length === toolkits.size && new Set(names).size === names.length
    && shown.every((item) => new RegExp(`^${item.rows.length} accounts?\\b`).test(item.summary));
  checks.oneRowPerAddress = shown.every((item) => { const addresses = item.rows.map((entry) => entry.label).filter((label) => label.includes("@")); return new Set(addresses).size === addresses.length; });
  checks.pageShowsAddresses = expected.some((item) => item.toolkit.slug === "gmail") ? shown.find((item) => item.name === "Gmail")!.rows.filter((entry) => entry.status === "Connected").every((entry) => entry.label.includes("@")) : true;
  const broken = (item: Card) => item.rows.filter((entry) => entry.status !== "Connected" && entry.status !== "Finishing sign-in").length;
  checks.expiredOffersReconnect = rows.filter((entry) => entry.status === "Expired").length >= expected.filter((item) => item.status === "EXPIRED").length - rows.filter((entry) => entry.times > 1).length
    && rows.filter((entry) => entry.status !== "Connected").every((entry) => entry.reconnect)
    && shown.every((item) => broken(item) === 0 ? !/need/.test(item.summary) : item.summary.includes(`${broken(item)} need`));
  const attention = shown.map((item) => item.rows.some((entry) => entry.status !== "Connected"));
  const sorted = (list: string[]) => list.every((name, index) => index === 0 || list[index - 1].localeCompare(name) <= 0);
  const firstFine = attention.indexOf(false);
  checks.attentionFirstThenByName = (firstFine === -1 || attention.slice(firstFine).every((value) => !value))
    && sorted(names.filter((_, index) => attention[index])) && sorted(names.filter((_, index) => !attention[index]));
  checks.everyCardAddsAnother = shown.every((item) => item.add === `Add another ${item.name} account`);
  checks.workingAccountsSayNothing = rows.filter((entry) => entry.status === "Connected").every((entry) => entry.actions === "Disconnect");
  // No boxes: neither the app groups nor their account lists are drawn with a border.
  checks.noBoxes = await evaluate(`[...${cardsList}.children].every((li) => [li, ...li.querySelectorAll(":scope > div, :scope > ul, :scope > ul > li")].every((el) => parseFloat(getComputedStyle(el).borderTopWidth) === 0 && parseFloat(getComputedStyle(el).borderBottomWidth) === 0))`) as boolean;
  await shoot("connectors.png", `section[aria-label="Connected"]`);

  if (!standIn) {
    // 13. Logos and paging: logos load lazily from Composio's servers, so in view and given a moment.
    await evaluate(`document.querySelector('[aria-label="Popular apps"]').scrollIntoView(); true`);
    await until(() => evaluate(`[...document.querySelectorAll('[aria-label="Popular apps"] img')].every((img) => img.complete && img.naturalWidth > 0)`), "the logos", 15).catch(() => {});
    const logos = await evaluate(`[...document.querySelectorAll('[aria-label="Popular apps"] img')].map((img) => img.complete && img.naturalWidth > 0)`) as boolean[];
    notes.popularLogos = `${logos.filter(Boolean).length}/${logos.length}`;
    const allApps = await evaluate(`document.querySelectorAll('[aria-label="All apps"] > li').length`) as number;
    checks.catalogueHasLogosAndPages = logos.length >= 6 && logos.filter(Boolean).length >= logos.length - 1 && allApps === 40 && await has(`[...document.querySelectorAll("button")].some((b) => b.innerText.startsWith("Show more"))`);
    await shoot("connectors-page.png");

    // 11. Search by app, by address, and for nothing.
    await typeSearch("calendar");
    await until(() => has(`document.querySelector('[aria-label="Matching apps"]')`), "search results");
    const narrowed = (await cards()).map((item) => item.name);
    const appsFound = await evaluate(`[...document.querySelectorAll('[aria-label="Matching apps"] > li')].map((li) => li.innerText.split("\\n")[0])`) as string[];
    notes.search = { narrowed, apps: appsFound.slice(0, 8), count: appsFound.length };
    checks.searchNarrowsApps = narrowed.every((name) => /calendar/i.test(name)) && appsFound.some((name) => name.startsWith("Google Calendar"));
    await shoot("connectors-search.png");
    const someAddress = rows.find((entry) => entry.label.includes("@"))?.label;
    if (someAddress) {
      await typeSearch(someAddress);
      await sleep(500);
      const byAddress = await cards();
      // Which cards and rows it kept, as whether each is that address, so none is written down.
      notes.searchAddress = byAddress.map((item) => `${item.name}: ${item.rows.map((entry) => entry.label === someAddress ? "that address" : entry.label.toLowerCase().includes(someAddress.toLowerCase()) ? "containing it" : "another").join(", ")}`);
      checks.searchMatchesAddress = byAddress.length > 0 && byAddress.every((item) => item.rows.every((entry) => entry.label.toLowerCase().includes(someAddress.toLowerCase())));
    }
    await typeSearch("zzqqxxnothing");
    await until(async () => (await text(`document.querySelector("main")`)).includes("No app by that name"), "the empty search");
    checks.searchSaysNothing = (await text(`document.querySelector("main")`)).includes("No connected app or account matches");
    await typeSearch("");
    await until(() => has(cardsList), "the full page again");

    // 10. Disconnect asks, and Keep it keeps.
    await clickIn(cardsList, "Disconnect");
    await until(() => has(dialog), "the confirmation");
    notes.dialog = (await text(dialog)).replace(/\n+/g, " | ");
    await clickIn(dialog, "Keep it");
    await until(async () => !(await has(dialog)), "the dialog to close");
    checks.disconnectAsksAndCancelKeeps = /Disconnect/.test(String(notes.dialog)) && (await truth()).length === expected.length;
  } else {
    // What the stand-in holds, card by card.
    const byName = Object.fromEntries(shown.map((item) => [item.name, item]));
    const gmail = byName.Gmail;
    const calendar = byName["Google Calendar"];
    const higgsfield = byName["Higgsfield MCP"];
    checks.orderIsAttentionThenName = JSON.stringify(names) === JSON.stringify(["Gmail", "Notion", "YouTube", "Google Calendar", "Higgsfield MCP", "Slack"]);
    checks.cardSummaries = gmail?.summary === "2 accounts · 1 needs reconnecting" && byName.YouTube?.summary === "1 account · 1 needs reconnecting"
      && byName.Notion?.summary === "1 account · 1 finishing sign-in" && calendar?.summary === "1 account" && higgsfield?.summary === "2 accounts";
    checks.duplicateShowsOnce = JSON.stringify(gmail?.rows.map((entry) => [entry.label, entry.status, entry.times, entry.reconnect])) === JSON.stringify([["sam@example.com", "Expired", 1, true], ["alex@example.com", "Connected", 2, false]]);
    checks.expiredSpareUnderWorkingAccount = calendar?.rows.length === 1 && calendar.rows[0].label === "alex@example.com" && calendar.rows[0].status === "Connected" && calendar.rows[0].times === 2 && !calendar.rows[0].reconnect;
    checks.expiredWithoutAddress = byName.YouTube?.rows[0]?.label.startsWith("Added") === true && byName.YouTube.rows[0].status === "Expired" && byName.YouTube.rows[0].reconnect;
    checks.noAddressStaysApart = higgsfield?.rows.length === 2 && higgsfield.rows.every((entry) => entry.label.startsWith("Added") && /\d:\d\d/.test(entry.label)) && higgsfield.rows[0].label !== higgsfield.rows[1].label;

    // 12. The catalogue: Gmail has one working account (signed in twice) and one expired.
    notes.catalogue = { gmail: await catalogueNote("Popular apps", "Gmail"), calendar: await catalogueNote("Popular apps", "Google Calendar"), notion: await catalogueNote("Popular apps", "Notion") };
    checks.catalogueCountsAccounts = JSON.stringify(notes.catalogue) === JSON.stringify({ gmail: "Connected", calendar: "Connected", notion: "" });
    await shoot("connectors-page.png");

    // 11. Search by app and by address.
    await typeSearch("calendar");
    await until(async () => JSON.stringify((await cards()).map((item) => item.name)) === JSON.stringify(["Google Calendar"]), "the calendar card alone");
    checks.searchByAppShowsWholeCard = (await cards())[0].rows.length === 1 && await has(`[...document.querySelectorAll('[aria-label="Matching apps"] > li')].some((li) => li.innerText.startsWith("Google Calendar"))`);
    await typeSearch("sam@");
    await until(async () => (await cards()).length === 1, "the address search");
    const bySam = await cards();
    notes.searchSam = bySam.map((item) => `${item.name}: ${item.rows.map((entry) => entry.label).join(", ")}`);
    checks.searchByAddress = bySam[0].name === "Gmail" && bySam[0].rows.length === 1 && bySam[0].rows[0].label === "sam@example.com";
    await shoot("connectors-search.png", `section[aria-label="Connected"]`);
    await typeSearch("zzqqxxnothing");
    await until(async () => (await text(`document.querySelector("main")`)).includes("No connected app or account matches"), "the empty search");
    checks.searchSaysNothing = true;
    await typeSearch("");
    await until(() => has(cardsList), "the full page again");

    // 9. Remove extras on Calendar: asks, then removes only the expired spare.
    await clickIn(row("Google Calendar", "alex@example.com"), "Remove extras");
    await until(() => has(dialog), "the remove extras question");
    notes.removeExtrasDialog = (await text(dialog)).replace(/\n+/g, " | ");
    await shoot("remove-extras.png");
    await clickIn(dialog, "Remove extras");
    await until(async () => (await cards()).find((item) => item.name === "Google Calendar")?.rows[0]?.times === 1, "the spare to go");
    const afterExtras = (await cards()).find((item) => item.name === "Google Calendar")!;
    checks.removeExtrasRemovesOnlySpares = JSON.stringify(standIn.deleted) === JSON.stringify(["ca_cal_old"]) && afterExtras.rows[0].status === "Connected" && standIn.connections.some((item) => item.id === "ca_cal_new");

    // 9 and 10. Disconnect alex's Gmail: Keep it keeps both; confirmed, both connections go and Sam stays.
    await clickIn(row("Gmail", "alex@example.com"), "Disconnect");
    await until(() => has(dialog), "the disconnect question");
    notes.disconnectDialog = (await text(dialog)).replace(/\n+/g, " | ");
    await clickIn(dialog, "Keep it");
    await until(async () => !(await has(dialog)), "the dialog to close");
    const kept = standIn.deleted.length === 1;
    await clickIn(row("Gmail", "alex@example.com"), "Disconnect");
    await until(() => has(dialog), "the disconnect question again");
    await clickIn(dialog, "Disconnect");
    await until(async () => (await cards()).find((item) => item.name === "Gmail")?.rows.length === 1, "alex's Gmail to go");
    const afterDisconnect = (await cards()).find((item) => item.name === "Gmail")!;
    notes.deleted = [...standIn.deleted];
    checks.disconnectAsksAndCancelKeeps = kept && /all 2 of its connections/.test(String(notes.disconnectDialog));
    checks.disconnectRemovesEveryConnection = JSON.stringify([...standIn.deleted].sort()) === JSON.stringify(["ca_cal_old", "ca_gmail_alex_1", "ca_gmail_alex_2"])
      && afterDisconnect.rows[0].label === "sam@example.com" && afterDisconnect.summary === "1 account · 1 needs reconnecting";
    await shoot("after-removals.png", `section[aria-label="Connected"]`);

    // 8. Add another account starts at that card's app, and comes back here; Reconnect too.
    const signIn = async (click: string, toolkit: string) => {
      await evaluate(`${click}.click(); true`);
      await until(async () => String(await evaluate(`location.href`).catch(() => "")).startsWith(`${standIn.url}/link?toolkit=${toolkit}`), `the ${toolkit} sign-in`);
      const link = standIn.links.at(-1);
      return link?.toolkit === toolkit && link.callbackUrl === `${BASE}/connectors?connected=${toolkit}`;
    };
    checks.addAnotherStartsFromTheApp = await signIn(`${card("Gmail")}.querySelector(':scope > div button')`, "gmail");
    await send("Page.navigate", { url: `${BASE}/connectors` });
    await until(() => has(cardsList), "the page again", 60);
    checks.reconnectStartsFromTheApp = await signIn(`[...${row("YouTube", (await cards()).find((item) => item.name === "YouTube")!.rows[0].label)}.querySelectorAll("button")].find((b) => b.innerText.trim() === "Reconnect")`, "youtube");
    notes.links = standIn.links;
    notes.unknownCalls = standIn.unknown;
    checks.noUnknownCalls = standIn.unknown.length === 0;
  }

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (server.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill("SIGTERM");
  await sleep(2_000);
  await standIn?.close();
  writeFileSync(join(outDir, "server.log"), log.replaceAll(KEY, "<key>").replaceAll(apiKey, "<composio key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

// Real addresses stay out of the committed result too; the stand-in's are made up.
const redacted = standIn ? notes : JSON.parse(JSON.stringify(notes).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (found) => aliases[found.toLowerCase()] ?? "someone@example.com"));
const result = { ranAt: new Date().toISOString(), checks, notes: redacted, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
