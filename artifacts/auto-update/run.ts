import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/auto-update/run.ts [outDir]
// Perry keeps himself up to date: the check, the one-click update, the night's
// update when idle, and what happens when an update's build fails.
//
// Nothing here touches the real Perry, its checkout or the network: this
// worktree's files are committed into a temp git repo, pushed to a temp bare
// repo that stands in for GitHub, and cloned into a temp checkout, which gets
// its own packages, build, PERRY_HOME, CODEX_HOME and a spare port. New
// "upstream" commits are pushed to the bare repo. The supervisor is the real
// one, `bun scripts/perry.ts run` in the temp checkout, with its runner and
// dashboard, and the update it does is real: git, pnpm install, next build.
//
// Ways it could fail, written down before the checks:
//   1. Up to date, an update is still offered; behind, none is shown, or not
//      how many changes or the newest one's title.
//   2. The checkout has changes of the owner's, and an update is offered
//      anyway, or they are lost; untracked files (.env.local, notes) are lost
//      by an update or by going back after a failed one.
//   3. No upstream, or the remote unreachable, and the check throws, hangs,
//      or offers an update.
//   4. Perry not under `perry run` (a server started by hand), and a click
//      writes a request nobody will pick up, or the page spins forever
//      instead of saying to use perry start.
//   5. The first check waits a day instead of coming soon after start.
//   6. The night's update runs with the setting off; or while an approval
//      waits or a reply is queued; or not at all when idle at night.
//   7. A click while Perry is busy updates at once, cutting the work off,
//      or is forgotten instead of done once he is free.
//   8. The update kills the supervisor (it runs in the process tree the
//      dashboard is in), or leaves the runner or dashboard stopped.
//   9. The update does not move the checkout to the new commit, or does not
//      rebuild, so the old code keeps running.
//  10. A failed build leaves Perry down (no build to start, or no disk to
//      build the old one again), or on a half-updated checkout; or the
//      failure is not recorded.
//  11. The result is never shown: the dashboard does not read it back after
//      restarting, or shows the wrong from/to.
//  12. A request that nothing picks up spins forever instead of being
//      reported.
//  13. Settings, the sidebar or the pet page do not show the update, or
//      throw.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
mkdirSync(outDir, { recursive: true });

const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "auto-update-e2e-key";
const work = mkdtempSync(join(tmpdir(), "perry-auto-update-"));
const upstream = join(work, "upstream.git");
const seed = join(work, "seed");
const checkout = join(work, "perry");
const homeA = join(work, "home-a");
const homeB = join(work, "home-b");
const codexHome = join(work, "codex");
for (const dir of [homeA, homeB, codexHome]) mkdirSync(dir, { recursive: true });

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
const started = Date.now();
const mark = (what: string) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${what}`);

/** A command that must work; pnpm is a .cmd on Windows, so it goes through the shell. */
function sh(cwd: string, command: string, args: string[]): string {
  const ran = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, shell: command === "pnpm" && process.platform === "win32" });
  if (ran.status !== 0) throw new Error(`${command} ${args.join(" ")} (in ${cwd}) failed: ${ran.stdout}${ran.stderr}${ran.error ?? ""}`);
  return (ran.stdout ?? "").trim();
}
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", ["-c", "user.name=Perry E2E", "-c", "user.email=e2e@perry.invalid", ...args]);
const head = () => git(checkout, "rev-parse", "HEAD");
const buildId = () => existsSync(join(checkout, ".next", "BUILD_ID")) ? readFileSync(join(checkout, ".next", "BUILD_ID"), "utf8").trim() : null;
/** A commit on "GitHub": made in the seed repo and pushed to the bare one. */
function pushUpstream(title: string, change: () => void): string {
  change();
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", title);
  git(seed, "push", "-q", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, CODEX_HOME: codexHome, PERRY_NO_BROWSER: "1", PERRY_NO_PATH: "1" };
for (const name of Object.keys(env)) {
  if (name.startsWith("CONVEX") || ["COMPOSIO_API_KEY", "ELECTRON_RUN_AS_NODE", "PERRY_SERVICE_PID_FILE", "PERRY_SUPERVISOR", "TELEGRAM_BOT_TOKEN", "NODE_ENV"].includes(name)) delete env[name];
}
const logs: Record<string, string> = {};
function start(name: string, argv: string[], extra: Record<string, string>): ChildProcess {
  logs[name] = "";
  const child = spawn(argv[0], argv.slice(1), { cwd: checkout, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  return child;
}
const stop = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
const alive = (pid?: number) => { try { return Boolean(pid) && process.kill(pid!, 0); } catch { return false; } };
const up = () => fetch(`${BASE}/api/backend/http/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);

