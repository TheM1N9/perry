import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { appended, cleanTitle, editSection, tooLong } from "./lib/notes";
import {
  blocksOf, itemOf, journalTitle, personKey, reconcile, removeLine, replaceLine, sameKey, snippet, type PageKind,
} from "./lib/pages";
import { timezoneOf } from "./jobs";
import type { MemoryView } from "./memories";
import { recordUser } from "./persona";

/**
 * Pages and their lines: Brain (issue #210), where notes and memory are one
 * place and a memory is a line in a page.
 *
 * Every paragraph, list item or other block of a page is a row in `memories`
 * with the page's id (lib/pages.ts splits the Markdown), kept in step with the
 * page in the same transaction as each save. A line that keeps its words keeps
 * its row, wherever it moves; one edited where it stands keeps its row with
 * the new words; so each line knows who wrote it, from which chat, and when.
 * Lines get vectors like memories do (memories.embedMissing), so recall and
 * search (Ctrl+K) find a page by meaning, paragraph by paragraph, beside the
 * memories, and only where the page may be read.
 *
 * Memory is pages too (lib/pages.ts, PageKind): About me (USER.md, and how the
 * owner likes things done), Things to remember in sections, a journal page a
 * day, a page per person, and what a chat kept to itself. "remember" writes a
 * line into the right one (memories.add), and the owner reads and edits every
 * memory there as text. A line of a page of memory is a memory: it has a
 * layer (profile, core or daily) and is loaded and recalled as one.
 */

type Note = Doc<"notes">;
type Line = Doc<"memories">;
type Writer = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] };
type Reader = { db: QueryCtx["db"] };
export type LineBy = "owner" | "assistant" | "job";
/** Who writes, and from which chat. */
export type Author = { by: LineBy; from?: Id<"conversations"> };

/** The layer a line of each kind of page is. */
const LINE_KIND = { about: "profile", remember: "core", journal: "daily", person: "core", chat: "core" } as const;
const searchOf = (title: string, content: string) => `${title}\n\n${content}`;
const noteBy = (by: LineBy): "owner" | "assistant" => (by === "owner" ? "owner" : "assistant");

