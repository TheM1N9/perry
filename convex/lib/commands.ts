/**
 * Chat slash commands, shared by the Telegram handler and the web composer.
 * Pure functions with no server imports, so the browser bundle can use them.
 */

export type ModelOption = { id: string; name: string; isDefault: boolean };

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

/** The effective model: the chat's pick, else Codex's default. */
export function currentModel(models: ModelOption[], picked?: string): string | undefined {
  return picked ?? (models.find((model) => model.isDefault) ?? models[0])?.id;
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

/** The reply to "/model <name>": switched, ambiguous, or unknown. */
export function pickModel(models: ModelOption[], name: string): { model?: ModelOption; reply: string } {
  const { model, matches } = findModel(models, name);
  if (model) return { model, reply: `This chat now uses ${model.name} (${model.id}).` };
  if (matches.length > 1) return { reply: `"${name}" matches ${matches.map((item) => item.id).join(", ")}. Be more specific.` };
  return { reply: `No Codex model called "${name}". /model lists them.` };
}
