import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Headless Chrome over the DevTools protocol, for the dashboard suite: a fresh
 * profile per run, any viewport, light or dark, and every uncaught error and
 * console error the pages raise.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string } };

export async function launch(port = 9334) {
  const profile = mkdtempSync(join(tmpdir(), "perry-dashboard-e2e-"));
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--window-size=1440,900", "--no-first-run", "--hide-scrollbars", "about:blank",
  ], { stdio: "ignore" });

  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
  for (let i = 0; i < 60 && !targets.some((target) => target.type === "page"); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as typeof targets; } catch {}
    await sleep(200);
  }
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error("Chrome did not open a page.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

  let nextId = 0;
  const waiting = new Map<number, (message: Message) => void>();
  const errors: string[] = [];
  /** Requests sent and not yet answered, to say what a stuck page is waiting on. */
  const inFlight = new Map<string, { url: string; body?: string; at: number; document: string }>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.method === "Network.requestWillBeSent") inFlight.set(message.params.requestId, { url: message.params.request.url, body: message.params.request.postData?.slice(0, 120), at: Date.now(), document: `${message.params.loaderId} ${message.params.documentURL}` });
    if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") inFlight.delete(message.params.requestId);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(`console.error: ${message.params.args.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(" ")}`);
    }
  });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  };
  /** Wait until an expression in the page is truthy. */
  const waitFor = async (expression: string, what: string, ms = 15_000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error(`timed out: ${what}`);
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");

  const page = {
    send, evaluate, waitFor, errors,
    pending: () => [...inFlight.values()].map((request) => ({ ...request, ms: Date.now() - request.at })),
    async viewport(width: number, height: number, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    },
    async scheme(value: "light" | "dark") {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }, { name: "prefers-reduced-motion", value: "reduce" }] });
    },
    async go(url: string) {
      await send("Page.navigate", { url });
      await waitFor(`document.readyState === "complete"`, `${url} to load`);
    },
    async shot(file: string) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    /** Type into the focused element as the keyboard would. */
    async type(text: string) { await send("Input.insertText", { text }); },
    async press(key: string, code = key, modifiers = 0) {
      const keyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
      // Enter only submits a form, or breaks a line, when the key carries its text.
      const text = key === "Enter" && !modifiers ? "\r" : undefined;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: keyCode });
    },
    /** Click the centre of the first element matching a selector, as a pointer would. */
    async click(selector: string) {
      const box = await evaluate<{ x: number; y: number } | null>(`(() => { const el = ${selector}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error(`nothing to click: ${selector}`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
    close() {
      ws.close();
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
      else chrome.kill();
      setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500);
    },
  };
  return page;
}

/** An element found by its accessible role and name, as a person would find it: `byRole("button", "Approve")`. */
export const byRole = (role: string, name: string | RegExp) => {
  const test = typeof name === "string" ? `(n) => n === ${JSON.stringify(name)}` : `(n) => ${name.toString()}.test(n)`;
  const implicit: Record<string, string> = {
    button: "button, [role=button]", link: "a[href], [role=link]", heading: "h1, h2, h3, h4, [role=heading]",
    tab: "[role=tab]", menuitem: "[role=menuitem], [role=menuitemradio]", option: "[role=option]", textbox: "textarea, input, [role=textbox]",
    combobox: "[role=combobox]", radio: "[role=radio]", switch: "[role=switch]", dialog: "[role=dialog], [role=alertdialog]", article: "article",
  };
  return `[...document.querySelectorAll(${JSON.stringify(implicit[role] ?? `[role=${role}]`)})].find((el) => { const r = el.getBoundingClientRect(); const n = (el.getAttribute("aria-label") || el.innerText || el.value || "").trim(); return r.width > 0 && r.height > 0 && (${test})(n); })`;
};
