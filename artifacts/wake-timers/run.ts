import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/wake-timers/run.ts <outDir>
// Issue #109: wake the computer for scheduled jobs and reminders. A fresh
// Perry (production build, `pnpm build` first) on Windows, where it sets a
// real Task Scheduler wake timer (its own, named after its PERRY_HOME), and
// headless Chrome for the Work page. Nothing here puts the computer to sleep:
// the timer is read back from Task Scheduler instead.
//
// Ways it could fail, written down before the checks:
//   1. No timer is set for what is due next, or one that does not wake the
//      computer, or at the wrong time (not a minute before).
//   2. The timer stays where it was when something sooner is added (a to-do
//      reminder), or when that is gone again.
//   3. Turning waking off leaves the timer set; turning it on does not set it.
//   4. Nothing holds the computer awake when something is minutes away, or
//      the hold is never let go.
//   5. The Work page does not say when the next wake is, or that it is off.
//   6. This Perry's timer touches the owner's own ("Perry wake").

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/wake-timers/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
if (process.platform !== "win32") throw new Error("This check reads Task Scheduler; run it on Windows.");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "wake-timers-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-wake-"));
const TASK = `Perry wake-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const ps = (script: string) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout.trim();
/** The task as Task Scheduler has it: whether it wakes the computer, and when it starts; null when there is none. */
const task = (name: string): { wakes: boolean; at: number } | null => {
  const out = ps(`$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; if ($t) { ConvertTo-Json -Compress @{ wakes = $t.Settings.WakeToRun; at = $t.Triggers[0].StartBoundary } }`);
  if (!out) return null;
  const parsed = JSON.parse(out) as { wakes: boolean; at: string };
  return { wakes: parsed.wakes, at: Date.parse(parsed.at) };
};
/** Processes holding the computer awake the way Perry does: all of them, the owner's Perry's too. */
const holders = () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*PerryAwake*' }).Count`);
const ownersBefore = { task: task("Perry wake"), holders: Number(holders()) };
notes.ownersBefore = ownersBefore;

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: "ignore", windowsHide: true });
const stop = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
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
type Wake = { enabled: boolean; at?: number; what?: string; error?: string; awake?: boolean };
const wake = () => call<Wake>("wake:get", { key: KEY });
/** A minute before, to the minute, as the timer is set. */
const timerFor = (at: number) => Math.floor((at - 60_000) / 60_000) * 60_000;
type Job = { id: string; name: string; enabled: boolean; nextRunAt: number; trigger?: unknown };

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  // The built-in jobs are added on the first minute's tick; this does it now. The dashboard sets the timezone, which moves them.
  await call("jobs:tick", {});
  await call("jobs:setTimezone", { key: KEY, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  // --- 1. What is due next ---------------------------------------------------------------------------
  const jobs = (await call<{ jobs: Job[] }>("jobs:listForDashboard", { key: KEY })).jobs;
  const soonest = jobs.filter((job) => job.enabled && !job.trigger).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
  await until(async () => task(TASK)?.at === timerFor(soonest.nextRunAt), "the first timer", 30).catch(() => {});
  const first = task(TASK);
  const said = await wake();
  check("timerForTheNextJob", Boolean(first?.wakes) && first?.at === timerFor(soonest.nextRunAt) && said.at === soonest.nextRunAt && said.what === soonest.name && !said.error,
    { job: soonest.name, due: new Date(soonest.nextRunAt).toISOString(), timer: first && new Date(first.at).toISOString(), said });

  // --- 2. Something sooner, then gone ------------------------------------------------------------------
  const dueAt = Math.min(soonest.nextRunAt - 5 * 60_000, Date.now() + 20 * 60_000);
  const todo = await call<string>("todos:add", { key: KEY, title: "Call the bank", dueAt });
  await until(() => task(TASK)?.at === timerFor(dueAt), "the timer to move sooner", 30).catch(() => {});
  const sooner = task(TASK);
  check("movesForASoonerReminder", sooner?.at === timerFor(dueAt) && /Call the bank/.test((await wake()).what ?? ""), sooner && new Date(sooner.at).toISOString());
  await call("todos:setDone", { key: KEY, id: todo, done: true });
  await until(() => task(TASK)?.at === timerFor(soonest.nextRunAt), "the timer to move back", 30).catch(() => {});
  check("movesBackWhenItIsDone", task(TASK)?.at === timerFor(soonest.nextRunAt));

  // --- 4. Minutes away: held awake, then let go ---------------------------------------------------------
  const inTwo = new Date(Date.now() + 2 * 60_000 + 30_000);
  const made = await call<{ id?: string }>("jobs:create", { name: "Stretch", prompt: "Remind me to stretch.", at: inTwo.toISOString() });
  await until(async () => Boolean((await wake()).awake) && Number(holders()) > ownersBefore.holders, "the hold", 30).catch(() => {});
  const held = { awake: (await wake()).awake, holders: Number(holders()) };
  check("heldAwakeWhenMinutesAway", held.awake === true && held.holders === ownersBefore.holders + 1, held);
  await call("jobs:removeFromDashboard", { key: KEY, id: made.id });
  await until(async () => !(await wake()).awake && Number(holders()) === ownersBefore.holders, "the hold let go", 30).catch(() => {});
  check("letGoWhenNothingIsNear", !(await wake()).awake && Number(holders()) === ownersBefore.holders);

  // --- 5. The Work page ----------------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const card = `(document.querySelector("#wake-computer")?.closest("div.rounded-xl")?.innerText ?? "")`;
  await send("Page.navigate", { url: `${BASE}/work?tab=schedules` });
  await until(async () => /Next:/.test(await evaluate(card)), "the wake line", 30).catch(() => {});
  const shown = await evaluate(card) as string;
  await shot("work-wake-on.png");
  check("pageSaysWhenItWakes", /Wake this computer for them/.test(shown) && shown.includes(soonest.name), shown);

  // --- 3. Off, then on again --------------------------------------------------------------------------------
  await evaluate(`document.querySelector("#wake-computer").click(); true`);
  await until(() => task(TASK) === null, "the timer to go", 30).catch(() => {});
  await until(async () => /Off: what is due/.test(await evaluate(card)), "the off line", 15).catch(() => {});
  const off = await evaluate(card) as string;
  await shot("work-wake-off.png");
  check("offTakesTheTimerAway", task(TASK) === null && !(await wake()).enabled && /Off: what is due while it sleeps/.test(off), off);
  await call("wake:set", { key: KEY, enabled: true });
  await until(() => task(TASK) !== null, "the timer to come back", 30).catch(() => {});
  const again = task(TASK);
  check("onSetsItAgain", again?.at === timerFor(soonest.nextRunAt), { timer: again && new Date(again.at).toISOString(), wanted: new Date(timerFor(soonest.nextRunAt)).toISOString(), said: await wake() });
  check("noPageErrors", browser.errors.length === 0, browser.errors);

  // --- 6. The owner's own --------------------------------------------------------------------------------------
  check("ownersTimerUntouched", JSON.stringify(task("Perry wake")) === JSON.stringify(ownersBefore.task));
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(server);
  await sleep(2_000);
  // Never leave this Perry's timer behind.
  ps(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue`);
  checks.timerRemovedAfter = task(TASK) === null;
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
