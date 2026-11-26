import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openChat, sleep } from "../browser.ts";

if (!process.argv[2]) throw new Error("Pass a disposable output directory");
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "perry-markdown-images-"));
const key = "synthetic-markdown-image-owner";
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "ad".repeat(32);
const report = { checks: {}, imageRequests: [], build: readFileSync(".next/BUILD_ID", "utf8").trim() };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
save();
let runtime, database, server, browser, images;
try {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNn8AAAAASUVORK5CYII=", "base64");
  const requested = new Set();
  images = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/image.png") { response.writeHead(404).end(); return; }
    const id = Number(url.searchParams.get("id"));
    requested.add(id);
    report.imageRequests.push(id);
    response.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store" });
    response.end(png);
  });
  await new Promise(resolve => images.listen(0, "127.0.0.1", resolve));
  const imageBase = `http://127.0.0.1:${images.address().port}`;
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts"),
  ]);
  database = new DatabaseSync(join(scratch, "perry.sqlite"));
  initializeCredentialEncryption(database, scratch);
  runtime = new Runtime(database, schema, modules, { storageDir: join(scratch, "storage") });
  await runtime.stop();
  const call = async (path, args) => (await runtime.call(path, args, { internal: true })).value;
  await runtime.exclusive(() => runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now() }));
  const thread = await call("agentStore:createThread", { userId: "synthetic-image-owner", title: "Image history" });
  const chat = await call("conversations:create", { channel: "web", externalId: "synthetic-image-history", threadId: thread, title: "Image history" });
  const padding = Array.from({ length: 16 }, (_, index) => `Historical context paragraph ${index + 1}. This text keeps distant images outside the native lazy-load margin.`).join("\n\n");
  const messages = Array.from({ length: 48 }, (_, index) => ({ role: "assistant", content: `${padding}\n\n![fixture-${index}](${imageBase}/image.png?id=${index})` }));
  const localPath = join(scratch, "registered-image.png");
  writeFileSync(localPath, png);
  await runtime.exclusive(() => runtime.store.insert("chatAttachments", {
    conversationId: chat, messageKey: "synthetic-image-path-registration", localPath,
    fileName: "registered-image.png", contentType: "image/png", size: png.length, createdAt: Date.now(),
  }));
  messages.push({ role: "assistant", content: `![registered-local](<${localPath.replaceAll("\\", "/")}>)` });
  const missingPath = join(scratch, "unregistered-image.png").replaceAll("\\", "/");
  messages.push({ role: "assistant", content: `![unregistered-local](<${missingPath}>)\n\n![unsafe-image](javascript:alert%281%29)\n\nLast fixture message.` });
  await call("agentStore:saveMessages", { threadId: thread, messages });
  await runtime.stop(); database.close(); runtime = null; database = null;

  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: resolve("."), env: { ...process.env, PERRY_PORT: String(port), TELEGRAM_BOT_TOKEN: "", COMPOSIO_API_KEY: "", GROQ_API_KEY: "", GEMINI_API_KEY: "", PERRY_WAKE_DISABLED: "1" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-16000); writeFileSync(join(output, "server.log"), log); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(base).then(response => response.ok, () => false)) break;
    if (server.exitCode !== null) throw new Error(`Fixture server exited: ${log}`);
    await sleep(100);
  }
  process.env.PERRY_E2E_BROWSER ??= process.platform === "linux" ? "/usr/bin/google-chrome" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await openChat(base, key);
  const until = async expression => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try { if (await browser.evaluate(`Boolean(${expression})`)) return; }
      catch (error) { if (!/navigated or closed|Execution context was destroyed|Cannot find context/.test(String(error))) throw error; }
      await sleep(50);
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  };
  await browser.send("Page.navigate", { url: `${base}/chat/${chat}` });
  await until("document.querySelectorAll('.prose-chat img[alt^=fixture-]').length === 48 && document.body.innerText.includes('Last fixture message.')");
  await sleep(1000);
  report.initialRequests = requested.size;
  report.checks.allHistoryImagesRendered = true;
  report.checks.historyImagesAreLazy = await browser.evaluate("Array.from(document.querySelectorAll('.prose-chat img[alt^=fixture-]')).every(image => image.loading === 'lazy')");
  report.checks.historyImagesDecodeAsync = await browser.evaluate("Array.from(document.querySelectorAll('.prose-chat img[alt^=fixture-]')).every(image => image.decoding === 'async')");
  report.checks.distantImageRequestsDeferred = requested.size < 48;
  report.checks.registeredLocalPathPreserved = await browser.evaluate(`(() => { const image = document.querySelector('img[alt=registered-local]'); return image?.getAttribute('src').startsWith('/api/media/') && image.title === ${JSON.stringify(localPath)}; })()`);
  report.checks.registeredLocalImageIsLazy = await browser.evaluate("document.querySelector('img[alt=registered-local]')?.loading === 'lazy' && document.querySelector('img[alt=registered-local]')?.decoding === 'async'");
  report.checks.unregisteredPathStaysInert = await browser.evaluate("!document.querySelector('img[alt=unregistered-local]') && Array.from(document.querySelectorAll('[data-file-path]')).some(path => path.textContent.includes('unregistered-local'))");
  report.checks.unsafeSchemeStaysInert = await browser.evaluate("!document.querySelector('img[alt=unsafe-image]') && !Array.from(document.images).some(image => image.getAttribute('src')?.toLowerCase().startsWith('javascript:'))");
  await browser.evaluate("document.querySelector('img[alt=registered-local]').scrollIntoView({block:'center',behavior:'instant'})");
  await until("document.querySelector('img[alt=registered-local]')?.complete && document.querySelector('img[alt=registered-local]').naturalWidth > 0");
  report.checks.registeredImageLoadsInView = true;
  const readerPoint = await browser.evaluate("(() => { const box = document.querySelector('#content').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()");
  await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...readerPoint, deltaX: 0, deltaY: -120 });
  await sleep(100);
  for (let index = 0; index < 48; index++) {
    await browser.evaluate(`document.querySelector('img[alt="fixture-${index}"]').scrollIntoView({block:'center',behavior:'instant'})`);
    await until(`document.querySelector('img[alt="fixture-${index}"]')?.complete && document.querySelector('img[alt="fixture-${index}"]').naturalWidth > 0`);
  }
  report.checks.everyImageLoadsAfterScroll = requested.size === 48;
  report.finalRequests = requested.size;
  report.errors = browser.errors;
  report.checks.noUncaughtBrowserErrors = browser.errors.length === 0;
  const screenshot = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, "historical-image.png"), Buffer.from(screenshot.data, "base64"));
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  browser?.close();
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { server.kill(); await new Promise(resolve => server.once("exit", resolve)); }
  }
  await runtime?.stop(); database?.close();
  if (images) { images.closeAllConnections(); await new Promise(resolve => images.close(resolve)); }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  report.scratchRemoved = !existsSync(scratch);
  report.passed = !report.error && report.scratchRemoved && Object.values(report.checks).every(Boolean);
  save();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, initialRequests: report.initialRequests, finalRequests: report.finalRequests, scratchRemoved: report.scratchRemoved, error: report.error }));
  if (!report.passed) process.exitCode = 1;
}
