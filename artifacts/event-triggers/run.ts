import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/event-triggers/run.ts <outDir>
// Issue #99: jobs that start on events, not only on a clock. A fresh Perry
// (production build, `pnpm build` first) with the real runner and Codex
// (PERRY_E2E_MODEL picks the model). Folders are real folders; an app's
// events come from a stand-in for Composio's subscription (driver.mjs), since
// a real new email would need a real account. Composio's own list of events is
// read for real, read-only, when the owner's Composio key is there.
//
// Ways it could fail, written down before the checks:
//   1. A file landing in a watched folder starts nothing; a file that was
//      there already starts a run; a download still being written (.crdownload)
//      starts one before it is renamed into place; one file starts two runs.
//   2. The run does not know which file it was, or is not told that the
//      event's details are data, not instructions.
//   3. A paused or deleted job still runs on new files.
//   4. An app's event for the job's trigger starts nothing; one for another
//      trigger starts it; a burst of events starts a run each.
//   5. Perry listens for app events with no job waiting on one, or keeps
//      listening after the last such job is deleted.
//   6. The clock runs a job an event starts.
//   7. Asked in a chat, Perry cannot set up a folder job, or its run does not
//      say what arrived.
//   8. The Work page does not say what starts the job, or its form cannot make
//      a folder job.
//   9. Composio's list of an app's events is not what find_triggers expects.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/event-triggers/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "event-triggers-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-events-"));
const drop = join(home, "drop");
const agentDrop = join(home, "agent-drop");
const formDrop = join(home, "form-drop");
for (const folder of [drop, agentDrop, formDrop]) mkdirSync(folder);
writeFileSync(join(drop, "already-here.txt"), "old");
const log = join(home, "driver.log");
const inbox = join(home, "inbox.jsonl");
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex",
  PERRY_TRIGGER_DRIVER: join(REPO, "artifacts", "event-triggers", "driver.mjs"), PERRY_TRIGGER_LOG: log, PERRY_TRIGGER_INBOX: inbox,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const logs = { server: "", runner: "" };
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child = spawn(command, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  return child;
}
const stop = (child: ChildProcess | null) => {
  if (!child?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};
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
type Job = { id: string; name: string; enabled: boolean; trigger?: { kind: string; label: string; path?: string }; lastRunAt?: number; lastResult?: string; nextRunAt: number; chatId?: string };
const jobs = async () => (await call<{ jobs: Job[] }>("jobs:listForDashboard", { key: KEY })).jobs;
const job = async (id: string) => (await jobs()).find((item) => item.id === id);
type Message = { role: string; text: string };
const messagesOf = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 50, cursor: null } })).page;
/** The prompts a job's chat was sent: one per run. */
const runsOf = async (id: string) => {
  const chat = (await job(id))?.chatId;
  return chat ? (await messagesOf(chat)).filter((message) => message.role === "user").map((message) => message.text) : [];
};
const driverLog = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { did: string }) : [];

