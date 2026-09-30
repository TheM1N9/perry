import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/textareas/run.ts <outDir>
// Text boxes grow with what is typed instead of being dragged to a size
// (components/ui/textarea.tsx). A fresh Perry from the production build
// (`pnpm build` first) on a free port with its own PERRY_HOME (PERRY_E2E_DIR,
// else the temp folder), no runner, and headless Chrome on the Memory page's
// "Teach Perry something" box and the other pages with text boxes.
//
// Ways it could fail, written down before the checks:
//   1. A text box can still be dragged to a size: a resize handle in its corner.
//   2. It does not grow: a second and third line scroll inside a two-line box.
//   3. It grows without end: a long text pushes the page down instead of
//      scrolling inside the box past a limit.
//   4. It does not shrink back when the text is cleared.
//   5. Where the browser has no `field-sizing` (older Firefox and Safari), it
//      stays one size: the fallback must set its height from the text.
//   6. Any page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/textareas/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "textareas-e2e-key";
const home = mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), "perry-textareas-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY") delete env[name];
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE)).status < 500) break; } catch {}
    await sleep(500);
  }
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  const open = async (path: string, selector: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(1500);
    await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => document.querySelector(${JSON.stringify(selector)}) ? resolve(true) : Date.now() - start > 30000 ? reject(new Error("no ${selector} on ${path}")) : setTimeout(tick, 200); tick(); })`);
    await sleep(500);
  };
  /** Put text in a box the way typing does, so React hears it. */
  const type = (selector: string, text: string) => evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)});
    box.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const measure = (selector: string) => evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const box = document.querySelector(${JSON.stringify(selector)});
    const style = getComputedStyle(box);
    resolve({ height: box.getBoundingClientRect().height, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, resize: style.resize, maxHeight: style.maxHeight, window: innerHeight });
  })))`) as Promise<{ height: number; scrollHeight: number; clientHeight: number; resize: string; maxHeight: string; window: number }>;
  const shot = async (name: string) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
  };

  // The Memory page's box, as the owner types into it.
  const BOX = "#memory-text";
  await open("/memory", BOX);
  const empty = await measure(BOX);
  check("noResizeHandle", empty.resize === "none", { resize: empty.resize });

  await type(BOX, "I take my coffee black.");
  const one = await measure(BOX);
  await type(BOX, "I take my coffee black.\nNo sugar, ever.\nOat milk only when there is no other choice.\nAnd never after 4 pm.");
  const four = await measure(BOX);
  check("growsWithLines", four.height > one.height + 20 && four.scrollHeight <= four.clientHeight + 1, { one: one.height, four: four.height });
  await evaluate(`document.querySelector(${JSON.stringify(BOX)}).scrollIntoView({ block: "center" })`);
  await shot("memory-grown.png");

  await type(BOX, Array.from({ length: 80 }, (_, line) => `Line ${line + 1} of a very long note about the owner's mornings.`).join("\n"));
  const long = await measure(BOX);
  check("stopsAtLimitThenScrolls", long.height <= long.window * 0.6 + 1 && long.scrollHeight > long.clientHeight, { height: long.height, limit: long.window * 0.6, scrollHeight: long.scrollHeight });
  await evaluate(`document.querySelector(${JSON.stringify(BOX)}).scrollIntoView({ block: "center" })`);
  await shot("memory-long.png");

  await type(BOX, "");
  const cleared = await measure(BOX);
  check("shrinksWhenCleared", Math.abs(cleared.height - empty.height) <= 1, { empty: empty.height, cleared: cleared.height });

  // As a browser without field-sizing would size it: the native growing off, and CSS.supports saying no.
  await evaluate(`(() => { const supports = CSS.supports.bind(CSS); CSS.supports = (...args) => String(args[0]).includes("field-sizing") ? false : supports(...args); document.querySelector(${JSON.stringify(BOX)}).style.fieldSizing = "fixed"; })()`);
  await type(BOX, "x");
  const fallbackOne = await measure(BOX);
  await type(BOX, "One\nTwo\nThree\nFour\nFive\nSix");
  const fallbackSix = await measure(BOX);
  check("fallbackGrowsWithoutFieldSizing", fallbackSix.height > fallbackOne.height + 40 && fallbackSix.scrollHeight <= fallbackSix.clientHeight + 1, { one: fallbackOne.height, six: fallbackSix.height });
  await type(BOX, "");

  // Every text box on the pages that have them: none can be dragged to a size.
  const handles: Record<string, string[]> = {};
  for (const [path, selector] of [["/memory", "textarea"], ["/chat", "#composer"]] as const) {
    await open(path, selector);
    handles[path] = await evaluate(`[...document.querySelectorAll("textarea")].map((box) => getComputedStyle(box).resize)`) as string[];
  }
  check("noHandleAnywhere", Object.values(handles).every((list) => list.length > 0 && list.every((value) => value === "none")), handles);


  check("noPageErrors", browser.errors.length === 0, browser.errors.slice(0, 5));
} catch (error) {
  check("ran", false, String(error));
} finally {
  browser?.close();
  if (server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await sleep(500);
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

const passed = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
writeFileSync(join(outDir, "result.json"), JSON.stringify({ at: new Date().toISOString(), checks, notes, passed }, null, 2));
if (!passed) writeFileSync(join(outDir, "server.log"), log.slice(-20_000));
console.log(passed ? "passed" : `FAILED: ${Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`);
process.exit(passed ? 0 : 1);
