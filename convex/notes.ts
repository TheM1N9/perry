import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { appended, editSection, headingsOf, INBOX_TITLE, noteHref, titleFrom, tooLong } from "./lib/notes";
import { journalTitle, type PageKind } from "./lib/pages";
import { around, linkedIds, type BrainGraph } from "./lib/graph";
import { neighbourhoodOf } from "./brainMap";
import { timezoneOf } from "./jobs";
import { insertPage, isPinned, linesOf, memoryPage, mentionsOf, moveLines, removePage, secretIn, setPinned, writePage, type LineBy } from "./pages";
import { readPersona } from "./persona";

/**
 * Notes: pages of Markdown the owner and Perry both read and write. A trip
 * plan, a packing list, meeting notes, a weekly review: what is read and
 * edited as a whole, where memory (memories.ts) is short facts about the
 * owner's life that Perry recalls by itself.
 *
 * - Revisions. Every save names the revision it was made from, and a save
 *   from an older one is refused with the newer note, so neither the owner's
 *   editor nor Perry ever writes over words they have not seen. Adding to the
 *   end cannot lose anything, so Perry's appends need no revision; the owner's
 *   editor then sees a newer note and keeps their draft until they choose.
 * - Where. A note in a project is reached only from that project's chats (and
 *   the dashboard); one in no project from every chat of the owner's. A chat
 *   with someone else reaches none: its tools do not include them (mcp.ts),
 *   and every function here refuses it too.
 * - Storage. Rows in Perry's SQLite database, like everything else of his:
 *   a save and its revision check are one transaction, the dashboard follows a
 *   note live, and a backup of perry.sqlite has them all. Each note downloads
 *   as a .md file, and a .md file opens as a new note.
 */

// Adapted from CopilotKit/OpenDots (MIT): src/server/pages.ts (revision-checked saves)

type Note = Doc<"notes">;
type Chat = Doc<"conversations">;
type Reader = { db: QueryCtx["db"] };
type Writer = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] };
type By = "owner" | "assistant";

const vKey = v.string();
const PREVIEW = 140;
const COMMENTS = /\n?<!--[\s\S]*?-->/g;

export type NoteSummary = {
  id: Id<"notes">;
  title: string;
  projectId?: Id<"projects">;
  project?: string;
  preview: string;
  by: By;
  updatedAt: number;
  /** Loaded into every chat that may read it (pages.isPinned), whole or by sections. */
  pinned: boolean;
  pinnedSections?: string[];
  /** A page of memory (pages.ts): what it is. Brain lists these in their own groups, not among the owner's pages. */
  kind?: PageKind;
};
export type NoteView = NoteSummary & {
  content: string;
  revision: number;
  createdAt: number;
  from?: { id: Id<"conversations">; title: string };
  /** A journal page's day. */
  day?: string;
};

const previewOf = (content: string) => {
  // Each line's block marker (a heading's #s, a bullet, a checkbox, a quote) and emphasis go; the words stay as written.
  const text = content.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "").replace(/\*\*|`|\||(^|\W)_+|_+(?=\W|$)/g, "$1 ").replace(/\s+/g, " ").trim();
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1).trimEnd()}…` : text;
};

async function projectNames(ctx: Reader): Promise<Map<string, string>> {
  return new Map((await ctx.db.query("projects").collect()).map((project) => [project._id as string, project.name]));
}

function summary(note: Note, names: Map<string, string>): NoteSummary {
  return {
    id: note._id,
    title: note.title,
    ...(note.projectId ? { projectId: note.projectId, project: names.get(note.projectId) } : {}),
    preview: previewOf(note.content),
    by: note.by,
    updatedAt: note.updatedAt,
    pinned: isPinned(note),
    ...(note.pinnedSections?.length ? { pinnedSections: note.pinnedSections } : {}),
    ...(note.kind ? { kind: note.kind } : {}),
  };
}

async function view(ctx: Reader, note: Note): Promise<NoteView> {
  const chat = note.from ? await ctx.db.get(note.from) : null;
  return {
    ...summary(note, await projectNames(ctx)),
    content: note.content,
    revision: note.revision,
    createdAt: note.createdAt,
    ...(chat ? { from: { id: chat._id, title: chat.title ?? "Untitled chat" } } : {}),
    ...(note.kind ? { kind: note.kind } : {}),
    ...(note.day ? { day: note.day } : {}),
  };
}

/** Every note, newest first, without the pages of memory (pages.ts), which the Memory page lists. A few hundred at most, so read whole. */
const allNotes = async (ctx: Reader) => (await ctx.db.query("notes").withIndex("by_updated").order("desc").collect()).filter((note) => !note.kind);

async function getNote(ctx: Reader, raw: string): Promise<Note | null> {
  const id = ctx.db.normalizeId("notes", raw);
  return id ? await ctx.db.get(id) : null;
}

