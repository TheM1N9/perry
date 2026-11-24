import { listMessages, searchMessages } from "./lib/agent";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import { open } from "node:fs/promises";

/**
 * The agent's view of past conversations, on every channel: search them by
 * text, then read one. OpenClaw calls these sessions_search and
 * sessions_history. Saved memories are a separate, curated layer (recall).
 */

type Chat = Doc<"conversations">;
const MARKER = /\n?<!-- attachments:[^>]+ -->\s*$/;

const userIdOf = (chat: Chat) => chat.channel === "web" ? "web:dashboard" : `${chat.channel}:${chat.externalId}`;
const titleOf = (chat: Chat) => chat.title ?? (chat.channel === "telegram" ? "Telegram chat" : chat.channel === "whatsapp" ? "WhatsApp chat" : "Untitled chat");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A short window of text around the first match, so a long message still shows why it matched. */
function snippet(text: string, needle: string, width = 240): string {
  const clean = text.replace(MARKER, "").replace(/\s+/g, " ").trim();
  const at = clean.toLowerCase().indexOf(needle.toLowerCase().split(/\s+/)[0] ?? "");
  const start = Math.max(0, (at < 0 ? 0 : at) - width / 3);
  return `${start > 0 ? "…" : ""}${clean.slice(start, start + width)}${start + width < clean.length ? "…" : ""}`;
}

/**
 * Which chats a chat may read. What is said in a project's chats stays in the
 * project (projects.ts): a chat in it reads the project's chats, and the chats
 * in no project too unless kept to "this project"; any other chat reads only
 * the chats in no project. A chat with someone else reads none.
 */
function openFrom(chats: Chat[], from: string | undefined, scope: "this project" | "everywhere" = "this project") {
  const here = chats.find((chat) => chat._id === from);
  return (chat: Chat) => {
    if (here?.contactId) return false;
    if (chat._id === from) return true;
    if (chat.projectId) return chat.projectId === here?.projectId;
    // From before projects, until it is moved into one (projects.migrate).
    if (chat.project) return false;
    return !here?.projectId || scope === "everywhere";
  };
}

export const search = internalAction({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    from: v.optional(v.id("conversations")),
    /** From a project's chat: only its chats (the default), or the chats in no project too. */
    scope: v.optional(v.union(v.literal("this project"), v.literal("everywhere"))),
  },
  handler: async (ctx, args): Promise<{
    found: number;
    results: Array<{ chatId: string; chat: string; channel: string; role: string; date: string; snippet: string }>;
  }> => {
    const query = args.query.trim();
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 30);
    if (!query) return { found: 0, results: [] };
    const all: Chat[] = await ctx.runQuery(internal.conversations.list, {});
    const chats = all.filter(openFrom(all, args.from, args.scope));
    const byThread = new Map(chats.map((chat) => [chat.threadId, chat]));
    const users = [...new Set(chats.map(userIdOf))];
    // Each channel's hits come back best match first; interleave them by rank. The web's chats share one
    // user, so when only some of them may be read, more hits are taken to leave enough after the rest.
    const some = chats.length < all.length;
    const lists = await Promise.all(users.map((userId) => searchMessages(ctx, { userId: userId, text: query, limit: some ? 300 : 50 })));
    const hits = lists.flatMap((list) => list.map((hit, rank) => ({ hit, rank }))).sort((a, b) => a.rank - b.rank).map(({ hit }) => hit);

    const results = hits
      .filter((hit) => byThread.has(hit.threadId) && (hit.message?.role === "user" || hit.message?.role === "assistant") && hit.text?.trim())
      .map((hit) => {
        const chat = byThread.get(hit.threadId)!;
        return { chatId: chat._id, chat: titleOf(chat), channel: chat.channel, role: hit.message!.role, date: day(hit._creationTime), snippet: snippet(hit.text!, query) };
      })
      .slice(0, limit);
    return { found: results.length, results };
  },
});

