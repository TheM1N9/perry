import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { appended, cleanTitle, CONTENT_LIMIT, editSection, MEMORY_PAGE_LIMIT, tooLong } from "./lib/notes";
import {
  blocksOf, itemOf, journalTitle, peopleIn, personKey, PREFERENCES_SECTION, reconcile, removeLine, replaceLine, sameKey, sectionFor, snippet, type PageKind,
} from "./lib/pages";
import { timezoneOf } from "./jobs";
import { aliasesIn } from "./lib/recall";
import { CONDENSE_FROM, pinnedBudget, SUMMARY_LIMIT } from "./lib/budget";
import type { MemoryView } from "./memories";
import { recordUser } from "./persona";
import { savedValues } from "./vault";

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
export async function syncLines(ctx: Writer, page: Note, author: Author, at = Date.now(), hints?: Map<string, Id<"memories">>, spare?: Set<string>): Promise<Map<string, Id<"memories">>> {
  const rows = await linesOf(ctx, page._id);
  const byId = new Map(rows.map((row) => [row._id as string, row]));
  const plan = reconcile(rows.map((row) => ({ id: row._id, text: row.text, order: row.order })), blocksOf(page.content), hints);
  const scope = { projectId: page.projectId, conversationId: page.conversationId };
  const memory = Boolean(page.kind);
  const added = new Map<string, Id<"memories">>();
  let changed = false;
  const reworded: Array<Id<"memories">> = [];
  for (const { id, block, order } of plan.keep) {
    const row = byId.get(id)!;
    const words = row.text !== block.text;
    if (!words && row.order === order && row.section === block.section && row.projectId === scope.projectId && row.conversationId === scope.conversationId) continue;
    await ctx.db.patch(id, {
      order, section: block.section, ...scope,
      ...(words ? { text: block.text, editedAt: at, embedding: undefined, embeddedWith: undefined } : {}),
    });
    if (words) reworded.push(id);
    changed ||= words;
  }
  for (const { id, block, order } of plan.edit) {
    await ctx.db.patch(id, {
      // Who changed it last; the chat it came from stays unless it was changed from another.
      text: block.text, order, section: block.section, ...scope, by: author.by, ...(author.from ? { from: author.from } : {}), editedAt: at, embedding: undefined, embeddedWith: undefined,
      // A memory the owner rewrote is theirs from then on, whoever wrote it first.
      ...(memory && author.by === "owner" ? { origin: "owner" as const } : {}),
    });
    reworded.push(id);
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
    reworded.push(id);
    changed = true;
  }
  for (const id of plan.drop) {
    // A memory being moved into this page whose words did not come back as a line of it stays as it was, out of the page.
    if (spare?.has(id)) await ctx.db.patch(id, { pageId: undefined, order: undefined, section: undefined, migratedAt: undefined });
    else await deleteLine(ctx, id);
  }
  if (reworded.length) await noteMentions(ctx, reworded);
  if (page.kind === "person" && (reworded.length || plan.drop.length)) await noteAliases(ctx, page._id);
  if (page.linesAt !== page.revision) await ctx.db.patch(page._id, { linesAt: page.revision });
  if (changed) await ctx.scheduler.runAfter(0, internal.memories.embedMissing, {});
  return added;
}

/** installation.mentionsAt once every line from before mentions were kept has been read (indexMentions). */
const MENTIONS_DONE = Number.MAX_SAFE_INTEGER;

/** A line gone for good, and what it mentioned. */
export async function deleteLine(ctx: Writer, id: Id<"memories">): Promise<void> {
  for (const mention of await ctx.db.query("mentions").withIndex("by_line", (q) => q.eq("lineId", id)).collect()) await ctx.db.delete(mention._id);
  if (await ctx.db.get(id)) await ctx.db.delete(id);
}

/** People who have a page, by every name a line may call them: the page's title, and a first name only one of them has. */
export async function peopleByName(ctx: Reader): Promise<Map<string, string>> {
  const pages = await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", "person")).collect();
  const names = new Map<string, string>();
  const firsts = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.person) continue;
    names.set(page.title.toLocaleLowerCase(), page.person);
    const first = page.title.split(/\s+/)[0].toLocaleLowerCase();
    if (first.length > 2) firsts.set(first, [...(firsts.get(first) ?? []), page.person]);
  }
  for (const [first, keys] of firsts) if (keys.length === 1 && !names.has(first)) names.set(first, keys[0]);
  return names;
}