/** A page's lines as they stand, in order. */
export async function linesOf(ctx: Reader, pageId: Id<"notes">): Promise<Line[]> {
  return (await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", pageId)).collect()).filter((line) => !line.supersededBy);
}

/**
 * Bring a page's lines up to its words, after a save by `author`. `at` is
 * when new lines count as written: now, or for a page from before lines, when
 * it was last saved. The lines it added, by their words (lib/pages.sameKey).
 */
export async function syncLines(ctx: Writer, page: Note, author: Author, at = Date.now(), hints?: Map<string, Id<"memories">>): Promise<Map<string, Id<"memories">>> {
  const rows = await linesOf(ctx, page._id);
  const byId = new Map(rows.map((row) => [row._id as string, row]));
  const plan = reconcile(rows.map((row) => ({ id: row._id, text: row.text, order: row.order })), blocksOf(page.content), hints);
  const scope = { projectId: page.projectId, conversationId: page.conversationId };
  const memory = Boolean(page.kind);
  const added = new Map<string, Id<"memories">>();
  let changed = false;
  for (const { id, block, order } of plan.keep) {
    const row = byId.get(id)!;
    const words = row.text !== block.text;
    if (!words && row.order === order && row.section === block.section && row.projectId === scope.projectId && row.conversationId === scope.conversationId) continue;
    await ctx.db.patch(id, {
      order, section: block.section, ...scope,
      ...(words ? { text: block.text, editedAt: at, vector: undefined, vectorModel: undefined } : {}),
    });
    changed ||= words;
  }
  for (const { id, block, order } of plan.edit) {
    await ctx.db.patch(id, {
      // Who changed it last; the chat it came from stays unless it was changed from another.
      text: block.text, order, section: block.section, ...scope, by: author.by, ...(author.from ? { from: author.from } : {}), editedAt: at, vector: undefined, vectorModel: undefined,
      // A memory the owner rewrote is theirs from then on, whoever wrote it first.
      ...(memory && author.by === "owner" ? { origin: "owner" as const } : {}),
    });
    changed = true;
  }
  for (const { block, order } of plan.add) {
    const id = await ctx.db.insert("memories", {
      text: block.text,
      tags: [],
      source: "page",
      createdAt: at,
      kind: page.kind ? LINE_KIND[page.kind] : "page",
      pageId: page._id,
      order,
      ...(block.section ? { section: block.section } : {}),
      by: author.by,
      ...(author.from ? { from: author.from } : {}),
      ...(page.projectId ? { projectId: page.projectId } : {}),
      ...(page.conversationId ? { conversationId: page.conversationId } : {}),
      ...(page.kind === "journal" && page.day ? { day: page.day } : {}),
      ...(page.kind === "person" ? { about: [page.title] } : {}),
      ...(memory && author.by !== "assistant" ? { origin: author.by === "job" ? "job" as const : "owner" as const } : {}),
    });
    added.set(sameKey(block.text), id);
    changed = true;
  }
  for (const id of plan.drop) await ctx.db.delete(id);
  if (page.linesAt !== page.revision) await ctx.db.patch(page._id, { linesAt: page.revision });
  if (changed) await ctx.scheduler.runAfter(0, internal.memories.embedMissing, {});
  return added;
}

// --- Writing pages ------------------------------------------------------------------------------

export type NewPage = {
  title: string; content: string; author: Author; projectId?: Id<"projects">;
  kind?: PageKind; day?: string; person?: string; conversationId?: Id<"conversations">;
};

/** A new page, and its lines. */
export async function insertPage(ctx: Writer, input: NewPage): Promise<Id<"notes">> {
  const problem = tooLong(input.content);
  if (problem) throw new Error(problem);
  const title = cleanTitle(input.title);
  const now = Date.now();
  const id = await ctx.db.insert("notes", {
    title,
    content: input.content,
    revision: 1,
    search: searchOf(title, input.content),
    by: noteBy(input.author.by),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.author.from ? { from: input.author.from } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.day ? { day: input.day } : {}),
    ...(input.person ? { person: input.person } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    createdAt: now,
    updatedAt: now,
  });
  await syncLines(ctx, (await ctx.db.get(id))!, input.author);
  return id;
}

/**
 * A save of what changed, as the next revision, and its lines brought up to it.
 * The caller has checked the revision it was made from, if it had one. About
 * me is USER.md too: each change is kept as a version of it (persona.ts), and
 * `typing` lets the owner's saves from one sitting be one version.
 */
export async function writePage(ctx: Writer, page: Note, patch: { title?: string; content?: string }, author: Author, options: { typing?: boolean; hints?: Map<string, Id<"memories">> } = {}): Promise<Map<string, Id<"memories">>> {
  const title = patch.title === undefined || page.kind ? page.title : cleanTitle(patch.title);
  const content = patch.content ?? page.content;
  const problem = tooLong(content);
  if (problem) throw new Error(problem);
  if (title === page.title && content === page.content) return new Map();
  await ctx.db.patch(page._id, { title, content, search: searchOf(title, content), revision: page.revision + 1, by: noteBy(author.by), updatedAt: Date.now() });
  const added = await syncLines(ctx, (await ctx.db.get(page._id))!, author, Date.now(), options.hints);
  // The owner's saves from one sitting are one version; anyone else's are each their own.
  if (page.kind === "about" && content !== page.content) await recordUser(ctx, content, author.by, options.typing ?? author.by === "owner");
  return added;
}

/** Delete a page and its lines. A schedule that wrote to it stops writing anywhere. */
export async function removePage(ctx: Writer, id: Id<"notes">): Promise<void> {
  if (!await ctx.db.get(id)) return;
  for (const job of await ctx.db.query("jobs").collect()) if (job.noteId === id) await ctx.db.patch(job._id, { noteId: undefined });
  for (const line of await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", id)).collect()) await ctx.db.delete(line._id);
  await ctx.db.delete(id);
}

/** A page moved into a project or out of one: its lines are read where it is now. */
export async function moveLines(ctx: Writer, pageId: Id<"notes">, projectId: Id<"projects"> | undefined): Promise<void> {
  for (const line of await linesOf(ctx, pageId)) if (line.projectId !== projectId) await ctx.db.patch(line._id, { projectId });
}

// --- Pages of memory ----------------------------------------------------------------------------

/** Where a memory lives. */
export type Place =
  | { kind: "about" }
  | { kind: "remember"; projectId?: Id<"projects"> }
  | { kind: "journal"; day: string; projectId?: Id<"projects"> }
  | { kind: "person"; name: string }
  | { kind: "chat"; conversationId: Id<"conversations"> };

/** The page of memory for a place, if there is one yet. */
export async function findPage(ctx: Reader, place: Place): Promise<Note | null> {
  const rows = await ctx.db.query("notes")
    .withIndex("by_kind", (q) => (place.kind === "journal" ? q.eq("kind", "journal").eq("day", place.day) : q.eq("kind", place.kind)))
    .collect();
  return rows.find((page) => {
    switch (place.kind) {
      case "about": return !page.projectId;
      case "remember": case "journal": return page.projectId === place.projectId;
      case "person": return page.person === personKey(place.name);
      case "chat": return page.conversationId === place.conversationId;
    }
  }) ?? null;
}

/** The page of memory for a place, made the first time something goes there. About me starts as USER.md. */
export async function memoryPage(ctx: Writer, place: Place): Promise<Note> {
  const found = await findPage(ctx, place);
  if (found) return found;
  let title = "Things to remember";
  let content = "";
  if (place.kind === "about") {
    title = "About me";
    const user = await ctx.db.query("persona").withIndex("by_kind", (q) => q.eq("kind", "user")).order("desc").first();
    content = user?.text?.trim() ? `${user.text.trim()}\n` : "";
  } else if (place.kind === "journal") title = journalTitle(place.day);
  else if (place.kind === "person") title = place.name.replace(/\s+/g, " ").trim();
  else if (place.kind === "chat") {
    const chat = await ctx.db.get(place.conversationId);
    const contact = chat?.contactId ? await ctx.db.get(chat.contactId) : null;
    title = chat?.title ?? (contact ? `Chat with ${contact.name}` : "A chat");
  }
  const id = await insertPage(ctx, {
    title, content, author: { by: "owner" }, kind: place.kind,
    ...("projectId" in place && place.projectId ? { projectId: place.projectId } : {}),
    ...(place.kind === "journal" ? { day: place.day } : {}),
    ...(place.kind === "person" ? { person: personKey(place.name) } : {}),
    ...(place.kind === "chat" ? { conversationId: place.conversationId } : {}),
  });
  return (await ctx.db.get(id))!;
}

type LineMeta = Partial<Pick<Line, "kind" | "tags" | "source" | "origin" | "day" | "about" | "todoId" | "confirmedAt">>;

/**
 * A memory written into a page: added at the end of a section (made when the
 * page lacks it), or of the page, or, `replacing` the words of a line there,
 * in that line's place. Returns the new line's id.
 */
export async function putLine(ctx: Writer, page: Note, input: { text: string; section?: string; replacing?: string }, author: Author, meta: LineMeta): Promise<Id<"memories">> {
  const text = input.text.trim();
  let content = input.replacing ? replaceLine(page.content, input.replacing, text) : null;
  if (content === null) {
    const edited = input.section ? editSection(page.content, input.section, itemOf(text), "append") : null;
    content = edited && "content" in edited ? edited.content : appended(page.content, itemOf(text));
  }
  const added = await writePage(ctx, page, { content }, author);
  const id = added.get(sameKey(text)) ?? [...added.values()].at(-1) ?? (await linesOf(ctx, page._id)).filter((line) => sameKey(line.text) === sameKey(text)).at(-1)?._id;
  if (!id) throw new Error("The memory could not be written into its page.");
  const fields = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
  await ctx.db.patch(id, fields);
  return id;
}

/** A line taken out of its page (forget). One whose words are no longer in the page goes as a row. */
export async function dropLine(ctx: Writer, line: Line, author: Author): Promise<void> {
  const page = line.pageId ? await ctx.db.get(line.pageId) : null;
  const content = page ? removeLine(page.content, line.text) : null;
  if (page && content !== null) await writePage(ctx, page, { content }, author);
  if (await ctx.db.get(line._id)) await ctx.db.delete(line._id);
}

/** A line's words changed where it stands, keeping its row (an edit, a to-do's news). */
export async function rewordLine(ctx: Writer, line: Line, text: string, author: Author): Promise<void> {
  const page = line.pageId ? await ctx.db.get(line.pageId) : null;
  const content = page ? replaceLine(page.content, line.text, text) : null;
  if (page && content !== null) await writePage(ctx, page, { content }, author, { hints: new Map([[sameKey(text), line._id]]) });
  const now = await ctx.db.get(line._id);
  if (now && now.text !== text.trim()) await ctx.db.patch(line._id, { text: text.trim(), by: author.by, editedAt: Date.now(), vector: undefined, vectorModel: undefined });
}

// --- Start and import ---------------------------------------------------------------------------

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
      await syncLines(ctx, page, { by: page.by, ...(page.from ? { from: page.from } : {}) }, page.updatedAt);
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

// --- The dashboard ------------------------------------------------------------------------------

export type MemoryPage = {
  id: Id<"notes">; kind: PageKind; title: string; day?: string; projectId?: Id<"projects">; project?: string;
  conversationId?: Id<"conversations">; lines: number; updatedAt: number;
};

/** Every page of memory, for the Memory page: About me, Things to remember, the journal (newest day first), people, chats. */
export const memoryPages = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<MemoryPage[]> => {
    assertDashboardKey(args.key);
    const names = new Map((await ctx.db.query("projects").collect()).map((project) => [project._id as string, project.name]));
    const pages: MemoryPage[] = [];
    for (const kind of ["about", "remember", "journal", "person", "chat"] as const) {
      const rows = await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", kind)).collect();
      if (kind === "journal") rows.sort((a, b) => (b.day ?? "").localeCompare(a.day ?? ""));
      else if (kind === "person") rows.sort((a, b) => a.title.localeCompare(b.title));
      for (const page of rows) {
        pages.push({
          id: page._id, kind, title: page.title, updatedAt: page.updatedAt, lines: (await linesOf(ctx, page._id)).length,
          ...(page.day ? { day: page.day } : {}),
          ...(page.projectId ? { projectId: page.projectId, project: names.get(page.projectId) ?? "a deleted project" } : {}),
          ...(page.conversationId ? { conversationId: page.conversationId } : {}),
        });
      }
    }
    return pages;
  },
});

