#!/usr/bin/env node
/**
 * One command to install Perry: `pnpm run setup`.
 *
 * Everything this touches belongs to whoever runs it. Your own Convex
 * deployment, your own bot, your own keys, your own data. Nothing is shared
 * with anyone, including whoever handed you this repo.
 *
 * Safe to re-run. It keeps what is already configured and only asks for what
 * is missing.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { ensureHome, HOME } from "../runner/home.mjs";

/**
 * Call the Convex CLI through this same Node binary rather than npx.
 * Windows refuses to spawn a .cmd without a shell, and a shell needs quoting,
 * and quoting secrets on a command line is how secrets get mangled.
 */
const CONVEX_CLI = resolve(process.cwd(), "node_modules/convex/bin/main.js");

const ENV_FILE = resolve(process.cwd(), ".env.local");

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const rl = createInterface({ input: process.stdin, output: process.stdout });

function say(text = "") {
  console.log(text);
}

function step(n, total, text) {
  say(`\n${bold(`[${n}/${total}]`)} ${text}`);
}

/** Run a command, streaming its output. Resolves with the exit code. */
function run(command, args, { quiet = false } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let buffered = "";
    if (quiet) {
      child.stdout?.on("data", (d) => (buffered += d));
      child.stderr?.on("data", (d) => (buffered += d));
    }
    child.on("close", (code) => resolvePromise({ code, output: buffered }));
  });
}

