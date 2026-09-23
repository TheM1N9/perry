import { createGateway } from "@ai-sdk/gateway";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, query } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import type { Mode } from "./modes";

const vModelOption = v.object({ id: v.string(), name: v.string() });

/**
 * What the composer's model picker offers besides the live gateway catalog.
 *
 * Codex models come from `model/list` on the most recently seen signed-in
 * runner, because the subscription's catalog is only visible from the CLI.
 */
export const options = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{
    defaultEngine: "codex" | "gateway";
    codex: Array<{ id: string; name: string; isDefault: boolean }>;
    gatewayDefaults: Record<string, string>;
  }> => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    const runners = await ctx.db.query("runners").order("desc").take(20);
    const runner = runners
      .filter((item) => !item.revoked && item.codexAuthMode === "chatgpt" && item.codexModels?.length)
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
    const modes: Mode[] = await ctx.runQuery(internal.config.resolveAllModes, {});
    return {
      defaultEngine: install?.chatEngine ?? "codex",
      codex: runner?.codexModels ?? [],
      gatewayDefaults: Object.fromEntries(modes.map((mode) => [mode.name, mode.model])),
    };
  },
});

/** The gateway's language models. Empty without a Vercel key, where only the configured model applies. */
export const gatewayModels = action({
  args: { key: v.string() },
  returns: v.array(vModelOption),
  handler: async (ctx, args): Promise<Array<{ id: string; name: string }>> => {
    assertDashboardKey(args.key);
    const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "AI_GATEWAY_API_KEY" });
    if (!apiKey) return [];
    const { models } = await createGateway({ apiKey }).getAvailableModels();
    return models
      .filter((model) => (model.modelType ?? "language") === "language")
      .map((model) => ({ id: model.id, name: model.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },
});
