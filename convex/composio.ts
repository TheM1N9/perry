"use node";

import { Composio, ToolRouterSession } from "@composio/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { ToolCtx } from "./lib/agent";
import { z } from "zod";
import { expiredConnection, reconnectMessage } from "./lib/connection-health";
import { DEADLINE_MS, InternetError, publicUrl, type ConnectedRead, type InternetFailure, type InternetRequest, type Platform } from "./lib/internet";

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
        error: "No Composio key yet. Add one in Apps & skills → Connectors.",
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

export type CatalogApp = { slug: string; name: string; logo?: string; description?: string; category?: string };

/** Composio's catalogue changes rarely and is read whole, so it is kept for a while between page loads. */
let catalogCache: { at: number; apps: CatalogApp[] } | null = null;
const CATALOG_TTL_MS = 6 * 60 * 60_000;

/** A description's first sentence, short enough for one line under the name. */
function blurb(description?: string): string | undefined {
  const first = description?.split(/(?<=[.!?])\s/)[0]?.trim();
  return first ? (first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first) : undefined;
}

async function catalogOf(apiKey: string): Promise<CatalogApp[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.apps;
  const toolkits = await client(apiKey).toolkits.get({ limit: 5000 } as never) as unknown as Array<{
    slug: string; name: string; meta?: { logo?: string; description?: string; categories?: Array<{ name?: string }> };
  }>;
  const apps = toolkits.map((toolkit) => ({
    slug: toolkit.slug,
    name: toolkit.name,
    logo: toolkit.meta?.logo,
    description: blurb(toolkit.meta?.description),
    category: toolkit.meta?.categories?.[0]?.name,
  }));
  catalogCache = { at: Date.now(), apps };
  return apps;
}

/** Every app Composio can connect, with its logo and a line about it: the catalogue in Apps & skills → Connectors. */
export const catalog = internalAction({
  args: {},
  handler: async (ctx): Promise<{ apps: CatalogApp[]; error?: string }> => {
    const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
    if (!apiKey) return { apps: [], error: "No Composio key yet. Add one in Apps & skills → Connectors." };
    try {
      return { apps: await catalogOf(apiKey) };
    } catch (error) {
      return { apps: [], error: message(error) };
    }
  },
});

/**
 * A read-only "who am I" per service: Composio keeps no account name, so the
 * service is asked, once per connection. Services not listed show when they
 * were connected instead.
 */
const WHO_AM_I: Record<string, [action: string, args: Record<string, unknown>]> = {
  gmail: ["GMAIL_GET_PROFILE", { user_id: "me" }],
  googlecalendar: ["GOOGLECALENDAR_GET_CALENDAR_PROFILE", {}],
  googledrive: ["GOOGLEDRIVE_GET_ABOUT", {}],
  outlook: ["OUTLOOK_GET_PROFILE", {}],
  github: ["GITHUB_GET_THE_AUTHENTICATED_USER", {}],
  slack: ["SLACK_TEST_AUTH", {}],
  notion: ["NOTION_GET_ABOUT_ME", {}],
  linear: ["LINEAR_GET_CURRENT_USER", {}],
  twitter: ["TWITTER_USER_LOOKUP_ME", {}],
  youtube: ["YOUTUBE_LIST_CHANNELS", { part: "snippet", mine: true }],
};
/** The fields that name an account, best first: an address, then a handle, then a display name. */
const IDENTITY_FIELDS = ["emailAddress", "email", "mail", "userPrincipalName", "login", "username", "screen_name", "handle", "user", "name", "title", "summary"];

