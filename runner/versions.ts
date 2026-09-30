import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { CLI_PACKAGES, versionIn, type EngineKind } from "../convex/lib/engines";
import type { EngineStatus } from "./engine";
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

/** The command that updates an engine's CLI on this computer, for the way it was installed here. */
export function updateCommand(kind: EngineKind, command: string = kind): string | undefined {
  const pkg = CLI_PACKAGES[kind];
  if (!pkg) return undefined;
  const file = onPath(command);
  const by = file ? installedBy(file, pkg) : "own";
  if (by === "npm") return `npm install -g ${pkg}@latest`;
  if (by === "pnpm") return `pnpm add -g ${pkg}@latest`;
  if (by === "bun") return `bun add -g ${pkg}@latest`;
  return OWN[kind]?.[by] ?? OWN[kind]?.own ?? `npm install -g ${pkg}@latest`;
}

/** An engine's status with the newest release known and the command that updates it here, for a CLI that is here. */
export function withVersions(status: EngineStatus): EngineStatus {
  if (!status.version || !CLI_PACKAGES[status.kind]) return status;
  const latest = latestVersion(status.kind);
  const update = status.update ?? updateCommand(status.kind);
  return { ...status, ...(latest ? { latest } : {}), ...(update ? { update } : {}) };
}
