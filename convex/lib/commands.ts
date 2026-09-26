/**
 * Chat slash commands, shared by the Telegram handler and the web composer.
 * Pure functions with no server imports, so the browser bundle can use them.
 */

export type ModelOption = {
  id: string;
  name: string;
  isDefault: boolean;
  /** The reasoning efforts it takes, from `model/list`. Unset from a runner that predates them. */
  efforts?: string[];
  defaultEffort?: string;
};

/** How far a chat's Codex turns may reach; see vAccess in schema.ts. */
export type Access = "supervised" | "full";

/** What /compact reports once Codex has summarised the chat's thread. */
export const COMPACTED = "Compacted. Codex now works from a summary of this chat; the messages here are unchanged.";

/** "/model", "/model <name>", "/set model <name>" (and "/model@botname" on Telegram). */
export function parseModelCommand(text: string): { name?: string } | null {
  const match = text.trim().match(/^\/(?:set\s+)?model(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  return match ? { name: match[1]?.trim() || undefined } : null;
}

/**
 * Match a model by id or display name, ignoring case. An exact match wins;
 * otherwise a name that matches exactly one model by substring picks it, so
 * "/model luna" works while there is only one Luna.
 */
export function findModel(models: ModelOption[], name: string): { model?: ModelOption; matches: ModelOption[] } {
  const wanted = name.trim().toLowerCase();
  const slug = wanted.replace(/\s+/g, "-");
  const exact = models.find((model) => model.id.toLowerCase() === slug || model.name.toLowerCase() === wanted);
  if (exact) return { model: exact, matches: [exact] };
  const matches = models.filter((model) => model.id.toLowerCase().includes(slug) || model.name.toLowerCase().includes(wanted));
  return { model: matches.length === 1 ? matches[0] : undefined, matches };
}

/** The effective model: the chat's pick while the account still offers it, else Codex's default. */
export function currentModel(models: ModelOption[], picked?: string): string | undefined {
  if (picked && (!models.length || models.some((model) => model.id === picked))) return picked;
  return (models.find((model) => model.isDefault) ?? models[0])?.id;
}

/** The reply to "/model": every model, with the current one marked. */
export function describeModels(models: ModelOption[], picked?: string): string {
  if (!models.length) return "No Codex models yet. Start the runner and sign in to Codex, then try again.";
  const current = currentModel(models, picked);
  return [
    "Codex models:",
    ...models.map((model) => `${model.id === current ? "•" : " "} ${model.id}${model.name.toLowerCase() !== model.id ? ` (${model.name})` : ""}${model.isDefault ? ", default" : ""}`),
    "",
    "Switch with /model <name>.",
  ].join("\n");
}

/**
 * The reply to "/model <name>": switched, ambiguous, or unknown. A chat's
 * thinking level the new model does not take is kept, and said to be unused.
 */
export function pickModel(models: ModelOption[], name: string, effort?: string): { model?: ModelOption; reply: string } {
  const { model, matches } = findModel(models, name);
  if (model) {
    const unused = effortUnused(model, effort) ? ` Its thinking level, ${effort}, is not one ${model.name} takes, so the model's default is used.` : "";
    return { model, reply: `This chat now uses ${model.name} (${model.id}).${unused}` };
  }
  if (matches.length > 1) return { reply: `"${name}" matches ${matches.map((item) => item.id).join(", ")}. Be more specific.` };
  return { reply: `No Codex model called "${name}". /model lists them.` };
}

/** A run's model as the Activity page shows it: "codex/<model> · <effort>", and "· full access" when it was. */
export function runLabel(model?: string, effort?: string, access?: Access): string {
  return [model ? `codex/${model}` : "codex subscription", effort, access === "full" ? "full access" : undefined]
    .filter(Boolean).join(" · ");
}

// --- Thinking level (/think) ----------------------------------------------

/** "/think", "/think <level>" (and "/think@botname" on Telegram). */
export function parseThinkCommand(text: string): { level?: string } | null {
  const match = text.trim().match(/^\/think(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  return match ? { level: match[1]?.trim().toLowerCase() || undefined } : null;
}

/** The model a chat's thinking level applies to: its pick, else Codex's default. */
export function chatModel(models: ModelOption[], picked?: string): ModelOption | undefined {
  const id = currentModel(models, picked);
  return models.find((model) => model.id === id);
}

/** A level is set that this model does not take (or has not said what it takes). */
export function effortUnused(model: ModelOption, effort?: string): boolean {
  return Boolean(effort && !model.efforts?.includes(effort));
}

/**
 * The effort a turn starts with: the chat's level when its model takes it,
 * else the model's default. Codex keeps a thread's effort for later turns, so
 * the default is sent too, or a level picked earlier would outlast
 * "/think default". Unset when the runner has not reported efforts.
 */
export function turnEffort(models: ModelOption[], picked?: string, effort?: string): string | undefined {
  const model = chatModel(models, picked);
  if (!model?.efforts?.length) return undefined;
  return effort && model.efforts.includes(effort) ? effort : model.defaultEffort;
}

const NO_MODELS = "No Codex models yet. Start the runner and sign in to Codex, then try again.";

/** The reply to "/think": the model's levels, with the chat's marked. */
export function describeEfforts(models: ModelOption[], picked?: string, effort?: string): string {
  const model = chatModel(models, picked);
  if (!model) return NO_MODELS;
  if (!model.efforts?.length) return `${model.name} has not reported its thinking levels. Restart the runner, then try again.`;
  const current = effort && model.efforts.includes(effort) ? effort : undefined;
  return [
    `Thinking levels for ${model.name}:`,
    `${current ? " " : "•"} default${model.defaultEffort ? ` (${model.defaultEffort})` : ""}`,
    ...model.efforts.map((level) => `${level === current ? "•" : " "} ${level}`),
    ...(effortUnused(model, effort) ? ["", `This chat's level, ${effort}, is not one ${model.name} takes, so the default is used.`] : []),
    "",
    "Switch with /think <level>, or /think default.",
  ].join("\n");
}

/**
 * The reply to "/think <level>", and what to save: a level, or undefined for
 * the model's default. A level the model does not take is refused, naming the
 * ones it does.
 */
export function pickEffort(
  models: ModelOption[], picked: string | undefined, level: string,
): { ok: true; effort?: string; reply: string } | { ok: false; reply: string } {
  const model = chatModel(models, picked);
  const wanted = level.trim().toLowerCase();
  if (wanted === "default") {
    return { ok: true, effort: undefined, reply: `This chat now thinks at ${model?.name ?? "the model"}'s default level${model?.defaultEffort ? ` (${model.defaultEffort})` : ""}.` };
  }
  if (!model) return { ok: false, reply: NO_MODELS };
  if (!model.efforts?.includes(wanted)) {
    const levels = model.efforts?.length ? ` It takes ${model.efforts.join(", ")}.` : "";
    return { ok: false, reply: `${model.name} has no thinking level "${level}".${levels} /think lists them.` };
  }
  return { ok: true, effort: wanted, reply: `This chat now thinks at ${wanted} on ${model.name}.` };
}

// --- Access (/access) -----------------------------------------------------

export const ACCESS_LABELS: Record<Access, string> = { supervised: "Supervised", full: "Full access" };

/** "/access", "/access <mode>" (and "/access@botname" on Telegram). */
export function parseAccessCommand(text: string): { mode?: string } | null {
  const match = text.trim().match(/^\/access(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  return match ? { mode: match[1]?.trim().toLowerCase() || undefined } : null;
}

/** The reply to "/access": this chat's access, and what each means. */
export function describeAccess(access: Access): string {
  return [
    `This chat is ${access === "full" ? "on Full access" : "Supervised"}.`,
    "",
    `${access === "supervised" ? "•" : " "} supervised  Codex works in its sandbox and asks you before anything beyond it`,
    `${access === "full" ? "•" : " "} full        no sandbox, and Codex acts on this computer without asking`,
    "",
    "Switch with /access supervised or /access full.",
  ].join("\n");
}

/** The reply to "/access <mode>"; "full access" and "full-access" count as full. */
export function pickAccess(mode: string): { access?: Access; reply: string } {
  const wanted = mode.trim().toLowerCase().replace(/[\s-]+access$/, "");
  if (wanted === "supervised") {
    return { access: "supervised", reply: "This chat is Supervised: Codex works in its sandbox and asks you before anything beyond it." };
  }
  if (wanted === "full") {
    return {
      access: "full",
      reply: "This chat is on Full access: Codex runs without its sandbox and acts without asking. Every command still shows in the trace. /access supervised turns it back.",
    };
  }
  return { reply: `No access called "${mode}". Use /access supervised or /access full.` };
}
