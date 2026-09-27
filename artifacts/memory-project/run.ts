import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/memory-project/run.ts <outDir>
// Issue #106, part two: a project chat keeps its own memory, and what matters
// is saved before a chat is compacted: by /compact, and before Codex compacts
// a nearly full thread by itself. A fresh Perry (production build, `pnpm build`
// first), the real runner and Codex (PERRY_E2E_MODEL picks the model), and
// headless Chrome for the Memory page.
//
// Ways it could fail, written down before the checks:
//   1. What Perry remembers in a project chat is known in another chat: in
//      what it recalls, or by searching or reading the project chat.
//   2. The project chat itself forgets it.
//   3. Something the owner says belongs everywhere, said in a project chat,
//      stays stuck there.
//   4. /compact summarises the chat away before anything is saved; or the
//      checkpoint shows up in the chat.
//   5. The runner never says how full a thread is, so Perry cannot tell when
//      Codex is about to compact it.
//   6. A nearly full thread gets no checkpoint, or one after every reply.
//   7. The day's summary of chats (into everyone's notes) includes the project.
//   8. The Memory page does not say which memory stays in which chat.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/memory-project/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "memory-project-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-project-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  return spawn(command, args, { cwd: REPO, env, stdio: "ignore", windowsHide: true });
}
const stop = (child: ChildProcess | null) => { if (child?.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
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
type Message = { role: string; text: string };
type Memory = { id: string; text: string; kind: string; chatId?: string; chat?: string };
const messagesOf = async (id: string) => (await call<{ page: Message[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 30, cursor: null } })).page;
const idle = (id: string) => until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id })).isRunning
  && !(await call<Array<{ status: string }>>("dashboard:listRuns", { key: KEY, conversationId: id })).some((run) => run.status === "running"), "the chat to be idle", 400);
async function ask(chat: string, text: string): Promise<string> {
  await call("dashboard:sendChat", { key: KEY, id: chat, text });
  await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning, "the reply to start", 60).catch(() => {});
  await idle(chat);
  return (await messagesOf(chat)).find((message) => message.role === "assistant")?.text ?? "";
}
const memories = () => call<Memory[]>("dashboard:listMemories", { key: KEY });
const runsOf = (chat: string) => call<Array<{ prompt: string; status: string }>>("dashboard:listRuns", { key: KEY, conversationId: chat });
const conversation = (id: string) => call<{ contextFill?: number; checkpointedAt?: number } | null>("conversations:getById", { id });

