"use node";

import { Composio } from "@composio/core";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/**
 * Perry's hands on your accounts, through Composio.
 *
 * The important property: Perry does not ship a Gmail tool, a Calendar tool
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
 * Perry never sees a token. OAuth lives with Composio, and this deployment
 * holds one API key that can act only on the accounts you linked.
 */

/**
 * One owner per install, so the Composio user id is a constant. This is the
 * same reasoning as the rest of Perry: the isolation boundary is the
 * deployment, not a row.
 */
const USER_ID = "owner";

function client(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "COMPOSIO_API_KEY is not set, so no accounts are connected. Get a key " +
        "at composio.dev, then: npx convex env set COMPOSIO_API_KEY <key>",
    );
  }
  return new Composio({ apiKey });
}

async function session(toolkits?: string[]) {
  return await client().sessions.create(USER_ID, {
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
 * list, not the catalogue.
 */
export const connectors = internalAction({
  args: {},
  handler: async (): Promise<{
    configured: boolean;
    connectors: Connector[];
    error?: string;
  }> => {
    if (!process.env.COMPOSIO_API_KEY) {
      return {
        configured: false,
        connectors: [],
        error: "No COMPOSIO_API_KEY on this deployment.",
      };
    }

    try {
      const s = await session();
      const { items } = await s.toolkits();

      const connectors = items
        .filter((t) => t.connection?.isActive || t.isNoAuth)
        .map((t) => ({
          slug: t.slug,
          name: t.name,
          connected: Boolean(t.connection?.isActive) || t.isNoAuth,
          status: t.connection?.connectedAccount?.status,
          needsAuth: !t.isNoAuth,
        }));

      return { configured: true, connectors };
    } catch (error) {
      return { configured: true, connectors: [], error: message(error) };
    }
  },
});

/**
 * Start an OAuth flow for a toolkit and hand back the URL to open.
 *
 * The owner finishes it in a browser. Perry only ever learns that the account
 * exists, never the token behind it.
 */
export const authorize = internalAction({
  args: { toolkit: v.string() },
  handler: async (
    _ctx,
    args,
  ): Promise<{ redirectUrl?: string; status?: string; error?: string }> => {
    try {
      const s = await session();
      const request = await s.authorize(args.toolkit.toLowerCase().trim());

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

/**
 * Find the actual operation for a request, across connected accounts.
 *
 * The agent calls this before acting, which is what makes a newly connected
 * account usable immediately: the tool list is looked up at the moment of use
 * rather than baked in at deploy time.
 */
export const search = internalAction({
  args: { query: v.string(), toolkits: v.optional(v.array(v.string())) },
  handler: async (
    _ctx,
    args,
  ): Promise<{ actions: FoundAction[]; error?: string }> => {
    try {
      const s = await session(args.toolkits);
      const found = await s.search({
        query: args.query,
        ...(args.toolkits && args.toolkits.length > 0
          ? { toolkits: args.toolkits }
          : {}),
      });

      const raw = found as unknown as Record<string, unknown>;
      const list = Array.isArray(raw.items)
        ? raw.items
        : Array.isArray(raw.tools)
          ? raw.tools
          : Array.isArray(found)
            ? (found as unknown[])
            : [];

      const actions: FoundAction[] = list.slice(0, 15).map((entry) => {
        const tool = entry as Record<string, unknown>;
        return {
          slug: String(tool.slug ?? tool.name ?? ""),
          description:
            typeof tool.description === "string"
              ? tool.description.slice(0, 400)
              : undefined,
          toolkit:
            typeof tool.toolkit === "string"
              ? tool.toolkit
              : typeof tool.toolkitSlug === "string"
                ? (tool.toolkitSlug as string)
                : undefined,
          inputSchema: tool.inputSchema ?? tool.input_parameters ?? tool.parameters,
        };
      });

      return { actions: actions.filter((a) => a.slug.length > 0) };
    } catch (error) {
      return { actions: [], error: message(error) };
    }
  },
});

/** Run one action on a connected account. */
export const execute = internalAction({
  args: { slug: v.string(), args: v.optional(v.any()) },
  handler: async (
    _ctx,
    input,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    try {
      const s = await session();
      const result = await s.execute(
        input.slug,
        (input.args ?? {}) as Record<string, unknown>,
      );

      const raw = result as unknown as Record<string, unknown>;
      if (raw.successful === false || raw.successfull === false) {
        return {
          ok: false,
          error:
            typeof raw.error === "string" ? raw.error : "The action failed.",
          data: raw.data,
        };
      }

      return { ok: true, data: raw.data ?? result };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  },
});