export const read = internalAction({
  args: { chatId: v.string(), limit: v.optional(v.number()), cursor: v.optional(v.string()), messageId: v.optional(v.string()), offset: v.optional(v.number()), from: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<{
    chat?: string;
    channel?: string;
    messages: Array<{ id: string; role: string; date: string; text: string; nextOffset?: number }>;
    note?: string;
    cursor?: string;
  }> => {
    const chats: Chat[] = await ctx.runQuery(internal.conversations.list, {});
    const chat = chats.find((item) => item._id === args.chatId);
    if (!chat) return { messages: [], note: "No chat with that id. Ids come from search_chats." };
    if (!openFrom(chats, args.from, "everywhere")(chat)) return { messages: [], note: "This chat may not read that one: what is said in a project's chats stays in the project." };
    if (args.messageId) {
      const message = await ctx.runQuery(internal.history.message, { id: args.messageId, threadId: chat.threadId });
      if (!message) return { messages: [], note: "No message with that id in this chat." };
      const offset = Math.max(0, Math.floor(args.offset ?? 0)), end = offset + 32000, text = message.text ?? "";
      return { chat: titleOf(chat), channel: chat.channel, messages: [{ id: message._id, role: message.message?.role ?? "unknown", date: day(message._creationTime), text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) }] };
    }
    const page = await listMessages(ctx, {
      threadId: chat.threadId,
      excludeToolMessages: true,
      paginationOpts: { cursor: args.cursor ?? null, numItems: Math.min(Math.max(args.limit ?? 20, 1), 50) },
    });
    const messages = page.page.reverse()
      .filter((item) => (item.message?.role === "user" || item.message?.role === "assistant") && item.text?.trim())
      .map((item) => ({ id: item._id, role: item.message!.role, date: day(item._creationTime), text: item.text!.slice(0, 16000), ...(item.text!.length > 16000 ? { nextOffset: 16000 } : {}) }));
    return { chat: titleOf(chat), channel: chat.channel, messages, ...(page.isDone ? {} : { cursor: page.continueCursor, note: "Read the next older page with this cursor." }) };
  },
});

export const message = internalQuery({
  args: { id: v.string(), threadId: v.string() },
  handler: async (ctx, args) => { const id = ctx.db.normalizeId("agentMessages", args.id); const row = id ? await ctx.db.get(id) : null; return row?.threadId === args.threadId ? row : null; },
});
export const attachmentRow = internalQuery({
  args: { chatId: v.string(), messageKey: v.string(), fileName: v.string() },
  handler: async (ctx, args) => {
    const chatId = ctx.db.normalizeId("conversations", args.chatId); if (!chatId) return null;
    const row = (await ctx.db.query("chatAttachments").withIndex("by_conversation", q => q.eq("conversationId", chatId)).collect()).find(row => row.messageKey === args.messageKey && row.fileName === args.fileName && !row.removedAt);
    return row ? { ...row, url: row.storageId ? await ctx.storage.getUrl(row.storageId) : null } : null;
  },
});
export const attachment = internalAction({
  args: { chatId: v.string(), messageKey: v.string(), fileName: v.string(), offset: v.optional(v.number()), from: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<{ fileName: string; contentType: string; base64: string; nextOffset?: number }> => {
    const chats: Chat[] = await ctx.runQuery(internal.conversations.list, {}), chat = chats.find(chat => chat._id === args.chatId);
    if (!chat || !openFrom(chats, args.from, "everywhere")(chat)) throw new Error("This chat may not read that file.");
    const row = await ctx.runQuery(internal.history.attachmentRow, { chatId: args.chatId, messageKey: args.messageKey, fileName: args.fileName });
    if (!row) throw new Error("This attachment is no longer available. Use the Files panel to find its name.");
    const offset = Math.max(0, Math.floor(args.offset ?? 0)), length = 48000;
    let bytes: Buffer, total = row.size;
    if (row.storageId) {
      const blob = await ctx.storage.get(row.storageId);
      if (!blob) throw new Error("Attachment download failed.");
      total = blob.size; bytes = Buffer.from(await blob.slice(offset, offset + length).arrayBuffer());
    } else if (row.localPath) {
      const file = await open(row.localPath, "r");
      try { total = (await file.stat()).size; const buffer = Buffer.alloc(length); const result = await file.read(buffer, 0, length, offset); bytes = buffer.subarray(0, result.bytesRead); }
      finally { await file.close(); }
    } else throw new Error("This attachment has no readable file.");
    return { fileName: row.fileName, contentType: row.contentType, base64: bytes.toString("base64"), ...(offset + bytes.length < total ? { nextOffset: offset + bytes.length } : {}) };
  },
});
