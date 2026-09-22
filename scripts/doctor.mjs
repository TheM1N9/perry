#!/usr/bin/env node
/**
 * `pnpm run doctor` — check every moving part and say which one is broken.
 *
 * Reports only. It changes nothing, so it is safe to run when you are not sure
 * what state an install is in.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Call the Convex CLI through this same Node binary rather than npx.
 * Windows refuses to spawn a .cmd without a shell, and a shell needs quoting,
 * and quoting secrets on a command line is how secrets get mangled.
 */
const CONVEX_CLI = resolve(process.cwd(), "node_modules/convex/bin/main.js");

const ENV_FILE = resolve(process.cwd(), ".env.local");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failures = 0;

function ok(label, detail = "") {
  console.log(`${green("ok")}    ${label}${detail ? dim(`  ${detail}`) : ""}`);
}
function bad(label, detail = "") {
  failures += 1;
  console.log(`${red("fail")}  ${label}${detail ? `  ${detail}` : ""}`);
}
function warn(label, detail = "") {
  console.log(`${yellow("warn")}  ${label}${detail ? dim(`  ${detail}`) : ""}`);
}

function readEnvFile() {
  const values = {};
  if (!existsSync(ENV_FILE)) return values;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

function run(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("close", (code) => resolvePromise({ code, output: out }));
  });
}

/** The Convex CLI, run in-process by path. */
function runConvex(args, options) {
  return run(process.execPath, [CONVEX_CLI, ...args], options);
}

async function main() {
  console.log("");

  const env = readEnvFile();

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
    for (const required of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "DASHBOARD_KEY",
    ]) {
      if (names.has(required)) ok(`env ${required}`);
      else bad(`env ${required}`, "not set. Run: pnpm run setup");
    }
    if (names.has("AI_GATEWAY_API_KEY")) ok("gateway", "vercel");
    else ok("gateway", "convex (no key needed)");
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
    bad("telegram token", "not in .env.local");
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
  } else {
    const code = status.output.match(/"pairingCode":\s*"(\d{6})"/)?.[1];
    warn(
      "ownership",
      code ? `unclaimed. Send ${code} to your bot.` : "unclaimed. Run: pnpm run pair",
    );
  }

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
