import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vChannel = v.union(v.literal("telegram"), v.literal("web"), v.literal("whatsapp"));
/** The messaging apps the owner can pair; the web dashboard is always there. */
export const vMessenger = v.union(v.literal("telegram"), v.literal("whatsapp"));
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
/** The engine items a run's trace records (runner/trace.ts maps each engine's canonical items to these). See runSpans. */
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
/**
 * An event that starts a job (jobs.ts, server/triggers.ts): one Composio sends
 * from a connected app (a new email, a pull request), by the trigger instance
 * made for it; or a new file in a folder on this computer. `label` says it as
 * the owner would: "When a new Gmail message arrives".
 */
export const vTrigger = v.union(
  v.object({
    kind: v.literal("app"),
    toolkit: v.string(),
    slug: v.string(),
    config: v.optional(v.any()),
    /** Composio's trigger instance, which its events name. */
    instanceId: v.string(),
    label: v.string(),
  }),
  v.object({ kind: v.literal("folder"), path: v.string(), label: v.string() }),
);
/** How a runner decides what needs the owner. See approvals.ts. */
export const vPolicy = v.union(v.literal("ask"), v.literal("review"), v.literal("trust"));
/**
 * How far a chat's Codex turns may reach (lib/commands.ts, Access). Supervised
 * ("Ask"): Codex's workspace-write sandbox, and anything beyond it asks the
 * owner. Auto: no sandbox, with a Codex reviewer checking each command. Full:
 * no sandbox, and Codex never asks.
 */
export const vAccess = v.union(v.literal("supervised"), v.literal("auto"), v.literal("full"));
/** Who asked Perry to update himself: the owner, with a click, or the night (updates.ts). */
export const vUpdateBy = v.union(v.literal("owner"), v.literal("nightly"));
/** A Codex model as `model/list` reports it, with the reasoning efforts it takes. Every engine reports its models this way. */
export const vCodexModel = v.object({
  id: v.string(),
  name: v.string(),
  isDefault: v.boolean(),
  /** Unset when reported by a runner from before thinking levels. */
  efforts: v.optional(v.array(v.string())),
  defaultEffort: v.optional(v.string()),
});
/** The engine a chat, turn or job runs on (lib/engines.ts). Unset is Codex, as everything from before engines. */
export const vEngine = v.union(v.literal("codex"), v.literal("claude"), v.literal("grok"), v.literal("cursor"), v.literal("antigravity"));
/** What the owner does to finish signing an engine in (lib/engines.ts, LoginInteraction). */
export const vLoginInteraction = v.union(
  v.object({ type: v.literal("browser"), url: v.string() }),
  v.object({ type: v.literal("deviceCode"), verificationUrl: v.string(), userCode: v.string() }),
  v.object({ type: v.literal("terminal"), command: v.string() }),
  v.object({ type: v.literal("credentials"), message: v.string() }),
);
/**
 * One engine on a runner, as its side-effect-free probe found it
 * (runner/engine.ts, EngineStatus). Only account metadata: the engine's
 * credentials stay in its own CLI on that computer.
 */
