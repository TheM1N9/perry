import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeUserMd, EMPTY_ANSWERS } from "../../lib/persona";
import { openChat, sleep } from "../browser";

// bun artifacts/sidebar-name/run.ts <outDir>
// The sidebar calls the owner what they asked to be called on the welcome
// page. A fresh PERRY_HOME, the production build (`pnpm build` first) on a free
// port and a stand-in Telegram whose owner is @The_M1N9. No runner or Codex.
//
// Ways it could fail:
//   1. Before the welcome page, the Telegram name is not shown.
//   2. After it, the sidebar still shows the Telegram name, not the answer to
//      "What should I call you?" (with its initial in the avatar).
//   3. A change to USER.md's "Call them" line (the About you page, or Perry
//      keeping it current) does not reach the sidebar.
//   4. A USER.md rewritten without that line loses the name its "# About"
//      heading still gives; with neither, the Telegram name comes back.
//   5. Going through the welcome page again does not start from that name.
//   6. Any page throws: no uncaught errors in the browser.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/sidebar-name/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "sidebar-name-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-sidebar-name-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const pending: object[] = [];
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  request.resume().on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getUpdates") {
      if (pending.length) return reply(pending.splice(0));
      return void setTimeout(() => reply(pending.splice(0)), 1_000);
    }
    return reply(method === "sendMessage" ? { message_id: 1 } : true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:sidebar-name-e2e",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
};
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

async function call<T>(path: string, args: object = {}, admin = false): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/${admin ? "admin" : "call"}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { "x-perry-key": KEY } : {}) },
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

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing", {}, true);
  pending.push({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private" }, from: { id: 4242, is_bot: false, first_name: "Mani", username: "The_M1N9" }, text: code } });
  await until(async () => (await call<{ claimed: boolean }>("installation:status", {}, true)).claimed, "the owner to be claimed", 30);

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const footer = () => evaluate(`document.querySelector('[data-sidebar="footer"]')?.innerText ?? ""`) as Promise<string>;
  const shows = (name: string, what: string) => until(async () => (await footer()).split("\n").map((line) => line.trim()).includes(name), what, 20);
  await send("Page.navigate", { url: `${BASE}/memory` });

  // 1. Only Telegram knows a name yet.
  await shows("The_M1N9", "the Telegram name").then(() => { checks.telegramNameBefore = true; }, () => { checks.telegramNameBefore = false; });
  notes.before = await footer();

  // 2. The welcome page, as it saves: USER.md composed from the answers.
  const userMd = composeUserMd({ ...EMPTY_ANSWERS, call: "Mani", work: "Developer and content strategist" }, "Asia/Calcutta");
  await call("dashboard:finishOnboarding", { key: KEY, name: "Perry", personality: "", userMd });
  await shows("Mani", "the onboarding name").then(() => { checks.onboardingNameAfter = true; }, () => { checks.onboardingNameAfter = false; });
  const avatar = await evaluate(`document.querySelector('[data-sidebar="footer"] span.rounded-full[aria-hidden]')?.innerText?.trim() ?? ""`) as string;
  notes.after = { footer: await footer(), avatar };
  checks.avatarInitial = avatar === "M";
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "sidebar.png"), Buffer.from(shot.data, "base64")));

  // 3. A change to the line, as the About you page saves it.
  await call("dashboard:saveUserMd", { key: KEY, text: userMd.replace("**Call them:** Mani", "**Call them:** Manikanta") });
  await shows("Manikanta", "the edited name").then(() => { checks.editReachesSidebar = true; }, () => { checks.editReachesSidebar = false; });

  // 4. Rewritten without the line; then with no name at all.
  await call("dashboard:saveUserMd", { key: KEY, text: "# About Mani\n\nA developer who works at night.\n" });
  await shows("Mani", "the heading's name").then(() => { checks.headingFallback = true; }, () => { checks.headingFallback = false; });
  await call("dashboard:saveUserMd", { key: KEY, text: "# About the owner\n\nA developer who works at night.\n" });
  await shows("The_M1N9", "the Telegram name again").then(() => { checks.telegramFallback = true; }, () => { checks.telegramFallback = false; });

  // 5. The welcome page again starts from the current name.
  await call("dashboard:saveUserMd", { key: KEY, text: userMd });
  await send("Page.navigate", { url: `${BASE}/welcome` });
  await until(async () => Boolean(await evaluate(`[...document.querySelectorAll("button")].some((b) => /next|continue|get started|let's go/i.test(b.innerText))`)), "the welcome page", 20);
  // Step through until "What should I call you?" is on screen.
  for (let step = 0; step < 4 && !(await evaluate(`!!document.querySelector('input[autocomplete="given-name"]')`)); step++) {
    await evaluate(`[...document.querySelectorAll("button")].find((b) => /next|continue/i.test(b.innerText))?.click(); true`);
    await sleep(600);
  }
  const prefill = await evaluate(`document.querySelector('input[autocomplete="given-name"]')?.value ?? null`) as string | null;
  notes.welcomePrefill = prefill;
  checks.welcomeStartsFromName = prefill === "Mani";

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (server.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill("SIGTERM");
  stub.close();
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), log.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
