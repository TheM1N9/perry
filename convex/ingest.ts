import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { ClaimResult } from "./installation";
import { vTelegramMedia } from "./schema";

/**
 * The front door for Telegram. Runs as a mutation so the HTTP action can return
 * 200 immediately; the actual turn is scheduled and runs on its own.
 *
 * Authorisation happens here, once, before anything else. Assistant belongs to
 * exactly one person and that is decided by the pairing code, not by an
 * environment variable and not by whoever messages first.
 */

const CLAIMED = `
Paired. I'm yours now.

To tell me about yourself, open the dashboard's welcome page, or just tell me here.

Try:
  remember that I drink coffee black
  what do you know about me
  /help for the rest
`.trim();

export const receive = internalMutation({
  args: {
    chatId: v.string(),
    senderId: v.string(),
    text: v.string(),
    title: v.optional(v.string()),
    media: v.optional(v.array(vTelegramMedia)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result: ClaimResult = await ctx.runMutation(
      internal.installation.authorize,
      {
        channel: "telegram",
        externalId: args.chatId,
        name: args.title,
        text: args.text,
      },
    );

    const reply = async (text: string) => {
      await ctx.scheduler.runAfter(0, internal.brain.sendDirect, {
        chatId: args.chatId,
        text,
      });
    };

    switch (result.outcome) {
      case "already-owner":
        break;

      case "claimed":
        await reply(CLAIMED);
        return null;

      case "needs-code":
        await reply(
          "Send me the six digit pairing code from your terminal.\n" +
            "Lost it? Run: pnpm run pair",
        );
        return null;

      case "bad-code":
        await reply("That code is wrong.");
        return null;

      case "expired":
        await reply("That code expired. Run `pnpm run pair` for a fresh one.");
        return null;

      case "not-owner":
        // Someone else's message. Drop it without replying: a silent bot gives
        // a stranger nothing to work with, and this one is already claimed.
        console.warn(`dropped message from non-owner chat=${args.chatId}`);
        return null;
    }

    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: "telegram",
      externalId: args.chatId,
      text: args.text,
      title: args.title,
      telegramMedia: args.media,
    });
    return null;
  },
});
