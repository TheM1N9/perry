import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// bun artifacts/fresh-instructions/fallback-probe.ts
// When thread/inject_items fails, the change goes ahead of the message instead (codex.ts, updateInstructions).
// Without a model turn, in an empty CODEX_HOME (signed out): does this Codex take thread/inject_items, how does it
// fail on a thread it does not have, and does turn/start take the fallback's extra text part?
// Codex CLI 0.159.2, 2026-09-30: inject on a new thread {"ok":true}; on an unknown thread {"error":"..."} (the
// fallback's trigger); turn/start with the extra part started a turn, which then failed on sign-in, not on its input.
const home = mkdtempSync(join(process.env.PERRY_E2E_DIR ?? tmpdir(), "codex-fallback-"));
process.env.CODEX_HOME = home;
const { CodexAppServer } = await import("../../runner/codex");
const off = { "plugins.browser@openai-bundled.enabled": false, "plugins.unified-computer-use@openai-bundled.enabled": false, "windows.sandbox": "unelevated" };
const app = new CodexAppServer(); await app.start();
const note = (promise: Promise<unknown>) => promise.then(() => ({ ok: true }), (error) => ({ error: String(error instanceof Error ? error.message : error) }));
const thread = await app.request<any>("thread/start", { cwd: home, approvalPolicy: "never", sandbox: "read-only", config: off, developerInstructions: "Your name is Perry." }, 30_000);
const id = thread.thread.id;
const developer = (text: string) => [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }];
console.log("inject:", JSON.stringify(await note(app.request("thread/inject_items", { threadId: id, items: developer("# Your instructions changed\n\nYour name is Nova.") }, 30_000))));
console.log("inject, unknown thread:", JSON.stringify(await note(app.request("thread/inject_items", { threadId: "00000000-0000-7000-8000-000000000000", items: developer("x") }, 30_000))));
const input = [
  { type: "text", text: "<perry-instructions>\n# Your instructions changed\n\nYour name is Nova.\n</perry-instructions>", text_elements: [] },
  { type: "text", text: "What is your name?", text_elements: [] },
];
const started = await app.request<any>("turn/start", { threadId: id, input }, 30_000).then((value) => ({ turn: value.turn?.id }), (error) => ({ error: String(error) }));
console.log("turn/start with the extra part:", JSON.stringify(started));
if (started.turn) console.log("the turn:", JSON.stringify(await app.waitForTurn(started.turn, 60_000).then((out) => ({ text: out.text }), (error) => ({ failed: String(error instanceof Error ? error.message : error).slice(0, 200) }))));
app.close();
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
process.exit(0);
