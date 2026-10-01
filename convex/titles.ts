import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { EngineKind } from "./lib/engines";
import { engineFor } from "./installation";
import { authenticate } from "./runner";

/**
 * Naming web chats. A new chat is titled with its first message straight
 * away, so the sidebar never shows "New chat" for one that has started; a
 * runner then asks a quick model (runner/title.ts) for a short name and that
 * replaces it: the chat's own engine's when that runner has it signed in, else
 * any engine's. Any runner may do it, since naming needs no workspace.
 */

/** A claim older than this is taken to be from a runner that went away. */
const CLAIM_MS = 2 * 60_000;
/** A request no runner took by then is dropped; the first-message title stays. */
const REQUEST_TTL_MS = 24 * 60 * 60_000;
const TITLE_LIMIT = 100;

/** Ask for a name for a chat whose first message was just sent. */
export async function requestTitle(ctx: MutationCtx, conversationId: Id<"conversations">, text: string, provisional: string) {
  const existing = await ctx.db.query("chatTitles").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
  for (const row of existing) await ctx.db.delete(row._id);
  if (!text.trim()) return;
  await ctx.db.insert("chatTitles", { conversationId, text: text.slice(0, 4000), provisional, requestedAt: Date.now() });
}

/** Forget a request, as when the owner names the chat or deletes it. */
export async function cancelTitle(ctx: MutationCtx, conversationId: Id<"conversations">) {
  const existing = await ctx.db.query("chatTitles").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
  for (const row of existing) await ctx.db.delete(row._id);
}

/** Chats a runner is naming right now, for the dashboard to show. */
export async function beingNamed(ctx: QueryCtx): Promise<Set<Id<"conversations">>> {
  const now = Date.now();
  const rows = await ctx.db.query("chatTitles").collect();
  return new Set(rows.filter((row) => (row.claimedAt ?? 0) >= now - CLAIM_MS).map((row) => row.conversationId));
}

/**
 * Chats waiting for a name, for any runner to take, with the engine each chat
 * is on (its own, or the default it follows), which names it when it can.
 * Unset for a chat with no engine yet: the runner then uses the default, or
 * any engine of its own that can (runner/index.ts, quickEngine).
 */
export const pending = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Array<{ id: Id<"chatTitles">; text: string; engine?: EngineKind }>> => {
    await authenticate(ctx, args.token);
    const rows = await ctx.db.query("chatTitles").order("asc").take(50);
    const now = Date.now();
    const waiting = rows.filter((row) => row.requestedAt > now - REQUEST_TTL_MS && (row.claimedAt ?? 0) < now - CLAIM_MS).slice(0, 10);
    return await Promise.all(waiting.map(async (row) => ({ id: row._id, text: row.text, engine: await engineFor(ctx, await ctx.db.get(row.conversationId)) })));
  },
});

/** Take a request, so no other runner names the same chat. False when it is gone or taken. */
export const claim = mutation({
  args: { token: v.string(), id: v.id("chatTitles") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    const now = Date.now();
    if (!row || (row.claimedAt ?? 0) >= now - CLAIM_MS) return false;
    if (row.requestedAt <= now - REQUEST_TTL_MS) {
      await ctx.db.delete(row._id);
      return false;
    }
    await ctx.db.patch(row._id, { claimedAt: now });
    return true;
  },
});

/** The name, or none when naming failed: either way the request is done. */
export const finish = mutation({
  args: { token: v.string(), id: v.id("chatTitles"), title: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    await ctx.db.delete(row._id);
    const title = cleanTitle(args.title ?? "");
    const chat = await ctx.db.get(row.conversationId);
    // Renamed, reset or deleted in the meantime: the owner's choice stands.
    if (!title || !chat || chat.title !== row.provisional) return null;
    await ctx.db.patch(chat._id, { title });
    return null;
  },
});

/** One line, no quotes or trailing full stop, as a model sometimes adds. */
function cleanTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim()
    .replace(/^(title|name)\s*:\s*/i, "")
    .replace(/^["'“‘`*]+|["'”’`*]+$/g, "")
    .replace(/\.$/, "")
    .trim()
    .slice(0, TITLE_LIMIT);
}
