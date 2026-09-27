import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { enginesOf, modelsOf, type ModelOption } from "./lib/commands";
import { ENGINE_LABELS, ENGINES, type EngineKind } from "./lib/engines";
import { defaultEngine, statusesOf } from "./engines";

/**
 * The models a chat can use, each tagged with its engine. An engine's come
 * from the most recently seen runner where it is signed in, because a
 * subscription's catalogue is only visible from the engine's own CLI.
 */
async function engineModels(ctx: QueryCtx): Promise<ModelOption[]> {
  const runners = (await ctx.db.query("runners").order("desc").take(20))
    .filter((item) => !item.revoked)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  return ENGINES.flatMap((engine) => {
    for (const runner of runners) {
      const status = statusesOf(runner).find((item) => item.kind === engine);
      if (status?.signedIn && status.models.length) return status.models.map((model) => ({ ...model, engine }));
    }
    return [];
  });
}

/** For the composer's and the Work page's pickers, and their slash commands. */
export const options = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ models: ModelOption[]; engines: Array<{ kind: EngineKind; label: string }>; defaultEngine: EngineKind; codex: ModelOption[] }> => {
    assertDashboardKey(args.key);
    const models = await engineModels(ctx);
    return {
      models,
      // Pickers with nothing picked show this engine's default model.
      defaultEngine: await defaultEngine(ctx),
      engines: enginesOf(models).map((kind) => ({ kind, label: ENGINE_LABELS[kind] })),
      // Codex's alone, as scripts from before engines read them.
      codex: modelsOf(models, "codex"),
    };
  },
});

/** For Telegram's and WhatsApp's /model and /think, and the turn's model (brain.ts). */
export const list = internalQuery({
  args: {},
  handler: async (ctx): Promise<ModelOption[]> => await engineModels(ctx),
});
