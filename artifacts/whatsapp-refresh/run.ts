import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/whatsapp-refresh/run.ts <outDir>
// Linking WhatsApp keeps a live QR or code on the dashboard, as WhatsApp Web
// does: WhatsApp changes the QR every 20 seconds and ends the connection after
// a few, and a code typed on the phone lives only as long as its connection.
// The stand-in WhatsApp (artifacts/whatsapp/fake-driver.mjs) plays those out;
// no runner or Codex. The linking window is shortened to 15 seconds.
//
// Ways it could fail:
//   1. A new QR does not reach the page: the one showing must change in place.
//   2. When WhatsApp ends the QRs, linking stalls: a new connection must start
//      within a few seconds, with no "Reconnecting" in between, and its QR show.
//   3. The code typed on the phone goes stale: the next connection's code must
//      replace it.
//   4. The restart WhatsApp asks for right after linking reads as a failure:
//      it must reconnect at once, with no "Reconnecting", and then be linked.
//   5. A real failure before any QR loses its backoff, or shows as linked: it
//      must say it is reconnecting, on the linking card, and wait before trying.
//   6. Codes are made for nobody forever: after the window, it must stop, say
//      the code ran out, make no more, and "Get a new code" must start again.
//   7. Any page throws: no uncaught errors in the browser.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/whatsapp-refresh/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "whatsapp-refresh-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-whatsapp-refresh-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const wa = { commands: [] as object[], connects: [] as number[], logouts: 0, codeRequested: 0 };
const control = createServer((request: IncomingMessage, response: ServerResponse) => {
  request.resume().on("end", () => {
    const done = (value: unknown = true) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    switch (request.url) {
      case "/next":
        if (wa.commands.length) return done(wa.commands.splice(0));
        return void setTimeout(() => done(wa.commands.splice(0)), 300);
      case "/connect": wa.connects.push(Date.now()); return done();
      case "/logout": wa.logouts += 1; return done();
      case "/code-requested": wa.codeRequested += 1; return done();
      default: return done();
    }
  });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const push = (...commands: object[]) => wa.commands.push(...commands);
const qr = (value: string) => push({ event: "connection.update", data: { qr: value } });
const close = (statusCode: number) => push({ event: "connection.update", data: { connection: "close", lastDisconnect: { error: { output: { statusCode } } } } });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  PERRY_WHATSAPP_DRIVER: join(REPO, "artifacts", "whatsapp", "fake-driver.mjs"),
  PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
  PERRY_WHATSAPP_LINK_MINUTES: "0.25",
};
delete env.TELEGRAM_BOT_TOKEN;
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 20) {
  for (let i = 0; i < seconds * 5; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}
type View = { status: string; qr?: string; code?: string; wanted: boolean; error?: string; number?: string };
const view = () => call<View>("whatsapp:status", { key: KEY });
const png = (value: string) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
/** Every status the dashboard could have shown while something happens. */
async function watching<T>(during: () => Promise<T>): Promise<{ result: T; seen: string[] }> {
  const seen = new Set<string>();
  let on = true;
  const sample = (async () => { while (on) { seen.add((await view().catch(() => ({ status: "?" }))).status); await sleep(100); } })();
  const result = await during();
  on = false;
  await sample;
  return { result, seen: [...seen] };
}

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shownQr = () => evaluate(`document.querySelector('img[alt="WhatsApp link QR code"]')?.getAttribute("src") ?? null`) as Promise<string | null>;
  const pageText = () => evaluate(`document.querySelector("main")?.innerText ?? ""`) as Promise<string>;
  await send("Page.navigate", { url: `${BASE}/settings?tab=whatsapp` });
  await until(async () => (await pageText()).includes("Link WhatsApp"), "the WhatsApp tab");

  // 1. A new QR, in place.
  await call("whatsapp:startLinking", { key: KEY, mode: "separate" });
  await until(() => wa.connects.length >= 1, "WhatsApp to start");
  qr("QR-A");
  await until(async () => (await shownQr()) === png("QR-A"), "the first QR on the page");
  qr("QR-B");
  await until(async () => (await shownQr()) === png("QR-B"), "the next QR on the page", 10).then(() => { checks.newQrShown = true; }, () => { checks.newQrShown = false; });
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "whatsapp-qr.png"), Buffer.from(shot.data, "base64")));

  // 2. WhatsApp ends the QRs: straight on to a new connection and its QR.
  const connectsBefore = wa.connects.length;
  const ended = Date.now();
  const refresh = await watching(async () => {
    close(408);
    await until(() => wa.connects.length > connectsBefore, "a new connection", 10);
    qr("QR-C");
    await until(async () => (await shownQr()) === png("QR-C"), "the new connection's QR on the page", 10);
  });
  notes.qrRefresh = { secondsToReconnect: (wa.connects[connectsBefore] - ended) / 1000, statusesSeen: refresh.seen };
  checks.qrRefreshesAtOnce = wa.connects[connectsBefore] - ended < 3_000 && !refresh.seen.includes("disconnected");

  // 4. Linked on the phone: the restart WhatsApp asks for, then linked.
  const beforeRestart = wa.connects.length;
  const restart = await watching(async () => {
    close(515);
    await until(() => wa.connects.length > beforeRestart, "the restart", 10);
    push({ user: { id: "15550001111:3@s.whatsapp.net" } }, { event: "connection.update", data: { connection: "open" } });
    await until(async () => (await view()).status === "connected", "the link to open", 10);
  });
  notes.restart = restart.seen;
  checks.restartAfterLinking = !restart.seen.includes("disconnected");
  await call("whatsapp:unlink", { key: KEY });
  await until(() => wa.logouts >= 1, "unlinking");

  // 3. A code typed on the phone, fresh on each connection.
  const codeConnects = wa.connects.length;
  await call("whatsapp:startLinking", { key: KEY, mode: "separate", phone: "+1 555 000 1111" });
  await until(() => wa.connects.length > codeConnects, "WhatsApp to start for a code");
  await sleep(500);
  qr("QR-D");
  await until(async () => Boolean((await view()).code), "the first code");
  const first = (await view()).code;
  await until(async () => (await pageText()).includes(first!), "the first code on the page");
  const beforeCode = wa.connects.length;
  close(408);
  await until(() => wa.connects.length > beforeCode, "a new connection for the code", 10);
  qr("QR-E");
  await until(async () => { const next = (await view()).code; return Boolean(next) && next !== first; }, "a new code", 10);
  const second = (await view()).code;
  await until(async () => (await pageText()).includes(second!), "the new code on the page", 10).catch(() => {});
  notes.codes = [first, second];
  checks.codeRefreshes = first !== second && (await pageText()).includes(second!) && !(await pageText()).includes(first!);
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "whatsapp-code.png"), Buffer.from(shot.data, "base64")));
  await call("whatsapp:unlink", { key: KEY });
  await until(() => wa.logouts >= 2, "unlinking the code");

  // 5. A real failure before any QR: backoff, said so, on the linking card.
  const beforeStart = wa.connects.length;
  await call("whatsapp:startLinking", { key: KEY, mode: "separate" });
  await until(() => wa.connects.length > beforeStart, "a connection");
  await sleep(500);
  const beforeFailure = wa.connects.length;
  const failedAt = Date.now();
  close(428);
  await until(async () => (await view()).status === "disconnected", "the failure to show", 10);
  const failed = await view();
  const card = await (async () => { await sleep(600); return await pageText(); })();
  await until(() => wa.connects.length > beforeFailure, "the retry", 30);
  notes.failure = { error: failed.error, secondsToRetry: (wa.connects[beforeFailure] - failedAt) / 1000 };
  checks.realFailureBacksOff = /Reconnecting/.test(failed.error ?? "") && wa.connects[beforeFailure] - failedAt >= 2_000 && card.includes("Waiting for the phone") && !card.includes("Unlink");
  await call("whatsapp:unlink", { key: KEY });
  await until(() => wa.logouts >= 3, "unlinking after the failure");

  // 6. Nobody links it within the window.
  const windowConnects = wa.connects.length;
  await call("whatsapp:startLinking", { key: KEY, mode: "separate" });
  await until(() => wa.connects.length > windowConnects, "linking to start for the window");
  await sleep(1_500);
  qr("QR-F");
  await until(async () => (await view()).status === "qr", "a QR");
  await sleep(16_000);
  const beforeExpiry = wa.connects.length;
  close(408);
  await until(async () => (await view()).status === "expired", "the code to run out", 10);
  await sleep(5_000);
  const expired = await view();
  await until(async () => (await pageText()).includes("The code ran out"), "the page to say the code ran out", 10).catch(() => {});
  const expiredText = await pageText();
  await send("Page.captureScreenshot", { format: "png" }).then((shot) => writeFileSync(join(outDir, "whatsapp-expired.png"), Buffer.from(shot.data, "base64")));
  checks.stopsAfterWindow = !expired.wanted && wa.connects.length === beforeExpiry && expiredText.includes("The code ran out") && expiredText.includes("Get a new code");
  await evaluate(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Get a new code").click(); true`);
  await until(() => wa.connects.length > beforeExpiry, "Get a new code to start again", 15).then(() => { checks.getNewCodeStartsAgain = true; }, () => { checks.getNewCodeStartsAgain = false; });

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (server.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill("SIGTERM");
  control.close();
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), log.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
