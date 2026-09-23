import { createThread, listMessages, saveMessages } from "@convex-dev/agent";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, mutation, query } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { activeGateway } from "./lib/models";
import { MODE_NAMES, TOOL_NAMES, type Mode } from "./modes";
import { vEngine, vMemoryKind, vMode } from "./schema";

/**
 * Everything the web dashboard is allowed to do.
 *
 * These are the only public functions in the deployment. Each one checks the
 * dashboard key first and does nothing before it passes, so there is exactly
 * one line to audit per entry point.
 */

/** Web sessions have their own Agent threads and share the same memory pool. */
const WEB_CHANNEL = "web" as const;

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

    const apiKey: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "AI_GATEWAY_API_KEY",
    });

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
  attachments: Array<{ url: string; fileName: string; contentType: string }>;
};

function assistantMedia(text: string): Array<{ url: string; fileName: string; contentType: string }> {
  const found = new Set<string>();
  const result: Array<{ url: string; fileName: string; contentType: string }> = [];
  const pattern = /(?:!\[[^\]]*\]|\[[^\]]*\])\((https?:\/\/[^)\s]+)\)|(?<![\w"'=])(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|m4a)(?:\?[^\s)]*)?)/gi;
  for (const match of text.matchAll(pattern)) {
    const url = match[1] ?? match[2];
    if (!url || found.has(url)) continue;
    found.add(url);
    const clean = url.split("?")[0];
    const extension = clean.split(".").pop()?.toLowerCase() ?? "";
    const contentType = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)
      ? `image/${extension === "jpg" ? "jpeg" : extension}`
      : ["mp4", "webm", "mov"].includes(extension) ? `video/${extension === "mov" ? "quicktime" : extension}`
        : `audio/${extension === "mp3" ? "mpeg" : extension}`;
    result.push({ url, fileName: clean.split("/").pop() || "shared media", contentType });
  }
  return result;
}

function webChat(conversation: Doc<"conversations"> | null) {
  if (!conversation || conversation.channel !== WEB_CHANNEL) {
    throw new Error("Chat not found.");
  }
  return conversation;
}

export const listChats = query({
  args: { key: vKey },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const chats = await ctx.db.query("conversations")
      .withIndex("by_channel_last", (q) => q.eq("channel", WEB_CHANNEL))
      .order("desc")
      .collect();
    return chats.map((chat) => ({
      id: chat._id,
      title: chat.title ?? "Untitled chat",
      mode: chat.mode,
      lastMessageAt: chat.lastMessageAt,
      parentConversationId: chat.parentConversationId,
      branchedFromMessageId: chat.branchedFromMessageId,
    }));
  },
});

export const createChat = mutation({
  args: { key: vKey },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const threadId = await createThread(ctx, components.agent, { userId: "web:dashboard", title: "New chat" });
    return await ctx.db.insert("conversations", {
      channel: WEB_CHANNEL,
      externalId: `session:${threadId}`,
      threadId,
      mode: "perry",
      title: "New chat",
      lastMessageAt: Date.now(),
    });
  },
});

export const renameChat = mutation({
  args: { key: vKey, id: v.id("conversations"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.id));
    const title = args.title.trim().slice(0, 100);
    if (!title) throw new Error("Enter a chat name.");
    await ctx.db.patch(args.id, { title });
    return null;
  },
});

export const deleteChat = mutation({
  args: { key: vKey, id: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const chat = webChat(await ctx.db.get(args.id));
    if ((chat.pendingTurns ?? 0) > 0) {
      throw new Error("Wait for this chat to finish before deleting it.");
    }
    const runs = await ctx.db.query("runs")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    if (runs.some((run) => run.status === "running")) {
      throw new Error("Wait for this chat to finish before deleting it.");
    }
    for (const run of runs) await ctx.db.delete(run._id);
    const attachments = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    for (const attachment of attachments) {
      await ctx.storage.delete(attachment.storageId);
      await ctx.db.delete(attachment._id);
    }
    await ctx.db.delete(args.id);
    await ctx.runMutation(components.agent.threads.deleteAllForThreadIdAsync, {
      threadId: chat.threadId,
    });
    return null;
  },
});

