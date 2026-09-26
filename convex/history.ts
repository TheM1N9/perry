import { listMessages, searchMessages } from "./lib/agent";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

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

export const search = internalAction({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{
    found: number;
    results: Array<{ chatId: string; chat: string; channel: string; role: string; date: string; snippet: string }>;
  }> => {
    const query = args.query.trim();
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 30);
    if (!query) return { found: 0, results: [] };
    const chats: Chat[] = await ctx.runQuery(internal.conversations.list, {});
    const byThread = new Map(chats.map((chat) => [chat.threadId, chat]));
    const users = [...new Set(chats.map(userIdOf))];
    // Each channel's hits come back best match first; interleave them by rank.
    const lists = await Promise.all(users.map((userId) => searchMessages(ctx, { userId: userId, text: query, limit: 50 })));
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
  args: { chatId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{
    chat?: string;
    channel?: string;
    messages: Array<{ role: string; date: string; text: string }>;
    note?: string;
  }> => {
    const chats: Chat[] = await ctx.runQuery(internal.conversations.list, {});
    const chat = chats.find((item) => item._id === args.chatId);
    if (!chat) return { messages: [], note: "No chat with that id. Ids come from search_chats." };
    const page = await listMessages(ctx, {
      threadId: chat.threadId,
      excludeToolMessages: true,
      paginationOpts: { cursor: null, numItems: Math.min(Math.max(args.limit ?? 20, 1), 50) },
    });
    const messages = page.page.reverse()
      .filter((item) => (item.message?.role === "user" || item.message?.role === "assistant") && item.text?.trim())
      .map((item) => ({ role: item.message!.role, date: day(item._creationTime), text: item.text!.replace(MARKER, "").trim().slice(0, 4000) }));
    return { chat: titleOf(chat), channel: chat.channel, messages, ...(page.isDone ? {} : { note: "Older messages exist; these are the most recent." }) };
  },
});
