import { v } from "convex/values";
import { query } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";

/**
 * The Codex models the composer's picker offers. They come from `model/list`
 * on the most recently seen signed-in runner, because the subscription's
 * catalogue is only visible from the CLI.
 */
export const options = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ codex: Array<{ id: string; name: string; isDefault: boolean }> }> => {
    assertDashboardKey(args.key);
    const runners = await ctx.db.query("runners").order("desc").take(20);
    const runner = runners
      .filter((item) => !item.revoked && item.codexAuthMode === "chatgpt" && item.codexModels?.length)
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
    return { codex: runner?.codexModels ?? [] };
  },
});
