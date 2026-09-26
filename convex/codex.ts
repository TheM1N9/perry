import { v, type Infer } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { createThread, saveMessages } from "./lib/agent";
import { CAPTION_LIMIT, UPLOAD_LIMIT, deleteMessage, editDraft, finishDraft, sendDraft, sendFile, sendMessage } from "./lib/telegram";
import { assertDashboardKey } from "./lib/auth";
import { COMPACTED } from "./lib/commands";
import { authenticate } from "./runner";
import { ABSOLUTE_PATH } from "./media";
import { QUIET } from "./jobs";
import { hide, savedValues } from "./vault";
import { takeFromOutbox } from "./conversations";
import { vAccess, vCodexModel, vSpanKind, vSpanStatus, vTurnAttachment, vUsage } from "./schema";
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
    models: v.optional(v.array(vCodexModel)),
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

/** The chat's runner, or the freshest online one for a chat that has none yet. */
async function pickRunner(ctx: MutationCtx, conversation: Doc<"conversations">): Promise<Id<"runners"> | null> {
  const runners = conversation.codexRunnerId
    ? [await ctx.db.get(conversation.codexRunnerId)]
    : await ctx.db.query("runners").order("desc").take(20);
  const runner = runners.filter((item) => item && !item.revoked && item.codexAvailable && item.codexAuthMode === "chatgpt" && (item.lastSeenAt ?? 0) > Date.now() - 90_000)
    .sort((a, b) => (b!.lastSeenAt ?? 0) - (a!.lastSeenAt ?? 0))[0];
  if (!runner) return null;
  if (!conversation.codexRunnerId) await ctx.db.patch(conversation._id, { codexRunnerId: runner._id });
  return runner._id;
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/execution/session/input-queue.ts
/**
 * Whether a new message joins the running turn instead of waiting behind it:
 * only when it asks to steer, and only into a reply that is not being stopped
 * and is not a compaction, which Codex cannot steer.
 */
function isSteering(policy: "steer" | "queue" | undefined, running: Doc<"codexTurns"> | null): running is Doc<"codexTurns"> {
  return (policy ?? "queue") === "steer" && running !== null && !running.stopRequested && running.kind !== "compact"
    && running.runnerId !== undefined;
}

/**
 * Hand a message to Codex. With the "steer" policy, a message sent while the
 * chat's reply is running joins that reply (see codexSteers); otherwise, and
 * for "queue", it becomes a turn of its own behind whatever is running.
 */
export const enqueueTurn = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    runId: v.id("runs"),
    prompt: v.string(),
    history: v.optional(v.string()),
    instructions: v.string(),
    recalled: v.optional(v.string()),
    recallDigest: v.optional(v.string()),
    flush: v.optional(v.boolean()),
    /** The prompt is not the owner's: only the reply is saved to the chat (see finalizeTurn). */
    hidden: v.optional(v.boolean()),
    model: v.optional(v.string()),
    /** The reasoning effort for turn/start, already checked against the model (commands.turnEffort). */
    effort: v.optional(v.string()),
    access: v.optional(vAccess),
    attachments: v.optional(v.array(vTurnAttachment)),
    policy: v.optional(v.union(v.literal("steer"), v.literal("queue"))),
  },
  returns: v.union(v.id("codexTurns"), v.id("codexSteers")),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("This chat was deleted.");
    const running = await ctx.db.query("codexTurns")
      .withIndex("by_conversation_status", (q) => q.eq("conversationId", args.conversationId).eq("status", "running"))
      .first();
    const message = {
      conversationId: args.conversationId,
      runId: args.runId,
      prompt: args.prompt,
      history: args.history,
      instructions: args.instructions,
      recalled: args.recalled || undefined,
      recallDigest: args.recallDigest,
      ...(args.flush ? { flush: true } : {}),
      ...(args.hidden ? { hidden: true } : {}),
      requestedModel: args.model,
      requestedEffort: args.effort,
      access: args.access,
      attachments: args.attachments,
      createdAt: Date.now(),
    };
    if (isSteering(args.policy, running)) {
      // The running turn already carries recalled memory; a steer adds only the message.
      const { recalled: _recalled, recallDigest: _digest, flush: _flush, hidden: _hidden, ...steer } = message;
      const id = await ctx.db.insert("codexSteers", { ...steer, turnId: running._id, runnerId: running.runnerId!, status: "pending" });
      await takeFromOutbox(ctx, conversation, args.prompt);
      return id;
    }
    const runnerId = await pickRunner(ctx, conversation);
    if (!runnerId) {
      throw new Error(conversation.codexRunnerId
        ? "The Codex runner for this chat is offline. Start Perry on its computer (perry start) to continue."
        : "Sign in to Codex in Settings and start Perry's runner (perry start) to chat.");
    }
    const id = await ctx.db.insert("codexTurns", { ...message, runnerId, status: "queued" });
    await takeFromOutbox(ctx, await ctx.db.get(args.conversationId), args.prompt);
    return id;
  },
});

