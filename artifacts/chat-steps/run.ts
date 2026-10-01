import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/chat-steps/run.ts <outDir>
// The web chat lists every step Perry takes while a reply is on its way, in
// order, and keeps them with the reply after, folded into "Worked for 12s ·
// 3 steps" (dashboard.getChatWork), not a "Thinking" that stays put until the
// whole reply lands. A fresh Perry (production build, `pnpm build` first) with
// the real runner and Codex (PERRY_E2E_MODEL picks the model), and the chat in
// headless Chrome. PERRY_E2E_ENGINE=claude (or another engine) runs it there
// instead: every engine's steps come through the runner's trace the same way.
//
// Ways it could fail, written down before the checks:
//   1. The chat still says only "Thinking" while a step runs: it must show
//      "Reading example.com" and "Running Start-Sleep -Seconds 8…".
//   2. A step reads as a raw name: a tool id (read_page), or a command in its
//      PowerShell wrapper.
//   3. The steps are off screen: they must be in view while they show.
//   4. A step goes away when the next starts: each look must still list every
//      step seen before, in the same order.
//   5. The live list or a spinner stays once the reply is in.
//   6. The reply does not land. (Whether its words streamed is noted, not
//      checked: after a tool, Claude Code sends them in one burst at the end.)
//   7. No "Worked for …" above the reply, or it is open from the start.
//   8. Opened, it does not list the steps in the order they ran, each done.
//   9. It is gone once the page loads again (kept in the page, not the server).
//  10. The page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/chat-steps/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "chat-steps-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-chat-steps-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
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

