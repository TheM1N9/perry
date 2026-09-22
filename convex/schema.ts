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
   * One row per chat Perry talks in. Holds the durable mode and the id of the
   * Agent component thread that carries the message history.
   */
  conversations: defineTable({
    channel: vChannel,
    externalId: v.string(), // telegram chat id, or "dashboard" for the web chat
    threadId: v.string(),
    mode: vMode,
    title: v.optional(v.string()),
    lastMessageAt: v.number(),
  }).index("by_channel_external", ["channel", "externalId"]),

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
});
