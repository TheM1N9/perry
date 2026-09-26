import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/keys-logins/run.ts <outDir>
// Logins and secrets under Settings → Keys: the owner adds one there, or sends
// one in a chat and Perry moves it there, and Perry signs in to a website with
// it. A fresh PERRY_HOME, the production build (`pnpm build` first) on a free
// port, a stand-in shop with a sign-in form, headless Chrome for the Keys page,
// and the real runner and Codex (signed in with ChatGPT). PERRY_E2E_MODEL picks
// the model. The transcript is kept in result.json; the temp folder is deleted.
//
// Ways it could fail, checked without Codex:
//   1. The Keys page cannot add one: a login typed into the form must be listed
//      with its name, username and site.
//   2. A password reaches the browser: neither what the page is sent nor what
//      it shows may contain it once saved.
//   3. Saving again duplicates it: the same name and username must replace the
//      entry, with the new password.
// And with Codex:
//   4. A password sent in a chat stays in memory, or nowhere: Perry must save it
//      to Keys, with its username, and not to memory.
//   5. It stays in the chat: after the reply, the chat's messages, its title,
//      its runs' prompts and their traces must not contain it, nor the reply.
//   6. Perry cannot use a saved login: asked to sign in to the shop, the shop
//      must receive the saved username and the replaced password, and the reply
//      must carry what the shop shows only after signing in.
//   7. Using it leaks it: that run's trace must not contain the password, and
//      the entry must be marked used.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/keys-logins/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "keys-logins-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-keys-logins-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

// Random each run, so a match can only come from this run.
const secret = (prefix: string) => `${prefix}-${randomBytes(6).toString("hex")}`;
const OLD_PASSWORD = secret("Old");
const SHOP_PASSWORD = secret("Shop");
const GITHUB_PASSWORD = secret("Gh");
const SHOP_USER = "owner@example.com";
const ORDER = `#${1000 + (randomBytes(2).readUInt16BE() % 9000)}`;

// --- A stand-in shop with a sign-in form -------------------------------------------

const shop = { attempts: [] as Array<{ username: string; password: string; ok: boolean }> };
const form = (message = "") => `<!doctype html><title>Test Shop</title><h1>Sign in to Test Shop</h1>${message ? `<p>${message}</p>` : ""}
<form method="post" action="/login"><label>Email <input name="username" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`;
const shopServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const html = (status: number, text: string) => { response.writeHead(status, { "content-type": "text/html" }); response.end(text); };
    if (request.url?.startsWith("/login") && request.method === "POST") {
      const fields = new URLSearchParams(body.includes("=") && !body.trim().startsWith("{") ? body : "");
      const json = body.trim().startsWith("{") ? JSON.parse(body) as Record<string, string> : {};
      const username = fields.get("username") ?? json.username ?? "";
      const password = fields.get("password") ?? json.password ?? "";
      const ok = username === SHOP_USER && password === SHOP_PASSWORD;
      shop.attempts.push({ username, password, ok });
      return ok
        ? html(200, `<!doctype html><title>Your account</title><h1>Welcome back</h1><p>Your latest order is ${ORDER}, arriving Friday.</p>`)
        : html(401, form("Wrong email or password."));
    }
    return html(200, form());
  });
});
await new Promise<void>((done) => shopServer.listen(0, "127.0.0.1", done));
const SHOP = `http://127.0.0.1:${(shopServer.address() as { port: number }).port}`;

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
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

type Login = { id: string; label: string; url?: string; username?: string; by: string; lastUsedAt?: number };
type Run = { id: string; prompt: string; status: string; toolCalls?: string[] };
type Span = { name: string; input?: string; output?: string };
const vault = () => call<Login[]>("dashboard:getVault", { key: KEY });
const messages = async (id: string) => (await call<{ page: Array<{ role: string; text: string }> }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 50, cursor: null } })).page;
const runs = (id: string) => call<Run[]>("dashboard:listRuns", { key: KEY, conversationId: id });
const traces = async (id: string) => (await Promise.all((await runs(id)).map((run) => call<Span[]>("dashboard:runTrace", { key: KEY, runId: run.id })))).flat();
/** Everything Perry keeps about a chat, as one string to search for a password. */
async function keptAbout(id: string): Promise<string> {
  const chat = await call<{ title: string }>("dashboard:getChat", { key: KEY, id });
  const memories = await call<Array<{ text: string }>>("dashboard:listMemories", { key: KEY, query: "" });
  return JSON.stringify({ title: chat.title, messages: await messages(id), runs: await runs(id), spans: await traces(id), memories });
}
/** Say something in a web chat and wait for the whole reply. */
async function ask(id: string, text: string, access?: "supervised" | "full"): Promise<string> {
  await call("dashboard:sendChat", { key: KEY, id, text, ...(access ? { access } : {}) });
  await sleep(1_000);
  await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id })).isRunning, `the reply to "${text.slice(0, 40)}…"`, 420);
  return (await messages(id)).find((message) => message.role === "assistant")?.text ?? "";
}