/** The best identity in a "who am I" reply, however deep the service put it. */
export function identityOf(data: unknown): string | undefined {
  const found: Record<string, string> = {};
  const queue: Array<[unknown, number]> = [[data, 0]];
  while (queue.length) {
    const [value, depth] = queue.shift()!;
    if (!value || typeof value !== "object" || depth > 4) continue;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (typeof inner === "string" && inner.trim() && IDENTITY_FIELDS.includes(key) && !(key in found)) found[key] = inner.trim();
      else if (inner && typeof inner === "object") queue.push([inner, depth + 1]);
    }
  }
  const best = IDENTITY_FIELDS.find((key) => found[key]);
  return best ? found[best].slice(0, 80) : undefined;
}

export type ConnectedAccount = {
  id: string;
  toolkit: string;
  name: string;
  logo?: string;
  status: string;
  createdAt?: string;
  authExpiredAt?: number;
  /** The account it is signed in to, when the service says. */
  account?: string;
};

/**
 * Every connection, one row per account: a service can be connected twice
 * (two Google accounts), and an expired one is shown so it can be renewed.
 */
export const accounts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ configured: boolean; accounts: ConnectedAccount[]; error?: string }> => {
    const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
    // No key yet is not a failure: the page shows how to set one up, with the key field under it.
    if (!apiKey) return { configured: false, accounts: [] };
    try {
      const composio = client(apiKey);
      const items: Array<{ id: string; status: string; createdAt?: string; alias?: string | null; toolkit: { slug: string } }> = [];
      let cursor: string | undefined;
      do {
        const page = await composio.connectedAccounts.list({ userIds: [USER_ID], limit: 100, ...(cursor ? { cursor } : {}) } as never) as unknown as { items: typeof items; nextCursor?: string | null };
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      const health: Record<string, number> = await ctx.runQuery(internal.connectorHealth.read, { accounts: items.map((item) => ({ accountId: item.id, toolkit: item.toolkit.slug })) });
      const apps = await catalogOf(apiKey).catch(() => [] as CatalogApp[]);
      const known: Record<string, { identity?: string; checkedAt: number }> = await ctx.runQuery(internal.connectorAccounts.identities, { accountIds: items.map((item) => item.id) });
      // Ask each active account without a name yet (or whose service would not say, a day ago).
      const ask = items.filter((item) => item.status === "ACTIVE" && WHO_AM_I[item.toolkit.slug]
        && (health[item.id] !== undefined || !known[item.id] || (!known[item.id].identity && Date.now() - known[item.id].checkedAt > 86_400_000)));
      await Promise.all(ask.map(async (item) => {
        const [action, args] = WHO_AM_I[item.toolkit.slug];
        const startedAt = Date.now();
        const result = await composio.tools.execute(action, { userId: USER_ID, connectedAccountId: item.id, arguments: args, dangerouslySkipVersionCheck: true } as never)
          .catch((error: unknown) => ({ successful: false, error })) as { successful?: boolean; data?: unknown; error?: unknown } | null;
        if (result?.successful || expiredConnection(result?.error)) {
          await ctx.runMutation(internal.connectorHealth.observe, { accountId: item.id, toolkit: item.toolkit.slug, startedAt, expired: !result?.successful }).catch(() => null);
          if (result?.successful) delete health[item.id];
          else health[item.id] = startedAt;
        }
        const identity = result?.successful ? identityOf(result.data) : known[item.id]?.identity;
        await ctx.runMutation(internal.connectorAccounts.remember, { accountId: item.id, toolkit: item.toolkit.slug, identity });
        known[item.id] = { identity, checkedAt: Date.now() };
      }));

      return {
        configured: true,
        accounts: items.map((item) => {
          const app = apps.find((entry) => entry.slug === item.toolkit.slug);
          return {
            id: item.id,
            toolkit: item.toolkit.slug,
            name: app?.name ?? item.toolkit.slug,
            logo: app?.logo,
            status: health[item.id] !== undefined ? "EXPIRED" : item.status,
            authExpiredAt: health[item.id],
            createdAt: item.createdAt,
            account: item.alias || known[item.id]?.identity,
          };
        }),
      };
    } catch (error) {
      return { configured: true, accounts: [], error: message(error) };
    }
  },
});

