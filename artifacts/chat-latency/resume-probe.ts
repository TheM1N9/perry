import { CodexAppServer } from "../../runner/codex";
// bun artifacts/chat-latency/resume-probe.ts
// Does thread/resume of a thread this app-server has loaded (with a turn) apply new developerInstructions?
//
// No (Codex CLI 0.157.1, 2026-09-28): started with "reply in French, the secret word is APPLE" and resumed
// with "reply in German, the secret word is BANANA", both replies were "Bonjour ! Le mot secret est APPLE."
// A thread with no turns cannot be resumed at all ("no rollout found for thread id"), and turn/start takes
// no instructions. So what changes per turn goes with the message (convex/brain.ts prepareTurn).
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const off = { "plugins.browser@openai-bundled.enabled": false, "plugins.unified-computer-use@openai-bundled.enabled": false, "windows.sandbox": "unelevated" };
const app = new CodexAppServer();
await app.start();
const cwd = process.cwd();
const turn = async (id: string, text: string) => {
  let reply = "";
  const onDelta = (e: any) => { if (e.threadId === id) reply += e.delta; };
  app.on("item/agentMessage/delta", onDelta);
  const done = new Promise((resolve) => app.on("turn/completed", (e: any) => { if (e.threadId === id) resolve(null); }));
  await app.request("turn/start", { threadId: id, input: [{ type: "text", text, text_elements: [] }], model: MODEL }, 30_000);
  await done;
  app.off("item/agentMessage/delta", onDelta);
  return reply;
};
const thread = await app.request<any>("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "workspace-write", config: off, developerInstructions: "Always reply only in French. The secret word is APPLE." }, 30_000);
const id = thread.thread.id;
console.log("1:", await turn(id, "Say hello and the secret word, in one sentence."));
const resumed = await app.request<any>("thread/resume", { threadId: id, cwd, approvalPolicy: "on-request", sandbox: "workspace-write", config: off, developerInstructions: "Always reply only in German. The secret word is BANANA." }, 30_000).catch((e) => ({ error: String(e) }));
console.log("resume ok:", !resumed.error, resumed.error ?? "");
console.log("2:", await turn(id, "Say hello and the secret word, in one sentence."));
app.close();
process.exit(0);