/** The people a line mentions: those it is about, the person whose page it is on, and names in its words. */
export function mentionedIn(line: Pick<Line, "text" | "about">, names: Map<string, string>, pageOf?: string): string[] {
  // Whoever it is about, page or not yet (memories.add makes their page after the line).
  const found = new Set<string>(peopleIn(line.about).map(personKey));
  if (pageOf) found.add(pageOf);
  const words = line.text.toLocaleLowerCase().split(/[^\p{L}\p{N}'’.-]+/u).map((word) => word.replace(/['’]s$|[.'’-]+$/u, "")).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const two = i + 1 < words.length ? names.get(`${words[i]} ${words[i + 1]}`) : undefined;
    if (two) { found.add(two); i++; continue; }
    const one = names.get(words[i]);
    if (one) found.add(one);
  }
  return [...found];
}

/** Bring who these lines mention up to their words (memories.recall finds by it). */
export async function noteMentions(ctx: Writer, ids: Array<Id<"memories">>, names?: Map<string, string>): Promise<void> {
  const people = names ?? await peopleByName(ctx);
  const pageKeys = new Map<string, string | undefined>();
  for (const id of ids) {
    const line = await ctx.db.get(id);
    if (!line) continue;
    let pageOf: string | undefined;
    if (line.pageId) {
      if (!pageKeys.has(line.pageId)) {
        const page = await ctx.db.get(line.pageId);
        pageKeys.set(line.pageId, page?.kind === "person" ? page.person : undefined);
      }
      pageOf = pageKeys.get(line.pageId);
    }
    const want = new Set(mentionedIn(line, people, pageOf));
    for (const mention of await ctx.db.query("mentions").withIndex("by_line", (q) => q.eq("lineId", id)).collect()) {
      if (mention.person && want.has(mention.person)) want.delete(mention.person);
      else await ctx.db.delete(mention._id);
    }
    for (const person of want) await ctx.db.insert("mentions", { lineId: id, person });
  }
}

/** What the owner calls someone, read from their page's lines ("Divya is my younger sister"). */
export async function noteAliases(ctx: Writer, pageId: Id<"notes">): Promise<void> {
  const page = await ctx.db.get(pageId);
  if (!page || page.kind !== "person") return;
  const aliases = aliasesIn(page.title, (await linesOf(ctx, pageId)).map((line) => line.text));
  if (JSON.stringify(aliases) !== JSON.stringify(page.aliases ?? [])) await ctx.db.patch(pageId, { aliases: aliases.length ? aliases : undefined });
}

/**
 * Who every line mentions, and what each person is called, for lines from
 * before mentions were kept (issue #220): a batch of lines oldest first after
 * where the last batch stopped (installation.mentionsAt), the next scheduled
 * until none are left. Derived from the lines, so it changes none of them.
 */
export const indexMentions = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const install = await ctx.db.query("installation").first();
    if (!install || install.mentionsAt === MENTIONS_DONE) return 0;
    if (install.mentionsAt === undefined) for (const page of await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", "person")).collect()) await noteAliases(ctx, page._id);
    const from = install.mentionsAt ?? -1;
    const batch = await ctx.db.query("memories").withIndex("by_created", (q) => q.gt("createdAt", from)).take(2000);
    await noteMentions(ctx, batch.filter((line) => !line.supersededBy).map((line) => line._id), await peopleByName(ctx));
    const first = batch[0]?.createdAt ?? 0;
    const last = batch.at(-1)?.createdAt ?? 0;
    // Lines written at the same moment as the last of a batch go in the next one too; noteMentions does nothing twice.
    const done = batch.length < 2000;
    await ctx.db.patch(install._id, { mentionsAt: done ? MENTIONS_DONE : first < last - 1 ? last - 1 : last });
    if (!done) await ctx.scheduler.runAfter(0, internal.pages.indexMentions, {});
    return batch.length;
  },
});


// --- Writing pages ------------------------------------------------------------------------------

export type NewPage = {
  title: string; content: string; author: Author; projectId?: Id<"projects">;
  kind?: PageKind; day?: string; person?: string; conversationId?: Id<"conversations">;
};

/** A new page, and its lines. */
export async function insertPage(ctx: Writer, input: NewPage): Promise<Id<"notes">> {
  const problem = tooLong(input.content, input.kind ? MEMORY_PAGE_LIMIT : CONTENT_LIMIT);
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
export async function writePage(ctx: Writer, page: Note, patch: { title?: string; content?: string }, author: Author, options: { typing?: boolean; hints?: Map<string, Id<"memories">>; spare?: Set<string> } = {}): Promise<Map<string, Id<"memories">>> {
  const title = patch.title === undefined || page.kind ? page.title : cleanTitle(patch.title);
  const content = patch.content ?? page.content;
  const problem = tooLong(content, page.kind ? MEMORY_PAGE_LIMIT : CONTENT_LIMIT);
  if (problem) throw new Error(problem);
  if (title === page.title && content === page.content) return new Map();
  await ctx.db.patch(page._id, { title, content, search: searchOf(title, content), revision: page.revision + 1, by: noteBy(author.by), updatedAt: Date.now() });
  const added = await syncLines(ctx, (await ctx.db.get(page._id))!, author, Date.now(), options.hints, options.spare);
  // The owner's saves from one sitting are one version; anyone else's are each their own.
  if (page.kind === "about" && content !== page.content) await recordUser(ctx, content, author.by, options.typing ?? author.by === "owner");
  return added;
}

/** Delete a page and its lines. A schedule that wrote to it stops writing anywhere. */
export async function removePage(ctx: Writer, id: Id<"notes">): Promise<void> {
  if (!await ctx.db.get(id)) return;
  for (const job of await ctx.db.query("jobs").collect()) if (job.noteId === id) await ctx.db.patch(job._id, { noteId: undefined });
  for (const line of await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", id)).collect()) await deleteLine(ctx, line._id);
  await ctx.db.delete(id);
}

/** A page moved into a project or out of one: its lines are read where it is now. */
export async function moveLines(ctx: Writer, pageId: Id<"notes">, projectId: Id<"projects"> | undefined): Promise<void> {
  for (const line of await linesOf(ctx, pageId)) if (line.projectId !== projectId) await ctx.db.patch(line._id, { projectId });
}

// --- No secrets in pages (issue #137) -----------------------------------------------------------

/** Shapes of keys and codes that never belong in a page: API keys, tokens, private keys, a password or PIN said outright. */
const SECRET_SHAPES = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bpass(?:word|code|phrase)\s*(?:is|was|:|=)\s*\S{4,}/i, /\b(?:pin|otp|one[- ]time code|cvv)\s*(?:is|was|:|=)\s*\d{3,}/i,
];

/**
 * Why words may not go into a page, or null: a value saved in Logins &
 * secrets, or something shaped like a password, key or code. Perry's writes
 * are refused with this; the owner's own typing is theirs.
 */
export async function secretIn(ctx: Reader, text: string): Promise<string | null> {
  if ((await savedValues(ctx)).some((value) => text.includes(value))) {
    return "Not saved: it contains a value kept in Logins & secrets, which stays there and never goes into a page or memory.";
  }
  if (SECRET_SHAPES.some((shape) => shape.test(text))) {
    return "Not saved: it looks like a password, key or code. Secrets never go into a page or memory; move it to Logins & secrets with save_secret.";
  }
  return null;
}

// --- Pages of memory ----------------------------------------------------------------------------

/** Where a memory lives. */
export type Place =
  | { kind: "about" }
  | { kind: "remember"; projectId?: Id<"projects"> }
  | { kind: "journal"; day: string; projectId?: Id<"projects"> }
  | { kind: "person"; name: string }
  | { kind: "chat"; conversationId: Id<"conversations"> };

/**
 * Where a memory goes: what a chat kept to itself to that chat's page; a
 * day's note to that day's journal; a standing preference to About me (a
 * project's to its Things to remember); a fact about someone else, kept for
 * every chat, to their page in People; any other fact to Things to remember,
 * the project's in a project.
 */
export function placeFor(kind: "profile" | "core" | "daily", day: string, args: { conversationId?: Id<"conversations">; projectId?: Id<"projects">; about?: string[] }): Place {
  if (args.conversationId) return { kind: "chat", conversationId: args.conversationId };
  if (kind === "daily") return { kind: "journal", day, ...(args.projectId ? { projectId: args.projectId } : {}) };
  if (kind === "profile") return args.projectId ? { kind: "remember", projectId: args.projectId } : { kind: "about" };
  const person = peopleIn(args.about)[0];
  if (person && !args.projectId) return { kind: "person", name: person };
  return { kind: "remember", ...(args.projectId ? { projectId: args.projectId } : {}) };
}

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
  if (await ctx.db.get(line._id)) await deleteLine(ctx, line._id);
}

