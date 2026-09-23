import { v, type Infer } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { saveMessages } from "@convex-dev/agent";
import { editDraft, finishDraft, sendDraft, sendMessage, sendPhoto } from "./lib/telegram";
import { assertDashboardKey } from "./lib/auth";
import { authenticate } from "./runner";
import { FALLBACK_PROVIDER, startFallback } from "./chatgpt";
import { ABSOLUTE_PATH } from "./media";
import { QUIET } from "./jobs";
import { vSpanKind, vSpanStatus, vUsage } from "./schema";
import type { Doc, Id } from "./_generated/dataModel";

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
    if (!runner) {
      // No runner can take it; answer without the computer if the owner allows that.
      const fallback = await startFallback(ctx, {
        conversationId: args.conversationId, runId: args.runId, prompt: args.prompt, history: args.history,
        instructions: args.instructions, requestedModel: args.model, attachments: args.attachments,
      });
      if ("id" in fallback) return fallback.id;
      const offline = conversation.codexRunnerId
        ? "The Codex runner for this chat is offline. Start it to continue"
        : "Connect a ChatGPT account in Settings and start its runner to chat with Codex";
      throw new Error(fallback.reason === "off"
        ? `${offline}, or turn on answering without the computer in Settings.`
        : `${offline}. Answering without the computer needs a ChatGPT token from a runner, and none is valid now.`);
    }
    if (!conversation.codexRunnerId) await ctx.db.patch(conversation._id, { codexRunnerId: runner._id });
    return await ctx.db.insert("codexTurns", {
      runnerId: runner._id,
      conversationId: args.conversationId,
      runId: args.runId,
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

/** Running turns of this runner that the owner asked to stop. */
export const stopRequests = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const runner = await authenticate(ctx, args.token);
    const running = await ctx.db.query("codexTurns")
      .withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", "running"))
      .take(20);
    return running.filter((job) => job.stopRequested).map((job) => job._id);
  },
});

/**
 * Stop a chat's turns: a running one is flagged and its runner interrupts
 * Codex, keeping what it produced; one still queued ends right away.
 */
export const requestStop = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    let stopped = 0;
    for (const status of ["running", "queued"] as const) {
      const turns = await ctx.db.query("codexTurns")
        .withIndex("by_conversation_status", (q) => q.eq("conversationId", args.conversationId).eq("status", status))
        .collect();
      for (const job of turns) {
        if (status === "running") {
          await ctx.db.patch(job._id, { stopRequested: true });
        } else {
          await ctx.db.patch(job._id, { status: "done", stopped: true, finishedAt: Date.now() });
          await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: job._id });
        }
        stopped += 1;
      }
    }
    return stopped;
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

/** Telegram allows about one edit a second per chat; stay under it. */
const TELEGRAM_EDIT_MS = 1_500;

/**
 * The runner reports the reply as Codex writes it. The web chat reads it live
 * from the turn; a Telegram chat gets one message that is edited as it grows,
 * one edit at a time and no faster than TELEGRAM_EDIT_MS.
 */
export const streamTurn = mutation({
  args: { token: v.string(), id: v.id("codexTurns"), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "running") return null;
    await recordPartial(ctx, job, args.text);
    return null;
  },
});

async function recordPartial(ctx: MutationCtx, job: Doc<"codexTurns">, text: string) {
  const conversation = await ctx.db.get(job.conversationId);
  const edit = conversation?.channel === "telegram" && !job.telegramEditing
    && Date.now() - (job.telegramEditedAt ?? 0) >= TELEGRAM_EDIT_MS;
  await ctx.db.patch(job._id, {
    partial: text.slice(0, 100_000),
    ...(edit ? { telegramEditing: true, telegramEditedAt: Date.now() } : {}),
  });
  if (edit) await ctx.scheduler.runAfter(0, internal.codex.streamToTelegram, { id: job._id });
}

export const streamToTelegram = internalAction({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(internal.codex.getTurn, args);
    let messageId = data?.job.telegramMessageId;
    try {
      if (data?.conversation && data.job.partial && !data.job.finalizedAt) {
        const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
        if (messageId) await editDraft(token, data.conversation.externalId, messageId, data.job.partial);
        else messageId = await sendDraft(token, data.conversation.externalId, data.job.partial);
      }
    } catch (error) {
      console.error(`Could not stream to Telegram: ${String(error)}`);
    } finally {
      await ctx.runMutation(internal.codex.streamedToTelegram, { id: args.id, messageId });
    }
    return null;
  },
});

export const streamedToTelegram = internalMutation({
  args: { id: v.id("codexTurns"), messageId: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { telegramEditing: false, telegramMessageId: args.messageId });
    return null;
  },
});

/** The runner cuts span input and output to this many bytes; this is the backstop. */
const SPAN_TEXT = 2_048;