/** The Convex CLI, run in-process by path. */
function runConvex(args, options) {
  return run(process.execPath, [CONVEX_CLI, ...args], options);
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

function writeEnvFile(values) {
  const lines = [
    "# Perry, local env. Gitignored. Written by `pnpm run setup`.",
    "# Deployment secrets live on Convex; these are the local copies the",
    "# scripts need.",
    "",
  ];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf8");
}

async function setConvexEnv(name, value) {
  const { code, output } = await runConvex(["env", "set", name, value],
    { quiet: true },
  );
  if (code !== 0) {
    say(yellow(`  could not set ${name}`));
    say(dim(output.split("\n").slice(-4).join("\n")));
    return false;
  }
  say(`  ${green("set")} ${name}`);
  return true;
}

async function main() {
  say(bold("\nPerry setup"));
  say(
    dim(
      "Your deployment, your bot, your keys, your data.\n" +
        "Perry can read and write your memory, and in Agent P mode it can act\n" +
        "on whatever you connect. Only you will be able to talk to it.",
    ),
  );

  const TOTAL = 5;
  let env = readEnvFile();

  // --- 1. Convex deployment ------------------------------------------------
  step(1, TOTAL, "Convex deployment");

  if (env.CONVEX_DEPLOYMENT) {
    say(dim(`  already configured: ${env.CONVEX_DEPLOYMENT}`));
  } else {
    say(dim("  Opening a browser to log in and create your project."));
    const { code } = await runConvex(["dev", "--once"]);
    if (code !== 0) {
      say(yellow("\n  Convex setup did not finish. Fix the error above and re-run."));
      process.exit(1);
    }
    env = readEnvFile();
  }

  const cloudUrl = env.NEXT_PUBLIC_CONVEX_URL || env.CONVEX_URL;
  if (!cloudUrl) {
    say(yellow("  No Convex URL in .env.local. Run `pnpm exec convex dev` once, then re-run."));
    process.exit(1);
  }
  const siteUrl = cloudUrl.replace(".convex.cloud", ".convex.site");
  say(dim(`  webhook host: ${siteUrl}`));

  // --- 2. Telegram bot -----------------------------------------------------
  step(2, TOTAL, "Telegram bot");

  let token = env.TELEGRAM_BOT_TOKEN;
  if (token) {
    say(dim("  already configured"));
  } else {
    say(dim("  Open Telegram, message @BotFather, send /newbot, answer two"));
    say(dim("  questions. It gives you a token like 8123456789:AAH..."));
    token = (await rl.question("\n  Paste the bot token: ")).trim();
    if (!token.includes(":")) {
      say(yellow("  That does not look like a bot token."));
      process.exit(1);
    }
  }

  const probe = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(
    (r) => r.json(),
    () => null,
  );
  if (!probe?.ok) {
    say(yellow(`  Telegram rejected that token: ${probe?.description ?? "no response"}`));
    process.exit(1);
  }
  say(`  ${green("bot")} @${probe.result.username}`);

  // --- 3. Model access -----------------------------------------------------
  step(3, TOTAL, "Model access");

  let gatewayKey = env.AI_GATEWAY_API_KEY ?? "";
  if (gatewayKey) {
    say(dim("  using your Vercel AI Gateway key"));
  } else {
    say(dim("  Perry uses Convex's own AI gateway by default, which needs no"));
    say(dim("  extra signup. A Vercel AI Gateway key works too if you have one."));
    gatewayKey = (
      await rl.question("\n  Vercel AI Gateway key, or blank for Convex: ")
    ).trim();
  }
  say(`  ${green("gateway")} ${gatewayKey ? "vercel" : "convex"}`);

  // --- 4. Secrets and deploy ----------------------------------------------
  step(4, TOTAL, "Pushing config");

  const webhookSecret =
    env.TELEGRAM_WEBHOOK_SECRET || randomBytes(32).toString("hex");
  const dashboardKey = env.DASHBOARD_KEY || randomBytes(24).toString("base64url");

  writeEnvFile({
    ...env,
    NEXT_PUBLIC_CONVEX_URL: cloudUrl,
    CONVEX_SITE_URL: siteUrl,
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    DASHBOARD_KEY: dashboardKey,
    ...(gatewayKey ? { AI_GATEWAY_API_KEY: gatewayKey } : {}),
  });
  say(`  ${green("wrote")} .env.local`);
  say(`  ${green("home")} ${ensureHome() && HOME}`);

  await setConvexEnv("TELEGRAM_BOT_TOKEN", token);
  await setConvexEnv("TELEGRAM_WEBHOOK_SECRET", webhookSecret);
  await setConvexEnv("DASHBOARD_KEY", dashboardKey);
  if (gatewayKey) await setConvexEnv("AI_GATEWAY_API_KEY", gatewayKey);

  const deploy = await runConvex(["dev", "--once"], { quiet: true });
  if (deploy.code !== 0) {
    say(yellow("  Push failed:"));
    say(dim(deploy.output.split("\n").slice(-8).join("\n")));
    process.exit(1);
  }
  say(`  ${green("pushed")} functions`);

  const hook = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${siteUrl}/telegram`,
      secret_token: webhookSecret,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: true,
    }),
  }).then((r) => r.json(), () => null);

  if (!hook?.ok) {
    say(yellow(`  Webhook failed: ${hook?.description ?? "no response"}`));
    process.exit(1);
  }
  say(`  ${green("webhook")} ${siteUrl}/telegram`);

  // --- 5. Pair ------------------------------------------------------------
  step(5, TOTAL, "Claim it");

  const pair = await runConvex(["run", "installation:startPairing", "{}"],
    { quiet: true },
  );
  const code = pair.output.match(/"code":\s*"(\d{6})"/)?.[1];

  if (!code) {
    say(yellow("  Could not mint a pairing code. Run `pnpm run pair` to retry."));
  } else {
    say("");
    say(`  Message ${bold("@" + probe.result.username)} on Telegram with:`);
    say(`\n      ${bold(green(code))}\n`);
    say(dim("  It expires in an hour. Whoever sends it first owns this Perry;"));
    say(dim("  everyone else is ignored from then on."));
  }

  say(bold("\nDashboard"));
  say(`  pnpm run dev  then open http://localhost:3000`);
  say(`  key: ${dashboardKey}`);
  say(dim("\n  (also saved in .env.local; `pnpm run doctor` checks everything)\n"));

  rl.close();
}

main().catch((error) => {
  console.error(error);
  rl.close();
  process.exit(1);
});