/** A line's words changed where it stands, keeping its row (an edit, a to-do's news). */
export async function rewordLine(ctx: Writer, line: Line, text: string, author: Author): Promise<void> {
  const page = line.pageId ? await ctx.db.get(line.pageId) : null;
  const content = page ? replaceLine(page.content, line.text, text) : null;
  if (page && content !== null) await writePage(ctx, page, { content }, author, { hints: new Map([[sameKey(text), line._id]]) });
  const now = await ctx.db.get(line._id);
  if (now && now.text !== text.trim()) await ctx.db.patch(line._id, { text: text.trim(), by: author.by, editedAt: Date.now(), embedding: undefined, embeddedWith: undefined });
}

// --- Memories from before pages, moved into them (issue #210, step 4) --------------------------------

/**
 * A memory from before pages: a current row with no page that is not a line of
 * one of the owner's other pages. Perry moves each into its page when it
 * starts (migrate), after server/index.ts has written every row to a backup
 * file; one that cannot be moved stays as it is, and is still loaded and
 * recalled (standingFor).
 */
const isLoose = (line: Line) => !line.pageId && !line.supersededBy && line.kind !== "page";

/** Words that come back from a page as exactly one line: a blank line inside them would make two. */
const oneLine = (text: string) => text.trim().replace(/\n\s*\n+/g, "\n");

/**
 * Move every memory from before pages into its page, keeping the row: its id
 * (so citations, to-do links and asked threads hold), its words, layer, tags,
 * people, scope, source, origin and dates stay; it gains its page, place and
 * section, and when (migratedAt), and keeps its words as they were when they
 * had to become one line (migratedFrom). Pages it makes say so (migrated).
 * Lines are attached before the page is saved, so a save keeps them; one
 * whose words did not come back is left as it was rather than lost (spare).
 *
 * Idempotent: run whenever Perry starts and after an import, it moves what is
 * left, and nothing once done. Not after the owner moved them back out
 * (undoMigration), unless `again`.
 */
export const migrate = internalMutation({
  args: { again: v.optional(v.boolean()) },
  returns: v.object({ moved: v.number(), kept: v.number(), pages: v.number(), skipped: v.boolean() }),
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (install?.memoriesInPages === "undone") {
      if (!args.again) return { moved: 0, kept: 0, pages: 0, skipped: true };
      await ctx.db.patch(install._id, { memoriesInPages: undefined });
    }
    const loose = (await ctx.db.query("memories").withIndex("by_created").collect()).filter(isLoose);
    if (!loose.length) return { moved: 0, kept: 0, pages: 0, skipped: false };
    const timezone = await timezoneOf(ctx);
    const groups = new Map<string, { place: Place; lines: Array<{ line: Line; section?: string }> }>();
    for (const line of loose) {
      const kind = line.kind === "profile" || line.kind === "daily" ? line.kind : "core";
      // A day's note from before days were kept says the day it was made.
      const day = line.day ?? new Date(line.createdAt).toLocaleDateString("en-CA", { timeZone: timezone });
      const place = placeFor(kind, day, { conversationId: line.conversationId, projectId: line.projectId, about: line.about });
      const section = kind === "profile" ? PREFERENCES_SECTION : place.kind === "remember" ? sectionFor(line.text, line.tags, line.about) : undefined;
      const key = JSON.stringify(place.kind === "person" ? { kind: "person", name: personKey(place.name) } : place);
      const group = groups.get(key) ?? { place, lines: [] };
      group.lines.push({ line, section });
      groups.set(key, group);
    }
    const now = Date.now();
    let made = 0;
    for (const { place, lines } of groups.values()) {
      const existed = Boolean(await findPage(ctx, place));
      let page = await memoryPage(ctx, place);
      if (!existed) {
        await ctx.db.patch(page._id, { migrated: true });
        made++;
      }
      let content = page.content;
      const spare = new Set<string>();
      for (const { line, section } of lines.sort((a, b) => a.line.createdAt - b.line.createdAt)) {
        // As the line will read back from the page, so the save keeps the row as it is (a leading checkbox, say, would not).
        const once = oneLine(line.text);
        const read = blocksOf(itemOf(once));
        const text = read.length === 1 ? read[0].text : once;
        const item = itemOf(text);
        const placed = section ? editSection(content, section, item, "append") : null;
        content = placed && "content" in placed ? placed.content : appended(content, item);
        await ctx.db.patch(line._id, {
          pageId: page._id, order: Number.MAX_SAFE_INTEGER, section, migratedAt: now,
          ...(text !== line.text ? { text, migratedFrom: line.text, embedding: undefined, embeddedWith: undefined } : {}),
        });
        spare.add(line._id);
      }
      page = (await ctx.db.get(page._id))!;
      await writePage(ctx, page, { content }, { by: "owner" }, { spare });
    }
    const moved = (await ctx.db.query("memories").withIndex("by_created").collect()).filter((line) => line.migratedAt === now).length;
    return { moved, kept: loose.length - moved, pages: made, skipped: false };
  },
});

/**
 * Move memories back out of pages, exactly as they were before (`perry brain
 * move-back`): each moved row loses its page, place, section and migratedAt,
 * and gets its words back; their lines leave their pages; pages the move made
 * that are left empty are deleted. Lines of the owner's other pages, which
 * are made from them, go too (they come back when Perry starts). Memories
 * written in pages since stay, as the rows they are. Perry then leaves
 * memories where they are until `perry brain move-in`. With this, a Perry from
 * before pages reads memory as it was.
 */