async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
const refusal = (path: string, args: object) => call(path, args).then(() => null, (error: Error) => error.message);
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return true;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

type View = { supervised: boolean; checkedAt?: number; behind: number; latest?: { sha: string; title: string }; problem?: string; auto: boolean; state: string; busy?: string; last?: { id: string; by: string; at: number; ok: boolean; from?: string; to?: string; title?: string; error?: string; log?: string } };
const status = () => call<View>("updates:status", { key: KEY });
const checkNow = async () => { await call("updates:check", { key: KEY }); return status(); };
const tick = () => call("updates:tick", {});
const requestFile = (home: string) => join(home, "update-request.json");

/** A timezone where it is now the night's update hour (4:00): an Etc/GMT zone, whose sign is the other way round. */
function nightZone(): string {
  const utc = new Date().getUTCHours();
  let offset = (4 - utc + 24) % 24;
  if (offset > 14) offset -= 24;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}
/** Not in the last minutes of an hour, so "now is 4:00 there" holds while it is checked. */
async function awayFromTheHour() {
  while (new Date().getMinutes() >= 55) await sleep(10_000);
}

let server: ChildProcess | null = null;
let perry: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  // --- The stand-ins: GitHub, and Perry's checkout ------------------------------------------
  mark("making the upstream and the checkout");
  const files = sh(REPO, "git", ["ls-files", "-co", "--exclude-standard"]).split(/\r?\n/)
    .filter((file) => file && !/^(artifacts|film|site)\//.test(file) && existsSync(join(REPO, file)));
  for (const file of files) {
    mkdirSync(dirname(join(seed, file)), { recursive: true });
    copyFileSync(join(REPO, file), join(seed, file));
  }
  sh(work, "git", ["init", "-q", "--bare", "-b", "main", upstream]);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "Perry as this branch has it");
  git(seed, "remote", "add", "origin", upstream);
  git(seed, "push", "-q", "-u", "origin", "main");
  const c0 = git(seed, "rev-parse", "HEAD");
  sh(work, "git", ["clone", "-q", upstream, checkout]);
  writeFileSync(join(checkout, ".env.local"), `DASHBOARD_KEY=${KEY}\n`);
  mark("installing packages in the checkout");
  sh(checkout, "pnpm", ["install", "--frozen-lockfile"]);
  mark("building the checkout");
  sh(checkout, "node", [join(checkout, "node_modules", "next", "dist", "bin", "next"), "build"]);
  const firstBuild = buildId();
  // Its compiler cache is only speed, and a few hundred MB this run's disk may not have.
  rmSync(join(checkout, ".next", "cache"), { recursive: true, force: true });
  check("checkoutCleanAfterBuild", sh(checkout, "git", ["status", "--porcelain", "--untracked-files=no"]) === "", sh(checkout, "git", ["status", "--porcelain"]));

  // --- 1–4. Not under perry run: a server started by hand ------------------------------------
  mark("A: a server started by hand");
  server = start("server-a", ["node", join(checkout, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { PERRY_HOME: homeA, NODE_ENV: "production", PERRY_ENGINE: "codex" });
  await until(up, "the hand-started server", 90);
  let view = await checkNow();
  check("upToDateOffersNothing", view.behind === 0 && !view.problem && Boolean(view.checkedAt), view);

  const c1 = pushUpstream("Say hello from upstream", () => appendFileSync(join(seed, "README.md"), "\nHello from upstream.\n"));
  view = await checkNow();
  check("behindShowsCountAndTitle", view.behind === 1 && view.latest?.title === "Say hello from upstream" && view.latest.sha === c1 && !view.problem, view);

  appendFileSync(join(checkout, "README.md"), "\nMy own note.\n");
  view = await checkNow();
  const kept = readFileSync(join(checkout, "README.md"), "utf8").includes("My own note.");
  check("ownersChangesBlockAndStay", view.behind === 1 && /changes that aren't committed/.test(view.problem ?? "") && kept, view.problem);
  git(checkout, "checkout", "--", "README.md");

  git(checkout, "branch", "--unset-upstream");
  view = await checkNow();
  check("noUpstreamHandled", view.behind === 0 && /isn't following a branch/.test(view.problem ?? ""), view.problem);
  git(checkout, "branch", "-u", "origin/main");

  git(checkout, "remote", "set-url", "origin", join(work, "nowhere.git"));
  view = await checkNow();
  check("unreachableRemoteHandled", view.behind === 0 && /Couldn't check for updates/.test(view.problem ?? ""), view.problem);
  git(checkout, "remote", "set-url", "origin", upstream);

  view = await checkNow();
  const refused = await refusal("updates:update", { key: KEY });
  await tick();
  check("handStartedSaysPerryStart", !view.supervised && view.behind === 1 && /perry start/.test(refused ?? ""), { supervised: view.supervised, refused });
  check("handStartedNeverRequests", !existsSync(requestFile(homeA)));
  stop(server);
  server = null;
  await until(async () => !(await up()), "the hand-started server to stop", 30);

  // --- 5–9. Under perry run: the night's update ----------------------------------------------
  mark("C: perry run");
  writeFileSync(join(checkout, "notes.txt"), "the owner's own file, not in git\n");
  perry = start("perry", [process.execPath, join(checkout, "scripts", "perry.ts"), "run"], { PERRY_HOME: homeB, PERRY_ENGINE: "codex" });
  const supervisor = perry.pid;
  await until(up, "perry run's dashboard", 120);
  const upAt = Date.now();
  // Nothing asks: the first tick checks by itself.
  await until(async () => Boolean((await status()).checkedAt), "the first check after start", 150);
  view = await status();
  check("checksSoonAfterStart", view.supervised && view.behind === 1 && view.latest?.sha === c1, { seconds: Math.round((Date.now() - upAt) / 1000), view });

  await awayFromTheHour();
  const zone = nightZone();
  notes.nightZone = zone;
  await call("updates:setAuto", { key: KEY, on: false });
  await call("jobs:setTimezone", { key: KEY, timezone: zone });
  await tick();
  view = await status();
  check("nightlyOffDoesNothing", !existsSync(requestFile(homeB)) && view.state === "idle" && !view.auto && head() === c0);

  const token = (JSON.parse(readFileSync(join(homeB, "runner.json"), "utf8")) as { token: string }).token;
  const ask = () => call<{ id: string; next: string }>("approvals:request", { token, kind: "command", title: "echo waiting on the owner" });
  let approval = await ask();
  await call("updates:setAuto", { key: KEY, on: true });
  await tick();
  view = await status();
  check("nightlyWaitsWhileBusy", !existsSync(requestFile(homeB)) && view.state === "idle" && head() === c0, { approval, view });

  const beforeNight = buildId();
  await call("approvals:decide", { key: KEY, id: approval.id, approved: false });
  mark("C: idle at night; the update should start");
  await tick();
  const wentDown = await until(async () => !(await up()), "the dashboard to stop for the update", 60).catch(() => false);
  await until(up, "the dashboard back after the update", 600);
  await tick().catch(() => {});
  await until(async () => (await status()).last !== undefined, "the result read back", 90);
  view = await status();
  check("nightlyUpdates", wentDown && view.last?.ok === true && view.last.by === "nightly" && view.last.from === c0 && view.last.to === c1 && head() === c1, view.last);
  check("newBuildRuns", Boolean(beforeNight) && buildId() !== beforeNight && buildId() !== null, { before: beforeNight, after: buildId(), first: firstBuild });
  check("supervisorSurvives", alive(supervisor) && perry.exitCode === null && (await up()));
  check("ownersFilesKept", existsSync(join(checkout, "notes.txt")) && readFileSync(join(checkout, ".env.local"), "utf8").includes(KEY));
  view = await checkNow();
  check("upToDateAfterUpdate", view.behind === 0 && !view.problem, view);

  // --- 7, 10, 11. A click while busy, and an update whose build fails ------------------------
  mark("D: a click while busy, and a broken build");
  const c2 = pushUpstream("Break the build on purpose", () => {
    mkdirSync(join(seed, "app", "broken-on-purpose"), { recursive: true });
    writeFileSync(join(seed, "app", "broken-on-purpose", "page.tsx"), "export default function Page( {\n  return <div>not valid</div>;\n}\n");
  });
  view = await checkNow();
  approval = await ask();
  const clicked = await call<{ waitingFor?: string }>("updates:update", { key: KEY });
  await tick();
  view = await status();
  check("clickWaitsWhileBusy", clicked.waitingFor === "an approval" && view.state === "waiting" && view.busy === "an approval" && !existsSync(requestFile(homeB)) && head() === c1, { clicked, state: view.state });

  const beforeBroken = buildId();
  const lastId = view.last?.id;
  await call("approvals:decide", { key: KEY, id: approval.id, approved: false });
  await tick();
  await until(async () => !(await up()), "the dashboard to stop for the broken update", 60).catch(() => {});
  await until(up, "the dashboard back after the broken update", 900);
  await tick().catch(() => {});
  await until(async () => (await status()).last?.id !== lastId, "the failure read back", 90);
  view = await status();
  const last = view.last;
  check("failedBuildGoesBack", last?.ok === false && last.by === "owner" && last.from === c1 && last.to === c2 && head() === c1 && buildId() !== null && buildId() === beforeBroken && (await up()) && alive(supervisor),
    { last: last && { ...last, log: undefined }, head: head(), buildBefore: beforeBroken, buildAfter: buildId() });
  check("failureSaysWhy", /didn't build/.test(last?.error ?? "") && /went back to the version he was on/.test(last?.error ?? "") && (last?.log ?? "").length > 0, last?.error);
  check("ownersFilesKeptAfterGoingBack", existsSync(join(checkout, "notes.txt")) && !existsSync(join(checkout, "app", "broken-on-purpose")));
  check("stillOffered", view.behind === 1 && view.latest?.sha === c2 && view.state === "idle", view);

  // --- 13. The pages ---------------------------------------------------------------------------
  mark("E: Settings, the sidebar and the pet");
  browser = await openChat(BASE, KEY);
  const sidebar = await browser.evaluate(`document.querySelector('[data-sidebar="footer"], [data-slot="sidebar-footer"]')?.innerText ?? document.body.innerText`) as string;
  check("sidebarShowsUpdate", /Update available/.test(sidebar) && /1 change/.test(sidebar), sidebar.slice(0, 300));
  await browser.send("Page.navigate", { url: `${BASE}/settings/general` });
  await until(() => browser!.evaluate(`Boolean(document.querySelector('[data-update-state]'))`), "the Updates section", 30).catch(() => {});
  await sleep(1_500);
  const section = await browser.evaluate(`(() => { const box = document.querySelector('[data-update-state]'); box?.scrollIntoView({ block: 'center' }); return box?.closest('section')?.innerText ?? box?.parentElement?.parentElement?.innerText ?? ''; })()`) as string;
  await sleep(500);
  const shot = await browser.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "settings-updates.png"), Buffer.from(shot.data, "base64"));
  check("settingsShowUpdateAndFailure", /Update available/.test(section) && /1 change/.test(section) && /Break the build on purpose/.test(section) && /didn.t work/.test(section) && /Update on his own at night/.test(section), section);
  await browser.send("Page.navigate", { url: `${BASE}/pet` });
  const petSays = await until(() => browser!.evaluate(`document.body.innerText.includes("A new version of me is ready")`), "the pet's bubble", 30).catch(() => false);
  const petShot = await browser.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "pet-update.png"), Buffer.from(petShot.data, "base64"));
  check("petMentionsUpdate", petSays === true);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
  browser.close();
  browser = null;

  // --- 12, 6. A request nothing picks up, and a queued reply --------------------------------------
  mark("F: a server that believes it is supervised, with nothing picking requests up");
  stop(perry);
  perry = null;
  await until(async () => !(await up()), "perry run to stop", 30);
  // This test's own PID stands in for a `perry run` that is alive but never reads the request.
  server = start("server-f", ["node", join(checkout, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { PERRY_HOME: homeB, NODE_ENV: "production", PERRY_SUPERVISOR: String(process.pid), PERRY_ENGINE: "codex" });
  await until(up, "the server that believes it is supervised", 90);
  await call("updates:update", { key: KEY });
  await until(() => existsSync(requestFile(homeB)), "the request to be written", 30);
  view = await status();
  const updatingShown = view.state === "updating";
  await sleep(95_000);
  await tick();
  view = await status();
  check("unpickedRequestReported", updatingShown && view.state === "idle" && view.last?.ok === false && /Nothing picked the update up/.test(view.last.error ?? "") && !existsSync(requestFile(homeB)), view.last?.error);

  // This test checks in as the computer's runner, signed in to Codex, so the reply is queued for it and waits there.
  const runnerToken = (JSON.parse(readFileSync(join(homeB, "runner.json"), "utf8")) as { token: string }).token;
  await call("runner:checkIn", { token: runnerToken, platform: "win32", hostname: "e2e" });
  await call("codex:reportAccount", { token: runnerToken, available: true, authMode: "chatgpt" });
  const accounts = await call<unknown[]>("codex:accounts", { key: KEY });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "Anything new today?" });
  const queued = await call<{ waitingFor?: string }>("updates:update", { key: KEY });
  await sleep(2_000);
  await tick();
  view = await status();
  check("queuedReplyMakesItWait", queued.waitingFor === "a reply" && view.state === "waiting" && view.busy === "a reply" && !existsSync(requestFile(homeB)), { queued, state: view.state, busy: view.busy, accounts });
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack : error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(perry);
  stop(server);
  await sleep(2_000);
  for (const [name, text] of Object.entries(logs)) writeFileSync(join(outDir, `${name}.log`), text.replaceAll(KEY, "<key>").replaceAll(work, "<work>"));
  try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2).replaceAll(work.replace(/\\/g, "\\\\"), "<work>")}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
