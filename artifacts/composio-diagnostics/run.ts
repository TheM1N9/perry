// Failure inventory: docs/composio-diagnostics.md. Real action/runtime/SDK, local provider only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const output = resolve(process.argv[2] ?? "artifacts/composio-diagnostics/latest");
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "perry-diagnostics-"));
process.env.PERRY_HOME = home;
process.env.PERRY_CREDENTIAL_KEY = "11".repeat(32);
process.env.TELEMETRY_DISABLED = "true";
process.env.COMPOSIO_API_KEY = "fixture-only-key";
const secret = "synthetic-private-token-DO-NOT-RETURN";
let scenario = "configuration";
const paths: string[] = [];
const provider = createServer(async (req, res) => {
  for await (const _ of req) { /* drain request */ }
  const path = req.url?.split("?")[0] ?? ""; paths.push(path);
  res.setHeader("content-type", "application/json");
  if (path === "/api/v3.1/tool_router/session") return res.end(JSON.stringify({ session_id: "fixture-session", config: { user_id: "owner", execute: {}, search: {}, preload: { tools: [] } }, config_version: 1, mcp: { type: "http", url: "http://fixture.invalid/mcp" } }));
  if (path.endsWith("/execute")) {
    if (scenario === "success") return res.end(JSON.stringify({ data: { ok: "fixture" }, error: null, log_id: "fixture" }));
    if (scenario === "returned-error") return res.end(JSON.stringify({ data: {}, error: `OAuth token expired ${secret}`, log_id: "fixture" }));
    res.statusCode = scenario === "auth" ? 401 : scenario === "rate" ? 429 : 400;
    if (scenario === "rate") res.setHeader("retry-after", "0");
    return res.end(JSON.stringify({ error: { code: scenario === "configuration" || scenario === "invalid" ? 4300 : 1234, type: "ToolRouterV2_BadRequest", message: `${scenario === "configuration" ? "Multi-account selection is not enabled for this project" : "Fixture request refused"}. ${secret}`, account_id: "ca-private-fixture" } }));
  }
  res.statusCode = 404; res.end(JSON.stringify({ error: "Fixture has no standalone tool metadata" }));
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const address = provider.address();
if (!address || typeof address === "string") throw new Error("Fixture port missing");
const base = `http://127.0.0.1:${address.port}`;
process.env.COMPOSIO_BASE_URL = base;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(`${base}/`)) throw new Error("Non-fixture SDK request blocked");
  return realFetch(input, init);
};
const diagnostics: unknown[] = [];
const consoleError = console.error;
console.error = (...args) => { diagnostics.push(args); };
const checks: Array<{ name: string; passed: boolean }> = [];
let runtime: import("../../server/runtime").Runtime | undefined;
let db: DatabaseSync | undefined;
try {
  const { Runtime } = await import("../../server/runtime");
  const { default: schema } = await import("../../convex/schema");
  const composio = await import("../../convex/composio");
  const secrets = await import("../../convex/secrets");
  const { connectedDiagnostic } = await import("../../convex/lib/connected-error");
  db = new DatabaseSync(":memory:");
  runtime = new Runtime(db, schema as never, { composio, secrets }, { storageDir: join(home, "storage") });
  await runtime.stop();
  for (const [name, category] of [["configuration", "configuration"], ["invalid", "invalid_request"], ["auth", "auth_required"], ["rate", "rate_limited"], ["returned-error", "expired_auth"], ["success", null]] as const) {
    scenario = name;
    const result = (await runtime.call("composio:execute", { slug: "COMPOSIO_FIXTURE_GET", args: { private: secret } }, { internal: true })).value as any;
    assert.equal(result.ok, category === null, JSON.stringify(result));
    if (category) {
      assert.equal(result.diagnostic.category, category, JSON.stringify(result));
      assert.equal(result.diagnostic.stage, "execution");
      assert.equal(result.diagnostic.operation, "COMPOSIO_FIXTURE_GET");
      if (name === "configuration") {
        assert.equal(result.diagnostic.status, 400); assert.equal(result.diagnostic.code, 4300);
        assert.equal(result.diagnostic.type, "ToolRouterV2_BadRequest");
        assert.match(result.error, /not enabled/);
      }
      if (name === "invalid") assert.doesNotMatch(result.error, /Multi-account/);
      if (name === "auth") assert.match(result.error, /project key/);
    }
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes("ca-private-fixture"));
    checks.push({ name: `real action: ${name}`, passed: true });
  }
  const cyclic: Record<string, unknown> = { message: secret, code: secret, name: secret }; cyclic.cause = cyclic;
  const safe = connectedDiagnostic(cyclic, "execution", "FIXTURE_GET");
  assert.ok(!JSON.stringify(safe).includes(secret));
  checks.push({ name: "cyclic and unknown structural fields stay bounded and private", passed: true });
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
  assert.ok(paths.some((path) => path.endsWith("/execute")));
  checks.push({ name: "sanitized logs and real SDK fixture execution", passed: true });
} catch (error) {
  checks.push({ name: error instanceof Error ? error.message : String(error), passed: false });
} finally {
  console.error = consoleError;
  await runtime?.stop(); db?.close();
  globalThis.fetch = realFetch;
  await new Promise<void>((done) => provider.close(() => done()));
  rmSync(home, { recursive: true, force: true });
  writeFileSync(join(output, "result.json"), JSON.stringify({ at: new Date().toISOString(), passed: checks.every((c) => c.passed), checks, paths }, null, 2));
}
console.log(JSON.stringify(checks));
process.exit(checks.every((c) => c.passed) ? 0 : 1);
