#!/usr/bin/env bun
/**
 * A stand-in ACP agent for Perry's end-to-end runs, built on the agent side
 * of @agentclientprotocol/sdk. It plays one of the real agents Perry drives
 * (--profile grok | cursor | antigravity): their CLI's status and sign-in
 * commands as far as Perry uses them, and their ACP server as their sources
 * and docs describe it: capabilities, auth methods, session config options,
 * modes, permission option ids, how they name tool calls, concurrent prompts,
 * session/load replay and session/resume, and their known faults (Cursor
 * ignoring session/new's MCP servers, Antigravity's hangs).
 *
 *   PERRY_GROK_COMMAND="bun artifacts/engine-acp/fake-agent.ts --profile grok"
 *
 * FAKE_ACP_HOME holds its state: whether it is signed in, its sessions (so a
 * new process can load them), and log.jsonl, every call it got and what it
 * decided, which the runs check. Nothing real is run: a command it is allowed
 * to run is only reported as run.
 *
 * What a message makes it do (the last text block of the prompt):
 *   REMEMBER <text>  call Perry's `remember` tool through the MCP server it was given
 *   RUN <command>    an execute tool call, which asks permission unless always-approve
 *   SLOW             a long reply, 30 chunks 400 ms apart, that stops on session/cancel
 *   HANG             one chunk, then nothing, and session/cancel is ignored
 *   RECALL           the messages this session has had before, to show it was resumed
 *   /compact, /compress   the agent's compaction command
 *   anything else    a reply streamed in chunks, after a thought and a plan
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError, type AgentContext, type ContentBlock, type McpServer, type PermissionOption, type SessionConfigOption, type SessionUpdate } from "@agentclientprotocol/sdk";

type Profile = "grok" | "cursor" | "antigravity";
const argv = process.argv.slice(2);
const profileAt = argv.indexOf("--profile");
const profile = (profileAt >= 0 ? argv.splice(profileAt, 2)[1] : "grok") as Profile;
const HOME = process.env.FAKE_ACP_HOME ?? join(tmpdir(), "fake-acp");
mkdirSync(join(HOME, "sessions"), { recursive: true });
const SIGNED_IN = join(HOME, `${profile}-signed-in`);
const signedIn = () => existsSync(SIGNED_IN);
const log = (entry: Record<string, unknown>) => appendFileSync(join(HOME, "log.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, profile, ...entry })}\n`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// --- The CLI, as far as Perry uses it -----------------------------------------------------------

const MODELS: Record<Profile, string[]> = {
  grok: ["grok-fake-fast", "grok-fake-heavy"],
  cursor: ["cursor-fake-auto", "cursor-fake-sonnet"],
  antigravity: ["gemini-fake-pro", "gemini-fake-flash"],
};
const EFFORTS = ["low", "medium", "high"];

async function cli(): Promise<boolean> {
  const words = argv.filter((word) => !word.startsWith("--permission-mode") && word !== "default");
  if (words[0] === "--version" || words[0] === "version") {
    log({ cli: "version" });
    console.log(profile === "grok" ? "grok 1.0.42-fake (0000000) [stable]" : "2026.09.18-fake");
    return true;
  }
  if (profile === "grok" && words[0] === "models") {
    const started = Date.now();
    await sleep(300);
    console.log(signedIn() ? "You are logged in with grok.com." : "You are not authenticated.");
    console.log(`\nDefault model: ${MODELS.grok[0]}\n\nAvailable models:`);
    MODELS.grok.forEach((model, index) => console.log(index === 0 ? `  * ${model} (default)` : `  - ${model}`));
    log({ cli: "models", started, ended: Date.now() });
    return true;
  }
  if (words[0] === "login") {
    log({ cli: "login", args: words, referrer: process.env.GROK_OAUTH2_REFERRER });
    if (profile === "grok" && words.includes("--device-auth")) {
      console.error("To sign in, open this URL in your browser:\n  https://accounts.x.ai/device?fake=1\nConfirm this code in your browser:\n  FAKE-1234\nOnly continue with a code you requested. Don't share it with anyone.\nWaiting for authorization...");
    }
    await sleep(Number(process.env.FAKE_ACP_LOGIN_MS) || 3000);
    writeFileSync(SIGNED_IN, "yes");
    console.error("✓ Signed in as owner@example.com");
    return true;
  }
  if (words[0] === "logout") {
    log({ cli: "logout" });
    rmSync(SIGNED_IN, { force: true });
    console.error("Logged out");
    return true;
  }
  return false;
}

// --- The ACP server -------------------------------------------------------------------------------

type Message = { role: "user" | "agent"; text: string };
type Saved = { id: string; cwd: string; model: string; effort: string; mode?: string; messages: Message[]; mcpServers: McpServer[] };
type Live = Saved & { queue: Promise<unknown>; running?: AbortController };
const sessions = new Map<string, Live>();
const sessionFile = (id: string) => join(HOME, "sessions", `${id}.json`);
const save = (session: Live) => {
  const { queue: _queue, running: _running, ...saved } = session;
  writeFileSync(sessionFile(session.id), JSON.stringify(saved));
};
const restore = (id: string): Live | undefined => {
  if (sessions.has(id)) return sessions.get(id);
  if (!existsSync(sessionFile(id))) return undefined;
  const session: Live = { ...JSON.parse(readFileSync(sessionFile(id), "utf8")) as Saved, queue: Promise.resolve() };
  sessions.set(id, session);
  return session;
};
let authenticated = false;
/** Grok's --always-approve, or a session's yoloMode: it never asks. */
const alwaysApprove = argv.includes("--always-approve") || argv.includes("--yolo");