/** What the chat shows below the messages at one moment. */
type Seen = { at: number; thinking: string | null; streaming: number | null; steps: string[]; inView: boolean; replies: number };
const server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  runner = start("runner");
  // Every engine reports its steps the same way (the runner's trace); PERRY_E2E_ENGINE picks one other than Codex.
  const engine = process.env.PERRY_E2E_ENGINE;
  const model = process.env.PERRY_E2E_MODEL;
  notes.engine = engine ?? "codex";
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && (engine || item.codexAuthMode === "chatgpt")), "the runner to come online", 120);
  // Full access, so the steps run without waiting on an approval.
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  if (model || engine) await call("dashboard:setChatModel", { key: KEY, id: chat, ...(model ? { model } : {}), ...(engine ? { engine } : {}) });

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await until(() => evaluate(`Boolean(document.querySelector("#composer"))`), "the chat to open", 30);
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));

  // Watch what the chat shows under the messages while the reply is on its way.
  const seen: Seen[] = [];
  let watching = true;
  const shots = new Set<string>();
  const watch = (async () => {
    while (watching) {
      const now = await evaluate(`(() => {
        const thinking = document.querySelector("[data-thinking]");
        const streaming = document.querySelector("[data-streaming]");
        const steps = [...document.querySelectorAll("#content [data-step]")];
        const inView = steps.every((step) => { const box = step.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; });
        return { thinking: thinking ? thinking.textContent.trim() : null, streaming: streaming ? streaming.textContent.length : null, steps: steps.map((step) => step.getAttribute("data-step")), inView,
          replies: document.querySelectorAll('[data-role="assistant"]:not([data-streaming]):not([data-thinking])').length };
      })()`).catch(() => null) as Omit<Seen, "at"> | null;
      if (now) {
        const last = seen.at(-1);
        if (!last || JSON.stringify([last.thinking, last.streaming === null, last.steps, last.inView, last.replies]) !== JSON.stringify([now.thinking, now.streaming === null, now.steps, now.inView, now.replies])) {
          seen.push({ at: Date.now(), ...now });
          const latest = now.steps.filter((step) => step !== "Thinking").at(-1) ?? "";
          const name = /^Reading/.test(latest) ? "chat-reading.png" : /^Running/.test(latest) ? "chat-running.png" : now.streaming !== null ? "chat-streaming.png" : "";
          if (name && !shots.has(name)) { shots.add(name); void shot(name); }
        }
      }
      await sleep(150);
    }
  })();

  const prompt = "Do these two things in order: 1) call your read_page tool on https://example.com and note its heading; 2) run this shell command exactly: Start-Sleep -Seconds 8; Write-Output perry-steps. Then answer in three sentences about what you found.";
  await evaluate(`(() => {
    const box = document.querySelector("#composer");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(prompt)});
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  await evaluate(`document.querySelector("#composer").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true`);
  await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to start", 60);
  await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to finish", 400);
  await until(() => seen.at(-1)?.replies === 1 && seen.at(-1)?.thinking === null && seen.at(-1)?.streaming === null, "the reply to land in the chat", 20).catch(() => {});
  await sleep(1_500);
  await shot("chat-reply.png");
  watching = false;
  // A page that stopped answering would hold the last look open for good.
  await Promise.race([watch, sleep(5_000)]);
  const failed = await call<{ lastError?: string }>("dashboard:getChat", { key: KEY, id: chat });
  if (failed.lastError) notes.replyError = failed.lastError;
  notes.seen = seen.map(({ at, ...item }) => ({ t: at - seen[0]!.at, ...item }));

  const steps = seen.flatMap((item) => item.steps);
  check("stepsShowNotThinking", steps.includes("Reading example.com") && steps.some((step) => /^Running Start-Sleep -Seconds 8/.test(step)), [...new Set(steps)]);
  check("noRawNames", !steps.some((step) => /read_page|powershell|-Command|mcp/i.test(step)));
  check("stepInView", seen.every((item) => item.inView));
  // While the reply is on its way, the steps listed only grow: no earlier one drops out or moves.
  const lists = seen.filter((item) => item.replies === 0).map((item) => item.steps.filter((step) => step !== "Thinking"));
  check("stepsStayInOrder", lists.every((list, index) => index === 0 || lists[index - 1]!.every((step, at) => list[at] === step)) && Math.max(0, ...lists.map((list) => list.length)) >= 2);
  const end = seen.at(-1);
  check("nothingLingers", Boolean(end && end.thinking === null && end.streaming === null && end.steps.length === 0 && end.replies === 1), end);
  check("replyLands", end?.replies === 1);
  notes.wordsStreamed = seen.some((item) => item.streaming !== null);

  // Above the reply, folded: "Worked for …", opened by a click to the steps in the order they ran.
  const folded = () => evaluate(`(() => {
    const reply = [...document.querySelectorAll('[data-role="assistant"]:not([data-streaming]):not([data-thinking])')].at(-1);
    const work = reply?.querySelector("[data-work]");
    const button = work?.querySelector("button");
    return { label: button ? button.textContent.trim() : null, open: button?.getAttribute("aria-expanded") === "true", above: Boolean(work && work.compareDocumentPosition(reply.querySelector(".prose-chat, p") ?? work) & Node.DOCUMENT_POSITION_FOLLOWING),
      steps: work ? [...work.querySelectorAll("[data-step]")].map((step) => ({ label: step.getAttribute("data-step"), status: step.getAttribute("data-status") })) : [] };
  })()`) as Promise<{ label: string | null; open: boolean; above: boolean; steps: Array<{ label: string; status: string }> }>;
  const closed = await folded();
  check("workedForAboveReply", Boolean(closed.label && /^Worked for (<1s|\d+s|\d+m \d+s) · \d+ steps?$/.test(closed.label) && !closed.open && closed.steps.length === 0 && closed.above), closed);
  await evaluate(`[...document.querySelectorAll('[data-role="assistant"] [data-work] button')].at(-1).click(); true`);
  await sleep(300);
  const opened = await folded();
  await shot("chat-worked-for.png");
  const reading = opened.steps.findIndex((step) => step.label === "Reading example.com");
  const running = opened.steps.findIndex((step) => /^Running Start-Sleep -Seconds 8/.test(step.label));
  check("opensToStepsInOrder", opened.open && reading >= 0 && running > reading && opened.steps.every((step) => step.status === "ok")
    && closed.label?.endsWith(`· ${opened.steps.length} step${opened.steps.length === 1 ? "" : "s"}`) === true, opened);
  await send("Page.reload", {});
  await until(() => evaluate(`Boolean(document.querySelector('[data-role="assistant"] [data-work] button'))`), "the chat to load again with its work", 30).catch(() => {});
  const again = await folded();
  check("keptAfterReload", again.label === closed.label, again);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  notes.runnerLog = logs.runner.slice(-2000);
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
