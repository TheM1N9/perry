#!/usr/bin/env bun
/**
 * Stand-ins for the Codex and Claude Code CLIs at a version a run chooses, for
 * artifacts/cli-versions: `bun fake-cli.ts codex|claude <args>`, put first on
 * PATH by a codex.cmd and a claude.cmd, so the owner's own CLIs are neither run
 * nor changed.
 *
 * FAKE_CLI_HOME/<cli>-version holds the version it says it is, read at every
 * start, so a run "updates" it by writing a new one. FAKE_CLI_HOME/log.jsonl
 * records every start and every app-server request, which the run checks.
 *
 *   codex --version, codex login status, and codex app-server: the slice of
 *   the app-server protocol the runner uses, signed in with ChatGPT. A turn
 *   answers "Fake Codex <version> reply to: <prompt>"; one with an output
 *   schema (a chat's name) answers {"title": ...}. Below 0.136.0 it lacks
 *   skills/extraRoots/set, as real Codex does.
 *   claude --version and claude auth status --json, signed in with Claude.
 *   claude update, for artifacts/engine-update: as FAKE_CLI_HOME/claude-update
 *   says (ok, fail or hang), to the version in FAKE_CLI_HOME/claude-latest.
 *   A Codex prompt starting "SLOW <seconds>" is answered that much later.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [cli = "codex", ...args] = process.argv.slice(2);
const HOME = process.env.FAKE_CLI_HOME ?? join(tmpdir(), "fake-cli");
mkdirSync(HOME, { recursive: true });
const version = existsSync(join(HOME, `${cli}-version`)) ? readFileSync(join(HOME, `${cli}-version`), "utf8").trim() : "0.0.0";
const log = (entry: Record<string, unknown>) => appendFileSync(join(HOME, "log.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, cli, version, ...entry })}\n`);
log({ args });

const older = (a: string, b: string) => {
  const x = a.split(/[.-]/).map(Number);
  const y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

if (cli === "claude" && args[0] === "update") {
  // `claude update`, as artifacts/engine-update plays it: FAKE_CLI_HOME/claude-update says how (ok, fail or hang),
  // and FAKE_CLI_HOME/claude-latest is the version it updates to.
  const mode = existsSync(join(HOME, "claude-update")) ? readFileSync(join(HOME, "claude-update"), "utf8").trim() : "ok";
  const latest = existsSync(join(HOME, "claude-latest")) ? readFileSync(join(HOME, "claude-latest"), "utf8").trim() : version;
  log({ update: mode });
  console.log(`Current version: ${version}`);
  console.log("Checking for updates...");
  await new Promise((done) => setTimeout(done, 1_500));
  if (mode === "hang") await new Promise(() => setInterval(() => {}, 60_000));
  if (mode === "fail") {
    console.error(`Error: Failed to install update: EBUSY: resource busy or locked, rename '${join(HOME, "claude.exe")}'`);
    console.error("Try running the update again, or reinstall with: curl -fsSL https://claude.ai/install.sh | bash");
    process.exit(1);
  }
  console.log(`New version available: ${latest} (current: ${version})`);
  console.log("Installing update...");
  await new Promise((done) => setTimeout(done, 1_500));
  writeFileSync(join(HOME, "claude-version"), latest);
  console.log(`Successfully updated from ${version} to version ${latest}`);
  process.exit(0);
}

if (cli === "claude") {
  if (args[0] === "--version") console.log(`${version} (Claude Code)`);
  else if (args[0] === "auth" && args[1] === "status") console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "owner@example.com", subscriptionType: "max" }));
  else { console.error(`fake claude: ${args.join(" ")} is not played here`); process.exit(2); }
  process.exit(0);
}

if (args[0] === "--version") { console.log(`codex-cli ${version}`); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (args[0] !== "app-server") { console.error(`fake codex: ${args.join(" ")} is not played here`); process.exit(2); }

// --- codex app-server ------------------------------------------------------------------------

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
let next = 0;
const textOf = (input: Array<{ type?: string; text?: string }> = []) => input.filter((part) => part.type === "text").map((part) => part.text ?? "").at(-1) ?? "";

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: { id?: number; method?: string; params?: Record<string, any> };
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || !message.method) return;
  const { id, method, params = {} } = message;
  // How a thread and its turns were started, for checks on what Codex was let do (artifacts/no-hardcoded-engines).
  log({ method, ...(/^(thread\/start|thread\/resume|turn\/start)$/.test(method) ? { params } : {}) });
  const answer = (result: object) => send({ id, result });
  switch (method) {
    case "initialize": return answer({ userAgent: `codex_cli_rs/${version} (Windows fake; fake) perry (0.1.0)` });
    case "account/read": return answer({ account: { type: "chatgpt", planType: "plus", email: "owner@example.com" } });
    case "model/list": return answer({ data: [{ model: "gpt-fake", displayName: "GPT Fake", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }] });
    case "skills/extraRoots/set":
      if (older(version, "0.136.0")) return send({ id, error: { code: -32600, message: "Invalid request: unknown variant `skills/extraRoots/set`" } });
      return answer({});
    case "skills/list": return answer({ data: [] });
    case "thread/start": return answer({ thread: { id: `fake-thread-${++next}-${process.pid}` } });
    case "thread/resume": return answer({ thread: { id: params.threadId } });
    case "thread/unsubscribe": return answer({});
    case "turn/interrupt": return answer({});
    case "turn/start": {
      const threadId = params.threadId as string;
      const turnId = `fake-turn-${++next}`;
      const prompt = textOf(params.input);
      const text = params.outputSchema ? JSON.stringify({ title: "Fake chat name" }) : `Fake Codex ${version} reply to: ${prompt}`;
      log({ turn: prompt.slice(0, 200) });
      answer({ turn: { id: turnId } });
      const itemId = `fake-item-${next}`;
      // "SLOW <seconds> ..." answers that much later, for a turn that is still running when something else happens.
      const slow = Number(/^SLOW (\d+)/.exec(prompt)?.[1] ?? 0);
      setTimeout(() => {
        for (const piece of text.match(/.{1,12}/gs) ?? []) send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: piece } });
        const item = { id: itemId, type: "agentMessage", text };
        send({ method: "item/completed", params: { threadId, turnId, item, completedAtMs: Date.now() } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [item] } } });
        log({ turnEnded: prompt.slice(0, 200) });
      }, slow * 1000 || 200);
      return;
    }
    default: return send({ id, error: { code: -32601, message: `fake codex does not play ${method}` } });
  }
});