function config(session: Saved): SessionConfigOption[] {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: MODELS[profile].map((value) => ({ value, name: value })) },
    { id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: session.effort, options: EFFORTS.map((value) => ({ value, name: value })) },
  ];
}

const PERMISSION_OPTIONS: Record<"execute" | "mcp", PermissionOption[]> = {
  execute: [
    { optionId: "always-allow", name: "Always allow", kind: "allow_always" },
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
  ],
  mcp: [
    { optionId: "always-allow", name: "Always allow", kind: "allow_always" },
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
};

/** Call Perry's `remember` through the MCP server this session was given: over HTTP, or by starting its stdio command. */
async function remember(session: Saved, text: string): Promise<string> {
  const server = session.mcpServers.find((item) => item.name === "assistant");
  if (!server) return "no Perry MCP server was given";
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `fake-${profile}`, version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: { text, kind: "daily" } } },
  ];
  if ("url" in server) {
    let answer = "";
    for (const message of messages) {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map((header) => [header.name, header.value])) },
        body: JSON.stringify(message),
      });
      answer = await response.text();
      if (!response.ok) return `http ${response.status}: ${answer.slice(0, 200)}`;
    }
    log({ mcp: "http", url: server.url, answer: answer.slice(0, 300) });
    return /isError"\s*:\s*true/.test(answer) ? `failed: ${answer.slice(0, 200)}` : "remembered over HTTP";
  }
  if (!("command" in server)) return "unsupported MCP server";
  const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map((item) => [item.name, item.value])) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  await new Promise((done) => child.on("close", done));
  log({ mcp: "stdio", command: server.command, args: server.args, answer: out.slice(0, 300) });
  return /isError"\s*:\s*true/.test(out) || !out.includes('"id":2') ? `failed: ${out.slice(0, 200)}` : "remembered over stdio";
}

