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
 *   TOOL <name> <json>  call any of Perry's tools with those arguments, and log what it answered
 *   LONGER <minutes> <seconds>  call Perry's `take_longer` for that many minutes, then say
 *                    nothing for that many seconds, then reply
 *   QUIET <seconds>  say nothing for that many seconds, then reply
 *   RUN <command>    an execute tool call, which asks permission unless always-approve
 *   STEPS <json>     one of every kind of step: a command with growing output, a file edit,
 *                    a web search, Perry's browser, another Perry tool, a failed command (steps())
 *   SLOW             a long reply, 30 chunks 400 ms apart, that stops on session/cancel
 *   HANG             one chunk, then nothing, and session/cancel is ignored
 *   EARLY            an empty end_turn at once, then the reply as updates after it
 *   RECALL           the messages this session has had before, to show it was resumed
 *   REJECT ...       session/prompt fails at once, without taking the prompt in (it is logged as `rejected`)
 *   LIMIT            the prompt fails as Grok's does when the plan's limit is hit; so does every
 *                    prompt while FAKE_ACP_HOME has a file named <profile>-limited (a plan used up)
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

/** What each agent says about itself, as their sources and docs describe it. */
const PROFILES = {
  grok: {
    name: "fake-grok", resume: true, image: false, logout: false,
    methods: () => signedIn() ? [{ id: "cached_token", name: "Cached login" }, { id: "grok.com", name: "Grok" }] : [{ id: "grok.com", name: "Grok" }],
    modes: undefined,
    permissions: { execute: ["always-allow", "allow-once", "reject-once", "reject-always"], mcp: ["always-allow", "allow-once", "reject-once"] },
  },
  cursor: {
    name: "fake-cursor", resume: false, image: true, logout: false,
    methods: () => [{ id: "cursor_login", name: "Cursor login" }],
    modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }, { id: "ask", name: "Ask" }] },
    permissions: { execute: ["allow-always", "allow-once", "reject-once"], mcp: ["allow-always", "allow-once", "reject-once"] },
  },
  antigravity: {
    name: "antigravity-acp", resume: true, image: true, logout: true,
    methods: () => ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"].map((id) => ({ id, name: id })),
    modes: undefined,
    permissions: { execute: ["opt_always_7", "opt_once_3", "opt_reject_9"], mcp: ["opt_always_7", "opt_once_3", "opt_reject_9"] },
  },
}[profile];
const KINDS: Record<string, PermissionOption["kind"]> = { "always-allow": "allow_always", "allow-always": "allow_always", "allow-once": "allow_once", "reject-once": "reject_once", "reject-always": "reject_always", opt_always_7: "allow_always", opt_once_3: "allow_once", opt_reject_9: "reject_once" };
const permissionOptions = (kind: "execute" | "mcp"): PermissionOption[] => PROFILES.permissions[kind].map((optionId) => ({ optionId, name: optionId, kind: KINDS[optionId] }));
const allows = (optionId: string) => KINDS[optionId]?.startsWith("allow");
/** The key the fake Gemini API accepts. */
const GEMINI_KEY = "fake-gemini-key-0123";

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
    ...(profile === "antigravity" ? [{ id: "mode", name: "Mode", category: "mode", type: "select" as const, currentValue: session.mode ?? "default", options: ["default", "auto_edit", "yolo"].map((value) => ({ value, name: value })) }] : []),
    { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: MODELS[profile].map((value) => ({ value, name: value })) },
    { id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: session.effort, options: EFFORTS.map((value) => ({ value, name: value })) },
  ];
}

/** Call Perry's `remember` through the MCP server this session was given: over HTTP, or by starting its stdio command. */
async function remember(session: Saved, text: string): Promise<string> {
  const answer = await callTool(session, "remember", { text, kind: "daily" });
  return answer.startsWith("ok ") ? `remembered ${answer.slice(3)}` : answer;
}