let server: ChildProcess | null = start("server");
let runner: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);

  // --- 1 to 3: the Keys page ----------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })
    .then((image) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  const type = (selector: string, value: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const pageHas = (text: string) => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`) as Promise<boolean>;
  const openKeys = async () => {
    await send("Page.navigate", { url: `${BASE}/settings?tab=keys` });
    await until(() => pageHas("Logins and secrets"), "the Keys tab", 30);
    await sleep(1_000);
  };

  await openKeys();
  await shot("keys-empty.png");
  await type("#login-label", "Test Shop");
  await type("#login-url", `${SHOP}/login`);
  await type("#login-username", SHOP_USER);
  await type("#login-value", OLD_PASSWORD);
  await evaluate(`document.querySelector("#login-value").form.requestSubmit(); true`);
  await until(async () => (await vault()).some((login) => login.label === "Test Shop"), "the login to be saved", 20);
  await until(() => pageHas(SHOP_USER), "the login to be listed", 20);
  const added = (await vault()).find((login) => login.label === "Test Shop");
  checks.addedFromKeysPage = added?.username === SHOP_USER && added.url === `${SHOP}/login` && added.by === "owner";
  checks.passwordNeverSentToPage = !JSON.stringify(await vault()).includes(OLD_PASSWORD)
    && !(await evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(OLD_PASSWORD)})`));

  // The same name and username, from the page's own endpoint, replaces the password.
  await call("dashboard:saveToVault", { key: KEY, label: "test shop", username: SHOP_USER, url: `${SHOP}/login`, value: SHOP_PASSWORD });
  checks.sameNameReplaces = (await vault()).filter((login) => login.label.toLowerCase() === "test shop").length === 1;

  // --- 4 to 7: with Codex --------------------------------------------------------------
  runner = start("runner");
  await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
  await until(async () => (await call<unknown[]>("models:list")).length > 0, "the runner's model list", 60);
  const models = await call<Array<{ id: string; isDefault: boolean }>>("models:list");
  const model = process.env.PERRY_E2E_MODEL ?? (models.find((item) => item.isDefault) ?? models[0]).id;
  notes.model = model;

  // 4 and 5: a password sent in a chat moves to Keys.
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("conversations:setModel", { id: chat, model });
  const sharing = `My GitHub login is octo-owner and the password is ${GITHUB_PASSWORD}. Keep it for when you need to sign in there.`;
  const shared = await ask(chat, sharing);
  notes.sharedReply = shared;
  const github = (await vault()).find((login) => /github/i.test(login.label));
  notes.vaultAfterSharing = await vault();
  checks.movedToKeys = github?.username === "octo-owner" && github.by === "assistant";
  const kept = await keptAbout(chat);
  checks.goneFromChat = !kept.includes(GITHUB_PASSWORD) && !shared.includes(GITHUB_PASSWORD);
  checks.chatShowsWhereItWent = (await messages(chat)).some((message) => message.role === "user" && message.text.includes("[saved in Keys]"));
  notes.runsAfterSharing = (await runs(chat)).map((run) => ({ prompt: run.prompt, toolCalls: run.toolCalls }));

  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await until(() => pageHas("[saved in Keys]"), "the chat to show the moved password", 30).catch(() => {});
  await sleep(1_500);
  await shot("chat-moved.png");

  // 6 and 7: signing in with a saved login. Full access, so Codex may reach the shop.
  const shopAt = shop.attempts.length;
  const signIn = await ask(chat, `Sign in to Test Shop at ${SHOP}/login with my saved login, and tell me what my latest order number is.`, "full");
  notes.signInReply = signIn;
  notes.shopAttempts = shop.attempts.slice(shopAt).map((attempt) => ({ ...attempt, password: attempt.password === SHOP_PASSWORD ? "<the saved password>" : attempt.password ? "<another>" : "" }));
  const signInRun = (await runs(chat))[0];
  const signInTrace = await call<Span[]>("dashboard:runTrace", { key: KEY, runId: signInRun.id });
  notes.signInRun = signInRun;
  notes.signInTrace = signInTrace.map((span) => ({ name: span.name, input: span.input?.slice(0, 600), output: span.output?.slice(0, 600) }));
  const afterSignIn = await keptAbout(chat);
  checks.useLeavesNoTrace = !afterSignIn.includes(SHOP_PASSWORD) && !signIn.includes(SHOP_PASSWORD);
  // Codex's computer use gets its browser and its native helper from the Codex desktop app. Without
  // them nothing can sign in, and that is Codex's to fix, not this feature's: say so, not pass or fail.
  const noBrowser = signInTrace.some((span) => /native pipe is unavailable|Browser is not available/i.test(span.output ?? ""));
  if (noBrowser && shop.attempts.length === shopAt) {
    notes.skipped = "Codex computer use had no browser on this computer (the Codex desktop app provides it), so signing in (6) and marking the login used (7) were not checked.";
    checks.saysItCouldNotSignIn = !signIn.includes(ORDER) && /couldn.t|could not|can.t|cannot|unavailable|not available/i.test(signIn);
  } else {
    checks.signedInWithSavedLogin = shop.attempts.slice(shopAt).some((attempt) => attempt.ok);
    checks.replyHasWhatSigningInShows = signIn.includes(ORDER);
    checks.markedUsed = Boolean((await vault()).find((login) => login.label.toLowerCase() === "test shop")?.lastUsedAt);
  }

  await openKeys();
  await shot("keys-listed.png");
  checks.noBrowserErrors = browser.errors.length === 0;
  if (browser.errors.length) notes.browserErrors = browser.errors;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  stop(runner);
  stop(server);
  shopServer.close();
  await sleep(2_000);
  const redact = (text: string) => [OLD_PASSWORD, SHOP_PASSWORD, GITHUB_PASSWORD, KEY].reduce((out, value) => out.replaceAll(value, "<secret>"), text);
  writeFileSync(join(outDir, "server.log"), redact(logs.server));
  writeFileSync(join(outDir, "runner.log"), redact(logs.runner));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, ...(notes.skipped ? { skipped: notes.skipped } : {}), notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, skipped: notes.skipped, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
