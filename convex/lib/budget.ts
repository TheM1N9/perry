import type { EngineKind } from "./engines";

/**
 * How much of what is pinned every message may carry, per engine (issue #220).
 *
 * Not a fixed size: a share of the engine's context window. The pinned block
 * is sent once per chat session and again only when it changes, and it sits
 * ahead of the conversation, so it should be big enough to hold what matters
 * and small enough that a long chat still has room: 5% of the window. On
 * Codex (272k tokens) that is about 13,600 tokens, ~47,000 characters; on
 * Claude Code (200k) ~35,000; on Antigravity's Gemini (1M) it would be 50,000
 * tokens, so it is capped at 24,000 tokens (~84,000 characters): past that a
 * resend costs more than it brings. Never under 6,000 tokens (~21,000
 * characters), so a small window still gets About me and the gist of the rest.
 * What is over is condensed, never dropped (pages.standingFor).
 *
 * Context windows are the models' as the engines run them; a window an engine
 * reports for a chat (Codex does, with each turn) wins over the table.
 */
export const CONTEXT_WINDOWS: Record<EngineKind, number> = {
  codex: 272_000,
  claude: 200_000,
  grok: 256_000,
  cursor: 200_000,
  antigravity: 1_000_000,
};
/** An engine not named, or none yet. */
const DEFAULT_WINDOW = 200_000;
export const PINNED_SHARE = 0.05;
const MIN_TOKENS = 6_000;
const MAX_TOKENS = 24_000;
/** Characters a token holds, conservatively, for English mixed with Indian languages (which take more tokens). */
export const CHARS_PER_TOKEN = 3.5;

/** The pinned budget in characters for an engine, or for a window that engine reported. */
export function pinnedBudget(engine?: EngineKind, window?: number): number {
  const tokens = window && window > 0 ? window : engine ? CONTEXT_WINDOWS[engine] ?? DEFAULT_WINDOW : DEFAULT_WINDOW;
  return Math.round(Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, tokens * PINNED_SHARE)) * CHARS_PER_TOKEN);
}

/** A section this long or longer may be sent condensed when what is pinned is over the budget. */
export const CONDENSE_FROM = 1_200;
/** How long a written section summary may be. */
export const SUMMARY_LIMIT = 900;