let server = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  const model = process.env.PERRY_E2E_MODEL;
  const newChat = async () => { const id = await call<string>("dashboard:createChat", { key: KEY }); if (model) await call("dashboard:setChatModel", { key: KEY, id, model }); return id; };

  // --- 1–3. A project chat -------------------------------------------------------------------
  const project = await newChat();
  await call("dashboard:setChatProject", { key: KEY, id: project, project: true });
  await ask(project, "Remember this for this project: its codename is BLUEFIN.");
  await ask(project, "Also remember, for every chat, that my favourite code editor is Helix.");
  const saved = await memories();
  const codename = saved.find((memory) => /bluefin/i.test(memory.text));
  const editor = saved.find((memory) => /helix/i.test(memory.text));
  check("projectMemoryStaysInProject", codename?.chatId === project && !editor?.chatId, saved.map(({ text, chatId }) => ({ text, chatId })));
  const other = await newChat();
  const elsewhere = await ask(other, "This is an automated test. What is the codename of my current project? Check your memory and my other chats; if you cannot find it, say you don't know.");
  check("otherChatsDoNotKnow", !/bluefin/i.test(elsewhere), elsewhere);
  const editorElsewhere = await ask(other, "Which code editor do I like best? One word.");
  check("everywhereIsSeenEverywhere", /helix/i.test(editorElsewhere), editorElsewhere);
  const inProject = await ask(project, "What is this project's codename? One word.");
  check("projectRemembers", /bluefin/i.test(inProject), inProject);
  const summary = await call<Array<{ id: string }>>("conversations:activeSince", { since: 0 });
  check("dailySummaryLeavesProjectOut", !summary.some((chat) => chat.id === project) && summary.some((chat) => chat.id === other));

  // --- 5. The runner says how full a thread is --------------------------------------------------
  const fill = (await conversation(other))?.contextFill;
  check("runnerReportsContext", typeof fill === "number" && fill > 0 && fill < 1, fill);

  // --- 4. /compact saves first -------------------------------------------------------------------
  const trip = await newChat();
  await ask(trip, "I'm planning a trip to Kyoto on 12 March with Ananya, staying at the Ryokan Sakura. Just say OK, don't save anything yet.");
  const shownBefore = (await messagesOf(trip)).length;
  const compaction = await call<string | null>("dashboard:compactChat", { key: KEY, id: trip });
  await until(async () => (await runsOf(trip)).some((run) => run.prompt === "Memory checkpoint" && run.status !== "running"), "the checkpoint before /compact", 400).catch(() => {});
  await until(async () => (await call<{ status: string } | null>("dashboard:getCompaction", { key: KEY, id: compaction }))?.status === "done", "the compaction", 400).catch(() => {});
  const tripRuns = (await runsOf(trip)).map((run) => run.prompt.slice(0, 20));
  const kyoto = (await memories()).find((memory) => /kyoto/i.test(memory.text));
  check("compactSavesFirst", Boolean(compaction) && Boolean(kyoto) && tripRuns.includes("Memory checkpoint"), { tripRuns, kyoto: kyoto?.text });
  check("checkpointLeavesNoTrace", (await messagesOf(trip)).length === shownBefore);

  // --- 6. Nearly full: one checkpoint, not one per reply -------------------------------------
  // A thread really near its limit takes hundreds of thousands of tokens. Perry restarts on the same data with
  // the threshold near nothing (PERRY_CHECKPOINT_AT), so the fill the runner really reports sets it off.
  stop(runner);
  stop(server);
  await sleep(4_000);
  env.PERRY_CHECKPOINT_AT = "0.0001";
  server = start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start again", 90);
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 30_000 && item.codexAuthMode === "chatgpt"), "the runner to come back", 120);
  const busy = await newChat();
  await ask(busy, "Remember nothing yet. My sister Ananya's birthday party is on 20 April at 7pm, at our place. Just say OK.");
  await until(async () => (await runsOf(busy)).some((run) => run.prompt === "Memory checkpoint" && run.status !== "running"), "the checkpoint of a full thread", 400).catch(() => {});
  const afterFirst = (await runsOf(busy)).filter((run) => run.prompt === "Memory checkpoint").length;
  await ask(busy, "Thanks. What time is the party? One line.");
  await idle(busy);
  await sleep(3_000);
  const afterSecond = (await runsOf(busy)).filter((run) => run.prompt === "Memory checkpoint").length;
  const party = (await memories()).find((memory) => /20 April|party/i.test(memory.text));
  check("fullThreadCheckpointsOnce", afterFirst === 1 && afterSecond === 1 && Boolean((await conversation(busy))?.checkpointedAt) && Boolean(party), { afterFirst, afterSecond, party: party?.text });

  // --- 8. The Memory page ------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  await browser.send("Page.navigate", { url: `${BASE}/memory` });
  await until(() => browser!.evaluate(`document.body.innerText.includes("BLUEFIN") || document.body.innerText.includes("Bluefin")`), "the Memory page", 30).catch(() => {});
  await sleep(1_000);
  const shownOnly = await browser.evaluate(`document.body.innerText.includes("Only in")`);
  const shot = await browser.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "memory-page.png"), Buffer.from(shot.data, "base64"));
  check("memoryPageSaysWhichChat", Boolean(shownOnly));
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
