import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Internal data layer for memory. The agent never touches these directly; it
 * goes through the tools in tools.ts, which are gated by mode.
 */

const MAX_RESULTS = 25;

export const add = internalMutation({
  args: {
    text: v.string(),
    tags: v.array(v.string()),
    source: v.string(),
  },
  returns: v.object({ id: v.id("memories"), duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const text = args.text.trim();

    // Cheap exact-duplicate guard. The agent re-remembers the same fact more
    // often than you would think, and duplicates poison recall ranking.
    const existing = await ctx.db
      .query("memories")
      .withSearchIndex("search_text", (q) => q.search("text", text))
      .take(5);

    const match = existing.find(
      (m) => m.text.trim().toLowerCase() === text.toLowerCase(),
    );
    if (match) return { id: match._id, duplicate: true };

    const id = await ctx.db.insert("memories", {
      text,
      tags: args.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      source: args.source,
      createdAt: Date.now(),
    });
    return { id, duplicate: false };
  },
});

export const search = internalQuery({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 8, MAX_RESULTS);
    const query = args.query.trim();

    const docs =
      query.length === 0
        ? await ctx.db.query("memories").withIndex("by_created").order("desc").take(limit)
        : await ctx.db
            .query("memories")
            .withSearchIndex("search_text", (q) => q.search("text", query))
            .take(limit);

    return docs.map((d) => ({
      id: d._id,
      text: d.text,
      tags: d.tags,
      createdAt: d.createdAt,
    }));
  },
});

export const removeMany = internalMutation({
  args: { ids: v.array(v.string()) },
  returns: v.object({ deleted: v.number(), missing: v.array(v.string()) }),
  handler: async (ctx, args) => {
    let deleted = 0;
    const missing: string[] = [];

    for (const raw of args.ids) {
      const id = ctx.db.normalizeId("memories", raw);
      if (!id) {
        missing.push(raw);
        continue;
      }
      const doc = await ctx.db.get(id);
      if (!doc) {
        missing.push(raw);
        continue;
      }
      await ctx.db.delete(id);
      deleted += 1;
    }

    return { deleted, missing };
  },
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // Single-user scale. If this ever gets slow, it is time for a counter.
    const all = await ctx.db.query("memories").take(1000);
    return all.length;
  },
});
