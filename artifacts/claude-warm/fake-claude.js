/**
 * A stand-in for Claude Code, for artifacts/claude-warm/stand-in.ts: the slice
 * of `claude --output-format stream-json --input-format stream-json` the
 * Claude Agent SDK and runner/engines/claude.ts use, so a turn runs with no
 * model, no account and none of the owner's Claude Code. Plain JavaScript, as
 * the SDK runs a cli.js with node or bun.
 *
 * FAKE_CLAUDE_HOME/log.jsonl records every start (its arguments), every
 * control request (initialize with the appended instructions, a permission
 * mode switch, an interrupt), every message it is sent and every step it
 * takes, with this process's id. FAKE_CLAUDE_HOME/version is the version it
 * says it is. FAKE_CLAUDE_HOME/sessions/<id> keeps the words a session was
 * asked to remember, so a resumed session recalls them.
 *
 * What a message asks, by its last text block:
 *   REMEMBER <word>   remember it, reply NOTED
 *   RECALL            reply with the word remembered
 *   SAY <word>        reply with it
 *   SLOW <word>       wait 4 s, then reply with it and any message that joined meanwhile
 *   STEPS <word>      three steps, 3 s apart: Write a.txt, Write b.txt, Bash `echo <word>`.
 *                     Write is asked about unless the mode accepts edits; Bash always is.
 *                     The reply names what each step got.
 *   SLEEP             wait 60 s (to be stopped), then reply DONE
 */

const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

const args = process.argv.slice(2);
const HOME = process.env.FAKE_CLAUDE_HOME;
if (!HOME) { console.error("fake claude: FAKE_CLAUDE_HOME is not set"); process.exit(2); }
mkdirSync(join(HOME, "sessions"), { recursive: true });
const version = existsSync(join(HOME, "version")) ? readFileSync(join(HOME, "version"), "utf8").trim() : "9.9.9";
const log = (entry) => appendFileSync(join(HOME, "log.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
const flag = (name) => {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  const joined = args.find((arg) => arg.startsWith(`${name}=`));
  return joined ? joined.slice(name.length + 1) : undefined;
};
const flags = (name) => args.flatMap((arg, i) => arg === name ? [args[i + 1]] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []);

if (args[0] === "--version") { console.log(`${version} (Claude Code)`); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "stand-in@example.com", subscriptionType: "max" }));
  process.exit(0);
}
if (!args.includes("stream-json")) { console.error(`fake claude: ${args.join(" ")} is not played here`); process.exit(2); }

const session = flag("--resume") ?? flag("--session-id") ?? randomUUID();
let mode = flag("--permission-mode") ?? "default";
log({ event: "start", session, resumed: Boolean(flag("--resume")), mode, model: flag("--model"), addDirs: flags("--add-dir"), args });

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const memory = join(HOME, "sessions", session);

/** Answers to this process's own control requests (can_use_tool), by id. */
const waiting = new Map();
function ask(tool, input, toolUseId) {
  const id = randomUUID();
  send({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: toolUseId, permission_suggestions: [] } });
  return new Promise((done) => waiting.set(id, done));
}

/** Messages the owner sent; one with priority "next" joins the turn running. */
const queue = [];
let running = null;
let wake = null;

function textOf(message) {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text).at(-1) ?? "";
}

