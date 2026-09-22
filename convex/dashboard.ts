import { listMessages } from "@convex-dev/agent";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { activeGateway } from "./lib/models";
import { MODE_NAMES, TOOL_NAMES, type Mode } from "./modes";
import { vMode } from "./schema";

/**
 * Everything the web dashboard is allowed to do.
 *
 * These are the only public functions in the deployment. Each one checks the
 * dashboard key first and does nothing before it passes, so there is exactly
 * one line to audit per entry point.
 */

/** The web chat is a single conversation, distinct from any Telegram chat. */
const WEB_CHANNEL = "web" as const;
const WEB_ID = "dashboard";

const vKey = v.string();

// --- Configuration -------------------------------------------------------

export type ModeView = Mode & { overridden: string[] };

export const getConfig = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<{ modes: ModeView[]; tools: string[] }> => {
    assertDashboardKey(args.key);

    const modes: Mode[] = await ctx.runQuery(internal.config.resolveAllModes, {});
    const overrides: Record<string, string[]> = await ctx.runQuery(
      internal.config.overriddenFields,
      {},
    );

    return {
      modes: modes.map((mode) => ({
        ...mode,
        overridden: overrides[mode.name] ?? [],
      })),
      tools: [...TOOL_NAMES],
    };
  },
});

/**
 * Update one mode. Omit a field to leave it, pass null to clear it back to the
 * value shipped in modes.ts.
 */
export const updateMode = mutation({
  args: {
    key: vKey,
    mode: vMode,
    model: v.optional(v.union(v.string(), v.null())),
    stepBudget: v.optional(v.union(v.number(), v.null())),
    tools: v.optional(v.union(v.array(v.string()), v.null())),
    instructions: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const { key: _key, ...rest } = args;
    await ctx.runMutation(internal.config.updateMode, rest);
    return null;
  },
});

export const resetMode = mutation({
  args: { key: vKey, mode: vMode },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.config.resetMode, { mode: args.mode });
    return null;
  },
});

/**
 * Ask the gateway which models exist, so picking one is a list rather than a
 * guess at a slug. Falls back to the modes already configured if the gateway
 * will not answer, because a broken dropdown should not block the page.
 */
export const listModels = action({
  args: { key: vKey },
  handler: async (
    ctx,
    args,
  ): Promise<{ models: string[]; error?: string }> => {
    assertDashboardKey(args.key);

    const apiKey = process.env.AI_GATEWAY_API_KEY;

    // On the Convex gateway there is no model index to query, so offer a short
    // hand-kept list. The field is free text either way, so a wrong guess here
    // costs nothing.
    if (!apiKey) {
      return {
        models: [
          "anthropic/claude-haiku-4.5",
          "anthropic/claude-sonnet-5",
          "anthropic/claude-opus-5",
          "openai/gpt-5-mini",
          "openai/gpt-5",
          "google/gemini-2.5-flash",
          "google/gemini-2.5-pro",
        ],
      };
    }

    try {
      const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        return { models: [], error: `Gateway returned ${res.status}.` };
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string")
        .sort();
      return { models };
    } catch (error) {
      return {
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

// --- Web chat ------------------------------------------------------------

export type ChatMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: number;
};

export const getChat = query({
  args: { key: vKey },
  handler: async (
    ctx,
    args,
  ): Promise<{ mode: string | null; messages: ChatMessage[] }> => {
    assertDashboardKey(args.key);

    const conversation = await ctx.runQuery(
      internal.conversations.getByExternalId,
      { channel: WEB_CHANNEL, externalId: WEB_ID },
    );
    if (!conversation) return { mode: null, messages: [] };

    const page = await listMessages(ctx, components.agent, {
      threadId: conversation.threadId,
      excludeToolMessages: true,
      paginationOpts: { cursor: null, numItems: 100 },
    });

    const messages: ChatMessage[] = page.page
      .map((doc) => ({
        id: doc._id,
        role: doc.message?.role ?? "assistant",
        text: typeof doc.text === "string" ? doc.text : "",
        createdAt: doc._creationTime,
      }))
      .filter((m) => m.text.trim().length > 0)
      .sort((a, b) => a.createdAt - b.createdAt);

    return { mode: conversation.mode, messages };
  },
});

export const sendChat = mutation({
  args: { key: vKey, text: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);

    const text = args.text.trim();
    if (text.length === 0) return null;

    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: WEB_CHANNEL,
      externalId: WEB_ID,
      text,
      title: "Dashboard",
    });
    return null;
  },
});

export const setChatMode = mutation({
  args: { key: vKey, mode: vMode },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);

    const conversation = await ctx.runQuery(
      internal.conversations.getByExternalId,
      { channel: WEB_CHANNEL, externalId: WEB_ID },
    );
    if (!conversation) return null;

    await ctx.runMutation(internal.conversations.setMode, {
      id: conversation._id,
      mode: args.mode,
    });
    return null;
  },
});

// --- Memories ------------------------------------------------------------

export type MemoryView = {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
};

export const listMemories = query({
  args: { key: vKey, query: v.optional(v.string()) },
  handler: async (ctx, args): Promise<MemoryView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.memories.search, {
      query: args.query ?? "",
      limit: 25,
    });
  },
});

export const addMemory = mutation({
  args: { key: vKey, text: v.string(), tags: v.optional(v.array(v.string())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const text = args.text.trim();
    if (text.length === 0) return null;

    await ctx.runMutation(internal.memories.add, {
      text,
      tags: args.tags ?? [],
      source: "dashboard",
    });
    return null;
  },
});

export const deleteMemory = mutation({
  args: { key: vKey, id: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.memories.removeMany, { ids: [args.id] });
    return null;
  },
});

// --- Activity ------------------------------------------------------------

export type RunView = {
  id: string;
  mode: string;
  prompt: string;
  status: string;
  steps?: number;
  toolCalls?: string[];
  model?: string;
  totalTokens?: number;
  error?: string;
  startedAt: number;
  durationMs?: number;
};

export const listRuns = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<RunView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.runs.recent, { limit: 30 });
  },
});

export const getStatus = query({
  args: { key: vKey },
  handler: async (
    ctx,
    args,
  ): Promise<{
    memories: number;
    conversations: Array<{ channel: string; mode: string; lastMessageAt: number }>;
    claimed: boolean;
    ownerName?: string;
    pairingCode?: string;
    pairingExpiresAt?: number;
    gateway: "vercel" | "convex";
    telegramConfigured: boolean;
    modeNames: string[];
  }> => {
    assertDashboardKey(args.key);

    const memories: number = await ctx.runQuery(internal.memories.count, {});
    const conversations = await ctx.runQuery(internal.conversations.list, {});
    const install = await ctx.runQuery(internal.installation.status, {});

    return {
      memories,
      conversations: conversations.map((c) => ({
        channel: c.channel,
        mode: c.mode,
        lastMessageAt: c.lastMessageAt,
      })),
      claimed: install.claimed,
      ownerName: install.ownerName,
      pairingCode: install.pairingCode,
      pairingExpiresAt: install.pairingExpiresAt,
      gateway: activeGateway(),
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      modeNames: [...MODE_NAMES],
    };
  },
});

/** Mint a fresh pairing code, for a first claim or to move Perry to a new chat. */
export const startPairing = mutation({
  args: { key: vKey },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.installation.startPairing, {});
  },
});

/** Release ownership. The next correct pairing code claims Perry again. */
export const unclaim = mutation({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.unclaim, {});
    return null;
  },
});
