import { CodexAppServer } from "../../runner/codex";
// bun artifacts/fresh-instructions/restart-probe.ts
// Does a Codex thread take new developerInstructions when a new app-server resumes it?
// No (Codex CLI 0.157.1, 2026-09-28): started with "reply in French, the secret word is APPLE", resumed after a
// restart with German and BANANA, it still replied "Bonjour ! Le mot secret est APPLE." The instructions are a
// developer message in the thread's saved history; thread/unsubscribe then resume keeps them too.
const MODEL = "gpt-6-luna";
const off = { "plugins.browser@openai-bundled.enabled": false, "plugins.unified-computer-use@openai-bundled.enabled": false, "windows.sandbox": "unelevated" };
const cwd = process.cwd();
const turn = async (app: CodexAppServer, id: string, text: string) => {
  let reply = ""; const t0 = Date.now(); let taken = 0;
  app.on("item/completed", (e: any) => { if (e.threadId === id && e.item?.type === "agentMessage") reply = e.item.text; });
  app.on("item/started", (e: any) => { if (e.threadId === id && e.item?.type === "userMessage" && !taken) taken = Date.now() - t0; });
  const done = new Promise((resolve) => app.on("turn/completed", (e: any) => { if (e.threadId === id) resolve(null); }));
  await app.request("turn/start", { threadId: id, input: [{ type: "text", text, text_elements: [] }], model: MODEL, effort: "low" }, 30_000);
  await done;
  return { reply, takenMs: taken };
};
const ask = "Say hello and the secret word, in one sentence.";
let app = new CodexAppServer(); await app.start();
const thread = await app.request<any>("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "workspace-write", config: off, developerInstructions: "Always reply only in French. The secret word is APPLE." }, 30_000);
const id = thread.thread.id;
console.log("1:", JSON.stringify(await turn(app, id, ask)));
app.close();
await new Promise((r) => setTimeout(r, 1500));
app = new CodexAppServer(); await app.start();
let t = Date.now();
await app.request<any>("thread/resume", { threadId: id, cwd, approvalPolicy: "on-request", sandbox: "workspace-write", config: off, developerInstructions: "Always reply only in German. The secret word is BANANA." }, 30_000);
console.log("resume after restart:", Date.now() - t, "ms");
console.log("2:", JSON.stringify(await turn(app, id, ask)));
app.close(); process.exit(0);
