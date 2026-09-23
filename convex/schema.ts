import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vChannel = v.union(v.literal("telegram"), v.literal("web"));
export const vMode = v.union(v.literal("perry"), v.literal("agentP"));

/**
 * Perry is single-owner, so there is no users table. The owner is identified by
 * channel plus external id, checked against an env allowlist on every inbound
 * message. Everything below is scoped to that one owner.
 */
export default defineSchema({
  /**
   * Exactly one row, describing this install and who owns it.
   *
   * The owner used to be an environment variable, which meant claiming your own
   * Perry took a trip back to a terminal. It lives here instead so the whole
   * flow is: run setup, send the code to your bot, done. One install, one
   * owner, and the owner is whoever answered the code first.
   */
  installation: defineTable({
    ownerChannel: v.optional(vChannel),
    ownerExternalId: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    /** Cleared the moment it is used. Null once claimed. */
    pairingCode: v.optional(v.string()),
    pairingExpiresAt: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    /** The Daytona sandbox this install works in, created on first use. */
    sandboxId: v.optional(v.string()),
    /** Where run_command goes: a throwaway cloud box, or the owner's machine. */
    computeTarget: v.optional(v.union(v.literal("sandbox"), v.literal("local"))),
    /** Codex subscription is the default engine for chats. */
    chatEngine: v.optional(v.union(v.literal("codex"), v.literal("gateway"))),
    createdAt: v.number(),
  }),

  /**
   * Work Perry has been asked to do, borrowed from OpenMuse's task model.
   *
   * A task is the unit that survives the conversation: the agent writes a plan
   * into it, ticks steps off as it goes, and the dashboard renders progress
   * without anyone having to scroll back through chat.
   */
  tasks: defineTable({
    title: v.string(),
    prompt: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("blocked"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    goalId: v.optional(v.id("goals")),
    /** The agent's own checklist. Rewritten wholesale by `plan`. */
    plan: v.array(
      v.object({
        title: v.string(),
        status: v.union(
          v.literal("pending"),
          v.literal("active"),
          v.literal("done"),
          v.literal("skipped"),
        ),
        note: v.optional(v.string()),
      }),
    ),
    /** What it needs from the owner, when status is blocked. */
    question: v.optional(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_updated", ["updatedAt"]),

  /**
   * An outcome the owner wants, with milestones. Slower moving than a task,
   * and a task can belong to one.
   */
  goals: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("done"),
    ),
    milestones: v.array(v.object({ title: v.string(), done: v.boolean() })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_status", ["status"]),

  /**
   * A recurring check on a public page. The cron ticks these, and Perry only
   * speaks up when the condition actually fires.
   */
  monitors: defineTable({
    title: v.string(),
    url: v.string(),
    condition: v.union(
      v.literal("change"),
      v.literal("contains"),
      v.literal("price_below"),
    ),
    value: v.optional(v.string()),
    intervalMinutes: v.number(),
    active: v.boolean(),
    /** Hash of the last body, for change detection. */
    lastFingerprint: v.optional(v.string()),
    lastCheckedAt: v.optional(v.number()),
    nextCheckAt: v.number(),
    lastObservation: v.optional(v.string()),
    firedAt: v.optional(v.number()),
    failures: v.number(),
    createdAt: v.number(),
  })
    .index("by_next_check", ["nextCheckAt"])
    .index("by_active", ["active"]),

  /**
   * Commands run in the sandbox, kept so a repeated operationId returns the
   * first receipt instead of running twice. OpenMuse's idea: an interrupted
   * command must never be silently retried.
   */
  receipts: defineTable({
    operationId: v.string(),
    command: v.string(),
    exitCode: v.optional(v.number()),
    output: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_operation", ["operationId"]),

  /**
   * A machine the owner has connected: their laptop, desktop or Mac.
   *
   * The critical property is the direction of the connection. The runner dials
   * out to Convex and holds a subscription; Convex never dials in. There is no
   * listening port, no inbound firewall rule and no tunnel, so a Perry install
   * cannot be found by scanning the internet. OpenClaw's 135,000 exposed
   * instances are the cost of getting this backwards.
   */
  runners: defineTable({
    name: v.string(),
    token: v.string(),
    platform: v.optional(v.string()),
    hostname: v.optional(v.string()),
    workdir: v.optional(v.string()),
    /** False means every command waits for a keypress on that machine. */
    autoApprove: v.boolean(),
    lastSeenAt: v.optional(v.number()),
    revoked: v.boolean(),
    /** Codex credentials stay in the CLI's local store on this runner. */
    codexAvailable: v.optional(v.boolean()),
    codexAuthMode: v.optional(v.string()),
    codexPlanType: v.optional(v.string()),
    codexError: v.optional(v.string()),
    codexUpdatedAt: v.optional(v.number()),
    codexRequestId: v.optional(v.number()),
    codexRequestKind: v.optional(v.union(v.literal("login"), v.literal("logout"))),
    codexRequestStatus: v.optional(v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("error"))),
    codexVerificationUrl: v.optional(v.string()),
    codexUserCode: v.optional(v.string()),
    codexRequestError: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  /**
   * One row per operation handed to a runner. The runner subscribes to the
   * queued ones, does the work, and writes the result back here.
   */
  commands: defineTable({
    runnerId: v.id("runners"),
    kind: v.union(
      v.literal("exec"),
      v.literal("read"),
      v.literal("write"),
      v.literal("list"),
    ),
    operationId: v.string(),
    command: v.optional(v.string()),
    path: v.optional(v.string()),
    text: v.optional(v.string()),
    cwd: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("denied"),
      v.literal("error"),
    ),
    exitCode: v.optional(v.number()),
    output: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_runner_status", ["runnerId", "status"])
    .index("by_operation", ["operationId"])
    .index("by_created", ["createdAt"]),

  /**
   * Service keys, set from the dashboard instead of a terminal.
   *
   * Convex environment variables can only be written by the CLI, which meant
   * every key change was a trip to a shell. These rows take precedence over
   * the matching environment variable, so an install configured the old way
   * keeps working and the dashboard can override any of it.
   *
   * DASHBOARD_KEY deliberately stays an environment variable: it is the thing
   * that guards this table, and a lockout should be recoverable from a
   * terminal rather than not at all.
   */
  secrets: defineTable({
    name: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  /**
   * One row per chat Perry talks in. Holds the durable mode and the id of the
   * Agent component thread that carries the message history.
   */
  conversations: defineTable({
    channel: vChannel,
    externalId: v.string(), // telegram chat id, or a unique web session id
    threadId: v.string(),
    codexThreadId: v.optional(v.string()),
    codexRunnerId: v.optional(v.id("runners")),
    mode: vMode,
    title: v.optional(v.string()),
    parentConversationId: v.optional(v.id("conversations")),
    branchedFromMessageId: v.optional(v.string()),
    pendingTurns: v.optional(v.number()),
    lastMessageAt: v.number(),
  })
    .index("by_channel_external", ["channel", "externalId"])
    .index("by_channel_last", ["channel", "lastMessageAt"]),

  /**
   * Per-mode overrides layered on top of the defaults in modes.ts.
   *
   * The defaults stay in code so a fresh deployment works with an empty table
   * and so the file remains the readable answer to "what is Perry allowed to
   * do". This table exists so the next person to run Perry can change the model
   * from the dashboard instead of editing TypeScript and redeploying.
   */
  modeConfigs: defineTable({
    mode: vMode,
    model: v.optional(v.string()),
    stepBudget: v.optional(v.number()),
    tools: v.optional(v.array(v.string())),
    instructions: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_mode", ["mode"]),

  /**
   * Durable facts, written only when the agent explicitly calls `remember`.
   * Full-text search for now. Swapping in @convex-dev/rag for embeddings is a
   * later step and does not change the tool surface.
   */
  memories: defineTable({
    text: v.string(),
    tags: v.array(v.string()),
    source: v.string(),
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .searchIndex("search_text", { searchField: "text" }),

  /**
   * One row per agent turn: what came in, which mode handled it, which tools
   * fired, what it cost, and how it ended. Debugging a chat bot without this is
   * guesswork.
   */
  runs: defineTable({
    conversationId: v.id("conversations"),
    mode: vMode,
    prompt: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("ok"),
      v.literal("error"),
      v.literal("rejected"),
    ),
    steps: v.optional(v.number()),
    toolCalls: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    usage: v.optional(
      v.object({
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
        totalTokens: v.optional(v.number()),
      }),
    ),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_started", ["startedAt"]),

  /** Subscription turns are queued for the owner's outbound local runner. */
  codexTurns: defineTable({
    runnerId: v.id("runners"),
    conversationId: v.id("conversations"),
    runId: v.id("runs"),
    mode: vMode,
    prompt: v.string(),
    history: v.optional(v.string()),
    instructions: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("error")),
    response: v.optional(v.string()),
    error: v.optional(v.string()),
    model: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    finalizedAt: v.optional(v.number()),
  })
    .index("by_runner_status", ["runnerId", "status"])
    .index("by_conversation_status", ["conversationId", "status"]),
});
