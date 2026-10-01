import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { CLI_PACKAGES, versionIn, type EngineKind } from "../convex/lib/engines";
import type { EngineStatus } from "./engine";
import { killTree } from "./engines/process";
import { PATHS } from "./home";

/**
 * How current each engine's CLI is on this computer: the newest release, and
 * the command that updates it here. The minimum Perry works with is in
 * convex/lib/engines.ts, which says what an engine's version means.
 *
 * The newest release is looked up where each CLI publishes it, npm's
 * registry, whose releases Codex's Homebrew cask, Claude Code's native
 * installer and Grok's own installer follow too. It is looked up at most
 * every six hours, in the background, and kept in engine-versions.json in
 * Perry's home: an engine's status reads what was found last and never waits
 * for it, so a reply is never slowed by it, and offline nothing changes but
 * that it is not refreshed.
 *
 * PERRY_NPM_REGISTRY names another registry (tests serve their own).
 */

const CHECK_MS = 6 * 60 * 60_000;
/** After a look-up that failed (offline, say), the next is tried this much later. */
const RETRY_MS = 30 * 60_000;

/** What the last look-up found, and when it was, found or not. */
type Looked = { latest?: string; at: number; found: boolean };
let known: Partial<Record<EngineKind, Looked>> | null = null;
const looking = new Map<EngineKind, Promise<string | undefined>>();

function load(): Partial<Record<EngineKind, Looked>> {
  if (!known) {
    try { known = JSON.parse(readFileSync(PATHS.engineVersions, "utf8")) as Partial<Record<EngineKind, Looked>>; }
    catch { known = {}; }
  }
  return known;
}

const stale = (looked?: Looked) => !looked || Date.now() - looked.at > (looked.found ? CHECK_MS : RETRY_MS);

/** Look the newest release up now. One that cannot be reached leaves what was known. */
function lookUp(kind: EngineKind, timeoutMs = 15_000): Promise<string | undefined> {
  const pkg = CLI_PACKAGES[kind];
  if (!pkg) return Promise.resolve(undefined);
  let pending = looking.get(kind);
  if (pending) return pending;
  const registry = (process.env.PERRY_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  pending = fetch(`${registry}/${pkg}/latest`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`${pkg}: ${response.status}`);
      return versionIn(String((await response.json() as { version?: unknown }).version ?? ""));
    })
    .then((latest) => latest, () => undefined)
    .then((latest) => {
      const all = load();
      all[kind] = { latest: latest ?? all[kind]?.latest, at: Date.now(), found: Boolean(latest) };
      try {
        mkdirSync(dirname(PATHS.engineVersions), { recursive: true });
        writeFileSync(PATHS.engineVersions, JSON.stringify(all, null, 2));
      } catch {}
      return all[kind]!.latest;
    })
    .finally(() => looking.delete(kind));
  looking.set(kind, pending);
  return pending;
}

/** The newest release known, at once. One not looked up for a while is looked up in the background, for the next time. */
export function latestVersion(kind: EngineKind): string | undefined {
  const looked = load()[kind];
  if (stale(looked)) void lookUp(kind);
  return looked?.latest;
}

/** For `perry doctor` and `perry setup`, which can wait a moment: looked up now when it is stale, for at most `waitMs`. */
export async function latestVersionNow(kind: EngineKind, waitMs = 5_000): Promise<string | undefined> {
  const looked = load()[kind];
  return stale(looked) ? await lookUp(kind, waitMs) : looked?.latest;
}

// --- The command that updates it -----------------------------------------------

/** Where a command is, as a shell on this computer would find it on PATH. */
function onPath(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  const windows = process.platform === "win32";
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of windows ? [".exe", ".cmd", ".bat"].map((ext) => command + ext) : [command]) {
      const file = join(dir, name);
      try { if (statSync(file).isFile()) return file; } catch {}
    }
  }
  return undefined;
}

type Installer = "npm" | "pnpm" | "bun" | "brew" | "winget" | "own";

/**
 * How a CLI was installed, from where it is: a package manager's global
 * folder (npm, pnpm, Bun), Homebrew or WinGet, or else its own installer.
 * npm's own folders come first, since Homebrew's Node keeps them under
 * Homebrew's prefix.
 */
