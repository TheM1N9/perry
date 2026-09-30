import { CodexAppServer } from "../../runner/codex";

// bun artifacts/engine-usage/codex-probe.ts
// Reads this machine's real Codex plan limits once (account/rateLimits/read),
// with no turn, and prints them. No usage is spent.
const app = await new CodexAppServer().start();
try {
  const read = await app.request("account/rateLimits/read", { excludeResetCreditDetails: true });
  console.log(JSON.stringify({ ...read, accountId: read?.accountId ? "(hidden)" : null }, null, 2));
} finally {
  app.close();
  process.exit(0);
}
