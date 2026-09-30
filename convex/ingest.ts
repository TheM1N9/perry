import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ClaimResult } from "./installation";
import { getMe, parseUpdate, type TelegramUpdate } from "./lib/telegram";
import { callsBy } from "./contacts";
import { readPersona } from "./persona";
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
    // A tap on a to-do reminder's button: done, or pushed back. The mutation checks the tapper is the owner.
    if ("callbackId" in inbound && inbound.data.startsWith("td:")) {
      const answer: { note: string; card?: string } = await ctx.runMutation(internal.todos.answerFromTelegram, { senderId: inbound.senderId, data: inbound.data });
      await ctx.scheduler.runAfter(0, internal.approvals.acknowledgeTap, { callbackId: inbound.callbackId, note: answer.note });
      if (answer.card && inbound.chatId && inbound.messageId) {
        await ctx.scheduler.runAfter(0, internal.todos.settleCard, { chatId: inbound.chatId, messageId: inbound.messageId, text: answer.card });
      }
      return null;
    }
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
      name: inbound.name,
      media: inbound.media,
      ...(inbound.chatType ? { chatType: inbound.chatType } : {}),
      ...(inbound.username ? { username: inbound.username } : {}),
      ...(inbound.replyToId ? { replyToId: inbound.replyToId } : {}),
      ...(inbound.mentions ? { mentions: inbound.mentions } : {}),
    });
    return null;
  },
});

/** The bot, asked of Telegram once per process: in a group, "@its_name" or a reply to it is for Perry. */
let bot: { id: string; username?: string } | null = null;

/**
 * A message from anyone but the owner's own chat with Perry: someone's direct
 * message to the bot, or a group it is in (the owner's messages there too).
 * Whether it is for Perry: a direct message always is; in a group, a mention,
 * a reply to the bot, or Perry's name. contacts.ts does the rest.
 */
export const receiveOther = internalAction({
  args: {
    chatId: v.string(), senderId: v.string(), text: v.string(), title: v.optional(v.string()), name: v.optional(v.string()),
    chatType: v.optional(v.string()), username: v.optional(v.string()), replyToId: v.optional(v.string()), mentions: v.optional(v.array(v.string())),
    hasMedia: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.chatType === "channel") return null;
    if (!bot) {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      const me = await getMe(token).catch(() => null);
      if (me) bot = { id: String(me.id), username: me.username?.toLowerCase() };
    }
    const facts: { name: string; owner?: string } = await ctx.runQuery(internal.ingest.otherFacts, {});
    const group = args.chatType === "group" || args.chatType === "supergroup";
    const addressed = !group || callsBy(facts.name, args.text)
      || Boolean(bot?.username && args.mentions?.includes(bot.username))
      || Boolean(bot && args.replyToId === bot.id);
    const handle = `${args.username ? `@${args.username} · ` : ""}id ${args.senderId}`;
    await ctx.runAction(internal.contacts.inbound, {
      channel: "telegram", chatId: args.chatId, kind: group ? "group" : "person",
      ...(group && args.title ? { chatName: args.title } : {}),
      from: { handle, ...(args.name ? { name: args.name } : {}), ...(facts.owner && args.senderId === facts.owner ? { owner: true } : {}) },
      text: args.text || (args.hasMedia ? "(sent a file, which you cannot open here)" : ""),
      addressed,
    });
    return null;
  },
});

export const otherFacts = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ name: string; owner?: string }> => {
    const install = await ctx.db.query("installation").first();
    return { name: (await readPersona(ctx)).name, owner: install?.ownerChannel === "telegram" ? install.ownerExternalId : undefined };
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
    name: v.optional(v.string()),
    media: v.optional(v.array(vTelegramMedia)),
    chatType: v.optional(v.string()),
    username: v.optional(v.string()),
    replyToId: v.optional(v.string()),
    mentions: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result: ClaimResult = await ctx.runMutation(
      internal.installation.authorize,
      {
        channel: "telegram",
        externalId: args.chatId,
        name: args.name ?? args.title,
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
        // Someone else's message, or a group's: never answered as the owner. Perry talks with them only once the
        // owner allows it (contacts.ts); until then a silent bot gives a stranger nothing to work with.
        await ctx.scheduler.runAfter(0, internal.ingest.receiveOther, {
          chatId: args.chatId, senderId: args.senderId, text: args.text, title: args.title, name: args.name,
          chatType: args.chatType, username: args.username, replyToId: args.replyToId, mentions: args.mentions,
          hasMedia: Boolean(args.media?.length),
        });
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
