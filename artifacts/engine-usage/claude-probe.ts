import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { findClaude } from "../../runner/engines/claude";

// bun artifacts/engine-usage/claude-probe.ts
// Asks this machine's real Claude Code for its plan limits (the /usage data)
// without sending it a message, so nothing of the plan is spent.
const binary = findClaude();
if (!binary) throw new Error("Claude Code is not installed here.");
let close = () => {};
const idle: AsyncIterable<SDKUserMessage> = { async *[Symbol.asyncIterator]() { await new Promise<void>((done) => { close = done; }); } };
const q = query({
  prompt: idle,
  options: {
    ...(binary.sdkPath ? { pathToClaudeCodeExecutable: binary.sdkPath } : {}),
    tools: [], strictMcpConfig: true, mcpServers: {}, settingSources: [], persistSession: false,
  },
});
const started = Date.now();
try {
  const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  console.log(JSON.stringify({ ms: Date.now() - started, subscription: usage.subscription_type, available: usage.rate_limits_available, limits: usage.rate_limits }, null, 2));
} finally {
  close();
  q.close();
  process.exit(0);
}
