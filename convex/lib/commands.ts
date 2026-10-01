/**
 * Chat slash commands, shared by the Telegram handler and the web composer.
 * Pure functions with no server imports, so the browser bundle can use them.
 */

import { ENGINE_LABELS, ENGINES, modelKey, parseModelKey, type EngineKind } from "./engines";

export type ModelOption = {
  id: string;
  name: string;
  isDefault: boolean;
  /** The engine that offers it (models.ts tags each with its engine). */
  engine: EngineKind;
  /** The reasoning efforts it takes, from `model/list`. Unset from a runner that predates them. */
  efforts?: string[];
  defaultEffort?: string;
};

/** One engine's models; none for no engine. */
export const modelsOf = (models: ModelOption[], engine: EngineKind | undefined) => models.filter((model) => model.engine === engine);
/** Engines with models to pick, in the order ENGINES lists them. */
export const enginesOf = (models: ModelOption[]) => ENGINES.filter((engine) => models.some((model) => model.engine === engine));

/**
 * What a chat may do without asking, one setting per chat (Settings picks the
 * one a new chat starts with). Each engine honours these its own way
 * (runner/engine.ts); for Codex:
 *
 *   supervised  "Ask": Codex works in its sandbox, and asks the owner before
 *               anything beyond it.
 *   auto        "Auto": no sandbox, but a reviewer checks each command
 *               first, runs the routine ones and asks the owner about the rest.
 *   full        "Full access": no sandbox, and it never asks.
 *
 * A change applies at once, to a turn already running too: its engine is
 * told (runner/engine.ts, setAccess), and each approval is decided by the
 * chat's access when it is asked (convex/approvals.ts).
 */
export type Access = "supervised" | "auto" | "full";
export const ACCESSES: readonly Access[] = ["supervised", "auto", "full"];

/** What /compact reports once the chat's engine has summarised its session. */
export const COMPACTED = "Compacted. Perry now works from a summary of this chat; the messages here are unchanged.";

