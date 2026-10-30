import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authenticate } from "./runner";
import { assertDashboardKey } from "./lib/auth";
import { appendStream, streamBody } from "./lib/turn-stream";
import { hide, savedValues } from "./vault";
import { REACTION_ONLY } from "./reactions";

export const append = mutation({
  args: { token: v.string(), id: v.id("codexTurns"), offset: v.number(), text: v.string(), reset: v.optional(v.boolean()), resetKey: v.optional(v.string()) },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const turn = await ctx.db.get(args.id);
    if (!turn || turn.runnerId !== runner._id || turn.status !== "running" || turn.finalizedAt !== undefined) return null;
    // Liveness is reported independently by runner.checkIn, never by each text flush.
    return appendStream(ctx, turn, args.offset, args.text, args.reset, args.resetKey);
  },
});

/** Subscribe separately from getChat; no body dependency is added to chat metadata. */
export const getChatStream = query({
  args: { key: v.string(), id: v.id("conversations") },
  handler: async (ctx, args): Promise<string | null> => {
    assertDashboardKey(args.key);
    if (!await ctx.db.get(args.id)) throw new Error("Chat not found.");
    const turn = await ctx.db.query("codexTurns")
      .withIndex("by_conversation_status", (q) => q.eq("conversationId", args.id).eq("status", "running")).first();
    if (!turn || turn.flush || turn.checkpoint || turn.kind === "compact") return null;
    const body = await streamBody(ctx, turn);
    if (body?.trim() && REACTION_ONLY.startsWith(body.trim())) return null;
    return body === undefined ? null : hide(body, await savedValues(ctx));
  },
});
