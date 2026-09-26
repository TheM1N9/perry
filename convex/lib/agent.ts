import type { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { MessagePage, StoredMessage } from "../agentStore";

/**
 * Chat history and tool definitions, called as the code called them when they
 * came from @convex-dev/agent, minus its component argument. The data is in
 * agentStore.ts.
 */

type Runner = Pick<ActionCtx, "runQuery"> & Partial<Pick<ActionCtx, "runMutation">>;
type Writer = Pick<ActionCtx, "runQuery" | "runMutation">;

export async function createThread(ctx: Writer, args: { userId?: string; title?: string }): Promise<string> {
  return await ctx.runMutation(internal.agentStore.createThread, args);
}

export async function listMessages(
  ctx: Runner,
  args: { threadId: string; excludeToolMessages?: boolean; paginationOpts: { numItems: number; cursor: string | null } },
): Promise<MessagePage> {
  return await ctx.runQuery(internal.agentStore.listMessages, {
    threadId: args.threadId,
    excludeToolMessages: args.excludeToolMessages,
    paginationOpts: { numItems: args.paginationOpts.numItems, cursor: args.paginationOpts.cursor ?? null },
  });
}

export async function saveMessages(
  ctx: Writer,
  args: {
    threadId: string;
    userId?: string;
    order?: "next";
    messages: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>;
    metadata?: Array<{ provider?: string; model?: string }>;
  },
) {
  return await ctx.runMutation(internal.agentStore.saveMessages, {
    threadId: args.threadId,
    userId: args.userId,
    messages: args.messages,
    metadata: args.metadata?.map((item) => ({ provider: item.provider, model: item.model })),
  });
}

export async function searchMessages(ctx: Runner, args: { userId: string; text: string; limit?: number }): Promise<StoredMessage[]> {
  return await ctx.runQuery(internal.agentStore.searchMessages, args);
}

export async function deleteThread(ctx: Writer, threadId: string): Promise<void> {
  await ctx.runMutation(internal.agentStore.deleteThread, { threadId });
}

export async function deleteMessages(ctx: Writer, messageIds: string[]): Promise<void> {
  await ctx.runMutation(internal.agentStore.deleteMessages, { messageIds });
}

/** What a tool's execute receives: the backend's context, plus who and which chat the call is for. */
/** conversationId: the chat the turn is in, so what a tool sets up can report back there. */
export type ToolCtx = ActionCtx & { userId?: string; threadId?: string; fromJob?: boolean; conversationId?: Id<"conversations"> };

/**
 * A tool the assistant can call: a description, a zod input schema and an
 * execute that receives the context the caller binds (see mcp.ts).
 */
export function createTool<Schema extends z.ZodType, Output>(definition: {
  description: string;
  inputSchema: Schema;
  execute: (ctx: ToolCtx, input: z.infer<Schema>, options: { toolCallId: string; messages: unknown[] }) => Promise<Output>;
}) {
  return {
    description: definition.description,
    inputSchema: definition.inputSchema,
    ctx: undefined as ToolCtx | undefined,
    execute(this: { ctx?: ToolCtx }, input: z.infer<Schema>, options: { toolCallId: string; messages: unknown[] }): Promise<Output> {
      if (!this.ctx) throw new Error("A tool runs with the context its caller binds.");
      return definition.execute(this.ctx, input, options);
    },
  };
}