/** Remove a connection at Composio: Perry can no longer act on that account. */
export const disconnect = internalAction({
  args: { accountId: v.string() },
  handler: async (ctx, args): Promise<{ error?: string }> => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
      const composio = client(apiKey);
      const account = await composio.connectedAccounts.get(args.accountId);
      await composio.connectedAccounts.delete(args.accountId);
      await ctx.runMutation(internal.connectorHealth.forget, { accountId: args.accountId, toolkit: account.toolkit.slug });
      recheckInternetConnections();
      await ctx.runMutation(internal.connectorAccounts.forget, { accountId: args.accountId });
      return {};
    } catch (error) {
      return { error: message(error) };
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
  args: { toolkit: v.string(), callbackUrl: v.optional(v.string()), accountId: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ redirectUrl?: string; status?: string; error?: string }> => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, {
        name: "COMPOSIO_API_KEY",
      });
      if (args.accountId) {
        const startedAt = Date.now();
        const composio = client(apiKey);
        // Listing by owner prevents refreshing an unrelated account ID.
        let cursor: string | undefined;
        let owned = false;
        do {
          const page = await composio.connectedAccounts.list({ userIds: [USER_ID], toolkitSlugs: [args.toolkit], limit: 100, ...(cursor ? { cursor } : {}) });
          owned = page.items.some((item) => item.id === args.accountId && item.toolkit.slug === args.toolkit);
          cursor = page.nextCursor ?? undefined;
        } while (!owned && cursor);
        if (!owned) return { error: "That account is no longer connected to this toolkit. Refresh the list." };
        const refreshed = await composio.connectedAccounts.refresh(args.accountId, { redirectUrl: args.callbackUrl, validateCredentials: true });
        if (refreshed.id === args.accountId && refreshed.status === "ACTIVE" && !refreshed.redirect_url) {
          await ctx.runMutation(internal.connectorHealth.observe, { accountId: args.accountId, toolkit: args.toolkit, startedAt, expired: false }).catch(() => null);
          recheckInternetConnections();
          return { status: "ACTIVE" };
        }
        return { redirectUrl: refreshed.redirect_url ?? undefined, status: refreshed.status,
          ...(!refreshed.redirect_url ? { error: "Sign-in is not active yet. Refresh or try reconnecting again." } : {}) };
      }
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
    } catch {
      return { error: "Could not start or verify sign-in. Check Composio and try reconnecting this account again." };
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
    let selected: { accountId: string; toolkit: string } | undefined;
    let stage = "credentials";
    const startedAt = Date.now();
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
      const composio = client(apiKey);
      stage = "tool_metadata";
      // Resolve metadata from the SDK, never infer the toolkit from a slug prefix.
      const tool = await composio.tools.getRawComposioToolBySlug(input.slug).catch(() => null);
      // Router helper tools may not have standalone metadata. They still execute,
      // but without an exact account we do not infer or persist account health.
      const toolkit = tool?.toolkit?.slug;
      stage = "session";
      const s = await session(apiKey);
      if (toolkit) {
        stage = "account_selection";
        const state = await s.toolkits({ toolkits: [toolkit] });
        const account = state.items.find((item) => item.slug === toolkit)?.connection?.connectedAccount;
        if (account) selected = { accountId: account.id, toolkit };
        if (account && ["EXPIRED", "REVOKED"].includes(account.status)) {
          await ctx.runMutation(internal.connectorHealth.observe, { ...selected!, startedAt, expired: true }).catch(() => null);
          return { ok: false, error: reconnectMessage };
        }
      }
      // Standalone app tools use the native account-specific execution API.
      // The router's `account` option returns HTTP 400/code 4300 on projects
      // without multi-account selection. Native execution pins the account
      // without requiring that project feature. Router helpers stay on s.execute.
      stage = "execution";
      const result = selected
        ? await composio.tools.execute(input.slug, {
          userId: USER_ID,
          connectedAccountId: selected.accountId,
          arguments: (input.args ?? {}) as Record<string, unknown>,
          dangerouslySkipVersionCheck: true,
        }).then((reply) => ({ data: reply.data, error: reply.successful ? null : (reply.error ?? "execution_failed") }))
        : await s.execute(input.slug, (input.args ?? {}) as Record<string, unknown>);
      if (result.error) {
        if (selected && expiredConnection(result.error)) {
          await ctx.runMutation(internal.connectorHealth.observe, { ...selected, startedAt, expired: true }).catch(() => null);
          recheckInternetConnections();
          return { ok: false, error: reconnectMessage };
        }
        return { ok: false, error: "The connected action failed. Check the service and permissions, then try again." };
      }
      if (selected) await ctx.runMutation(internal.connectorHealth.observe, { ...selected, startedAt, expired: false }).catch(() => null);
      return { ok: true, data: result.data };
    } catch (error) {
      if (selected && expiredConnection(error)) {
        await ctx.runMutation(internal.connectorHealth.observe, { ...selected, startedAt, expired: true }).catch(() => null);
        recheckInternetConnections();
        return { ok: false, error: reconnectMessage };
      }
      // Only structural diagnostics: never log provider payloads, arguments,
      // headers, credentials, or arbitrary exception messages.
      const details = error as { name?: unknown; code?: unknown; status?: unknown } | null;
      const safeLabel = (value: unknown) => typeof value === "string" && /^[\w.-]{1,80}$/.test(value) ? value : undefined;
      const diagnostic = { stage, type: safeLabel(details?.name) ?? "Error", code: safeLabel(details?.code), status: typeof details?.status === "number" ? details.status : undefined };
      console.error("[composio] execution failed", diagnostic);
      return { ok: false, error: `The connected action could not complete (${Object.entries(diagnostic).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(", ")}).` };
    }
  },
});