async function reply(turn, text) {
  const messageId = `msg_${randomUUID()}`;
  send({ type: "stream_event", uuid: randomUUID(), session_id: session, parent_tool_use_id: null, event: { type: "message_start", message: { id: messageId } } });
  for (const piece of text.match(/.{1,6}/gs) ?? []) {
    send({ type: "stream_event", uuid: randomUUID(), session_id: session, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
    await sleep(20);
  }
  send({ type: "assistant", uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { id: messageId, role: "assistant", content: [{ type: "text", text }] } });
  turn.text = text;
}

async function tool(turn, name, input) {
  const id = `toolu_${randomUUID()}`;
  send({ type: "assistant", uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const byMode = name !== "Bash" && (mode === "acceptEdits" || mode === "bypassPermissions");
  const answer = byMode ? { behavior: "allow" } : await ask(name, input, id);
  const got = byMode ? "mode" : answer.behavior;
  log({ event: "step", tool: name, mode, got, session });
  send({ type: "user", uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: got === "deny" ? "declined" : "ok", is_error: got === "deny" }] } });
  return `${name}:${got}`;
}

async function runTurn(first) {
  const turn = { uuids: [first.uuid].filter(Boolean), joined: [], interrupted: false, text: "" };
  running = turn;
  send({ type: "system", subtype: "init", uuid: randomUUID(), session_id: session, model: flag("--model") ?? "default", permissionMode: mode, tools: [], mcp_servers: [], cwd: process.cwd(), apiKeySource: "none", claude_code_version: version, slash_commands: [], output_style: "default", skills: [], plugins: [] });
  const text = textOf(first);
  const [verb, word = ""] = text.trim().split(/\s+/);
  const blocks = (first.message?.content ?? []).filter?.((part) => part.type === "text").map((part) => part.text) ?? [];
  log({ event: "turn", session, text, blocks, mode });
  try {
    if (verb === "REMEMBER") { writeFileSync(memory, word); await reply(turn, "NOTED"); }
    else if (verb === "RECALL") await reply(turn, existsSync(memory) ? readFileSync(memory, "utf8") : "NOTHING");
    else if (verb === "SAY") await reply(turn, word);
    else if (verb === "SLOW") { await sleep(4_000); await reply(turn, [word, ...turn.joined].join(" ")); }
    else if (verb === "STEPS") {
      const got = [];
      got.push(await tool(turn, "Write", { file_path: "a.txt", content: "a" }));
      await sleep(3_000);
      got.push(await tool(turn, "Write", { file_path: "b.txt", content: "b" }));
      await sleep(3_000);
      got.push(await tool(turn, "Bash", { command: `echo ${word}` }));
      await reply(turn, got.join(" "));
    } else if (verb === "SLEEP") {
      for (let i = 0; i < 600 && !turn.interrupted; i++) await sleep(100);
      if (!turn.interrupted) await reply(turn, "DONE");
    } else await reply(turn, `UNKNOWN ${text.slice(0, 40)}`);
  } catch (error) {
    log({ event: "error", error: String(error) });
  }
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 };
  const common = { type: "result", uuid: randomUUID(), session_id: session, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], user_message_uuids: turn.uuids, queued_turn_count: queue.length };
  if (turn.interrupted) send({ ...common, subtype: "error_during_execution", is_error: true, errors: ["[Request interrupted by user]"] });
  else send({ ...common, subtype: "success", is_error: false, result: turn.text });
  log({ event: "result", session, text: turn.text, interrupted: turn.interrupted });
  running = null;
}

(async () => {
  for (;;) {
    while (!queue.length) await new Promise((done) => { wake = done; });
    wake = null;
    await runTurn(queue.shift());
  }
})();

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "control_response") {
    const done = waiting.get(message.response?.request_id);
    waiting.delete(message.response?.request_id);
    done?.(message.response?.subtype === "success" ? message.response.response ?? {} : { behavior: "deny" });
    return;
  }
  if (message.type === "control_request") {
    const request = message.request ?? {};
    const answer = (response = {}) => send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    log({ event: "control", subtype: request.subtype, ...(request.subtype === "initialize" ? { append: request.appendSystemPrompt ?? null } : {}), ...(request.subtype === "set_permission_mode" ? { mode: request.mode } : {}) });
    if (request.subtype === "initialize") {
      return answer({ commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [{ value: "default", displayName: "Default (stand-in)", description: "" }, { value: "stand-in-b", displayName: "Stand-in B", description: "" }], account: { email: "stand-in@example.com" } });
    }
    if (request.subtype === "set_permission_mode") { mode = request.mode; return answer(); }
    if (request.subtype === "interrupt") {
      if (running) running.interrupted = true;
      return answer({ still_queued: [] });
    }
    if (request.subtype === "get_usage") {
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      return answer({ rate_limits_available: true, subscription_type: "max", rate_limits: { five_hour: { utilization: 42, resets_at: soon }, seven_day: { utilization: 7, resets_at: soon } } });
    }
    return answer();
  }
  if (message.type === "user") {
    log({ event: "message", priority: message.priority ?? null, uuid: message.uuid ?? null, text: textOf(message) });
    if (running && message.priority === "next") {
      running.joined.push(textOf(message));
      if (message.uuid) running.uuids.push(message.uuid);
      return;
    }
    queue.push(message);
    wake?.();
  }
});
process.stdin.on("end", () => { log({ event: "exit" }); process.exit(0); });
