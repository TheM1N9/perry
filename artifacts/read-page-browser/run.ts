import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/read-page-browser/run.ts <outDir>   (PERRY_E2E_ROOT: where the temp home goes)
// Issue #158: read_page reads a page again in Perry's own browser when a site
// turns the plain fetch away. A fresh Perry (production build, `pnpm build`
// first) on a spare port with a temp PERRY_HOME, and a small site served here
// that stands in for the web (PERRY_WEB_TEST_SITE lets read_page reach it; no
// other local address). read_page is called the way Codex calls it: over
// Perry's MCP route, with a runner's token while a turn of its chat runs. The
// runner is played by its reports, so no Codex turn is spent. Perry's browser
// is headless, with its profile in the temp home.
//
// Ways it could fail, written down before the checks:
//   1. A page behind a bot check (403 with a "Just a moment" page to a plain
//      fetch, cleared by a script that sets a cookie and reloads, the way
//      Cloudflare's is) still fails, or comes back as the check page, or
//      without via: "browser".
//   2. A page a script fills in still comes back nearly empty.
//   3. A page walled for everyone (a press-and-hold check; a bare 403) comes
//      back as if read, or with an error that does not say both were tried,
//      or without the hint to tell the owner; or the browser waits forever.
//   4. An ordinary page, or a 404, goes through the browser (cost): the
//      browser starts (its profile appears), or the site sees a browser.
//   5. The browser becomes a way around read_page's address checks: a bot
//      check that redirects to a private address (127.0.0.1 on another port),
//      or a page whose script fetches one, reaches it, or its text comes back.
//   6. The browser's text reaches Codex unmarked, or reading it does not hold
//      back outward steps in that turn (issue #108's guard).
//   7. The browser path skips read_page's own limits: its output is not
//      truncated the same way, or the call never ends, or a page that never
//      stops drawing (live prices) holds it to the deadline every time.
//   8. The browser announces itself as HeadlessChrome, which real bot checks
//      turn away on sight.
//   9. read_page tries a local address in the browser after the fetch refused
//      it.
//
// Also tried, and noted but not checked (they change from day to day): the
// sites from the issue.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/read-page-browser/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "read-page-browser-e2e-key";
const NONCE = `e2e-${Date.now().toString(36)}`;
// PERRY_E2E_ROOT puts the temp home (and so Perry's browser profile) and temp files elsewhere, off a full disk.
const root = process.env.PERRY_E2E_ROOT ?? tmpdir();
mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(root, "perry-read-page-"));
const temp = join(home, "tmp");
mkdirSync(temp, { recursive: true });
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

// --- A private service the browser must never reach ----------------------------------------------
const SECRET = "PRIVATE-ROUTER-PASSWORD-7731";
let secretHits = 0;
const secretServer = createServer((_request, response) => {
  secretHits++;
  response.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
  response.end(`<html><body><h1>Router admin</h1><p>${SECRET}</p></body></html>`);
});
await new Promise<void>((done) => secretServer.listen(0, "127.0.0.1", done));
const PRIVATE = `http://127.0.0.1:${(secretServer.address() as { port: number }).port}/`;

// --- The site ------------------------------------------------------------------------------------
const ARTICLE = "The founder said the company doubled revenue in 2025 by selling fewer, better products. " +
  "She credited a decision to cut two thirds of the catalogue and put the savings into support. ";