/**
 * A steer that could not join its turn becomes an ordinary turn of its own,
 * queued behind it; one the owner stopped along with its turn ends at once.
 */
export async function queueSteer(ctx: MutationCtx, steer: Doc<"codexSteers">, outcome: { error?: string; stopped?: boolean } = {}) {
  const queuedTurnId = await ctx.db.insert("codexTurns", {
    runnerId: steer.runnerId,
    conversationId: steer.conversationId,
    runId: steer.runId,
    prompt: steer.prompt,
    history: steer.history,
    instructions: steer.instructions,
    requestedModel: steer.requestedModel,
    requestedEffort: steer.requestedEffort,
    access: steer.access,
    attachments: steer.attachments,
    createdAt: Date.now(),
    ...(outcome.stopped ? { status: "done", stopped: true, finishedAt: Date.now() } : { status: "queued" }),
  });
  await ctx.db.patch(steer._id, { status: "queued", queuedTurnId, error: outcome.error?.slice(0, 500) });
  if (outcome.stopped) await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: queuedTurnId });
}

/** Every steer of a turn still waiting for the runner. */
const pendingSteersOf = (ctx: MutationCtx, turnId: Id<"codexTurns">) => ctx.db.query("codexSteers")
  .withIndex("by_turn_status", (q) => q.eq("turnId", turnId).eq("status", "pending"))
  .collect();

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

/** Messages the owner sent into this runner's running turns, for it to steer Codex with. */
export const pendingSteers = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const steers = await ctx.db.query("codexSteers")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(50);
    return steers.filter((steer) => steer.runnerId === runner._id)
      .map((steer) => ({ _id: steer._id, turnId: steer.turnId, prompt: steer.prompt, attachments: steer.attachments }));
  },
});

/**
 * The runner's answer for a steer: Codex took it into the running turn, or it
 * could not ("no active turn", a turn id mismatch), and it is queued instead.
 */
