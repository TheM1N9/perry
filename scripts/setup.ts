#!/usr/bin/env bun
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

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { ensureHome, HOME } from "../runner/home";
import { bold, dim, green, INSTALL_HINTS, runCodex, runConvex, yellow } from "./lib";


const ENV_FILE = resolve(process.cwd(), ".env.local");


const rl = createInterface({ input: process.stdin, output: process.stdout });

function say(text = "") {
  console.log(text);
}

function step(n: number, total: number, text: string) {
  say(`\n${bold(`[${n}/${total}]`)} ${text}`);
}



function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
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

function writeEnvFile(values: Record<string, string | undefined>) {
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

async function setConvexEnv(name: string, value: string) {
  const { code, output } = await runConvex(["env", "set", name, value]);
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
    say(dim("  Choose \"Login or create an account\": Telegram has to reach your deployment,"));
    say(dim("  which one run locally on this machine cannot be."));
    const { code } = await runConvex(["dev", "--once"], { quiet: false });
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
  if (!cloudUrl.includes(".convex.cloud")) {
    say(yellow(`  This is a local deployment (${cloudUrl}); Telegram cannot reach it.`));
    say(yellow(`  Run ${bold("pnpm exec convex dev --once --configure new")}, choose "Login or create an account", then run setup again.`));
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

  // --- 3. Codex -------------------------------------------------------------
  step(3, TOTAL, "Codex");

  say(dim("  Perry thinks with your ChatGPT subscription, through the Codex CLI on"));
  say(dim("  this machine. Sign in to Codex from the dashboard's Settings page."));
  const codex = await runCodex(["--version"]);
  if (codex.code !== 0) {
    say(yellow(`  Codex is not installed here yet. Install it with: ${INSTALL_HINTS.codex}`));
  } else {
    const login = await runCodex(["login", "status"]);
    say(`  ${green("codex")} ${codex.output.trim().split(/\r?\n/).at(-1)}${login.code === 0 ? dim(", signed in") : dim(", not signed in yet")}`);
  }

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
  });
  say(`  ${green("wrote")} .env.local`);
  say(`  ${green("home")} ${ensureHome() && HOME}`);

  await setConvexEnv("TELEGRAM_BOT_TOKEN", token);
  await setConvexEnv("TELEGRAM_WEBHOOK_SECRET", webhookSecret);
  await setConvexEnv("DASHBOARD_KEY", dashboardKey);

  const deploy = await runConvex(["dev", "--once"]);
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
      allowed_updates: ["message", "edited_message", "callback_query"],
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

  const pair = await runConvex(["run", "installation:startPairing", "{}"]);
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

  rl.close();
  // `perry setup` goes on to connect this computer, start Perry and open the dashboard.
  if (process.argv.includes("--from-perry")) return;

  say(bold("\nNext"));
  say(`  ${bold("pnpm perry start")}  connects this computer, then runs Perry in the background`);
  say(`  dashboard key: ${dashboardKey}`);
  say(dim("\n  (also saved in .env.local; `pnpm perry doctor` checks everything)\n"));
}

main().catch((error) => {
  console.error(error);
  rl.close();
  process.exit(1);
});
