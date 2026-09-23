import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { saveMessages } from "@convex-dev/agent";
import { sendMessage, sendPhoto } from "./lib/telegram";
import { vEngine, vMode } from "./schema";
import { assertDashboardKey } from "./lib/auth";
import { authenticate } from "./runner";
import { ABSOLUTE_PATH } from "./media";
import type { Id } from "./_generated/dataModel";
import type { Mode } from "./modes";

export const engine = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    return install?.chatEngine ?? "codex";
  },
});

export const setEngine = mutation({
  args: { key: v.string(), engine: vEngine },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Installation is missing.");
    await ctx.db.patch(install._id, { chatEngine: args.engine });
    return null;
  },
});

export const activeEngine = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("installation").first())?.chatEngine ?? "codex",
});

/** Only device codes and account metadata cross Convex. Codex tokens never do. */
export const accounts = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const runners = await ctx.db.query("runners").order("desc").take(20);
    const cutoff = Date.now() - 90_000;
    return runners.filter((runner) => !runner.revoked).map((runner) => ({
      id: runner._id,
      name: runner.name,
      online: (runner.lastSeenAt ?? 0) > cutoff,
      available: runner.codexAvailable ?? false,
      authMode: runner.codexAuthMode,
      planType: runner.codexPlanType,
      error: runner.codexError,
      updatedAt: runner.codexUpdatedAt,
      requestKind: runner.codexRequestKind,
      requestStatus: runner.codexRequestStatus,
      verificationUrl: runner.codexVerificationUrl,
      userCode: runner.codexUserCode,
      requestError: runner.codexRequestError,
    }));
  },
});

export const requestAuth = mutation({
  args: {
    key: v.string(),
    runnerId: v.id("runners"),
    kind: v.union(v.literal("login"), v.literal("logout")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const runner = await ctx.db.get(args.runnerId);
    if (!runner || runner.revoked || (runner.lastSeenAt ?? 0) < Date.now() - 90_000) {
      throw new Error("Start this runner before connecting Codex.");
    }
    if (!runner.codexAvailable) throw new Error(runner.codexError || "Codex CLI is unavailable on this machine.");
    if (runner.codexRequestStatus === "queued" || runner.codexRequestStatus === "running") {
      throw new Error("A Codex account request is already in progress.");
    }
    await ctx.db.patch(args.runnerId, {
      codexRequestId: (runner.codexRequestId ?? 0) + 1,
      codexRequestKind: args.kind,
      codexRequestStatus: "queued",
      codexVerificationUrl: undefined,
      codexUserCode: undefined,
      codexRequestError: undefined,
    });
    return null;
  },
});

export const queuedAuth = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    if (runner.codexRequestStatus !== "queued" || !runner.codexRequestKind) return null;
    return { id: runner.codexRequestId!, kind: runner.codexRequestKind };
  },
});

export const recoverAuth = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    if (runner.codexRequestStatus === "running") {
      await ctx.db.patch(runner._id, {
        codexRequestStatus: "error",
        codexVerificationUrl: undefined,
        codexUserCode: undefined,
        codexRequestError: "Runner restarted. Start sign-in again.",
      });
    }
    return null;
  },
});

export const claimAuth = mutation({
  args: { token: v.string(), id: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    if (runner.codexRequestStatus !== "queued" || runner.codexRequestId !== args.id) return false;
    await ctx.db.patch(runner._id, { codexRequestStatus: "running" });
    return true;
  },
});

export const updateAuth = mutation({
  args: {
    token: v.string(),
    id: v.number(),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
    verificationUrl: v.optional(v.string()),
    userCode: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    if (runner.codexRequestId !== args.id || runner.codexRequestStatus !== "running") return null;
    await ctx.db.patch(runner._id, {
      codexRequestStatus: args.status,
      codexVerificationUrl: args.status === "running" ? args.verificationUrl : undefined,
      codexUserCode: args.status === "running" ? args.userCode : undefined,
      codexRequestError: args.error?.slice(0, 500),
    });
    return null;
  },
});

