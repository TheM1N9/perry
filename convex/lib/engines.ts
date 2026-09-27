/**
 * The engines a chat can run on: the coding agents on the owner's computer,
 * each signed in with the owner's own subscription. Codex is the only one
 * built so far; the rest are named here so a chat, a turn or a runner's report
 * can already hold them (runner/engine.ts says how one is added).
 *
 * Pure, with no server imports, so the browser bundle and the runner use it too.
 */

/** In the order the default engine falls back through when the owner's pick isn't signed in (engines.defaultEngine). */
export const ENGINES = ["codex", "claude", "grok", "cursor", "antigravity"] as const;
export type EngineKind = (typeof ENGINES)[number];

/**
 * Chats, turns and jobs from before engines ran on Codex, and leave it unset.
 * Not the owner's default engine, which new chats are created with (engines.defaultEngine).
 */
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
