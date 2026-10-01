#!/usr/bin/env bun
/**
 * One command to install Perry: `pnpm run setup`, run by `perry setup`.
 *
 * Everything this touches belongs to whoever runs it: your bot, your keys,
 * your data, all on this computer. Nothing is shared with anyone, including
 * whoever handed you this repo, and no account is needed but the one of the
 * engine you choose.
 *
 * Safe to re-run. It keeps what is already configured and only asks for what
 * is missing.
 *
 * The engine Perry thinks with is the owner's choice, never this script's:
 * it lists each one as installed and signed in or not, asks which should be
 * the default, and offers to install and sign in to that one. With exactly
 * one ready it is offered first, and still confirmed. Without a terminal to
 * ask in, `--engine <codex|claude|grok|antigravity>` or PERRY_ENGINE says
 * which, and without either it stops rather than guess.
 */

import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, join, resolve } from "node:path";
import { ENGINE_LABELS, isRunnable, RUNNABLE_ENGINES, updateOf, type EngineKind } from "../convex/lib/engines";
import type { Engine, EngineStatus } from "../runner/engine";
import { createEngines } from "../runner/engines";
import { findClaude } from "../runner/engines/claude";
import { commandOf } from "../runner/engines/process";
import { ensureHome, HOME, PATHS } from "../runner/home";
import { latestVersionNow, updateCommand } from "../runner/versions";
import { bold, callPerry, dim, done, INSTALL_COMMANDS, run, runOnPath, runShell, spinner, yellow } from "./lib";

const ENV_FILE = resolve(process.cwd(), ".env.local");

function say(text = "") {
  console.log(text);
}

// --- Questions --------------------------------------------------------------

/**
 * What the owner types, or a script pipes in, a line per question. Lines that
 * come before their question wait for it, so a piped answer is never lost.
 * Null once there is nothing more to read: there is no one to ask.
 */
const input = createInterface({ input: process.stdin });
const typed: string[] = [];
let waiting: ((line: string | null) => void) | null = null;
let ended = false;
input.on("line", (line) => {
  if (waiting) { const answer = waiting; waiting = null; answer(line); } else typed.push(line);
});
input.on("close", () => {
  ended = true;
  if (waiting) { const answer = waiting; waiting = null; answer(null); }
});

function ask(question: string): Promise<string | null> {
  process.stdout.write(question);
  if (typed.length) { const line = typed.shift()!; process.stdout.write("\n"); return Promise.resolve(line); }
  if (ended) { process.stdout.write("\n"); return Promise.resolve(null); }
  // A piped answer is not echoed as a typed one is: the line ends here instead, so what follows starts on its own.
  return new Promise((answer) => { waiting = (line) => { if (!process.stdin.isTTY) process.stdout.write("\n"); answer(line); }; });
}

/** Yes or no, Enter being yes. With no one to answer, `alone` says what happens. */
async function confirm(question: string, alone: boolean): Promise<boolean> {
  const answer = await ask(`${question} [Y/n] `);
  if (answer === null) return alone;
  return !/^\s*n/i.test(answer);
}

/** A command that takes the terminal for a while (a sign-in): what is typed goes to it, not to these questions. */
async function handOver<T>(work: () => Promise<T>): Promise<T> {
  input.pause();
  try { return await work(); } finally { input.resume(); }
}

// --- .env.local ---------------------------------------------------------------

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

// --- Engines --------------------------------------------------------------------

/** What `--engine` and PERRY_ENGINE take: an engine's kind, or its name as Perry shows it. */
function engineNamed(name: string): EngineKind | undefined {
  const wanted = name.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return RUNNABLE_ENGINES.find((kind) => kind === wanted || ENGINE_LABELS[kind].toLowerCase().replace(/\s+/g, "") === wanted);
}

/** `--engine claude` or `--engine=claude`. */
function engineFlag(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--engine") return args[i + 1] ?? "";
    if (args[i].startsWith("--engine=")) return args[i].slice("--engine=".length);
  }
  return undefined;
}

/** Ready to answer: installed, signed in, and not older than Perry works with. */
const ready = (status: EngineStatus) => status.installed && status.signedIn && updateOf(status)?.need !== "required";

