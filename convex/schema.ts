import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vChannel = v.union(v.literal("telegram"), v.literal("web"));
/** A file the owner sent on Telegram, before it is downloaded. */
export const vTelegramMedia = v.object({ fileId: v.string(), fileName: v.string(), contentType: v.string(), size: v.optional(v.number()) });
export const vMemoryKind = v.union(v.literal("profile"), v.literal("core"), v.literal("daily"));
/**
 * Tokens a run used, named after OpenTelemetry's gen_ai.usage.* attributes.
 * Cached input is part of input, and reasoning part of output.
 */
export const vUsage = v.object({
  inputTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
});
/** The Codex items a run's trace records. See runSpans. */
export const vSpanKind = v.union(
  v.literal("command"), v.literal("fileChange"), v.literal("mcpToolCall"), v.literal("dynamicToolCall"),
  v.literal("webSearch"), v.literal("imageGeneration"), v.literal("reasoning"),
);
export const vSpanStatus = v.union(v.literal("running"), v.literal("ok"), v.literal("error"), v.literal("declined"));
/** Where a memory came from: the owner, tool output such as a web page or email, or a scheduled job. */
export const vMemoryOrigin = v.union(v.literal("owner"), v.literal("tool"), v.literal("job"));
/** A file a Codex turn is given: on the runner's machine, or at a URL it fetches first. */
export const vTurnAttachment = v.object({
  url: v.optional(v.string()),
  localPath: v.optional(v.string()),
  fileName: v.string(),
  contentType: v.string(),
});
/** How a runner decides what needs the owner. See approvals.ts. */
export const vPolicy = v.union(v.literal("ask"), v.literal("review"), v.literal("trust"));
/**
 * How far a chat's Codex turns may reach. Supervised: Codex's workspace-write
 * sandbox, and anything beyond it asks through the runner's approvals. Full:
 * no sandbox, and Codex never asks.
 */
export const vAccess = v.union(v.literal("supervised"), v.literal("full"));
/** A Codex model as `model/list` reports it, with the reasoning efforts it takes. */
export const vCodexModel = v.object({
  id: v.string(),
  name: v.string(),
  isDefault: v.boolean(),
  /** Unset when reported by a runner from before thinking levels. */
  efforts: v.optional(v.array(v.string())),
  defaultEffort: v.optional(v.string()),
});

/**
 * Assistant is single-owner, so there is no users table. The owner is identified by
 * channel plus external id, checked against an env allowlist on every inbound
 * message. Everything below is scoped to that one owner.
 */
