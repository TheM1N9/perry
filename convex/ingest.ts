import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import type { ClaimResult } from "./installation";
import { parseUpdate, type TelegramUpdate } from "./lib/telegram";
import { vTelegramMedia } from "./schema";

/**
 * One update from Telegram, as the server's long-polling loop fetched it
 * (server/telegram.ts). Anything that is not a message from a person or a tap
 * on an approval button is ignored.
 */
export const fromTelegram = internalAction({
  args: { update: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inbound = parseUpdate(args.update as TelegramUpdate);
    if (!inbound) return null;
    // A tap on an approval button. The mutation checks the tapper is the owner.
    if ("callbackId" in inbound) {
      const note: string = await ctx.runMutation(internal.approvals.answerFromTelegram, { senderId: inbound.senderId, data: inbound.data });
      await ctx.scheduler.runAfter(0, internal.approvals.acknowledgeTap, { callbackId: inbound.callbackId, note });
      return null;
    }
    await ctx.runMutation(internal.ingest.receive, {
      chatId: inbound.chatId,
      senderId: inbound.senderId,
      text: inbound.text,
      title: inbound.title,
      media: inbound.media,
    });
    return null;
  },
});

/**
 * The front door for Telegram. Runs as a mutation so the poller can move on
 * at once; the actual turn is scheduled and runs on its own.
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