/** How a span is listed in the run's tool calls, as gen_ai.tool.name would name it. */
const toolName = (span: { kind: Doc<"runSpans">["kind"]; name: string }) =>
  span.kind === "command" ? "shell"
    : span.kind === "fileChange" ? "apply_patch"
    : span.kind === "webSearch" ? "web_search"
    : span.kind === "imageGeneration" ? "image_generation"
    : span.name;

/**
 * The runner reports what Codex is doing, on the same cadence as the reply:
 * spans that started or finished since the last report, and the turn's token
 * usage so far. A span is keyed by its Codex item id, so a later report of the
 * same item updates it. Every new span but reasoning also lands in the run's
 * tool calls, and each model response counts as one step.
 */
const vTrace = v.object({
  spans: v.array(v.object({
    callId: v.string(),
    kind: vSpanKind,
    name: v.string(),
    status: vSpanStatus,
    startedAt: v.number(),
    durationMs: v.optional(v.number()),
    input: v.optional(v.string()),
    output: v.optional(v.string()),
  })),
  usage: v.optional(vUsage),
  steps: v.optional(v.number()),
});

export const traceTurn = mutation({
  args: { token: v.string(), id: v.id("codexTurns"), ...vTrace.fields },
  returns: v.null(),
  handler: async (ctx, { token, id, ...trace }) => {
    const runner = await authenticate(ctx, token);
    const job = await ctx.db.get(id);
    if (!job || job.runnerId !== runner._id || job.status !== "running") return null;
    await recordTrace(ctx, job, trace);
    return null;
  },
});

async function recordTrace(ctx: MutationCtx, job: Doc<"codexTurns">, trace: Infer<typeof vTrace>) {
  const run = await ctx.db.get(job.runId);
  if (!run) return;
  const toolCalls = [...(run.toolCalls ?? [])];
  for (const span of trace.spans) {
    const row = {
      ...span,
      name: span.name.slice(0, 300),
      input: span.input?.slice(0, SPAN_TEXT),
      output: span.output?.slice(0, SPAN_TEXT),
    };
    const existing = await ctx.db.query("runSpans")
      .withIndex("by_run", (q) => q.eq("runId", run._id).eq("callId", span.callId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, row);
      continue;
    }
    await ctx.db.insert("runSpans", { runId: run._id, ...row });
    if (span.kind !== "reasoning") toolCalls.push(toolName(span));
  }
  await ctx.db.patch(run._id, {
    toolCalls,
    ...(trace.usage ? { usage: trace.usage } : {}),
    ...(trace.steps !== undefined ? { steps: trace.steps } : {}),
  });
}

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
    /** Codex was interrupted because the owner stopped the turn. */
    stopped: v.optional(v.boolean()),
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
      ...(args.stopped ? { stopped: true } : {}),
      response: args.response?.slice(0, 100_000),
      error: args.error?.slice(0, 2000),
      model: args.model,
      finishedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: job._id });
    return null;
  },
});

// --- Fallback turns, answered in Convex without a runner (fallback.ts) ----

const fallbackTurn = async (ctx: MutationCtx, id: Id<"codexTurns">) => {
  const job = await ctx.db.get(id);
  return job?.fallback && job.status === "running" ? job : null;
};

/** The reply so far. Returns true once the turn should stop: the owner asked, or it already ended. */
export const streamFallback = internalMutation({
  args: { id: v.id("codexTurns"), text: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await fallbackTurn(ctx, args.id);
    if (!job) return true;
    await recordPartial(ctx, job, args.text);
    return job.stopRequested === true;
  },
});

/** Tool calls and usage, as traceTurn records them for a runner. Returns true once the turn should stop. */
export const traceFallback = internalMutation({
  args: { id: v.id("codexTurns"), ...vTrace.fields },
  returns: v.boolean(),
  handler: async (ctx, { id, ...trace }) => {
    const job = await fallbackTurn(ctx, id);
    if (!job) return true;
    await recordTrace(ctx, job, trace);
    return job.stopRequested === true;
  },
});

