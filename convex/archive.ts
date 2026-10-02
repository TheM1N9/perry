import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";

/**
 * Brain's archive (issue #220, the owner's idea): a line nobody has used for
 * three months (the owner can change it in Settings) is archived. It is not
 * sent with messages and not found by normal search, but a deep search finds
 * it (recall with deep, Brain's "Include archive"), and the owner sees and
 * restores it in Brain. Using it again brings it back by itself.
 *
 * Used means: recalled into a turn (the lines a message is sent as bearing on
 * it, and what Perry's recall returns), cited in a reply, edited, or on a page
 * the owner opened. A line past the time it holds until (expiresAt) is
 * archived too. Use was not kept before the archive, so the age counts from
 * when it began (installation.archiveSince) for a line not used since: an
 * install from before it archives nothing for its first three months. Never archived: About me, a page or section the owner pinned
 * themselves, and the Lately page.
 *
 * Archiving changes no words and moves no line: the line keeps its place in
 * its page, with archivedAt set, and its vector is kept apart from the live
 * ones (vectorKey) so normal search never has to wade through it.
 */

type Line = Doc<"memories">;
const DAY_MS = 86_400_000;
export const DEFAULT_ARCHIVE_DAYS = 90;
/** How long after a line was last marked used it is marked again: once a day is enough to tell three months. */
const MARK_EVERY_MS = DAY_MS;
const BATCH = 2_000;

/** The key a line's vector is searched under: its model, and live or archived (memories.byMeaning). */
export const vectorKeyOf = (model: string | undefined, archived: boolean) => (model ? `${model}|${archived ? "archive" : "live"}` : undefined);

/** Lines were used: they count as used now, and an archived one comes back. */
export async function markUsed(ctx: MutationCtx, ids: string[], options: { revive?: boolean; now?: number } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  let revived = 0;
  for (const raw of new Set(ids)) {
    const id = ctx.db.normalizeId("memories", raw);
    const line = id ? await ctx.db.get(id) : null;
    if (!line || line.supersededBy) continue;
    if (line.archivedAt && options.revive) {
      await ctx.db.patch(line._id, { archivedAt: undefined, lastUsedAt: now, ...(line.embeddedWith ? { vectorKey: vectorKeyOf(line.embeddedWith, false) } : {}) });
      revived++;
    } else if (!line.archivedAt && (line.lastUsedAt ?? 0) < now - MARK_EVERY_MS) {
      await ctx.db.patch(line._id, { lastUsedAt: now });
    }
  }
  return revived;
}

export const used = internalMutation({
  args: { ids: v.array(v.string()), revive: v.optional(v.boolean()) },
  returns: v.number(),
  handler: async (ctx, args) => await markUsed(ctx, args.ids, { revive: args.revive }),
});

/** The owner opened a page in Brain: its lines count as used (not its archived ones, which they restore one by one). */
export const opened = mutation({
  args: { key: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("notes", args.id);
    if (!id) return null;
    const lines = await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", id)).collect();
    await markUsed(ctx, lines.filter((line) => !line.archivedAt).map((line) => line._id));
    return null;
  },
});

/** How old, in days, an unused line is when it is archived; 0 is never. */
export async function archiveDays(ctx: { db: MutationCtx["db"] }): Promise<number> {
  const days = (await ctx.db.query("installation").first())?.archiveAfterDays;
  return days === undefined ? DEFAULT_ARCHIVE_DAYS : days;
}

/** Whether a line may never be archived: About me's, the Lately page's, and what the owner pinned themselves. */
function keptOf(page: Doc<"notes"> | null, line: Line): boolean {
  if (!page) return false;
  if (page.kind === "about" || page.lately) return true;
  if (page.pinned === true) return true;
  return Boolean(line.section && page.pinnedSections?.includes(line.section));
}

/**
 * One pass over a batch of lines, oldest first from where the last stopped
 * (installation.archiveCursor), archiving what has gone unused past the age
 * and what is past the time it held until; the next batch is scheduled until
 * the end, and the cursor starts again from the beginning next time. `now`
 * is for a check that moves time on; it is otherwise the clock.
 */
