import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { ToolName } from "./modes";

/**
 * The full tool catalogue. Which of these a given turn can actually reach is
 * decided in modes.ts and enforced in agents.ts by simply not binding the rest.
 * A tool the model was never handed cannot be called.
 *
 * Every `execute` carries an explicit return type. Without one, TypeScript
 * chases tools.ts -> _generated/api -> tools.ts and gives up with an implicit
 * `any`. The annotations are what break that cycle, not decoration.
 */

type MemoryRow = {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
};

type RecallResult = {
  found: number;
  memories: Array<{
    id: string;
    text: string;
    tags: string[];
    rememberedOn: string;
  }>;
  note?: string;
};

type RememberResult = { id: string; stored: boolean; note: string };

type ForgetResult = { deleted: number; missing: string[] };

const recall = createTool({
  description:
    "Search your long-term memory about the owner. Use this before saying you " +
    "do not know something, and before asking a question you may already have " +
    "the answer to. An empty query returns the most recent memories.",
  inputSchema: z.object({
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
  execute: async (ctx, input): Promise<RecallResult> => {
    const results: MemoryRow[] = await ctx.runQuery(internal.memories.search, {
      query: input.query,
      limit: input.limit,
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
  inputSchema: z.object({
    text: z.string().min(3).describe("The fact, as one self-contained sentence."),
    tags: z
      .array(z.string())
      .optional()
      .describe("A few lowercase topic tags, e.g. ['work', 'travel']."),
  }),
  execute: async (ctx, input): Promise<RememberResult> => {
    const result: { id: string; duplicate: boolean } = await ctx.runMutation(
      internal.memories.add,
      {
        text: input.text,
        tags: input.tags ?? [],
        source: ctx.userId ?? "unknown",
      },
    );

    return {
      id: result.id,
      stored: !result.duplicate,
      note: result.duplicate
        ? "Already remembered, nothing to do."
        : "Stored.",
    };
  },
});

const forget = createTool({
  description:
    "Permanently delete memories by id. Ids come from `recall`. This cannot be " +
    "undone, so confirm with the owner in chat before calling it, and quote " +
    "back the exact text of what you are about to delete.",
  inputSchema: z.object({
    ids: z.array(z.string()).min(1).describe("Memory ids returned by recall."),
  }),
  execute: async (ctx, input): Promise<ForgetResult> => {
    const result: ForgetResult = await ctx.runMutation(
      internal.memories.removeMany,
      { ids: input.ids },
    );
    return result;
  },
});

export const ALL_TOOLS = { recall, remember, forget } satisfies Record<
  ToolName,
  unknown
>;
