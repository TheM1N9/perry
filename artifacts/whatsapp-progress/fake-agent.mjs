// Synthetic ACP agent for the progress replay. No provider, shell tool or network.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const sessions = new Set();
const pending = new Map();
const log = (entry) => appendFileSync(process.env.PERRY_PROGRESS_ACP_LOG, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const loose = value => value;
let connection;
const text = (text, messageId) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) });
const tool = (id, update = false, status = "in_progress") => ({ sessionUpdate: update ? "tool_call_update" : "tool_call", toolCallId: id, title: "Synthetic source read", kind: "read", status });
const notify = (sessionId, update) => connection.client.notify("session/update", { sessionId, update });
connection = agent({ name: "synthetic-progress-agent" })
  .onRequest("initialize", loose, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false, promptCapabilities: { image: false } }, authMethods: [], agentInfo: { name: "synthetic-progress-agent", version: "1.0.0" } }))
  .onRequest("session/new", loose, () => {
    const sessionId = randomUUID(); sessions.add(sessionId); log({ event: "session", sessionId });
    return { sessionId, modes: { currentModeId: "yolo", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "Full" }] } };
  })
  .onRequest("session/set_mode", loose, () => ({}))
  .onRequest("session/prompt", loose, async ({ params }) => {
    if (!sessions.has(params.sessionId)) throw new RequestError(-32002, "Synthetic session missing");
    const scenario = params.prompt.filter(x => x.type === "text").map(x => x.text).join("\n").match(/SCENARIO:([\w-]+)/)?.[1];
    log({ event: "prompt", scenario });
    const say = update => notify(params.sessionId, update);
    if (scenario === "final") {
      await say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private synthetic reasoning" } });
      await say(text("Final ", "final")); await say(text("answer.", "final"));
    } else if (scenario === "two") {
      await say(text("Checking ")); await say(text("the first source."));
      await say(tool("read-1")); await say(tool("read-1", true)); await say(tool("read-1", true, "completed"));
      await say(text("Comparing the second source.", "second"));
      await say(tool("read-2")); await say(tool("read-2")); await say(tool("read-2", true, "completed"));
      await say(text("Final ", "final"));
      await say(tool("read-1", true, "completed"));
      await say(text("answer.", "final"));
      await notify("foreign-session", text("Foreign private progress"));
      await notify("foreign-session", tool("foreign-read"));
    } else if (scenario === "tools-only") {
      await say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private synthetic reasoning" } });
      await say(tool("only-read"));
      await say({ ...tool("only-read", true, "completed"), content: [{ type: "content", content: { type: "text", text: "Private tool output" } }] });
    } else if (scenario === "no-final") {
      await say(text("Checking the original source."));
      await say(tool("read-1")); await say(tool("read-1", true, "completed"));
    } else if (scenario === "hold") {
      await say(text("An unfinished sentence"));
      await new Promise(done => pending.set(params.sessionId, done));
      pending.delete(params.sessionId);
      return { stopReason: "cancelled" };
    } else if (scenario === "failure") {
      await say(text("An unfinished sentence"));
      throw new RequestError(-32603, "Synthetic provider failed");
    } else if (scenario === "update-only") {
      await say(text("An unfinished final sentence"));
      await say(tool("unseen-old-tool", true, "completed"));
    } else throw new RequestError(-32602, "Unknown synthetic scenario");
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", loose, ({ params }) => { log({ event: "cancel", sessionId: params.sessionId }); pending.get(params.sessionId)?.(); })
  .connect(stream);
log({ event: "started", pid: process.pid });
process.stdin.once("end", () => { connection.close(); });