/** One of Perry's tools, through the MCP server it was given: "ok over HTTP|stdio", or what went wrong. With `whole`, the log keeps all of its answer. */
async function callTool(session: Saved, name: string, args: Record<string, unknown>, whole = false): Promise<string> {
  const server = session.mcpServers.find((item) => item.name === "assistant");
  if (!server) return "no Perry MCP server was given";
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `fake-${profile}`, version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
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
    log({ mcp: "http", tool: name, url: server.url, answer: whole ? answer : answer.slice(0, 300), ...(whole ? { args } : {}) });
    return /isError"\s*:\s*true/.test(answer) ? `failed: ${answer.slice(0, 200)}` : "ok over HTTP";
  }
  if (!("command" in server)) return "unsupported MCP server";
  const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map((item) => [item.name, item.value])) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  await new Promise((done) => child.on("close", done));
  log({ mcp: "stdio", tool: name, command: server.command, args: server.args, answer: out.slice(0, 300) });
  return /isError"\s*:\s*true/.test(out) || !out.includes('"id":2') ? `failed: ${out.slice(0, 200)}` : "ok over stdio";
}

/** One of Perry's tools over the HTTP MCP server it was given, and the text it answered (what an agent shows as the tool's result). */
async function toolAnswer(session: Saved, name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const server = session.mcpServers.find((item) => item.name === "assistant");
  if (!server || !("url" in server)) return { text: "no Perry MCP server over HTTP was given", error: true };
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `fake-${profile}`, version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  let answer = "";
  for (const message of messages) {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map((header) => [header.name, header.value])) },
      body: JSON.stringify(message),
    });
    answer = await response.text();
    if (!response.ok) return { text: `http ${response.status}: ${answer.slice(0, 200)}`, error: true };
  }
  const body = answer.trim().startsWith("{") ? answer : answer.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}";
  const result = (JSON.parse(body) as { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } }).result;
  log({ mcp: "http", tool: name, answer: answer.slice(0, 300) });
  return { text: (result?.content ?? []).map((part) => part.text ?? `[${part.type}]`).join("\n"), error: Boolean(result?.isError) };
}

/**
 * STEPS <json>: one of every kind of step, a second or so apart, the way an
 * agent reports them over ACP: a command whose output grows while it runs
 * and is longer than the trace keeps when it ends, a file edit with its diff (the file is written
 * too), a web search with its results, Perry's browser on two pages, another
 * of Perry's tools, and a command that fails. `secret` (or FAKE_ACP_HOME/steps-secret) is put where a saved
 * login could leak: in a command, its output, and a page.
 */
async function steps(session: Saved, text: string, update: (update: SessionUpdate) => Promise<void>, say: (chunk: string) => Promise<void>, signal: AbortSignal) {
  const plan = JSON.parse(text.slice("STEPS ".length)) as { dir: string; page: string; secretPage: string; secret?: string; gap?: number };
  // The saved login is read from FAKE_ACP_HOME, so the owner's message does not carry it.
  plan.secret ??= readFileSync(join(HOME, "steps-secret"), "utf8").trim();
  const gap = plan.gap ?? 1500;
  const tool = (id: string, fields: Record<string, unknown>, first = false) => update({ sessionUpdate: first ? "tool_call" : "tool_call_update", toolCallId: id, ...fields } as SessionUpdate);
  const words = (value: string) => [{ type: "content", content: { type: "text", text: value } }];
  const stamp = Date.now().toString(36);

  // A command: running, its output growing, then done with 150 lines, more than the trace keeps.
  const command = `node scripts/check.js --token ${plan.secret}`;
  const lines = Array.from({ length: 150 }, (_, index) => `check ${index + 1} of 150 passed`);
  await tool(`cmd-${stamp}`, { title: `Execute \`${command}\``, kind: "execute", status: "pending", rawInput: { command, cwd: plan.dir } }, true);
  for (let shown = 5; shown <= 20 && !signal.aborted; shown += 5) {
    await tool(`cmd-${stamp}`, { status: "in_progress", content: words(lines.slice(0, shown).join("\n")) });
    await sleep(gap);
  }
  await tool(`cmd-${stamp}`, { status: "completed", content: words(`${lines.join("\n")}\nsigned in with token ${plan.secret}\nall 150 checks passed`) });
  await sleep(gap / 2);

  // A file edit, with its diff; the file is written for its link to open.
  const file = join(plan.dir, "notes.md");
  writeFileSync(file, "# Notes\nPerry shows each step.\nIt keeps them after the reply.\n");
  await tool(`edit-${stamp}`, { title: "Edit notes.md", kind: "edit", status: "in_progress", locations: [{ path: file }], rawInput: { path: file } }, true);
  await sleep(gap / 2);
  await tool(`edit-${stamp}`, { status: "completed", content: [{ type: "diff", path: file, oldText: "# Notes\nPerry shows one step.", newText: "# Notes\nPerry shows each step.\nIt keeps them after the reply." }] });
  await sleep(gap / 2);

  // A web search, with its results.
  const found = [1, 2, 3, 4, 5].map((n) => ({ title: `Inline steps, part ${n}`, url: `https://example.com/steps/${n}` }));
  await tool(`search-${stamp}`, { title: "perry inline steps", kind: "fetch", status: "in_progress", rawInput: { query: "perry inline steps" } }, true);
  await sleep(gap / 2);
  await tool(`search-${stamp}`, { status: "completed", content: words(`Web search results for query: "perry inline steps"\n\nLinks: ${JSON.stringify(found)}`) });
  await sleep(gap / 2);

  // Perry's browser, on a page, then on one that shows the saved login.
  for (const [index, url] of [plan.page, plan.secretPage].entries()) {
    const id = `browser-${index}-${stamp}`;
    const args = { action: "open", url };
    await tool(id, { title: "assistant__browser", kind: "other", status: "in_progress", rawInput: args }, true);
    const answer = await toolAnswer(session, "browser", args);
    await tool(id, { status: answer.error ? "failed" : "completed", content: words(answer.text) });
    await sleep(gap / 2);
  }

  // Another of Perry's tools.
  const todo = { title: `Look at the inline steps ${stamp}` };
  await tool(`todo-${stamp}`, { title: "assistant__add_todo", kind: "other", status: "in_progress", rawInput: todo }, true);
  const added = await toolAnswer(session, "add_todo", todo);
  await tool(`todo-${stamp}`, { status: added.error ? "failed" : "completed", content: words(added.text) });
  await sleep(gap / 2);

  // A command that fails.
  await tool(`fail-${stamp}`, { title: "Execute `node scripts/missing.js`", kind: "execute", status: "in_progress", rawInput: { command: "node scripts/missing.js", cwd: plan.dir } }, true);
  await sleep(gap / 2);
  await tool(`fail-${stamp}`, { status: "failed", content: words("Error: Cannot find module 'scripts/missing.js'\nexit code 1") });
  await sleep(gap / 2);
  for (const chunk of ["Done: ", "ran the checks, ", "updated notes.md ", "and looked at two pages."]) { await say(chunk); await sleep(120); }
  return "Done: ran the checks, updated notes.md and looked at two pages.";
}

