import assert from "node:assert/strict";
import { join } from "node:path";
import { perry } from "../engine-acp/harness";

// Run after pnpm build. No runner, model or provider is started.
const app = await perry({ name: "security-deployment", outDir: join(import.meta.dirname, "deployment"),
  runnerEnv: () => ({}), engine: null });
let failure: string | undefined;
try {
  app.start("server");
  await app.until(async () => (await fetch(app.BASE + "/chat")).ok, "production dashboard", 45);
  const page = await fetch(app.BASE + "/chat");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-powered-by"), null);
  app.check("production dashboard security headers", true);

  const ticket = await app.call<string>("dashboard:generateUploadUrl", { key: app.KEY });
  const upload = await fetch(app.BASE + ticket, { method: "POST", headers: { "content-type": "text/html" }, body: "<script>throw Error('untrusted')</script>" });
  assert.equal(upload.status, 200);
  const stored = await upload.json() as { storageId: string };
  const media = await fetch(app.BASE + "/api/backend/storage/" + stored.storageId);
  assert.equal(media.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(media.headers.get("content-type"), "application/octet-stream");
  assert.match(media.headers.get("content-disposition") ?? "", /^attachment/);
  assert.match(media.headers.get("content-security-policy") ?? "", /sandbox/);
  app.check("compiled storage route forces active documents to download", true);
  await app.call("installation:setOnboarding", { state: "skipped" });
  await app.call("installation:setDefaultEngine", { engine: "codex" });
  await app.openBrowser();
  assert.equal(app.browser()!.errors.length, 0, JSON.stringify(app.browser()!.errors));
  app.check("production dashboard loads in isolated Chrome", true);
  const browser = app.browser()!;
  await assert.rejects(browser.evaluate("new Promise(() => {})", 50), /timed out/);
  const pending = browser.evaluate("new Promise(() => {})");
  const disconnected = assert.rejects(pending, /connection closed/);
  await browser.send("Browser.close").catch(() => {});
  await disconnected;
  app.check("Chrome deadlines and disconnect settle pending commands", true);
} catch (error) {
  failure = String(error);
  app.check("deployment acceptance", false, failure);
} finally {
  process.exitCode = await app.finish({ failure, scope: "Compiled Next server and isolated Chrome; synthetic account, no runner or model" }) ? 0 : 1;
}
