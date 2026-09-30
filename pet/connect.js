/**
 * The desktop pet on another of the owner's computers: paired with the Perry
 * running on their main one, over their network, without a whole Perry here.
 *
 *   node connect.js <Perry's address> <pairing code>   pair him, start him, and start him at every login
 *   node connect.js off                                stop him, and stop him starting at login
 *
 * The installers run this in their pet-only mode (PERRY_PET, in install.ps1
 * and install.sh) once Electron is installed beside it. The code is made in
 * Perry's Settings → Desktop pet and works once, for a few minutes: it is
 * traded for this computer's own key, kept with the server's address in
 * pet.json in ~/.perry, which is all main.js needs. Removing this computer
 * in Settings takes the key away.
 *
 * He starts at login the way `perry pet` has him start on Perry's computer
 * (scripts/pet.ts), per user and without admin rights: a Run entry on
 * Windows, a launchd agent on a Mac, an autostart entry on Linux.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PERRY_HOME ?? join(homedir(), ".perry");
const STATE = join(HOME, "pet.json");
/** Perry's port unless it was changed (PERRY_PORT on its computer). */
const DEFAULT_PORT = "7377";
/** A pet with its own PERRY_HOME (a test) gets its own login entry, as with `perry pet`, so it never replaces another's. */
const OWN_HOME = process.env.PERRY_HOME ? `-${createHash("sha256").update(process.env.PERRY_HOME).digest("hex").slice(0, 8)}` : "";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = `Perry pet${OWN_HOME}`;
const LABEL = `com.perry.pet${OWN_HOME}`;

const say = (text = "") => console.log(text);
const fail = (text) => { console.error(`\n  ${text}\n`); process.exit(1); };

function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; }
}

/** Perry's address as typed: with or without http://, and its port only when it is not Perry's usual one. */
function serverOf(typed) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(typed) ? typed : `http://${typed}`); } catch { return null; }
  if (!url.port && url.protocol === "http:") url.port = DEFAULT_PORT;
  return url.origin;
}

/** Electron's program, which its package downloads the first time it is asked for. */
function electron() {
  try {
    const path = createRequire(import.meta.url)("electron");
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const desktopWord = (s) => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;

function autostartFile() {
  if (process.platform === "darwin") return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  if (process.platform === "win32") return null;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", `perry-pet${OWN_HOME}.desktop`);
}

function startAtLogin(program) {
  if (process.platform === "win32") {
    const added = spawnSync("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${program}" "${HERE}"`, "/f"], { encoding: "utf8", windowsHide: true });
    return added.status === 0;
  }
  const file = autostartFile();
  mkdirSync(dirname(file), { recursive: true });
  const env = process.env.PERRY_HOME ? { PERRY_HOME: process.env.PERRY_HOME } : {};
  if (process.platform === "darwin") {
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Perry on the desktop, paired with Perry on another computer. Written by pet/connect.js; removed by \`node connect.js off\`. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
    <string>${xml(HERE)}</string>
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
    "# Perry on the desktop, paired with Perry on another computer. Written by pet/connect.js; removed by `node connect.js off`.",
    "Type=Application",
    "Name=Perry",
    "Comment=Your to-dos, on your screen",
    `Exec=${prefix}${desktopWord(program)} ${desktopWord(HERE)}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n"));
  return true;
}

function stopStartingAtLogin() {
  if (process.platform === "win32") spawnSync("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { stdio: "ignore", windowsHide: true });
  else rmSync(autostartFile(), { force: true });
}

/** Electron on the pet, on its own: a new pet, or a word (--quit) to the one running, which takes a new pairing as it hears it. */
function launch(program, args = []) {
  const env = { ...process.env };
  // Set, Electron would run as plain Node and never open a window.
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(program, [HERE, ...args], { cwd: HERE, env, detached: true, stdio: "ignore", windowsHide: false }).unref();
}

async function pair(typed, code) {
  const server = serverOf(typed);
  if (!server) fail(`That is not an address: ${typed}. It looks like http://192.168.1.20:7377, as Perry's Settings → Desktop pet shows it.`);
  say(`\n  Pairing with Perry at ${server}…`);
  let answer;
  try {
    const response = await fetch(`${server}/api/backend/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // What Perry's Settings call this computer: its own name, unless PERRY_PET_NAME says otherwise ("Work laptop").
      body: JSON.stringify({ path: "pet:redeem", args: { code, name: process.env.PERRY_PET_NAME || hostname(), platform: process.platform } }),
      signal: AbortSignal.timeout(15_000),
    });
    answer = await response.json();
  } catch (error) {
    fail(`Could not reach Perry at ${server} (${error?.cause?.code ?? error?.message ?? error}). Is Perry running there, and is this computer on the same network, or signed in to the same Tailscale?`);
  }
  const paired = answer?.value;
  if (!paired?.key) fail(paired?.error ?? answer?.error ?? "Perry did not pair this computer.");
  mkdirSync(HOME, { recursive: true });
  writeFileSync(STATE, `${JSON.stringify({ ...readState(), server, token: paired.key }, null, 2)}\n`);
  say(`  Paired, as ${paired.name}. Perry lists this computer in Settings → Desktop pet, where it can be removed.`);

  const program = electron();
  if (!program) fail("Electron is not installed beside this script: run pnpm install in this folder, then this again.");
  const atLogin = startAtLogin(program);
  launch(program);
  say(`  He is on this screen now${atLogin ? ", and starts with this computer from now on" : ""}.`);
  say(`  To stop him: node ${join(HERE, "connect.js")} off\n`);
}

function off() {
  stopStartingAtLogin();
  const program = electron();
  if (program) launch(program, ["--quit"]);
  say("\n  Stopped, and no longer starts at login. Remove this computer in Perry's Settings → Desktop pet to take its key away too.\n");
}

const [first, second] = process.argv.slice(2);
if (first === "off") off();
else if (first && second) await pair(first, second);
else {
  say("\n  node connect.js <Perry's address> <pairing code>   pair this computer's pet with Perry, and start him");
  say("  node connect.js off                                stop him, and stop him starting at login\n");
  say("  Perry's Settings → Desktop pet → Add a computer shows both.\n");
  process.exit(first === "help" || first === "--help" ? 0 : 1);
}
