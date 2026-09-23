import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import type { ModelOption } from "./lib/commands";

/**
 * The Codex models a chat can use. They come from `model/list` on the most
 * recently seen signed-in runner, because the subscription's catalogue is only
 * visible from the CLI.
 */
async function codexModels(ctx: QueryCtx): Promise<ModelOption[]> {
  const runners = await ctx.db.query("runners").order("desc").take(20);
  const runner = runners
    .filter((item) => !item.revoked && item.codexAuthMode === "chatgpt" && item.codexModels?.length)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
  return runner?.codexModels ?? [];
}

/** For the composer's picker and its slash commands. */
export const options = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ codex: ModelOption[] }> => {
    assertDashboardKey(args.key);
    return { codex: await codexModels(ctx) };
  },
});

/** For Telegram's /model. */
export const list = internalQuery({
  args: {},
  handler: async (ctx): Promise<ModelOption[]> => await codexModels(ctx),
});
