import { Agent, stepCountIs } from "@convex-dev/agent";
import { components } from "./_generated/api";
import { MODES, type Mode, type ModeName } from "./modes";
import { ALL_TOOLS } from "./tools";

/**
 * One Agent per mode. The mode decides the model, the instructions, the step
 * ceiling, and the tool allowlist, and those are baked in at construction.
 *
 * This is the whole enforcement story: tools outside the mode's allowlist are
 * never bound, so they are not in the model's vocabulary for that turn. There
 * is no runtime permission check to forget to write.
 *
 * Models are passed as `provider/model` strings and resolved by the AI SDK
 * through the Vercel AI Gateway. Passing a provider object instead would mean
 * pinning a second copy of @ai-sdk/provider and matching its specification
 * version to the one the Agent component expects, which is a version-skew
 * argument nobody wins.
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

const cache = new Map<ModeName, ReturnType<typeof buildAgent>>();

export function agentFor(name: ModeName) {
  let agent = cache.get(name);
  if (!agent) {
    agent = buildAgent(MODES[name]);
    cache.set(name, agent);
  }
  return agent;
}