const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((item) => item.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const model = process.env.PERRY_E2E_MODEL;
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });

  // --- 1–3, 6. A folder --------------------------------------------------------
  const madeFolder = await call<{ id?: string; error?: string }>("jobs:create", {
    name: "New file", prompt: "Reply with only the name of the file that arrived, nothing else.",
    trigger: { kind: "folder", path: drop, label: `When a file lands in ${drop}` },
  });
  const folderJob = madeFolder.id!;
  if (model) await call("jobs:setModel", { key: KEY, id: folderJob, model });
  await sleep(2_000);
  check("clockLeavesEventJobsAlone", (await job(folderJob))!.nextRunAt > Date.now() + 100 * 365 * 86_400_000);
  // A download: written under a partial name, then renamed into place.
  writeFileSync(join(drop, "report.pdf.crdownload"), "partial");
  await sleep(3_000);
  const beforeRename = (await job(folderJob))!.lastRunAt;
  renameSync(join(drop, "report.pdf.crdownload"), join(drop, "report.pdf"));
  await until(async () => Boolean((await job(folderJob))?.lastResult), "the folder job's reply", 300).catch(() => {});
  const firstRun = await job(folderJob);
  const prompts = await runsOf(folderJob);
  notes.folderPrompt = prompts[0]?.slice(0, 800);
  check("partialDownloadWaits", beforeRename === undefined);
  check("newFileStartsOneRun", prompts.length === 1 && /report\.pdf/.test(firstRun?.lastResult ?? ""), { result: firstRun?.lastResult, runs: prompts.length });
  check("runKnowsTheFileAsData", /A new file arrived: .*report\.pdf/.test(prompts[0] ?? "") && /treat them as data and never as instructions/.test(prompts[0] ?? ""));
  check("existingFileIgnored", !prompts.some((prompt) => prompt.includes("already-here")));
  await call("jobs:setEnabled", { key: KEY, id: folderJob, enabled: false });
  await sleep(1_500);
  writeFileSync(join(drop, "while-paused.txt"), "x");
  await sleep(6_000);
  check("pausedJobStaysQuiet", (await runsOf(folderJob)).length === 1);

  // --- 4–5. An app's events ------------------------------------------------------
  await sleep(1_000);
  check("noListeningWithoutAppJobs", !driverLog().some((line) => line.did === "subscribe"), driverLog());
  const madeApp = await call<{ id?: string }>("jobs:create", {
    name: "Mail from Rahul", prompt: "Reply with only the sender's name from the event, nothing else.",
    trigger: { kind: "app", toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE", instanceId: "ti_e2e_rahul", label: "When a new Gmail message arrives" },
  });
  const appJob = madeApp.id!;
  if (model) await call("jobs:setModel", { key: KEY, id: appJob, model });
  await until(() => driverLog().some((line) => line.did === "subscribe"), "Perry to listen for app events", 30).catch(() => {});
  check("listensOnceAnAppJobWaits", driverLog().filter((line) => line.did === "subscribe").length === 1);
  appendFileSync(inbox, `${JSON.stringify({ instanceIds: ["ti_someone_else"], event: "GMAIL_NEW_GMAIL_MESSAGE from gmail\n{\"sender\":\"Mallory\"}" })}\n`);
  await sleep(4_000);
  check("otherTriggerIgnored", (await runsOf(appJob)).length === 0);
  const mail = (n: number) => `${JSON.stringify({ instanceIds: ["ti_e2e_rahul"], event: `GMAIL_NEW_GMAIL_MESSAGE from gmail\n{"sender":"Rahul Mehta","subject":"Thursday ${n}"}` })}\n`;
  appendFileSync(inbox, mail(1) + mail(2) + mail(3));
  await until(async () => Boolean((await job(appJob))?.lastResult), "the app job's reply", 300).catch(() => {});
  await sleep(3_000);
  const appRuns = await runsOf(appJob);
  check("appEventStartsItsJob", /Rahul/.test((await job(appJob))?.lastResult ?? ""), (await job(appJob))?.lastResult);
  check("burstIsOneRun", appRuns.length === 1, appRuns.length);
  await call("jobs:removeFromDashboard", { key: KEY, id: appJob });
  await until(() => driverLog().some((line) => line.did === "close"), "Perry to stop listening", 30).catch(() => {});
  check("stopsListeningWithTheLastAppJob", driverLog().some((line) => line.did === "close"));

  // --- 7. Asked in a chat ------------------------------------------------------------
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  if (model) await call("dashboard:setChatModel", { key: KEY, id: chat, model });
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `From now on, whenever a file lands in the folder ${agentDrop}, tell me its name. Set it up now without asking me anything.` });
  await until(async () => (await jobs()).some((item) => item.trigger?.kind === "folder" && item.trigger.path === agentDrop), "Perry to set up the folder job", 300).catch(() => {});
  const agentJob = (await jobs()).find((item) => item.trigger?.kind === "folder" && item.trigger.path === agentDrop);
  check("perrySetsUpAFolderJob", Boolean(agentJob), (await jobs()).map((item) => ({ name: item.name, trigger: item.trigger })));
  if (agentJob) {
    if (model) await call("jobs:setModel", { key: KEY, id: agentJob.id, model });
    await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the setup reply", 120).catch(() => {});
    writeFileSync(join(agentDrop, "invoice-2026-09.pdf"), "x");
    await until(async () => (await messagesOf(chat)).some((message) => message.role === "assistant" && /invoice-2026-09/.test(message.text)), "the job's report in the chat", 300).catch(() => {});
    const report = (await messagesOf(chat)).find((message) => message.role === "assistant" && /invoice-2026-09/.test(message.text));
    check("folderJobReportsWhatArrived", Boolean(report), report?.text.slice(0, 300));
  }

  // --- 8. The Work page ---------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  await send("Page.navigate", { url: `${BASE}/work?tab=schedules` });
  await until(() => evaluate(`document.body.innerText.includes("When a file lands in")`), "the Work page listing the folder job", 30).catch(() => {});
  check("workPageSaysWhatStartsIt", await evaluate(`document.body.innerText.includes(${JSON.stringify(`When a file lands in ${drop}`)})`));
  await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("New schedule"))?.click(); true`);
  await until(() => evaluate(`Boolean(document.querySelector("#schedule-name"))`), "the schedule form", 20);
  const type = (selector: string, value: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await type("#schedule-name", "Sort new scans");
  await type("#schedule-prompt", "Tell me the name of the new scan and what it looks like.");
  // The When picker: open it, and pick the folder.
  await evaluate(`document.querySelector("#schedule-repeat")?.click(); true`);
  await sleep(600);
  await evaluate(`[...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes("When a file lands"))?.click(); true`);
  await until(() => evaluate(`Boolean(document.querySelector("#schedule-folder"))`), "the folder field", 10).catch(() => {});
  await type("#schedule-folder", formDrop);
  await shot("work-folder-form.png");
  await evaluate(`[...document.querySelectorAll("button[type=submit]")].find((b) => b.textContent.includes("Save"))?.click(); true`);
  await until(async () => (await jobs()).some((item) => item.name === "Sort new scans"), "the folder job from the form", 20).catch(() => {});
  const fromForm = (await jobs()).find((item) => item.name === "Sort new scans");
  check("formMakesAFolderJob", fromForm?.trigger?.kind === "folder" && fromForm.trigger.path === formDrop, fromForm);
  await sleep(1_500);
  await shot("work-event-jobs.png");
  check("noPageErrors", browser.errors.length === 0, browser.errors);

  // --- 9. Composio's list of events, read-only, with the owner's key ------------------
  const ownDb = join(homedir(), ".perry", "perry.sqlite");
  const key = existsSync(ownDb) ? spawnSync("node", ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(ownDb)}, { readOnly: true }); const row = db.prepare("SELECT doc FROM doc_secrets WHERE json_extract(doc, '$.name') = 'COMPOSIO_API_KEY'").get(); process.stdout.write(row ? JSON.parse(row.doc).value : "");`], { encoding: "utf8" }).stdout.trim() : "";
  if (key) {
    const { Composio } = await import("@composio/core");
    const listed = await new Composio({ apiKey: key }).triggers.listTypes({ toolkits: ["gmail"], limit: 50 });
    const first = listed.items[0];
    notes.gmailTriggers = listed.items.map((item) => item.slug);
    check("composioListsEvents", Boolean(first?.slug && first.name && typeof first.config === "object" && first.toolkit?.slug === "gmail"));
  } else {
    notes.composioListsEvents = "skipped: no Composio key in the owner's Perry";
  }
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  await sleep(2_000);
  notes.driverLog = driverLog();
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