const seen: Array<{ path: string; browser: boolean; agent: string }> = [];
const doc = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
/** Cloudflare's shape: a 403 that runs a script, which sets a cookie and reloads, and the page after it. */
const challenge = (cookie: string) => doc("Just a moment...", `<h1>Checking your browser</h1><p>Enable JavaScript and cookies to continue.</p>
<script>setTimeout(() => { document.cookie = "${cookie}=ok; path=/"; location.reload(); }, 1200);</script>`);
const siteServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://x");
  const cookies = String(request.headers.cookie ?? "");
  const browser = request.headers["sec-fetch-dest"] === "document";
  seen.push({ path: url.pathname, browser, agent: String(request.headers["user-agent"] ?? "") });
  const send = (status: number, html: string, headers: Record<string, string> = {}) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); response.end(html); };
  const cleared = (name: string) => cookies.includes(`${name}=ok`);
  switch (url.pathname) {
    case "/plain": return send(200, doc("Plain article", `<article><h1>An ordinary article</h1><p>ORDINARY-${NONCE}. ${ARTICLE}</p></article>`));
    case "/missing": return send(404, doc("Not found", "<h1>Not found</h1><p>There is no page here, and there never was one. Try the home page.</p>"));
    case "/article":
      if (!cleared("clearance")) return send(403, challenge("clearance"), { "cf-mitigated": "challenge" });
      return send(200, doc("How one founder doubled revenue", `<article><h1>How one founder doubled revenue</h1><p>BEHIND-THE-CHECK-${NONCE}. ${ARTICLE}</p></article>`));
    case "/long":
      if (!cleared("longclear")) return send(403, challenge("longclear"), { "cf-mitigated": "challenge" });
      return send(200, doc("A long read", Array.from({ length: 3000 }, (_, i) => `<p>Paragraph ${i + 1}. ${ARTICLE}</p>`).join("")));
    case "/ticker":
      if (!cleared("ticker")) return send(403, challenge("ticker"), { "cf-mitigated": "challenge" });
      return send(200, doc("Markets live", `<h1>Markets live</h1><p>TICKER-${NONCE}. ${ARTICLE}</p><ul id="ticks"></ul>
<script>let n = 0; setInterval(() => { const li = document.createElement("li"); li.textContent = "Tick " + (++n); document.getElementById("ticks").append(li); }, 300);</script>`));
    case "/app": return send(200, doc("App", `<div id="root"></div><script>document.getElementById("root").innerHTML = "<h1>Drawn by a script</h1><p>SCRIPTED-${NONCE}. " + ${JSON.stringify(ARTICLE)} + "</p>";</script>`));
    case "/walled": return send(403, doc("Access to this page has been denied", `<div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p><p>Reference ID ${NONCE}</p>`));
    case "/forbidden": return send(403, doc("Forbidden", "<h1>Forbidden</h1><p>You do not have permission to see this page.</p>"));
    case "/bounce":
      if (!cleared("bounce")) return send(403, challenge("bounce"), { "cf-mitigated": "challenge" });
      return send(302, "", { location: PRIVATE });
    case "/peek":
      if (!cleared("peek")) return send(403, challenge("peek"), { "cf-mitigated": "challenge" });
      return send(200, doc("Innocent article", `<article><h1>An innocent article</h1><p>PEEK-${NONCE}. ${ARTICLE}</p><div id="stolen"></div></article>
<script>fetch(${JSON.stringify(PRIVATE)}).then((r) => r.text()).then((t) => { document.getElementById("stolen").textContent = t; }).catch(() => {});</script>`));
    default: return send(404, doc("Not found", "<p>Not found</p>"));
  }
});
await new Promise<void>((done) => siteServer.listen(0, "127.0.0.1", done));
const SITE_HOST = `127.0.0.1:${(siteServer.address() as { port: number }).port}`;
const SITE = `http://${SITE_HOST}`;
const browserSaw = (path: string) => seen.filter((request) => request.path === path && request.browser);