export const branchChat = action({
  args: { key: vKey, id: v.id("conversations"), messageId: v.string() },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    assertDashboardKey(args.key);
    const source = await ctx.runQuery(internal.conversations.getWebById, { id: args.id });
    if (!source) throw new Error("Source chat was deleted.");
    const newest: Array<{ _id: string; message?: { role: string }; text?: string }> = [];
    let cursor: string | null = null;
    let found = false;
    while (true) {
      const page = await listMessages(ctx, components.agent, {
        threadId: source.threadId,
        excludeToolMessages: true,
        paginationOpts: { cursor, numItems: 100 },
      });
      for (const message of page.page) {
        if (message._id === args.messageId) {
          found = true;
        }
        if (found) newest.push(message);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (!found) throw new Error("That message is no longer available to branch.");

    const title = `${source.title ?? "Chat"} · branch`.slice(0, 100);
    const threadId = await createThread(ctx, components.agent, { userId: "web:dashboard", title });
    const history = newest.reverse()
      .filter((message) =>
        (message.message?.role === "user" || message.message?.role === "assistant") &&
        typeof message.text === "string" && message.text.trim().length > 0,
      );
    try {
      for (let start = 0; start < history.length; start += 100) {
        await saveMessages(ctx, components.agent, {
          threadId,
          userId: "web:dashboard",
          order: "next",
          messages: history.slice(start, start + 100).map((message) => ({
            role: message.message!.role as "user" | "assistant",
            content: message.text!,
          })),
        });
      }
      const branchId = await ctx.runMutation(internal.conversations.createBranch, {
        parentId: source._id,
        threadId,
        title,
        messageId: args.messageId,
      });
      const keys = new Set(newest.flatMap((message) => {
        const raw = typeof message.text === "string" ? message.text : "";
        const match = raw.match(/\n?<!-- attachments:([^>]+) -->\s*$/);
        return match?.[1] ? [match[1].trim()] : [];
      }));
      await ctx.runMutation(internal.conversations.copyAttachments, {
        sourceId: source._id,
        targetId: branchId,
        messageKeys: [...keys],
      });
      return branchId;
    } catch (error) {
      await ctx.runMutation(components.agent.threads.deleteAllForThreadIdAsync, { threadId });
      throw error;
    }
  },
});

export const searchChats = action({
  args: { key: vKey, search: v.string() },
  handler: async (ctx, args): Promise<Array<{ id: Id<"conversations">; title: string; snippet: string; lastMessageAt: number }>> => {
    assertDashboardKey(args.key);
    const needle = args.search.trim().toLocaleLowerCase();
    if (!needle) return [];
    const [chats, messages] = await Promise.all([
      ctx.runQuery(internal.conversations.listWeb, {}),
      ctx.runAction(components.agent.messages.searchMessages, {
        searchAllMessagesForUserId: "web:dashboard",
        text: args.search.trim(),
        textSearch: true,
        vectorSearch: false,
        limit: 100,
      }),
    ]);
    const snippets = new Map(messages.map((message) => [message.threadId, message.text ?? ""]));
    return chats.filter((chat) =>
      (chat.title ?? "").toLocaleLowerCase().includes(needle) || snippets.has(chat.threadId),
    ).slice(0, 30).map((chat) => ({
      id: chat._id,
      title: chat.title ?? "Untitled chat",
      snippet: snippets.get(chat.threadId)?.slice(0, 160) ?? "",
      lastMessageAt: chat.lastMessageAt,
    }));
  },
});

export const getChat = query({
  args: { key: vKey, id: v.id("conversations") },
  handler: async (
    ctx,
    args,
  ): Promise<{ mode: string; engine?: "codex" | "gateway"; model?: string; title: string; isRunning: boolean; lastError?: string }> => {
    assertDashboardKey(args.key);
    const conversation = webChat(await ctx.db.get(args.id));
    const isRunning = (conversation.pendingTurns ?? 0) > 0;
    const latestRun = await ctx.db.query("runs")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .order("desc")
      .first();
    return {
      mode: conversation.mode,
      engine: conversation.engine,
      model: conversation.model,
      title: conversation.title ?? "Untitled chat",
      isRunning,
      lastError: latestRun?.status === "error" ? latestRun.error : undefined,
    };
  },
});

export const getChatMessages = query({
  args: { key: vKey, id: v.id("conversations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const conversation = webChat(await ctx.db.get(args.id));
    const page = await listMessages(ctx, components.agent, {
      threadId: conversation.threadId,
      excludeToolMessages: true,
      paginationOpts: args.paginationOpts,
    });
    const attachments = await ctx.db.query("chatAttachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.id))
      .collect();
    const attachmentMap = new Map<string, Array<{ url: string; fileName: string; contentType: string }>>();
    for (const attachment of attachments) {
      const url = await ctx.storage.getUrl(attachment.storageId);
      if (!url) continue;
      const list = attachmentMap.get(attachment.messageKey) ?? [];
      list.push({ url, fileName: attachment.fileName, contentType: attachment.contentType });
      attachmentMap.set(attachment.messageKey, list);
    }
    return {
      ...page,
      page: page.page.map((doc): ChatMessage => {
        const raw = typeof doc.text === "string" ? doc.text : "";
        const marker = raw.match(/\n?<!-- attachments:([^>]+) -->\s*$/);
        const messageKey = marker?.[1]?.trim();
        return {
          id: doc._id,
          role: doc.message?.role ?? "assistant",
          text: (marker ? raw.slice(0, marker.index).trimEnd() : raw),
          createdAt: doc._creationTime,
          attachments: messageKey ? attachmentMap.get(messageKey) ?? [] : (doc.message?.role === "assistant" ? assistantMedia(raw) : []),
        };
      }).filter((message) => message.text.trim().length > 0 || message.attachments.length > 0),
    };
  },
});

export const generateUploadUrl = mutation({
  args: { key: vKey },
  returns: v.string(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await ctx.storage.generateUploadUrl();
  },
});

export const registerAttachment = mutation({
  args: {
    key: vKey,
    conversationId: v.id("conversations"),
    messageKey: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
  },
  returns: v.id("chatAttachments"),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.conversationId));
    if (!args.fileName.trim() || args.size <= 0 || args.size > 50 * 1024 * 1024) {
      throw new Error("Attachments must be between 1 byte and 50 MB.");
    }
    const stored = await ctx.storage.getMetadata(args.storageId);
    if (!stored) throw new Error("Upload could not be found.");
    return await ctx.db.insert("chatAttachments", {
      conversationId: args.conversationId,
      messageKey: args.messageKey,
      storageId: args.storageId,
      fileName: args.fileName.trim().slice(0, 200),
      contentType: args.contentType || stored.contentType || "application/octet-stream",
      size: args.size,
      createdAt: Date.now(),
    });
  },
});

