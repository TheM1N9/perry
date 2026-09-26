import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeUserMd, EMPTY_ANSWERS } from "../../lib/persona";
import { openChat, sleep } from "../browser";

// bun artifacts/about-you/run.ts <outDir>
// USER.md on the About you page reads as a document, and turns into its
// Markdown to edit. A fresh PERRY_HOME and the production build (`pnpm build`
// first) on a free port; no Telegram, runner or Codex.
//
// Ways it could fail:
//   1. It still shows raw Markdown: headings, bold and lists must render, with
//      no "**" or "##" left in the text.
//   2. There is no way in: Edit must open the editor holding the Markdown.
//   3. Esc keeps the change: it must close the editor and save nothing.
//   4. Ctrl+Enter does not save, or does not come back to the document: the
//      new section must render, and the sidebar take the new name.
//   5. A double click on the document does not open the editor.
//   6. History still shows raw Markdown.
//   7. An empty USER.md has no way to start: it must offer "Write it".
//   8. Any page throws: no uncaught errors in the browser.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/about-you/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "about-you-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-about-you-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
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
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
const saved = async () => (await call<{ user: string }>("dashboard:getPersona", { key: KEY })).user;

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const userMd = composeUserMd({ ...EMPTY_ANSWERS, call: "Mani", work: "Developer and content strategist", people: "mom, brother, girlfriend, friends", replies: "short" }, "Asia/Calcutta");
  await call("dashboard:finishOnboarding", { key: KEY, name: "Perry", personality: "", userMd });

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const has = (expression: string) => evaluate(`!!(${expression})`) as Promise<boolean>;
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  const doc = `document.querySelector('article[aria-label="USER.md"]')`;
  const editor = `document.querySelector("#user-md")`;
  const button = (label: string, within = "document") => `[...${within}.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
  const typeInto = (value: string) => evaluate(`(() => { const el = ${editor}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const key = (init: object) => evaluate(`${editor}.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ bubbles: true, ...init })})); true`);

  await send("Page.navigate", { url: `${BASE}/memory?tab=about` });
  await until(() => has(doc), "USER.md on the About you page");

  // 1. Rendered.
  const rendered = await evaluate(`(() => { const d = ${doc}; return { h1: d.querySelector("h1")?.innerText, h2: [...d.querySelectorAll("h2")].map((h) => h.innerText), strong: d.querySelector("strong")?.innerText, li: d.querySelectorAll("li").length, text: d.innerText }; })()`) as { h1?: string; h2: string[]; strong?: string; li: number; text: string };
  notes.rendered = { ...rendered, text: rendered.text.slice(0, 300) };
  checks.rendersMarkdown = rendered.h1 === "About Mani" && rendered.h2.includes("Work") && rendered.strong === "Call them:" && rendered.li >= 2 && !rendered.text.includes("**") && !rendered.text.includes("## ");
  await shot("about-you.png");

  // 2 and 3. Edit, change, Esc.
  await evaluate(`${button("Edit", doc)}.click(); true`);
  await until(() => has(editor), "the editor");
  checks.editOpensMarkdown = (await evaluate(`${editor}.value`)) === (await saved());
  await typeInto(`${userMd}\n## Scratch\n\nnot to keep\n`);
  await key({ key: "Escape" });
  await until(async () => !(await has(editor)) && await has(doc), "Esc to close the editor");
  checks.escapeDiscards = !(await saved()).includes("Scratch") && !(await evaluate(`${doc}.innerText`) as string).includes("Scratch");

  // 5 and 4. Double click in, then Ctrl+Enter.
  await evaluate(`${doc}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); true`);
  await until(() => has(editor), "a double click to open the editor");
  checks.doubleClickEdits = true;
  await typeInto(`${userMd.replace("**Call them:** Mani", "**Call them:** Manikanta")}\n## Hobbies\n\nSwimming, since this month.\n`);
  await key({ key: "Enter", ctrlKey: true });
  await until(async () => !(await has(editor)) && await has(doc) && (await saved()).includes("Swimming"), "Ctrl+Enter to save");
  await until(async () => ((await evaluate(`document.querySelector('[data-sidebar="footer"]')?.innerText ?? ""`)) as string).includes("Manikanta"), "the sidebar to take the name");
  const after = await evaluate(`[...${doc}.querySelectorAll("h2")].map((h) => h.innerText)`) as string[];
  checks.saveRendersAndRenames = after.includes("Hobbies");
  await shot("about-you-saved.png");

  // 6. History, rendered.
  await evaluate(`[...document.querySelectorAll("button")].find((b) => /^USER\\.md/.test(b.innerText.trim()))?.click(); true`);
  await until(() => has(`[...document.querySelectorAll("li h2")].some((h) => h.innerText === "Hobbies")`), "the newest version to open, rendered");
  const historyText = await evaluate(`[...document.querySelectorAll("li")].filter((li) => li.querySelector("h1")).map((li) => li.innerText).join("\\n")`) as string;
  checks.historyRendered = historyText.length > 0 && !historyText.includes("**") && !historyText.includes("## ");

  // 7. Empty.
  await call("dashboard:saveUserMd", { key: KEY, text: "" });
  await until(() => has(button("Write it")), "the empty state");
  await evaluate(`${button("Write it")}.click(); true`);
  await until(() => has(editor), "Write it to open the editor");
  checks.emptyOffersWriting = true;

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  browser?.close();
  if (server.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill("SIGTERM");
  await sleep(2_000);
  writeFileSync(join(outDir, "server.log"), log.replaceAll(KEY, "<key>"));
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