export const ackSteer = mutation({
  args: { token: v.string(), id: v.id("codexSteers"), applied: v.boolean(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const steer = await ctx.db.get(args.id);
    if (!steer || steer.runnerId !== runner._id || steer.status !== "pending") return null;
    if (args.applied) await ctx.db.patch(steer._id, { status: "applied", appliedAt: Date.now() });
    else await queueSteer(ctx, steer, { error: args.error });
    return null;
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
        // A /compact is not a reply, and Codex finishes it quickly on its own.
        if (job.kind === "compact") continue;
        if (status === "running") {
          await ctx.db.patch(job._id, { stopRequested: true });
          // A message sent into the reply stops with it, but stays in the chat.
          for (const steer of await pendingSteersOf(ctx, job._id)) await queueSteer(ctx, steer, { stopped: true });
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

/**
 * /compact: ask Codex to summarise the chat's thread so it carries less
 * context. It waits in the chat's queue like a turn, so it never runs while a
 * reply is being written. Null when the chat has no Codex thread yet.
 */
export const requestCompact = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.union(v.null(), v.id("codexTurns")),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("This chat was deleted.");
    if (!conversation.codexThreadId) return null;
    const runnerId = await pickRunner(ctx, conversation);
    // Only a runner's Codex holds the thread; answering without the computer cannot compact it.
    if (!runnerId) throw new Error("The Codex runner for this chat is offline. Start it to compact this chat.");
    const runId = await ctx.db.insert("runs", { conversationId: conversation._id, prompt: "/compact", status: "running", startedAt: Date.now() });
    return await ctx.db.insert("codexTurns", {
      runnerId,
      conversationId: conversation._id,
      runId,
      kind: "compact",
      prompt: "/compact",
      instructions: "",
      status: "queued",
      createdAt: Date.now(),
    });
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
    // Relative: the runner reaches the server at its own address for it, which may be over Tailscale.
    return { ...job, codexThreadId: conversation.codexThreadId, channel: conversation.channel, mcpUrl: "/api/backend/http/mcp" };
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

/** Codex has started the turn; its id is what a steer is checked against. */
export const setCodexTurn = mutation({
  args: { token: v.string(), id: v.id("codexTurns"), codexTurnId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "running") return null;
    await ctx.db.patch(job._id, { codexTurnId: args.codexTurnId });
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
  // The flush before /reset works quietly, so it never shows on Telegram.
  const edit = conversation?.channel === "telegram" && !job.flush && !job.telegramEditing
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
  // use_secret's answer, and a password typed into a sign-in form, are kept out of the trace.
  const values = await savedValues(ctx);
  for (const span of trace.spans) {
    const row = {
      ...span,
      name: span.name.slice(0, 300),
      input: span.input && hide(span.input, values).slice(0, SPAN_TEXT),
      output: span.output && hide(span.output, values).slice(0, SPAN_TEXT),
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
    /** Codex compacted the thread's context during the turn, so recalled memory may be gone from it. */
    compacted: v.optional(v.boolean()),
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
    const shared = job.mediaKey
      ? await ctx.db.query("chatAttachments")
        .withIndex("by_message", (q) => q.eq("conversationId", job.conversationId).eq("messageKey", job.mediaKey!))
        .collect()
      : [];
    for (const item of args.media ?? []) {
      const stored = item.storageId ? await ctx.storage.getMetadata(item.storageId) : null;
      const local = item.localPath && ABSOLUTE_PATH.test(item.localPath) ? item.localPath : undefined;
      if (!stored && !local) continue;
      mediaKey = `codex-${job._id}`;
      // A shared file uploaded for Telegram gains its copy; the chat keeps serving it from the machine.
      const row = stored && local ? shared.find((existing) => existing.localPath === local && !existing.storageId) : undefined;
      if (row) {
        await ctx.db.patch(row._id, { storageId: item.storageId, size: stored!.size });
        continue;
      }
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
    // The chat's Codex thread has now seen this turn's recalled memory, unless
    // compaction summarised it away; either way the next turn knows what to send.
    if ((args.compacted || !args.error) && await ctx.db.get(job.conversationId)) {
      await ctx.db.patch(job.conversationId, { recallDigest: args.compacted ? undefined : job.recallDigest });
    }
    // Messages the turn ended before taking are answered next, in the same transaction.
    for (const steer of await pendingSteersOf(ctx, job._id)) await queueSteer(ctx, steer, { error: "The reply finished before this message could join it." });
    await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, { id: job._id });
    return null;
  },
});

const vTurnFile = v.object({
  storageId: v.optional(v.id("_storage")),
  localPath: v.optional(v.string()),
  fileName: v.string(),
  contentType: v.string(),
  size: v.number(),
});
type TurnFile = typeof vTurnFile.type;

/** The files a Codex turn produced or shared, in the order they came. */
export const turnFiles = internalQuery({
  args: { conversationId: v.id("conversations"), messageKey: v.string() },
  returns: v.array(vTurnFile),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", args.conversationId).eq("messageKey", args.messageKey))
      .collect();
    return rows.map((row) => ({
      storageId: row.storageId, localPath: row.localPath, fileName: row.fileName, contentType: row.contentType, size: row.size,
    }));
  },
});

/**
 * Files share_file attached to a running turn that are still only on the
 * owner's machine. For a Telegram chat the runner uploads them, since
 * Telegram needs the bytes.
 */
export const sharedFiles = query({
  args: { token: v.string(), id: v.id("codexTurns") },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const job = await ctx.db.get(args.id);
    if (!job || job.runnerId !== runner._id || job.status !== "running" || !job.mediaKey) return [];
    const rows = await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", job.conversationId).eq("messageKey", job.mediaKey!))
      .collect();
    return rows.filter((row) => row.localPath && !row.storageId)
      .map((row) => ({ localPath: row.localPath!, fileName: row.fileName, contentType: row.contentType }));
  },
});

/**
 * Send a finished reply and its files to Telegram. A reply short enough to be
 * a caption rides on the first file and takes the place of the streamed draft;
 * a longer one goes first, as text, with the files after it. A file too big to
 * upload, or one that never left the owner's machine, is named with where it is.
 */
async function deliverToTelegram(
  ctx: ActionCtx, token: string | null, chatId: string, text: string, draftId: number | undefined, files: TurnFile[],
): Promise<void> {
  const send = async (file: TurnFile, caption?: string) => {
    if (!file.storageId) {
      await sendMessage(token, chatId, `${file.fileName} is on your computer at ${file.localPath}; it could not be uploaded.`);
      return;
    }
    if (file.size > UPLOAD_LIMIT) {
      await sendMessage(token, chatId, `${file.fileName} is too big to send on Telegram${file.localPath ? `; it is on your computer at ${file.localPath}` : ""}.`);
      return;
    }
    const blob = await ctx.storage.get(file.storageId);
    if (!blob) throw new Error(`${file.fileName} is gone from storage.`);
    await sendFile(token, chatId, { blob, fileName: file.fileName, contentType: file.contentType, caption });
  };

  // Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/channels/slack/api.ts
  const first = files.find((file) => file.storageId && file.size <= UPLOAD_LIMIT);
  let captioned = false;
  if (first && text && text.length <= CAPTION_LIMIT) {
    try {
      await send(first, text);
      captioned = true;
    } catch (error) {
      console.error(`Could not send ${first.fileName} with its caption: ${String(error)}`);
    }
  }
  if (captioned) {
    if (draftId) await deleteMessage(token, chatId, draftId);
  } else if (draftId) {
    await finishDraft(token, chatId, draftId, text || "Done.");
  } else if (text) {
    await sendMessage(token, chatId, text, { markdown: true });
  }
  for (const file of files) {
    if (captioned && file === first) continue;
    await send(file).catch(async (error) => {
      console.error(`Could not send ${file.fileName}: ${String(error)}`);
      await sendMessage(token, chatId, `Could not send ${file.fileName}.`);
    });
  }
}

export const getTurn = internalQuery({
  args: { id: v.id("codexTurns") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job) return null;
    const conversation = await ctx.db.get(job.conversationId);
    // The messages that joined the turn, in the order Codex took them.
    const steers = (await ctx.db.query("codexSteers")
      .withIndex("by_turn_status", (q) => q.eq("turnId", job._id).eq("status", "applied"))
      .collect()).sort((a, b) => (a.appliedAt ?? 0) - (b.appliedAt ?? 0));
    // A saved login typed into the chat, or read back into the reply, is not kept or delivered.
    const values = await savedValues(ctx);
    const clean = (text: string) => hide(text, values);
    return {
      job: {
        ...job,
        prompt: clean(job.prompt),
        ...(job.response !== undefined ? { response: clean(job.response) } : {}),
        ...(job.partial !== undefined ? { partial: clean(job.partial) } : {}),
      },
      conversation,
      steers: steers.map((steer) => clean(steer.prompt)),
    };
  },
});

export const markFinalized = internalMutation({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job || job.finalizedAt) return null;
    await ctx.db.patch(job._id, { finalizedAt: Date.now() });
    // Each message that joined the turn has its own run, and ends with it.
    const steers = await ctx.db.query("codexSteers")
      .withIndex("by_turn_status", (q) => q.eq("turnId", job._id).eq("status", "applied"))
      .collect();
    for (const runId of [job.runId, ...steers.map((steer) => steer.runId)]) {
      await ctx.db.patch(runId, {
        status: job.status === "done" ? "ok" : "error",
        model: job.model ?? "codex subscription",
        error: job.error,
        finishedAt: Date.now(),
      });
    }
    // A compaction is not a message: the chat was never marked busy for it.
    const conversation = job.kind === "compact" ? null : await ctx.db.get(job.conversationId);
    if (conversation) await ctx.db.patch(conversation._id, {
      lastMessageAt: Date.now(),
      pendingTurns: conversation.channel === "web" ? Math.max(0, (conversation.pendingTurns ?? 0) - 1 - steers.length) : conversation.pendingTurns,
    });
    return null;
  },
});

/**
 * Start finalizing, unless another finalize of this turn started within the
 * lease: delivering files can take minutes (uploads, rate limits), and a
 * second finalize beside it would send them again.
 */
export const beginFinalize = internalMutation({
  args: { id: v.id("codexTurns") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job || job.finalizedAt) return false;
    if (job.finalizingAt && job.finalizingAt > Date.now() - FINALIZE_LEASE_MS) return false;
    await ctx.db.patch(args.id, { finalizingAt: Date.now() });
    return true;
  },
});

