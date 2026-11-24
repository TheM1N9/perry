import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { vTelegramMedia } from "./schema";
import { PAUSED_OWNER } from "./lib/commands";

const QUIET_MS = 1_500;
const MAX_WAIT_MS = 7_500;
const MAX_MESSAGES = 20;
const MAX_CHARS = 32_000;
const vStoredMedia = v.array(v.object({ storageId: v.id("_storage"), fileName: v.string(), contentType: v.string(), size: v.number() }));
type Files = { telegramMedia?: Infer<typeof vTelegramMedia>[]; storedMedia?: Infer<typeof vStoredMedia>; outside?: boolean };

/** Stop and pause cancel pending input as well as turns already handed to the runner. */
export async function discardPending(ctx: MutationCtx, conversationId?: Id<"conversations">): Promise<number> {
  const rows = conversationId
    ? await ctx.db.query("phoneInbox").withIndex("by_conversation", q => q.eq("conversationId", conversationId)).collect()
    : await ctx.db.query("phoneInbox").collect();
  for (const row of rows) {
    if (row.scheduledId) await ctx.scheduler.cancel(row.scheduledId);
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

async function dispatch(ctx: MutationCtx, chat: Doc<"conversations">, text: string, title?: string, files: Files = {}) {
  const command = !files.outside && text.startsWith("/") && !files.telegramMedia?.length && !files.storedMedia?.length;
  let preparingId: Id<"codexTurns"> | undefined;
  if (!command && !(await ctx.db.query("installation").first())?.paused) {
    // Reserve queue order before recall or file downloads, using the web send's admission path.
    try {
      preparingId = await ctx.runMutation(internal.codex.prepareTurn, { conversationId: chat._id, prompt: text });
    } catch (error) {
      // Brain reports admission failures through the existing phone error path.
      console.error(`Phone input could not reserve a turn: ${String(error)}`);
    }
  }
  await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
    channel: chat.channel, externalId: chat.externalId, text, title, ...files,
    ...(preparingId ? { preparingId } : {}),
  });
}

export const receive = internalMutation({
  args: {
    channel: v.union(v.literal("telegram"), v.literal("whatsapp")),
    externalId: v.string(), text: v.string(), title: v.optional(v.string()),
    outside: v.optional(v.boolean()),
    messageId: v.optional(v.string()),
    telegramMedia: v.optional(v.array(vTelegramMedia)), storedMedia: v.optional(vStoredMedia),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const command = !args.outside && args.text.startsWith("/") && !args.telegramMedia?.length && !args.storedMedia?.length;
    if (!command && (await ctx.db.query("installation").first())?.paused) {
      if (args.channel === "telegram") await ctx.scheduler.runAfter(0, internal.brain.sendDirect, { chatId: args.externalId, text: PAUSED_OWNER });
      else await ctx.runMutation(internal.whatsapp.send, { to: args.externalId, text: PAUSED_OWNER });
      return null;
    }
    let chat = await ctx.db.query("conversations").withIndex("by_channel_external", q => q.eq("channel", args.channel).eq("externalId", args.externalId)).unique();
    if (!chat) {
      const threadId: string = await ctx.runMutation(internal.agentStore.createThread, { userId: `${args.channel}:${args.externalId}`, title: args.title });
      const id: Id<"conversations"> = await ctx.runMutation(internal.conversations.create, { channel: args.channel, externalId: args.externalId, threadId, title: args.title });
      chat = (await ctx.db.get(id))!;
    }
    const pending = await ctx.db.query("phoneInbox").withIndex("by_conversation", q => q.eq("conversationId", chat._id)).unique();
    if (command) {
      const name = args.text.split(/\s/, 1)[0].toLowerCase().split("@")[0];
      // Stop/pause own cancellation; other commands flush preceding words before changing the chat.
      if (pending && name !== "/stop" && name !== "/pause") await ctx.runMutation(internal.phoneInbox.flush, { id: pending._id, dueAt: pending.dueAt, now: true });
      await dispatch(ctx, chat, args.text, args.title);
      return null;
    }
    const parts = [...(pending?.parts ?? []), args.text];
    const messageIds = [...(pending?.messageIds ?? pending?.parts.map(() => "") ?? []), args.messageId ?? ""];
    const title = args.title ?? pending?.title;
    if (args.telegramMedia?.length || args.storedMedia?.length || parts.length >= MAX_MESSAGES || parts.join("\n").length >= MAX_CHARS) {
      if (pending) await discardPending(ctx, chat._id);
      await dispatch(ctx, chat, parts.filter(Boolean).join("\n"), title, { telegramMedia: args.telegramMedia, storedMedia: args.storedMedia, outside: args.outside || pending?.outside });
      return null;
    }
    const now = Date.now();
    const firstAt = pending?.firstAt ?? now;
    const dueAt = Math.min(now + QUIET_MS, firstAt + MAX_WAIT_MS);
    if (pending?.scheduledId) await ctx.scheduler.cancel(pending.scheduledId);
    // The scheduled mutation and the buffer commit together; replacing the timer bounds pending work.
    const id = pending?._id ?? await ctx.db.insert("phoneInbox", { conversationId: chat._id, parts, title, firstAt, dueAt });
    const scheduledId = await ctx.scheduler.runAt(dueAt, internal.phoneInbox.flush, { id, dueAt });
    await ctx.db.patch(id, { parts, messageIds, title, dueAt, scheduledId, outside: args.outside || pending?.outside });
    return null;
  },
});

export const editPending = internalMutation({
  args: { externalId: v.string(), messageId: v.string(), text: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.query("conversations").withIndex("by_channel_external", q => q.eq("channel", "whatsapp").eq("externalId", args.externalId)).unique();
    if (!chat) return false;
    const pending = await ctx.db.query("phoneInbox").withIndex("by_conversation", q => q.eq("conversationId", chat._id)).unique();
    const index = pending?.messageIds?.indexOf(args.messageId) ?? -1;
    if (!pending || index < 0) return false;
    const parts = [...pending.parts], messageIds = [...pending.messageIds!];
    if (args.text !== undefined) parts[index] = args.text;
    else { parts.splice(index, 1); messageIds.splice(index, 1); }
    if (parts.length) await ctx.db.patch(pending._id, { parts, messageIds });
    else await discardPending(ctx, chat._id);
    return true;
  },
});

export const flush = internalMutation({
  args: { id: v.id("phoneInbox"), dueAt: v.number(), now: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pending = await ctx.db.get(args.id);
    if (!pending || pending.dueAt !== args.dueAt || !args.now && pending.dueAt > Date.now()) return null;
    const chat = await ctx.db.get(pending.conversationId);
    if (pending.scheduledId) await ctx.scheduler.cancel(pending.scheduledId);
    await ctx.db.delete(pending._id);
    if (chat) await dispatch(ctx, chat, pending.parts.filter(Boolean).join("\n"), pending.title, { outside: pending.outside });
    return null;
  },
});
