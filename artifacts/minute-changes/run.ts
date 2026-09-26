import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/minute-changes/run.ts <outDir>
// Three small things: the greeting says the owner's name rather than their
// Telegram @username; a new chat starts on the model and thinking level last
// picked; and the CLI's waits show an ora spinner. A fresh PERRY_HOME, the
// production build (`pnpm build` first) on a free port, a stand-in Telegram,
// headless Chrome, and the real runner only long enough to report its Codex
// models: no Codex turn runs. The temp folder is deleted at the end.
//
// Ways it could fail:
//   1. An install that stored the @username keeps greeting with it: the owner's
//      next message, which carries their name, must replace it.
//   2. The greeting still reads the @username: it must say the name.
//   3. A pick is not carried over: after sending with a model and a level
//      picked in the composer, a new chat, after a reload, must show both.
//   4. Carrying over overrides a pick: choosing the default level on a new
//      chat must show the default, not the remembered level.
//   5. The spinner breaks output without a terminal (service logs): the helper
//      must still print how a step ended, and ora must be what prints it.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/minute-changes/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "minute-changes-e2e-key";
const OWNER = 4242;
const home = mkdtempSync(join(tmpdir(), "perry-minute-changes-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

// --- A stand-in Telegram -------------------------------------------------------------

const telegram = { pending: [] as object[], nextUpdate: 1 };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  request.resume();
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 1, is_bot: true, username: "perry_e2e_bot" });
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    return reply({ message_id: 1 });
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string, from: { first_name?: string; last_name?: string }) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, username: "The_M1N9", ...from }, text },
});

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:minute-changes-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL") delete env[name];
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
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
const ownerName = async () => (await call<{ ownerName?: string }>("installation:status")).ownerName;

let server: ChildProcess | null = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);

  // 1: claimed from a message without a name, as an install that stored the @username did.
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code, {});
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  notes.nameAtClaim = await ownerName();
  // A command, so no Codex turn is queued.
  ownerSays("/model", { first_name: "Pranav", last_name: "B" });
  await until(async () => (await ownerName()) === "Pranav B", "the name to be refreshed", 30).catch(() => {});
  notes.nameAfterMessage = await ownerName();
  checks.usernameReplacedByName = notes.nameAtClaim === "The_M1N9" && notes.nameAfterMessage === "Pranav B";
  await call("dashboard:skipOnboarding", { key: KEY });

  // The runner reports its Codex models, then stops: nothing sent below reaches Codex.
  runner = start("runner");
  await until(async () => (await call<unknown[]>("models:list")).length > 1, "the runner's model list", 120);
  stop(runner);
  runner = null;
  const models = await call<Array<{ id: string; name: string; isDefault: boolean; efforts?: string[] }>>("models:list");
  const picked = models.find((model) => !model.isDefault && (model.efforts?.length ?? 0) > 1) ?? models[0];
  const level = picked.efforts!.find((effort) => effort !== "medium") ?? picked.efforts![0];
  notes.picked = { model: picked.id, level };

  // 2: the greeting, on a new chat.
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  const text = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`) as Promise<string>;
  const heading = () => evaluate(`[...document.querySelectorAll("h2")].map((el) => el.textContent).join(" | ")`) as Promise<string>;
  const newChat = async () => {
    await send("Page.navigate", { url: `${BASE}/chat` });
    await until(async () => (await text('[aria-label="Model"]')).trim().length > 0 && !(await text('[aria-label="Model"]')).includes("Loading"), "the composer's model", 30);
    await sleep(1_000);
  };
  /** Type into the composer and press Enter, as the owner would. */
  const enter = async (value: string) => {
    await evaluate(`(() => { const el = document.querySelector('textarea[aria-label^="Message"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await sleep(300);
    await evaluate(`document.querySelector('textarea[aria-label^="Message"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); true`);
    await sleep(800);
  };

  await newChat();
  notes.greeting = await heading();
  checks.greetsByName = /Pranav B/.test(String(notes.greeting)) && !/The_M1N9/.test(String(notes.greeting));
  await shot("greeting.png");

  // 3: pick in the composer, send, reload into a new chat.
  await enter(`/model ${picked.id}`);
  await enter(`/think ${level}`);
  notes.composerBeforeSend = { model: await text('[aria-label="Model"]'), thinking: await text('[aria-label="Thinking"]') };
  await enter("Remember what I picked.");
  let sentChat: { model?: string; effort?: string } = {};
  await until(async () => {
    const chats = await call<Array<{ id: string; title: string }>>("dashboard:listChats", { key: KEY });
    const chat = chats.find((item) => item.title.startsWith("Remember what I picked"));
    if (chat) sentChat = await call<{ model?: string; effort?: string }>("dashboard:getChat", { key: KEY, id: chat.id });
    return Boolean(chat);
  }, "the chat to be sent", 30);
  notes.sentChat = { model: sentChat.model, effort: sentChat.effort };
  const levelLabel = level === "xhigh" ? "Extra high" : `${level[0].toUpperCase()}${level.slice(1)}`;
  await newChat();
  notes.composerInNewChat = { model: await text('[aria-label="Model"]'), thinking: await text('[aria-label="Thinking"]') };
  await shot("new-chat-remembers.png");
  checks.sentWithPicks = sentChat.model === picked.id && sentChat.effort === level;
  checks.newChatRemembers = (await text('[aria-label="Model"]')).includes(picked.name) && (await text('[aria-label="Thinking"]')).includes(levelLabel);

  // 4: the default level, picked on purpose, is not overridden by the remembered one.
  await enter("/think default");
  notes.composerAfterDefault = await text('[aria-label="Thinking"]');
  checks.defaultPickHonoured = String(notes.composerAfterDefault).startsWith("Default");

  checks.noBrowserErrors = browser.errors.length === 0;
  if (browser.errors.length) notes.browserErrors = browser.errors;

  // 5: the CLI spinner without a terminal, as in the service's logs.
  const cli = spawn(process.execPath, ["-e", `import { spinner } from "./scripts/lib.ts";
const ok = await spinner("a step that works"); await new Promise((r) => setTimeout(r, 300)); ok.succeed("done");
const bad = await spinner("a step that fails"); await new Promise((r) => setTimeout(r, 300)); bad.fail("failed");`], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  cli.stdout.on("data", (chunk) => { output += chunk; });
  cli.stderr.on("data", (chunk) => { output += chunk; });
  await new Promise((done) => cli.on("close", done));
  writeFileSync(join(outDir, "spinner-without-terminal.txt"), output);
  notes.spinnerOutput = output;
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  checks.spinnerSettlesWithoutTerminal = plain.includes("  ✔ done") && plain.includes("  ✖ failed");
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  stub.close();
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), logs.server.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
