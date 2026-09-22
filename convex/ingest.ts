import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/**
 * The front door for Telegram. Runs as a mutation so the HTTP action can return
 * 200 immediately; the actual turn is scheduled and runs on its own.
 *
 * This is also where authorisation happens, once, before anything else.
 */

function allowedChatIds(): string[] {
  return (process.env.TELEGRAM_OWNER_CHAT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const receive = internalMutation({
  args: {
    chatId: v.string(),
    senderId: v.string(),
    text: v.string(),
    title: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const allowed = allowedChatIds();

    // First-run convenience: with no owner configured, Perry will not think,
    // will not call a model, and will not remember. It only tells you the id
    // you need in order to claim it.
    if (allowed.length === 0) {
      await ctx.scheduler.runAfter(0, internal.brain.sendDirect, {
        chatId: args.chatId,
        text:
          `Not claimed yet. Your chat id is ${args.chatId}\n\n` +
          `Run this, then message me again:\n` +
          `npx convex env set TELEGRAM_OWNER_CHAT_ID ${args.chatId}`,
      });
      return null;
    }

    // Not the owner. Drop it on the floor without replying: a silent bot gives
    // a stranger nothing to work with.
    if (!allowed.includes(args.chatId) || !allowed.includes(args.senderId)) {
      console.warn(
        `dropped message from unauthorized chat=${args.chatId} sender=${args.senderId}`,
      );
      return null;
    }

    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: "telegram",
      externalId: args.chatId,
      text: args.text,
      title: args.title,
    });
    return null;
  },
});