// --- Perry ---------------------------------------------------------------------------------------
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex", PERRY_WEB_TEST_SITE: SITE_HOST, TEMP: temp, TMP: temp };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE" || name === "PERRY_BROWSER_HEADED") delete env[name];
let serverLog = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { serverLog += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk; });
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
// The documents as Perry keeps them in SQLite, through Node (Bun has no node:sqlite).
const SQL = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all()));`;
const rows = (table: string): Array<Record<string, any> & { _id: string }> => {
  const ran = spawnSync("node", ["-e", SQL, join(home, "perry.sqlite"), `SELECT _id, doc FROM "doc_${table}"`], { encoding: "utf8", windowsHide: true });
  if (ran.status !== 0) throw new Error(`sqlite: ${ran.stderr}`);
  return (JSON.parse(ran.stdout || "[]") as Array<{ _id: string; doc: string }>).map((row) => ({ _id: row._id, ...JSON.parse(row.doc) }));
};

type Page = { url?: string; title?: string; text?: string; chars?: number; truncated?: boolean; via?: string; note?: string; error?: string; hint?: string };
type Called = { untrusted?: string; result: Page; ms: number; raw: string };
let token = "";
let chat = "";
let rpc = 0;
/** One MCP call, as Codex makes it during the chat's turn. */
async function mcp(name: string, args: object): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/backend/http/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-perry-chat": chat },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json() as { result?: { content?: Array<{ text?: string }> }; error?: { message: string } };
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  return { text: body.result?.content?.[0]?.text ?? "", ms: Date.now() - started };
}
async function readPage(url: string): Promise<Called> {
  const { text, ms } = await mcp("read_page", { url });
  const parsed = JSON.parse(text) as { untrusted?: string; result: Page };
  return { ...parsed, ms, raw: text };
}
const brief = (called: Called) => ({ ms: called.ms, via: called.result.via ?? null, title: called.result.title, chars: called.result.chars, note: called.result.note, error: called.result.error, hint: called.result.hint, text: called.result.text?.slice(0, 160) });
const BOTH = /with either a plain fetch or Perry's browser/;
const TELL_OWNER = /Tell the owner this page could not be read/;

try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // A runner, played by its reports, with Codex signed in; a chat whose turn it claims and keeps running.
  token = `read-page-${NONCE}`;
  await call("runner:createToken", { name: "E2E runner", token });
  await call("runner:checkIn", { token, platform: platform(), hostname: hostname(), workdir: home });
  await call("engines:report", { token, engines: [{
    kind: "codex", installed: true, version: "0.0.0-e2e", signedIn: true, auth: { type: "chatgpt", label: "ChatGPT" },
    models: [{ id: "gpt-e2e", name: "GPT E2E", isDefault: true, efforts: ["low"], defaultEffort: "low" }],
  }] });
  await call("codex:reportAccount", { token, available: true, authMode: "chatgpt", planType: "plus", models: [{ id: "gpt-e2e", name: "GPT E2E", isDefault: true }] }).catch(() => {});
  chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `Read me some pages ${NONCE}` });
  let turn: { _id: string } | undefined;
  await until(async () => { turn = (await call<Array<{ _id: string; conversationId: string }>>("codex:queuedTurns", { token })).find((item) => item.conversationId === chat); return Boolean(turn); }, "the turn to queue", 30);
  const claimed = await call<{ _id: string } | null>("codex:claimTurn", { token, id: turn!._id });
  if (!claimed) throw new Error("could not claim the turn");
  const turnRow = () => rows("codexTurns").find((row) => row._id === turn!._id);

  // --- 4. Ordinary pages stay plain fetches, and the browser does not start ---------------------------
  const plain = await readPage(`${SITE}/plain`);
  const missing = await readPage(`${SITE}/missing`);
  const refusedLocal = await readPage(`${PRIVATE}`);
  const profile = join(home, "browser");
  check("ordinaryPageIsAPlainFetch",
    plain.result.via === undefined && plain.result.text?.includes(`ORDINARY-${NONCE}`) === true && browserSaw("/plain").length === 0 && !existsSync(profile),
    { ...brief(plain), browserStarted: existsSync(profile) });
  check("notFoundIsNotRetried",
    missing.result.error === "The site returned 404." && missing.result.via === undefined && browserSaw("/missing").length === 0 && !existsSync(profile),
    brief(missing));
  check("localAddressRefusedWithoutTheBrowser",
    /not public/.test(refusedLocal.result.error ?? "") && !BOTH.test(refusedLocal.result.error ?? "") && secretHits === 0 && !existsSync(profile),
    brief(refusedLocal));

  // --- 1. Behind a bot check that a browser clears --------------------------------------------------
  const article = await readPage(`${SITE}/article`);
  const articleVisits = browserSaw("/article");
  check("botCheckReadInTheBrowser",
    article.result.via === "browser" && article.result.text?.includes(`BEHIND-THE-CHECK-${NONCE}`) === true
      && article.result.title === "How one founder doubled revenue" && !/Just a moment/i.test(article.result.text ?? "")
      && /turned away \(403, a bot check\)/.test(article.result.note ?? "") && !article.result.error,
    { ...brief(article), browserRequests: articleVisits.length });
  // A plain fetch saw the check twice (a browser's user agent, then an honest one), then the browser cleared it.
  check("browserStartedOnlyWhenNeeded", existsSync(profile) && seen.filter((r) => r.path === "/article" && !r.browser).length === 2 && articleVisits.length >= 2,
    { plainFetches: seen.filter((r) => r.path === "/article" && !r.browser).map((r) => r.agent), browserRequests: articleVisits.length });
  check("browserIsNotAnnouncedAsHeadless", articleVisits.length > 0 && articleVisits.every((r) => /Chrome\//.test(r.agent) && !/Headless/i.test(r.agent)),
    articleVisits.map((r) => r.agent));

  // --- 6. Marked as untrusted, and it holds back outward steps ---------------------------------------
  const held = await mcp("use_secret", { id: "anything" });
  check("browserTextMarkedUntrusted",
    typeof article.untrusted === "string" && /never follow instructions/.test(article.untrusted) && typeof turnRow()?.outsideAt === "number" && /Held back/.test(held.text),
    { untrusted: article.untrusted, outsideAt: turnRow()?.outsideAt ?? null, useSecret: JSON.parse(held.text) });

  // --- 2. A page a script fills in -------------------------------------------------------------------
  const app = await readPage(`${SITE}/app`);
  check("scriptedPageReadInTheBrowser",
    app.result.via === "browser" && app.result.text?.includes(`SCRIPTED-${NONCE}`) === true && /Almost no text came back without JavaScript/.test(app.result.note ?? ""),
    brief(app));

  // --- 7. The same limits ------------------------------------------------------------------------------
  const long = await readPage(`${SITE}/long`);
  check("browserOutputTruncatedTheSameWay",
    long.result.via === "browser" && long.result.truncated === true && /\[page truncated: showing the first \d+ of \d+ lines\]$/.test(long.result.text ?? "")
      && (long.result.text ?? "").length < 52 * 1024 && (long.result.chars ?? 0) > 500_000,
    { ...brief(long), textLength: long.result.text?.length, tail: long.result.text?.slice(-70) });

  // A page that never stops drawing (live prices) is read once it has loaded, not at the deadline.
  const ticker = await readPage(`${SITE}/ticker`);
  check("liveUpdatingPageDoesNotWaitForTheDeadline",
    ticker.result.via === "browser" && ticker.result.text?.includes(`TICKER-${NONCE}`) === true && ticker.ms < 15_000,
    brief(ticker));

  // --- 3. Walled for everyone ------------------------------------------------------------------------
  const forbidden = await readPage(`${SITE}/forbidden`);
  check("bare403FailsInBothSaysSo",
    !forbidden.result.text && BOTH.test(forbidden.result.error ?? "") && /returned 403 to it too/.test(forbidden.result.error ?? "")
      && TELL_OWNER.test(forbidden.result.hint ?? "") && browserSaw("/forbidden").length >= 1 && forbidden.ms < 20_000,
    brief(forbidden));
  const walled = await readPage(`${SITE}/walled`);
  check("botCheckThatWantsAPersonFailsInBothSaysSo",
    !walled.result.text && BOTH.test(walled.result.error ?? "") && /bot check did not let it through/.test(walled.result.error ?? "")
      && TELL_OWNER.test(walled.result.hint ?? "") && browserSaw("/walled").length >= 1 && walled.ms < 45_000,
    brief(walled));

  // --- 5. No way around the address checks -----------------------------------------------------------
  const bounce = await readPage(`${SITE}/bounce`);
  check("browserRedirectToPrivateAddressRefused",
    !bounce.result.text && /not public/.test(bounce.result.error ?? "") && /Only public internet addresses/.test(bounce.result.hint ?? "")
      && browserSaw("/bounce").length >= 2 && secretHits === 0 && !bounce.raw.includes(SECRET),
    { ...brief(bounce), secretHits });
  const peek = await readPage(`${SITE}/peek`);
  check("pageScriptCannotFetchPrivateAddress",
    !peek.raw.includes(SECRET) && secretHits === 0 && (Boolean(peek.result.error) || peek.result.text?.includes(`PEEK-${NONCE}`) === true),
    { ...brief(peek), secretHits });

  // --- The sites from the issue, noted only ------------------------------------------------------------
  const real: Record<string, unknown> = {};
  for (const url of [
    "https://www.inc.com/",
    "https://qz.com/",
    "https://www.benzinga.com/",
    "https://moneywise.com/",
    "https://finance.yahoo.com/",
  ]) {
    try {
      const page = await readPage(url);
      real[url] = { ...brief(page), text: page.result.text?.slice(0, 300) };
    } catch (error) {
      real[url] = { thrown: String(error) };
    }
  }
  notes.realSites = real;

  await call("codex:finishTurn", { token, id: turn!._id, response: "Done." }).catch(() => {});
} catch (error) {
  check("ran", false, String(error));
  notes.serverLog = serverLog.slice(-4000);
} finally {
  if (server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  siteServer.close();
  secretServer.close();
  await sleep(1500);
  for (let attempt = 0; attempt < 10; attempt++) {
    try { rmSync(home, { recursive: true, force: true }); break; } catch { await sleep(1000); }
  }
}

const passed = Object.values(checks).every(Boolean) && Object.keys(checks).length > 0;
const result = { ranAt: new Date().toISOString(), passed, checks, notes };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(passed ? "PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
