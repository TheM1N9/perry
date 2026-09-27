import { WINDOWS_SANDBOX, type CodexAppServer } from "./codex";
import { HOME } from "./home";

/**
 * Quick side turns on the owner's subscription: the approval reviewer
 * (review.ts) and chat names (title.ts). Each is one ephemeral, read-only
 * Codex turn that only answers, beside whatever chat turn is running.
 */

/**
 * Codex's tools, off for a quick turn: it answers from the text it is given
 * and has no reason to run, read, browse or delegate anything.
 */
const NO_TOOLS = Object.fromEntries([
  "shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation", "computer_use", "browser_use",
].map((feature) => [`features.${feature}`, false]));

/** Threads quick turns started. Any request Codex makes from one is refused. */
const quickThreads = new Set<string>();
export const isQuickThread = (threadId?: string) => Boolean(threadId && quickThreads.has(threadId));

export type ListedModel = { model: string; description?: string; hidden?: boolean; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort: string }> };
export type ModelChoice = { model?: string; effort?: string };
const chosen = new WeakMap<CodexAppServer, Map<string, Promise<ModelChoice>>>();

/**
 * A model from what the subscription offers, picked once per app-server and
 * purpose, at low effort where the model has it.
 */
export function pickModel(app: CodexAppServer, purpose: string, pick: (all: ListedModel[], listed: ListedModel[]) => ListedModel | undefined, fallback?: string) {
  let picks = chosen.get(app);
  if (!picks) chosen.set(app, picks = new Map());
  let choice = picks.get(purpose);
  if (!choice) {
    choice = (async () => {
      const { data = [] } = await app.request<{ data?: ListedModel[] }>("model/list", { limit: 100 });
      const model = pick(data, data.filter((item) => !item.hidden));
      const effort = model?.supportedReasoningEfforts?.some((option) => option.reasoningEffort === "low") ? "low" : undefined;
      return { model: model?.model ?? fallback, effort };
    })();
    choice.catch(() => picks.delete(purpose));
    picks.set(purpose, choice);
  }
  return choice;
}

/** Run one quick turn and return its answer. Throws on failure or when out of time, having stopped the turn. */
export async function quickTurn(app: CodexAppServer, options: {
  instructions: string;
  text: string;
  choice: ModelChoice;
  outputSchema?: object;
  timeoutMs: number;
}): Promise<string> {
  const started = Date.now();
  const left = () => Math.max(1, options.timeoutMs - (Date.now() - started));
  let turn: { threadId: string; turnId: string } | undefined;
  try {
    const thread = await app.request<{ thread?: { id?: string } }>("thread/start", {
      cwd: HOME,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: options.instructions,
      config: { ...WINDOWS_SANDBOX, ...NO_TOOLS },
      serviceName: "perry",
    }, left());
    const threadId = thread.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread ID.");
    quickThreads.add(threadId);
    const begun = await app.request<{ turn?: { id?: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: options.text }],
      ...(options.choice.model ? { model: options.choice.model } : {}),
      ...(options.choice.effort ? { effort: options.choice.effort } : {}),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    }, left());
    if (!begun.turn?.id) throw new Error("Codex did not start the turn.");
    turn = { threadId, turnId: begun.turn.id };
    return (await app.waitForTurn(begun.turn.id, left())).text;
  } catch (error) {
    // Stop a turn that ran out of time, so it does not keep using the subscription.
    if (turn) void app.interrupt(turn.threadId, turn.turnId).catch(() => {});
    throw error;
  }
}
