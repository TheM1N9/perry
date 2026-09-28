import { CodexAppServer } from "../../runner/codex";

// bun artifacts/chat-latency/codex-probe.ts: Codex alone, without Perry, for one fresh thread per variant:
// how long from thread/start to the owner's message being taken (its userMessage item), and to the first words.
//
// What it found (Codex CLI 0.157.1, Windows, 2026-09-28), with the variants edited between runs:
// - A new thread takes the first message 2.3 to 3 s after turn/start whatever is turned off: the
//   ChatGPT apps (features.apps, about 0.5 s of it), the shell snapshot, plugins, skill search,
//   multi-agent, the sandbox, or an empty working folder.
// - That setup runs in the background once thread/start answers: a thread started 6 s before its
//   first message took it 0.6 s after turn/start. A resumed, loaded thread takes it in about 0.25 s.
// - From the message taken to the first words, the model alone varied from 1.4 to 9 s.
const off = { "plugins.browser@openai-bundled.enabled": false, "plugins.unified-computer-use@openai-bundled.enabled": false, "windows.sandbox": "unelevated", "features.apps": false };
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const cwd = process.cwd();
const base = { "plugins.browser@openai-bundled.enabled": false, "plugins.unified-computer-use@openai-bundled.enabled": false, "windows.sandbox": "unelevated" };
const empty = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "probe-"));
const VARIANTS: Array<{ name: string; config: object; effort?: string; cwd?: string; sandbox?: string; waitMs?: number; twice?: boolean }> = [
  { name: "start-then-send", config: off },
  { name: "start-wait-6s-then-send", config: off, waitMs: 6000 },
  { name: "second-turn", config: off, twice: true },
];
const app = new CodexAppServer();
await app.start();
const out: Array<Record<string, unknown>> = [];
for (const variant of VARIANTS) {
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = (name: string) => { marks[name] ??= Date.now() - t0; };
  const onItem = (event: any) => { if (event.item?.type) mark(`item.${event.item.type}`); };
  const onDelta = () => mark("firstDelta");
  const onMcp = (event: any) => { if (event.status === "ready") mark(`mcp.${event.name}.ready`); };
  app.on("item/started", onItem); app.on("item/agentMessage/delta", onDelta); app.on("mcpServer/startupStatus/updated", onMcp);
  const thread = await app.request<any>("thread/start", { cwd: variant.cwd ?? cwd, approvalPolicy: "on-request", sandbox: variant.sandbox ?? "workspace-write", config: variant.config, serviceName: "perry", ephemeral: true }, 30_000);
  mark("threadStarted");
  if (variant.waitMs) await new Promise((r) => setTimeout(r, variant.waitMs));
  if (variant.twice) { const first = new Promise((resolve) => app.on("turn/completed", (event: any) => { if (event.threadId === thread.thread.id) resolve(null); })); await app.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Say ok.", text_elements: [] }], model: MODEL }, 30_000); await first; for (const key of Object.keys(marks)) delete marks[key]; }
  const t1 = Date.now(); marks.sendAt = t1 - t0;
  const done = new Promise((resolve) => app.on("turn/completed", (event: any) => { if (event.threadId === thread.thread.id) resolve(null); }));
  await app.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Say hello in five words.", text_elements: [] }], model: MODEL, ...(variant.effort ? { effort: variant.effort } : {}) }, 30_000);
  mark("turnStarted");
  await done;
  mark("turnCompleted");
  app.off("item/started", onItem); app.off("item/agentMessage/delta", onDelta); app.off("mcpServer/startupStatus/updated", onMcp);
  out.push({ variant: variant.name, ...marks });
  console.log(variant.name, JSON.stringify(marks));
}
app.close();
process.exit(0);