export const sendChat = mutation({
  args: {
    key: vKey,
    id: v.id("conversations"),
    text: v.string(),
    attachmentIds: v.optional(v.array(v.id("chatAttachments"))),
    messageKey: v.optional(v.string()),
    engine: v.optional(vEngine),
    model: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);

    const text = args.text.trim();
    const attachmentIds = args.attachmentIds ?? [];
    if (text.length === 0 && attachmentIds.length === 0) return null;
    const chat = webChat(await ctx.db.get(args.id));
    const messageKey = args.messageKey?.trim() || crypto.randomUUID();
    const attachments = await Promise.all(attachmentIds.map((id) => ctx.db.get(id)));
    if (attachments.some((attachment) => !attachment || attachment.conversationId !== args.id || attachment.messageKey !== messageKey)) {
      throw new Error("One of the attachments is no longer available.");
    }
    const prompt = attachmentIds.length > 0
      ? `${text}\n\n<!-- attachments: ${messageKey} -->`.trim()
      : text;
    await ctx.db.patch(args.id, {
      lastMessageAt: Date.now(),
      title: chat.title === "New chat" ? (text || "Attached files").slice(0, 80) : chat.title,
      pendingTurns: (chat.pendingTurns ?? 0) + 1,
      ...(args.engine ? { engine: args.engine, model: args.model?.trim() || undefined } : {}),
    });

    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: WEB_CHANNEL,
      externalId: chat.externalId,
      text: prompt,
      title: chat.title,
      attachmentIds,
    });
    return null;
  },
});

export const setChatModel = mutation({
  args: { key: vKey, id: v.id("conversations"), engine: vEngine, model: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    webChat(await ctx.db.get(args.id));
    await ctx.db.patch(args.id, { engine: args.engine, model: args.model?.trim() || undefined });
    return null;
  },
});

export const setChatMode = mutation({
  args: { key: vKey, id: v.id("conversations"), mode: vMode },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);

    const conversation = webChat(await ctx.db.get(args.id));

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
  source: string;
  kind: "profile" | "core" | "daily";
  day?: string;
  createdAt: number;
};

export const listMemories = query({
  args: { key: vKey, query: v.optional(v.string()), kind: v.optional(vMemoryKind) },
  handler: async (ctx, args): Promise<MemoryView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.memories.search, {
      query: args.query ?? "",
      limit: 25,
      kind: args.kind,
    });
  },
});