export const vEngineStatus = v.object({
  kind: vEngine,
  installed: v.boolean(),
  version: v.optional(v.string()),
  signedIn: v.boolean(),
  auth: v.object({ type: v.optional(v.string()), label: v.optional(v.string()), email: v.optional(v.string()), plan: v.optional(v.string()) }),
  models: v.array(vCodexModel),
  /** What to do next, such as "Run `grok login` on this computer". */
  message: v.optional(v.string()),
  error: v.optional(v.string()),
});
/** A sign-in or sign-out the owner asked for from Settings, until the runner has done it. */
export const vEngineAuth = v.object({
  id: v.number(),
  kind: v.union(v.literal("login"), v.literal("logout")),
  /** Which way in, for an engine that has more than one (Antigravity: gemini-api-key or oauth-personal). */
  method: v.optional(v.string()),
  status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("error")),
  interaction: v.optional(vLoginInteraction),
  error: v.optional(v.string()),
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
    /** The owner on WhatsApp: their chat's JID, once linked and claimed (whatsapp.ts). */
    whatsappOwner: v.optional(v.string()),
    /** Where proactive messages go when both apps are paired. Unset: Telegram, then WhatsApp. */
    homeChannel: v.optional(vMessenger),
    /** The access a new chat starts with. Unset means supervised. */
    defaultAccess: v.optional(vAccess),
    /** When Perry's own messages wait instead of reaching the phone, as HH:MM in the owner's timezone (notify.ts). Unset: never. */
    quietHours: v.optional(v.object({ start: v.string(), end: v.string() })),
    /** How many of Perry's own messages may reach the phone in a day; the rest wait for tomorrow. Unset: no limit. */
    dailyLimit: v.optional(v.number()),
    /** False when the owner turned off Perry looking at the screen on his own (screen.ts). Unset: on. */
    screenLook: v.optional(v.boolean()),
    /** When the owner last wrote to Perry anywhere, so what goes unanswered can be told apart. */
    ownerWroteAt: v.optional(v.number()),
    /** False stops Perry updating himself at night (updates.ts). Unset means on. */
    autoUpdate: v.optional(v.boolean()),
    /** False when the owner turned off waking the computer for jobs and reminders (wake.ts). Unset: on. */
    wake: v.optional(v.boolean()),
    /** The wake timer the server last set, or why it could not, and whether it is keeping the computer awake (server/wake.ts). */
    wakeState: v.optional(v.object({
      at: v.optional(v.number()),
      what: v.optional(v.string()),
      error: v.optional(v.string()),
      awake: v.optional(v.boolean()),
      checkedAt: v.number(),
    })),
    /** Keyboard shortcuts the owner changed, by id (lib/shortcuts.ts), as Electron accelerators. The rest are the defaults. */
    shortcuts: v.optional(v.record(v.string(), v.string())),
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
    /** Where it was asked for: its question and result go back there (tasks.ts). Unset: the owner's messaging app. */
    origin: v.optional(v.id("conversations")),
    /** The chat a background task works in, a turn at a time. Unset for a task only tracked in a chat (start_task). */
    conversationId: v.optional(v.id("conversations")),
    /** Turns it has taken, against tasks.MAX_TURNS. */
    turns: v.optional(v.number()),
    /** The owner's answer to its question, for its next turn. */
    answer: v.optional(v.string()),
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
   * The owner's own to-do list: things they mean to do, where tasks are work
   * Perry does. The desktop pet shows it and speaks up as each comes due; away
   * from the computer, the reminder goes to their messaging app. See todos.ts.
   */
  todos: defineTable({
    title: v.string(),
    /** When it is due. Unset: some time, with no reminder. */
    dueAt: v.optional(v.number()),
    /** A cron schedule in the owner's timezone; ticking it off makes the next one. */
    repeat: v.optional(v.string()),
    doneAt: v.optional(v.number()),
    by: v.union(v.literal("owner"), v.literal("assistant")),
    /** Reminders sent to the owner's phone for this due time, and when the next one is. */
    nagged: v.optional(v.number()),
    nextNagAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_done", ["doneAt"])
    .index("by_next_nag", ["nextNagAt"]),

  /**
   * Perry asking the desktop pet for a picture of the screen during a chat
   * (screen.ts): asked, then done with where the pet saved it, or failed.
   * With pets on several computers, the one the owner was last at is asked.
   */
  screenLooks: defineTable({
    conversationId: v.id("conversations"),
    which: v.union(v.literal("window"), v.literal("screen")),
    why: v.string(),
    status: v.union(v.literal("asked"), v.literal("done"), v.literal("failed")),
    path: v.optional(v.string()),
    name: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    /** The pet asked: one on another computer, or none for the one on Perry's own. */
    device: v.optional(v.id("petDevices")),
  }).index("by_status", ["status", "createdAt"]),

  /**
   * A row per desktop pet: when it last checked in, and when the owner last
   * touched the computer it runs on. While they are at any of them,
   * reminders are the pets' to give; otherwise they go to the phone. `device`
   * is a pet on another computer; the one on Perry's own computer has none.
   */
  petPresence: defineTable({
    device: v.optional(v.id("petDevices")),
    seenAt: v.number(),
    activeAt: v.number(),
    /** The Talk hotkey the pet holds, or why it could not take the one asked for (another app has it). */
    hotkey: v.optional(v.string()),
    hotkeyError: v.optional(v.string()),
    /** The same for his other global shortcuts, by shortcut id (convex/lib/shortcuts.ts): Look. */
    keys: v.optional(v.record(v.string(), v.object({ hotkey: v.optional(v.string()), error: v.optional(v.string()) }))),
  }),

  /**
   * A desktop pet on another of the owner's computers, paired from Settings →
   * Desktop pet (pet.ts). It calls Perry with a key of its own, made for it as
   * it paired, which opens only what the pet's page does (server/devices.ts);
   * removing the computer here is what takes that away. Only the key's hash
   * is kept: the key itself is on that computer alone.
   */
  petDevices: defineTable({
    name: v.string(),
    platform: v.optional(v.string()),
    keyHash: v.string(),
    pairedAt: v.number(),
  }).index("by_key_hash", ["keyHash"]),

  /**
   * One row: the pairing code last made in Settings → Desktop pet, good once
   * and for a few minutes (pet.ts). Only its hash is kept; too many wrong
   * codes tried while it is open close it.
   */
  petPairing: defineTable({
    codeHash: v.string(),
    expiresAt: v.number(),
    misses: v.number(),
  }),

  /**
   * One row: the pet being turned on or off from the dashboard (pet.ts), the
   * step it is on, and how it ended.
   */
  petSetup: defineTable({
    action: v.union(v.literal("on"), v.literal("off")),
    state: v.union(v.literal("working"), v.literal("failed"), v.literal("done")),
    step: v.optional(v.string()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }),

  /**
   * One row: Perry keeping himself up to date (updates.ts). What the last
   * check of his checkout found, an update asked for and not done yet, and
   * how the last one went, as `perry run`, which does them, reported it.
   */
  updates: defineTable({
    checkedAt: v.optional(v.number()),
    head: v.optional(v.string()),
    behind: v.optional(v.number()),
    latest: v.optional(v.object({ sha: v.string(), title: v.string() })),
    /** Why no update can be offered (changes of the owner's, no network, not a git checkout). */
    problem: v.optional(v.string()),
    /** The owner asked while Perry was busy: he updates once he isn't. */
    wantedAt: v.optional(v.number()),
    /** Handed to `perry run` (update-request.json), which stops the dashboard's server to do it. */
    requested: v.optional(v.object({ id: v.string(), at: v.number(), by: vUpdateBy })),
    /** The owner's day the night's update was last asked for, so it is asked once a night. */
    nightOf: v.optional(v.string()),
    last: v.optional(v.object({
      id: v.string(),
      by: vUpdateBy,
      at: v.number(),
      ok: v.boolean(),
      from: v.optional(v.string()),
      to: v.optional(v.string()),
      title: v.optional(v.string()),
      error: v.optional(v.string()),
      log: v.optional(v.string()),
    })),
  }),

  /**
   * One row: the page of the dashboard the pet last asked to open (pet.ts),
   * for a dashboard tab already open to take, or the pet to open itself.
   */
  petOpen: defineTable({
    request: v.string(),
    path: v.string(),
    at: v.number(),
    claimedAt: v.optional(v.number()),
  }),

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
    /** The chat it was set up in, where it reports (channels.ts). Unset: the owner's messaging channel. */
    origin: v.optional(v.id("conversations")),
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
    /** Whether a contains or price watch's condition held at the last check, so it fires when it starts holding, not on every check. */
    met: v.optional(v.boolean()),
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
    /** Each engine on this computer, as its runner last reported it (engines.ts). */
    engines: v.optional(v.array(v.object({ ...vEngineStatus.fields, updatedAt: v.number() }))),
    /** Sign-ins and sign-outs asked for from Settings, by engine. */
    engineAuth: v.optional(v.record(v.string(), vEngineAuth)),
    /**
     * Codex's state from before engines. Still written from Codex's entry in
     * `engines`, and read when a runner from before engines reports only these.
     * Codex credentials stay in the CLI's local store on this runner.
     */
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
   * The owner's own logins and secrets, for Perry to sign in to websites with
   * computer use. Kept here rather than in memory, which loads into every turn:
   * a value reaches a turn only when the agent asks for it with use_secret.
   * See vault.ts.
   */
  vault: defineTable({
    /** What it is for, as the owner would say it: "Netflix", "Wi-Fi". */
    label: v.string(),
    /** The site's address, so the agent enters it only there. */
    url: v.optional(v.string()),
    username: v.optional(v.string()),
    value: v.string(),
    note: v.optional(v.string()),
    /** Who saved it: the owner on the Keys page, or the agent from a chat. */
    by: v.union(v.literal("owner"), v.literal("assistant")),
    updatedAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  }),

  /**
   * One row per chat Assistant talks in. Holds the durable mode and the id of the
   * Agent component thread that carries the message history.
   */
  /**
   * The people and groups Perry may talk with besides the owner, on Telegram and WhatsApp
   * (contacts.ts), and the ones it knows of: WhatsApp's address book and groups, and whoever wrote.
   * Nobody is talked to until the owner allows them, once.
   */
  contacts: defineTable({
    channel: v.union(v.literal("telegram"), v.literal("whatsapp")),
    /** The chat: a WhatsApp jid (person or group) or a Telegram chat id. */
    externalId: v.string(),
    kind: v.union(v.literal("person"), v.literal("group")),
    name: v.string(),
    /** How they are told apart, whatever name they give: a phone number, or a Telegram @username and id. */
    handle: v.optional(v.string()),
    /**
     * known: in the address book, never talked with. pending: asked the owner. allowed: Perry talks
     * with them. blocked: the owner said no; nothing they send reaches Perry.
     */
    status: v.union(v.literal("known"), v.literal("pending"), v.literal("allowed"), v.literal("blocked")),
    /** What the owner lets Perry know and share with them, in the owner's words. Nothing else of the owner's is. */
    brief: v.optional(v.string()),
    /** Messages that came while the owner was asked, answered once they allow it. */
    waiting: v.optional(v.array(v.object({ text: v.string(), from: v.string(), at: v.number() }))),
    /** When a chat with them last passed something on to the owner (tell_owner), for a limit per hour. */
    told: v.optional(v.array(v.number())),
    /** A group's latest messages, for context when Perry is mentioned there. */
    recent: v.optional(v.array(v.object({ text: v.string(), from: v.string(), at: v.number() }))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_channel_external", ["channel", "externalId"])
    .index("by_status", ["status", "updatedAt"]),

  conversations: defineTable({
    channel: vChannel,
    externalId: v.string(), // telegram chat id, or a unique web session id
    threadId: v.string(),
    /** The engine this chat's turns run on. Unset is Codex. Picking another engine's model changes it. */
    engine: v.optional(vEngine),
    /**
     * Where the chat's engine session resumes: an opaque cursor its engine
     * made (for Codex, the thread id), versioned by that engine. Unset, the
     * next turn starts a session seeded with the chat's history.
     */
    resume: v.optional(v.object({ engine: vEngine, cursor: v.string(), version: v.number() })),
    /** Codex's thread, from before `resume`; still written for Codex chats, and read when `resume` is unset. */
    codexThreadId: v.optional(v.string()),
    /** The runner (computer) this chat's turns run on; its engine sessions are on that disk. */
    codexRunnerId: v.optional(v.id("runners")),
    /** The model picked for this chat, one of its engine's. Unset means the engine's default. */
    model: v.optional(v.string()),
    /** Reasoning effort picked for this chat (/think). Unset means the model's default. */
    effort: v.optional(v.string()),
    /** Set when the chat is created, from installation.defaultAccess. Unset means supervised. */
    access: v.optional(vAccess),
    title: v.optional(v.string()),
    /** Set on the chat where a scheduled job's results collect. */
    jobId: v.optional(v.id("jobs")),
    /** Set on the chat a background task works in (tasks.ts). */
    taskId: v.optional(v.id("tasks")),
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
    /** How full its Codex thread's context was after its last turn, 0 to 1, as the runner reported. */
    contextFill: v.optional(v.number()),
    /** When memory was last checkpointed because the context filled up; cleared when Codex compacts it. */
    checkpointedAt: v.optional(v.number()),
    /** A project chat: what Perry remembers here stays here, out of every other chat (memories.conversationId). */
    project: v.optional(v.boolean()),
    /**
     * A chat with someone other than the owner (a person or a group, contacts.ts): sealed off from
     * everything of the owner's, with its own memory and no computer, keys or accounts.
     */
    contactId: v.optional(v.id("contacts")),
    /**
     * Web messages sent and not yet in the chat's history: from sendChat until
     * the turn is queued (codex.enqueueTurn), or kept in the history when it
     * cannot be (brain.handleTurn). The history only gets them when the reply
     * is saved, so without this a message vanishes on reload until then.
     */
    outbox: v.optional(v.array(v.object({ text: v.string(), at: v.number() }))),
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
    /** The one chat it belongs to (a project chat's own memory), out of every other chat. Unset: everywhere. */
    conversationId: v.optional(v.id("conversations")),
    /** Its meaning as a vector, for search by meaning (lib/embed.ts): base64 float32, and the model that made it. */
    vector: v.optional(v.string()),
    vectorModel: v.optional(v.string()),
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
    /** What starts it instead of a time: an event in a connected app, or a file landing in a folder (triggers.ts). */
    trigger: v.optional(vTrigger),
    prompt: v.string(),
    enabled: v.boolean(),
    builtin: v.optional(v.union(v.literal("heartbeat"), v.literal("daily-summary"), v.literal("consolidate"))),
    /** The model its runs use, picked on the Work page. Unset means the account's default. */
    model: v.optional(v.string()),
    /** The engine `model` is one of. Unset is Codex. */
    engine: v.optional(vEngine),
    /** The chat it was set up in, where its results go (channels.ts). Unset: the owner's messaging channel. */
    origin: v.optional(v.id("conversations")),
    nextRunAt: v.number(),
    lastRunAt: v.optional(v.number()),
    lastResult: v.optional(v.string()),
    lastError: v.optional(v.string()),
    /** When the owner dismissed its last error from Needs you. */
    seenAt: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    createdAt: v.number(),
  }),

  /**
   * Which account a Composio connection is signed in to (an email, a handle),
   * asked of the service once through a read-only "who am I" action, since
   * Composio does not keep it. See composio.accounts.
   */
  connectorAccounts: defineTable({
    /** Composio's connected account id. */
    accountId: v.string(),
    toolkit: v.string(),
    /** Unset when the service would not say; asked again after a day. */
    identity: v.optional(v.string()),
    checkedAt: v.number(),
  }).index("by_account", ["accountId"]),

  /**
   * The WhatsApp link, one row: which way the owner chose (their own number,
   * talking in "Message yourself", or a separate number for Perry), and what
   * the server's connection is doing, for the dashboard to show. See
   * whatsapp.ts and server/whatsapp.ts.
   */
  whatsappLink: defineTable({
    mode: v.union(v.literal("self"), v.literal("separate")),
    /** The owner asked to be linked (or is); false once unlinked. */
    wanted: v.boolean(),
    /** Link with a code typed on the phone instead of a QR: the phone's number, digits only. */
    phone: v.optional(v.string()),
    status: v.union(v.literal("starting"), v.literal("qr"), v.literal("code"), v.literal("connected"), v.literal("disconnected"), v.literal("logged-out"), v.literal("expired"), v.literal("off")),
    /** A QR to scan, as a PNG data URL, or an 8-character code to type, while linking. */
    qr: v.optional(v.string()),
    code: v.optional(v.string()),
    /** The linked account's own JID once connected. */
    me: v.optional(v.string()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  /**
   * What Perry said on his own (notify.ts): a job's result, a watch firing, a
   * reminder, an offer to pause something ignored. Kept so the rules for
   * unprompted messages can be kept: one that must wait (quiet hours, the
   * day's limit) is here with no sentAt until it goes, grouped with the rest.
   */
  sent: defineTable({
    from: v.union(v.literal("job"), v.literal("watch"), v.literal("reminder"), v.literal("offer"), v.literal("other")),
    /** The job or watch it came from; an offer names what it offers to pause. */
    fromId: v.optional(v.string()),
    name: v.optional(v.string()),
    text: v.string(),
    /** Where it goes, as deliver was told: the chat it came from, or unset for the owner's messaging app. */
    origin: v.optional(v.id("conversations")),
    /** Where it went: a messaging app or a web chat. Only a messaging app is held back. */
    channel: v.union(v.literal("web"), v.literal("telegram"), v.literal("whatsapp")),
    buttons: v.optional(v.array(v.array(v.object({ text: v.string(), data: v.string() })))),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    /** Why it waited. */
    heldFor: v.optional(v.union(v.literal("quiet"), v.literal("limit"))),
  })
    .index("by_sent", ["sentAt"])
    .index("by_from", ["fromId", "createdAt"]),

  /**
   * What is waiting to go out on WhatsApp. The connection lives in the server
   * process (server/whatsapp.ts), which sends these in order as they appear,
   * so a reply written while it reconnects goes when it is back.
   */
  whatsappOutbox: defineTable({
    to: v.string(),
    kind: v.union(v.literal("text"), v.literal("typing"), v.literal("file")),
    text: v.optional(v.string()),
    /** A file to send: in Perry's storage, or on this machine. */
    file: v.optional(v.object({ storageId: v.optional(v.string()), localPath: v.optional(v.string()), fileName: v.string(), contentType: v.string() })),
    state: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    attempts: v.number(),
    error: v.optional(v.string()),
  }).index("by_state", ["state", "createdAt"]),

  /** What a runner asked the owner before acting on their machine. See approvals.ts. */
  approvals: defineTable({
    runnerId: v.id("runners"),
    conversationId: v.optional(v.id("conversations")),
    /**
     * "browser": a step in Perry's own browser that buys, sends or posts (lib/browser.ts, tools.ts).
     * "contact": someone new wrote to Perry, or added it to a group; "message": Perry wants to write to
     * someone for the first time (contacts.ts). Allowing either lets Perry talk with them from then on.
     */
    kind: v.union(v.literal("command"), v.literal("file"), v.literal("write"), v.literal("browser"), v.literal("contact"), v.literal("message")),
    /** For "contact" and "message": who. */
    contactId: v.optional(v.id("contacts")),
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
      v.literal("terminal"), v.literal("dashboard"), v.literal("timeout"), v.literal("telegram"), v.literal("whatsapp"),
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
    /** The WhatsApp chat it was asked in, answered by replying 1, 2 or 3. */
    whatsappChatId: v.optional(v.string()),
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
    /** The engine it runs on. Unset is Codex. The table keeps its name from before engines. */
    engine: v.optional(vEngine),
    /** A turn that compacts the chat's engine session (/compact) rather than answering a message. */
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
    /** A memory checkpoint (brain.checkpoint): nothing is shown or saved, and the chat goes on. */
    checkpoint: v.optional(v.boolean()),
    /** Its prompt is not the owner's (a greeting after the welcome page): only the reply is saved to the chat. */
    hidden: v.optional(v.boolean()),
    /** In a chat with someone other than the owner: the runner gives the engine no shell, files or computer, only Perry's guest tools. */
    guest: v.optional(v.boolean()),
    /** The engine's model id to run this turn with. Unset means the engine's default. */
    requestedModel: v.optional(v.string()),
    /** Reasoning effort for the turn. Unset leaves it to the engine, as before thinking levels. */
    requestedEffort: v.optional(v.string()),
    /** The chat's access when the turn was queued. Unset means supervised. */
    access: v.optional(vAccess),
    /** The engine's own id for the turn, recorded when it starts; a steer must name it. */
    codexTurnId: v.optional(v.string()),
    /**
     * When the turn first read something from outside (a web page, an app's
     * data, a web search), which may carry instructions of its own. From then
     * on it may not act outward without the owner's go-ahead (mcp.ts).
     */
    outsideAt: v.optional(v.number()),
    /** The memories the reply said it relied on (its last line, taken off; memories.MEMORY_LINE). */
    memoryIds: v.optional(v.array(v.id("memories"))),
    /** Attachment key for media the turn produced, such as generated images. */
    mediaKey: v.optional(v.string()),
    /** The owner asked to stop this turn; the runner interrupts its engine. */
    stopRequested: v.optional(v.boolean()),
    /**
     * The agent asked for longer (take_longer, mcp.ts): until then the
     * runner's watchdog lets the turn run on, however quiet or long.
     */
    patienceUntil: v.optional(v.number()),
    patienceWhy: v.optional(v.string()),
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
    /** The engine of that turn. Unset is Codex. */
    engine: v.optional(vEngine),
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
   * A web chat waiting for a name. Its first message titles it at once; any
   * runner then asks a quick Codex model for a short name (runner/title.ts)
   * and replaces that, unless the owner renamed the chat first. See titles.ts.
   */
  chatTitles: defineTable({
    conversationId: v.id("conversations"),
    /** The first message, which the name is made from. */
    text: v.string(),
    /** The title the chat was given when the message was sent; a different one means the owner renamed it. */
    provisional: v.string(),
    requestedAt: v.number(),
    /** A runner is naming it; another may take it over once this is old. */
    claimedAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"]),

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
