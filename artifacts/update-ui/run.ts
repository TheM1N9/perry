import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { perry } from "../engine-acp/harness";

const outDir = resolve(process.argv[2] ?? "node_modules/.cache/update-ui");
mkdirSync(outDir, { recursive: true });
const checks: Record<string, boolean> = {};
const check = (name: string, ok: boolean) => { checks[name] = ok; console.log(`${ok ? "ok" : "FAIL"} ${name}`); assert.ok(ok, name); };
const seed = { head: "a".repeat(40), behind: 1, latest: { sha: "b".repeat(40), title: "Verification update" } };
const failures: string[] = [];

for (const supervised of [false, true]) {
  const app = await perry({ name: `update-ui-${supervised ? "supervised" : "manual"}`, outDir, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex") }), env: { PERRY_SUPERVISOR: supervised ? String(process.pid) : "" } });
  const server = app.start("server");
  let browser: Awaited<ReturnType<typeof app.openBrowser>> | undefined;
  try {
    await app.until(() => fetch(`${app.BASE}/api/backend/http/health`).then(r => r.ok, () => false), "production server", 60);
    await app.call("dashboard:skipOnboarding", { key: app.KEY });
    await app.call("updates:setAuto", { key: app.KEY, on: false });
    await app.call("updates:saveCheck", seed);
    if (!supervised) {
      const error = await app.call("updates:update", { key: app.KEY }).then(() => "", e => String(e));
      check("manual server explains startup recovery", error.includes("perry start") && error.includes("perry update"));
    }
    browser = await app.openBrowser();
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `for (const method of ['getItem','setItem','removeItem']) Object.defineProperty(sessionStorage, method, { configurable: true, value() { throw new DOMException('Storage denied', 'SecurityError'); } });` });
    await browser.send("Page.navigate", { url: `${app.BASE}/settings/general` });
    await app.until(() => browser!.evaluate(`Boolean(document.querySelector('section [data-update-state]'))`), "update settings with denied storage", 30);
    check(`${supervised ? "supervised" : "manual"} storage denial keeps controls mounted`, browser.errors.length === 0);
    if (supervised) {
      await app.call("updates:saveCheck", seed);
      const downloadId = await app.call<string>("updates:beginDownload");
      await app.call("updates:finishDownload", { id: downloadId, ...seed });
      await app.until(() => browser!.evaluate(`document.querySelector('section [data-update-state]')?.getAttribute('data-update-state') === 'ready'`), "downloaded update", 30);
      await browser.evaluate(`(() => { const button = [...document.querySelectorAll('section button')].find(el => el.textContent?.includes('Reload to install')); if (!button) throw Error('Install control missing'); button.click(); return true; })()`);
      await app.until(async () => { const view = await app.call<{ state: string }>("updates:status", { key: app.KEY }); return ["waiting", "updating"].includes(view.state); }, "install request despite denied marker", 15);
      check("denied marker does not prevent durable install request", true);
      const request = app.rows("updates")[0];
      const pending = request.requested as { id: string } | undefined;
      await app.call("updates:finished", { result: { id: pending?.id ?? "verification-failure", by: "owner", at: Date.now(), ok: false, error: "Synthetic installation failed before any checkout change." } });
      await app.until(() => browser!.evaluate(`Boolean(document.querySelector('[data-last-update="failed"]'))`), "failure recovery", 15);
      check("failed update remains actionable without storage", await browser.evaluate(`document.body.innerText.includes("couldn’t be installed") || document.body.innerText.includes("couldn't be installed")`) as boolean);
    }
    check(`${supervised ? "supervised" : "manual"} no uncaught browser errors`, browser.errors.length === 0);
  } catch (error) { failures.push(String(error)); }
  finally {
    browser?.close();
    app.stop(server);
    try { rmSync(app.home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { failures.push(`Could not remove ${app.home}`); }
  }
}
const result = { checks, failures, passed: failures.length === 0 && Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
process.exitCode = result.passed ? 0 : 1;
