#!/usr/bin/env bun
/**
 * Perry's tools over stdio, for engines that take MCP servers only as a
 * command to run (ACP agents often ignore HTTP ones). It relays JSON-RPC, one
 * message per line: each line from stdin is posted to Perry's MCP endpoint
 * (convex/mcp.ts) with the runner's token, and each answer is written to
 * stdout as a line. Notifications get no answer. Nothing but JSON-RPC goes to
 * stdout; problems go to stderr.
 *
 *   PERRY_MCP_URL=<server>/api/backend/http/mcp PERRY_MCP_TOKEN=<runner token> bun runner/mcp-bridge.ts
 *
 * The endpoint serves a runner only while it has a turn running, as over HTTP.
 *
 * Without PERRY_MCP_TOKEN the token is read from this computer's runner.json
 * (in PERRY_HOME), so a config file an agent reads the bridge from (Cursor's
 * .cursor/mcp.json) never holds it.
 */

import { createInterface } from "node:readline";
import { readRunnerConfig } from "./home";

const url = process.env.PERRY_MCP_URL;
const token = process.env.PERRY_MCP_TOKEN || readRunnerConfig().token;
if (!url || !token) {
  console.error("mcp-bridge: PERRY_MCP_URL must be set, and PERRY_MCP_TOKEN or a runner.json in PERRY_HOME.");
  process.exit(2);
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string };
const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const failure = (id: Message["id"], code: number, text: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message: text } });
/** The server's session, when it names one; stateless today, so usually none. */
let session: string | undefined;

async function relay(line: string) {
  let message: Message;
  try { message = JSON.parse(line); }
  catch { write(failure(null, -32700, "Parse error")); return; }
  const answers = message.id !== undefined && message.id !== null;
  try {
    const response = await fetch(url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: line,
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const body = await response.text();
    if (!answers) return;
    // A streamed answer comes as server-sent events, one JSON-RPC message per data line.
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const data of body.split("\n").filter((row) => row.startsWith("data:")).map((row) => row.slice(5).trim())) {
        if (data) write(JSON.parse(data));
      }
      return;
    }
    let parsed: { jsonrpc?: string; error?: unknown } | null = null;
    try { parsed = body ? JSON.parse(body) : null; } catch {}
    if (parsed?.jsonrpc) write(parsed);
    else write(failure(message.id, -32000, typeof parsed?.error === "string" ? parsed.error : `Perry's tools answered ${response.status}.`));
  } catch (error) {
    if (answers) write(failure(message.id, -32000, `Perry's tools are unreachable: ${error instanceof Error ? error.message : String(error)}`));
    else console.error(`mcp-bridge: ${String(error)}`);
  }
}

const inFlight = new Set<Promise<void>>();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    const sent = relay(line).finally(() => inFlight.delete(sent));
    inFlight.add(sent);
  })
  .on("close", () => { void Promise.all(inFlight).then(() => process.exit(0)); });
