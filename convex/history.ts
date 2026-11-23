import { listMessages, searchMessages } from "./lib/agent";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";

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

export type ChatHistory = {
  chat?: string;
  channel?: string;
  messages: Array<{ role: string; date: string; text: string }>;
  note?: string;
  activity?: Activity;
};

export const read = internalAction({
  args: { chatId: v.string(), limit: v.optional(v.number()), from: v.optional(v.id("conversations")), runId: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ChatHistory> => {
    const chats: Chat[] = await ctx.runQuery(internal.conversations.list, {});
    const chat = chats.find((item) => item._id === args.chatId);
    if (!chat) return { messages: [], note: "No chat with that id. Ids come from search_chats." };
    if (!openFrom(chats, args.from, "everywhere")(chat)) return { messages: [], note: "This chat may not read that one: what is said in a project's chats stays in the project." };
    const page = await listMessages(ctx, {
      threadId: chat.threadId,
      excludeToolMessages: true,
      paginationOpts: { cursor: null, numItems: Math.min(Math.max(args.limit ?? 20, 1), 50) },
    });
    const messages = page.page.reverse()
      .filter((item) => (item.message?.role === "user" || item.message?.role === "assistant") && item.text?.trim())
      .map((item) => ({ role: item.message!.role, date: day(item._creationTime), text: item.text!.replace(MARKER, "").trim().slice(0, 16000) }));
    const activity: Activity = await ctx.runQuery(internal.history.activity, { chatId: chat._id, runId: args.runId, cursor: args.cursor });
    return { chat: titleOf(chat), channel: chat.channel, messages, activity, ...(page.isDone ? {} : { note: "Older messages exist; these are the most recent." }) };
  },
});

type Activity = {
  runs: Array<{ id: string; status: string; startedAt: number; error?: string }>;
  steps?: Array<{ kind: string; name: string; status: string; input?: string; output?: string }>;
  nextCursor?: string;
  note?: string;
};

/** Called only after read has checked project and guest access to this chat. */
export const activity = internalQuery({
  args: { chatId: v.id("conversations"), runId: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Activity> => {
    const recent = await ctx.db.query("runs").withIndex("by_conversation", q => q.eq("conversationId", args.chatId)).order("desc").take(10);
    const runs = recent.map(run => ({ id: run._id, status: run.status, startedAt: run.startedAt, error: run.error }));
    if (!args.runId) return { runs };
    const id = ctx.db.normalizeId("runs", args.runId);
    const run = id ? await ctx.db.get(id) : null;
    if (!run || run.conversationId !== args.chatId) return { runs, note: "That run does not belong to this chat." };
    const page = await ctx.db.query("runSpans").withIndex("by_run", q => q.eq("runId", run._id)).paginate({ numItems: 5, cursor: args.cursor ?? null });
    return {
      runs, steps: page.page.map(span => ({ kind: span.kind, name: span.name, status: span.status, input: span.input, output: span.output })),
      ...(!page.isDone ? { nextCursor: page.continueCursor } : {}),
    };
  },
});
