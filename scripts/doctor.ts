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

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sandboxMode } from "../runner/codex";
import { readRunnerConfig } from "../runner/home";
import { dim, green, INSTALL_HINTS, red, runCodex, runConvex, yellow } from "./lib";
import { serviceState } from "./service";

/**
 * Call the Convex CLI through this same Node binary rather than npx.
 * Windows refuses to spawn a .cmd without a shell, and a shell needs quoting,
 * and quoting secrets on a command line is how secrets get mangled.
 */

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
  else warn("runner", "not connected. Run: pnpm run connect");

  const service = serviceState();
  if (service.running) ok("background service", service.detail);
  else if (service.installed) warn("background service", `${service.detail}. Run: pnpm run service start`);
  else note("background service", "not installed (optional): pnpm run service install");
}



/** The Convex CLI, run in-process by path. */

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

  const cloudUrl = env.NEXT_PUBLIC_CONVEX_URL;
  if (cloudUrl) ok("convex url", cloudUrl);
  else bad("convex url", "NEXT_PUBLIC_CONVEX_URL not set. Run: pnpm run setup");

  // Deployment env vars
  const list = await runConvex(["env", "list"]);
  if (list.code !== 0) {
    bad("convex deployment", "cannot reach it. Is `pnpm exec convex dev` configured?");
  } else {
    const names = new Set(
      list.output
        .split("\n")
        .map((l) => l.split("=")[0].trim())
        .filter(Boolean),
    );
    for (const required of ["TELEGRAM_WEBHOOK_SECRET", "DASHBOARD_KEY"]) {
      if (names.has(required)) ok(`env ${required}`);
      else bad(`env ${required}`, "not set. Run: perry setup");
    }
    // Telegram is optional: without a bot, Perry is used from the dashboard.
    if (names.has("TELEGRAM_BOT_TOKEN")) ok("env TELEGRAM_BOT_TOKEN");
    else ok("env TELEGRAM_BOT_TOKEN", "not set: Telegram is off (optional; a bot saved on the Keys page is not checked here)");
  }

  // HTTP actions reachable
  const siteUrl = env.CONVEX_SITE_URL || cloudUrl?.replace(".convex.cloud", ".convex.site");
  if (siteUrl) {
    const health = await fetch(`${siteUrl}/health`).then(
      (r) => (r.ok ? r.json() : null),
      () => null,
    );
    if (health?.ok) ok("http actions", `${siteUrl}/health`);
    else bad("http actions", "not answering. Run: pnpm exec convex dev --once");
  }

  // Telegram webhook
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    ok("telegram", "not set up; Perry is used from the dashboard");
  } else {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(
      (r) => r.json(),
      () => null,
    );
    if (me?.ok) ok("telegram bot", `@${me.result.username}`);
    else bad("telegram bot", me?.description ?? "no response");

    const info = await fetch(
      `https://api.telegram.org/bot${token}/getWebhookInfo`,
    ).then((r) => r.json(), () => null);

    if (!info?.ok) {
      bad("webhook", "could not read it");
    } else if (!info.result.url) {
      bad("webhook", "not registered. Run: pnpm run webhook:set");
    } else {
      ok("webhook", info.result.url);
      if (info.result.last_error_message) {
        warn("webhook delivery", info.result.last_error_message);
      }
      if (info.result.pending_update_count > 0) {
        warn("webhook queue", `${info.result.pending_update_count} pending`);
      }
    }
  }

  // Ownership
  const status = await runConvex(["run", "installation:status", "{}"]);
  if (status.code !== 0) {
    warn("ownership", "could not read");
  } else if (/"claimed":\s*true/.test(status.output)) {
    ok("ownership", "claimed");
  } else if (!token) {
    ok("ownership", "the dashboard key; there is no bot to claim");
  } else {
    const code = status.output.match(/"pairingCode":\s*"(\d{6})"/)?.[1];
    warn(
      "ownership",
      code ? `unclaimed. Send ${code} to your bot.` : "unclaimed. Run: pnpm run pair",
    );
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
