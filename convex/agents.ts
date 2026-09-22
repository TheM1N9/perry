import { Agent, stepCountIs } from "@convex-dev/agent";
import { components } from "./_generated/api";
import type { Mode } from "./modes";
import { ALL_TOOLS } from "./tools";

/**
 * Build the Agent for a resolved mode.
 *
 * The mode decides the model, the instructions, the step ceiling, and the tool
 * allowlist, and those are baked in at construction. That is the whole
 * enforcement story: tools outside the allowlist are never bound, so they are
 * not in the model's vocabulary for that turn and there is no runtime
 * permission check to forget to write.
 *
 * Models are passed as `provider/model` strings and resolved by the AI SDK
 * through the Vercel AI Gateway. Passing a constructed provider object instead
 * means pinning a second copy of @ai-sdk/provider and matching its
 * specification version to the one the Agent component demands.
 */

function toolsFor(mode: Mode) {
  const bound: Record<string, unknown> = {};
  for (const name of mode.tools) {
    bound[name] = ALL_TOOLS[name];
  }
  return bound as Partial<typeof ALL_TOOLS>;
}

function buildAgent(mode: Mode) {
  return new Agent(components.agent, {
    name: mode.label,
    languageModel: mode.model,
    instructions: mode.instructions,
    tools: toolsFor(mode),
    stopWhen: stepCountIs(mode.stepBudget),
  });
}

/**
 * Keyed by the full config, not the mode name, because the config is editable
 * at runtime now. Changing the model in the dashboard has to take effect on the
 * next turn, not on the next cold start.
 */
const cache = new Map<string, ReturnType<typeof buildAgent>>();

function cacheKey(mode: Mode): string {
  return [
    mode.name,
    mode.model,
    mode.stepBudget,
    mode.tools.join(","),
    mode.instructions.length,
  ].join("|");
}

export function agentFor(mode: Mode) {
  const key = cacheKey(mode);
  let agent = cache.get(key);
  if (!agent) {
    agent = buildAgent(mode);
    // Bounded, so a long run of edits cannot grow this without limit.
    if (cache.size > 16) cache.clear();
    cache.set(key, agent);
  }
  return agent;
}
