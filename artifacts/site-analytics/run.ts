import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "../browser";
import { FILM_CDN } from "../../site/lib/film";

// bun artifacts/site-analytics/run.ts [outDir]
// Builds site/ for production, serves it with `next start`, and drives headless
// Chrome over it: are Vercel Web Analytics and Speed Insights on the page, and
// does each of the landing page's key actions send its custom event? Then runs
// `next dev` and checks that development loads only the debug scripts, which
// print events to the console and send nothing.
//
// Ways it could fail, and what this checks for each:
// - The scripts never reach the page (the components aren't rendered, or the
//   layout lost them): after hydration, the production page must hold exactly
//   one /_vercel/insights/script.js and one /_vercel/speed-insights/script.js,
//   marked as the Next.js integrations.
// - Analytics goes to the wrong region/project, doubles pageviews, loses conversions,
//   or includes copied commands: capture the real SDK's outgoing payloads in Chrome,
//   acknowledge them locally, and assert the US key, event properties and content limits.
// - PostHog runs in development: no PostHog network request or event is allowed there.
// - Unexpected third-party traffic: only PostHog US hosts and the existing film CDN may leave the origin.
// - Production loads the debug scripts, or development the real ones, so dev
//   visits would count as traffic: production must not reference
//   va.vercel-scripts.com, and development must load only the debug scripts
//   and make no request to /_vercel/*.
// - A visit is counted twice, or not at all: loading the production page must
//   queue exactly one page view, for /.
// - The scripts are server-rendered into the HTML, so the static page changes
//   per visitor or per build: the served HTML must hold neither script.
// - A key action sends no event, or the wrong one: clicking each Get Perry
//   (nav, hero, close), See a day, the footer's GitHub and Install guide links,
//   and each Copy (installer on each system, run commands) must queue exactly
//   that event with exactly those properties.
// - A failed copy is reported as a copy: with the clipboard refusing, Copy
//   must send copied: false.
// - Tracking breaks the action it tracks: the copy must still hand over the
//   command, and the external links must still open in a new tab.
// - Outside Vercel the missing /_vercel scripts break the page: no page errors
//   or console errors in production (a 404 for the script is expected locally).
// - The site's server prints noise or errors that would clutter Vercel's Logs:
//   `next start` must print nothing after its startup banner while the page is
//   used, and `next build` must not print errors or warnings.
// - Development is broken by the scripts, or quietly sends data: `next dev`
//   must serve the page, both debug scripts must say they send nothing, and an
//   action's event must show up in the debug script's console output.
const outDir = resolve(process.argv[2] ?? "artifacts/site-analytics");
const siteDir = resolve("site");
const work = process.env.SITE_ANALYTICS_WORK ?? join(tmpdir(), "site-analytics");
mkdirSync(outDir, { recursive: true });
mkdirSync(work, { recursive: true });

const children: ChildProcess[] = [];
const kill = (child: ChildProcess) => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
};
process.once("exit", () => children.forEach(kill));

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => done(port));
  });
});

const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(detail)}`}`);
};

// ---------- Build ----------
const build = spawnSync("pnpm", ["build"], { cwd: siteDir, shell: true, encoding: "utf8", windowsHide: true });
const buildLog = `${build.stdout}${build.stderr}`;
writeFileSync(join(work, "build.log"), buildLog);
check("next build succeeds", build.status === 0, buildLog.slice(-2000));
const buildNoise = buildLog.split("\n").filter((line) => /error|warn|⚠|⨯/i.test(line));
check("next build prints no errors or warnings", buildNoise.length === 0, buildNoise);

/** Start a Next server and collect everything it prints. */
async function serve(args: string[], cwd = siteDir, env: NodeJS.ProcessEnv = process.env) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("pnpm", ["exec", "next", ...args, "-p", String(port), "-H", "127.0.0.1"], { cwd, env, shell: true, windowsHide: true });
  children.push(server);
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await sleep(200);
  }
  await sleep(500);
  const banner = output.length;
  return { base, server, banner: () => output.slice(0, banner), sinceReady: () => output.slice(banner) };
}

