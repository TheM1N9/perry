#!/usr/bin/env bun
/**
 * `perry pet` — Perry on the desktop: a platypus on top of your windows with
 * your to-do list, who speaks up as each thing comes due (pet/main.js, which
 * shows the server's /pet page).
 *
 *   perry pet       install it the first time (Electron, and ONNX Runtime for
 *                   hearing you: under 1 GB, into pet/), start it, and start it
 *                   at every login from now on
 *   perry pet off   stop it, and stop it starting at login
 *
 * It starts at login the way each OS starts a desktop app, per user and
 * without admin rights:
 *
 *   macOS    a launchd agent        ~/Library/LaunchAgents/com.perry.pet.plist
 *   Linux    an autostart entry     ~/.config/autostart/perry-pet.desktop
 *   Windows  a Run entry            HKCU\...\CurrentVersion\Run, "Perry pet"
 *
 * The pet is a separate install so that Perry itself does not carry Electron
 * for everyone; `perry update` updates it when it is there.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bold, dim, done, red, run, spinner, tail, yellow, type Spinner } from "./lib";
import { PORT, REPO, dashboardUp, exec, nodePath, readEnvFile, tool, waitFor } from "./perry";

const PET = join(REPO, "pet");
/**
 * What his start-at-login entry is called. A Perry with its own PERRY_HOME (a
 * second checkout, a test) gets its own, so it never replaces another's.
 */
const OWN_HOME = process.env.PERRY_HOME ? `-${createHash("sha256").update(process.env.PERRY_HOME).digest("hex").slice(0, 8)}` : "";
const LABEL = `com.perry.pet${OWN_HOME}`;
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = `Perry pet${OWN_HOME}`;
/** Settings the pet started at login would not otherwise have. */
const CARRIED_ENV = ["PERRY_HOME", "PERRY_PORT"];

const say = (text = "") => console.log(text);
export const installed = () => existsSync(join(PET, "node_modules", "electron"));

function carriedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CARRIED_ENV) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A quoted word for a desktop entry's Exec line. */
const desktopWord = (s: string) => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;

function autostartFile(): string | null {
  if (process.platform === "darwin") return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  if (process.platform === "win32") return null;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", `perry-pet${OWN_HOME}.desktop`);
}