async function turn(client: AgentContext, session: Live, prompt: ContentBlock[], signal: AbortSignal): Promise<{ stopReason: "end_turn" | "cancelled" }> {
  const texts = prompt.flatMap((block) => block.type === "text" ? [block.text] : []);
  const text = texts.at(-1)?.trim() ?? "";
  const update = (update: SessionUpdate) => client.notify("session/update", { sessionId: session.id, update });
  const say = (chunk: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  const earlier = session.messages.filter((message) => message.role === "user").map((message) => message.text);
  session.messages.push({ role: "user", text });
  log({ prompt: text, blocks: prompt.map((block) => block.type), preamble: texts.length > 1 ? texts[0] : undefined, images: prompt.filter((block) => block.type === "image").length, model: session.model, effort: session.effort, mode: session.mode });
  let reply = "";
  const stream = async (chunks: string[], gap: number) => {
    for (const chunk of chunks) {
      if (signal.aborted) return false;
      reply += chunk;
      await say(chunk);
      await sleep(gap);
    }
    return !signal.aborted;
  };
  const tool = async (id: string, fields: Record<string, unknown>, first = true) =>
    update({ sessionUpdate: first ? "tool_call" : "tool_call_update", toolCallId: id, ...fields } as SessionUpdate);
  const done = (stopReason: "end_turn" | "cancelled") => {
    session.messages.push({ role: "agent", text: reply });
    save(session);
    log({ finished: text.slice(0, 80), stopReason, reply: reply.slice(0, 300) });
    return { stopReason };
  };

  if (text === "/compact" || text === "/compress") {
    await stream(["Compacted ", "the conversation."], 50);
    return done("end_turn");
  }
  if (text.startsWith("HANG")) {
    await say("Working on it");
    log({ hanging: true });
    // Never answers, and a cancel does nothing: only ending the process stops it.
    await new Promise(() => {});
  }
  if (text.startsWith("SLOW")) {
    const finished = await stream(Array.from({ length: 30 }, (_, index) => `step ${index + 1}. `), 400);
    return done(finished ? "end_turn" : "cancelled");
  }
  if (text.startsWith("RECALL")) {
    await stream([`You said before: ${earlier.join(" | ") || "nothing"}.`], 10);
    return done("end_turn");
  }
  if (text.startsWith("REMEMBER ")) {
    const note = text.slice("REMEMBER ".length);
    const id = `mcp-${Date.now()}`;
    await tool(id, { title: "remember", kind: "other", status: "pending", rawInput: { text: note } });
    await tool(id, { title: "assistant__remember", kind: "other", status: "pending", rawInput: { text: note } }, false);
    if (!alwaysApprove) {
      const asked = await client.request("session/request_permission", {
        sessionId: session.id, toolCall: { toolCallId: id, title: "assistant__remember", kind: "other", status: "pending", rawInput: { text: note } }, options: PERMISSION_OPTIONS.mcp,
      });
      log({ permission: "mcp", outcome: asked.outcome });
      if (asked.outcome.outcome !== "selected" || !asked.outcome.optionId.startsWith("allow")) {
        await tool(id, { status: "failed" }, false);
        await stream(["I was not allowed to use the remember tool."], 10);
        return done("end_turn");
      }
    }
    const result = await remember(session, note);
    await tool(id, { status: result.startsWith("remembered") ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: result } }] }, false);
    await stream([`Saved it: ${result}.`], 10);
    return done("end_turn");
  }
  if (text.startsWith("RUN ")) {
    const command = text.slice("RUN ".length);
    const id = `exec-${Date.now()}`;
    await tool(id, { title: "run_command", kind: "other", status: "pending", rawInput: { command } });
    await tool(id, { title: `Execute \`${command}\``, kind: "execute", status: "pending", rawInput: { variant: "Bash", command, description: "The owner asked for it" } }, false);
    let allowed = alwaysApprove;
    if (!alwaysApprove) {
      const asked = await client.request("session/request_permission", {
        sessionId: session.id,
        toolCall: { toolCallId: id, title: `Execute \`${command}\``, kind: "execute", status: "pending", rawInput: { variant: "Bash", command, description: "The owner asked for it" } },
        options: PERMISSION_OPTIONS.execute,
      });
      log({ permission: "execute", command, outcome: asked.outcome });
      if (asked.outcome.outcome === "cancelled") { await tool(id, { status: "failed" }, false); return done("cancelled"); }
      allowed = asked.outcome.optionId === "allow-once" || asked.outcome.optionId === "always-allow";
    }
    if (!allowed) {
      await tool(id, { status: "failed", content: [{ type: "content", content: { type: "text", text: "Rejected by the user." } }] }, false);
      await stream(["The command was declined, ", "so I did not run it."], 50);
      return done("end_turn");
    }
    await tool(id, { status: "completed", content: [{ type: "content", content: { type: "text", text: `(fake) ran: ${command}` } }] }, false);
    await stream([`I ran \`${command}\`. `, "It finished."], 50);
    return done("end_turn");
  }
  // An ordinary reply: a thought, a plan, then the answer in chunks.
  await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The owner wrote; answer briefly." } });
  await update({ sessionUpdate: "plan", entries: [{ content: "Answer the message", priority: "high", status: "in_progress" }] });
  const words = `Fake ${profile} reply to: ${text.slice(0, 120)}. One two three four five six seven eight nine ten.`.split(" ");
  const finished = await stream(words.map((word) => `${word} `), 120);
  await update({ sessionUpdate: "plan", entries: [{ content: "Answer the message", priority: "high", status: "completed" }] });
  return done(finished ? "end_turn" : "cancelled");
}