function installedBy(file: string, pkg: string): Installer {
  let real = file;
  try { real = realpathSync(file); } catch {}
  const path = real.replace(/\\/g, "/").toLowerCase();
  if (path.includes("/.bun/")) return "bun";
  if (path.includes("/pnpm/")) return "pnpm";
  if (path.includes("/node_modules/")) return "npm";
  // npm's shims on Windows sit beside the node_modules they run.
  if (existsSync(join(dirname(file), "node_modules", ...pkg.split("/")))) return "npm";
  if (/\/(caskroom|cellar|homebrew|linuxbrew)\//.test(path)) return "brew";
  if (path.includes("/winget/")) return "winget";
  return "own";
}

/** Each CLI's own way to update, and its Homebrew and WinGet packages, from each one's install docs. */
const OWN: Partial<Record<EngineKind, Partial<Record<Installer, string>>>> = {
  codex: {
    brew: "brew upgrade --cask codex",
    own: process.platform === "win32" ? `powershell -c "irm https://chatgpt.com/codex/install.ps1 | iex"` : "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
  claude: { brew: "brew upgrade --cask claude-code", winget: "winget upgrade Anthropic.ClaudeCode", own: "claude update" },
  grok: { own: "grok update" },
};

/** The command that updates a CLI installed this way. */
function commandFor(kind: EngineKind, pkg: string, by: Installer): string {
  if (by === "npm") return `npm install -g ${pkg}@latest`;
  if (by === "pnpm") return `pnpm add -g ${pkg}@latest`;
  if (by === "bun") return `bun add -g ${pkg}@latest`;
  return OWN[kind]?.[by] ?? OWN[kind]?.own ?? `npm install -g ${pkg}@latest`;
}

/** The command that updates an engine's CLI on this computer, for the way it was installed here. */
export function updateCommand(kind: EngineKind, command: string = kind): string | undefined {
  const pkg = CLI_PACKAGES[kind];
  if (!pkg) return undefined;
  const file = onPath(command);
  return commandFor(kind, pkg, file ? installedBy(file, pkg) : "own");
}

// --- Running it -------------------------------------------------------------------

/**
 * How the runner updates an engine's CLI here, from Settings
 * (convex/engineUpdates.ts): the command for the way it was installed, run
 * with the CLI's folder first on PATH, so `claude update` updates the Claude
 * Code Perry found, and npm is the one beside the CLI it installed.
 *
 * `locked` are the folders the update writes to that this user cannot: it
 * would need admin rights (sudo), which Perry never takes, so it is not run,
 * and the owner is shown `elevated` to run themselves. Homebrew never needs
 * them (it refuses to run as root); a CLI not found leaves nothing to look at,
 * and its own installer writes to the owner's home.
 */
export type UpdatePlan = {
  /** As the owner would type it, and Settings shows it. */
  command: string;
  /** What runs: the same, with what keeps an installer from stopping to ask (WinGet's agreements). */
  run: string;
  /** The CLI's folder, first on the update's PATH. */
  folder?: string;
  locked: string[];
  /** The command with the rights it needs: sudo before it, or as is, for a terminal run as administrator on Windows. */
  elevated: string;
};

export function updatePlan(kind: EngineKind, command: string = kind): UpdatePlan | undefined {
  const pkg = CLI_PACKAGES[kind];
  if (!pkg) return undefined;
  const file = onPath(command);
  const by = file ? installedBy(file, pkg) : "own";
  const shown = commandFor(kind, pkg, by);
  let real = file;
  if (file) try { real = realpathSync(file); } catch {}
  // The global node_modules a package manager's CLI is in: the first in its path.
  const modules = real && /^(.*?[\\/]node_modules)[\\/]/.exec(real)?.[1];
  const folders = !file || !real || by === "brew" ? []
    : by === "winget" ? [dirname(real)]
    : by === "own" ? [dirname(real), dirname(file)]
    : [dirname(file), modules || join(dirname(file), "node_modules")];
  return {
    command: shown,
    run: by === "winget" ? `${shown} --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity` : shown,
    ...(file ? { folder: dirname(file) } : {}),
    locked: [...new Set(folders)].filter((folder) => !writable(folder)),
    elevated: process.platform === "win32" ? shown : `sudo ${shown}`,
  };
}

/**
 * Whether this user can write in a folder, found by writing there, since
 * permission bits and Windows' ACLs say different things. One that is not
 * there is left to the installer.
 */
function writable(folder: string): boolean {
  const probe = join(folder, `.perry-write-check-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "", { flag: "wx" });
    unlinkSync(probe);
    return true;
  } catch (error) {
    return !["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
  }
}

/** An engine's status with the newest release known and the command that updates it here, for a CLI that is here. */
export function withVersions(status: EngineStatus): EngineStatus {
  if (!status.version || !CLI_PACKAGES[status.kind]) return status;
  const latest = latestVersion(status.kind);
  const update = status.update ?? updateCommand(status.kind);
  return { ...status, ...(latest ? { latest } : {}), ...(update ? { update } : {}) };
}

/** What an update printed, as a terminal would show it: no colours, and a line redrawn in place (a progress bar) only as it was last drawn. */
export function printed(raw: string): string {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n");
}

/**
 * Run an update plan's command in this computer's shell, from the owner's
 * home, with the CLI's folder first on PATH and nothing on its input, so
 * an installer that would stop to ask fails instead of waiting. `onOutput`
 * hears what it has printed so far, as it prints. Past `timeoutMs` it is
 * ended, with everything it started.
 */
export function runUpdate(plan: UpdatePlan, timeoutMs: number, onOutput: (output: string) => void): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const windows = process.platform === "win32";
    const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(plan.folder ? { [pathKey]: `${plan.folder}${delimiter}${process.env[pathKey] ?? ""}` } : {}),
      NO_COLOR: "1",
      // cmd.exe looks in the folder it starts in before PATH: only PATH's are run.
      NoDefaultCurrentDirectoryInExePath: "1",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
    };
    let raw = "";
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(windows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh", windows ? ["/d", "/s", "/c", `"${plan.run}"`] : ["-c", plan.run], {
        cwd: homedir(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: windows, detached: !windows,
      });
    } catch (error) {
      done({ code: null, output: error instanceof Error ? error.message : String(error), timedOut });
      return;
    }
    const hear = (chunk: Buffer) => {
      // Only the end is kept: it says how it went.
      raw = (raw + chunk).slice(-64_000);
      onOutput(printed(raw));
    };
    child.stdout?.on("data", hear);
    child.stderr?.on("data", hear);
    const timer = setTimeout(() => { timedOut = true; killTree(child, "SIGKILL"); }, timeoutMs);
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      done({ code, output: printed(raw).trim(), timedOut });
    };
    child.on("error", (error) => { raw += `\n${error.message}`; end(null); });
    child.on("close", end);
  });
}
