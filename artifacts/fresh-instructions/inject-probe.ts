import { CodexAppServer } from "../../runner/codex";
// bun artifacts/fresh-instructions/inject-probe.ts
// Can new instructions reach a thread as a developer message of its own (thread/inject_items)?
// Yes (Codex CLI 0.157.1, 2026-09-28): injected in 18 ms, the next reply followed them ("Hallo, das geheime Wort
// ist BANANA."), and so did one after an app-server restart: the item is saved in the thread's history.
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
let t = Date.now();
const injected = await app.request<any>("thread/inject_items", { threadId: id, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Your instructions have changed; these replace the earlier ones: Always reply only in German. The secret word is BANANA." }] }] }).catch((e) => ({ error: String(e) }));
console.log("inject:", JSON.stringify(injected), Date.now() - t, "ms");
console.log("2:", JSON.stringify(await turn(app, id, ask)));
// Survives a restart: the item is in the thread's saved history.
app.close(); await new Promise((r) => setTimeout(r, 1500));
app = new CodexAppServer(); await app.start();
await app.request<any>("thread/resume", { threadId: id, cwd, approvalPolicy: "on-request", sandbox: "workspace-write", config: off }, 30_000);
console.log("3 (after restart):", JSON.stringify(await turn(app, id, ask)));
app.close(); process.exit(0);