export const run = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ archived: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const install = await ctx.db.query("installation").first();
    if (!install) return { archived: 0, done: true };
    const days = await archiveDays(ctx);
    // Lines count as used when the archive began: until then nobody kept when a line was used.
    const since = install.archiveSince ?? now;
    if (install.archiveSince === undefined) await ctx.db.patch(install._id, { archiveSince: now });
    const from = install.archiveCursor ?? -1;
    const taken = await ctx.db.query("memories").withIndex("by_created", (q) => q.gt("createdAt", from)).take(BATCH);
    // Every line of the batch's last moment is in it, so none written at the same moment falls between two batches.
    const last = taken.at(-1)?.createdAt;
    const batch = last === undefined ? [] : [...taken.filter((line) => line.createdAt < last), ...await ctx.db.query("memories").withIndex("by_created", (q) => q.eq("createdAt", last)).collect()];
    const pages = new Map<string, Doc<"notes"> | null>();
    let archived = 0;
    for (const line of batch) {
      if (line.supersededBy || line.archivedAt || !line.pageId) continue;
      if (!pages.has(line.pageId)) pages.set(line.pageId, await ctx.db.get(line.pageId));
      const page = pages.get(line.pageId)!;
      if (keptOf(page, line)) continue;
      const expired = line.expiresAt !== undefined && line.expiresAt < now;
      const lastActive = Math.max(line.lastUsedAt ?? 0, line.createdAt, line.editedAt ?? 0, line.confirmedAt ?? 0, since);
      if (!expired && (days <= 0 || lastActive >= now - days * DAY_MS)) continue;
      await ctx.db.patch(line._id, { archivedAt: now, ...(line.embeddedWith ? { vectorKey: vectorKeyOf(line.embeddedWith, true) } : {}) });
      archived++;
    }
    const done = taken.length < BATCH;
    await ctx.db.patch(install._id, { archiveCursor: done || last === undefined ? undefined : last });
    if (!done) await ctx.scheduler.runAfter(0, internal.archive.run, args.now ? { now: args.now } : {});
    return { archived, done };
  },
});

/** The owner brings lines back from the archive. */
export const restore = mutation({
  args: { key: v.string(), ids: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await markUsed(ctx, args.ids, { revive: true });
  },
});

export type ArchivedLine = { id: Id<"memories">; text: string; page?: { id: Id<"notes">; title: string }; section?: string; archivedAt: number };

/** The archive, newest first; with words, the archived lines that have them. */
export const list = query({
  args: { key: v.string(), query: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ lines: ArchivedLine[] }> => {
    assertDashboardKey(args.key);
    const words = args.query?.trim() ?? "";
    const archived = words
      ? (await ctx.db.query("memories").withSearchIndex("search_text", (q) => q.search("text", words)).take(400)).filter((line) => line.archivedAt && !line.supersededBy)
      : await ctx.db.query("memories").withIndex("by_archived", (q) => q.gt("archivedAt", 0)).order("desc").take(50);
    const pages = new Map<string, Doc<"notes"> | null>();
    const lines: ArchivedLine[] = [];
    for (const line of archived.slice(0, 50)) {
      if (line.pageId && !pages.has(line.pageId)) pages.set(line.pageId, await ctx.db.get(line.pageId));
      const page = line.pageId ? pages.get(line.pageId) : null;
      lines.push({ id: line._id, text: line.text, ...(page ? { page: { id: page._id, title: page.title } } : {}), ...(line.section ? { section: line.section } : {}), archivedAt: line.archivedAt! });
    }
    return { lines };
  },
});

/** Settings: how long a line goes unused before it is archived. */
export const getSetting = query({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const days = (await ctx.db.query("installation").first())?.archiveAfterDays;
    return days === undefined ? DEFAULT_ARCHIVE_DAYS : days;
  },
});

export const setSetting = mutation({
  args: { key: v.string(), days: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    if (![0, 30, 90, 180, 365].includes(args.days)) throw new Error("Pick one of the choices.");
    await ctx.db.patch(install._id, { archiveAfterDays: args.days });
    return null;
  },
});

/**
 * Lines from before the archive have no vectorKey: each gets its own (its model, live), in batches from where the
 * last stopped, so the live search finds them (memories.byMeaning). Derived, so it changes nothing of the owner's.
 */
export const keyVectors = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const batch = await ctx.db.query("memories").withIndex("by_vector_key", (q) => q.eq("vectorKey", undefined).gt("embeddedWith", "")).take(BATCH);
    for (const line of batch) await ctx.db.patch(line._id, { vectorKey: vectorKeyOf(line.embeddedWith, Boolean(line.archivedAt)) });
    if (batch.length === BATCH) await ctx.scheduler.runAfter(0, internal.archive.keyVectors, {});
    return batch.length;
  },
});