async function serve() {
  if (process.env.FAKE_ACP_START_DELAY_MS) await sleep(Number(process.env.FAKE_ACP_START_DELAY_MS));
  log({ acp: argv });
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const loose = <T>(params: unknown) => params as T;
  const needAuth = () => { if (!authenticated) throw new RequestError(-32000, "Authentication required"); };
  const connection = agent({ name: `fake-${profile}` })
    .onRequest("initialize", loose, ({ params }) => {
      log({ method: "initialize", params });
      const methods = signedIn() ? [{ id: "cached_token", name: "Cached login" }, { id: "grok.com", name: "Grok" }] : [{ id: "grok.com", name: "Grok" }];
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { resume: {}, list: {}, close: {} },
        },
        authMethods: methods,
        agentInfo: { name: `fake-${profile}`, version: "1.0.42-fake" },
        _meta: { defaultAuthMethodId: signedIn() ? "cached_token" : null },
      };
    })
    .onRequest("authenticate", loose<{ methodId: string }>, ({ params }) => {
      log({ method: "authenticate", methodId: params.methodId });
      if (params.methodId === "cached_token" && signedIn()) { authenticated = true; return {}; }
      throw new RequestError(-32000, `Authentication failed: ${params.methodId} is not available here`);
    })
    .onRequest("session/new", loose<{ cwd: string; mcpServers: McpServer[]; _meta?: Record<string, unknown> }>, ({ params }) => {
      log({ method: "session/new", cwd: params.cwd, mcpServers: params.mcpServers, meta: params._meta });
      needAuth();
      const session: Live = { id: `fake-${profile}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, cwd: params.cwd, model: MODELS[profile][0], effort: "medium", messages: [], mcpServers: params.mcpServers, queue: Promise.resolve() };
      sessions.set(session.id, session);
      save(session);
      return { sessionId: session.id, configOptions: config(session) };
    })
    .onRequest("session/resume", loose<{ sessionId: string; cwd: string; mcpServers?: McpServer[] }>, ({ params }) => {
      log({ method: "session/resume", sessionId: params.sessionId, mcpServers: params.mcpServers });
      needAuth();
      const session = restore(params.sessionId);
      if (!session) throw new RequestError(-32002, `Session not found: ${params.sessionId}`);
      if (params.mcpServers) session.mcpServers = params.mcpServers;
      return { configOptions: config(session) };
    })
    .onRequest("session/load", loose<{ sessionId: string; cwd: string; mcpServers: McpServer[] }>, async ({ params, client }) => {
      log({ method: "session/load", sessionId: params.sessionId });
      needAuth();
      const session = restore(params.sessionId);
      if (!session) throw new RequestError(-32002, `Session not found: ${params.sessionId}`);
      session.mcpServers = params.mcpServers;
      for (const message of session.messages) {
        await client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: message.text } }, _meta: { isReplay: true } });
      }
      // As some agents do, a little of the replay arrives after the answer; the client must not take it for the next reply.
      setTimeout(() => void client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE-REPLAY " } } }), 100);
      return { configOptions: config(session) };
    })
    .onRequest("session/set_config_option", loose<{ sessionId: string; configId: string; value: string }>, ({ params }) => {
      log({ method: "session/set_config_option", configId: params.configId, value: params.value });
      const session = restore(params.sessionId);
      if (!session) throw new RequestError(-32002, "Session not found");
      if (params.configId === "model") session.model = params.value;
      else if (params.configId === "reasoning_effort") session.effort = params.value;
      else throw new RequestError(-32602, `unknown config option: ${params.configId}`);
      save(session);
      return { configOptions: config(session) };
    })
    .onRequest("session/set_mode", loose<{ sessionId: string; modeId: string }>, ({ params }) => {
      log({ method: "session/set_mode", modeId: params.modeId });
      const session = restore(params.sessionId);
      if (session) { session.mode = params.modeId; save(session); }
      return {};
    })
    .onRequest("session/prompt", loose<{ sessionId: string; prompt: ContentBlock[] }>, async ({ params, client }) => {
      const session = restore(params.sessionId);
      if (!session) throw new RequestError(-32002, "Session not found");
      // Prompts to a busy session wait their turn, as Grok queues them.
      const queued = session.queue.then(async () => {
        const controller = new AbortController();
        session.running = controller;
        try { return await turn(client, session, params.prompt, controller.signal); }
        finally { if (session.running === controller) session.running = undefined; }
      });
      session.queue = queued.catch(() => {});
      const result = await queued;
      return { ...result, _meta: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cachedReadTokens: 1000, reasoningTokens: 20 } };
    })
    .onNotification("session/cancel", loose<{ sessionId: string }>, ({ params }) => {
      log({ method: "session/cancel", sessionId: params.sessionId });
      sessions.get(params.sessionId)?.running?.abort();
    })
    .connect(stream);
  process.stdin.on("end", () => { log({ stdinClosed: true }); setTimeout(() => process.exit(0), 50); });
  process.on("SIGTERM", () => { log({ sigterm: true }); process.exit(0); });
  await connection.closed;
}

if (!await cli()) {
  if (argv.includes("stdio") || argv.includes("acp") || profile === "antigravity") await serve();
  else { console.error(`fake-agent: unknown command ${argv.join(" ")}`); process.exit(2); }
}