export type LineView = {
  id: Id<"memories">; text: string; section?: string; by?: LineBy; origin?: string; from?: { id: Id<"conversations">; title: string };
  createdAt: number; editedAt?: number; confirmedAt?: number; tags: string[]; about?: string[]; todoId?: string;
};

/** A page's lines and where each came from: who wrote it, from which chat, when, and when last confirmed. */
export const lines = query({
  args: { key: v.string(), id: v.string() },
  handler: async (ctx, args): Promise<LineView[]> => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("notes", args.id);
    if (!id) return [];
    const chats = new Map<string, string>();
    const views: LineView[] = [];
    for (const line of (await linesOf(ctx, id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (line.from && !chats.has(line.from)) chats.set(line.from, (await ctx.db.get(line.from))?.title ?? "a deleted chat");
      views.push({
        id: line._id, text: line.text, createdAt: line.createdAt, tags: line.tags,
        ...(line.section ? { section: line.section } : {}),
        ...(line.by ? { by: line.by } : {}),
        ...(line.origin ? { origin: line.origin } : {}),
        ...(line.from ? { from: { id: line.from, title: chats.get(line.from)! } } : {}),
        ...(line.editedAt ? { editedAt: line.editedAt } : {}),
        ...(line.confirmedAt ? { confirmedAt: line.confirmedAt } : {}),
        ...(line.about?.length ? { about: line.about } : {}),
        ...(line.todoId ? { todoId: line.todoId } : {}),
      });
    }
    return views;
  },
});

/** Open the page of memory for a place from the dashboard (About me, Things to remember, today's journal), made if need be. */
export const openMemoryPage = mutation({
  args: { key: v.string(), kind: v.union(v.literal("about"), v.literal("remember"), v.literal("journal")) },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (args.kind === "journal") {
      const day = new Date().toLocaleDateString("en-CA", { timeZone: await timezoneOf(ctx) });
      return (await memoryPage(ctx, { kind: "journal", day }))._id;
    }
    return (await memoryPage(ctx, { kind: args.kind }))._id;
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