export const undoMigration = internalMutation({
  args: {},
  returns: v.object({ movedBack: v.number(), pagesDeleted: v.number(), linesDropped: v.number() }),
  handler: async (ctx) => {
    const all = await ctx.db.query("memories").withIndex("by_created").collect();
    const moved = all.filter((line) => line.migratedAt);
    const byPage = new Map<string, Line[]>();
    for (const line of moved) if (line.pageId) byPage.set(line.pageId, [...(byPage.get(line.pageId) ?? []), line]);
    for (const line of moved) {
      await ctx.db.patch(line._id, {
        pageId: undefined, order: undefined, section: undefined, migratedAt: undefined,
        ...(line.migratedFrom !== undefined ? { text: line.migratedFrom, migratedFrom: undefined, embedding: undefined, embeddedWith: undefined } : {}),
      });
    }
    let pagesDeleted = 0;
    for (const [pageId, lines] of byPage) {
      const page = await ctx.db.get(pageId as Id<"notes">);
      if (!page) continue;
      let content = page.content;
      for (const line of lines) content = removeLine(content, line.text) ?? content;
      await writePage(ctx, page, { content }, { by: "owner" });
      const left = await linesOf(ctx, page._id);
      if (page.migrated && !left.length && !content.trim() && page.kind !== "about") {
        await removePage(ctx, page._id);
        pagesDeleted++;
      }
    }
    // The lines of the owner's other pages: an older Perry would take them for memories.
    let linesDropped = 0;
    for (const line of all) if (line.kind === "page") { await ctx.db.delete(line._id); linesDropped++; }
    for (const page of await ctx.db.query("notes").collect()) if (page.linesAt !== undefined && !page.kind) await ctx.db.patch(page._id, { linesAt: undefined });
    const install = await ctx.db.query("installation").first();
    if (install) await ctx.db.patch(install._id, { memoriesInPages: "undone" });
    return { movedBack: moved.length, pagesDeleted, linesDropped };
  },
});

// --- People ------------------------------------------------------------------------------------------

/**
 * Every person a memory names has a page in People. A memory is one row in
 * one page: a fact about one person on theirs, about several on the first
 * one's, a day's note in its journal. The other people's pages show it as
 * well, computed from `about` (mentionsOf), rather than holding a copy: a
 * copy would be a second memory to keep in step, would be sent twice when
 * both pages are pinned, and would come back twice from recall.
 */

/** The one contact with this name, if exactly one person is called so; groups never. */
async function contactNamed(ctx: Reader, name: string): Promise<Id<"contacts"> | undefined> {
  const matches = (await ctx.db.query("contacts").collect()).filter((contact) => contact.kind === "person" && personKey(contact.name) === personKey(name));
  return matches.length === 1 ? matches[0]._id : undefined;
}

/** Whether a memory belongs to a chat with someone else, whose people are theirs, not the owner's. */
async function guestOnly(ctx: Reader, line: Line): Promise<boolean> {
  const chat = line.conversationId ? await ctx.db.get(line.conversationId) : null;
  return Boolean(chat?.contactId);
}

/** A page in People for each of these names that has none yet, linked to their contact; the pages made. */
export async function ensurePeople(ctx: Writer, names: string[], options: { migrated?: boolean } = {}): Promise<number> {
  let made = 0;
  for (const name of names) {
    const found = await findPage(ctx, { kind: "person", name });
    const page = found ?? await memoryPage(ctx, { kind: "person", name });
    if (!found) {
      made++;
      if (options.migrated) await ctx.db.patch(page._id, { migrated: true });
    }
    if (!page.contactId) {
      const contactId = await contactNamed(ctx, name);
      if (contactId) await ctx.db.patch(page._id, { contactId });
    }
  }
  return made;
}

/** The people named in the owner's memories (not those of chats with someone else). */
async function peopleNamed(ctx: Reader): Promise<string[]> {
  const names = new Map<string, string>();
  for (const line of await ctx.db.query("memories").withIndex("by_created").collect()) {
    if (line.supersededBy || line.kind === "page" || !line.about?.length || await guestOnly(ctx, line)) continue;
    for (const name of peopleIn(line.about)) if (!names.has(personKey(name))) names.set(personKey(name), name);
  }
  return [...names.values()];
}

/** How many people named in memories have no page yet: what fixPeople would make. */
export const peopleMissing = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // Memory moved back out of pages (undoMigration) stays as it is.
    if ((await ctx.db.query("installation").first())?.memoriesInPages === "undone") return 0;
    let missing = 0;
    for (const name of await peopleNamed(ctx)) if (!await findPage(ctx, { kind: "person", name })) missing++;
    return missing;
  },
});

/**
 * For installs moved into pages before every person got a page (issue #218):
 * a page in People for each person a memory names, linked to their contact
 * when one has that name alone. It adds pages and nothing else: no memory
 * moves or changes, since each page shows the memories about its person
 * wherever they are (mentionsOf). Run whenever Perry starts and after an
 * import, after server/index.ts has backed up; nothing once done.
 */
export const fixPeople = internalMutation({
  args: {},
  returns: v.object({ made: v.number() }),
  handler: async (ctx) => {
    if ((await ctx.db.query("installation").first())?.memoriesInPages === "undone") return { made: 0 };
    return { made: await ensurePeople(ctx, await peopleNamed(ctx), { migrated: true }) };
  },
});

export type Mention = { id: Id<"memories">; text: string; page: { id: Id<"notes">; title: string; kind?: PageKind }; day?: string };

/**
 * The memories about a person that live on other pages (a journal day,
 * Things to remember, another person's page): one row each, shown on theirs.
 * From a chat, only what that chat may see.
 */
