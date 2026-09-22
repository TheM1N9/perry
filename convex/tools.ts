import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { ToolName } from "./modes";

/**
 * The full tool catalogue. Which of these a given turn can actually reach is
 * decided in modes.ts, and enforced in agents.ts by simply not binding the
 * rest. A tool the model was never handed cannot be called.
 */

const recall = createTool({
  description:
    "Search your long-term memory about the owner. Use this before saying you " +
    "do not know something, and before asking a question you may already have " +
    "the answer to. An empty query returns the most recent memories.",
  args: z.object({
    query: z
      .string()
      .describe("Keywords to search for. Empty string returns recent memories."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("How many memories to return. Defaults to 8."),
  }),
  handler: async (ctx, args) => {
    const results = await ctx.runQuery(internal.memories.search, {
      query: args.query,
      limit: args.limit,
    });

    if (results.length === 0) {
      return { found: 0, memories: [], note: "No memories matched." };
    }

    return {
      found: results.length,
      memories: results.map((m) => ({
        id: m.id,
        text: m.text,
        tags: m.tags,
        rememberedOn: new Date(m.createdAt).toISOString().slice(0, 10),
      })),
    };
  },
});

const remember = createTool({
  description:
    "Store a durable fact about the owner: a preference, a relationship, a " +
    "recurring commitment, a decision they made. Write it as a standalone " +
    "sentence that will still make sense in six months, with no pronouns " +
    "referring to the current conversation. Do not store passing chatter, and " +
    "do not store secrets or credentials.",
  args: z.object({
    text: z
      .string()
      .min(3)
      .describe("The fact, as one self-contained sentence."),
    tags: z
      .array(z.string())
      .optional()
      .describe("A few lowercase topic tags, e.g. ['work', 'travel']."),
  }),
  handler: async (ctx, args) => {
    const { id, duplicate } = await ctx.runMutation(internal.memories.add, {
      text: args.text,
      tags: args.tags ?? [],
      source: ctx.userId ?? "unknown",
    });

    return duplicate
      ? { id, stored: false, note: "Already remembered, nothing to do." }
      : { id, stored: true };
  },
});

const forget = createTool({
  description:
    "Permanently delete memories by id. Ids come from `recall`. This cannot be " +
    "undone, so confirm with the owner in chat before calling it, and quote " +
    "back the exact text of what you are about to delete.",
  args: z.object({
    ids: z.array(z.string()).min(1).describe("Memory ids returned by recall."),
  }),
  handler: async (ctx, args) => {
    const { deleted, missing } = await ctx.runMutation(
      internal.memories.removeMany,
      { ids: args.ids },
    );
    return { deleted, missing };
  },
});

export const ALL_TOOLS = { recall, remember, forget } satisfies Record<
  ToolName,
  unknown
>;
