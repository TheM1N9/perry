import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";

/**
 * The owner's logins and secrets, for Perry to sign in to websites with
 * computer use: the Keys page's second half.
 *
 * The owner adds one on the Keys page, or sends it in a chat and the agent
 * moves it here with save_secret. Moving means the value also leaves the chat:
 * it is replaced in that chat's history, its turns and its trace, so the only
 * copy Perry keeps is this row.
 *
 * Like the service keys, a value is never read back out to a browser. The
 * agent gets one only by asking for it with use_secret, one entry at a time,
 * and every trace hides whatever it reads.
 */

/** What the dashboard and list_secrets see: everything but the value. */
export type VaultEntry = {
  id: string;
  label: string;
  url?: string;
  username?: string;
  note?: string;
  by: "owner" | "assistant";
  updatedAt: number;
  lastUsedAt?: number;
};

const entry = (row: Doc<"vault">): VaultEntry => ({
  id: row._id,
  label: row.label,
  ...(row.url ? { url: row.url } : {}),
  ...(row.username ? { username: row.username } : {}),
  ...(row.note ? { note: row.note } : {}),
  by: row.by,
  updatedAt: row.updatedAt,
  ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
});

export const HIDDEN = "[saved in Keys]";

/**
 * Saved values shorter than this are not hidden everywhere: a four-digit PIN
 * would blank out every year in every trace. The chat a value was saved from
 * is cleaned of it whatever its length.
 */
const HIDE_EVERYWHERE = 6;

/** The text with each of the values replaced, longest first so one inside another cannot survive. */
export function hide(text: string, values: string[]): string {
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value && out.includes(value)) out = out.replaceAll(value, HIDDEN);
  }
  return out;
}

/** Every saved value long enough to hide on sight, for hiding it in whatever is about to be kept. */
export async function savedValues(ctx: Pick<QueryCtx, "db">): Promise<string[]> {
  return (await ctx.db.query("vault").collect()).map((row) => row.value).filter((value) => value.length >= HIDE_EVERYWHERE);
}

export const list = internalQuery({
  args: {},
  handler: async (ctx): Promise<VaultEntry[]> =>
    (await ctx.db.query("vault").collect()).map(entry).sort((a, b) => a.label.localeCompare(b.label)),
});

const same = (a?: string, b?: string) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const clean = (value?: string) => value?.trim() || undefined;

/**
 * Add one, or replace the entry with the same name and username. From a chat,
 * the value is then taken out of that chat: its messages, the turns and
 * messages still waiting to be saved, and the recent traces, where the call
 * that saved it recorded its arguments.
 */
export const save = internalMutation({
  args: {
    label: v.string(),
    url: v.optional(v.string()),
    username: v.optional(v.string()),
    value: v.string(),
    note: v.optional(v.string()),
    by: v.union(v.literal("owner"), v.literal("assistant")),
    /** The chat it was shared in, to take it out of. */
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args): Promise<{ id: string; replaced: boolean; hiddenIn: number }> => {
    const label = args.label.trim();
    const value = args.value.trim();
    if (!label) throw new Error("Give it a name, like the site it is for.");
    if (!value) throw new Error("There is no password or secret to save.");

    const fields = { label, url: clean(args.url), username: clean(args.username), value, note: clean(args.note), by: args.by, updatedAt: Date.now() };
    const existing = (await ctx.db.query("vault").collect())
      .find((row) => same(row.label, label) && same(row.username, fields.username));
    let id: Id<"vault">;
    if (existing) {
      await ctx.db.replace(existing._id, { ...fields, ...(existing.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}) });
      id = existing._id;
    } else {
      id = await ctx.db.insert("vault", fields);
    }

    const hiddenIn = args.conversationId ? await hideInChat(ctx, args.conversationId, value) : 0;
    return { id, replaced: Boolean(existing), hiddenIn };
  },
});

/** How many recent runs of the chat have their traces cleaned; the call that saved it is in the latest. */
const RECENT_RUNS = 10;

async function hideInChat(ctx: MutationCtx, conversationId: Id<"conversations">, value: string): Promise<number> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return 0;
  const scrub = (text: string) => hide(text, [value]);
  let changed = 0;

  // A web chat is named after its first message, and shows a sent one from its outbox until the history has it.
  if (conversation.title?.includes(value) || conversation.outbox?.some((entry) => entry.text.includes(value))) {
    await ctx.db.patch(conversation._id, {
      ...(conversation.title ? { title: scrub(conversation.title) } : {}),
      ...(conversation.outbox ? { outbox: conversation.outbox.map((entry) => ({ ...entry, text: scrub(entry.text) })) } : {}),
    });
    changed++;
  }

  const threadId = ctx.db.normalizeId("agentThreads", conversation.threadId);
  if (threadId) {
    const messages = await ctx.db.query("agentMessages").withIndex("by_thread_order", (q) => q.eq("threadId", threadId)).collect();
    for (const message of messages) {
      if (!message.text.includes(value) && !message.message.content.includes(value)) continue;
      await ctx.db.patch(message._id, { text: scrub(message.text), message: { ...message.message, content: scrub(message.message.content) } });
      changed++;
    }
  }

  // The owner's message is saved to the chat when its turn ends, from the turn itself.
  const turns = await ctx.db.query("codexTurns").withIndex("by_conversation_status", (q) => q.eq("conversationId", conversationId)).collect();
  for (const turn of turns) {
    const patch: Partial<Pick<Doc<"codexTurns">, "prompt" | "history" | "partial" | "response">> = {};
    for (const field of ["prompt", "history", "partial", "response"] as const) {
      const text = turn[field];
      if (text?.includes(value)) patch[field] = scrub(text);
    }
    if (Object.keys(patch).length) { await ctx.db.patch(turn._id, patch); changed++; }
    for (const steer of await ctx.db.query("codexSteers").withIndex("by_turn_status", (q) => q.eq("turnId", turn._id)).collect()) {
      if (steer.prompt.includes(value)) { await ctx.db.patch(steer._id, { prompt: scrub(steer.prompt) }); changed++; }
    }
  }

  const runs = await ctx.db.query("runs").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).order("desc").take(RECENT_RUNS);
  for (const run of runs) {
    if (run.prompt.includes(value)) { await ctx.db.patch(run._id, { prompt: scrub(run.prompt) }); changed++; }
    for (const span of await ctx.db.query("runSpans").withIndex("by_run", (q) => q.eq("runId", run._id)).collect()) {
      if (!span.input?.includes(value) && !span.output?.includes(value)) continue;
      await ctx.db.patch(span._id, { input: span.input && scrub(span.input), output: span.output && scrub(span.output) });
      changed++;
    }
  }
  return changed;
}

/** One entry with its value, for the agent to sign in with. Recorded as used. */
export const reveal = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<(VaultEntry & { value: string }) | null> => {
    const id = ctx.db.normalizeId("vault", args.id);
    const row = id && await ctx.db.get(id);
    if (!row) return null;
    await ctx.db.patch(row._id, { lastUsedAt: Date.now() });
    return { ...entry(row), value: row.value };
  },
});

export const remove = internalMutation({
  args: { id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("vault", args.id);
    if (!id || !(await ctx.db.get(id))) return false;
    await ctx.db.delete(id);
    return true;
  },
});
