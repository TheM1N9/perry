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
 * PERRY_MCP_CHAT names the chat the session is for, as the runner may run
 * several chats' turns at once (runner/engine.ts toolsOfChat).
 *
 * The endpoint serves a runner only while it has a turn running, as over HTTP.
 */


const url = process.env.PERRY_MCP_URL;
const token = process.env.PERRY_MCP_TOKEN;
const chat = process.env.PERRY_MCP_CHAT;
if (!url || !token) {
  console.error("mcp-bridge: PERRY_MCP_URL and PERRY_MCP_TOKEN must be set.");
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
        ...(chat ? { "x-perry-chat": chat } : {}),
        "x-perry-turn": process.env.PERRY_MCP_TURN ?? "",
        "x-perry-grant": process.env.PERRY_MCP_GRANT ?? "",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: line,
      signal: AbortSignal.timeout(11 * 60_000),
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
let parts: Buffer[] = [], size = 0, dropping = false;
process.stdin.on("data", (chunk: Buffer) => {
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
    const piece = chunk.subarray(start, end);
    size += piece.length;
    if (size > 2 * 1024 * 1024) { dropping = true; parts = []; }
    if (!dropping) parts.push(piece);
    start = newline < 0 ? chunk.length : newline + 1;
    if (newline < 0) continue;
    if (dropping) write(failure(null, -32600, "MCP request exceeds 2 MB."));
    else {
      const line = Buffer.concat(parts, size).toString("utf8");
      if (line.trim()) {
        let id: Message["id"];
        try { id = JSON.parse(line).id; } catch {}
        if (inFlight.size >= 8) write(failure(id, -32000, "Too many concurrent tool calls. Wait for a result."));
        else { const sent = relay(line).finally(() => inFlight.delete(sent)); inFlight.add(sent); }
      }
    }
    parts = []; size = 0; dropping = false;
  }
}).on("end", () => { void Promise.all(inFlight).then(() => process.exit(0)); });
