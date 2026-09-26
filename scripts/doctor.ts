#!/usr/bin/env bun
/**
 * `pnpm run doctor` — check every moving part and say which one is broken.
 *
 * Reports only. It changes nothing, so it is safe to run when you are not sure
 * what state an install is in.
 *
 * `pnpm run doctor -- --machine` checks only this machine (Bun, Codex, the
 * runner and its service), for a second machine with no .env.local.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sandboxMode } from "../runner/codex";
import { HOME, readRunnerConfig } from "../runner/home";
import { dim, green, INSTALL_HINTS, red, run, runCodex, yellow } from "./lib";
import { serviceState } from "./service";

const ENV_FILE = resolve(process.cwd(), ".env.local");

let failures = 0;

function ok(label: string, detail = "") {
  console.log(`${green("ok")}    ${label}${detail ? dim(`  ${detail}`) : ""}`);
}
function bad(label: string, detail = "") {
  failures += 1;
  console.log(`${red("fail")}  ${label}${detail ? `  ${detail}` : ""}`);
}
function warn(label: string, detail = "") {
  console.log(`${yellow("warn")}  ${label}${detail ? dim(`  ${detail}`) : ""}`);
}
function note(label: string, detail = "") {
  console.log(`${dim("info")}  ${label}${detail ? dim(`  ${detail}`) : ""}`);
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).at(-1) ?? "";

/** This machine: what the runner and Codex need here, on any OS. */
async function checkMachine() {
  note("machine", `${platform()} ${release()}`);
  ok("bun", process.versions.bun ?? process.version);
  // Perry's server runs on Node, and keeps its data with Node's built-in SQLite (22.13 and later).
  const node = await run("node", ["-p", "process.versions.node"]);
  const [major = 0, minor = 0] = node.output.trim().split(".").map(Number);
  if (node.code !== 0) bad("node", `not found on PATH. Perry's server needs Node.js 22.13 or newer`);
  else if (major > 22 || (major === 22 && minor >= 13)) ok("node", node.output.trim());
  else bad("node", `${node.output.trim()} is too old: Perry's server needs 22.13 or newer, for its built-in SQLite`);

  const codex = await runCodex(["--version"]);
  if (codex.code !== 0) {
    bad("codex", `not found on PATH. Install it: ${INSTALL_HINTS.codex}`);
  } else {
    ok("codex", lastLine(codex.output));
    const login = await runCodex(["login", "status"]);
    if (login.code === 0) ok("codex sign-in", lastLine(login.output));
    else warn("codex sign-in", "not signed in. Connect the runner, then sign in on the dashboard's Settings page");

    // Windows's sandbox is set up by Codex itself on first use; elsewhere a real sandboxed write shows it works.
    if (process.platform !== "win32") {
      const probe = mkdtempSync(join(tmpdir(), "perry-doctor-"));
      const sandboxed = await runCodex(["sandbox", "-P", ":workspace", "-C", probe, "--", "/bin/sh", "-c", "echo ok > probe.txt"]);
      const how = process.platform === "darwin" ? "Seatbelt" : "bubblewrap";
      if (sandboxed.code === 0 && existsSync(join(probe, "probe.txt"))) ok("codex sandbox", `workspace-write works (${how})`);
      // Codex 0.106, for one, has no -P; Perry still runs on it, without its skills.
      else if (/unexpected argument/.test(sandboxed.output)) warn("codex sandbox", `this Codex is too old to check. Update it: ${INSTALL_HINTS.codex}`);
      else warn("codex sandbox", `a sandboxed command failed: ${lastLine(sandboxed.output)}. See INSTALL.md, "Codex's sandbox"`);
      rmSync(probe, { recursive: true, force: true });
    }
  }
  try {
    const mode = sandboxMode();
    if (mode !== "workspace-write") warn("PERRY_CODEX_SANDBOX", `Codex runs ${mode}`);
  } catch (error) {
    bad("PERRY_CODEX_SANDBOX", (error as Error).message);
  }

  const runner = readRunnerConfig();
  if (runner.url && runner.token) ok("runner", `${runner.name ?? "this machine"}, working in ${runner.dir ?? "the folder it starts in"}`);
  else warn("runner", "not connected yet; Perry's server connects it when it starts (perry start)");

  const service = serviceState();
  if (service.running) ok("background service", service.detail);
  else if (service.installed) warn("background service", `${service.detail}. Run: pnpm run service start`);
  else note("background service", "not installed (optional): pnpm run service install");
}

async function main() {
  console.log("");

  await checkMachine();
  if (process.argv.includes("--machine")) return finish();

  const env = process.env;

  // Local env
  if (!existsSync(ENV_FILE)) {
    bad(".env.local", "missing. Run: pnpm run setup");
  } else {
    ok(".env.local");
  }

  if (env.DASHBOARD_KEY) ok("dashboard key");
  else bad("dashboard key", "DASHBOARD_KEY not set in .env.local. Run: perry setup");

  // Perry's server: the dashboard and the backend, one process.
  const port = Number(env.PERRY_PORT ?? 3000);
  const health = await fetch(`http://127.0.0.1:${port}/api/backend/http/health`).then((r) => (r.ok ? r.json() : null), () => null);
  if (health?.ok) ok("perry server", `http://127.0.0.1:${port}`);
  else bad("perry server", "not answering. Run: perry start");

  const database = join(HOME, "perry.sqlite");
  if (existsSync(database)) ok("data", `${database} (${Math.round(statSync(database).size / 1024)} KB)`);
  else warn("data", `no database yet in ${HOME}; the server makes it when it starts`);
  if (env.CONVEX_DEPLOYMENT) warn("convex", "this install still names a Convex deployment. Run: perry migrate");

  // Telegram, which Perry polls: a webhook left from before stops that until the server removes it.
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    ok("telegram", "not set up; Perry is used from the dashboard (a bot saved on the Keys page is not checked here)");
  } else {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json(), () => null);
    if (me?.ok) ok("telegram bot", `@${me.result.username}`);
    else bad("telegram bot", me?.description ?? "no response");
    const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then((r) => r.json(), () => null);
    if (info?.ok && info.result.url) warn("telegram", "a webhook is still set; Perry removes it when its server starts");
    else if (info?.ok) ok("telegram", info.result.pending_update_count ? `polling; ${info.result.pending_update_count} messages waiting` : "polling");
  }

  // Ownership, from the running server.
  if (health?.ok && env.DASHBOARD_KEY) {
    const status = await fetch(`http://127.0.0.1:${port}/api/backend/admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-perry-key": env.DASHBOARD_KEY },
      body: JSON.stringify({ path: "installation:status", args: {} }),
    }).then((r) => r.json(), () => null) as { value?: { claimed: boolean; pairingCode?: string } } | null;
    if (!status?.value) warn("ownership", "could not read");
    else if (status.value.claimed) ok("ownership", "claimed");
    else if (!token) ok("ownership", "the dashboard key; there is no bot to claim");
    else warn("ownership", status.value.pairingCode ? `unclaimed. Send ${status.value.pairingCode} to your bot.` : "unclaimed. Run: perry pair");
  }

  finish();
}

function finish() {
  console.log("");
  if (failures === 0) {
    console.log(green("Perry looks healthy.\n"));
  } else {
    console.log(red(`${failures} problem${failures === 1 ? "" : "s"} above.\n`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