async function turn(client: AgentContext, session: Live, prompt: ContentBlock[], signal: AbortSignal): Promise<{ stopReason: "end_turn" | "cancelled" }> {
  const texts = prompt.flatMap((block) => block.type === "text" ? [block.text] : []);
  const text = texts.at(-1)?.trim() ?? "";
  const update = (update: SessionUpdate) => client.notify("session/update", { sessionId: session.id, update });
  const say = (chunk: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  const earlier = session.messages.filter((message) => message.role === "user").map((message) => message.text);
  session.messages.push({ role: "user", text });
  log({ prompt: text, blocks: prompt.map((block) => block.type), preamble: texts.length > 1 ? texts[0] : undefined, context: texts.slice(0, -1).join("\n\n") || undefined, images: prompt.filter((block) => block.type === "image").length, model: session.model, effort: session.effort, mode: session.mode });
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

  if (text.startsWith("LIMIT") || existsSync(join(HOME, `${profile}-limited`))) {
    log({ limit: true, prompt: text.slice(0, 120) });
    // Grok Build's own words for it (xai-grok-shell).
    throw new RequestError(-32000, "You've hit the rate limit for your plan. Upgrade your account or try again later.");
  }
  if (text === "/compact" || text === "/compress") {
    await stream(["Compacted ", "the conversation."], 50);
    return done("end_turn");
  }
  if (text.startsWith("LONGER ") || text.startsWith("QUIET ")) {
    // Work that is long and quiet on purpose: with LONGER, the time asked for first.
    const [, first, second] = text.split(/\s+/);
    const quietSeconds = Number(text.startsWith("LONGER ") ? second : first) || 10;
    if (text.startsWith("LONGER ")) {
      const asked = await callTool(session, "take_longer", { minutes: Number(first) || 1, why: "a long quiet step, for the test" });
      log({ tookLonger: asked });
      await say(`Asked for ${first} minutes (${asked}). `);
    } else {
      await say("Going quiet. ");
    }
    log({ quietFor: quietSeconds });
    // Silent, and deaf to a cancel, as a render or an install with no output is.
    await sleep(quietSeconds * 1000);
    await stream([`Done after ${quietSeconds} quiet seconds.`], 10);
    return done("end_turn");
  }
  if (text.startsWith("HANG")) {
    await say("Working on it");
    log({ hanging: true });
    // Never answers, and a cancel does nothing: only ending the process stops it.
    await new Promise(() => {});
  }
  if (text.startsWith("EARLY")) {
    // As Antigravity's server sometimes does: an empty end_turn at once, and the reply after it.
    log({ early: true });
    const words = `Late reply to: ${text.slice(0, 120)}. One two three.`.split(" ");
    void sleep(1500).then(async () => {
      for (const word of words) { reply += `${word} `; await say(`${word} `); await sleep(120); }
      log({ lateReplySent: reply.trim() });
    });
    return done("end_turn");
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
    if (!alwaysApprove && session.mode !== "yolo") {
      const asked = await client.request("session/request_permission", {
        sessionId: session.id, toolCall: { toolCallId: id, title: "assistant__remember", kind: "other", status: "pending", rawInput: { text: note } }, options: permissionOptions("mcp"),
      });
      log({ permission: "mcp", outcome: asked.outcome });
      if (asked.outcome.outcome !== "selected" || !allows(asked.outcome.optionId)) {
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
  if (text.startsWith("TOOL ")) {
    // What the tool answered goes to the log, not the reply, so the chat's history does not repeat it.
    const [, name, ...rest] = text.split(" ");
    const outcome = await callTool(session, name, rest.length ? JSON.parse(rest.join(" ")) : {}, true);
    await stream([`Called ${name}: ${outcome}.`], 10);
    return done("end_turn");
  }
  if (text.startsWith("STEPS ")) {
    reply = await steps(session, text, update, say, signal);
    return done(signal.aborted ? "cancelled" : "end_turn");
  }
  if (text.startsWith("RUN ")) {
    const command = text.slice("RUN ".length);
    const id = `exec-${Date.now()}`;
    await tool(id, { title: "run_command", kind: "other", status: "pending", rawInput: { command } });
    await tool(id, { title: `Execute \`${command}\``, kind: "execute", status: "pending", rawInput: { variant: "Bash", command, description: "The owner asked for it" } }, false);
    let allowed = alwaysApprove || session.mode === "yolo";
    if (!allowed) {
      const asked = await client.request("session/request_permission", {
        sessionId: session.id,
        toolCall: { toolCallId: id, title: `Execute \`${command}\``, kind: "execute", status: "pending", rawInput: { variant: "Bash", command, description: "The owner asked for it" } },
        options: permissionOptions("execute"),
      });
      log({ permission: "execute", command, outcome: asked.outcome });
      if (asked.outcome.outcome === "cancelled") { await tool(id, { status: "failed" }, false); return done("cancelled"); }
      allowed = allows(asked.outcome.optionId);
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
  // Antigravity's server unpacks itself into its temp folder on every start (about 1 GB for real).
  if (profile === "antigravity") {
    const unpacked = join(process.env.TEMP ?? process.env.TMPDIR ?? tmpdir(), `_MEI${process.pid}`);
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(join(unpacked, "server.bin"), "x".repeat(64 * 1024));
  }
  if (process.env.FAKE_ACP_START_DELAY_MS) await sleep(Number(process.env.FAKE_ACP_START_DELAY_MS));
  log({ acp: argv });
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const loose = <T>(params: unknown) => params as T;
  const needAuth = () => { if (!authenticated) throw new RequestError(-32000, "Authentication required"); };
  const connection = agent({ name: `fake-${profile}` })
    .onRequest("initialize", loose, ({ params }) => {
      log({ method: "initialize", params });
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true, image: PROFILES.image },
          mcpCapabilities: { http: profile !== "cursor", sse: profile !== "cursor" },
          sessionCapabilities: PROFILES.resume ? { resume: {}, list: {}, close: {} } : {},
          ...(PROFILES.logout ? { auth: { logout: {} } } : {}),
        },
        authMethods: PROFILES.methods(),
        agentInfo: { name: PROFILES.name, version: profile === "antigravity" ? "1.2.1-fake" : "1.0.42-fake" },
        ...(profile === "grok" ? { _meta: { defaultAuthMethodId: signedIn() ? "cached_token" : null } } : {}),
      };
    })
    .onRequest("authenticate", loose<{ methodId: string }>, async ({ params }) => {
      // Whether a key came, never the key.
      log({ method: "authenticate", methodId: params.methodId, geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY), env: { GEMINI_HOME: process.env.GEMINI_HOME, TEMP: process.env.TEMP ?? process.env.TMPDIR } });
      if ((params.methodId === "cached_token") && signedIn()) { authenticated = true; return {}; }
      if (params.methodId === "gemini-api-key") {
        if (process.env.GEMINI_API_KEY !== GEMINI_KEY) throw new RequestError(-32602, "Invalid API key");
        authenticated = true;
        return {};
      }
      if (params.methodId === "oauth-personal") {
        if (!signedIn()) {
          // As Google's server does: the link on stdout, among the JSON-RPC lines.
          process.stdout.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?fake=1&redirect_uri=http://127.0.0.1:1/\n");
          await sleep(Number(process.env.FAKE_ACP_LOGIN_MS) || 3000);
          writeFileSync(SIGNED_IN, "yes");
        }
        authenticated = true;
        return {};
      }
      throw new RequestError(-32000, `Authentication failed: ${params.methodId} is not available here`);
    })
    .onRequest("logout", loose, () => {
      log({ method: "logout" });
      rmSync(SIGNED_IN, { force: true });
      authenticated = false;
      return {};
    })
    .onRequest("session/new", loose<{ cwd: string; mcpServers: McpServer[]; _meta?: Record<string, unknown> }>, ({ params }) => {
      log({ method: "session/new", cwd: params.cwd, mcpServers: params.mcpServers, meta: params._meta });
      needAuth();
      const session: Live = { id: `fake-${profile}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, cwd: params.cwd, model: MODELS[profile][0], effort: "medium", messages: [], mcpServers: params.mcpServers, queue: Promise.resolve() };
      if (PROFILES.modes) session.mode = PROFILES.modes.currentModeId;
      sessions.set(session.id, session);
      save(session);
      return { sessionId: session.id, configOptions: config(session), ...(PROFILES.modes ? { modes: PROFILES.modes } : {}) };
    })
    .onRequest("session/resume", loose<{ sessionId: string; cwd: string; mcpServers?: McpServer[] }>, ({ params }) => {
      log({ method: "session/resume", sessionId: params.sessionId, mcpServers: params.mcpServers });
      needAuth();
      if (!PROFILES.resume) throw new RequestError(-32601, "Method not found");
      const session = restore(params.sessionId);
      if (!session) throw new RequestError(-32002, `Session not found: ${params.sessionId}`);
      if (params.mcpServers) session.mcpServers = params.mcpServers;
      // Antigravity comes back on its default model after a cold resume.
      if (profile === "antigravity") { session.model = MODELS.antigravity[0]; session.mode = "default"; }
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
      else if (params.configId === "mode" && profile === "antigravity") session.mode = params.value;
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
      const texts = params.prompt.flatMap((block) => block.type === "text" ? [block.text] : []);
      if (texts.at(-1)?.trim().startsWith("REJECT")) {
        log({ rejected: texts.at(-1)?.trim(), context: texts.slice(0, -1).join("\n\n") || undefined });
        throw new RequestError(-32603, "Internal error: the prompt was turned away");
      }
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
      log({ method: "session/cancel", sessionId: params.sessionId, ignored: Boolean(process.env.FAKE_ACP_IGNORE_CANCEL) });
      // Antigravity may not implement cancel: FAKE_ACP_IGNORE_CANCEL plays that.
      if (!process.env.FAKE_ACP_IGNORE_CANCEL) sessions.get(params.sessionId)?.running?.abort();
    })
    .connect(stream);
  process.stdin.on("end", () => {
    log({ stdinClosed: true, ignored: Boolean(process.env.FAKE_ACP_IGNORE_STDIN) });
    // A server that does not end when its stdin closes: only ending its process tree stops it.
    if (process.env.FAKE_ACP_IGNORE_STDIN) setInterval(() => {}, 60_000);
    else setTimeout(() => process.exit(0), 50);
  });
  process.on("SIGTERM", () => { log({ sigterm: true }); process.exit(0); });
  await connection.closed;
}

if (!await cli()) {
  if (argv.includes("stdio") || argv.includes("acp") || profile === "antigravity") await serve();
  else { console.error(`fake-agent: unknown command ${argv.join(" ")}`); process.exit(2); }
}