async function insertNote(ctx: Writer, input: { title: string; content: string; by: By; projectId?: Id<"projects">; from?: Id<"conversations"> }): Promise<Id<"notes">> {
  return await insertPage(ctx, { title: input.title, content: input.content, author: { by: input.by, ...(input.from ? { from: input.from } : {}) }, ...(input.projectId ? { projectId: input.projectId } : {}) });
}

/**
 * A save of what changed, as the next revision, and its lines brought up to it (pages.writePage): `line` says who
 * wrote what changed, when not `by` itself (a job's run), and from which chat. The caller has checked the revision it was made from.
 */
async function writeNote(ctx: Writer, note: Note, patch: { title?: string; content?: string }, by: By, line?: { by: LineBy; from?: Id<"conversations"> }): Promise<number> {
  await writePage(ctx, note, patch, line ?? { by });
  return (await ctx.db.get(note._id))!.revision;
}

/** The owner's Inbox note, made the first time something is noted. Never in a project. */
async function inbox(ctx: Writer): Promise<Note> {
  const found = (await ctx.db.query("notes").withIndex("by_title", (q) => q.eq("title", INBOX_TITLE)).collect()).find((note) => !note.projectId && !note.kind);
  if (found) return found;
  return (await ctx.db.get(await insertNote(ctx, { title: INBOX_TITLE, content: "", by: "owner" })))!;
}