export const addMemory = mutation({
  args: { key: vKey, text: v.string(), tags: v.optional(v.array(v.string())), kind: v.optional(vMemoryKind) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    const text = args.text.trim();
    if (text.length === 0) return null;

    await ctx.runMutation(internal.memories.add, {
      text,
      tags: args.tags ?? [],
      source: "dashboard",
      kind: args.kind,
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
  sessionId: Id<"conversations">;
  threadId?: string;
  chatTitle: string;
  channel: string;
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
  args: { key: vKey, conversationId: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<RunView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.runs.recent, { limit: 100, conversationId: args.conversationId });
  },
});

export const listActivitySessions = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<Array<{
    id: Id<"conversations">;
    title: string;
    channel: "telegram" | "web";
  }>> => {
    assertDashboardKey(args.key);
    const conversations: Doc<"conversations">[] = await ctx.runQuery(internal.conversations.list, {});
    return conversations.map((chat) => ({
      id: chat._id,
      title: chat.title ?? (chat.channel === "web" ? "Untitled chat" : "Telegram chat"),
      channel: chat.channel,
    }));
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
    engine: "codex" | "gateway";
    telegramConfigured: boolean;
    modeNames: string[];
  }> => {
    assertDashboardKey(args.key);

    const memories: number = await ctx.runQuery(internal.memories.count, {});
    const conversations = await ctx.runQuery(internal.conversations.list, {});
    const install = await ctx.runQuery(internal.installation.status, {});
    const gatewayKey: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "AI_GATEWAY_API_KEY",
    });
    const telegramToken: string | null = await ctx.runQuery(
      internal.secrets.get,
      { name: "TELEGRAM_BOT_TOKEN" },
    );

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
      gateway: activeGateway(gatewayKey),
      engine: await ctx.runQuery(internal.codex.activeEngine, {}),
      telegramConfigured: Boolean(telegramToken),
      modeNames: [...MODE_NAMES],
    };
  },
});

/** Mint a fresh pairing code, for a first claim or to move Assistant to a new chat. */
export const startPairing = mutation({
  args: { key: vKey },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    assertDashboardKey(args.key);
    return await ctx.runMutation(internal.installation.startPairing, {});
  },
});

/** Release ownership. The next correct pairing code claims Assistant again. */
export const unclaim = mutation({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.unclaim, {});
    return null;
  },
});

// --- Work ----------------------------------------------------------------

export type WorkView = {
  tasks: Doc<"tasks">[];
  goals: Doc<"goals">[];
  monitors: Doc<"monitors">[];
};

export const getWork = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<WorkView> => {
    assertDashboardKey(args.key);

    const tasks: Doc<"tasks">[] = await ctx.runQuery(internal.work.listTasks, {
      limit: 25,
    });
    const goals: Doc<"goals">[] = await ctx.runQuery(internal.work.listGoals, {});
    const monitors: Doc<"monitors">[] = await ctx.runQuery(
      internal.work.listMonitors,
      {},
    );

    return { tasks, goals, monitors };
  },
});

export const toggleMonitor = mutation({
  args: { key: vKey, monitorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.work.toggleMonitor, {
      monitorId: args.monitorId,
    });
    return null;
  },
});

export const deleteMonitor = mutation({
  args: { key: vKey, monitorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.work.deleteMonitor, {
      monitorId: args.monitorId,
    });
    return null;
  },
});

export const cancelTask = mutation({
  args: { key: vKey, taskId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.work.updateTask, {
      taskId: args.taskId,
      status: "cancelled",
    });
    return null;
  },
});

/** Run every due monitor now, instead of waiting for the next tick. */
export const checkMonitorsNow = action({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runAction(internal.web.checkMonitors, {});
    return null;
  },
});

// --- Compute -------------------------------------------------------------

export type ComputeView = {
  target: "sandbox" | "local";
  sandboxConfigured: boolean;
  runners: Array<{
    id: string;
    name: string;
    platform?: string;
    workdir?: string;
    autoApprove: boolean;
    online: boolean;
    lastSeenAt?: number;
    revoked: boolean;
  }>;
  commands: Array<{
    id: string;
    kind: string;
    command?: string;
    path?: string;
    status: string;
    exitCode?: number;
    error?: string;
    createdAt: number;
  }>;
};

