import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/chat-indicators/run.ts <outDir>
// What a chat shows while it works and once it is done, and the names new
// chats get from Luna. A fresh PERRY_HOME, the production build (`pnpm build`
// first) on a free port, the real runner and Codex (signed in with ChatGPT),
// and headless Chrome on the dashboard. Chats reply on PERRY_E2E_MODEL
// (gpt-6-luna by default). Screenshots are of the headless page only.
//
// Ways it could fail, and what this checks for each:
//   1. The first message does not title the chat at once: right after sending,
//      the chat's title must be the message, not "New chat".
//   2. No runner names it, or not with Luna: the title must change to a short
//      one (1 to 8 words) that is not the message, and the runner's log must
//      say it named the chat with gpt-6-luna.
//   3. Naming is stuck: no chat may still be marked naming at the end.
//   4. No loading indicator: while the reply runs, the chat's sidebar row and
//      the header must show the spinner (data-status="running"), and the chat
//      must show the "Thinking" spinner or the streaming reply.
//   5. No completion indicator for a reply you missed: with the chat left while
//      it replies, its row must show "Reply ready" once it finishes, and lose
//      it when the chat is opened.
//   6. No completion indicator for a reply you watched: in a chat left open,
//      the header must show "Done" as the reply lands, and it must go again
//      after a few seconds.
//   7. A name overwrites the owner's: a chat renamed right after its first
//      message must keep the owner's name after the runner is done.
//   8. A failed reply does not show: a chat whose last run failed (recorded
//      with runs:finish) must show the red alert (data-status="error") in its
//      row and header.
//   9. Any of it throws in the page: no page errors.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/chat-indicators/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "chat-indicators-e2e-key";
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const home = mkdtempSync(join(tmpdir(), "perry-chat-indicators-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name.startsWith("TELEGRAM")) delete env[name];
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
  const response = await fetch(`${BASE}/api/backend/admin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-perry-key": KEY },
    body: JSON.stringify({ path, args }),
  });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until<T>(test: () => Promise<T> | T, what: string, seconds = 60, everyMs = 500): Promise<NonNullable<T>> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(test).catch(() => undefined);
    if (value) return value as NonNullable<T>;
    await sleep(everyMs);
  }
  throw new Error(`timed out: ${what}`);
}
type Summary = { id: string; title: string; status: string; unseen: boolean; naming: boolean };
const chats = () => call<Summary[]>("dashboard:listChats", { key: KEY });
const chatOf = async (id: string) => (await chats()).find((chat) => chat.id === id);
const newChat = async (model: string) => {
  const id = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id, model });
  return id;
};
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

let server: ChildProcess | null = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const models = await until(async () => { const list = await call<Array<{ id: string }>>("models:list"); return list.length ? list : null; }, "the runner's model list", 60);
  notes.models = models.map((model) => model.id);
  notes.model = MODEL;

  browser = await openChat(BASE, KEY);
  const { evaluate, send, errors } = browser;
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const go = async (path: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await evaluate(`new Promise((resolve) => { const tick = () => document.querySelector('textarea#composer') ? resolve(true) : setTimeout(tick, 100); tick(); })`);
  };
  const sendInPage = (text: string) => evaluate(`(() => {
    const box = document.querySelector('textarea#composer');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => { document.querySelector('[aria-label="Send message"]').click(); resolve(true); }, 200));
  })()`);
  /** What the page shows for a chat: its sidebar row's indicator and title, the header's, and the thinking spinner. */
  const shown = (id: string) => evaluate(`(() => {
    const row = document.querySelector('[data-sidebar="menu"] a[href="/chat/${id}"]')?.closest('li');
    const header = document.querySelector('h1')?.parentElement;
    return {
      row: row?.querySelector('[data-status]')?.getAttribute('data-status') ?? null,
      rowLabel: row?.querySelector('[data-status]')?.getAttribute('aria-label') ?? null,
      rowTitle: row?.querySelector('a')?.innerText.trim() ?? null,
      rowShimmer: Boolean(row?.querySelector('a .shimmer')),
      header: header?.querySelector('[data-status]')?.getAttribute('data-status') ?? null,
      thinkingSpinner: Boolean(document.querySelector('[data-thinking] .animate-spin, [data-thinking] .motion-safe\\\\:animate-spin')),
      streaming: Boolean(document.querySelector('[data-streaming]')),
    };
  })()`) as Promise<{ row: string | null; rowLabel: string | null; rowTitle: string | null; rowShimmer: boolean; header: string | null; thinkingSpinner: boolean; streaming: boolean }>;

  // --- 1 to 5: a chat that replies while you are away --------------------------------
  const away = await newChat(MODEL);
  const firstMessage = "What are three good day hikes near Lisbon? One line each.";
  await go(`/chat/${away}`);
  await sendInPage(firstMessage);
  const titled = await until(async () => { const chat = await chatOf(away); return chat && chat.title !== "New chat" ? chat : null; }, "the first-message title", 10, 100);
  notes.provisionalTitle = titled.title;
  checks.titledAtOnce = titled.title === firstMessage;
  const working = await until(async () => { const seen = await shown(away); return seen.row === "running" && seen.header === "running" ? seen : null; }, "the working spinner", 30, 100);
  notes.whileWorking = working;
  const thinking = await until(async () => { const seen = await shown(away); return seen.thinkingSpinner || seen.streaming ? seen : null; }, "the thinking spinner", 30, 100).catch(() => null);
  checks.spinnerWhileWorking = working.row === "running" && working.header === "running" && Boolean(thinking);
  await shot("working.png");
  notes.namingSeen = (await shown(away)).rowShimmer || (await chatOf(away))?.naming === true;

  // Leave while it replies; its row gets the check when the reply lands.
  await go("/chat");
  const named = await until(async () => { const chat = await chatOf(away); return chat && chat.title !== firstMessage && !chat.naming ? chat : null; }, "Luna to name the chat", 90);
  notes.name = named.title;
  notes.runnerNamed = logs.runner.split("\n").filter((line) => line.includes("named a chat") || line.includes("could not name")).map((line) => line.trim());
  checks.namedShort = words(named.title) >= 1 && words(named.title) <= 8 && named.title !== firstMessage;
  checks.namedWithLuna = logs.runner.includes(`named a chat "${named.title}" (gpt-6-luna)`);
  const ready = await until(async () => { const seen = await shown(away); return seen.row === "unseen" ? seen : null; }, "the reply-ready check", 300);
  notes.afterReply = ready;
  checks.replyReadyWhenAway = ready.row === "unseen" && ready.rowLabel === "Reply ready" && ready.rowTitle === named.title;
  await shot("reply-ready.png");
  await evaluate(`document.querySelector('[data-sidebar="menu"] a[href="/chat/${away}"]').click(); true`);
  const opened = await until(async () => { const seen = await shown(away); return seen.row === null && !(await chatOf(away))?.unseen ? seen : null; }, "the check to clear once opened", 15).catch(() => null);
  checks.readyClearsWhenOpened = Boolean(opened);

  // --- 6: a chat you watch reply ------------------------------------------------------
  const watched = await newChat(MODEL);
  await go(`/chat/${watched}`);
  await sendInPage("Name one fruit. Just the word.");
  await until(async () => (await shown(watched)).header === "running", "the watched chat to start", 30, 100);
  const done = await until(async () => { const seen = await shown(watched); return seen.header === "done" ? seen : null; }, "the done check", 300, 100);
  notes.watchedDone = done;
  await shot("done.png");
  await sleep(5_500);
  const later = await shown(watched);
  notes.watchedLater = later;
  checks.doneWhenWatched = done.header === "done" && later.header === null && later.row === null;

  // --- 7: the owner's name stands -----------------------------------------------------
  const renamed = await newChat(MODEL);
  await call("dashboard:sendChat", { key: KEY, id: renamed, text: "Draft a two-line birthday note for my sister." });
  await call("dashboard:renameChat", { key: KEY, id: renamed, title: "Sister's birthday" });
  await until(async () => { const chat = await chatOf(renamed); return chat && chat.status === "idle" && !chat.naming; }, "the renamed chat's reply", 300);
  await sleep(3_000);
  checks.ownerNameKept = (await chatOf(renamed))?.title === "Sister's birthday";

  // --- 8: a failed reply ----------------------------------------------------------------
  // Recorded the way a turn that failed records it: Perry falls back to the default for a model it
  // does not list, and the account takes every listed one, so a real failure cannot be made on demand.
  const failing = await newChat(MODEL);
  await call("dashboard:renameChat", { key: KEY, id: failing, title: "Check the weather" });
  const run = await call<string>("runs:start", { conversationId: failing, prompt: "What's the weather tomorrow?" });
  await call("runs:finish", { id: run, status: "error", error: "Codex could not reach the model." });
  await until(async () => (await chatOf(failing))?.status === "error", "the chat to list as failed", 15);
  await go(`/chat/${failing}`);
  const failed = await until(async () => { const seen = await shown(failing); return seen.row === "error" ? seen : null; }, "the failed alert", 15);
  notes.failed = failed;
  checks.errorShown = failed.row === "error" && failed.header === "error";
  await shot("failed.png");

  checks.nothingStuckNaming = (await chats()).every((chat) => !chat.naming);
  notes.titles = (await chats()).map((chat) => chat.title);
  notes.pageErrors = errors;
  checks.noPageErrors = errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  writeFileSync(join(outDir, "runner.log"), logs.runner.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