const INTERNET_TOOLKITS: Partial<Record<Platform, string>> = { github: "github", youtube: "youtube", reddit: "reddit", x: "twitter", instagram: "instagram", linkedin: "linkedin" };
const READ_OPERATION = /_(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY|COUNT|CHECK|DESCRIBE|VIEW|LOOKUP)(_|$)/i;
const UNSAFE_OPERATION = /(?:SECRET|TOKEN|COOKIE|PASSWORD|CREDENTIAL|EXPORT|DOWNLOAD|EXECUTE|PROXY|INSTALL|PURCHASE|CREATE|UPDATE|DELETE|SEND|PUBLISH)(?:_|$)/i;
const accountCache = new Map<string, { at: number; accounts: ConnectedRead["accounts"]; truncated: boolean }>();
export function recheckInternetConnections() { accountCache.clear(); }

/** SDK models share this native client; internet reads own retries, deadlines and sanitized diagnostics. */
class InternetClient extends Composio {
  constructor(apiKey: string) {
    super({ apiKey, allowTracking: false, disableVersionCheck: true });
    this.client.maxRetries = 0;
    this.client.timeout = DEADLINE_MS;
    this.client.logLevel = "off";
  }
}

/** SDK errors may wrap the HTTP error; classify it without exposing provider messages or headers. */
function internetFailure(error: unknown): InternetFailure {
  if (error instanceof InternetError) return error.failure;
  let cause = error;
  let status: number | undefined;
  let retryAfter: string | null = null;
  for (let depth = 0; cause && typeof cause === "object" && depth < 4; depth++) {
    const http = z.object({ status: z.number().optional(), statusCode: z.number().optional() }).safeParse(cause);
    if (http.success) status ??= http.data.status ?? http.data.statusCode;
    if ("headers" in cause && cause.headers instanceof Headers) retryAfter ??= cause.headers.get("retry-after");
    cause = "cause" in cause ? cause.cause : undefined;
  }
  const text = error instanceof Error ? error.message : String(error);
  const code = status === 429 || /\b429\b|rate.?limit/i.test(text) ? "rate_limited" : expiredConnection(error) ? "expired_auth" : status === 403 || /\b403\b|forbidden/i.test(text) ? "forbidden" : status === 401 || /\b401\b|unauthori[sz]ed/i.test(text) ? "auth_required" : error instanceof z.ZodError ? "malformed" : "unavailable";
  const retryTime = retryAfter ? Number.isFinite(Number(retryAfter)) ? Date.now() + Math.max(0, Number(retryAfter)) * 1000 : Date.parse(retryAfter) : NaN;
  return { code, message: "The selected connected read failed; no other account or public substitute was tried.", repair: code === "expired_auth" || code === "auth_required" ? "Reconnect the affected account in Apps & skills." : code === "rate_limited" ? "Wait for the provider's rate limit to reset." : "Check the selected account's permission or the current discovered input schema.", ...(Number.isFinite(retryTime) ? { retryAt: new Date(retryTime).toISOString() } : {}) };
}