export default defineSchema({
  /**
   * Exactly one row, describing this install and who owns it.
   *
   * The owner used to be an environment variable, which meant claiming your own
   * Assistant took a trip back to a terminal. It lives here instead so the whole
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
    /** The owner's IANA timezone, reported by the dashboard. Jobs run on it. */
    timezone: v.optional(v.string()),
    /** False stops approval requests going to the owner on Telegram. Unset means on. */
    telegramApprovals: v.optional(v.boolean()),
    /** The access a new chat starts with. Unset means supervised. */
    defaultAccess: v.optional(vAccess),
    /**
     * Getting to know each other. A new install starts "pending" and opens on
     * the dashboard's welcome page; unset is an install from before, offered it
     * rather than sent to it.
     */
    onboarding: v.optional(v.union(v.literal("pending"), v.literal("done"), v.literal("skipped"))),
    createdAt: v.number(),
  }),

  /**
   * Who the owner is (USER.md) and who the assistant is (its name and
   * personality). Append-only: the newest row of a kind is current and the
   * older ones are its history, so any version can be restored. Written by
   * the welcome page, the About you page, the assistant when told something
   * lasting, and the nightly jobs.
   */
  persona: defineTable({
    kind: v.union(v.literal("user"), v.literal("identity")),
    /** USER.md, as Markdown. */
    text: v.optional(v.string()),
    /** The assistant's name and a line or two of personality. */
    name: v.optional(v.string()),
    personality: v.optional(v.string()),
    by: v.union(v.literal("owner"), v.literal("assistant"), v.literal("job")),
    createdAt: v.number(),
  }).index("by_kind", ["kind", "createdAt"]),

  /**
   * Work Assistant has been asked to do, borrowed from OpenMuse's task model.
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
    /** When the owner dismissed its failure from Needs you. */
    seenAt: v.optional(v.number()),
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
   * A recurring check on a public page. The cron ticks these, and Assistant only
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
    /** When the owner dismissed its last firing from Needs you. */
    seenAt: v.optional(v.number()),
    failures: v.number(),
    createdAt: v.number(),
  })
    .index("by_next_check", ["nextCheckAt"])
    .index("by_active", ["active"]),

  /**
   * A machine the owner has connected: their laptop, desktop or Mac.
   *
   * The runner dials out to Perry's server and holds an event stream; nothing
   * dials in to the runner. The one on Perry's own computer is connected by the
   * server as it starts; another machine reaches it over the owner's network
   * (say Tailscale) with a token made for it. Nothing has to be reachable from
   * the internet.
   */
  runners: defineTable({
    name: v.string(),
    token: v.string(),
    platform: v.optional(v.string()),
    hostname: v.optional(v.string()),
    workdir: v.optional(v.string()),
    /** Legacy: true meant nothing waited for the owner. `policy` replaces it and wins. */
    autoApprove: v.boolean(),
    /** ask: the owner decides; review: a Codex reviewer clears routine actions first; trust: run. */
    policy: v.optional(vPolicy),
    lastSeenAt: v.optional(v.number()),
    revoked: v.boolean(),
    /** Codex credentials stay in the CLI's local store on this runner. */
    codexAvailable: v.optional(v.boolean()),
    codexAuthMode: v.optional(v.string()),
    codexPlanType: v.optional(v.string()),
    codexError: v.optional(v.string()),
    codexUpdatedAt: v.optional(v.number()),
    /** What `model/list` returned on this runner, for the chat model picker. */
    codexModels: v.optional(v.array(vCodexModel)),
    codexRequestId: v.optional(v.number()),
    codexRequestKind: v.optional(v.union(v.literal("login"), v.literal("logout"))),
    codexRequestStatus: v.optional(v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("error"))),
    codexVerificationUrl: v.optional(v.string()),
    codexUserCode: v.optional(v.string()),
    codexRequestError: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  /**
   * Service keys, set from the dashboard instead of a terminal.
   *
   * Keys in .env.local need a terminal and a restart to change. These rows take
   * precedence over the matching variable there, so the dashboard can change
   * any of them while one set in .env.local keeps working.
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
   * One row per chat Assistant talks in. Holds the durable mode and the id of the
   * Agent component thread that carries the message history.
   */
  conversations: defineTable({
    channel: vChannel,
    externalId: v.string(), // telegram chat id, or a unique web session id
    threadId: v.string(),
    codexThreadId: v.optional(v.string()),
    codexRunnerId: v.optional(v.id("runners")),
    /** Codex model picked for this chat. Unset means the Codex default. */
    model: v.optional(v.string()),
    /** Reasoning effort picked for this chat (/think). Unset means the model's default. */
    effort: v.optional(v.string()),
    /** Set when the chat is created, from installation.defaultAccess. Unset means supervised. */
    access: v.optional(vAccess),
    title: v.optional(v.string()),
    /** Set on the chat where a scheduled job's results collect. */
    jobId: v.optional(v.id("jobs")),
    parentConversationId: v.optional(v.id("conversations")),
    branchedFromMessageId: v.optional(v.string()),
    pendingTurns: v.optional(v.number()),
    /** Digest of the recalled memory this chat's Codex thread last saw, so an unchanged block is not sent again. */
    recallDigest: v.optional(v.string()),
    /** What the assistant sent here on its own (a job, an alert) since the owner last wrote; the next turn is told. */
    unprompted: v.optional(v.array(v.object({ at: v.number(), text: v.string() }))),
    lastMessageAt: v.number(),
    /** Pinned to the top of the dashboard's chat list, since then. */
    pinnedAt: v.optional(v.number()),
    /** When the owner last had this chat open; a reply after it is unseen. */
    seenAt: v.optional(v.number()),
  })
    .index("by_channel_external", ["channel", "externalId"])
    .index("by_channel_last", ["channel", "lastMessageAt"]),

  /**
   * Files attached to a chat turn. The bytes live either in the server's file
   * storage (Telegram's files) or on the owner's machine at `localPath`, wherever the agent (or the upload
   * inbox) put them, and the Next.js server on that machine serves them from
   * there. See app/api/media.
   */
  chatAttachments: defineTable({
    conversationId: v.id("conversations"),
    messageKey: v.string(),
    storageId: v.optional(v.id("_storage")),
    /** Absolute path on the owner's machine. */
    localPath: v.optional(v.string()),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_message", ["conversationId", "messageKey"]),

  /**
   * Layered like OpenClaw's workspace memory. `profile` is USER.md: standing
   * preferences and relationships, written as directives. `core` is MEMORY.md:
   * durable facts and decisions. Both load into every turn. `daily` is
   * memory/YYYY-MM-DD.md: working notes, where today and yesterday load and
   * older days are reached through search. Rows written before the layers
   * existed have no kind and count as core.
   */
  memories: defineTable({
    text: v.string(),
    tags: v.array(v.string()),
    source: v.string(),
    createdAt: v.number(),
    kind: v.optional(vMemoryKind),
    /** YYYY-MM-DD, for daily notes. */
    day: v.optional(v.string()),
    /** Replaced facts stay for the record and drop out of context and search. */
    supersededBy: v.optional(v.id("memories")),
    /** Unset on memories from before provenance was recorded. */
    origin: v.optional(vMemoryOrigin),
    /** When the owner last changed its text on the Memory page. */
    editedAt: v.optional(v.number()),
  })
    .index("by_created", ["createdAt"])
    .index("by_kind", ["kind", "createdAt"])
    .index("by_day", ["day", "createdAt"])
    .searchIndex("search_text", { searchField: "text" }),

  /**
   * One row per agent turn: what came in, which model handled it, which tools
   * fired, what it cost, and how it ended. Debugging a chat bot without this is
   * guesswork.
   */
  runs: defineTable({
    conversationId: v.id("conversations"),
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
    usage: v.optional(vUsage),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_started", ["startedAt"]),

  /**
   * What Codex did inside a run, one row per item: a command, a file change,
   * a tool call, a web search, a stretch of reasoning. The runner reports them
   * as they start and finish, so a trace fills in while its run is going.
   * Shaped like OpenTelemetry's gen_ai tool spans: `callId` is
   * gen_ai.tool.call.id, and `input` and `output` hold the call's arguments
   * and result, cut to about 2 KB.
   */
  runSpans: defineTable({
    runId: v.id("runs"),
    kind: vSpanKind,
    name: v.string(),
    callId: v.string(),
    status: vSpanStatus,
    startedAt: v.number(),
    durationMs: v.optional(v.number()),
    input: v.optional(v.string()),
    output: v.optional(v.string()),
  }).index("by_run", ["runId", "callId"]),

  /** Scheduled prompts, run as Codex turns. See jobs.ts. */
  jobs: defineTable({
    name: v.string(),
    /** A cron expression in the owner's timezone. Absent for a one-time job. */
    schedule: v.optional(v.string()),
    /** When a one-time job runs. It runs once and is then paused. */
    runAt: v.optional(v.number()),
    prompt: v.string(),
    enabled: v.boolean(),
    builtin: v.optional(v.union(v.literal("heartbeat"), v.literal("daily-summary"), v.literal("consolidate"))),
    nextRunAt: v.number(),
    lastRunAt: v.optional(v.number()),
    lastResult: v.optional(v.string()),
    lastError: v.optional(v.string()),
    /** When the owner dismissed its last error from Needs you. */
    seenAt: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    createdAt: v.number(),
  }),

  /** What a runner asked the owner before acting on their machine. See approvals.ts. */
  approvals: defineTable({
    runnerId: v.id("runners"),
    conversationId: v.optional(v.id("conversations")),
    kind: v.union(v.literal("command"), v.literal("file"), v.literal("write")),
    title: v.string(),
    detail: v.optional(v.string()),
    cwd: v.optional(v.string()),
    /** Files a change touches, which file rules match on. */
    paths: v.optional(v.array(v.string())),
    /** What "Always allow" would remember for this request. Unset means it cannot be remembered. */
    alwaysAllow: v.optional(v.object({
      command: v.optional(v.string()),
      prefix: v.optional(v.boolean()),
      pathPrefix: v.optional(v.string()),
    })),
    /** "reviewing" while the runner's Codex reviewer looks at it; the owner is not asked yet. */
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("declined"), v.literal("expired"), v.literal("auto"), v.literal("reviewing")),
    decidedBy: v.optional(v.union(
      v.literal("terminal"), v.literal("dashboard"), v.literal("timeout"), v.literal("telegram"),
      v.literal("rule"), v.literal("reviewer"), v.literal("trust"),
    )),
    /** The rule that allowed it, or the rule an "Always allow" answer created. */
    ruleId: v.optional(v.id("approvalRules")),
    /** The automatic reviewer's verdict. "error" is a failure or timeout, which asks the owner. */
    review: v.optional(v.object({
      verdict: v.union(v.literal("clear"), v.literal("caution"), v.literal("error")),
      reason: v.string(),
      model: v.optional(v.string()),
      ms: v.optional(v.number()),
    })),
    /** The prompt sent to the owner on Telegram, edited to the outcome once settled. */
    telegramChatId: v.optional(v.string()),
    telegramMessageId: v.optional(v.number()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  }).index("by_status", ["status", "createdAt"]),

  /**
   * What the owner said to always allow on one runner: an exact command, or a
   * command prefix, within a folder; or file changes under a folder. Only a
   * yes is remembered. A decline is asked again next time.
   */
  approvalRules: defineTable({
    runnerId: v.id("runners"),
    kind: v.union(v.literal("command"), v.literal("file")),
    command: v.optional(v.string()),
    /** Matches commands that start with `command` and chain nothing after it. */
    prefix: v.optional(v.boolean()),
    cwd: v.optional(v.string()),
    pathPrefix: v.optional(v.string()),
    uses: v.number(),
    lastUsedAt: v.optional(v.number()),
    createdFrom: v.optional(v.id("approvals")),
    createdAt: v.number(),
  }).index("by_runner", ["runnerId"]),

  /** Subscription turns are queued for the owner's outbound local runner. */
  codexTurns: defineTable({
    /** Unset only on turns from before Perry ran on this computer, answered without a runner. */
    runnerId: v.optional(v.id("runners")),
    conversationId: v.id("conversations"),
    runId: v.id("runs"),
    /** A turn that compacts the chat's Codex thread (/compact) rather than answering a message. */
    kind: v.optional(v.literal("compact")),
    prompt: v.string(),
    history: v.optional(v.string()),
    instructions: v.string(),
    /**
     * Memory recalled for this turn, sent to Codex as data ahead of the prompt
     * rather than as instructions. Never saved to the chat.
     */
    recalled: v.optional(v.string()),
    /** Digest of the long-term and recent memory this turn carried; see conversations.recallDigest. */
    recallDigest: v.optional(v.string()),
    /** A memory flush before /reset: nothing is shown or saved, and finishing it starts the chat afresh. */
    flush: v.optional(v.boolean()),
    /** Its prompt is not the owner's (a greeting after the welcome page): only the reply is saved to the chat. */
    hidden: v.optional(v.boolean()),
    /** Codex model id to run this turn with. Unset means the Codex default. */
    requestedModel: v.optional(v.string()),
    /** Reasoning effort for turn/start. Unset leaves it to Codex, as before thinking levels. */
    requestedEffort: v.optional(v.string()),
    /** The chat's access when the turn was queued. Unset means supervised. */
    access: v.optional(vAccess),
    /** Codex's own id for the turn, recorded when it starts; a steer must name it. */
    codexTurnId: v.optional(v.string()),
    /** Attachment key for media the turn produced, such as generated images. */
    mediaKey: v.optional(v.string()),
    /** The owner asked to stop this turn; the runner interrupts Codex. */
    stopRequested: v.optional(v.boolean()),
    /** The turn ended because the owner stopped it. */
    stopped: v.optional(v.boolean()),
    /** Finalizing steps already done, so a retried finalize never repeats one. */
    reportedAt: v.optional(v.number()),
    savedAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    /** When a finalize last started, so the recovery sweep does not run a second one beside it. */
    finalizingAt: v.optional(v.number()),
    /** The reply so far, while Codex is still writing it. */
    partial: v.optional(v.string()),
    /** Telegram: the message that shows the reply as it streams, edited as it grows. */
    telegramMessageId: v.optional(v.number()),
    telegramEditedAt: v.optional(v.number()),
    telegramEditing: v.optional(v.boolean()),
    attachments: v.optional(v.array(vTurnAttachment)),
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

  /**
   * A message the owner sent while a reply was running. It joins that turn
   * through Codex's turn/steer; one that cannot (the turn ended, or Codex
   * refused) becomes an ordinary queued turn, so it keeps what a turn needs.
   */
  codexSteers: defineTable({
    /** The running turn it joins. */
    turnId: v.id("codexTurns"),
    runnerId: v.id("runners"),
    conversationId: v.id("conversations"),
    runId: v.id("runs"),
    prompt: v.string(),
    history: v.optional(v.string()),
    instructions: v.string(),
    requestedModel: v.optional(v.string()),
    requestedEffort: v.optional(v.string()),
    access: v.optional(vAccess),
    attachments: v.optional(v.array(vTurnAttachment)),
    /** Waiting for the runner, joined the turn, or turned into a queued turn of its own. */
    status: v.union(v.literal("pending"), v.literal("applied"), v.literal("queued")),
    /** Why Codex would not take it, when it was queued instead. */
    error: v.optional(v.string()),
    queuedTurnId: v.optional(v.id("codexTurns")),
    createdAt: v.number(),
    appliedAt: v.optional(v.number()),
  })
    .index("by_turn_status", ["turnId", "status"])
    .index("by_status", ["status"]),

  /**
   * A chat's message history (the conversation's `threadId`). Each channel's
   * chats share a userId ("web:dashboard", "telegram:<chat>"), which is what
   * search_chats searches within. See agentStore.ts.
   */
  agentThreads: defineTable({
    userId: v.optional(v.string()),
    title: v.optional(v.string()),
  }),

  agentMessages: defineTable({
    threadId: v.id("agentThreads"),
    userId: v.optional(v.string()),
    /** Position in the thread; later messages have higher numbers. */
    order: v.number(),
    message: v.object({ role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system"), v.literal("tool")), content: v.string() }),
    text: v.string(),
    /** Who wrote an assistant message when it was not Codex on the owner's computer. */
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
  })
    .index("by_thread_order", ["threadId", "order"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["userId"] }),
});