export async function mentionsOf(ctx: Reader, page: Note, seen: (line: Line) => boolean = () => true): Promise<Mention[]> {
  if (page.kind !== "person" || !page.person) return [];
  const titles = new Map<string, Note | null>();
  const found: Mention[] = [];
  // Once every line's mentions are kept (indexMentions), only the lines that mention them are read, not all of Brain.
  const indexed = (await ctx.db.query("installation").first())?.mentionsAt === MENTIONS_DONE;
  const candidates = indexed
    ? (await Promise.all((await ctx.db.query("mentions").withIndex("by_person", (q) => q.eq("person", page.person)).collect()).map((mention) => ctx.db.get(mention.lineId))))
      .filter((line): line is Line => Boolean(line)).sort((a, b) => b.createdAt - a.createdAt)
    : await ctx.db.query("memories").withIndex("by_created").order("desc").collect();
  for (const line of candidates) {
    if (line.supersededBy || line.kind === "page" || line.pageId === page._id || !line.about?.length) continue;
    if (!peopleIn(line.about).some((name) => personKey(name) === page.person) || !seen(line) || await guestOnly(ctx, line)) continue;
    if (line.pageId && !titles.has(line.pageId)) titles.set(line.pageId, await ctx.db.get(line.pageId));
    const home = line.pageId ? titles.get(line.pageId) : null;
    if (!home) continue;
    found.push({ id: line._id, text: line.text, page: { id: home._id, title: home.title, ...(home.kind ? { kind: home.kind } : {}) }, ...(line.day ? { day: line.day } : {}) });
  }
  return found;
}

/** A person's page's memories that live on other pages, for the page editor. */
export const mentions = query({
  args: { key: v.string(), id: v.string() },
  handler: async (ctx, args): Promise<Mention[]> => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("notes", args.id);
    const page = id ? await ctx.db.get(id) : null;
    return page ? await mentionsOf(ctx, page) : [];
  },
});

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

// --- What every turn is sent: pinned pages, within a budget -------------------------------------

/** Pinned: About me and Things to remember unless unpinned; anything else once pinned. */
export const isPinned = (page: Pick<Note, "pinned" | "kind">) => page.pinned ?? (page.kind === "about" || page.kind === "remember");

const DAY_MS = 86_400_000;
const STALE_AFTER_MS = 90 * DAY_MS;
const dayAgo = (timezone: string, offset: number) => new Date(Date.now() - offset * DAY_MS).toLocaleDateString("en-CA", { timeZone: timezone });

/** A memory's id, and what to know of it: where it is kept, the to-do it follows, and when it was noted if long ago. */
function ref(line: Line): string {
  const notes: string[] = [];
  if (line.conversationId) notes.push("this chat only");
  else if (line.projectId) notes.push("this project only");
  if (line.todoId) notes.push(`follows to-do ${line.todoId}`);
  const at = Math.max(line.confirmedAt ?? 0, line.editedAt ?? 0, line.createdAt);
  if (!line.day && Date.now() - at >= STALE_AFTER_MS) {
    const months = Math.round((Date.now() - at) / (30 * DAY_MS));
    const age = months >= 24 ? `${Math.round(months / 12)} years ago` : months >= 12 ? "over a year ago" : `${months} months ago`;
    notes.push(`noted ${new Date(at).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}, ${age}: may have changed; check with the owner before relying on it`);
  }
  return ` (${[line._id, ...notes].join("; ")})`;
}
const memoryLine = (line: Line) => `- ${line.day ? `[${line.day}] ` : ""}${line.text.replace(/\n/g, " ")}${line.tags.map((tag) => ` #${tag}`).join("")}${ref(line)}`;

export type Standing = {
  about: string; standing: string; shown: string[]; used: number; budget: number;
  /** The sections sent condensed, by page and section, for the lines that match a message (memories.context). */
  condensed: Array<{ pageId: Id<"notes">; title: string; section?: string; lines: number }>;
  /** Their names, for the dashboard ("Things to remember: Work"). */
  left: string[];
};

type Entry = { text: string; id?: string; at?: number };
type Section = { name?: string; entries: Entry[] };
type Part = { title: string; page?: Note; sections: Section[]; fixed?: boolean };

const sizeOf = (section: Section) => section.entries.reduce((sum, entry) => sum + entry.text.length + 1, (section.name?.length ?? 0) + 5);

/**
 * A big section as it is sent when what is pinned is over the budget: its
 * written summary (the nightly consolidation keeps one, brain_summarize), or
 * until there is one its newest lines; and how to read the rest. Lines of it
 * that bear on the message are sent after it (memories.context).
 */
function condensedText(part: Part, section: Section, pointerOnly: boolean): string {
  const lines = section.entries.filter((entry) => entry.id).length || section.entries.length;
  const read = `brain_read page="${part.page?.title ?? part.title}"${section.name ? ` section="${section.name}"` : ""}`;
  const head = `${lines.toLocaleString("en-US")} lines, sent condensed to stay within what every message carries; the lines that match a message come below, and ${read} has all of them.`;
  if (pointerOnly) return head;
  const summary = part.page?.summaries?.find((item) => (item.section ?? "") === (section.name ?? ""));
  if (summary) return `${head}\nSummary (written ${new Date(summary.at).toISOString().slice(0, 10)}, of ${summary.lines.toLocaleString("en-US")} lines): ${summary.text}`;
  const newest = [...section.entries].filter((entry) => entry.id).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 6);
  return `${head}\nNo summary yet; the newest:\n${newest.map((entry) => entry.text.split("\n").at(-1)!.slice(0, 220)).join("\n")}`;
}

/**
 * What a chat's every turn starts with (memories.context): About me for the
 * instructions, whole; then as data the rest of what is pinned, in a fixed
 * order (so an engine's prompt cache keeps it): the Lately page, Things to
 * remember, this chat's page, today's and yesterday's journal, memories not
 * yet in a page, and what the owner pinned, oldest pin first.
 *
 * Within `budget` characters (lib/budget.ts, a share of the engine's context
 * window): when it is over, the biggest sections are sent condensed first,
 * each as its summary and where to read the rest, until it fits; if even that
 * is too much, the condensed ones lose their summaries, then smaller sections
 * are condensed too. Nothing is left out without a word. The choice depends
 * only on what is pinned, not on the message, so the block stays the same
 * from turn to turn until a pinned page changes. A chat with someone else
 * gets none of it.
 */
