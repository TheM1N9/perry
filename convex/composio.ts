"use node";

import { Composio } from "@composio/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/**
 * Assistant's hands on your accounts, through Composio.
 *
 * The important property: Assistant does not ship a Gmail tool, a Calendar tool
 * and a Notion tool. It ships three tools that ask Composio what you have
 * connected and use whatever that turns out to be. Connect Google Calendar in
 * the dashboard and the next turn can already create events, with no redeploy
 * and no code change here. Disconnect it and the ability disappears the same
 * way.
 *
 * That is Composio's Tool Router: a session exposes search and execute over
 * your connected accounts, instead of stuffing a thousand tool schemas into
 * the model's context.
 *
 * Assistant never sees a token. OAuth lives with Composio, and this deployment
 * holds one API key that can act only on the accounts you linked.
 */

/**
 * One owner per install, so the Composio user id is a constant. This is the
 * same reasoning as the rest of Assistant: the isolation boundary is the
 * deployment, not a row.
 */
const USER_ID = "owner";

function client(apiKey: string | null): Composio {
  if (!apiKey) {
    throw new Error(
      "COMPOSIO_API_KEY is not set, so no accounts are connected. Get a key " +
        "at composio.dev, then: pnpm exec convex env set COMPOSIO_API_KEY <key>",
    );
  }
  return new Composio({ apiKey });
}

async function session(apiKey: string | null, toolkits?: string[]) {
  return await client(apiKey).sessions.create(USER_ID, {
    manageConnections: true,
    ...(toolkits && toolkits.length > 0 ? { toolkits } : {}),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Connector = {
  slug: string;
  name: string;
  connected: boolean;
  status?: string;
  needsAuth: boolean;
};

/**
 * What the owner has actually connected.
 *
 * Returns only live connections, because the full Composio catalogue is over a
 * thousand toolkits and the agent asking "what can I reach" wants the short
 * list, not the catalogue. Composio filters server-side and pages the result,
 * so every page is read: a connection can sit anywhere in the catalogue order.
 */
export const connectors = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    configured: boolean;
    connectors: Connector[];
    error?: string;
  }> => {
    const apiKey: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "COMPOSIO_API_KEY",
    });
    if (!apiKey) {
      return {
        configured: false,
        connectors: [],
        error: "No Composio key yet. Add one on the Keys page.",
      };
    }

    try {
      const s = await session(apiKey);
      const connectors: Connector[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.toolkits({ isConnected: true, cursor });
        for (const t of page.items) {
          if (!t.connection?.isActive && !t.isNoAuth) continue;
          connectors.push({
            slug: t.slug,
            name: t.name,
            connected: true,
            status: t.connection?.connectedAccount?.status,
            needsAuth: !t.isNoAuth,
          });
        }
        cursor = page.cursor;
      } while (cursor);

      return { configured: true, connectors };
    } catch (error) {
      return { configured: true, connectors: [], error: message(error) };
    }
  },
});

/**
 * Start an OAuth flow for a toolkit and hand back the URL to open.
 *
 * The owner finishes it in a browser. Assistant only ever learns that the account
 * exists, never the token behind it. Without a callback URL, Composio's
 * hosted page ends the flow on its own screen instead of sending you back.
 */
export const authorize = internalAction({
  args: { toolkit: v.string(), callbackUrl: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ redirectUrl?: string; status?: string; error?: string }> => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, {
        name: "COMPOSIO_API_KEY",
      });
      const s = await session(apiKey);
      const request = await s.authorize(
        args.toolkit.toLowerCase().trim(),
        args.callbackUrl ? { callbackUrl: args.callbackUrl } : undefined,
      );

      const raw = request as unknown as Record<string, unknown>;
      const redirectUrl =
        typeof raw.redirectUrl === "string"
          ? raw.redirectUrl
          : typeof raw.redirect_url === "string"
            ? (raw.redirect_url as string)
            : undefined;

      return {
        redirectUrl,
        status: typeof raw.status === "string" ? raw.status : undefined,
        ...(redirectUrl
          ? {}
          : { error: "Composio did not return a link to open." }),
      };
    } catch (error) {
      return { error: message(error) };
    }
  },
});

export type FoundAction = {
  slug: string;
  description?: string;
  toolkit?: string;
  inputSchema?: unknown;
};

export type SearchResult = {
  actions: FoundAction[];
  /** Composio's advice for the matched use cases: how to run them and what goes wrong. */
  guidance?: Array<{ useCase: string; executionGuidance?: string; knownPitfalls?: string[]; steps?: string[] }>;
  /** Toolkits the search needed that are not connected, with why. */
  notConnected?: string[];
  error?: string;
};

/**
 * Find the actual operation for a request, across connected accounts.
 *
 * The agent calls this before acting, which is what makes a newly connected
 * account usable immediately: the tool list is looked up at the moment of use
 * rather than baked in at deploy time.
 */
export const search = internalAction({
  args: { query: v.string(), toolkits: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<SearchResult> => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, {
        name: "COMPOSIO_API_KEY",
      });
      const s = await session(apiKey, args.toolkits);
      const found = await s.search({
        query: args.query,
        ...(args.toolkits && args.toolkits.length > 0
          ? { toolkits: args.toolkits }
          : {}),
      });
      if (!found.success && found.error) return { actions: [], error: found.error };

      const slugs = [...new Set(found.results.flatMap((result) => [...result.primaryToolSlugs, ...result.relatedToolSlugs]))];
      const actions = slugs.slice(0, 15).map((slug) => {
        const schema = found.toolSchemas[slug];
        return {
          slug,
          toolkit: schema?.toolkit,
          description: schema?.description?.slice(0, 400),
          inputSchema: schema?.inputSchema,
        };
      });
      const notConnected = found.toolkitConnectionStatuses
        .filter((status) => !status.hasActiveConnection)
        .map((status) => `${status.toolkit}: ${status.statusMessage}`);
      return {
        actions,
        guidance: found.results.slice(0, 3).map((result) => ({
          useCase: result.useCase,
          executionGuidance: result.executionGuidance,
          knownPitfalls: result.knownPitfalls,
          steps: result.recommendedPlanSteps,
        })),
        ...(notConnected.length ? { notConnected } : {}),
      };
    } catch (error) {
      return { actions: [], error: message(error) };
    }
  },
});

/** Run one action on a connected account. */
export const execute = internalAction({
  args: { slug: v.string(), args: v.optional(v.any()) },
  handler: async (
    ctx,
    input,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, {
        name: "COMPOSIO_API_KEY",
      });
      const s = await session(apiKey);
      const result = await s.execute(
        input.slug,
        (input.args ?? {}) as Record<string, unknown>,
      );
      if (result.error) return { ok: false, error: result.error, data: result.data };
      return { ok: true, data: result.data };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  },
});
