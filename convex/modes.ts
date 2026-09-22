/**
 * A mode is the security and cost boundary of a single turn.
 *
 * It is resolved exactly once, at the top of the turn, and decides which tools
 * get bound to the model, how many steps it may take, and which model runs.
 * Nothing downstream can widen it. If a tool is not in the allowlist it is not
 * passed to the model at all, so there is no "the model tried and we said no"
 * path to get wrong.
 *
 * Modes are plain data. Adding one is an entry in MODES, not a refactor.
 */

export const MODE_NAMES = ["perry", "agentP"] as const;
export type ModeName = (typeof MODE_NAMES)[number];

export type ToolName = "recall" | "remember" | "forget";

export interface Mode {
  name: ModeName;
  label: string;
  /** Model slug, resolved through the Vercel AI Gateway. */
  model: string;
  /** Hard ceiling on tool-call round trips in one turn. */
  stepBudget: number;
  /** The only tools that get bound. Order is irrelevant, membership is not. */
  tools: readonly ToolName[];
  /** Whether destructive tool calls must be confirmed by the owner first. */
  requiresApproval: boolean;
  instructions: string;
}

const PERRY_VOICE = `
You are Perry, a personal assistant for a single owner. You live in a chat app,
so write like a person texting: short, plain, no preamble, no sign-off. Never
open with "Sure!" or "Certainly". If a one-word answer is right, give it.

You are not a search engine. You know the owner. Use what you remember.
Never invent a fact about the owner's life; if you do not know, say so and ask.
`.trim();

export const MODES: Record<ModeName, Mode> = {
  /**
   * The pet. Ambient, cheap, quiet, and structurally incapable of damage.
   * This is the default and where the large majority of turns should land.
   */
  perry: {
    name: "perry",
    label: "Perry",
    model: "anthropic/claude-haiku-4.5",
    stepBudget: 4,
    tools: ["recall", "remember"],
    requiresApproval: false,
    instructions: `
${PERRY_VOICE}

You are in Perry mode: you can read and remember, and that is all. You cannot
run commands, send anything, or change anything outside your own memory.

If the owner asks for something that needs more than that, do not apologise and
do not pretend. Say in one line what it would take, and offer to switch to
Agent P. They switch by sending /agentp.
`.trim(),
  },

  /**
   * The spy. Full reach, entered deliberately, on a short leash, and it reports
   * back when the job is done.
   */
  agentP: {
    name: "agentP",
    label: "Agent P",
    model: "anthropic/claude-sonnet-5",
    stepBudget: 40,
    tools: ["recall", "remember", "forget"],
    requiresApproval: true,
    instructions: `
${PERRY_VOICE}

You are in Agent P mode: full tool access and a long step budget. Work the task
to completion rather than checking in after every step, then report back with
what you actually did, not what you planned to do.

Destructive and outward-facing actions need the owner's explicit go-ahead in
chat before you take them. Deleting, sending, publishing and spending all count.
Reading does not.

State plainly when something failed. Never report success you did not verify.
`.trim(),
  },
};

export const DEFAULT_MODE: ModeName = "perry";

export function getMode(name: ModeName): Mode {
  return MODES[name];
}

export function isModeName(value: string): value is ModeName {
  return (MODE_NAMES as readonly string[]).includes(value);
}

/** Every tool the owner could reach if they switched modes. Used for /help. */
export function toolsAcrossAllModes(): ToolName[] {
  const seen = new Set<ToolName>();
  for (const mode of Object.values(MODES)) {
    for (const tool of mode.tools) seen.add(tool);
  }
  return [...seen];
}