/** Read-only discovery and execution, pinned to an explicitly selected account. No connection setup or fallback. */
export async function internetRead(ctx: ToolCtx, request: InternetRequest, platform: Platform, signal: AbortSignal): Promise<ConnectedRead> {
  const toolkit = INTERNET_TOOLKITS[platform];
  const empty: ConnectedRead = { state: "setup_required", actions: [], accounts: [], repair: "Use a public supported operation, or connect the relevant account in Apps & skills." };
  if (!toolkit) return empty;
  const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
  if (!apiKey) return empty;
  let executionStartedAt: number | undefined;
  try {
    const composio = new InternetClient(apiKey);
    let cached = accountCache.get(toolkit);
    if (!cached || Date.now() - cached.at > 60_000 || request.connector) {
      const accounts: ConnectedRead["accounts"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const listed = await composio.connectedAccounts.list({ userIds: [USER_ID], toolkitSlugs: [toolkit], limit: 100, ...(cursor ? { cursor } : {}) }, { signal });
        accounts.push(...listed.items.map((item) => ({ id: item.id, status: item.status })));
        cursor = listed.nextCursor ?? undefined;
        if (!cursor) break;
      }
      cached = { at: Date.now(), accounts, truncated: Boolean(cursor) }; accountCache.set(toolkit, cached);
    }
    const checked = { accounts: cached.accounts, accountsTruncated: cached.truncated, checkedAt: new Date(cached.at).toISOString(), cacheAgeMs: Date.now() - cached.at };
    if (request.connector && !cached.accounts.some((a) => a.id === request.connector?.accountId && a.status === "ACTIVE")) {
      accountCache.delete(toolkit);
      const absent = !cached.accounts.some((a) => a.id === request.connector?.accountId);
      return { ...empty, ...checked, state: absent && cached.truncated ? "degraded" : "expired_auth", repair: absent && cached.truncated ? "The selected account was not in the first 300 accounts. Account coverage is incomplete; inspect it in Apps & skills." : "The selected account is unavailable or no longer active. Recheck that account in Apps & skills; do not switch accounts automatically." };
    }
    if (!cached.accounts.some((a) => a.status === "ACTIVE")) return { ...empty, ...checked, state: cached.truncated ? "degraded" : cached.accounts.length ? "expired_auth" : "setup_required", repair: cached.truncated ? "Account coverage is incomplete; inspect accounts in Apps & skills." : cached.accounts.length ? "Reconnect the affected account in Apps & skills." : empty.repair };
    const s = await composio.sessions.create(USER_ID, {
      toolkits: [toolkit], tags: ["readOnlyHint"], manageConnections: false,
      workbench: { enable: false },
      multiAccount: { enable: true, requireExplicitSelection: true },
      ...(request.connector ? { connectedAccounts: { [toolkit]: request.connector.accountId } } : {}),
    }, { signal });
    // The SDK's Session interface omits trailing cancellation options; its concrete public class supports them.
    if (!(s instanceof ToolRouterSession)) throw new Error("Unsupported connected session implementation.");
    const query = `Read-only ${request.operation}: ${"query" in request ? request.query : request.url}`;
    const found = await s.search({ query, toolkits: [toolkit] }, { signal });
    if (!found.success || found.error) {
      accountCache.delete(toolkit);
      return { ...empty, ...checked, state: "degraded", error: internetFailure(new Error(found.error ?? "Discovery failed")), repair: "Connected operation discovery failed. Recheck later; this is not evidence that the account has no such operation." };
    }
    if (JSON.stringify(found.toolSchemas).length > 200_000) return { ...empty, ...checked, state: "degraded", error: { code: "malformed", message: "Discovered schemas exceeded the 200 KB limit.", repair: "Narrow the requested operation." } };
    const slugs = [...new Set(found.results.flatMap((r) => r.primaryToolSlugs))].sort();
    const matchesOperation = (slug: string) => request.operation === "comments" ? /COMMENT|REPL(Y|IES)|THREAD/i.test(slug)
      : request.operation === "transcript" ? /TRANSCRIPT|CAPTION/i.test(slug)
      : request.operation === "search" ? /SEARCH|QUERY|FIND/i.test(slug) : true;
    const actions = slugs.filter((slug) => READ_OPERATION.test(slug) && !UNSAFE_OPERATION.test(slug) && matchesOperation(slug) && found.toolSchemas[slug]?.toolkit?.toLowerCase() === toolkit)
      .slice(0, 10).map((slug) => ({ slug, description: found.toolSchemas[slug]?.description?.slice(0, 400), inputSchema: found.toolSchemas[slug]?.inputSchema }));
    const discovery: ConnectedRead = { state: "available", ...checked, actions };
    if (!request.connector) return { ...discovery, repair: "Select the intended account ID, then call again with an exact discovered slug and arguments matching its schema. Existing configured-plan usage applies." };
    const selected = actions.find((a) => a.slug === request.connector?.slug);
    if (!selected) return { ...discovery, error: { code: "policy", message: "That operation is not in current read-only discovery for this request.", repair: "Use a returned read operation and the same account; writes and secret access use their existing approval boundary." } };
    const schema = z.object({ type: z.literal("object") }).loose().parse(selected.inputSchema);
    // Zod 4's native JSON Schema reader validates current provider arguments, rather than a hand-written validator.
    const input = z.fromJSONSchema(schema);
    const args = z.record(z.string(), z.unknown()).parse(input.parse(request.connector.args));
    const serialized = JSON.stringify(args);
    if (serialized.length > 12_000 || /"[^"\n]*(?:token|password|cookie|secret|credential|authorization|api[_-]?key|connected_account|account_id)[^"\n]*"\s*:/i.test(serialized)) {
      return { ...discovery, error: { code: "policy", message: "Credentials and account overrides are not accepted as adapter arguments.", repair: "Use the selected connected account and its discovered read schema." } };
    }
    for (const [key, value] of Object.entries(args)) {
      if (/^(limit|max_results|maxResults|page_size|per_page)$/i.test(key) && typeof value === "number") args[key] = Math.min(request.limit, Math.max(1, value));
    }
    input.parse(args);
    for (const value of serialized.matchAll(/https?:[^"\s]+/g)) {
      const url = publicUrl(value[0]);
      const host = new URL(url).hostname.replace(/^www\./, "");
      const allowed = platform === "x" ? ["x.com", "twitter.com"] : platform === "github" ? ["github.com", "api.github.com"] : [`${platform}.com`];
      if (!allowed.includes(host)) return { ...discovery, error: { code: "policy", message: "An adapter argument points outside the selected platform.", repair: "Use a source on the selected platform." } };
    }
    executionStartedAt = Date.now();
    const executed = await composio.tools.execute(selected.slug, {
      userId: USER_ID, connectedAccountId: request.connector.accountId,
      arguments: args, dangerouslySkipVersionCheck: true,
    }, { signal });
    if (!executed.successful) {
      accountCache.delete(toolkit);
      if (expiredConnection(executed.error)) await ctx.runMutation(internal.connectorHealth.observe, { accountId: request.connector.accountId, toolkit, startedAt: executionStartedAt, expired: true }).catch(() => null);
      return { ...discovery, error: internetFailure(executed.error ?? new Error("Connected execution failed")) };
    }
    await ctx.runMutation(internal.connectorHealth.observe, { accountId: request.connector.accountId, toolkit, startedAt: executionStartedAt, expired: false }).catch(() => null);
    if (JSON.stringify(executed.data).length > 1_000_000) return { ...discovery, error: { code: "malformed", message: "The connected response exceeded the 1 MB adapter limit.", repair: "Request fewer results." } };
    return { ...discovery, data: executed.data, backend: `connected:${toolkit}:${selected.slug}` };
  } catch (error) {
    if (signal.aborted) throw error;
    if (executionStartedAt !== undefined && request.connector && expiredConnection(error)) await ctx.runMutation(internal.connectorHealth.observe, { accountId: request.connector.accountId, toolkit, startedAt: executionStartedAt, expired: true }).catch(() => null);
    accountCache.delete(toolkit);
    return { ...empty, state: "degraded", error: internetFailure(error) };
  }
}

// --- Triggers: events that start jobs (jobs.ts, server/triggers.ts) ---------------

export type TriggerOption = { slug: string; name: string; description: string; config: Record<string, unknown>; instructions?: string };

/**
 * The events a connected app can send, to start a job on: a new email, a new
 * pull request, an event about to begin. `query` narrows them by words in the
 * name or description.
 */
export const triggerTypes = internalAction({
  args: { toolkit: v.string(), query: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ triggers: TriggerOption[]; error?: string }> => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
      const listed = await client(apiKey).triggers.listTypes({ toolkits: [args.toolkit.toLowerCase()], limit: 50 });
      const words = (args.query ?? "").toLowerCase().split(/\W+/).filter((word) => word.length > 2);
      const triggers = listed.items
        .map((item) => ({ slug: item.slug, name: item.name, description: item.description.slice(0, 300), config: item.config, ...(item.instructions ? { instructions: item.instructions.slice(0, 400) } : {}) }))
        .filter((item) => !words.length || words.some((word) => `${item.name} ${item.description}`.toLowerCase().includes(word)));
      return { triggers: triggers.slice(0, 12) };
    } catch (error) {
      return { triggers: [], error: message(error) };
    }
  },
});

/** Start a trigger on the owner's connected account; its events name the instance id returned. */
export const createTrigger = internalAction({
  args: { slug: v.string(), config: v.optional(v.any()) },
  handler: async (ctx, args): Promise<{ instanceId?: string; name?: string; toolkit?: string; error?: string }> => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
      const composio = client(apiKey);
      const type = await composio.triggers.getType(args.slug);
      const made = await composio.triggers.create(USER_ID, args.slug, { triggerConfig: (args.config ?? {}) as Record<string, unknown> });
      return { instanceId: made.triggerId, name: type.name, toolkit: type.toolkit.slug };
    } catch (error) {
      return { error: message(error) };
    }
  },
});

/** Stop a trigger no job uses any more. Failing is only logged: Composio's events for it are ignored anyway. */
export const deleteTrigger = internalAction({
  args: { instanceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const apiKey: string | null = await ctx.runQuery(internal.secrets.get, { name: "COMPOSIO_API_KEY" });
      await client(apiKey).triggers.delete(args.instanceId);
    } catch (error) {
      console.error(`could not delete the Composio trigger ${args.instanceId}: ${message(error)}`);
    }
    return null;
  },
});