/** A headless Chrome of its own, with a DevTools session on one page. */
async function chrome() {
  const port = await freePort();
  const profile = mkdtempSync(join(work, "chrome-"));
  const browser = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });
  children.push(browser);
  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
  for (let i = 0; i < 50 && !targets.some((target) => target.type === "page"); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as typeof targets; } catch {}
    await sleep(200);
  }
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("Chrome did not open a page.");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ready) => ws.addEventListener("open", ready, { once: true }));
  let nextId = 0;
  const waiting = new Map<number, (message: any) => void>();
  const errors: string[] = [];
  const logs: string[] = [];
  const requests: string[] = [];
  const newTabs: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled") {
      // Vercel's debug lines style their prefix with %c; keep the words, drop the styles.
      const text = message.params.args
        .filter((a: any) => !(typeof a.value === "string" && /^color:/.test(a.value)))
        .map((a: any) => typeof a.value === "string" ? a.value.replaceAll("%c", "") : a.value !== undefined ? JSON.stringify(a.value) : a.preview ? JSON.stringify(Object.fromEntries(a.preview.properties.map((p: any) => [p.name, p.value]))) : a.description)
        .join(" ");
      (message.params.type === "error" ? errors : logs).push(text);
    }
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && message.params.targetInfo.openerId) newTabs.push(message.params.targetInfo.url);
  });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((done, fail) => {
    const id = ++nextId;
    waiting.set(id, (message) => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string): Promise<any> => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  // PostHog correctly filters HeadlessChrome as a bot; exercise normal visitor behavior.
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Target.setDiscoverTargets", { discover: true });
  // Install before SDK evaluation. Intercept analytics only; application requests remain real.
  // This keeps synthetic test traffic out of the user's new PostHog project.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.phEvents = []; window.phDecodeErrors = []; window.phCalls = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://us.i.posthog.com/')) return originalFetch(input, init);
      window.phCalls.push({ url: url.split('?')[0], body: !!init?.body });
      if (init?.body) {
        try {
          let text;
          const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
          if (bytes[0] === 31 && bytes[1] === 139) {
            text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
          } else {
            text = new TextDecoder().decode(bytes);
            if (text.startsWith('data=')) text = atob(new URLSearchParams(text).get('data'));
          }
          const data = JSON.parse(text);
          window.phCalls[window.phCalls.length-1].keys = Object.keys(data);
          for (const item of Array.isArray(data) ? data : data.batch ?? [data]) {
            if (item.event) window.phEvents.push(item);
          }
        } catch (e) { window.phDecodeErrors.push(String(e)); }
      }
      return new Response(JSON.stringify({ status: 1, featureFlags: {}, featureFlagPayloads: {}, flags: {}, sessionRecording: false }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    };
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, body) => {
      if (!String(url).startsWith('https://us.i.posthog.com/')) return originalBeacon(url, body);
      window.fetch(url, { method: 'POST', body }); return true;
    };
  ` });
  const close = () => {
    ws.close();
    kill(browser);
    for (let i = 0; i < 20; i++) {
      try { rmSync(profile, { recursive: true, force: true }); return; } catch { spawnSync(process.execPath, ["-e", "setTimeout(()=>{},250)"]); }
    }
  };
  return { send, evaluate, errors, logs, requests, newTabs, close };
}

const until = async (evaluate: (e: string) => Promise<any>, expression: string, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
};
const load = async (page: Awaited<ReturnType<typeof chrome>>, url: string) => {
  await page.send("Page.navigate", { url });
  await until(page.evaluate, `document.readyState === "complete"`, 60000);
  await sleep(1200);
};
const click = (page: Awaited<ReturnType<typeof chrome>>, selector: string) =>
  page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center", behavior: "instant" }); el.click(); return true; })()`);
/** The custom events queued for Vercel Web Analytics, as [name, data]. */
const EVENTS = `(window.vaq ?? []).filter(([kind]) => kind === "event").map(([, e]) => [e.name, e.data ?? null])`;

// ---------- Production: next start ----------
const prod = await serve(["start"]);
const page = await chrome();
await page.send("Browser.grantPermissions", { origin: prod.base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });

const html = await (await fetch(prod.base)).text();
check("the served HTML holds neither script (they're added on the client)", !html.includes("/_vercel/") && !html.includes("va.vercel-scripts.com"));

await load(page, prod.base);
const scripts = await page.evaluate(`[...document.scripts].filter((s) => /_vercel|vercel-scripts/.test(s.src)).map((s) => ({ src: new URL(s.src).pathname, host: new URL(s.src).host, sdkn: s.dataset.sdkn ?? null, defer: s.defer }))`);
const at = (path: string) => scripts.filter((s: any) => s.src === path && s.host === new URL(prod.base).host);
check("production: one Web Analytics script, from the site's own /_vercel/insights", at("/_vercel/insights/script.js").length === 1 && at("/_vercel/insights/script.js")[0].sdkn === "@vercel/analytics/next", scripts);
check("production: one Speed Insights script, from the site's own /_vercel/speed-insights", at("/_vercel/speed-insights/script.js").length === 1 && at("/_vercel/speed-insights/script.js")[0].sdkn === "@vercel/speed-insights/next", scripts);
check("production: no debug script and nothing else from Vercel", scripts.length === 2, scripts);
const pageviews = await page.evaluate(`(window.vaq ?? []).filter(([kind]) => kind === "pageview").map(([, view]) => view)`);
check("production: the visit queues exactly one page view, for /", pageviews.length === 1 && pageviews[0].path === "/", pageviews);

// Keep external links from leaving: the click still runs React's handler, only the navigation is stopped.
await page.evaluate(`addEventListener("click", (e) => { const a = e.target.closest('a[target="_blank"]'); if (a) { window.opened = { href: a.href, rel: a.rel }; e.preventDefault(); } }, true); true`);
await page.evaluate(`const write = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.copied = t; return write(t); }; true`);

const expectEvent = async (name: string, action: () => Promise<unknown>, expected: [string, Record<string, unknown>]) => {
  const before = (await page.evaluate(EVENTS)).length;
  await action();
  await sleep(250);
  const after = (await page.evaluate(EVENTS)).slice(before);
  check(name, after.length === 1 && JSON.stringify(after[0]) === JSON.stringify(expected), after);
  await page.evaluate(`window.lastCopyLabel = document.querySelector('[data-copy="install"]')?.textContent; true`);
  await until(page.evaluate, `window.phEvents.some((e) => e.event === ${JSON.stringify(expected[0])} && Object.entries(${JSON.stringify(expected[1])}).every(([k,v]) => e.properties[k] === v))`, 6000);
  check(`${name}: also reaches PostHog`, await page.evaluate(`window.phEvents.some((e) => e.event === ${JSON.stringify(expected[0])} && e.properties.app === 'website' && Object.entries(${JSON.stringify(expected[1])}).every(([k,v]) => e.properties[k] === v))`));
  return after;
};

await expectEvent("nav Get Perry sends CTA click {cta: get_perry, from: nav}", () => click(page, "header a[href='#setup']"), ["CTA click", { cta: "get_perry", from: "nav" }]);
await expectEvent("hero Get Perry sends CTA click {cta: get_perry, from: hero}", () => click(page, "#top a[href='#setup']"), ["CTA click", { cta: "get_perry", from: "hero" }]);
await expectEvent("hero See a day sends CTA click {cta: see_day, from: hero}", () => click(page, "#top a[href='#day']"), ["CTA click", { cta: "see_day", from: "hero" }]);
await expectEvent("closing Get Perry sends CTA click {cta: get_perry, from: close}", () => click(page, "section[aria-labelledby='close-title'] a[href='#setup']"), ["CTA click", { cta: "get_perry", from: "close" }]);

await expectEvent("footer GitHub sends GitHub click {link: repo}", () => click(page, "footer a[href='https://github.com/TheM1N9/perry']"), ["GitHub click", { link: "repo" }]);
const repoOpened = await page.evaluate(`window.opened`);
check("the GitHub link still opens the repo in a new tab", repoOpened?.href === "https://github.com/TheM1N9/perry" && repoOpened.rel.includes("noopener"), repoOpened);
await expectEvent("footer Install guide sends GitHub click {link: install_guide}", () => click(page, "footer a[href$='INSTALL.md']"), ["GitHub click", { link: "install_guide" }]);

const installers = {
  unix: "curl -fsSL https://raw.githubusercontent.com/TheM1N9/perry/main/install.sh | sh",
  windows: 'powershell -c "irm https://raw.githubusercontent.com/TheM1N9/perry/main/install.ps1 | iex"',
} as const;
for (const os of ["unix", "windows"] as const) {
  await click(page, `[data-os="${os}"]`);
  await sleep(150);
  await expectEvent(`Copy on the ${os} installer sends Copy command {command: install, os: ${os}, copied: true}`, () => click(page, `[data-copy="install"]`), ["Copy command", { command: "install", os, copied: true }]);
  check(`the ${os} installer is still what's copied`, (await page.evaluate(`window.copied`)) === installers[os], await page.evaluate(`window.copied`));
}
await expectEvent("Copy on the run commands sends Copy command {command: run, os: windows, copied: true}", () => click(page, `[data-copy="run"]`), ["Copy command", { command: "run", os: "windows", copied: true }]);

// The clipboard refuses: the event says so, and the button tells the reader to select instead.
await page.evaluate(`navigator.clipboard.writeText = () => Promise.reject(new DOMException("denied", "NotAllowedError")); true`);
await expectEvent("a refused copy sends Copy command {copied: false}", () => click(page, `[data-copy="install"]`), ["Copy command", { command: "install", os: "windows", copied: false }]);
check("a refused copy still shows Select to copy", await page.evaluate(`window.lastCopyLabel === "Select to copy"`));

const allEvents = await page.evaluate(EVENTS);
const foreign = [...new Set(page.requests)].filter((url) => !url.startsWith(prod.base) && !url.startsWith("data:"));
check("production: external requests use only PostHog US hosts and the existing film CDN", foreign.every((url) => url === FILM_CDN || /^https:\/\/us(-assets)?\.i\.posthog\.com\//.test(url)), foreign);
await sleep(3500);
const posthogEvents = await page.evaluate(`window.phEvents`);
check("production: PostHog sends one page view with the configured project key", posthogEvents.filter((e: any) => e.event === "$pageview").length === 1 && posthogEvents.every((e: any) => e.properties.token === "phc_qeCkb5s5b6x4T5adoyZWdCKsmwK27dKq3RginMwWAwqn"), posthogEvents.map((e: any) => e.event));
if (!posthogEvents.length) console.log("PostHog diagnostics", await page.evaluate(`({calls: window.phCalls, dnt:navigator.doNotTrack, ua:navigator.userAgent})`));
check("production: analytics payloads decode without errors", (await page.evaluate(`window.phDecodeErrors`)).length === 0, await page.evaluate(`window.phDecodeErrors`));
check("production: custom conversion events exclude clipboard contents", posthogEvents.filter((e: any) => ["CTA click", "GitHub click", "Copy command"].includes(e.event)).every((e: any) => Object.values(installers).every((command) => !JSON.stringify(e).includes(command))));
check("production: no page errors or console errors", page.errors.length === 0, page.errors);
check("production: no new tab was opened (links were held for the check)", page.newTabs.length === 0, page.newTabs);
const vercelLogs = page.logs.filter((line) => line.includes("[Vercel"));
await sleep(500);
const serverAfterBanner = prod.sinceReady().split("\n").map((line) => line.trim()).filter(Boolean);
check("next start prints nothing after its startup banner", serverAfterBanner.length === 0, { banner: prod.banner(), after: serverAfterBanner });
page.close();
kill(prod.server);

// ---------- Development: next dev ----------
const dev = await serve(["dev"]);
const devPage = await chrome();
await load(devPage, dev.base);
check("development: the page is served", await until(devPage.evaluate, `!!document.querySelector("#setup")`, 60000));
await until(devPage.evaluate, `[...document.scripts].some((s) => s.src.includes("speed-insights/script.debug.js"))`, 10000);
const devScripts = await devPage.evaluate(`[...document.scripts].filter((s) => /_vercel|vercel-scripts/.test(s.src)).map((s) => s.src)`);
check("development: only the debug scripts load", devScripts.length === 2 && devScripts.includes("https://va.vercel-scripts.com/v1/script.debug.js") && devScripts.includes("https://va.vercel-scripts.com/v1/speed-insights/script.debug.js"), devScripts);
// Wait for the debug script to take over the queue, then send one event through it.
await until(devPage.evaluate, `performance.getEntriesByName("https://va.vercel-scripts.com/v1/script.debug.js").length > 0`, 10000);
await sleep(1000);
await click(devPage, "#top a[href='#day']");
for (let i = 0; i < 50 && !devPage.logs.some((line) => line.includes("[event] CTA click")); i++) await sleep(100);
check("development: the debug script prints the event to the console", devPage.logs.some((line) => line.includes("[Vercel Web Analytics] [event] CTA click")), devPage.logs.filter((line) => line.includes("[Vercel")));
check("development: both debug scripts say no requests will be sent", ["Web Analytics", "Speed Insights"].every((tool) =>
  devPage.logs.some((line) => line.includes(`[Vercel ${tool}] Debug mode is enabled by default in development. No requests will be sent to the server.`))), devPage.logs.filter((line) => line.includes("[Vercel")));
const sent = devPage.requests.filter((url) => url.includes("/_vercel/") || /vercel-scripts\.com\/(?!v1\/(speed-insights\/)?script\.debug\.js)/.test(url));
check("development: nothing is sent to Vercel (only the two debug scripts are fetched)", sent.length === 0, sent);
check("development: PostHog sends nothing", devPage.requests.every((url) => !url.includes("posthog.com")) && (await devPage.evaluate(`window.phEvents`)).length === 0);
check("development: no page errors", devPage.errors.filter((e) => !/Download the React DevTools/.test(e)).length === 0, devPage.errors);
const devLogs = devPage.logs.filter((line) => line.includes("[Vercel"));
devPage.close();
kill(dev.server);

// Dashboard E2E failure modes: instrumentation may not run; URL/fragment credentials,
// nested person/entry metadata, route IDs, DOM text or mutation arguments may escape;
// operations may lose results or fail to track, and a disabled replay may still emit snapshots.
// Use a fresh real backend, unlock via the normal link, then create a page through the UI.
const dashboardHome = mkdtempSync(join(work, "dashboard-"));
const dashboard = await serve(["dev"], resolve("."), {
  ...process.env,
  PERRY_HOME: dashboardHome,
  DASHBOARD_KEY: "e2e-private-dashboard-key",
  TELEGRAM_BOT_TOKEN: "",
  COMPOSIO_API_KEY: "",
  NEXT_PUBLIC_POSTHOG_ENABLED: "true",
  PERRY_TELEMETRY_DISABLED: "1",
});
const dashboardPage = await chrome();
await load(dashboardPage, `${dashboard.base}/brain?analytics_secret=e2e-private-query#key=e2e-private-dashboard-key`);
check("dashboard: the real backend unlocks and renders Brain", await until(dashboardPage.evaluate, `!![...document.querySelectorAll('button')].find((b) => b.textContent.includes('New page'))`, 60000));
await dashboardPage.evaluate(`document.title = 'e2e-private-title'; const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('New page')); button.click(); true`);
check("dashboard: creating a page still navigates to it", await until(dashboardPage.evaluate, `location.pathname.startsWith('/brain/')`, 30000));
await until(dashboardPage.evaluate, `window.phEvents.some((e) => e.event === 'Feature used' && e.properties.operation === 'notes:create')`, 15000);
await until(dashboardPage.evaluate, `window.phEvents.some((e) => e.event === '$pageview' && e.properties.$pathname === '/brain/:id')`, 15000);
const dashboardEvents = await dashboardPage.evaluate(`window.phEvents`);
check("dashboard: feature outcome and timing reach PostHog", dashboardEvents.some((e: any) => e.event === "Feature used" && e.properties.operation === "notes:create" && e.properties.success === true && typeof e.properties.duration_ms === "number"));
check("dashboard: client navigation produces normalized pageviews", dashboardEvents.some((e: any) => e.event === "$pageview" && e.properties.$pathname === "/brain/:id"));
const privateId = await dashboardPage.evaluate(`location.pathname.split('/').pop()`);
const privacyFailures: string[] = [];
const findPrivateFields = (value: any, path: string) => {
  if (typeof value === "string" && ["e2e-private-dashboard-key", "e2e-private-query", "e2e-private-title", dashboard.base, privateId].some((secret) => value.includes(secret))) privacyFailures.push(path);
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) findPrivateFields(child, `${path}.${key}`);
};
findPrivateFields(dashboardEvents, "events");
check("dashboard: credentials, queries, title, route IDs and host stay local", dashboardEvents.length > 0 && privacyFailures.length === 0, privacyFailures);
check("dashboard: session replay sends no snapshots", dashboardEvents.every((e: any) => e.event !== "$snapshot"));
check("dashboard: event payloads decode without errors", (await dashboardPage.evaluate(`window.phDecodeErrors`)).length === 0);
dashboardPage.close();
kill(dashboard.server);

const pass = checks.every((c) => c.pass);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({
  pass,
  at: new Date().toISOString(),
  production: { scripts, events: allEvents, posthogEvents: posthogEvents.map((e: any) => ({ event: e.event, app: e.properties.app })), browserLogsFromVercel: vercelLogs },
  development: { scripts: devScripts, browserLogsFromVercel: devLogs },
  dashboard: { events: dashboardEvents.map((e: any) => ({ event: e.event, operation: e.properties.operation, pathname: e.properties.$pathname })) },
  checks,
}, null, 2)}\n`);
console.log(pass ? "\nAll checks passed." : "\nSome checks failed.");
await sleep(300);
process.exit(pass ? 0 : 1);
