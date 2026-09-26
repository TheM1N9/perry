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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bold, dim, green, red, yellow } from "./lib";
import { PORT, REPO, dashboardUp, exec, nodePath, tool } from "./perry";

const PET = join(REPO, "pet");
const LABEL = "com.perry.pet";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "Perry pet";
/** Settings the pet started at login would not otherwise have. */
const CARRIED_ENV = ["PERRY_HOME", "PERRY_PORT"];

const say = (text = "") => console.log(text);
export const installed = () => existsSync(join(PET, "node_modules", "electron"));

/** Electron's own program, downloaded by its package the first time it is asked for. */
function electron(): string | null {
  const asked = spawnSync(nodePath(), ["-e", "process.stdout.write('\\n' + require('electron'))"], { cwd: PET, encoding: "utf8", windowsHide: true });
  const path = asked.status === 0 ? asked.stdout.trim().split(/\r?\n/).pop()?.trim() : undefined;
  if (!path || !existsSync(path)) {
    say(red(`  Could not get Electron: ${`${asked.stderr ?? ""}`.trim().split(/\r?\n/).slice(-3).join(" ") || "no path"}`));
    return null;
  }
  return path;
}

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
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "perry-pet.desktop");
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

async function on(): Promise<boolean> {
  say(`\n${bold("Perry on your desktop")}`);
  if (!installed()) {
    say(dim("  Installing his window and his ears (Electron and ONNX Runtime, under 1 GB), once…"));
    if (exec(tool("pnpm", ["install", "--dir", "pet", "--frozen-lockfile"]), { quiet: true }).code !== 0) {
      say(red("  pnpm could not install it. Run: pnpm install --dir pet"));
      return false;
    }
  }
  const program = electron();
  if (!program) return false;
  if (!(await dashboardUp())) say(yellow(`  Perry isn't running, so he'll wait for it: ${bold("perry start")}`));
  const atLogin = startAtLogin(program);
  launch(program);
  say(`  ${green("started")}  in the bottom-right corner of your screen`);
  say(dim(`  Click him for your chats, to-dos and what needs you; drag him anywhere. Ctrl+Shift+Space talks to him.`));
  if (atLogin) say(dim(`  He starts with your computer from now on; ${bold("perry pet off")} stops that.`));
  say("");
  return true;
}

export function off(): boolean {
  stopStartingAtLogin();
  if (installed()) {
    const program = electron();
    if (program) launch(program, ["--quit"]);
  }
  say(`  ${green("stopped")}  and no longer starts at login`);
  return true;
}

/**
 * After `perry update`: the pet's own install brought up to date, and a
 * running pet told to load the new page. Nothing when it was never installed.
 */
export function refresh() {
  if (!installed()) return;
  if (exec(tool("pnpm", ["install", "--dir", "pet", "--frozen-lockfile"]), { quiet: true }).code !== 0) {
    say(yellow("  Could not update the desktop pet: pnpm install --dir pet"));
    return;
  }
  const program = electron();
  if (program) launch(program, ["--reload"]);
}

export async function pet(args: string[]): Promise<boolean> {
  const [what = "on"] = args;
  if (what === "on") return on();
  if (what === "off") return off();
  say(`\n  ${bold("perry pet")}       start Perry on your desktop, and at every login`);
  say(`  ${bold("perry pet off")}   stop him\n`);
  return what === "help" || what === "--help";
}
