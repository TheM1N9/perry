import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

/**
 * What the ACP engines' end-to-end runs share (artifacts/engine-grok,
 * engine-cursor, engine-antigravity): a fresh Perry from the production build
 * (`pnpm build` first) on a spare port with a temp PERRY_HOME, the real runner
 * with the engine's CLI pointed at the fake agent (fake-agent.ts) through its
 * PERRY_<ENGINE>_COMMAND, this machine's real Codex beside it on the same
 * runner, headless Chrome for Settings, and ways to read Perry's documents and
 * the fake agent's log. Nothing touches the owner's own Perry.
 */

export { sleep };
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FAKE_AGENT = join(REPO, "artifacts", "engine-acp", "fake-agent.ts");
/** An email address, as a signed-in account shows one; never written into an artifact. */
export const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
export type Row = Record<string, any> & { _id: string };

const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });

export async function perry(options: { name: string; outDir: string; runnerEnv: (home: string) => Record<string, string> }) {
  mkdirSync(options.outDir, { recursive: true });
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const KEY = `${options.name}-e2e-key`;
  const home = mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), `perry-${options.name}-`));
  const checks: Record<string, boolean> = {};
  const notes: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

  const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
  for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
  const logs = { server: "", runner: "" };
  const children: ChildProcess[] = [];
  const start = (name: "server" | "runner"): ChildProcess => {
    const [command, args]: [string, string[]] = name === "server"
      ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
      : [process.execPath, [join(REPO, "runner", "index.ts")]];
    const child = spawn(command, args, { cwd: REPO, env: name === "runner" ? { ...env, ...options.runnerEnv(home) } : env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
    children.push(child);
    return child;
  };
  const stop = (child: ChildProcess | null) => {
    if (!child?.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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

  // Perry's documents in SQLite, through Node (Bun has no node:sqlite); the server's connection sees each write.
  const SQL = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
const statement = db.prepare(process.argv[2]); const params = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? statement.all(...params) : (statement.run(...params), [])));`;
  function sql<T>(statement: string, params: Array<string | number> = []): T[] {
    const ran = spawnSync("node", ["-e", SQL, join(home, "perry.sqlite"), statement, JSON.stringify(params)], { encoding: "utf8", windowsHide: true });
    if (ran.status !== 0) throw new Error(`sqlite: ${ran.stderr}`);
    return JSON.parse(ran.stdout || "[]");
  }
  const rows = (table: string): Row[] => sql<{ _id: string; doc: string }>(`SELECT _id, doc FROM "doc_${table}"`).map((row) => ({ _id: row._id, ...JSON.parse(row.doc) }));
  const turnsOf = (chat: string) => rows("codexTurns").filter((turn) => turn.conversationId === chat).sort((a, b) => a.createdAt - b.createdAt);

  type Chat = { isRunning: boolean; streaming?: string; lastError?: string; engine: string; model?: string; title: string };
  const getChat = (id: string) => call<Chat>("dashboard:getChat", { key: KEY, id });
  const messagesOf = async (id: string) => (await call<{ page: Array<{ role: string; text: string; createdAt: number }> }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 50, cursor: null } }))
    .page.sort((a, b) => a.createdAt - b.createdAt);
  const lastReply = async (id: string) => (await messagesOf(id)).filter((message) => message.role === "assistant").at(-1)?.text ?? "";
  const runsOf = (id: string) => call<Array<{ prompt: string; status: string; model?: string; startedAt: number }>>("dashboard:listRuns", { key: KEY, conversationId: id });
  const conversation = (id: string) => call<Row>("conversations:getById", { id });
  type Computer = { id: string; name: string; online: boolean; engines: Array<{ kind: string; label: string; installed: boolean; signedIn: boolean; version?: string; message?: string; auth: { label?: string; plan?: string }; request?: { kind?: string; status: string; interaction?: Record<string, string> } }> };
  const computers = () => call<Computer[]>("engines:list", { key: KEY });

  /** Send a message and wait until the chat is idle again with a new reply; the snapshots of the streaming text are kept. */
  async function exchange(chat: string, text: string, seconds = 120) {
    const before = (await messagesOf(chat)).filter((message) => message.role === "assistant").length;
    await call("dashboard:sendChat", { key: KEY, id: chat, text });
    const streamed: string[] = [];
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const now = await getChat(chat);
      if (now.streaming && streamed.at(-1) !== now.streaming) streamed.push(now.streaming);
      const replies = (await messagesOf(chat)).filter((message) => message.role === "assistant").length;
      if (!now.isRunning && replies > before) break;
      if (Date.now() > deadline) throw new Error(`timed out: a reply to "${text.slice(0, 40)}"`);
      await sleep(100);
    }
    return { reply: await lastReply(chat), streamed, chat: await getChat(chat) };
  }

  /** The fake agent's log, as JSON lines. */
  const fakeLog = (dir: string): Array<Record<string, any>> => {
    const file = join(dir, "log.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  const alive = (pid: number) => {
    if (process.platform === "win32") return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true }).stdout.includes(` ${pid} `);
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  let browser: Awaited<ReturnType<typeof openChat>> | null = null;
  const openBrowser = async () => (browser = await openChat(BASE, KEY));
  /** Settings, photographed alone (the page, not the screen), with any email masked. */
  const shot = async (name: string, selector = 'section[aria-label="Engines"]') => {
    if (!browser) return;
    await browser.evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.replace(${EMAIL}, "owner@example.com"); document.querySelector(${JSON.stringify(selector)})?.scrollIntoView(); return true; })()`);
    const image = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(options.outDir, name), Buffer.from(image.data, "base64"));
  };
  const settingsText = async () => {
    if (!browser) return "";
    await browser.send("Page.navigate", { url: `${BASE}/settings` });
    await until(() => browser!.evaluate(`Boolean(document.querySelector('section[aria-label="Engines"]'))`), "Settings' Engines section", 30);
    return await browser.evaluate(`document.querySelector('section[aria-label="Engines"]').innerText`) as string;
  };

  /** Stop everything, delete the temp home, and write result.json. */
  async function finish(extra: Record<string, unknown> = {}) {
    browser?.close();
    for (const child of children.reverse()) stop(child);
    await sleep(3_000);
    notes.runnerLog = logs.runner.split("\n").filter(Boolean).slice(-50);
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
    notes.tempHomeRemoved = !existsSync(home);
    const result = { ranAt: new Date().toISOString(), ...extra, checks, notes, passed: Object.values(checks).every(Boolean) };
    writeFileSync(join(options.outDir, "result.json"), `${JSON.stringify(result, null, 2).replace(EMAIL, "owner@example.com")}\n`);
    console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
    return result.passed;
  }

  return {
    BASE, KEY, home, checks, notes, logs, check, start, stop, call, until, sql, rows, turnsOf, getChat, messagesOf, lastReply, runsOf,
    conversation, computers, exchange, fakeLog, alive, openBrowser, browser: () => browser, shot, settingsText, finish,
  };
}
