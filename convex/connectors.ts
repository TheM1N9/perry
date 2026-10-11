import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Connector, SearchResult } from "./composio";
import type { GitHubConnection } from "./github";

/**
 * The apps the agent's three app tools (tools.ts: list_connectors, find_action,
 * run_action) and Apps & skills reach, as one: those connected through
 * Composio (composio.ts) and GitHub, connected with a token (github.ts).
 */

/** GitHub as a connector: listed when a token is kept, connected only while GitHub accepts it. */
function gitHub(found: GitHubConnection): Connector[] {
  if (found.state === "none") return [];
  if (found.state === "working") return [{ slug: "github", name: "GitHub", connected: true, status: "ACTIVE", needsAuth: true, account: found.login }];
  return [{ slug: "github", name: "GitHub", connected: false, status: found.state === "refused" ? "EXPIRED" : "UNREACHABLE", needsAuth: true, error: found.error }];
}

export const list = internalAction({
  args: {},
  handler: async (ctx): Promise<{ configured: boolean; connectors: Connector[]; error?: string }> => {
    const [composio, github] = await Promise.all([
      ctx.runAction(internal.composio.connectors, {}),
      ctx.runAction(internal.github.connection, {}),
    ]);
    return { ...composio, connectors: [...gitHub(github), ...composio.connectors] };
  },
});

export const search = internalAction({
  args: { query: v.string(), toolkits: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<SearchResult> => {
    const [composio, github] = await Promise.all([
      ctx.runAction(internal.composio.search, args),
      ctx.runAction(internal.github.search, args),
    ]);
    const notConnected = [...github.notConnected ?? [], ...composio.notConnected ?? []];
    return { ...composio, actions: [...github.actions, ...composio.actions], ...(notConnected.length ? { notConnected } : {}) };
  },
});

export const execute = internalAction({
  args: { slug: v.string(), args: v.optional(v.any()) },
  handler: async (ctx, input): Promise<{ ok: boolean; data?: unknown; next?: string; error?: string }> => {
    return input.slug.toUpperCase().startsWith("GITHUB_")
      ? await ctx.runAction(internal.github.execute, input)
      : await ctx.runAction(internal.composio.execute, input);
  },
});
