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
import { ensureHome } from "../runner/home";
import { bold, dim, done, INSTALL_HINTS, runCodex, spinner, yellow } from "./lib";

const ENV_FILE = resolve(process.cwd(), ".env.local");

const rl = createInterface({ input: process.stdin, output: process.stdout });

function say(text = "") {
  console.log(text);
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

/**
 * Said in as few lines as it takes: one for each thing that went well, and
 * more only where the owner has something to do or something went wrong.
 */
async function main() {
  say(bold("\nPerry setup"));
  const env = readEnvFile();

  // --- Telegram bot, optional ---------------------------------------------

  /** The bot's @username, or null when Telegram is skipped and Perry is used from the dashboard. */
  const checkToken = async (candidate: string): Promise<string | null> => {
    const asking = await spinner("Checking the token with Telegram…");
    const probe = await fetch(`https://api.telegram.org/bot${candidate}/getMe`).then((r) => r.json(), () => null);
    asking.stop();
    if (probe?.ok) return probe.result.username as string;
    say(yellow(`  Telegram rejected that token: ${probe?.description ?? "no response"}`));
    return null;
  };
  let token: string | undefined = env.TELEGRAM_BOT_TOKEN;
  let botName: string | null = null;
  if (token) {
    botName = await checkToken(token);
    if (!botName) process.exit(1);
  } else {
    say(dim("  Telegram is optional. For a bot: message @BotFather, send /newbot, and paste its token."));
    for (let attempt = 0; attempt < 3 && !botName; attempt++) {
      const answer = (await rl.question("  Bot token, or Enter to skip: ")).trim();
      if (!answer) break;
      if (!answer.includes(":")) { say(yellow("  That does not look like a bot token.")); continue; }
      botName = await checkToken(answer);
      if (botName) token = answer;
    }
    if (!botName) {
      token = undefined;
      say(dim("  No bot: talk to Perry from the dashboard. Add one on the Keys page any time."));
    }
  }
  if (botName) await done(`bot @${botName}`);

  // --- Codex ----------------------------------------------------------------

  // Every reply is a Codex turn on this machine, so a first chat needs Codex signed in before it starts.
  const checking = await spinner("Checking Codex…");
  const codex = await runCodex(["--version"]);
  if (codex.code !== 0) {
    checking.stop();
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
  checking.stop();
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
    await done(`codex ${version}${dim(`, ${signedIn.replace(/^Logged in/i, "signed in")}`)}`);
  } else {
    say(yellow(`  Codex is not signed in, so Perry cannot answer yet. Run ${bold("codex login")}, or sign in from the dashboard's Settings page.`));
  }

  // --- Saving it, without a word unless it fails --------------------------------

  const dashboardKey = env.DASHBOARD_KEY || randomBytes(24).toString("base64url");
  // A Convex install's settings stay until `perry migrate` has brought its data over; these three are gone for good.
  const { TELEGRAM_WEBHOOK_SECRET: _webhook, NEXT_PUBLIC_CONVEX_URL: _url, CONVEX_SITE_URL: _site, ...kept } = env;
  writeEnvFile({ ...kept, TELEGRAM_BOT_TOKEN: token, DASHBOARD_KEY: dashboardKey });
  ensureHome();

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
