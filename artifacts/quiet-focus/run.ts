import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/quiet-focus/run.ts <outDir>
// Clicking into a text field no longer lights up its border or rings it
// (Input, Textarea, InputGroup, TimePicker, the chat composer), while
// moving through the page with the keyboard still shows where focus is on
// buttons and links, and a field marked invalid still turns red. A fresh
// Perry from the production build (`pnpm build` first) on a free port with
// its own PERRY_HOME (PERRY_E2E_DIR, else the temp folder), no runner, and
// headless Chrome clicking with real (DevTools) mouse events.
//
// Ways it could fail, written down before the checks:
//   1. A field still changes its border colour when clicked into.
//   2. A field still draws a ring (box-shadow) when clicked into.
//   3. One kind of field was missed: a plain Input, a Textarea, a field
//      inside an InputGroup (search, to-do quick add), the time picker, or
//      the chat composer's shell.
//   4. Clicking did not actually focus the field, so the check proves nothing.
//   5. Keyboard focus on a button lost its ring along with the fields'.
//   6. A field marked invalid no longer shows it.
//   7. Any page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/quiet-focus/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "quiet-focus-e2e-key";
const work = process.env.PERRY_E2E_DIR ?? tmpdir();
mkdirSync(work, { recursive: true });
const home = mkdtempSync(join(work, "perry-quiet-focus-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
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

  const open = async (path: string, selector: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => document.querySelector(${JSON.stringify(selector)}) ? resolve(true) : Date.now() - start > 30000 ? reject(new Error("no ${selector.replace(/"/g, "'")} on ${path}")) : setTimeout(tick, 200); tick(); })`);
    await sleep(800);
  };
  /** The box the owner sees around a field: the field itself, or the nearest parent that draws a border. */
  const frameOf = `(field) => { let node = field; while (node && node !== document.body) { if (parseFloat(getComputedStyle(node).borderTopWidth) > 0) return node; node = node.parentElement; } return field; }`;
  const look = (selector: string) => evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    const frame = (${frameOf})(field);
    const style = getComputedStyle(frame);
    resolve({ border: style.borderTopColor, shadow: style.boxShadow, focused: document.activeElement === field, tag: frame.tagName + "." + (frame.getAttribute("data-slot") ?? "") });
  })))`) as Promise<{ border: string; shadow: string; focused: boolean; tag: string }>;
  /** A real mouse click in the middle of the field, as the owner's would be. */
  const click = async (selector: string) => {
    const { x, y } = await evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.x + Math.min(20, box.width / 2), y: box.y + box.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const quiet = async (name: string, path: string, selector: string, before?: () => Promise<void>) => {
    await open(path, selector);
    await before?.();
    await evaluate(`document.activeElement?.blur?.()`);
    const rest = await look(selector);
    await click(selector);
    await sleep(300);
    const clicked = await look(selector);
    check(name, clicked.focused && clicked.border === rest.border && clicked.shadow === rest.shadow, { rest, clicked });
  };

  await quiet("textareaQuiet", "/memory", "#memory-text");
  await quiet("inputGroupSearchQuiet", "/memory", "input[aria-label='Search memories']");
  await quiet("todoQuickAddQuiet", "/todos", "input[aria-label='Add a to-do']");
  await quiet("composerQuiet", "/chat", "#composer");
  await quiet("plainInputQuiet", "/settings/logins", "input[data-slot=input]");
  await quiet("timePickerQuiet", "/settings/notifications", "[data-slot=time-picker] input", async () => {
    // Quiet hours start off, which disables the times: turn them on first.
    await evaluate(`(() => { const toggle = [...document.querySelectorAll("[role=switch]")].find((item) => /quiet/i.test(item.closest("label,div")?.textContent ?? "")); if (toggle && toggle.getAttribute("aria-checked") !== "true") toggle.click(); })()`);
    await sleep(800);
  });
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "time-picker-clicked.png"), Buffer.from(data, "base64"));

  // The keyboard still shows where it is: Tab to a button and it carries a ring.
  await open("/settings/logins", "input[data-slot=input]");
  await evaluate(`document.activeElement?.blur?.()`);
  let ring: { tag: string; shadow: string; outline: string } | null = null;
  for (let i = 0; i < 40 && !ring; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const now = await evaluate(`(() => { const node = document.activeElement; if (!node || node.tagName !== "BUTTON" || !node.matches(":focus-visible")) return null; const style = getComputedStyle(node); return { tag: node.tagName + " " + (node.getAttribute("aria-label") ?? node.textContent.trim().slice(0, 30)), shadow: style.boxShadow, outline: style.outlineStyle }; })()`);
    if (now) ring = now;
  }
  check("keyboardFocusStillShowsOnButtons", Boolean(ring && (ring.shadow !== "none" || ring.outline !== "none")), ring);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "keyboard-focus.png"), Buffer.from(shot.data, "base64"));

  // A field marked invalid still says so.
  const invalid = await evaluate(`(() => { const field = document.querySelector("input[data-slot=input]"); const rest = getComputedStyle(field).borderTopColor; field.setAttribute("aria-invalid", "true"); const marked = getComputedStyle(field).borderTopColor; field.removeAttribute("aria-invalid"); return { rest, marked }; })()`);
  check("invalidStillMarked", invalid.rest !== invalid.marked, invalid);

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
