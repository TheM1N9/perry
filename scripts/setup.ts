#!/usr/bin/env bun
/**
 * One command to install Perry: `pnpm run setup`, run by `perry setup`.
 *
 * Everything this touches belongs to whoever runs it: your bot, your keys,
 * your data, all on this computer. Nothing is shared with anyone, including
 * whoever handed you this repo, and no account is needed but Codex's.
 *
 * Safe to re-run. It keeps what is already configured and only asks for what
 * is missing.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { ensureHome, HOME } from "../runner/home";
import { bold, dim, green, INSTALL_HINTS, runCodex, yellow } from "./lib";

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
    "# Perry, local env. Gitignored. Written by `perry setup`.",
    "# The dashboard's server, which is also Perry's backend, reads it.",
    "",
  ];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf8");
}

async function main() {
  say(bold("\nPerry setup"));
  say(
    dim(
      "Your computer, your bot, your keys, your data.\n" +
        "Perry can read and write your memory, and in Agent P mode it can act\n" +
        "on whatever you connect. Only you will be able to talk to it.",
    ),
  );

  const TOTAL = 3;
  const env = readEnvFile();

  // --- 1. Telegram bot, optional ------------------------------------------
  step(1, TOTAL, "Telegram bot (optional)");

  /** The bot's @username, or null when Telegram is skipped and Perry is used from the dashboard. */
  const checkToken = async (candidate: string): Promise<string | null> => {
    const probe = await fetch(`https://api.telegram.org/bot${candidate}/getMe`).then((r) => r.json(), () => null);
    if (probe?.ok) return probe.result.username as string;
    say(yellow(`  Telegram rejected that token: ${probe?.description ?? "no response"}`));
    return null;
  };
  let token: string | undefined = env.TELEGRAM_BOT_TOKEN;
  let botName: string | null = null;
  if (token) {
    botName = await checkToken(token);
    if (!botName) process.exit(1);
    say(dim("  already configured"));
  } else {
    say(dim("  Talk to Perry from Telegram too, or only from the dashboard. For Telegram:"));
    say(dim("  message @BotFather, send /newbot, answer two questions, and paste the"));
    say(dim("  token it gives you (like 8123456789:AAH...). You can add one later on the Keys page."));
    for (let attempt = 0; attempt < 3 && !botName; attempt++) {
      const answer = (await rl.question("\n  Bot token, or Enter to skip: ")).trim();
      if (!answer) break;
      if (!answer.includes(":")) { say(yellow("  That does not look like a bot token.")); continue; }
      botName = await checkToken(answer);
      if (botName) token = answer;
    }
    if (!botName) {
      token = undefined;
      say(dim("  Skipped: Perry is yours from the dashboard. Add a bot on the Keys page whenever you like."));
    }
  }
  if (botName) say(`  ${green("bot")} @${botName}`);

  // --- 2. Codex -------------------------------------------------------------
  step(2, TOTAL, "Codex");

  // Every reply is a Codex turn on this machine, so a first chat needs Codex signed in before it starts.
  say(dim("  Perry thinks with your ChatGPT subscription, through the Codex CLI on this machine."));
  const codex = await runCodex(["--version"]);
  if (codex.code !== 0) {
    say(yellow(`  Codex is not installed here. Install it with: ${INSTALL_HINTS.codex}`));
    say(yellow("  Then run setup again."));
    process.exit(1);
  }
  const version = (codex.output.trim().split(/\r?\n/).at(-1) ?? "").replace(/^codex-cli\s+/, "");
  // `codex login status` exits 0 and says "Logged in using ChatGPT" (or an API key) once signed in.
  const codexStatus = async () => {
    const ran = await runCodex(["login", "status"]);
    return ran.code === 0 && /Logged in/i.test(ran.output) ? ran.output.trim().split(/\r?\n/).at(-1) ?? "" : null;
  };
  let signedIn = await codexStatus();
  if (!signedIn) {
    // No display to open a browser on (a server, or over SSH): Codex's device code, entered on any device.
    const headless = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY) || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
    rl.pause();
    if (!headless) {
      say(dim("  Sign in with your ChatGPT account in the browser window that opens.\n"));
      await runCodex(["login"], { quiet: false });
      signedIn = await codexStatus();
    }
    if (!signedIn) {
      say(dim(`\n  ${headless ? "No browser here" : "The browser sign-in did not finish"}; signing in with a code instead.\n`));
      await runCodex(["login", "--device-auth"], { quiet: false });
      signedIn = await codexStatus();
    }
    rl.resume();
  }
  if (signedIn) {
    say(`  ${green("codex")} ${version}${dim(`, ${signedIn.replace(/^Logged in/i, "signed in")}`)}`);
  } else {
    say(yellow(`  Codex is not signed in, so Perry cannot answer yet. Run ${bold("codex login")}, or sign in from the dashboard's Settings page.`));
  }

  // --- 3. Saving it -----------------------------------------------------------
  step(3, TOTAL, "Saving it");

  const dashboardKey = env.DASHBOARD_KEY || randomBytes(24).toString("base64url");
  // A Convex install's settings stay until `perry migrate` has brought its data over; these three are gone for good.
  const { TELEGRAM_WEBHOOK_SECRET: _webhook, NEXT_PUBLIC_CONVEX_URL: _url, CONVEX_SITE_URL: _site, ...kept } = env;
  writeEnvFile({ ...kept, TELEGRAM_BOT_TOKEN: token, DASHBOARD_KEY: dashboardKey });
  say(`  ${green("wrote")} .env.local`);
  say(`  ${green("home")} ${ensureHome() && HOME}${dim("  (your chats, memory and files live here)")}`);

  rl.close();
  // `perry setup` goes on to start Perry, pair the bot and open the dashboard.
  if (process.argv.includes("--from-perry")) return;

  say(bold("\nNext"));
  say(`  ${bold("pnpm perry start")}  runs Perry in the background`);
  say(`  dashboard key: ${dashboardKey}`);
  say(dim("\n  (also saved in .env.local; `pnpm perry doctor` checks everything)\n"));
}

main().catch((error) => {
  console.error(error);
  rl.close();
  process.exit(1);
});
