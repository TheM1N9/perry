import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { saveMessages } from "@convex-dev/agent";
import { sendMessage } from "./lib/telegram";
import { vMode } from "./schema";
import { assertDashboardKey } from "./lib/auth";
import { authenticate } from "./runner";

export const engine = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    return install?.chatEngine ?? "codex";
  },
});

export const setEngine = mutation({
  args: { key: v.string(), engine: v.union(v.literal("codex"), v.literal("gateway")) },
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    await ctx.db.patch(runner._id, {
      codexAvailable: args.available,
      codexAuthMode: args.authMode,
      codexPlanType: args.planType,
      codexError: args.error?.slice(0, 500),
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
    attachments: v.optional(v.array(v.object({
      url: v.string(),
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
    return { ...job, codexThreadId: conversation.codexThreadId };
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

export const finishTurn = mutation({
  args: {
    token: v.string(), id: v.id("codexTurns"),
    response: v.optional(v.string()), error: v.optional(v.string()), model: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "running") return null;
    await ctx.db.patch(job._id, {
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
    await ctx.db.patch(job.runId, {
      status: args.fallback?.status ?? (job.status === "done" ? "ok" : "error"),
      model: args.fallback?.model ?? job.model ?? "codex subscription",
      error: args.fallback?.error ?? (args.fallback ? undefined : job.error),
      toolCalls: args.fallback?.toolCalls,
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
      job: { prompt: string; response?: string; error?: string; status: string; finalizedAt?: number };
      conversation: { threadId: string; channel: "web" | "telegram"; externalId: string } | null;
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
        ...(job.response ? [{ role: "assistant" as const, content: job.response }] : []),
      ],
    });
    if (conversation.channel === "telegram") {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      try { await sendMessage(token, conversation.externalId, job.response || `That broke: ${job.error || "Codex did not reply."}`); }
      catch (error) { console.error(`Could not deliver Codex reply: ${String(error)}`); }
    }
    await ctx.runMutation(internal.codex.markFinalized, args);
    return null;
  },
});