/** One line on how an engine stands here, as Settings → Engines says it. */
function standing(status: EngineStatus): string {
  const version = status.version ? `${status.version}, ` : "";
  if (status.kind === "antigravity") {
    return status.signedIn ? `experimental, on with ${status.auth.label ?? "its sign-in"}` : "experimental, not turned on; Settings → Engines turns it on";
  }
  if (!status.installed) return "not installed";
  const update = updateOf(status);
  if (update?.need === "required") return `${update.version}, too old for Perry (needs ${update.minimum} or newer)`;
  if (!status.signedIn) return `${version}not signed in`;
  const plan = status.auth.plan ? ` ${status.auth.plan[0].toUpperCase()}${status.auth.plan.slice(1)}` : "";
  return `${version}signed in with ${status.auth.label ?? "an account"}${plan}`;
}

/** Every engine's status here, side by side; each probe is the runner's own (runner/engines). */
async function look(engines: Map<EngineKind, Engine>): Promise<Map<EngineKind, EngineStatus>> {
  const found = await Promise.all([...engines.values()].map(async (engine) => [engine.kind, await engine.status().catch((error): EngineStatus => ({
    kind: engine.kind, installed: false, signedIn: false, auth: {}, models: [], error: error instanceof Error ? error.message : String(error),
  }))] as const));
  return new Map(found.filter(([kind]) => isRunnable(kind)));
}

/** One engine looked at afresh, after it was installed or signed in: a new probe, not one that remembers failing a moment ago. */
async function lookAgain(kind: EngineKind): Promise<EngineStatus> {
  const engines = createEngines({ warn: () => {} });
  try {
    return (await look(new Map([[kind, engines.get(kind)!]]))).get(kind)!;
  } finally {
    for (const engine of engines.values()) engine.kill();
  }
}

/**
 * The command that installs an engine here. npm's global folder where it is
 * this user's to write; else, as install.sh does, Perry's own (~/.perry/npm),
 * so nothing needs root, put on this run's PATH to be found.
 */
async function installLine(kind: EngineKind): Promise<string | undefined> {
  const line = INSTALL_COMMANDS[kind];
  if (!line?.startsWith("npm ") || process.platform === "win32") return line;
  const prefix = (await runOnPath("npm", ["prefix", "-g"])).output.trim();
  try {
    accessSync(prefix, constants.W_OK);
    return line;
  } catch {
    const own = join(HOME, "npm");
    process.env.PATH = `${process.env.PATH}${delimiter}${join(own, "bin")}`;
    return `${line} --prefix "${own}"`;
  }
}

/** No display to open a browser on (a server, or over SSH): a sign-in goes by a device code, entered on any device. */
const headless = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY) || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

/** Sign in to an engine with its own CLI, in this terminal. False when it has no sign-in here. */
async function signIn(kind: EngineKind): Promise<boolean> {
  if (kind === "codex") {
    if (!headless) {
      say(dim("  Sign in with your ChatGPT account in the browser window that opens.\n"));
      await runOnPath("codex", ["login"], { quiet: false });
      if ((await lookAgain(kind)).signedIn) return true;
      say(dim("\n  The browser sign-in did not finish; signing in with a code instead.\n"));
    }
    await runOnPath("codex", ["login", "--device-auth"], { quiet: false });
    return true;
  }
  if (kind === "claude") {
    const claude = findClaude();
    if (!claude) return false;
    say(dim("  Signing in to Claude Code with its own sign-in.\n"));
    await run(claude.command, [...claude.prefix, "auth", "login"], { quiet: false });
    return true;
  }
  if (kind === "grok") {
    const grok = commandOf("PERRY_GROK_COMMAND", "grok");
    say(dim("  Signing in to Grok Build with its own sign-in.\n"));
    await runOnPath(grok.command, [...grok.args, "login", ...(headless ? ["--device-auth"] : [])], { quiet: false });
    return true;
  }
  // Antigravity is turned on from Settings, where its Gemini API key is kept.
  return false;
}

