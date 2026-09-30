/**
 * The engines a chat can run on: the coding agents on the owner's computer,
 * each signed in with the owner's own subscription. Codex is the only one
 * built so far; the rest are named here so a chat, a turn or a runner's report
 * can already hold them (runner/engine.ts says how one is added).
 *
 * Pure, with no server imports, so the browser bundle and the runner use it too.
 */

export const ENGINES = ["codex", "claude", "grok", "cursor", "antigravity"] as const;
export type EngineKind = (typeof ENGINES)[number];

/** Chats, turns and jobs from before engines ran on Codex, and leave it unset. */
export const DEFAULT_ENGINE: EngineKind = "codex";

export const ENGINE_LABELS: Record<EngineKind, string> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok Build",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

/** What the sign-in button says: the account the owner signs in with. */
export const SIGN_IN_LABELS: Record<EngineKind, string> = {
  codex: "Sign in with ChatGPT",
  claude: "Sign in with Claude",
  grok: "Sign in with Grok",
  cursor: "Sign in with Cursor",
  antigravity: "Sign in with Google",
};

export const isEngine = (value: unknown): value is EngineKind => (ENGINES as readonly unknown[]).includes(value);

/** The engine of a chat, turn or job; unset is Codex. */
export const engineOf = (item?: { engine?: EngineKind } | null): EngineKind => item?.engine ?? DEFAULT_ENGINE;

/**
 * What the owner does to finish signing an engine in. Perry never proxies a
 * vendor's web sign-in and never sees its tokens: it shows a page to open, a
 * code to enter, or a command to run on the computer, and the engine's own
 * CLI keeps the credentials there.
 */
export type LoginInteraction =
  | { type: "browser"; url: string }
  | { type: "deviceCode"; verificationUrl: string; userCode: string }
  | { type: "terminal"; command: string }
  | { type: "credentials"; message: string };

/**
 * A model as pickers and commands name it: "<engine>/<model id>", so the same
 * id on two engines stays two choices. A bare id is Codex's, as chats and jobs
 * from before engines stored it.
 */
export const modelKey = (engine: EngineKind, id: string) => `${engine}/${id}`;

export function parseModelKey(key: string): { engine: EngineKind; id: string } {
  const slash = key.indexOf("/");
  const engine = slash > 0 ? key.slice(0, slash) : "";
  return isEngine(engine) ? { engine, id: key.slice(slash + 1) } : { engine: DEFAULT_ENGINE, id: key };
}

// --- Versions -----------------------------------------------------------------

/**
 * The oldest version of each engine's CLI that Perry works with. Below it the
 * engine takes no new turns, and says which command updates it, rather than
 * failing half-way through one. Each is the first release with everything
 * Perry's engine for that CLI relies on:
 *
 *   codex   0.136.0  skills/extraRoots/set, the newest of the app-server
 *                    methods Perry calls (Perry's skills). ChatGPT's device
 *                    code for signing in from Settings (0.118), permission
 *                    requests (0.113) and MCP servers' questions (0.111) came
 *                    before it.
 *   claude  2.1.111  the xhigh effort Perry offers. `claude auth status --json`
 *                    (2.1.41) and each model's effort levels (2.1.49) came
 *                    before it.
 *   grok    1.0.0    Grok Build's first stable release, and the line Perry was
 *                    built and run on. The flags, the sign-in methods, the model
 *                    and reasoning_effort options and the autoMode setting that
 *                    keeps it asking are all there.
 *
 * Antigravity has none: Perry downloads the one version it pins
 * (runner/engines/antigravity.ts), so a newer one comes with Perry itself.
 */
export const MINIMUM_VERSIONS: Partial<Record<EngineKind, string>> = { codex: "0.136.0", claude: "2.1.111", grok: "1.0.0" };

/** Each CLI's package on npm, where its releases are published and its newest version is looked up (runner/versions.ts). */
export const CLI_PACKAGES: Partial<Record<EngineKind, string>> = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code", grok: "@xai-official/grok" };

/** The version in what a CLI prints, such as "codex-cli 0.157.1", "2.1.283 (Claude Code)" or "grok 1.0.41 (4220f3b)". */
export const versionIn = (text?: string): string | undefined => text?.match(/\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?/)?.[0];

/** Below zero when `a` is older than `b`, above when newer. A pre-release (1.0.45-alpha.1) comes before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const dash = version.indexOf("-");
    const core = dash < 0 ? version : version.slice(0, dash);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: dash < 0 ? undefined : version.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const difference = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * An engine's CLI that should be updated: "required" when it is older than
 * Perry works with, so it takes no new turns until it is; "available" when a
 * newer release is out. `command` updates it on that computer, for the way it
 * was installed there.
 */
export type EngineUpdate = { need: "required" | "available"; version: string; minimum?: string; latest?: string; command: string };

/** Whether an engine's CLI should be updated, from its version, the newest release known and the command its computer gave. */
export function updateOf(status: { kind: EngineKind; version?: string; latest?: string; update?: string }): EngineUpdate | undefined {
  const version = versionIn(status.version);
  const pkg = CLI_PACKAGES[status.kind];
  if (!version || !pkg) return undefined;
  const command = status.update || `npm install -g ${pkg}@latest`;
  const latest = status.latest && compareVersions(status.latest, version) > 0 ? status.latest : undefined;
  const minimum = MINIMUM_VERSIONS[status.kind];
  if (minimum && compareVersions(version, minimum) < 0) return { need: "required", version, minimum, ...(latest ? { latest } : {}), command };
  return latest ? { need: "available", version, latest, command } : undefined;
}

/** Why an engine takes no new turns until it is updated, and how: what the chat, the pet and the phone say. */
export function refusal(label: string, update: EngineUpdate, computer?: string): string {
  return `${label} ${update.version}${computer ? ` on ${computer}` : ""} is too old for Perry, which needs ${update.minimum} or newer. ` +
    `Update it${computer ? " on that computer" : ""}: ${update.command}`;
}
