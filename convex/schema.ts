import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Perry is single-tenant, so there is no users table. The owner is identified
 * by channel + external id, checked against an env allowlist on every inbound
 * message. Everything below is scoped to that one owner.
 */
export default defineSchema({
  /**
   * One row per chat Perry talks in. Holds the durable mode and the id of the
   * Agent component thread that carries the message history.
   */
  conversations: defineTable({
    channel: v.literal("telegram"),
    externalId: v.string(), // telegram chat id, as a string
    threadId: v.string(), // @convex-dev/agent thread
    mode: v.union(v.literal("perry"), v.literal("agentP")),
    title: v.optional(v.string()),
    lastMessageAt: v.number(),
  }).index("by_channel_external", ["channel", "externalId"]),

  /**
   * Durable facts, written only when the agent explicitly calls `remember`.
   * Full-text search for now. Swapping in @convex-dev/rag for embeddings is a
   * later step and does not change the tool surface.
   */
  memories: defineTable({
    text: v.string(),
    tags: v.array(v.string()),
    source: v.string(), // e.g. "telegram:12345"
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .searchIndex("search_text", { searchField: "text" }),

  /**
   * One row per agent turn. This is the audit log: what came in, which mode
   * handled it, which tools fired, what it cost, and how it ended. Debugging a
   * chat bot without this is guesswork.
   */
  runs: defineTable({
    conversationId: v.id("conversations"),
    mode: v.union(v.literal("perry"), v.literal("agentP")),
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