/** Start the pet at login. It is not restarted if it quits: quitting from the tray means it. */
function startAtLogin(program: string): boolean {
  const env = carriedEnv();
  if (process.platform === "win32") {
    const command = `"${program}" "${PET}"`;
    const added = exec(["reg", "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", command, "/f"], { quiet: true });
    if (added.code !== 0) say(yellow(`  Could not have it start at login: ${added.output}`));
    return added.code === 0;
  }
  const file = autostartFile()!;
  mkdirSync(join(file, ".."), { recursive: true });
  if (process.platform === "darwin") {
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Perry on the desktop. Written by \`perry pet\`; removed by \`perry pet off\`. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
    <string>${xml(PET)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`);
    return true;
  }
  const prefix = Object.keys(env).length ? `env ${Object.entries(env).map(([k, v]) => desktopWord(`${k}=${v}`)).join(" ")} ` : "";
  writeFileSync(file, [
    "[Desktop Entry]",
    "# Perry on the desktop. Written by `perry pet`; removed by `perry pet off`.",
    "Type=Application",
    "Name=Perry",
    "Comment=Your to-dos, on your screen",
    `Exec=${prefix}${desktopWord(program)} ${desktopWord(PET)}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n"));
  return true;
}

function stopStartingAtLogin() {
  if (process.platform === "win32") exec(["reg", "delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { quiet: true });
  else rmSync(autostartFile()!, { force: true });
}

/** Run Electron on the pet, detached: a new pet, or a word (--quit, --reload) to the one running. */
function launch(program: string, args: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, PERRY_PORT: String(PORT) };
  // Set, Electron would run as plain Node and never open a window.
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(program, [PET, ...args], { cwd: PET, env, detached: true, stdio: "ignore", windowsHide: false }).unref();
}

/**
 * A step that makes you wait, with ora's spinner (lib.spinner). Started from
 * the dashboard, whose server reads this command's output rather than a
 * terminal, each step is also named on a line of its own, for it to show.
 */
async function step(text: string): Promise<Spinner> {
  if (process.env.PERRY_PROGRESS === "1") say(`::step ${text}`);
  return await spinner(text);
}

/** Electron's own program, downloaded by its package the first time it is asked for. */
async function electron(): Promise<{ path?: string; error?: string }> {
  const asked = await run(nodePath(), ["-e", "process.stdout.write('\\n' + require('electron'))"], { cwd: PET });
  const path = asked.code === 0 ? asked.output.trim().split(/\r?\n/).pop()?.trim() : undefined;
  if (!path || !existsSync(path)) return { error: tail(asked.output, 3) || "Electron's package gave no program." };
  return { path };
}

/** pnpm, installing the pet's own packages (pet/package.json); a .cmd on Windows, so through cmd.exe there. */
async function installPackages(): Promise<{ code: number | null; output: string }> {
  const [command, ...args] = tool("pnpm", ["install", "--dir", "pet", "--frozen-lockfile"]);
  return await run(command, args, { cwd: REPO });
}

/** Whether his page has checked in with Perry, which it does as it opens. */
async function onScreen(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/backend/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "dashboard:getShortcuts", args: { key: process.env.DASHBOARD_KEY ?? readEnvFile().DASHBOARD_KEY ?? "" } }),
    });
    const body = await response.json() as { value?: { pet: { running: boolean } } };
    return Boolean(body.value?.pet.running);
  } catch {
    return false;
  }
}

async function on(): Promise<boolean> {
  say(`\n${bold("Perry on your desktop")}`);
  if (!installed()) {
    const installing = await step("Installing his window and his ears (Electron and ONNX Runtime, under 1 GB), once…");
    const result = await installPackages();
    if (result.code !== 0) {
      installing.fail(red("pnpm could not install him:"));
      say(dim(tail(result.output)));
      return false;
    }
    installing.succeed("installed");
  }
  // The first time, Electron's package downloads its program (about 100 MB); after that this is instant.
  const getting = await step("Getting Electron ready…");
  const program = await electron();
  if (!program.path) {
    getting.fail(red(`Could not get Electron: ${program.error}`));
    return false;
  }
  getting.succeed("Electron ready");

  const atLogin = startAtLogin(program.path);
  const running = await dashboardUp();
  const starting = await step("Starting him…");
  launch(program.path);
  if (!running) {
    starting.succeed(yellow(`started; he'll show up once Perry is running: ${bold("perry start")}`));
  } else if (await waitFor(onScreen, 45)) {
    starting.succeed("on your screen");
  } else {
    starting.fail(yellow("started, but he hasn't shown up yet; his tray icon, or perry pet again, will say more"));
  }
  say(dim(`  Click him for your chats, to-dos and what needs you; drag him anywhere. Ctrl+Shift+Space talks to him.`));
  if (atLogin) say(dim(`  He starts with your computer from now on; ${bold("perry pet off")} stops that.`));
  say("");
  return true;
}

export async function off(): Promise<boolean> {
  stopStartingAtLogin();
  if (installed()) {
    const program = await electron();
    if (program.path) launch(program.path, ["--quit"]);
  }
  await done("stopped, and no longer starts at login");
  return true;
}

/** Whether `perry pet` set him to start at login (and `perry pet off` has not undone it). */
function startsAtLogin(): boolean {
  if (process.platform === "win32") return exec(["reg", "query", RUN_KEY, "/v", RUN_VALUE], { quiet: true }).code === 0;
  return existsSync(autostartFile()!);
}

/** `perry stop`: he goes with Perry, having nothing behind him. He still starts at login as before. */
export async function quit() {
  if (!installed()) return;
  const program = await electron();
  if (program.path) launch(program.path, ["--quit"]);
}

/** `perry start`: he starts with Perry, if he is one to start at login. Already running, he just shows. */
export async function resume() {
  if (!installed() || !startsAtLogin()) return;
  const program = await electron();
  if (program.path) launch(program.path);
}

/**
 * After `perry update`: the pet's own install brought up to date, and a
 * running pet told to load the new page. Nothing when it was never installed.
 */
export async function refresh() {
  if (!installed()) return;
  const updating = await spinner("Updating the desktop pet…");
  if ((await installPackages()).code !== 0) {
    updating.fail(yellow("Could not update the desktop pet: pnpm install --dir pet"));
    return;
  }
  const program = await electron();
  if (program.path) launch(program.path, ["--reload"]);
  updating.succeed("desktop pet updated");
}

export async function pet(args: string[]): Promise<boolean> {
  const [what = "on"] = args;
  if (what === "on") return on();
  if (what === "off") return off();
  say(`\n  ${bold("perry pet")}       start Perry on your desktop, and at every login`);
  say(`  ${bold("perry pet off")}   stop him\n`);
  return what === "help" || what === "--help";
}