export const getCompute = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<ComputeView> => {
    assertDashboardKey(args.key);

    const install = await ctx.runQuery(internal.installation.get, {});
    const runners: Doc<"runners">[] = await ctx.runQuery(
      internal.runner.listRunners,
      {},
    );
    const commands: Doc<"commands">[] = await ctx.runQuery(
      internal.runner.recentCommands,
      { limit: 20 },
    );
    const daytonaKey: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "DAYTONA_API_KEY",
    });

    const cutoff = Date.now() - 90_000;

    return {
      target: install?.computeTarget ?? "sandbox",
      sandboxConfigured: Boolean(daytonaKey),
      runners: runners.map((r) => ({
        id: r._id,
        name: r.name,
        platform: r.platform,
        workdir: r.workdir,
        autoApprove: r.autoApprove,
        online: !r.revoked && (r.lastSeenAt ?? 0) > cutoff,
        lastSeenAt: r.lastSeenAt,
        revoked: r.revoked,
      })),
      commands: commands.map((c) => ({
        id: c._id,
        kind: c.kind,
        command: c.command,
        path: c.path,
        status: c.status,
        exitCode: c.exitCode,
        error: c.error,
        createdAt: c.createdAt,
      })),
    };
  },
});

export const setComputeTarget = mutation({
  args: {
    key: vKey,
    target: v.union(v.literal("sandbox"), v.literal("local")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.setComputeTarget, {
      target: args.target,
    });
    return null;
  },
});

/** Cut a machine loose. The runner's next call fails and it stops getting work. */
export const revokeRunner = mutation({
  args: { key: vKey, runnerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.runner.revokeRunner, {
      runnerId: args.runnerId,
    });
    return null;
  },
});

// --- Connected accounts --------------------------------------------------

export const getConnectors = action({
  args: { key: vKey },
  handler: async (
    ctx,
    args,
  ): Promise<{
    configured: boolean;
    connectors: Array<{
      slug: string;
      name: string;
      connected: boolean;
      status?: string;
      needsAuth: boolean;
    }>;
    error?: string;
  }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.connectors, {});
  },
});

/** Returns a URL for the owner to open and finish OAuth in their browser. */
export const connectToolkit = action({
  args: { key: vKey, toolkit: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ redirectUrl?: string; status?: string; error?: string }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.authorize, {
      toolkit: args.toolkit,
    });
  },
});

/** Lets the owner see exactly which operations a connection exposes. */
export const searchActions = action({
  args: { key: vKey, query: v.string(), toolkits: v.optional(v.array(v.string())) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    actions: Array<{
      slug: string;
      description?: string;
      toolkit?: string;
      inputSchema?: unknown;
    }>;
    error?: string;
  }> => {
    assertDashboardKey(args.key);
    return await ctx.runAction(internal.composio.search, {
      query: args.query,
      toolkits: args.toolkits,
    });
  },
});

// --- Keys ----------------------------------------------------------------

export type SecretView = {
  name: string;
  label: string;
  hint: string;
  set: boolean;
  source: "dashboard" | "environment" | "none";
  preview?: string;
  updatedAt?: number;
};

/**
 * Never returns a key, only whether one exists, where it came from, and its
 * last four characters. Enough to tell two keys apart, not enough to use one.
 */
export const getKeys = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<SecretView[]> => {
    assertDashboardKey(args.key);
    return await ctx.runQuery(internal.secrets.status, {});
  },
});

export const setKey = mutation({
  args: { key: vKey, name: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.secrets.set, {
      name: args.name,
      value: args.value,
    });
    return null;
  },
});

export const clearKey = mutation({
  args: { key: vKey, name: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.secrets.clear, { name: args.name });
    return null;
  },
});

/**
 * Re-point Telegram at this deployment after the bot token or webhook secret
 * changes, so a key edit does not silently leave the bot talking to nothing.
 */
export const registerWebhook = action({
  args: { key: vKey },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; url?: string; bot?: string; error?: string }> => {
    assertDashboardKey(args.key);

    const token: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "TELEGRAM_BOT_TOKEN",
    });
    const secret: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "TELEGRAM_WEBHOOK_SECRET",
    });
    if (!token) return { ok: false, error: "No bot token set." };
    if (!secret) return { ok: false, error: "No webhook secret set." };

    const site = process.env.CONVEX_SITE_URL;
    if (!site) {
      return { ok: false, error: "Could not work out this deployment URL." };
    }

    try {
      const url = `${site}/telegram`;
      const res = await fetch(
        `https://api.telegram.org/bot${token}/setWebhook`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url,
            secret_token: secret,
            allowed_updates: ["message", "edited_message"],
            drop_pending_updates: true,
          }),
        },
      );
      const body = (await res.json()) as { ok?: boolean; description?: string };
      if (!body.ok) {
        return { ok: false, error: body.description ?? "Telegram refused it." };
      }

      const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(
        (r) => r.json() as Promise<{ result?: { username?: string } }>,
        () => ({}) as { result?: { username?: string } },
      );

      return { ok: true, url, bot: me.result?.username };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
