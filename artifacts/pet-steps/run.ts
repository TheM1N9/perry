import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeStep, summarize } from "../../convex/lib/activity";
import { openChat, sleep } from "../browser";

// bun artifacts/pet-steps/run.ts <outDir>
// Issue #100: the desktop pet shows each step Perry is on, not just "On it…".
// A fresh Perry (production build, `pnpm build` first) with the real runner
// and Codex (PERRY_E2E_MODEL picks the model), and the pet's own page (/pet)
// in headless Chrome, watched as Perry works: nothing reaches the owner's
// desktop or their own pet.
//
// Ways it could fail, written down before the checks:
//   1. The bubble still says "On it…" while a step runs.
//   2. A step reads as a raw name: a tool id (read_page), or a command in its
//      PowerShell wrapper.
//   3. No prop shows beside him, or the wrong one for the step.
//   4. A long step never shows how long it has taken.
//   5. Once the reply is in, nothing says what it took, or it miscounts.
//   6. Work outside his chat (a scheduled job) does not show, or shows with
//      no word of where.
//   7. The page throws.
//   8. The phrases the pet uses for Perry's own tools and apps are wrong
//      (checked against spans shaped like the runner's).

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-steps/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pet-steps-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-pet-steps-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

// --- 8. Phrases, for spans shaped as the runner records them -------------------
const phrases = {
  wrapped: describeStep({ kind: "command", name: `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git status"` }).label,
  bash: describeStep({ kind: "command", name: `/bin/bash -lc 'pnpm test'` }).label,
  page: describeStep({ kind: "mcpToolCall", name: "read_page", input: JSON.stringify({ url: "https://www.example.com/pricing" }) }),
  gmail: describeStep({ kind: "mcpToolCall", name: "run_action", input: JSON.stringify({ slug: "GMAIL_FETCH_EMAILS", arguments: {} }) }).label,
  find: describeStep({ kind: "mcpToolCall", name: "find_action", input: JSON.stringify({ query: "new event", toolkits: ["googlecalendar"] }) }).label,
  file: describeStep({ kind: "fileChange", name: "C:\\work\\notes.md" }).label,
  files: describeStep({ kind: "fileChange", name: "a.ts, b.ts, c.ts" }).label,
  search: describeStep({ kind: "webSearch", name: "flights to Goa" }).label,
  other: describeStep({ kind: "mcpToolCall", name: "github.create_issue" }).label,
  summary: summarize([
    { kind: "command", name: "git status" }, { kind: "command", name: "pnpm test" },
    { kind: "mcpToolCall", name: "read_page", input: "{}" },
    { kind: "mcpToolCall", name: "run_action", input: JSON.stringify({ slug: "GMAIL_SEND_EMAIL" }) },
    { kind: "fileChange", name: "a.ts, b.ts" }, { kind: "reasoning", name: "reasoning" },
  ]),
};
notes.phrases = phrases;
check("phrasesReadWell",
  phrases.wrapped === "Running git status" && phrases.bash === "Running pnpm test" && phrases.page.label === "Reading example.com" && phrases.page.pose === "reading"
  && phrases.gmail === "Using Gmail" && phrases.find === "Finding the way into Google Calendar" && phrases.file === "Editing notes.md"
  && phrases.files === "Editing 3 files" && phrases.search === "Searching the web for “flights to Goa”" && phrases.other === "Using github"
  && phrases.summary === "Ran 2 commands · changed 2 files · read 1 page · used Gmail");

// --- Perry ----------------------------------------------------------------------
const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex" };
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