/** "- words (2 Oct, 14:05)": a line noted in a hurry, with when. */
async function jotLine(ctx: Reader, text: string): Promise<string> {
  const timezone = await timezoneOf(ctx);
  const when = new Date().toLocaleString("en-GB", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const lines = text.trim().split("\n");
  return `- ${lines[0]} _(${when})_${lines.length > 1 ? `\n${lines.slice(1).map((line) => `  ${line}`).join("\n")}` : ""}`;
}

async function jotInto(ctx: Writer, text: string, by: By): Promise<{ id: Id<"notes">; title: string }> {
  if (!text.trim()) throw new Error("Say what to note.");
  const note = await inbox(ctx);
  await writeNote(ctx, note, { content: appended(note.content, await jotLine(ctx, text)) }, by);
  return { id: note._id, title: note.title };
}

/** A message's words, without the comments that mark its files and memories. */
const wordsOf = (text: string) => text.replace(COMMENTS, "").trim();

/**
 * A note from a chat: one reply, or the whole chat as "You:" and "Perry:"
 * turns. It goes in the chat's project when the chat is in one.
 */
async function noteFromChat(ctx: Writer, chat: Chat, by: By, messageId?: string): Promise<{ id: Id<"notes">; title: string }> {
  const project = chat.projectId && !chat.contactId && await ctx.db.get(chat.projectId) ? chat.projectId : undefined;
  const messages = await ctx.db.query("agentMessages")
    .withIndex("by_thread_order", (q) => q.eq("threadId", chat.threadId as Id<"agentThreads">))
    .collect();
  if (messageId) {
    const message = messages.find((item) => item._id === messageId);
    if (!message) throw new Error("That message is no longer in this chat.");
    const words = wordsOf(message.text);
    if (!words) throw new Error("That message has no words to save.");
    const id = await insertNote(ctx, { title: titleFrom(words), content: `${words}\n`, by, from: chat._id, ...(project ? { projectId: project } : {}) });
    return { id, title: (await ctx.db.get(id))!.title };
  }
  const said = messages.filter((item) => item.message.role === "user" || item.message.role === "assistant")
    .map((item) => ({ role: item.message.role, words: wordsOf(item.text) }))
    .filter((item) => item.words);
  if (!said.length) throw new Error("This chat has nothing in it to save yet.");
  const assistant = (await readPersona(ctx as unknown as QueryCtx)).name;
  const body = said.map((item) => `**${item.role === "user" ? "You" : assistant}:** ${item.words}`).join("\n\n");
  let content = `${body}\n`;
  // A very long chat keeps its newest part.
  if (tooLong(content)) content = `_(The start of this chat was too long to keep.)_\n\n…${content.slice(content.length - 99_000)}`;
  const id = await insertNote(ctx, { title: chat.title ?? titleFrom(said[0].words), content, by, from: chat._id, ...(project ? { projectId: project } : {}) });
  return { id, title: (await ctx.db.get(id))!.title };
}

// --- The dashboard ------------------------------------------------------------------------------

/** Every note, newest first; with projectId, only that project's. */
export const list = query({
  args: { key: vKey, projectId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<NoteSummary[]> => {
    assertDashboardKey(args.key);
    const names = await projectNames(ctx);
    return (await allNotes(ctx))
      .filter((note) => args.projectId === undefined || note.projectId === args.projectId)
      .map((note) => summary(note, names));
  },
});

/** One note, live; null once deleted. */
export const get = query({
  args: { key: vKey, id: v.string() },
  handler: async (ctx, args): Promise<NoteView | null> => {
    assertDashboardKey(args.key);
    const note = await getNote(ctx, args.id);
    return note ? await view(ctx, note) : null;
  },
});

/** Notes whose title or words have these, best first, for search (Ctrl+K). */
export const search = query({
  args: { key: vKey, query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Array<NoteSummary & { snippet: string }>> => {
    assertDashboardKey(args.key);
    const words = args.query.trim();
    if (words.length < 2) return [];
    const names = await projectNames(ctx);
    const hits = (await ctx.db.query("notes").withSearchIndex("search_text", (q) => q.search("search", words)).take(60)).filter((note) => !note.kind).slice(0, Math.min(args.limit ?? 8, 30));
    return hits.map((note) => ({ ...summary(note, names), snippet: snippetOf(note.content, words) }));
  },
});

export const create = mutation({
  args: { key: vKey, title: v.optional(v.string()), content: v.optional(v.string()), projectId: v.optional(v.id("projects")) },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (args.projectId && !await ctx.db.get(args.projectId)) throw new Error("This project was deleted.");
    return await insertNote(ctx, { title: args.title ?? "Untitled", content: args.content ?? "", by: "owner", ...(args.projectId ? { projectId: args.projectId } : {}) });
  },
});

/**
 * The editor's save: the title and words as typed, from the revision it was
 * made from. A newer revision there means someone else saved since (Perry, or
 * another tab): nothing is written, and the newer note comes back, for the
 * owner to choose.
 */
export const save = mutation({
  args: { key: vKey, id: v.id("notes"), title: v.optional(v.string()), content: v.optional(v.string()), expectedRevision: v.number() },
  handler: async (ctx, args): Promise<{ ok: true; note: NoteView } | { ok: false; note: NoteView }> => {
    assertDashboardKey(args.key);
    const note = await ctx.db.get(args.id);
    if (!note) throw new Error("This note was deleted.");
    if (note.revision !== args.expectedRevision) return { ok: false, note: await view(ctx, note) };
    await writeNote(ctx, note, { title: args.title, content: args.content }, "owner");
    return { ok: true, note: await view(ctx, (await ctx.db.get(args.id))!) };
  },
});

/** Into a project (its chats reach it, and only they), or with null out to every chat. */
export const move = mutation({
  args: { key: vKey, id: v.id("notes"), projectId: v.union(v.id("projects"), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const note = await ctx.db.get(args.id);
    if (!note) throw new Error("This note was deleted.");
    if (note.kind) throw new Error("A page of memory stays where it is.");
    if (args.projectId && !await ctx.db.get(args.projectId)) throw new Error("This project was deleted.");
    await ctx.db.patch(note._id, { projectId: args.projectId ?? undefined, updatedAt: Date.now() });
    await moveLines(ctx, note._id, args.projectId ?? undefined);
    return null;
  },
});

/** Delete a note. A schedule that wrote to it stops writing anywhere. */
export const remove = mutation({
  args: { key: vKey, id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const note = await ctx.db.get(args.id);
    // About me and Things to remember are where memory lives; their lines can go, the pages stay.
    if (note?.kind === "about" || note?.kind === "remember" || note?.kind === "journey") throw new Error("This page stays; delete its lines instead.");
    await removeNote(ctx, args.id);
    return null;
  },
});

async function removeNote(ctx: Writer, id: Id<"notes">) {
  await removePage(ctx, id);
}

/** A line added to the Inbox note: the pet's quick note, and /note in the web chat. */
export const jot = mutation({
  args: { key: vKey, text: v.string() },
  returns: v.object({ id: v.id("notes"), title: v.string() }),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await jotInto(ctx, args.text, "owner");
  },
});

/** "Save as note" on a reply, or "Save chat as note" with no messageId. */
export const fromChat = mutation({
  args: { key: vKey, conversationId: v.id("conversations"), messageId: v.optional(v.string()) },
  returns: v.object({ id: v.id("notes"), title: v.string() }),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const chat = await ctx.db.get(args.conversationId);
    if (!chat) throw new Error("This chat was deleted.");
    return await noteFromChat(ctx, chat, "owner", args.messageId);
  },
});

// --- From a phone ------------------------------------------------------------------------------

/** "/note <words>" on Telegram or WhatsApp: added to the Inbox note. */
export const jotFromPhone = internalMutation({
  args: { text: v.string() },
  returns: v.object({ id: v.id("notes"), title: v.string() }),
  handler: async (ctx, args) => await jotInto(ctx, args.text, "owner"),
});

/** "/note" alone on Telegram or WhatsApp: Perry's last reply in that chat, as a note of its own. Null with none. */
export const lastReplyFromPhone = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.union(v.null(), v.object({ id: v.id("notes"), title: v.string() })),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.conversationId);
    if (!chat || chat.contactId) return null;
    const last = await ctx.db.query("agentMessages")
      .withIndex("by_thread_order", (q) => q.eq("threadId", chat.threadId as Id<"agentThreads">))
      .order("desc")
      .filter((q) => q.eq(q.field("message.role"), "assistant"))
      .first();
    if (!last || !wordsOf(last.text)) return null;
    return await noteFromChat(ctx, chat, "owner", last._id);
  },
});

