import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The headless Chrome the end-to-end checks drive, over the DevTools protocol.
 * Opens the dashboard at `base`, unlocks it with the dashboard key, and waits
 * for the chat to finish loading. Each Chrome has a DevTools port and a
 * profile of its own, so checks run side by side (another checkout's, or
 * another session's) never drive each other's pages. Closing it ends Chrome
 * and deletes its profile, which is 70 to 150 MB, so runs do not fill the disk.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait without an event loop, for cleanup that must finish before the process exits. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** End Chrome and every process it started, then delete its profile once nothing holds its files. */
function closeChrome(chrome: ChildProcess, profile: string) {
  if (chrome.pid && chrome.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome.kill("SIGKILL");
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      // Chrome's helpers can hold a file for a moment after it exits.
      pause(250);
    }
  }
  console.error(`Could not delete the Chrome profile at ${profile}.`);
}

type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: { message: string } };

/** A port nothing is listening on right now. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

export async function openChat(base: string, dashboardKey: string) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "perry-e2e-profile-"));
  const chrome = spawn(process.env.PERRY_E2E_BROWSER ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--window-size=1280,800", "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: "ignore" });
  let closed = false;
  let socket: WebSocket | undefined;
  const waiting = new Map<number, { settle: (message: CdpMessage) => void; fail: (error: Error) => void }>();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const pending of waiting.values()) pending.fail(new Error("Chrome connection closed."));
    waiting.clear();
    socket?.close();
    process.off("exit", close);
    closeChrome(chrome, profile);
  };
  // A check that throws or exits without closing still leaves no profile behind.
  process.once("exit", close);

  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
  for (let i = 0; i < 50 && !targets.some((target) => target.type === "page"); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json() as typeof targets; } catch {}
    await sleep(200);
  }
  const page = targets.find((target) => target.type === "page");
  if (!page) { close(); throw new Error("Chrome did not open a page."); }
  const ws = socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => { clearTimeout(timer); ws.removeEventListener("open", opened); ws.removeEventListener("error", failed); error ? reject(error) : resolve(); };
      const opened = () => done();
      const failed = () => done(new Error("Chrome connection failed."));
      const timer = setTimeout(() => done(new Error("Chrome connection timed out.")), 10_000);
      ws.addEventListener("open", opened, { once: true });
      ws.addEventListener("error", failed, { once: true });
    });
  } catch (error) { close(); throw error; }

  let nextId = 0;
  const errors: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)!.settle(message);
    }
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  ws.addEventListener("close", close, { once: true });
  const send = (method: string, params: object = {}, timeoutMs = 45_000): Promise<any> => new Promise((resolve, reject) => {
    if (closed || ws.readyState !== WebSocket.OPEN) { reject(new Error("Chrome connection closed.")); return; }
    const id = ++nextId;
    const finish = (error?: Error, result?: unknown) => { clearTimeout(timer); waiting.delete(id); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error(`${method} timed out.`)), timeoutMs);
    waiting.set(id, { settle: message => finish(message.error ? new Error(`${method}: ${message.error.message}`) : undefined, message.result), fail: error => finish(error) });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
  /** Run an expression in the page and return its (JSON) value. */
  const evaluate = async (expression: string, timeoutMs?: number): Promise<any> => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };

  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base });
    await sleep(1500);
    await evaluate(`localStorage.setItem("perry.dashboard.key", ${JSON.stringify(dashboardKey)}); localStorage.removeItem("perry.activeChat"); true`);
    await send("Page.navigate", { url: `${base}/chat` });
    await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => document.querySelector('input[type=file]') ? resolve(true) : Date.now() - start > 30000 ? reject(new Error('composer never rendered')) : setTimeout(tick, 200); tick(); })`);
    // The first visit compiles the route in dev and may reload once.
    await sleep(4000);
    await evaluate(`new Promise((resolve) => { const tick = () => document.body.innerText.includes('Loading chats') ? setTimeout(tick, 200) : resolve(true); tick(); })`);

    return {
      evaluate,
      send,
      errors,
      /** Its DevTools port, for its list of pages. */
      port,
      close,
    };
  } catch (error) {
    let page = "Page unavailable";
    try { page = await evaluate(`JSON.stringify({ url: location.href, text: document.body.innerText.slice(0, 1500) })`, 2000).catch(() => "Page unavailable"); }
    finally { close(); }
    throw new Error(`${String(error)}; browser errors: ${JSON.stringify(errors)}; page: ${page}`);
  }
}
