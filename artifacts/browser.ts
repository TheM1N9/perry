import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The headless Chrome the end-to-end checks drive, over the DevTools protocol.
 * Opens the dashboard at `base`, unlocks it with the dashboard key, and waits
 * for the chat to finish loading.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: { message: string } };

export async function openChat(base: string, dashboardKey: string) {
  const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${join(tmpdir(), "perry-e2e-profile")}`,
    "--window-size=1280,800", "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: "ignore" });

  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
  for (let i = 0; i < 50 && !targets.some((target) => target.type === "page"); i++) {
    try { targets = await (await fetch("http://127.0.0.1:9333/json/list")).json() as typeof targets; } catch {}
    await sleep(200);
  }
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("Chrome did not open a page.");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

  let nextId = 0;
  const waiting = new Map<number, (message: CdpMessage) => void>();
  const errors: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)!(message);
      waiting.delete(message.id);
    }
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  /** Run an expression in the page and return its (JSON) value. */
  const evaluate = async (expression: string): Promise<any> => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };

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
    close: () => { ws.close(); chrome.kill(); },
  };
}