// --- Perry's tools ------------------------------------------------------------------------------

/**
 * Where a chat's turn may reach: none from a chat with someone else; else
 * notes in no project, and those of the chat's own project.
 */
async function reachOf(ctx: Reader, chatId: Id<"conversations"> | undefined): Promise<{ sealed: boolean; projectId?: Id<"projects">; chatId?: Id<"conversations"> }> {
  const chat = chatId ? await ctx.db.get(chatId) : null;
  if (chat?.contactId) return { sealed: true };
  return { sealed: false, ...(chat?.projectId ? { projectId: chat.projectId } : {}), ...(chat ? { chatId: chat._id } : {}) };
}
/**
 * Where a turn may reach a page: never from a chat with someone else; a chat's own page only from that chat; a
 * project's page from its chats, except its Journey, which every chat of the owner's reads (issue #227).
 */
const reaches = (reach: { sealed: boolean; projectId?: Id<"projects">; chatId?: Id<"conversations"> }, note: Note) => !reach.sealed
  && (note.conversationId ? note.conversationId === reach.chatId : !note.projectId || note.projectId === reach.projectId || note.kind === "journey");
const SEALED = "Brain's pages are the owner's: a chat with someone else cannot read or write them.";
const NOT_HERE = "There is no page by that id or name here; brain_list shows the ones this chat can reach.";

type Reach = { sealed: boolean; projectId?: Id<"projects">; chatId?: Id<"conversations"> };
const DAY_MS = 86_400_000;
const dayAgo = (timezone: string, offset: number) => new Date(Date.now() - offset * DAY_MS).toLocaleDateString("en-CA", { timeZone: timezone });

/**
 * A page this chat may reach, by id or by name: "About me", "Things to
 * remember" (the project's, in a project's chat, when it has one), a journal
 * day ("today", "yesterday", "2026-10-01"), a project's Journey ("Journey",
 * this chat's project's; "Journey · Bathroom" or "Bathroom journey", any
 * project's), a person ("People/Datta" or "Datta"), or a page's title.
 */