export const finishFallback = internalMutation({
  args: { id: v.id("codexTurns"), response: v.optional(v.string()), error: v.optional(v.string()), model: v.string(), stopped: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await fallbackTurn(ctx, args.id);
    if (!job) return null;
    await ctx.db.patch(job._id, {
      status: args.error ? "error" : "done",
      ...(args.stopped ? { stopped: true } : {}),
      response: args.response?.slice(0, 100_000),
      error: args.error?.slice(0, 2000),
      model: args.model,
      finishedAt: Date.now(),
    });
    // The chat's Codex thread never saw this exchange, so the next Codex turn
    // starts a fresh one, seeded with the history as it now stands.
    if (args.response) await ctx.db.patch(job.conversationId, { codexThreadId: undefined });
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
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job || job.finalizedAt) return null;
    await ctx.db.patch(job._id, { finalizedAt: Date.now() });
    await ctx.db.patch(job.runId, {
      status: job.status === "done" ? "ok" : "error",
      model: job.model ?? "codex subscription",
      error: job.error,
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

export const markStep = internalMutation({
  args: { id: v.id("codexTurns"), step: v.union(v.literal("reportedAt"), v.literal("savedAt"), v.literal("deliveredAt")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { [args.step]: Date.now() });
    return null;
  },
});

export const finalizeTurn = internalAction({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result: {
      job: { prompt: string; response?: string; error?: string; status: string; model?: string; fallback?: boolean; finalizedAt?: number; mediaKey?: string; telegramMessageId?: number; stopped?: boolean; reportedAt?: number; savedAt?: number; deliveredAt?: number };
      conversation: { _id: Id<"conversations">; threadId: string; channel: "web" | "telegram"; externalId: string; jobId?: Id<"jobs"> } | null;
    } | null = await ctx.runQuery(internal.codex.getTurn, args);
    if (!result || result.job.finalizedAt || !result.conversation) return null;
    const { job, conversation } = result;
    // A stopped turn keeps whatever it had written, marked as stopped.
    const reply = job.stopped ? `${job.response ?? ""}\n\n_Stopped._`.trim() : job.response;
    // Each step is recorded once done, so recovery can retry this safely (see recovery.ts).
    const done = (step: "reportedAt" | "savedAt" | "deliveredAt") => ctx.runMutation(internal.codex.markStep, { id: args.id, step });
    if (conversation.jobId) {
      if (!job.reportedAt) {
        await ctx.runMutation(internal.jobs.finished, { id: conversation.jobId, result: job.response, error: job.error });
        await done("reportedAt");
      }
      // A job with nothing to say leaves no trace in its chat.
      if (!job.error && job.response?.trim() === QUIET && !job.mediaKey) {
        await ctx.runMutation(internal.codex.markFinalized, args);
        return null;
      }
    }
    // A failed turn keeps the owner's message; the error shows on the run and, on Telegram, as a reply.
    const answered = Boolean(reply || job.mediaKey);
    if (!job.savedAt) await saveMessages(ctx, components.agent, {
      threadId: conversation.threadId,
      userId: conversation.channel === "web" ? "web:dashboard" : `telegram:${conversation.externalId}`,
      order: "next",
      messages: [
        { role: "user", content: job.prompt },
        ...(answered
          ? [{ role: "assistant" as const, content: `${reply ?? ""}${job.mediaKey ? `\n\n<!-- attachments: ${job.mediaKey} -->` : ""}`.trim() }]
          : []),
      ],
      // A reply written without the computer says so in the web chat.
      ...(job.fallback && answered ? { metadata: [{}, { provider: FALLBACK_PROVIDER, model: job.model }] } : {}),
    }).then(() => done("savedAt"));
    if (conversation.channel === "telegram" && !job.deliveredAt) {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      const photos: string[] = job.mediaKey
        ? await ctx.runQuery(internal.codex.mediaUrls, { conversationId: conversation._id, messageKey: job.mediaKey })
        : [];
      try {
        const answer = job.error
          ? `${job.response ? `${job.response}\n\n` : ""}That broke: ${job.error}`
          : reply || (photos.length ? "" : "Codex did not reply.");
        const text = job.fallback && answer ? `${answer}\n\n(Answered without your computer.)` : answer;
        // A streamed reply lands in the message that showed it growing.
        if (job.telegramMessageId) await finishDraft(token, conversation.externalId, job.telegramMessageId, text || "Done.");
        else if (text) await sendMessage(token, conversation.externalId, text);
        // Telegram fetches photos by URL only up to 5 MB; send a link for anything it refuses.
        for (const url of photos) await sendPhoto(token, conversation.externalId, url).catch(() => sendMessage(token, conversation.externalId, url));
      }
      catch (error) { console.error(`Could not deliver Codex reply: ${String(error)}`); }
      // Marked even when sending failed part-way, so a retry never sends a reply twice.
      await done("deliveredAt");
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
  handler: async (ctx, args): Promise<{ turnId: Id<"codexTurns">; userId: string; threadId: string } | null> => {
    const runner = await authenticate(ctx, args.token).catch(() => null);
    if (!runner) return null;
    const job = await ctx.db.query("codexTurns")
      .withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", "running"))
      .first();
    const conversation = job && await ctx.db.get(job.conversationId);
    if (!job || !conversation) return null;
    return {
      turnId: job._id,
      userId: conversation.channel === "web" ? "web:dashboard" : `telegram:${conversation.externalId}`,
      threadId: conversation.threadId,
    };
  },
});