/**
 * Which engine Perry uses by default: the one named with --engine or
 * PERRY_ENGINE, else the one already chosen, else the owner's answer. Then
 * that engine installed and signed in, if the owner wants. Null when there is
 * no one to ask and nothing names one: setup stops rather than guess.
 */
async function chooseEngine(): Promise<{ engine: EngineKind; chosen: boolean; live: boolean } | null> {
  const named = engineFlag() ?? process.env.PERRY_ENGINE;
  const requested = named === undefined ? undefined : engineNamed(named);
  if (named !== undefined && !requested) {
    say(yellow(`  "${named}" is not an engine Perry runs. Choose one of: ${RUNNABLE_ENGINES.join(", ")}.`));
    process.exit(1);
  }
  // What is chosen already: on the running server, else what an earlier setup left for it.
  const status = await callPerry<{ defaultEngine?: EngineKind }>("installation:status");
  let pending: EngineKind | undefined;
  try { pending = existsSync(PATHS.engineChoice) ? engineNamed(String(JSON.parse(readFileSync(PATHS.engineChoice, "utf8")).engine ?? "")) : undefined; } catch {}
  const current = status?.value.defaultEngine ?? pending;

  const looking = await spinner("Looking for engines on this computer…");
  const engines = createEngines({ warn: () => {} });
  let statuses: Map<EngineKind, EngineStatus>;
  try {
    statuses = await look(engines);
  } finally {
    for (const engine of engines.values()) engine.kill();
  }
  looking.stop();

  let engine = requested ?? current;
  if (!engine) {
    // Ready ones first, then a sign-in away, then the rest, by name: no order favours one engine.
    const rank = (item: EngineStatus) => ready(item) ? 0 : item.installed && updateOf(item)?.need !== "required" ? 1 : 2;
    const listed = [...statuses.values()].sort((a, b) => rank(a) - rank(b) || ENGINE_LABELS[a.kind].localeCompare(ENGINE_LABELS[b.kind]));
    const width = Math.max(...listed.map((item) => ENGINE_LABELS[item.kind].length));
    say(`  Perry thinks with a coding agent on this computer, signed in with your own subscription.`);
    for (const [index, item] of listed.entries()) {
      say(`    ${bold(String(index + 1))}  ${ENGINE_LABELS[item.kind].padEnd(width)}  ${dim(standing(item))}`);
    }
    const readyOnes = listed.filter(ready);
    const offered = readyOnes.length === 1 ? readyOnes[0].kind : undefined;
    const range = `1-${listed.length}`;
    for (let attempt = 0; attempt < 3 && !engine; attempt++) {
      const answer = await ask(`  Which should Perry use by default? [${range}${offered ? `, Enter for ${ENGINE_LABELS[offered]}` : ""}] `);
      if (answer === null) {
        say(yellow("  Perry needs you to choose its default engine, and there is no one here to answer."));
        say(yellow(`  Run setup again with --engine <${RUNNABLE_ENGINES.join("|")}>, or set PERRY_ENGINE.`));
        return null;
      }
      const trimmed = answer.trim();
      const number = Number(trimmed);
      engine = !trimmed ? offered
        : Number.isInteger(number) && number >= 1 && number <= listed.length ? listed[number - 1].kind
        : engineNamed(trimmed);
      if (!engine) say(yellow(`  Answer with a number from ${range}, or an engine's name.`));
    }
    if (!engine) {
      say(yellow(`  No engine chosen. Run setup again, or name one with --engine <${RUNNABLE_ENGINES.join("|")}>.`));
      return null;
    }
  }
  const label = ENGINE_LABELS[engine];
  let found = statuses.get(engine) ?? await lookAgain(engine);

  // Not installed: offered, and run; with no one to answer, the engine named for it is installed.
  if (!found.installed) {
    const command = await installLine(engine);
    if (!command) { say(yellow(`  ${label} can't be installed from here.`)); process.exit(1); }
    if (!(await confirm(`  ${label} isn't installed here. Install it now? It runs: ${command}`, true))) {
      say(yellow(`  Install it with: ${command}`));
      say(yellow("  Then run setup again."));
      process.exit(1);
    }
    const installing = await spinner(`Installing ${label}…`);
    const installed = await runShell(command);
    if (installed.code !== 0) {
      installing.fail(yellow(`Installing ${label} failed:`));
      say(dim(installed.output.trim().split(/\r?\n/).slice(-8).join("\n")));
      say(yellow(`  Install it yourself with: ${command}, then run setup again.`));
      process.exit(1);
    }
    installing.stop();
    found = await lookAgain(engine);
    if (!found.installed) {
      say(yellow(`  ${label} installed, but this terminal can't find it yet. Open a new terminal and run setup again.`));
      process.exit(1);
    }
  }
  // Older than Perry works with, it could not answer: updating comes first. Behind the newest release, it is only said.
  const update = updateOf({ ...found, latest: await latestVersionNow(engine, 3_000), update: found.update ?? updateCommand(engine) });
  if (update?.need === "required") {
    say(yellow(`  ${label} ${update.version} is too old for Perry, which needs ${update.minimum} or newer. Update it with: ${update.command}`));
    say(yellow("  Then run setup again."));
    process.exit(1);
  }
  if (!found.signedIn) {
    if (engine === "antigravity") {
      say(dim("  Antigravity is turned on in Settings → Engines once Perry runs: it downloads Google's server, then takes a Gemini API key or a Google sign-in."));
    } else if (await confirm(`  ${label} isn't signed in. Sign in now?`, false) && await handOver(() => signIn(engine))) {
      found = await lookAgain(engine);
    }
  }
  if (update) say(yellow(`  ${label} ${update.latest} is out. To update: ${update.command}`));
  if (found.signedIn) await done(`default engine ${label}${dim(`, ${standing(found)}`)}`);
  else {
    await done(`default engine ${label}`);
    say(yellow(`  ${label} isn't signed in, so Perry can't answer yet. Sign in from the dashboard's Settings → Engines.`));
  }
  // live: the running server already has it, so nothing needs to wait for it.
  return { engine, chosen: engine !== current, live: status?.value.defaultEngine === engine };
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
      const answer = (await ask("  Bot token, or Enter to skip: "))?.trim();
      if (!answer) break;
      if (!answer.includes(":")) { say(yellow("  That does not look like a bot token.")); continue; }
      botName = await checkToken(answer);
      if (botName) token = answer;
    }
    if (!botName) {
      token = undefined;
      say(dim("  No bot: talk to Perry from the dashboard. Add one in Settings → Telegram any time."));
    }
  }
  if (botName) await done(`bot @${botName}`);

  // --- The default engine ------------------------------------------------------

  const choice = await chooseEngine();
  if (!choice) process.exit(1);

  // --- Saving it, without a word unless it fails --------------------------------

  const dashboardKey = env.DASHBOARD_KEY || randomBytes(24).toString("base64url");
  // A Convex install's settings stay until `perry migrate` has brought its data over; these three are gone for good.
  const { TELEGRAM_WEBHOOK_SECRET: _webhook, NEXT_PUBLIC_CONVEX_URL: _url, CONVEX_SITE_URL: _site, ...kept } = env;
  writeEnvFile({ ...kept, TELEGRAM_BOT_TOKEN: token, DASHBOARD_KEY: dashboardKey });
  ensureHome();
  // A new choice goes to the running server, or waits in Perry's home for it to start (server/index.ts).
  // Once the running server has the choice, one left waiting from before would only undo it at the next start.
  const saved = choice.chosen ? Boolean(await callPerry("installation:setDefaultEngine", { engine: choice.engine })) : choice.live;
  if (saved) rmSync(PATHS.engineChoice, { force: true });
  else if (choice.chosen) writeFileSync(PATHS.engineChoice, JSON.stringify({ engine: choice.engine }), "utf8");

  input.close();
  // `perry setup` goes on to start Perry, pair the bot and open the dashboard.
  if (process.argv.includes("--from-perry")) return;

  say(bold("\nNext"));
  say(`  ${bold("pnpm perry start")}  runs Perry in the background`);
  say(`  dashboard key: ${dashboardKey}`);
  say(dim("\n  (also saved in .env.local; `pnpm perry doctor` checks everything)\n"));
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  input.close();
  process.exit(1);
});