async function findForAgent(ctx: Reader, reach: Reach, ref: string): Promise<Note | null> {
  const byId = await getNote(ctx, ref.trim());
  if (byId) return reaches(reach, byId) ? byId : null;
  const pages = (await ctx.db.query("notes").collect()).filter((page) => reaches(reach, page));
  const name = ref.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const prefer = (list: Note[]) => list.find((page) => page.projectId && page.projectId === reach.projectId) ?? list.find((page) => !page.projectId) ?? list[0] ?? null;
  if (name === "about me" || name === "user.md") return pages.find((page) => page.kind === "about") ?? null;
  if (name === "things to remember") return prefer(pages.filter((page) => page.kind === "remember"));
  const journey = await journeyNamed(ctx, reach, name);
  if (journey) return pages.find((page) => page.kind === "journey" && page.projectId === journey) ?? null;
  const timezone = await timezoneOf(ctx);
  const day = name === "today" || name === "journal" ? dayAgo(timezone, 0) : name === "yesterday" ? dayAgo(timezone, 1) : /\b(\d{4}-\d{2}-\d{2})\b/.exec(name)?.[1];
  if (day) return prefer(pages.filter((page) => page.kind === "journal" && page.day === day));
  const person = name.replace(/^people\s*\/\s*/, "");
  return pages.find((page) => page.kind === "person" && page.person === person)
    ?? pages.filter((page) => page.title.toLocaleLowerCase() === name).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** The project whose Journey a name means: "journey" in a project's chat, "journey · <project>", "journey/<project>" or "<project> journey" anywhere. */
async function journeyNamed(ctx: Reader, reach: Reach, name: string): Promise<Id<"projects"> | undefined> {
  if (name === "journey" || name === "this project's journey") return reach.projectId;
  const project = /^journey\s*[·:/-]\s*(.+)$/.exec(name)?.[1] ?? /^(.+?)(?:'s)?\s+journey$/.exec(name)?.[1];
  if (!project) return undefined;
  const byId = ctx.db.normalizeId("projects", project.trim());
  if (byId && await ctx.db.get(byId)) return byId;
  return (await ctx.db.query("projects").collect()).find((item) => item.name.replace(/\s+/g, " ").trim().toLocaleLowerCase() === project.trim())?._id;
}

/** A page of memory named but not made yet (About me, Things to remember, today's journal, a Journey): made, to write into. */
async function memoryPageNamed(ctx: Writer, reach: Reach, ref: string): Promise<Note | null> {
  const name = ref.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const journey = await journeyNamed(ctx, reach, name);
  if (journey) return await memoryPage(ctx, { kind: "journey", projectId: journey });
  if (name === "about me" || name === "user.md") return await memoryPage(ctx, { kind: "about" });
  if (name === "things to remember") return await memoryPage(ctx, { kind: "remember", ...(reach.projectId ? { projectId: reach.projectId } : {}) });
  if (name === "today" || name === "journal") return await memoryPage(ctx, { kind: "journal", day: dayAgo(await timezoneOf(ctx), 0) });
  return null;
}

const vChat = v.optional(v.id("conversations"));

type AgentNote = {
  id: string; title: string; kind?: string; day?: string; pinned?: boolean; pinnedSections?: string[]; project?: string; revision: number; updated: string; chars: number; link: string;
};
/** What a page of memory is, as Perry is told. */
const KIND_NAMES = { about: "About me", remember: "Things to remember", journal: "journal", journey: "Journey", person: "person", chat: "this chat's own" } as const;
const agentNote = (note: Note, names: Map<string, string>): AgentNote => ({
  id: note._id,
  // A Journey says whose: every chat reads every project's.
  title: note.kind === "journey" && note.projectId ? `${note.title} · ${names.get(note.projectId) ?? "a project"}` : note.title,
  ...(note.kind ? { kind: KIND_NAMES[note.kind] } : {}),
  ...(note.day ? { day: note.day } : {}),
  ...(isPinned(note) ? { pinned: true } : note.pinnedSections?.length ? { pinnedSections: note.pinnedSections } : {}),
  ...(note.projectId ? { project: names.get(note.projectId) ?? "a project" } : {}),
  revision: note.revision,
  updated: new Date(note.updatedAt).toISOString().slice(0, 16).replace("T", " "),
  chars: note.content.length,
  link: noteHref(note._id),
});

/** The pages a chat may reach, newest first: the owner's pages, and with `memory` the pages of memory too. */
export const listForAgent = internalQuery({
  args: { chat: vChat, memory: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ notes: AgentNote[]; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { notes: [], error: SEALED };
    const names = await projectNames(ctx);
    const pages = args.memory ? await ctx.db.query("notes").withIndex("by_updated").order("desc").collect() : await allNotes(ctx);
    return { notes: pages.filter((note) => reaches(reach, note)).slice(0, 150).map((note) => agentNote(note, names)) };
  },
});

type AgentLine = { id: string; text: string; section?: string; by?: string; fromChat?: string; noted: string; confirmed?: string };
/**
 * One page whole, by id or name: its Markdown, sections and revision; a page
 * of memory also gives each line's id (for supersedes and forget) and where it came from.
 */
export const readForAgent = internalQuery({
  args: { chat: vChat, id: v.string(), section: v.optional(v.string()) },
  handler: async (ctx, args): Promise<(AgentNote & { content: string; sections: string[]; lines?: AgentLine[] }) | { error: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const note = await findForAgent(ctx, reach, args.id);
    if (!note) return { error: NOT_HERE };
    const day = (at: number) => new Date(at).toISOString().slice(0, 10);
    const lines = note.kind ? (await linesOf(ctx, note._id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .filter((line) => !args.section || line.section?.toLocaleLowerCase() === args.section.trim().toLocaleLowerCase()).slice(0, 400)
      .map((line): AgentLine => ({
        id: line._id, text: line.text, ...(line.section ? { section: line.section } : {}), ...(line.by ? { by: line.by } : {}),
        ...(line.from ? { fromChat: line.from } : {}), noted: day(line.createdAt), ...(line.confirmedAt ? { confirmed: day(line.confirmedAt) } : {}),
      })) : undefined;
    // One section's words, when asked for one: its heading and body, as the page has them.
    const content = args.section ? sectionOf(note.content, args.section) ?? note.content : note.content;
    // A person's page: their memories that live on other pages (a journal day, someone else's page), as this chat may see them.
    const elsewhere = note.kind === "person" ? (await mentionsOf(ctx, note, (line) => (line.conversationId ? line.conversationId === reach.chatId : !line.projectId || line.projectId === reach.projectId)))
      .map((mention) => ({ id: mention.id, text: mention.text, page: mention.page.title, ...(mention.day ? { day: mention.day } : {}) })) : [];
    return { ...agentNote(note, await projectNames(ctx)), content, sections: headingsOf(note.content).map((item) => item.text), ...(lines ? { lines } : {}), ...(elsewhere.length ? { alsoAbout: elsewhere } : {}) };
  },
});

/** The words of one section, heading and all; null when the page has none by that name. */
function sectionOf(content: string, heading: string): string | null {
  const headings = headingsOf(content);
  const wanted = heading.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim().toLocaleLowerCase();
  const at = headings.findIndex((item) => item.text.replace(/[*_`]/g, "").trim().toLocaleLowerCase() === wanted);
  if (at < 0) return null;
  const next = headings.slice(at + 1).find((item) => item.level <= headings[at].level);
  return content.split("\n").slice(headings[at].line, next ? next.line : undefined).join("\n").trim();
}

export const searchForAgent = internalQuery({
  args: { chat: vChat, query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ found: number; notes: Array<AgentNote & { snippet: string }>; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { found: 0, notes: [], error: SEALED };
    const names = await projectNames(ctx);
    const hits = (await ctx.db.query("notes").withSearchIndex("search_text", (q) => q.search("search", args.query)).take(60))
      .filter((note) => !note.kind && reaches(reach, note))
      .slice(0, Math.min(args.limit ?? 8, 20));
    return { found: hits.length, notes: hits.map((note) => ({ ...agentNote(note, names), snippet: snippetOf(note.content, args.query) })) };
  },
});

export const createForAgent = internalMutation({
  args: { chat: vChat, title: v.string(), content: v.string(), project: v.optional(v.union(v.literal("this project"), v.literal("none"))) },
  handler: async (ctx, args): Promise<{ created?: AgentNote; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const secret = await secretIn(ctx, `${args.title}\n${args.content}`);
    if (secret) return { error: secret };
    const projectId = args.project === "none" ? undefined : reach.projectId;
    try {
      const id = await insertNote(ctx, { title: args.title, content: args.content, by: "assistant", ...(projectId ? { projectId } : {}), ...(args.chat ? { from: args.chat } : {}) });
      return { created: agentNote((await ctx.db.get(id))!, await projectNames(ctx)) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});

/**
 * Perry's edit. Replacing words (the whole note, or a section) must name the
 * revision they were read at; a newer one there is refused with the note as it
 * is now, to read before trying again. Adding to the end, or to a section,
 * loses nothing, so it may go without one.
 */
export const updateForAgent = internalMutation({
  args: {
    chat: vChat,
    id: v.string(),
    mode: v.union(v.literal("append"), v.literal("replace_section"), v.literal("replace_all")),
    content: v.string(),
    section: v.optional(v.string()),
    title: v.optional(v.string()),
    expectedRevision: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ updated?: AgentNote; error?: string; current?: AgentNote & { content: string }; sections?: string[] }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const name = args.id.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    // A project's chats keep their days in its Journey, not the owner's journal (issue #227).
    const ownDay = Boolean(reach.projectId) && args.mode === "append" && (name === "today" || name === "journal");
    const note = ownDay ? await memoryPage(ctx, { kind: "journey", projectId: reach.projectId! })
      : await findForAgent(ctx, reach, args.id) ?? (args.mode === "append" ? await memoryPageNamed(ctx, reach, args.id) : null);
    if (!note) return { error: NOT_HERE };
    // Added to a Journey, it goes under today's date, newest last.
    if (note.kind === "journey" && args.mode === "append") args = { ...args, section: journalTitle(dayAgo(await timezoneOf(ctx), 0)) };
    const secret = await secretIn(ctx, `${args.title ?? ""}\n${args.content}`);
    if (secret) return { error: secret };
    const names = await projectNames(ctx);
    if (args.mode !== "append" && args.expectedRevision === undefined) {
      return { error: "Replacing words needs expectedRevision, the revision read_note gave: read the note first." };
    }
    if (args.expectedRevision !== undefined && args.expectedRevision !== note.revision) {
      return {
        error: `The note changed since revision ${args.expectedRevision}; it is at revision ${note.revision} now. Nothing was saved. Make your change again on the note as it is below, keeping what the owner wrote.`,
        current: { ...agentNote(note, names), content: note.content },
      };
    }
    let content = note.content;
    if (args.mode === "replace_all") content = args.content;
    else if (args.section) {
      const edited = editSection(note.content, args.section, args.content, args.mode === "append" ? "append" : "replace");
      if ("error" in edited) return { error: `${edited.error} Nothing was saved.`, sections: edited.headings };
      content = edited.content;
    } else if (args.mode === "replace_section") return { error: "replace_section needs section, the heading of the section to replace." };
    else content = appended(note.content, args.content);
    try {
      await writeNote(ctx, note, { content, ...(args.title ? { title: args.title } : {}) }, "assistant", { by: "assistant", ...(args.chat ? { from: args.chat } : {}) });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return { updated: agentNote((await ctx.db.get(note._id))!, names) };
  },
});

/**
 * A project's notes, by title, newest made first, for what a turn in its chats is told of the project
 * (projects.forTurn). By when each was made, not edited, so an edit does not reorder them and retell the project.
 */
export const titlesIn = async (ctx: Reader, projectId: Id<"projects">): Promise<Array<{ id: Id<"notes">; title: string }>> =>
  (await ctx.db.query("notes").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect())
    .filter((note) => !note.kind)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((note) => ({ id: note._id, title: note.title }));

/** Whether a chat may point a job at this note (tools.ts, create_job and update_job); the note's id when so. */
/** Pin a page, or one of its sections, to every chat that may read it; or unpin it. */
export const pinForAgent = internalMutation({
  args: { chat: vChat, id: v.string(), section: v.optional(v.string()), pinned: v.boolean() },
  handler: async (ctx, args): Promise<{ pinned?: AgentNote; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const note = await findForAgent(ctx, reach, args.id) ?? await memoryPageNamed(ctx, reach, args.id);
    if (!note) return { error: NOT_HERE };
    if (args.section && !headingsOf(note.content).some((item) => item.text.replace(/[*_`]/g, "").trim().toLocaleLowerCase() === args.section!.trim().toLocaleLowerCase())) {
      return { error: `"${note.title}" has no section "${args.section}".` };
    }
    await setPinned(ctx, note, args.pinned, args.section?.trim());
    return { pinned: agentNote((await ctx.db.get(note._id))!, await projectNames(ctx)) };
  },
});

export const reachableFrom = internalQuery({
  args: { chat: vChat, id: v.string() },
  handler: async (ctx, args): Promise<{ id?: Id<"notes">; title?: string; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const note = await getNote(ctx, args.id);
    if (!note || !reaches(reach, note)) return { error: NOT_HERE };
    return { id: note._id, title: note.title };
  },
});

// --- The map, for Perry (issue #230) ----------------------------------------------------------------

/** A page's neighbour on the map, as Perry is told: what it is, how far, and why they are tied. */
export type Neighbor = { id: string; title: string; kind: string; steps: number; why: string[]; via?: string; link: string };

/**
 * Brain's map as a chat may see it, only `steps` out from some pages (brainMap.neighbourhoodOf; never the whole
 * map, which grows with every page ever written): the pages it reaches, and its own project.
 */
async function mapFor(ctx: Reader, reach: Reach, pages: string[], steps: number): Promise<BrainGraph> {
  return await neighbourhoodOf(ctx, pages, steps, { page: (page) => reaches(reach, page), project: (id) => id === reach.projectId });
}

/** Why two nodes are tied, in words, from the kinds of edge between them. */
function reasons(graph: BrainGraph, a: number, b: number): string[] {
  const why: string[] = [];
  for (const [x, y, kind, weight] of graph.edges) {
    if (!((x === a && y === b) || (x === b && y === a))) continue;
    const lines = weight === 1 ? "a line" : `${weight} lines`;
    const person = graph.nodes[a].kind === "person" ? graph.nodes[a] : graph.nodes[b];
    if (kind === "link") why.push("a link between them");
    else if (kind === "about") why.push(`${lines} about ${person.title}`);
    else if (kind === "also") why.push(`${lines} about both`);
    else if (kind === "project") why.push(`in the project ${graph.nodes[a].kind === "project" ? graph.nodes[a].title : graph.nodes[b].title}`);
    else why.push(kind === "mention" ? "a mention" : "a related fact");
  }
  return why;
}

/** A page's neighbours, one or two steps out, strongest first, with why each is one; `skip` leaves pages out. */
function neighborsIn(graph: BrainGraph, id: string, steps: number, skip = new Set<string>(), limit = 40): Neighbor[] {
  const local = around(graph, id, steps);
  const start = local.nodes.findIndex((node) => node.id === id);
  if (start < 0) return [];
  const near = new Map<number, number>();
  for (const [a, b, , weight] of local.edges) {
    if (a === start) near.set(b, (near.get(b) ?? 0) + weight);
    if (b === start) near.set(a, (near.get(a) ?? 0) + weight);
  }
  const found: Array<Neighbor & { weight: number }> = [];
  local.nodes.forEach((node, i) => {
    if (i === start || skip.has(node.id)) return;
    const direct = near.has(i);
    // Two steps out: through the neighbour it is most tied to.
    let via = -1;
    if (!direct) {
      let best = 0;
      for (const [a, b, , weight] of local.edges) {
        const other = a === i ? b : b === i ? a : -1;
        if (other >= 0 && near.has(other) && weight > best) { best = weight; via = other; }
      }
      if (via < 0) return;
    }
    found.push({
      id: node.id, title: node.title, kind: node.kind === "page" ? "page" : node.kind, steps: direct ? 1 : 2,
      why: direct ? reasons(local, start, i) : reasons(local, via, i), ...(direct ? {} : { via: local.nodes[via].title }),
      link: node.kind === "project" ? `/projects/${node.id}` : noteHref(node.id), weight: direct ? near.get(i)! : 0,
    });
  });
  return found.sort((x, y) => x.steps - y.steps || y.weight - x.weight).slice(0, limit).map(({ weight: _weight, ...rest }) => rest);
}

/** brain_neighbors: a page's neighbours on the map, from the same graph the owner's Map draws. */
export const neighborsForAgent = internalQuery({
  args: { chat: vChat, id: v.string(), steps: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ page?: { id: string; title: string }; neighbors?: Neighbor[]; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const note = await findForAgent(ctx, reach, args.id);
    if (!note) return { error: NOT_HERE };
    const steps = args.steps === 2 ? 2 : 1;
    return { page: { id: note._id, title: note.title }, neighbors: neighborsIn(await mapFor(ctx, reach, [note._id], steps), note._id, steps) };
  },
});

/** For recall: the pages one step from the pages of its best hits, not already among them, strongest first. */
export const relatedForRecall = internalQuery({
  args: { chat: vChat, pages: v.array(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Array<Neighbor & { from: string }>> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed || !args.pages.length) return [];
    const graph = await mapFor(ctx, reach, args.pages, 1);
    const seen = new Set(args.pages);
    const found: Array<Neighbor & { from: string }> = [];
    for (const page of args.pages) {
      const from = graph.nodes.find((node) => node.id === page)?.title;
      if (!from) continue;
      for (const neighbor of neighborsIn(graph, page, 1, seen, 4)) {
        if (neighbor.kind === "project") continue;
        seen.add(neighbor.id);
        found.push({ ...neighbor, from });
      }
    }
    return found.slice(0, args.limit ?? 6);
  },
});

/** The "Related" section a link goes in, and a link line to a page in it. */
export const RELATED_SECTION = "Related";
const linkLine = (page: Note, why?: string) => `- [${page.title.replace(/[[\]]/g, "")}](${noteHref(page._id)})${why?.trim() ? `: ${why.trim().replace(/\s+/g, " ")}` : ""}`;

/**
 * brain_link: tie two pages, as a link line in each one's Related section (made when missing), which the owner
 * sees and edits, and the map draws. A page that already links the other is left as it is. Each page is checked
 * against the revision Perry read of it, when given, as any page write is.
 */
export const linkForAgent = internalMutation({
  args: { chat: vChat, a: v.string(), b: v.string(), why: v.optional(v.string()), revisionA: v.optional(v.number()), revisionB: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ linked?: Array<{ id: string; title: string; revision: number; added: boolean }>; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const a = await findForAgent(ctx, reach, args.a);
    const b = await findForAgent(ctx, reach, args.b);
    if (!a || !b) return { error: `${a ? `"${args.b}"` : `"${args.a}"`}: ${NOT_HERE}` };
    if (a._id === b._id) return { error: "A page cannot be linked to itself." };
    for (const [page, revision] of [[a, args.revisionA], [b, args.revisionB]] as const) {
      if (revision !== undefined && revision !== page.revision) {
        return { error: `"${page.title}" changed since revision ${revision}; it is at revision ${page.revision} now. Nothing was linked. Read it again first.` };
      }
    }
    const why = args.why?.slice(0, 200);
    const secret = why ? await secretIn(ctx, why) : null;
    if (secret) return { error: secret };
    const linked: Array<{ id: string; title: string; revision: number; added: boolean }> = [];
    for (const [page, other] of [[a, b], [b, a]] as const) {
      const now = (await ctx.db.get(page._id))!;
      const already = linkedIds(now.content).includes(other._id);
      if (!already) {
        const edited = editSection(now.content, RELATED_SECTION, linkLine(other, why), "append");
        const content = "content" in edited ? edited.content : appended(now.content, `## ${RELATED_SECTION}\n\n${linkLine(other, why)}`);
        try {
          await writeNote(ctx, now, { content }, "assistant", { by: "assistant", ...(args.chat ? { from: args.chat } : {}) });
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
      const after = (await ctx.db.get(page._id))!;
      linked.push({ id: after._id, title: after.title, revision: after.revision, added: !already });
    }
    return { linked };
  },
});

// --- Jobs ---------------------------------------------------------------------------------------

/** A job's run, added to its note under the day it ran (jobs.finished). Null once the note is gone. */
export async function appendRun(ctx: Writer, noteId: Id<"notes">, result: string): Promise<{ title: string } | null> {
  const note = await ctx.db.get(noteId);
  if (!note) return null;
  const timezone = await timezoneOf(ctx);
  const day = new Date().toLocaleDateString("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const entry = `## ${day}\n\n${result.trim()}`;
  // A note grown past its size keeps its newest runs: the oldest go from the top.
  let content = appended(note.content, entry);
  if (tooLong(content)) content = `${content.slice(content.length - 90_000).replace(/^[\s\S]*?(?=^## )/m, "")}`;
  await writeNote(ctx, note, { content }, "assistant", { by: "job" });
  return { title: note.title };
}

// --- Search snippets ----------------------------------------------------------------------------

function snippetOf(content: string, query: string, width = 160): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const words = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const lower = flat.toLocaleLowerCase();
  const at = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = flat.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${piece}${start + width < flat.length ? "…" : ""}`;
}

