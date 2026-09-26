import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";

/**
 * Where the assistant speaks. One rule, as messaging-native assistants have it
 * (Instinct; OpenInstinct's channels): it answers in the conversation you are
 * in, and what it does in the background reports back to the conversation it
 * was set up in. Talking on the web, nothing reaches Telegram; talking on
 * Telegram, the answer and anything it needs from you are there.
 *
 * What has no conversation of its own (the heartbeat, the built-in jobs, a job
 * or watch set up before this rule) goes to the owner's messaging channel, the
 * one they paired: Telegram now, WhatsApp when it comes. A web-only owner
 * reads it on the dashboard.
 *
 * A channel is added here: a target kind, where replies to it go, and how it
 * is named to the assistant (describe).
 */

export type Target =
  | { channel: "telegram"; externalId: string; conversationId?: Id<"conversations"> }
  | { channel: "web"; conversationId: Id<"conversations"> };

async function install(ctx: QueryCtx): Promise<Doc<"installation"> | null> {
  return await ctx.db.query("installation").first();
}

/** The owner's messaging channel: the one they paired, when there is one. */
async function home(ctx: QueryCtx): Promise<Target | null> {
  const owner = await install(ctx);
  if (owner?.claimedAt && owner.ownerChannel === "telegram" && owner.ownerExternalId) {
    return { channel: "telegram", externalId: owner.ownerExternalId };
  }
  return null;
}

/**
 * Where something from this conversation goes. A job's chat is not one the
 * owner talks in: it reports where the job was set up, and a job with no such
 * chat reports to the messaging channel.
 */
export async function targetOf(ctx: QueryCtx, conversationId?: Id<"conversations">): Promise<Target | null> {
  let chat = conversationId ? await ctx.db.get(conversationId) : null;
  // A job set up by another job reports where that one does; three steps is plenty.
  for (let hops = 0; chat?.jobId && hops < 3; hops++) {
    const job: Doc<"jobs"> | null = await ctx.db.get(chat.jobId);
    chat = job?.origin ? await ctx.db.get(job.origin) : null;
  }
  if (!chat) return await home(ctx);
  if (chat.channel === "telegram") return { channel: "telegram", externalId: chat.externalId, conversationId: chat._id };
  return { channel: "web", conversationId: chat._id };
}

export const target = internalQuery({
  args: { conversationId: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<Target | null> => await targetOf(ctx, args.conversationId),
});

const TELEGRAM_STYLE = "Write for a phone: short paragraphs, a line starting with • for each point, no tables or headings, links bare on their own line.";

/**
 * What the assistant is told about where it is, each turn: which channel this
 * conversation is on, where its reply goes, and where what it sets up will
 * report. The owner's memory and USER.md are the same everywhere; each
 * conversation's history is its own, and search_chats reaches the others.
 */
export const describe = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<string> => {
    const chat = await ctx.db.get(args.conversationId);
    if (!chat) return "";
    const owner = await install(ctx);
    const telegram = owner?.claimedAt && owner.ownerChannel === "telegram";
    const elsewhere = "Memory and USER.md are the same on every channel; each conversation keeps its own history, and search_chats and read_chat reach the others.";
    if (chat.jobId) {
      const to = await targetOf(ctx, chat._id);
      const where = to?.channel === "telegram" ? "on Telegram" : to ? "in the web chat it was set up in" : "on the dashboard";
      return `## Where you are\n\nThis is a scheduled job, not a conversation. What you reply is delivered to the owner ${where}, so it is the whole message they get.${to?.channel === "telegram" ? ` ${TELEGRAM_STYLE}` : ""} ${elsewhere}`;
    }
    if (chat.channel === "telegram") {
      return `## Where you are\n\nThis conversation is the owner's private Telegram chat with you. Your reply is sent here as a Telegram message, and anything you need from them (an approval, a question) reaches them here. ${TELEGRAM_STYLE} They also use you on the web dashboard. Jobs and page watches you set up in this chat report back here. ${elsewhere}`;
    }
    return `## Where you are\n\nThis conversation is on the web dashboard. Your reply appears only here: nothing from this chat is sent to ${telegram ? "Telegram" : "any other app"}, and anything you need from the owner is asked here. ${telegram ? "They have also paired Telegram, where you reach them when they are away: your own background checks (the heartbeat) go there, while jobs and page watches set up in this chat report back to this chat. " : "They have not paired a messaging app, so everything you send them waits here. "}${elsewhere}`;
  },
});
