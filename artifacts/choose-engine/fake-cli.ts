#!/usr/bin/env bun
/**
 * Stand-ins for the Codex and Claude Code CLIs and for npm, for
 * artifacts/choose-engine: `bun fake-cli.ts codex|claude|npm|installer <args>`,
 * put first on PATH by a codex, claude and npm shim (and powershell, curl and
 * bash shims that only refuse), so the owner's own CLIs are neither run nor
 * changed and nothing is really installed.
 *
 * FAKE_CLI_HOME holds the state: <cli>-version, the version it says it is
 * (Codex 0.177.7 and Claude Code 2.1.277 unless written, versions no real CLI
 * on this machine has, so a check can tell them apart), and <cli>-signed-in,
 * there once it is signed in. log.jsonl records every start and every
 * app-server request.
 *
 *   codex --version, codex login status, codex login [--device-auth] (signs
 *   in at once), and codex app-server: the slice of its protocol the runner
 *   uses, including ChatGPT's device code from Settings, which finishes after
 *   FAKE_CLI_LOGIN_MS. A turn answers "Fake Codex reply to: <prompt>"; one
 *   with an output schema (a chat's name) answers {"title": ...}.
 *   claude --version, claude auth status --json and claude auth login.
 *   npm install -g @openai/codex writes a codex shim beside the npm one, as
 *   npm would, signed out; npm prefix -g names that folder. Any other install
 *   is refused.
 *   installer: what the powershell, curl and bash shims run; it refuses, so a
 *   real installer is never reached.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const [cli = "codex", ...args] = process.argv.slice(2);
const HOME = process.env.FAKE_CLI_HOME ?? join(tmpdir(), "fake-cli");
mkdirSync(HOME, { recursive: true });
const DEFAULTS: Record<string, string> = { codex: "0.177.7", claude: "2.1.277" };
const version = existsSync(join(HOME, `${cli}-version`)) ? readFileSync(join(HOME, `${cli}-version`), "utf8").trim() : DEFAULTS[cli] ?? "0.0.0";
const SIGNED_IN = join(HOME, `${cli}-signed-in`);
const signedIn = () => existsSync(SIGNED_IN);
const log = (entry: Record<string, unknown>) => appendFileSync(join(HOME, "log.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, cli, version, ...entry })}\n`);
log({ args });

if (cli === "installer") {
  console.error(`fake installer: refused to run ${args.join(" ")}; this run installs nothing for real.`);
  process.exit(3);
}

if (cli === "npm") {
  const bin = process.env.FAKE_CLI_BIN ?? dirname(process.argv[1]);
  if (args[0] === "prefix" && args[1] === "-g") { console.log(bin); process.exit(0); }
  if (args[0] === "install" && args.includes("-g") && args.includes("@openai/codex")) {
    // As npm installs a CLI: a shim in its global folder. This one runs the stand-in, signed out.
    const fake = process.argv[1];
    if (process.platform === "win32") writeFileSync(join(bin, "codex.cmd"), `@"${process.execPath}" "${fake}" codex %*\r\n`);
    else { writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" codex "$@"\n`); chmodSync(join(bin, "codex"), 0o755); }
    console.log("added 1 package in 0.1s");
    process.exit(0);
  }
  console.error(`fake npm: ${args.join(" ")} is not played here`);
  process.exit(2);
}

if (cli === "claude") {
  if (args[0] === "--version") console.log(`${version} (Claude Code)`);
  else if (args[0] === "auth" && args[1] === "status") {
    console.log(JSON.stringify(signedIn() ? { loggedIn: true, authMethod: "claude.ai", email: "owner@example.com", subscriptionType: "max" } : { loggedIn: false, authMethod: "none" }));
  } else if (args[0] === "auth" && args[1] === "login") {
    writeFileSync(SIGNED_IN, "yes");
    console.log("Login successful.");
  } else { console.error(`fake claude: ${args.join(" ")} is not played here`); process.exit(2); }
  process.exit(0);
}

if (args[0] === "--version") { console.log(`codex-cli ${version}`); process.exit(0); }
if (args[0] === "login" && args[1] === "status") {
  if (signedIn()) { console.log("Logged in using ChatGPT"); process.exit(0); }
  console.log("Not logged in"); process.exit(1);
}
if (args[0] === "login") {
  if (args.includes("--device-auth")) console.log("Open https://auth.openai.com/codex/device?fake=1 and enter FAKE-CODE");
  else console.log("Signing in in the browser… (fake: at once)");
  writeFileSync(SIGNED_IN, "yes");
  console.log("Successfully logged in");
  process.exit(0);
}
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
  log({ method, ...(params.threadId ? { threadId: params.threadId } : {}) });
  const answer = (result: object) => send({ id, result });
  switch (method) {
    case "initialize": return answer({ userAgent: `codex_cli_rs/${version} (fake; fake) perry (0.1.0)` });
    case "account/read": return answer({ account: signedIn() ? { type: "chatgpt", planType: "plus", email: "owner@example.com" } : null });
    case "account/login/start": {
      const loginId = `fake-login-${++next}`;
      answer({ type: "chatgptDeviceCode", loginId, verificationUrl: "https://auth.openai.com/codex/device?fake=1", userCode: "FAKE-CODE" });
      setTimeout(() => {
        writeFileSync(SIGNED_IN, "yes");
        log({ login: "completed" });
        send({ method: "account/login/completed", params: { loginId, success: true } });
      }, Number(process.env.FAKE_CLI_LOGIN_MS) || 3_000);
      return;
    }
    case "account/login/cancel": return answer({});
    case "account/logout": rmSync(SIGNED_IN, { force: true }); return answer({});
    case "account/rateLimits/read": return answer({ rateLimits: null });
    case "model/list": return answer({ data: signedIn() ? [{ model: "gpt-fake", displayName: "GPT Fake", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }] : [] });
    case "skills/extraRoots/set": return answer({});
    case "skills/list": return answer({ data: [] });
    case "thread/start": return answer({ thread: { id: `fake-thread-${++next}-${process.pid}` } });
    case "thread/resume": return answer({ thread: { id: params.threadId } });
    case "thread/unsubscribe": return answer({});
    case "turn/interrupt": return answer({});
    case "turn/start": {
      const threadId = params.threadId as string;
      const turnId = `fake-turn-${++next}`;
      const prompt = textOf(params.input);
      const text = params.outputSchema ? JSON.stringify({ title: "Fake chat name" }) : `Fake Codex reply to: ${prompt}`;
      log({ turn: prompt.slice(0, 200) });
      answer({ turn: { id: turnId } });
      const itemId = `fake-item-${next}`;
      setTimeout(() => {
        for (const piece of text.match(/.{1,12}/gs) ?? []) send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: piece } });
        const item = { id: itemId, type: "agentMessage", text };
        send({ method: "item/completed", params: { threadId, turnId, item, completedAtMs: Date.now() } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [item] } } });
      }, 200);
      return;
    }
    default: return send({ id, error: { code: -32601, message: `fake codex does not play ${method}` } });
  }
});