/** "/model", "/model <name>", "/set model <name>" (and "/model@botname" on Telegram). */
export function parseModelCommand(text: string): { name?: string } | null {
  const match = text.trim().match(/^\/(?:set\s+)?model(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  return match ? { name: match[1]?.trim() || undefined } : null;
}

/**
 * Match a model by id or display name, ignoring case, or by "<engine>/<id>".
 * An exact match wins; otherwise a name that matches exactly one model by
 * substring picks it, so "/model luna" works while there is only one Luna.
 * The same name on two engines is the chat's own engine's.
 */
export function findModel(models: ModelOption[], name: string, engine?: EngineKind): { model?: ModelOption; matches: ModelOption[] } {
  const wanted = name.trim().toLowerCase();
  const slug = wanted.replace(/\s+/g, "-");
  const one = (found: ModelOption[]) => found.length === 1 ? found[0] : found.find((model) => engine !== undefined && model.engine === engine);
  const qualified = models.filter((model) => modelKey(model.engine, model.id).toLowerCase() === slug);
  const exact = qualified.length ? qualified : models.filter((model) => model.id.toLowerCase() === slug || model.name.toLowerCase() === wanted);
  const picked = one(exact);
  if (picked) return { model: picked, matches: [picked] };
  if (exact.length > 1) return { matches: exact };
  const matches = models.filter((model) => model.id.toLowerCase().includes(slug) || model.name.toLowerCase().includes(wanted));
  return { model: one(matches), matches };
}

/** The effective model: the chat's pick while its engine still offers it, else that engine's default. None without an engine. */
export function currentModel(models: ModelOption[], picked: string | undefined, engine: EngineKind | undefined): string | undefined {
  if (!engine) return undefined;
  const offered = modelsOf(models, engine);
  if (picked && (!offered.length || offered.some((model) => model.id === picked))) return picked;
  return (offered.find((model) => model.isDefault) ?? offered[0])?.id;
}

const NO_MODELS = "No models yet. Start the runner and sign in to an engine in Settings → Engines, then try again.";
/** For /think in a chat with no engine of its own while the owner has not chosen a default. */
const NO_ENGINE_YET = "Perry has no default engine yet. Pick a model for this chat with /model <name>, or choose the default in Settings → Engines.";

/** The reply to "/model": every engine's models, with the chat's current one marked. */
export function describeModels(models: ModelOption[], picked: string | undefined, engine: EngineKind | undefined): string {
  if (!models.length) return NO_MODELS;
  const current = currentModel(models, picked, engine);
  const engines = enginesOf(models);
  return [
    ...engines.flatMap((kind, index) => [
      ...(index ? [""] : []),
      `${ENGINE_LABELS[kind]} models:`,
      ...modelsOf(models, kind).map((model) =>
        `${kind === engine && model.id === current ? "•" : " "} ${model.id}${model.name.toLowerCase() !== model.id ? ` (${model.name})` : ""}${model.isDefault ? ", default" : ""}`),
    ]),
    "",
    !engine ? "Perry has no default engine yet. Pick one for this chat with /model <name>, or choose the default in Settings → Engines."
      : engines.length > 1
      ? "Switch with /model <name>. Another engine's model moves this chat to that engine, which picks up from the chat so far."
      : "Switch with /model <name>.",
  ].join("\n");
}

/**
 * The reply to "/model <name>": switched, ambiguous, or unknown. A chat's
 * thinking level the new model does not take is kept, and said to be unused.
 */
export function pickModel(models: ModelOption[], name: string, effort: string | undefined, engine: EngineKind | undefined): { model?: ModelOption; reply: string } {
  const { model, matches } = findModel(models, name, engine);
  if (model) {
    const unused = effortUnused(model, effort) ? ` Its thinking level, ${effort}, is not one ${model.name} takes, so the model's default is used.` : "";
    const moved = !engine ? ` It runs on ${ENGINE_LABELS[model.engine]}.`
      : model.engine !== engine ? ` It moves to ${ENGINE_LABELS[model.engine]}, which picks up from the chat so far.` : "";
    return { model, reply: `This chat now uses ${model.name} (${model.id}).${moved}${unused}` };
  }
  if (matches.length > 1) {
    const names = matches.map((item) => enginesOf(matches).length > 1 ? modelKey(item.engine, item.id) : item.id);
    return { reply: `"${name}" matches ${names.join(", ")}. Be more specific.` };
  }
  return { reply: `No model called "${name}". /model lists them.` };
}

/** A run's model as the activity log shows it: "<engine>/<model> · <effort>", and "· full access" when it was. "no engine" for a turn refused for want of one. */
export function runLabel(model: string | undefined, effort: string | undefined, access: Access | undefined, engine: EngineKind | undefined): string {
  return [!engine ? "no engine" : model ? `${engine}/${model}` : `${engine} subscription`, effort, access === "full" ? "full access" : access === "auto" ? "auto" : undefined]
    .filter(Boolean).join(" · ");
}

export { modelKey, parseModelKey };

// --- Thinking level (/think) ----------------------------------------------

/** "/think", "/think <level>" (and "/think@botname" on Telegram). */
export function parseThinkCommand(text: string): { level?: string } | null {
  const match = text.trim().match(/^\/think(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  return match ? { level: match[1]?.trim().toLowerCase() || undefined } : null;
}

/** The model a chat's thinking level applies to: its pick, else its engine's default. */
export function chatModel(models: ModelOption[], picked: string | undefined, engine: EngineKind | undefined): ModelOption | undefined {
  const id = currentModel(models, picked, engine);
  return modelsOf(models, engine).find((model) => model.id === id);
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
export function turnEffort(models: ModelOption[], picked: string | undefined, effort: string | undefined, engine: EngineKind | undefined): string | undefined {
  const model = chatModel(models, picked, engine);
  if (!model?.efforts?.length) return undefined;
  return effort && model.efforts.includes(effort) ? effort : model.defaultEffort;
}

/** The reply to "/think": the model's levels, with the chat's marked. */
export function describeEfforts(models: ModelOption[], picked: string | undefined, effort: string | undefined, engine: EngineKind | undefined): string {
  const model = chatModel(models, picked, engine);
  if (!model) return engine ? NO_MODELS : NO_ENGINE_YET;
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
  models: ModelOption[], picked: string | undefined, level: string, engine: EngineKind | undefined,
): { ok: true; effort?: string; reply: string } | { ok: false; reply: string } {
  const model = chatModel(models, picked, engine);
  const wanted = level.trim().toLowerCase();
  if (wanted === "default") {
    return { ok: true, effort: undefined, reply: `This chat now thinks at ${model?.name ?? "the model"}'s default level${model?.defaultEffort ? ` (${model.defaultEffort})` : ""}.` };
  }
  if (!model) return { ok: false, reply: engine ? NO_MODELS : NO_ENGINE_YET };
  if (!model.efforts?.includes(wanted)) {
    const levels = model.efforts?.length ? ` It takes ${model.efforts.join(", ")}.` : "";
    return { ok: false, reply: `${model.name} has no thinking level "${level}".${levels} /think lists them.` };
  }
  return { ok: true, effort: wanted, reply: `This chat now thinks at ${wanted} on ${model.name}.` };
}

// --- Access (/access) -----------------------------------------------------

export const ACCESS_LABELS: Record<Access, string> = { supervised: "Ask", auto: "Auto", full: "Full access" };

/** One line each, for the ⓘ beside a choice and for /access. */
export const ACCESS_HINTS: Record<Access, string> = {
  supervised: "Works in its sandbox and asks you before anything beyond it.",
  auto: "A reviewer checks each command before it runs: routine ones go ahead on their own, risky ones come to you.",
  full: "No sandbox, and it never asks. It can change anything your account can.",
};

/** What /access and the settings call each: "ask" is supervised, and the old name still works. */
const ACCESS_WORDS: Record<string, Access> = { ask: "supervised", supervised: "supervised", auto: "auto", full: "full" };

/** "/access", "/access <mode>" (and "/access@botname" on Telegram). */
export function parseAccessCommand(text: string): { mode?: string } | null {
  const match = text.trim().match(/^\/access(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  return match ? { mode: match[1]?.trim().toLowerCase() || undefined } : null;
}

/** The reply to "/access": this chat's access, and what each means. */
export function describeAccess(access: Access): string {
  return [
    `This chat is on ${ACCESS_LABELS[access]}.`,
    "",
    ...ACCESSES.map((mode) => `${mode === access ? "•" : " "} ${ACCESS_LABELS[mode].toLowerCase().replace(" access", "").padEnd(5)} ${ACCESS_HINTS[mode]}`),
    "",
    "Switch with /access ask, /access auto or /access full. It applies at once, to a reply already running too.",
  ].join("\n");
}

/** The reply to "/access <mode>"; "full access" and "full-access" count as full. */
export function pickAccess(mode: string): { access?: Access; reply: string } {
  const access = ACCESS_WORDS[mode.trim().toLowerCase().replace(/[\s-]+access$/, "")];
  if (!access) return { reply: `No access called "${mode}". Use /access ask, /access auto or /access full.` };
  return { access, reply: `This chat is on ${ACCESS_LABELS[access]}: ${ACCESS_HINTS[access]} It applies at once, to a reply already running too.` };
}

// --- Skills ($name) -------------------------------------------------------

/**
 * "$weekly-review" in a message names a skill, as in Codex: a skill's name
 * (lowercase letters, digits and hyphens) after a $ that does not follow a
 * word, so "US$5" and "$$" name none. A name no skill has is left as text.
 */
export const SKILL_MENTION = /(?<![\w$])\$([a-z0-9][a-z0-9-]{0,63})/g;

/** The skill names a message mentions, once each, in order. */
export function skillMentions(text: string): string[] {
  return [...new Set([...text.matchAll(SKILL_MENTION)].map((match) => match[1]))];
}

/** The $name being typed at the end of `before` (the text up to the caret), for the composer to complete. */
export function typingSkill(before: string): { start: number; typed: string } | null {
  const match = before.match(/(?:^|[^\w$])\$([a-z0-9-]*)$/);
  return match ? { start: before.length - match[1].length - 1, typed: match[1] } : null;
}