type Seen = { at: number; title: string; detail: string; note: string; pose: string | null };
const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const model = process.env.PERRY_E2E_MODEL;
  // Full access, so the steps run without waiting on an approval.
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  if (model) await call("dashboard:setChatModel", { key: KEY, id: chat, model });

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(chat)}); true`);
  await send("Page.navigate", { url: `${BASE}/pet` });
  await until(() => evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`), "the pet's page", 30);
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));

  // Watch his bubble and prop while he works.
  const seen: Seen[] = [];
  let watching = true;
  const shots = new Set<string>();
  const watch = (async () => {
    while (watching) {
      const now = await evaluate(`(() => {
        const bubble = document.querySelector('main [role="status"]');
        const lines = bubble ? [...bubble.querySelectorAll("p")].map((p) => p.textContent.trim()) : [];
        return { title: lines[0] ?? "", detail: lines[1] ?? "", note: lines[2] ?? "", pose: [...document.querySelectorAll("[data-pose]")].at(-1)?.getAttribute("data-pose") ?? null };
      })()`).catch(() => null) as Omit<Seen, "at"> | null;
      if (now) {
        const last = seen.at(-1);
        if (!last || last.title !== now.title || last.detail.replace(/\d/g, "") !== now.detail.replace(/\d/g, "") || last.note !== now.note || last.pose !== now.pose) {
          seen.push({ at: Date.now(), ...now });
          const name = now.pose ? `pet-${now.pose}.png` : "";
          if (name && !shots.has(name)) { shots.add(name); void shot(name); }
        }
        if (/\d:\d\d/.test(now.detail) && !shots.has("pet-timer.png")) { shots.add("pet-timer.png"); void shot("pet-timer.png"); }
      }
      await sleep(250);
    }
  })();

  const prompt = "Do these two things in order, then answer in one short line: 1) call your read_page tool on https://example.com and note its heading; 2) run this shell command exactly: Start-Sleep -Seconds 8; Write-Output perry-steps";
  await call("dashboard:sendChat", { key: KEY, id: chat, text: prompt });
  await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to start", 60);
  await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to finish", 400);
  await until(() => seen.some((item) => item.title === "Perry" && item.note), "the reply's bubble with what it took", 20).catch(() => {});
  await sleep(1_000);
  await shot("pet-reply.png");
  notes.seenInChat = seen.map(({ title, detail, note, pose }) => ({ title, detail: detail.slice(0, 80), note, pose }));

  const steps = seen.filter((item) => item.title && item.title !== "Perry");
  check("stepsShowNotOnIt", steps.some((item) => item.title === "Reading example.com") && steps.some((item) => /^Running Start-Sleep -Seconds 8/.test(item.title)));
  check("noRawNames", !steps.some((item) => /read_page|powershell|-Command|mcp/i.test(item.title)), steps.map((item) => item.title));
  check("propMatchesStep", seen.some((item) => item.title === "Reading example.com" && item.pose === "reading") && seen.some((item) => /^Running Start-Sleep/.test(item.title) && item.pose === "running"));
  check("longStepShowsTime", seen.some((item) => /^Running Start-Sleep/.test(item.title) && /^0:0[5-9]|^0:1\d/.test(item.detail)));
  const replyBubble = [...seen].reverse().find((item) => item.title === "Perry");
  check("summaryAfterReply", replyBubble?.note === "Ran 1 command · read 1 page", replyBubble);
  const activity = await call<{ running: boolean; summary: string } | null>("dashboard:getActivity", { key: KEY, id: chat });
  check("activityServerSide", activity?.running === false && activity.summary === "Ran 1 command · read 1 page", activity);

  // 6. A scheduled job works while his chat is quiet. The reply he is holding up comes first, so it is put away.
  await evaluate(`document.querySelector('main [role="status"] button[aria-label="Hide"]')?.click(); true`);
  seen.length = 0;
  const job = await call<string>("jobs:saveFromDashboard", { key: KEY, name: "Disk check", prompt: "Run this shell command exactly, then reply with its output only: Start-Sleep -Seconds 6; Write-Output from-a-job", schedule: "0 3 1 1 *" });
  await call("jobs:setModel", { key: KEY, id: job, model: model ?? undefined }).catch(() => {});
  await call("jobs:runNow", { key: KEY, id: job });
  await until(() => seen.some((item) => /^Running Start-Sleep -Seconds 6/.test(item.title)), "the job's step on the pet", 300).catch(() => {});
  const jobStep = seen.find((item) => /^Running Start-Sleep -Seconds 6/.test(item.title));
  if (jobStep) await shot("pet-elsewhere.png");
  check("jobStepShowsWithWhere", Boolean(jobStep && /In ⏰ Disk check/.test(jobStep.detail) && jobStep.pose === "running"), jobStep);
  await until(async () => (await call<Array<{ id: string; lastRunAt?: number; lastResult?: string }>>("jobs:list")).some((item) => item.id === job && Boolean(item.lastResult)), "the job to finish", 300).catch(() => {});
  notes.seenForJob = seen.map(({ title, detail, pose }) => ({ title, detail, pose }));

  watching = false;
  await watch;
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  await sleep(2_000);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