export const reportAccount = mutation({
  args: {
    token: v.string(),
    available: v.boolean(),
    authMode: v.optional(v.string()),
    planType: v.optional(v.string()),
    error: v.optional(v.string()),
    models: v.optional(v.array(v.object({ id: v.string(), name: v.string(), isDefault: v.boolean() }))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    await ctx.db.patch(runner._id, {
      codexAvailable: args.available,
      codexAuthMode: args.authMode,
      codexPlanType: args.planType,
      codexError: args.error?.slice(0, 500),
      codexModels: args.models ?? runner.codexModels,
      codexUpdatedAt: Date.now(),
    });
    return null;
  },
});

export const enqueueTurn = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    runId: v.id("runs"),
    mode: vMode,
    prompt: v.string(),
    history: v.optional(v.string()),
    instructions: v.string(),
    model: v.optional(v.string()),
    attachments: v.optional(v.array(v.object({
      url: v.optional(v.string()),
      localPath: v.optional(v.string()),
      fileName: v.string(),
      contentType: v.string(),
    }))),
  },
  returns: v.id("codexTurns"),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("This chat was deleted.");
    const runners = conversation.codexRunnerId
      ? [await ctx.db.get(conversation.codexRunnerId)]
      : await ctx.db.query("runners").order("desc").take(20);
    const runner = runners.filter((item) => item && !item.revoked && item.codexAvailable && item.codexAuthMode === "chatgpt" && (item.lastSeenAt ?? 0) > Date.now() - 90_000)
      .sort((a, b) => (b!.lastSeenAt ?? 0) - (a!.lastSeenAt ?? 0))[0];
    if (!runner) throw new Error(conversation.codexRunnerId
      ? "The Codex runner for this chat is offline. Start it to continue."
      : "Connect a ChatGPT account in Settings and start its runner to chat with Codex.");
    if (!conversation.codexRunnerId) await ctx.db.patch(conversation._id, { codexRunnerId: runner._id });
    return await ctx.db.insert("codexTurns", {
      runnerId: runner._id,
      conversationId: args.conversationId,
      runId: args.runId,
      mode: args.mode,
      prompt: args.prompt,
      history: args.history,
      instructions: args.instructions,
      requestedModel: args.model,
      attachments: args.attachments,
      status: "queued",
      createdAt: Date.now(),
    });
  },
});

export const queuedTurns = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    return await ctx.db.query("codexTurns")
      .withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", "queued"))
      .order("asc").take(20);
  },
});

export const runningTurns = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    return await ctx.db.query("codexTurns")
      .withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", "running"))
      .take(20);
  },
});

export const claimTurn = mutation({
  args: { token: v.string(), id: v.id("codexTurns") },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "queued" || runner.codexAuthMode !== "chatgpt") return null;
    const conversation = await ctx.db.get(job.conversationId);
    if (!conversation) return null;
    const running = await ctx.db.query("codexTurns")
      .withIndex("by_conversation_status", (q) => q.eq("conversationId", job.conversationId).eq("status", "running"))
      .first();
    if (running) return null;
    await ctx.db.patch(job._id, { status: "running", startedAt: Date.now() });
    const site = process.env.CONVEX_SITE_URL;
    return { ...job, codexThreadId: conversation.codexThreadId, channel: conversation.channel, mcpUrl: site ? `${site}/mcp` : undefined };
  },
});

export const setThread = mutation({
  args: { token: v.string(), id: v.id("codexTurns"), threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "running") return null;
    const conversation = await ctx.db.get(job.conversationId);
    if (!conversation) return null;
    if (conversation.codexThreadId && conversation.codexThreadId !== args.threadId) throw new Error("Chat already has another Codex thread.");
    await ctx.db.patch(conversation._id, { codexThreadId: args.threadId });
    return null;
  },
});

/** Where a runner uploads media a Codex turn produced, while that turn runs. */
export const mediaUploadUrl = mutation({
  args: { token: v.string(), id: v.id("codexTurns") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "running") throw new Error("This Codex turn is not running.");
    return await ctx.storage.generateUploadUrl();
  },
});

