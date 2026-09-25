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
import { hostname } from "node:os";
import { bold, dim, green, INSTALL_HINTS, openUrl, runCodex, runConvex, runConvexShown, yellow } from "./lib";


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

  // Perry's backend is the owner's own Convex project, in Convex's cloud, where Telegram can reach it.
  // The Convex CLI's own onboarding is never shown: every choice it would ask about is made here, with
  // at most one plain question (which team), and anonymous local deployments are off (runConvex).
  const convexUrl = () => env.NEXT_PUBLIC_CONVEX_URL || env.CONVEX_URL || "";
  // The CLI follows the name with a comment ("dev:x # team: y, project: z"), which is not part of it.
  const deploymentName = () => (env.CONVEX_DEPLOYMENT ?? "").replace(/\s+#.*$/, "");
  if (env.CONVEX_DEPLOYMENT && convexUrl().includes(".convex.cloud")) {
    say(dim(`  already configured: ${deploymentName()}`));
  } else {
    if (env.CONVEX_DEPLOYMENT) {
      say(yellow(`  ${deploymentName()} runs on this machine, where Telegram cannot reach it; making one in the cloud instead.`));
      const { CONVEX_DEPLOYMENT: _local, CONVEX_URL: _url, NEXT_PUBLIC_CONVEX_URL: _publicUrl, CONVEX_SITE_URL: _site, ...rest } = env;
      writeEnvFile(rest);
      env = readEnvFile();
    }
    say(dim("  Perry keeps your chats and memory in your own free Convex project."));

    // The CLI's exit codes are unreliable here, so its status line is what counts.
    const status = async () => (await runConvex(["login", "status"])).output;
    if (!/Status: Logged in/.test(await status())) {
      say(dim("  Log in to Convex in the browser window that opens (GitHub or Google works):\n"));
      let opened = false;
      // The CLI has the terminal while it runs (it may ask to accept Convex's terms), so setup stops reading it.
      rl.pause();
      await runConvexShown(["login", "--device-name", `Perry on ${hostname()}`, "--no-open"], (text) => {
        const link = text.match(/Visit (https:\/\/\S+) to finish logging in/)?.[1];
        if (link && !opened) { opened = true; void openUrl(link); }
      });
      rl.resume();
      if (!/Status: Logged in/.test(await status())) {
        say(yellow("\n  Convex login did not finish. Run setup again to retry."));
        process.exit(1);
      }
    }

    const teams = [...(await status()).matchAll(/^\s*- (.+) \(([^()\s]+)\)\s*$/gm)].map((m) => ({ name: m[1], slug: m[2] }));
    let team = teams[0];
    if (teams.length > 1) {
      say(`\n  Which Convex team should Perry's project be in?`);
      teams.forEach((option, index) => say(`    ${index + 1}. ${option.name}`));
      const picked = Number((await rl.question("  Team [1]: ")).trim() || "1");
      team = teams[picked - 1] ?? teams[0];
    }
    if (!team) {
      say(yellow("  Your Convex account has no team yet. Open https://dashboard.convex.dev once, then run setup again."));
      process.exit(1);
    }

    // A new project each time: reusing one named perry could attach this install to another machine's Perry.
    say(dim(`  Creating the project "perry" in ${team.name}…`));
    const made = await runConvex(["dev", "--once", "--configure", "new", "--team", team.slug, "--project", "perry", "--dev-deployment", "cloud"]);
    env = readEnvFile();
    if (!convexUrl().includes(".convex.cloud")) {
      say(yellow("  Creating the Convex project failed:"));
      say(dim(made.output.split(/\r?\n/).filter((line) => line.trim()).slice(-8).join("\n")));
      process.exit(1);
    }
    say(`  ${green("created")} ${deploymentName()}`);
  }

  const cloudUrl = convexUrl();
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