/** Long enough for a finalize with slow uploads to finish; a crashed one is retried after it. */
export const FINALIZE_LEASE_MS = 10 * 60_000;

export const markStep = internalMutation({
  args: { id: v.id("codexTurns"), step: v.union(v.literal("reportedAt"), v.literal("savedAt"), v.literal("deliveredAt")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { [args.step]: Date.now() });
    return null;
  },
});

/** A short note to a messaging chat, outside a reply: a command's outcome, or why something did not happen. */
async function tell(ctx: ActionCtx, conversation: { channel: "web" | "telegram" | "whatsapp"; externalId: string }, text: string) {
  if (conversation.channel === "telegram") {
    const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
    await sendMessage(token, conversation.externalId, text);
  } else if (conversation.channel === "whatsapp") {
    await ctx.runMutation(internal.whatsapp.send, { to: conversation.externalId, text });
  }
}

export const finalizeTurn = internalAction({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result: {
      job: { kind?: "compact"; prompt: string; response?: string; error?: string; status: string; model?: string; finalizedAt?: number; mediaKey?: string; telegramMessageId?: number; stopped?: boolean; flush?: boolean; hidden?: boolean; reportedAt?: number; savedAt?: number; deliveredAt?: number };
      conversation: { _id: Id<"conversations">; threadId: string; channel: "web" | "telegram" | "whatsapp"; externalId: string; title?: string; jobId?: Id<"jobs"> } | null;
      steers: string[];
    } | null = await ctx.runQuery(internal.codex.getTurn, args);
    if (!result || result.job.finalizedAt || !result.conversation) return null;
    if (!(await ctx.runMutation(internal.codex.beginFinalize, args))) return null;
    const { job, conversation, steers } = result;
    // A stopped turn keeps whatever it had written, marked as stopped.
    const reply = job.stopped ? `${job.response ?? ""}\n\n_Stopped._`.trim() : job.response;
    // Each step is recorded once done, so recovery can retry this safely (see recovery.ts).
    const done = (step: "reportedAt" | "savedAt" | "deliveredAt") => ctx.runMutation(internal.codex.markStep, { id: args.id, step });
    const userId = conversation.channel === "web" ? "web:dashboard" : `${conversation.channel}:${conversation.externalId}`;
    // The flush before /reset leaves nothing in the chat: finishing it, even
    // with an error, starts the chat afresh ("saved" here), and only a failure
    // is worth telling a Telegram chat about.
    if (job.flush) {
      if (!job.savedAt) {
        const threadId = await createThread(ctx, { userId, title: conversation.title });
        await ctx.runMutation(internal.conversations.clearThread, { id: conversation._id, threadId });
        await done("savedAt");
      }
      if (conversation.channel !== "web" && job.error && !job.deliveredAt) {
        await tell(ctx, conversation, `Fresh start, but this chat was not summarised into memory first: ${job.error}`)
          .catch((error) => console.error(`Could not report the flush: ${String(error)}`));
        await done("deliveredAt");
      }
      await ctx.runMutation(internal.codex.markFinalized, args);
      return null;
    }
    // A compaction leaves the chat as it was. The web chat watches it finish;
    // Telegram is told, like any command.
    if (job.kind === "compact") {
      if (conversation.channel !== "web" && !job.deliveredAt) {
        await tell(ctx, conversation, job.error ? `Could not compact: ${job.error}` : COMPACTED)
          .catch((error) => console.error(`Could not report compaction: ${String(error)}`));
        await done("deliveredAt");
      }
      await ctx.runMutation(internal.codex.markFinalized, args);
      return null;
    }
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
    // Messages that joined the reply come after the one that started it, and before the reply.
    // A hidden prompt (the greeting after the welcome page) is not the owner's, so only what they sent is kept.
    const prompts = job.hidden ? steers : [job.prompt, ...steers];
    const answered = Boolean(reply || job.mediaKey);
    if (!job.savedAt) await saveMessages(ctx, {
      threadId: conversation.threadId,
      userId,
      order: "next",
      messages: [
        ...prompts.map((content) => ({ role: "user" as const, content })),
        ...(answered
          ? [{ role: "assistant" as const, content: `${reply ?? ""}${job.mediaKey ? `\n\n<!-- attachments: ${job.mediaKey} -->` : ""}`.trim() }]
          : []),
      ],
    }).then(() => done("savedAt"));
    if (conversation.channel === "telegram" && !job.deliveredAt) {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      const files: TurnFile[] = job.mediaKey
        ? await ctx.runQuery(internal.codex.turnFiles, { conversationId: conversation._id, messageKey: job.mediaKey })
        : [];
      try {
        const answer = job.error
          ? `${job.response ? `${job.response}\n\n` : ""}That broke: ${job.error}`
          : reply || (files.length ? "" : "Codex did not reply.");
        const text = answer;
        // A streamed reply lands in the message that showed it growing, unless a file carries it.
        await deliverToTelegram(ctx, token, conversation.externalId, text, job.telegramMessageId, files);
      }
      catch (error) { console.error(`Could not deliver Codex reply: ${String(error)}`); }
      // Marked even when sending failed part-way, so a retry never sends a reply twice.
      await done("deliveredAt");
    }
    // WhatsApp gets the finished reply, then its files, through the connection's outbox; it showed "typing…" meanwhile.
    if (conversation.channel === "whatsapp" && !job.deliveredAt) {
      const files: TurnFile[] = job.mediaKey
        ? await ctx.runQuery(internal.codex.turnFiles, { conversationId: conversation._id, messageKey: job.mediaKey })
        : [];
      const answer = job.error
        ? `${job.response ? `${job.response}\n\n` : ""}That broke: ${job.error}`
        : reply || (files.length ? "" : "Codex did not reply.");
      if (answer) await ctx.runMutation(internal.whatsapp.send, { to: conversation.externalId, text: answer });
      for (const file of files) {
        await ctx.runMutation(internal.whatsapp.sendFile, {
          to: conversation.externalId, fileName: file.fileName, contentType: file.contentType,
          ...(file.storageId ? { storageId: file.storageId } : {}), ...(file.localPath ? { localPath: file.localPath } : {}),
        });
      }
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
      const steers = await ctx.db.query("codexSteers").withIndex("by_turn_status", (q) => q.eq("turnId", turn._id)).collect();
      for (const steer of steers) await ctx.db.delete(steer._id);
      await ctx.db.delete(turn._id);
      deleted += 1;
    }
    return deleted;
  },
});

/** Who may use the MCP endpoint: a runner, while it has a Codex turn running. */
export const mcpAccess = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ turnId: Id<"codexTurns">; userId: string; threadId: string; fromJob: boolean; conversationId: Id<"conversations"> } | null> => {
    const runner = await authenticate(ctx, args.token).catch(() => null);
    if (!runner) return null;
    const job = await ctx.db.query("codexTurns")
      .withIndex("by_runner_status", (q) => q.eq("runnerId", runner._id).eq("status", "running"))
      .first();
    const conversation = job && await ctx.db.get(job.conversationId);
    if (!job || !conversation) return null;
    return {
      turnId: job._id,
      userId: conversation.channel === "web" ? "web:dashboard" : `${conversation.channel}:${conversation.externalId}`,
      threadId: conversation.threadId,
      fromJob: Boolean(conversation.jobId),
      conversationId: conversation._id,
    };
  },
});