/** Repair media from a completed turn produced by an older runner build. */
export const recoverMediaUploadUrl = mutation({
  args: { token: v.string(), id: v.id("codexTurns") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "done") {
      throw new Error("Only completed Codex turns can be repaired.");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const recoverMedia = mutation({
  args: {
    token: v.string(),
    id: v.id("codexTurns"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "done") {
      throw new Error("Only completed Codex turns can be repaired.");
    }
    const stored = await ctx.storage.getMetadata(args.storageId);
    if (!stored) throw new Error("Uploaded media was not found.");
    const mediaKey = `codex-${job._id}`;
    const existing = await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", job.conversationId).eq("messageKey", mediaKey))
      .collect();
    if (!existing.some((item) => item.storageId === args.storageId)) {
      await ctx.db.insert("chatAttachments", {
        conversationId: job.conversationId,
        messageKey: mediaKey,
        storageId: args.storageId,
        fileName: args.fileName.slice(0, 200),
        contentType: args.contentType || stored.contentType || "image/png",
        size: stored.size,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(job._id, { mediaKey });
    return null;
  },
});

export const finishTurn = mutation({
  args: {
    token: v.string(), id: v.id("codexTurns"),
    response: v.optional(v.string()), error: v.optional(v.string()), model: v.optional(v.string()),
    media: v.optional(v.array(v.object({
      /** Uploaded to Convex storage, or left where it is on the runner's machine. */
      storageId: v.optional(v.id("_storage")),
      localPath: v.optional(v.string()),
      size: v.optional(v.number()),
      fileName: v.string(),
      contentType: v.string(),
    }))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "running") return null;
    // share_file may already have attached files to this turn.
    let mediaKey = job.mediaKey;
    for (const item of args.media ?? []) {
      const stored = item.storageId ? await ctx.storage.getMetadata(item.storageId) : null;
      const local = item.localPath && ABSOLUTE_PATH.test(item.localPath) ? item.localPath : undefined;
      if (!stored && !local) continue;
      mediaKey = `codex-${job._id}`;
      await ctx.db.insert("chatAttachments", {
        conversationId: job.conversationId,
        messageKey: mediaKey,
        ...(stored ? { storageId: item.storageId } : { localPath: local }),
        fileName: item.fileName.slice(0, 200),
        contentType: item.contentType || stored?.contentType || "application/octet-stream",
        size: stored?.size ?? item.size ?? 0,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(job._id, {
      mediaKey,
      status: args.error ? "error" : "done",
      response: args.response?.slice(0, 100_000),
      error: args.error?.slice(0, 2000),
      model: args.model,
      finishedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: job._id });
    return null;
  },
});

/** Storage URLs for the media a Codex turn produced. */
export const mediaUrls = internalQuery({
  args: { conversationId: v.id("conversations"), messageKey: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", args.conversationId).eq("messageKey", args.messageKey))
      .collect();
    const urls = await Promise.all(rows.map((row) => row.storageId ? ctx.storage.getUrl(row.storageId) : null));
    return urls.filter((url): url is string => Boolean(url));
  },
});

export const getTurn = internalQuery({
  args: { id: v.id("codexTurns") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job) return null;
    const conversation = await ctx.db.get(job.conversationId);
    return { job, conversation };
  },
});

export const markFinalized = internalMutation({
  args: {
    id: v.id("codexTurns"),
    fallback: v.optional(v.object({
      status: v.union(v.literal("ok"), v.literal("error")),
      model: v.string(),
      error: v.optional(v.string()),
      toolCalls: v.optional(v.array(v.string())),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job || job.finalizedAt) return null;
    await ctx.db.patch(job._id, { finalizedAt: Date.now() });
    const run = await ctx.db.get(job.runId);
    await ctx.db.patch(job.runId, {
      status: args.fallback?.status ?? (job.status === "done" ? "ok" : "error"),
      model: args.fallback?.model ?? job.model ?? "codex subscription",
      error: args.fallback?.error ?? (args.fallback ? undefined : job.error),
      ...(args.fallback?.toolCalls ? { toolCalls: [...(run?.toolCalls ?? []), ...args.fallback.toolCalls] } : {}),
      finishedAt: Date.now(),
    });
    const conversation = await ctx.db.get(job.conversationId);
    if (conversation) await ctx.db.patch(conversation._id, {
      lastMessageAt: Date.now(),
      pendingTurns: conversation.channel === "web" ? Math.max(0, (conversation.pendingTurns ?? 0) - 1) : conversation.pendingTurns,
    });
    return null;
  },
});

export const finalizeTurn = internalAction({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result: {
      job: { prompt: string; response?: string; error?: string; status: string; finalizedAt?: number; mediaKey?: string };
      conversation: { _id: Id<"conversations">; threadId: string; channel: "web" | "telegram"; externalId: string } | null;
    } | null = await ctx.runQuery(internal.codex.getTurn, args);
    if (!result || result.job.finalizedAt || !result.conversation) return null;
    const { job, conversation } = result;
    if (job.status === "error") {
      const fallback = await ctx.runAction(internal.brain.gatewayFallback, args);
      await ctx.runMutation(internal.codex.markFinalized, { id: args.id, fallback });
      return null;
    }
    await saveMessages(ctx, components.agent, {
      threadId: conversation.threadId,
      userId: conversation.channel === "web" ? "web:dashboard" : `telegram:${conversation.externalId}`,
      order: "next",
      messages: [
        { role: "user", content: job.prompt },
        ...(job.response || job.mediaKey
          ? [{ role: "assistant" as const, content: `${job.response ?? ""}${job.mediaKey ? `\n\n<!-- attachments: ${job.mediaKey} -->` : ""}`.trim() }]
          : []),
      ],
    });
    if (conversation.channel === "telegram") {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      const photos: string[] = job.mediaKey
        ? await ctx.runQuery(internal.codex.mediaUrls, { conversationId: conversation._id, messageKey: job.mediaKey })
        : [];
      try {
        if (job.response || !photos.length) await sendMessage(token, conversation.externalId, job.response || `That broke: ${job.error || "Codex did not reply."}`);
        // Telegram fetches photos by URL only up to 5 MB; send a link for anything it refuses.
        for (const url of photos) await sendPhoto(token, conversation.externalId, url).catch(() => sendMessage(token, conversation.externalId, url));
      }
      catch (error) { console.error(`Could not deliver Codex reply: ${String(error)}`); }
    }
    await ctx.runMutation(internal.codex.markFinalized, args);
    return null;
  },
});

/**
 * Delete Codex turns whose chat is gone: one chat's, when it is being deleted,
 * or every orphan when called without a chat.
 */
export const pruneOrphans = internalMutation({
  args: { conversationId: v.optional(v.id("conversations")) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const turns = args.conversationId
      ? await ctx.db.query("codexTurns").withIndex("by_conversation_status", (q) => q.eq("conversationId", args.conversationId!)).collect()
      : await ctx.db.query("codexTurns").collect();
    let deleted = 0;
    for (const turn of turns) {
      if (!args.conversationId && await ctx.db.get(turn.conversationId)) continue;
      await ctx.db.delete(turn._id);
      deleted += 1;
    }
    return deleted;
  },
});

/** Who may use the MCP endpoint: a runner, while it has a Codex turn running. */
export const mcpAccess = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ turnId: Id<"codexTurns">; tools: string[]; userId: string; threadId: string } | null> => {
    const runner = await authenticate(ctx, args.token).catch(() => null);
    if (!runner) return null;
    const job = await ctx.db.query("codexTurns")
      .withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", "running"))
      .first();
    const conversation = job && await ctx.db.get(job.conversationId);
    if (!job || !conversation) return null;
    const mode: Mode = await ctx.runQuery(internal.config.resolveMode, { mode: job.mode });
    return {
      turnId: job._id,
      tools: mode.tools,
      userId: conversation.channel === "web" ? "web:dashboard" : `telegram:${conversation.externalId}`,
      threadId: conversation.threadId,
    };
  },
});

/** Codex's calls into our tools show up on the run like the gateway agent's do. */
export const noteToolCall = internalMutation({
  args: { turnId: v.id("codexTurns"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.turnId);
    const run = job && await ctx.db.get(job.runId);
    if (run) await ctx.db.patch(run._id, { toolCalls: [...(run.toolCalls ?? []), args.name] });
    return null;
  },
});
