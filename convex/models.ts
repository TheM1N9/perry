import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { enginesOf, modelsOf, type ModelOption } from "./lib/commands";
import { ENGINE_LABELS, ENGINES, type EngineKind } from "./lib/engines";
import { statusesOf } from "./engines";
import type { Id } from "./_generated/dataModel";

/**
 * The models a chat can use, each tagged with its engine. An engine's come
 * from the most recently seen runner where it is signed in, because a
 * subscription's catalogue is only visible from the engine's own CLI.
 */
export async function engineModels(ctx: QueryCtx, runnerId?: Id<"runners">): Promise<ModelOption[]> {
  const runners = (runnerId ? [await ctx.db.get(runnerId)].filter((runner): runner is NonNullable<typeof runner> => Boolean(runner)) : await ctx.db.query("runners").collect())
    .filter((item) => !item.revoked && (!runnerId || item._id === runnerId))
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  return ENGINES.flatMap((engine) => {
    for (const runner of runners) {
      const status = statusesOf(runner).find((item) => item.kind === engine);
      if (status?.signedIn && status.models.length) return status.models.map((model) => ({ ...model, engine }));
    }
    return [];
  });
}
export async function chatRunner(ctx: QueryCtx, chat: { projectId?: Id<"projects">; codexRunnerId?: Id<"runners"> } | null) {
  const project = chat?.projectId ? await ctx.db.get(chat.projectId) : null;
  return project?.workspace?.runnerId ?? project?.runnerId ?? chat?.codexRunnerId;
}

/** For the composer's and the Work page's pickers, and their slash commands. */
export const options = query({
  args: { key: v.string(), conversationId: v.optional(v.id("conversations")), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args): Promise<{ models: ModelOption[]; engines: Array<{ kind: EngineKind; label: string }>; codex: ModelOption[] }> => {
    assertDashboardKey(args.key);
    const chat = args.conversationId ? await ctx.db.get(args.conversationId) : null;
    if (args.conversationId && (!chat || chat.contactId)) throw new Error("This chat is unavailable.");
    const models = await engineModels(ctx, await chatRunner(ctx, chat ?? (args.projectId ? { projectId: args.projectId } : null)));
    return {
      models,
      engines: enginesOf(models).map((kind) => ({ kind, label: ENGINE_LABELS[kind] })),
      // Codex's alone, as scripts from before engines read them.
      codex: modelsOf(models, "codex"),
    };
  },
});

/** For Telegram's and WhatsApp's /model and /think, and the turn's model (brain.ts). */
export const list = internalQuery({
  args: { conversationId: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<ModelOption[]> => await engineModels(ctx, await chatRunner(ctx, args.conversationId ? await ctx.db.get(args.conversationId) : null)),
});
