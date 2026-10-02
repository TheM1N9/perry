import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { blocksOf, reconcile, snippet } from "./lib/pages";
import type { MemoryView } from "./memories";

/**
 * Pages and their lines: the start of Brain (issue #210), where notes and
 * memory are one place and a memory is a line in a page.
 *
 * Every paragraph, list item or other block of a page is a row in `memories`
 * with the page's id (lib/pages.ts splits the Markdown), kept in step with the
 * page in the same transaction as each save. A line that keeps its words keeps
 * its row, wherever it moves; one edited where it stands keeps its row with
 * the new words; so each line knows who wrote it, from which chat, and when.
 * Lines get vectors like memories do (memories.embedMissing), so recall and
 * search (Ctrl+K) find a page by meaning, paragraph by paragraph, beside the
 * memories, and only where the page may be read.
 */

type Note = Doc<"notes">;
type Line = Doc<"memories">;
type Writer = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] };
type Reader = { db: QueryCtx["db"] };
export type LineBy = "owner" | "assistant" | "job";

/** A page's lines as they stand, in order. */
export async function linesOf(ctx: Reader, pageId: Id<"notes">): Promise<Line[]> {
  return (await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", pageId)).collect()).filter((line) => !line.supersededBy);
}

/**
 * Bring a page's lines up to its words, after a save by `by` (from chat
 * `from`). `at` is when new lines count as written: now, or for a page from
 * before lines, when it was last saved.
 */
export async function syncLines(ctx: Writer, page: Note, by: LineBy, from?: Id<"conversations">, at = Date.now()): Promise<void> {
  const rows = await linesOf(ctx, page._id);
  const byId = new Map(rows.map((row) => [row._id as string, row]));
  const plan = reconcile(rows.map((row) => ({ id: row._id, text: row.text, order: row.order })), blocksOf(page.content));
  const scope = { projectId: page.projectId };
  let changed = false;
  for (const { id, block, order } of plan.keep) {
    const row = byId.get(id)!;
    const words = row.text !== block.text;
    if (!words && row.order === order && row.section === block.section && row.projectId === scope.projectId) continue;
    await ctx.db.patch(id, {
      order, section: block.section, ...scope,
      ...(words ? { text: block.text, editedAt: at, vector: undefined, vectorModel: undefined } : {}),
    });
    changed ||= words;
  }
  for (const { id, block, order } of plan.edit) {
    await ctx.db.patch(id, {
      text: block.text, order, section: block.section, ...scope, by, from, editedAt: at, vector: undefined, vectorModel: undefined,
    });
    changed = true;
  }
  for (const { block, order } of plan.add) {
    await ctx.db.insert("memories", {
      text: block.text,
      tags: [],
      source: "page",
      createdAt: at,
      kind: "page",
      pageId: page._id,
      order,
      ...(block.section ? { section: block.section } : {}),
      by,
      ...(from ? { from } : {}),
      ...(page.projectId ? { projectId: page.projectId } : {}),
    });
    changed = true;
  }
  for (const id of plan.drop) await ctx.db.delete(id);
  if (page.linesAt !== page.revision) await ctx.db.patch(page._id, { linesAt: page.revision });
  if (changed) await ctx.scheduler.runAfter(0, internal.memories.embedMissing, {});
}

/** A page deleted: its lines go with it. */
export async function dropLines(ctx: Writer, pageId: Id<"notes">): Promise<void> {
  for (const line of await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", pageId)).collect()) await ctx.db.delete(line._id);
}

/** A page moved into a project or out of one: its lines are read where it is now. */
export async function moveLines(ctx: Writer, pageId: Id<"notes">, projectId: Id<"projects"> | undefined): Promise<void> {
  for (const line of await linesOf(ctx, pageId)) if (line.projectId !== projectId) await ctx.db.patch(line._id, { projectId });
}

/**
 * Lines for every page behind its words: pages from before lines, and any an
 * import brought. Run whenever Perry starts and after an import; it does
 * nothing once done. Derived from the pages, so it changes none of them.
 */
export const indexAll = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let done = 0;
    for (const page of await ctx.db.query("notes").collect()) {
      if (page.linesAt === page.revision) continue;
      await syncLines(ctx, page, page.by, page.from, page.updatedAt);
      done++;
    }
    return done;
  },
});

/** The titles of pages, by id, for search results. */
export const titles = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const found: Record<string, string> = {};
    for (const raw of new Set(args.ids)) {
      const id = ctx.db.normalizeId("notes", raw);
      const page = id ? await ctx.db.get(id) : null;
      if (page) found[raw] = page.title;
    }
    return found;
  },
});

export type Found = {
  id: string;
  text: string;
  kind: MemoryView["kind"];
  day?: string;
  page?: { id: string; title: string };
  section?: string;
  score: number;
};

/**
 * One search across memory and pages, for Ctrl+K: the memories and the lines
 * of pages that match by words or by meaning (memories.recall), best first.
 */
export const search = action({
  args: { key: v.string(), query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Found[]> => {
    assertDashboardKey(args.key);
    const query = args.query.trim();
    if (query.length < 2) return [];
    const hits: Array<MemoryView & { score: number }> = await ctx.runAction(internal.memories.recall, { query, limit: Math.min(args.limit ?? 10, 25), everywhere: true });
    return hits.map((hit) => ({
      id: hit.id,
      text: snippet(hit.text),
      kind: hit.kind,
      ...(hit.day ? { day: hit.day } : {}),
      ...(hit.page ? { page: hit.page } : {}),
      ...(hit.section ? { section: hit.section } : {}),
      score: hit.score,
    }));
  },
});