export async function standingFor(ctx: Reader, chatId?: Id<"conversations">, budget = pinnedBudget()): Promise<Standing> {
  const chat = chatId ? await ctx.db.get(chatId) : null;
  const none: Standing = { about: "", standing: "", shown: [], used: 0, budget, condensed: [], left: [] };
  if (chat?.contactId) return none;
  const project = chat?.projectId;
  const reach = (page: Note) => (page.conversationId ? page.conversationId === chat?._id : !page.projectId || page.projectId === project);
  const ofKind = async (kind: PageKind) => (await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", kind)).collect()).filter((page) => page.kind === kind && reach(page));
  const timezone = await timezoneOf(ctx);
  const days = [dayAgo(timezone, 0), dayAgo(timezone, 1)];
  const ordered = async (page: Note) => (await linesOf(ctx, page._id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const lineAt = (line: Line) => Math.max(line.createdAt, line.editedAt ?? 0, line.confirmedAt ?? 0);

  /** A page of memory's lines, by section. */
  const linesIn = async (page: Note, only?: string[]): Promise<Section[]> => {
    const sections: Section[] = [];
    for (const line of await ordered(page)) {
      if (only && !only.includes(line.section ?? "")) continue;
      if (sections.at(-1)?.name !== line.section || !sections.length) sections.push({ name: line.section, entries: [] });
      sections.at(-1)!.entries.push({ text: memoryLine(line), id: line._id, at: lineAt(line) });
    }
    return sections;
  };
  /** An ordinary page's words, block by block, by section. */
  const wordsIn = async (page: Note, only?: string[]): Promise<Section[]> => {
    const lines = page.content.replace(/\r\n?/g, "\n").split("\n");
    const rows = new Map((await ordered(page)).map((row) => [sameKey(row.text), row]));
    const sections: Section[] = [];
    for (const block of blocksOf(page.content)) {
      if (only && !only.includes(block.section ?? "")) continue;
      if (sections.at(-1)?.name !== block.section || !sections.length) sections.push({ name: block.section, entries: [] });
      const row = rows.get(sameKey(block.text));
      sections.at(-1)!.entries.push({ text: lines.slice(block.start, block.end + 1).join("\n"), ...(row ? { id: row._id, at: lineAt(row) } : {}) });
    }
    return sections;
  };

  // About me goes with the instructions, whole: it is the owner's own account of themselves.
  const aboutPage = (await ofKind("about")).find((page) => !page.projectId);
  const aboutParts: Part[] = [];
  if (aboutPage ? isPinned(aboutPage) && aboutPage.content.trim() : false) {
    aboutParts.push({ title: `About me (USER.md, the owner's own page; id ${aboutPage!._id})`, page: aboutPage!, sections: await wordsIn(aboutPage!), fixed: true });
  } else if (!aboutPage) {
    const user = (await ctx.db.query("persona").withIndex("by_kind", (q) => q.eq("kind", "user")).order("desc").first())?.text?.trim();
    if (user) aboutParts.push({ title: "About the owner (USER.md)", sections: [{ entries: user.split(/\n{2,}/).map((text) => ({ text })) }], fixed: true });
  }
  // Memories from before pages, until they are moved into theirs (pages.migrate).
  const loose = (await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", undefined)).collect()).filter((line) => !line.pageId && !line.supersededBy && line.kind !== "page"
    && (line.conversationId ? line.conversationId === chat?._id : !line.projectId || line.projectId === project));
  const asEntries = (lines: Line[]) => lines.map((line) => ({ text: memoryLine(line), id: line._id, at: lineAt(line) }));
  const looseProfile = loose.filter((line) => line.kind === "profile");
  if (looseProfile.length) aboutParts.push({ title: "Owner profile", sections: [{ entries: asEntries(looseProfile) }], fixed: true });

  const parts: Part[] = [];
  const pinnedPages = (await ctx.db.query("notes").withIndex("by_pinned", (q) => q.gt("pinnedAt", 0)).collect()).filter(reach);
  const lately = pinnedPages.find((page) => page.lately && isPinned(page));
  if (lately) parts.push({ title: `Lately, the last two weeks (id ${lately._id})`, page: lately, sections: await wordsIn(lately) });
  const remember = (await ofKind("remember")).filter(isPinned).sort((a, b) => (a.projectId ? 1 : 0) - (b.projectId ? 1 : 0));
  for (const page of remember) parts.push({ title: page.projectId ? "Things to remember in this project" : "Things to remember", page, sections: await linesIn(page) });
  for (const page of await ofKind("chat")) parts.push({ title: "Kept to this chat", page, sections: await linesIn(page) });
  const journal: Entry[] = [];
  const journalPages = (await ofKind("journal")).filter((page) => days.includes(page.day ?? ""));
  for (const day of days) for (const page of journalPages.filter((item) => item.day === day)) for (const section of await linesIn(page)) journal.push(...section.entries);
  if (journal.length) parts.push({ title: "Journal, today and yesterday", page: journalPages.find((page) => page.day === days[0]) ?? journalPages[0], sections: [{ entries: journal }] });
  // Memories from before pages were all loaded before, so they come before what the owner pinned since.
  const looseCore = loose.filter((line) => line.kind !== "profile" && line.kind !== "daily");
  if (looseCore.length) parts.push({ title: "Long-term memory not yet in a page", sections: [{ entries: asEntries(looseCore) }] });
  const looseDays = loose.filter((line) => line.kind === "daily" && days.includes(line.day ?? ""));
  if (looseDays.length) parts.push({ title: "Notes from today and yesterday not yet in a page", sections: [{ entries: asEntries(looseDays) }] });
  const pinned = pinnedPages.filter((page) => page !== lately && page.kind !== "about" && page.kind !== "remember" && page.kind !== "chat" && !(page.kind === "journal" && days.includes(page.day ?? ""))
    && (isPinned(page) || page.pinnedSections?.length)).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
  const shownSoFar = new Set<string>();
  for (const part of parts) for (const section of part.sections) for (const entry of section.entries) if (entry.id) shownSoFar.add(entry.id);
  for (const page of pinned) {
    const sections = isPinned(page) ? undefined : page.pinnedSections;
    const title = `Pinned: ${page.title}${sections ? ` (${sections.join(", ")})` : ""}${page.kind ? "" : `, a page (id ${page._id})`}`;
    const content = page.kind ? await linesIn(page, sections) : await wordsIn(page, sections);
    // A person's page has their memories that live elsewhere too, each once: one already sent above is not sent again.
    if (page.kind === "person" && !sections) {
      const elsewhere: Entry[] = [];
      for (const mention of await mentionsOf(ctx, page, (line) => (line.conversationId ? line.conversationId === chat?._id : !line.projectId || line.projectId === project))) {
        if (!shownSoFar.has(mention.id)) elsewhere.push({ text: `- [${mention.page.title}] ${mention.text.replace(/\n/g, " ")} (${mention.id})`, id: mention.id });
      }
      if (elsewhere.length) content.push({ name: "On other pages", entries: elsewhere });
    }
    parts.push({ title, page, sections: content });
  }

  // Over the budget: the biggest sections condensed first, then without their summaries, then smaller ones.
  type Choice = { part: Part; section: Section; size: number; mode: "whole" | "summary" | "pointer" };
  const choices: Choice[] = parts.flatMap((part) => part.sections.map((section) => ({ part, section, size: sizeOf(section), mode: "whole" as const })));
  const fixedSize = aboutParts.reduce((sum, part) => sum + part.sections.reduce((inner, section) => inner + sizeOf(section), part.title.length + 4), 0);
  const costOf = (choice: Choice) => (choice.mode === "whole" ? choice.size : condensedText(choice.part, choice.section, choice.mode === "pointer").length + (choice.section.name?.length ?? 0) + 8);
  const total = () => fixedSize + parts.reduce((sum, part) => sum + part.title.length + 4, 0) + choices.reduce((sum, choice) => sum + costOf(choice), 0);
  const bySize = [...choices].sort((a, b) => b.size - a.size);
  for (const floor of [CONDENSE_FROM, 300, 0]) {
    for (const choice of bySize) {
      if (total() <= budget) break;
      if (choice.mode === "whole" && choice.size >= floor && costOf({ ...choice, mode: "summary" }) < choice.size) (choice as { mode: Choice["mode"] }).mode = "summary";
    }
    if (total() <= budget) break;
    for (const choice of bySize) {
      if (total() <= budget) break;
      if (choice.mode === "summary") (choice as { mode: Choice["mode"] }).mode = "pointer";
    }
  }

  const shown: string[] = [];
  const condensed: Standing["condensed"] = [];
  const render = (part: Part, modeOf: (section: Section) => Choice["mode"]) => {
    const body = part.sections.map((section) => {
      const mode = modeOf(section);
      const heading = section.name ? `### ${section.name}${mode === "whole" ? "" : " (condensed)"}\n` : mode === "whole" ? "" : "(condensed)\n";
      if (mode === "whole") {
        for (const entry of section.entries) if (entry.id) shown.push(entry.id);
        return `${heading}${section.entries.map((entry) => entry.text).join("\n")}`;
      }
      if (part.page) condensed.push({ pageId: part.page._id, title: part.page.title, ...(section.name ? { section: section.name } : {}), lines: section.entries.length });
      return `${heading}${condensedText(part, section, mode === "pointer")}`;
    }).filter(Boolean).join("\n");
    return body ? `## ${part.title}\n${body}` : "";
  };
  const about = aboutParts.map((part) => render(part, () => "whole")).filter(Boolean).join("\n\n");
  const modes = new Map(choices.map((choice) => [choice.section, choice.mode]));
  const standing = parts.map((part) => render(part, (section) => modes.get(section) ?? "whole")).filter(Boolean).join("\n\n");
  const left = [...new Set(condensed.map((item) => (item.section ? `${item.title}: ${item.section}` : item.title)))];
  return { about, standing, shown, used: about.length + standing.length, budget, condensed, left };
}

export const standing = internalQuery({
  args: { chat: v.optional(v.id("conversations")), budget: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Standing> => await standingFor(ctx, args.chat, args.budget),
});

/** Pin a page, or one of its sections, to every chat that may read it; or unpin it. */
export async function setPinned(ctx: Writer, page: Note, pinned: boolean, section?: string): Promise<void> {
  if (section) {
    const sections = new Set(page.pinnedSections ?? []);
    if (pinned) sections.add(section); else sections.delete(section);
    await ctx.db.patch(page._id, { pinnedSections: sections.size ? [...sections] : undefined, ...(pinned ? { pinnedAt: Date.now() } : {}) });
    return;
  }
  await ctx.db.patch(page._id, { pinned, pinnedAt: pinned ? Date.now() : page.pinnedAt });
}

export const pin = mutation({
  args: { key: v.string(), id: v.id("notes"), pinned: v.boolean(), section: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const page = await ctx.db.get(args.id);
    if (!page) throw new Error("This page was deleted.");
    await setPinned(ctx, page, args.pinned, args.section);
    return null;
  },
});

/** How much of the budget what is pinned uses, as a chat outside any project sees it. */
// --- Section summaries and Lately (issue #220) --------------------------------------------------

/** A summary older than this, or written when its section had a sixth more or fewer lines, is due again. */
const SUMMARY_STALE_MS = 7 * DAY_MS;

export type SummaryDue = { page: string; id: Id<"notes">; section?: string; lines: number; chars: number; summarized?: string };

/** The big sections of pinned pages, each with its size and whether its summary is missing or out of date. */
async function sectionsOf(ctx: Reader, page: Note): Promise<Array<{ section?: string; lines: number; chars: number }>> {
  const sizes = new Map<string, { section?: string; lines: number; chars: number }>();
  for (const line of await linesOf(ctx, page._id)) {
    const key = line.section ?? "";
    const size = sizes.get(key) ?? { ...(line.section ? { section: line.section } : {}), lines: 0, chars: 0 };
    size.lines++;
    size.chars += line.text.length + 3;
    sizes.set(key, size);
  }
  return [...sizes.values()];
}

/** The sections a summary is due for: big ones of pinned pages, with none or an old one. */
export async function summariesDue(ctx: Reader): Promise<SummaryDue[]> {
  const pages = [
    ...(await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", "remember")).collect()),
    ...(await ctx.db.query("notes").withIndex("by_pinned", (q) => q.gt("pinnedAt", 0)).collect()),
  ].filter((page, index, all) => all.findIndex((other) => other._id === page._id) === index && isPinned(page) && page.kind !== "about" && !page.lately);
  const due: SummaryDue[] = [];
  for (const page of pages) {
    for (const size of await sectionsOf(ctx, page)) {
      if (size.chars < CONDENSE_FROM) continue;
      const summary = page.summaries?.find((item) => (item.section ?? "") === (size.section ?? ""));
      const fresh = summary && Date.now() - summary.at < SUMMARY_STALE_MS && Math.abs(summary.lines - size.lines) <= size.lines / 6;
      if (!fresh) due.push({ page: page.title, id: page._id, ...(size.section ? { section: size.section } : {}), lines: size.lines, chars: size.chars, ...(summary ? { summarized: new Date(summary.at).toISOString().slice(0, 10) } : {}) });
    }
  }
  return due.sort((a, b) => b.chars - a.chars).slice(0, 20);
}

/**
 * Perry's brain_summarize: without words, the big pinned sections whose
 * summary is missing or out of date; with them, the summary of one section,
 * which is what that section is sent as while it is too big to send whole.
 */
export const summarizeForAgent = internalMutation({
  args: { chat: v.optional(v.id("conversations")), page: v.optional(v.string()), section: v.optional(v.string()), text: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ due?: SummaryDue[]; saved?: { page: string; section?: string }; error?: string }> => {
    const chat = args.chat ? await ctx.db.get(args.chat) : null;
    if (chat?.contactId) return { error: "Not from a chat with someone else." };
    if (!args.text?.trim()) return { due: await summariesDue(ctx) };
    const raw = args.page?.trim() ?? "";
    const id = ctx.db.normalizeId("notes", raw);
    const page = id ? await ctx.db.get(id) : (await ctx.db.query("notes").withIndex("by_title", (q) => q.eq("title", raw)).collect()).find((item) => !item.projectId || item.projectId === chat?.projectId) ?? null;
    if (!page) return { error: `No page "${raw}".` };
    const section = args.section?.trim() || undefined;
    const size = (await sectionsOf(ctx, page)).find((item) => (item.section ?? "").toLocaleLowerCase() === (section ?? "").toLocaleLowerCase());
    if (!size) return { error: `"${page.title}" has no section "${section ?? "(top)"}".` };
    const secret = await secretIn(ctx, args.text);
    if (secret) return { error: secret };
    const text = args.text.trim().replace(/\s+/g, " ").slice(0, SUMMARY_LIMIT);
    const summaries = (page.summaries ?? []).filter((item) => (item.section ?? "") !== (size.section ?? ""));
    summaries.push({ ...(size.section ? { section: size.section } : {}), text, lines: size.lines, at: Date.now() });
    await ctx.db.patch(page._id, { summaries });
    return { saved: { page: page.title, ...(size.section ? { section: size.section } : {}) } };
  },
});

/**
 * Perry's brain_lately: the Lately page, the last two weeks in short, written
 * whole each time by the nightly consolidation. Pinned, and sent right after
 * About me (standingFor). Made the first time.
 */
export const writeLately = internalMutation({
  args: { chat: v.optional(v.id("conversations")), text: v.string() },
  handler: async (ctx, args): Promise<{ id?: Id<"notes">; error?: string }> => {
    const chat = args.chat ? await ctx.db.get(args.chat) : null;
    if (chat?.contactId) return { error: "Not from a chat with someone else." };
    const secret = await secretIn(ctx, args.text);
    if (secret) return { error: secret };
    const content = `${args.text.trim()}\n`;
    const found = (await ctx.db.query("notes").withIndex("by_title", (q) => q.eq("title", "Lately")).collect()).find((page) => page.lately && !page.projectId);
    if (found) {
      await writePage(ctx, found, { content }, { by: "job" });
      return { id: found._id };
    }
    const id = await insertPage(ctx, { title: "Lately", content, author: { by: "job" } });
    await ctx.db.patch(id, { lately: true, pinned: true, pinnedAt: Date.now() });
    return { id };
  },
});

export const pinnedUsage = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ used: number; budget: number; left: string[]; engine?: string }> => {
    assertDashboardKey(args.key);
    // As the default engine sends it: a chat on another engine has that engine's share (lib/budget.ts).
    const engine = (await ctx.db.query("installation").first())?.defaultEngine;
    const { used, budget, left } = await standingFor(ctx, undefined, pinnedBudget(engine));
    return { used, budget, left, ...(engine ? { engine } : {}) };
  },
});

// --- The dashboard ------------------------------------------------------------------------------

export type MemoryPage = {
  id: Id<"notes">; kind: PageKind | "page"; title: string; day?: string; projectId?: Id<"projects">; project?: string;
  conversationId?: Id<"conversations">; updatedAt: number; pinned: boolean; pinnedSections?: string[];
};

/** Every page of memory, for the Memory page: About me, Things to remember, the journal (newest day first), people, chats. */
export const memoryPages = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<MemoryPage[]> => {
    assertDashboardKey(args.key);
    const names = new Map((await ctx.db.query("projects").collect()).map((project) => [project._id as string, project.name]));
    const pages: MemoryPage[] = [];
    for (const kind of ["about", "remember", "journal", "person", "chat", undefined] as const) {
      // Other pages are listed here only when pinned.
      // Each page once: the kind is checked here too, as an index range on "no kind" can return every page.
      const rows = (await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", kind)).collect())
        .filter((page) => (kind ? page.kind === kind : !page.kind) && (kind || isPinned(page) || page.pinnedSections?.length));
      if (kind === "journal") rows.sort((a, b) => (b.day ?? "").localeCompare(a.day ?? ""));
      else if (kind === "person") rows.sort((a, b) => a.title.localeCompare(b.title));
      for (const page of rows) {
        pages.push({
          // No count of lines: reading every page's lines would read all of Brain each time the list is shown.
          id: page._id, kind: kind ?? "page", title: page.title, updatedAt: page.updatedAt,
          pinned: isPinned(page), ...(page.pinnedSections?.length ? { pinnedSections: page.pinnedSections } : {}),
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
  /** The pages it was promoted from (the journal days), to open. */
  basedOn?: Array<{ id: Id<"notes">; title: string }>;
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
        ...(line.basedOn?.length ? { basedOn: await basedOnPages(ctx, line.basedOn) } : {}),
      });
    }
    return views;
  },
});

/** The pages the lines a memory was promoted from are in, once each. */
async function basedOnPages(ctx: Reader, ids: Id<"memories">[]): Promise<Array<{ id: Id<"notes">; title: string }>> {
  const pages = new Map<string, string>();
  for (const id of ids) {
    const line = await ctx.db.get(id);
    const page = line?.pageId ? await ctx.db.get(line.pageId) : null;
    if (page) pages.set(page._id, page.title);
  }
  return [...pages].map(([id, title]) => ({ id: id as Id<"notes">, title }));
}

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
