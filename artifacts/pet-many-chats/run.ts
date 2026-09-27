import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/pet-many-chats/run.ts <outDir>
// The desktop pet with several chats answering at once. A fresh Perry
// (production build, `pnpm build` first), the pet's page (/pet) in headless
// Chrome, and a runner played by its calls (check-in, claim, finish), so
// replies land exactly when the test says: nothing reaches the owner's desktop.
//
// Ways it could fail, written down before the checks:
//   1. Two chats answered together: only one is announced, the other never.
//   2. A second announcement within the first's few seconds replaces it,
//      and the first is never said again.
//   3. His own chat's reply, held up for you, is dropped when you open
//      another chat from a bubble, though you never read it.
//   4. That held reply loses its words once his chat is another one.
//   5. The page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-many-chats/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pet-many-chats-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-pet-many-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
let serverLog = "";
const server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { serverLog += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk; });
const stop = (child: ChildProcess) => { if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  const runnerJson = join(home, "runner.json");
  await until(() => existsSync(runnerJson), "the server to connect this computer", 30);
  const token = (JSON.parse(readFileSync(runnerJson, "utf8")) as { token: string }).token;
  const online = async () => {
    await call("runner:checkIn", { token, platform: "win32", hostname: "E2E", workdir: home });
    await call("codex:reportAccount", { token, available: true, authMode: "chatgpt", planType: "plus" });
  };
  await online();
  const heartbeat = setInterval(() => void online().catch(() => {}), 20_000);

  /** Send in a chat and have the runner take the turn, leaving it running until `finish`. */
  const ask = async (chat: string, text: string) => {
    await call("dashboard:sendChat", { key: KEY, id: chat, text });
    let turn: { _id: string } | undefined;
    await until(async () => { turn = (await call<Array<{ _id: string; conversationId: string }>>("codex:queuedTurns", { token })).find((item) => item.conversationId === chat); return Boolean(turn); }, "the turn to queue", 30);
    await call("codex:claimTurn", { token, id: turn!._id });
    return (response: string) => call("codex:finishTurn", { token, id: turn!._id, response });
  };

  const alpha = await call<string>("dashboard:createChat", { key: KEY });
  const beta = await call<string>("dashboard:createChat", { key: KEY });
  const own = await call<string>("dashboard:createChat", { key: KEY });

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(own)}); true`);
  await send("Page.navigate", { url: `${BASE}/pet` });
  await until(() => evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`), "the pet's page", 30);
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  const bubble = () => evaluate(`(() => {
    const bubble = document.querySelector('main [role="status"]');
    return bubble ? [...bubble.querySelectorAll("p")].map((p) => p.textContent.trim()) : [];
  })()`) as Promise<string[]>;
  const seen: string[][] = [];
  const watchFor = async (test: (lines: string[]) => boolean, seconds: number) => {
    for (let i = 0; i < seconds * 4; i++) {
      const lines = await bubble().catch(() => []);
      if (lines.length && JSON.stringify(seen.at(-1)) !== JSON.stringify(lines)) seen.push(lines);
      if (test(lines)) return lines;
      await sleep(250);
    }
    return null;
  };
  await sleep(2_000);

  // --- 1–2. Two chats answered together ---------------------------------------------------
  const finishAlpha = await ask(alpha, "alpha: what is on today");
  const finishBeta = await ask(beta, "beta: any news");
  await Promise.all([finishAlpha("Alpha's answer."), finishBeta("Beta's answer.")]);
  const together = await watchFor((lines) => /New in 2 chats/.test(lines[0] ?? ""), 12);
  if (together) await shot("two-chats.png");
  check("bothAnnounced", Boolean(together && /alpha/.test(together[1] ?? "") && /beta/.test(together[1] ?? "")), together ?? seen.slice(-4));
  // Apart but within the first's few seconds: said together too.
  await watchFor((lines) => lines.length === 0, 12);
  const finishAlpha2 = await ask(alpha, "alpha: and tomorrow");
  const finishBeta2 = await ask(beta, "beta: anything else");
  await finishAlpha2("Alpha again.");
  await watchFor((lines) => /New in alpha/.test(lines[0] ?? ""), 8);
  await sleep(1_500);
  await finishBeta2("Beta again.");
  const merged = await watchFor((lines) => /New in 2 chats/.test(lines[0] ?? ""), 8);
  check("apartButCloseSaidTogether", Boolean(merged), merged ?? seen.slice(-4));

  // --- 3–4. His own chat's reply survives opening another chat --------------------------------
  await watchFor((lines) => lines.length === 0, 12);
  const finishOwn = await ask(own, "own: remind me what I asked");
  await finishOwn("Here is your own chat's reply, held for you.");
  const held = await watchFor((lines) => lines[0] === "Perry" && /own chat's reply/.test(lines[1] ?? ""), 10);
  check("ownReplyHeld", Boolean(held), held ?? seen.slice(-3));
  const finishAlpha3 = await ask(alpha, "alpha: one more");
  await finishAlpha3("Alpha a third time.");
  await watchFor((lines) => /New in alpha/.test(lines[0] ?? ""), 8);
  // Open alpha from its bubble, then close the panel.
  await evaluate(`document.querySelector('main [role="status"]').click(); true`);
  await until(() => evaluate(`!document.querySelector('main [role="status"]') || !/New in/.test(document.querySelector('main [role="status"] p')?.textContent ?? "")`), "the panel to open", 5).catch(() => {});
  await sleep(1_000);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  const still = await watchFor((lines) => lines[0] === "Perry", 6);
  if (still) await shot("held-reply.png");
  check("ownReplySurvivesOtherChat", Boolean(still), still ?? seen.slice(-3));
  check("heldReplyKeepsWords", Boolean(still && /own chat's reply/.test(still[1] ?? "")), still);

  check("pageDidNotThrow", browser.errors.length === 0, browser.errors.slice(0, 5));
  clearInterval(heartbeat);
} catch (error) {
  notes.error = String(error);
} finally {
  browser?.close();
  stop(server);
  await sleep(1_500);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const passed = Object.keys(checks).length === 6 && Object.values(checks).every(Boolean);
const result = { ranAt: new Date().toISOString(), passed, checks, notes, serverLog: serverLog.split("\n").filter((line) => /error/i.test(line)).slice(-20) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed, checks, notes }, null, 2));
process.exit(passed ? 0 : 1);
