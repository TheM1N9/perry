import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { appended, editSection, headingsOf, INBOX_TITLE, noteHref, titleFrom, tooLong } from "./lib/notes";
import type { PageKind } from "./lib/pages";
import { timezoneOf } from "./jobs";
import { insertPage, isPinned, moveLines, removePage, writePage, type LineBy } from "./pages";
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
};
export type NoteView = NoteSummary & {
  content: string;
  revision: number;
  createdAt: number;
  from?: { id: Id<"conversations">; title: string };
  /** A page of memory (pages.ts): what it is, and a journal page's day. */
  kind?: PageKind;
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
    if (note?.kind === "about" || note?.kind === "remember") throw new Error("This page stays; delete its lines instead.");
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
/** Where a turn may reach a page: never from a chat with someone else; a chat's own page only from that chat. */
const reaches = (reach: { sealed: boolean; projectId?: Id<"projects">; chatId?: Id<"conversations"> }, note: Note) => !reach.sealed
  && (note.conversationId ? note.conversationId === reach.chatId : !note.projectId || note.projectId === reach.projectId);
const SEALED = "Notes are the owner's: a chat with someone else cannot read or write them.";
const NOT_HERE = "There is no note with that id here; list_notes shows the ones this chat can reach.";

const vChat = v.optional(v.id("conversations"));

type AgentNote = { id: string; title: string; project?: string; revision: number; updated: string; chars: number; link: string };
const agentNote = (note: Note, names: Map<string, string>): AgentNote => ({
  id: note._id,
  title: note.title,
  ...(note.projectId ? { project: names.get(note.projectId) ?? "a project" } : {}),
  revision: note.revision,
  updated: new Date(note.updatedAt).toISOString().slice(0, 16).replace("T", " "),
  chars: note.content.length,
  link: noteHref(note._id),
});

export const listForAgent = internalQuery({
  args: { chat: vChat },
  handler: async (ctx, args): Promise<{ notes: AgentNote[]; error?: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { notes: [], error: SEALED };
    const names = await projectNames(ctx);
    return { notes: (await allNotes(ctx)).filter((note) => reaches(reach, note)).slice(0, 100).map((note) => agentNote(note, names)) };
  },
});

export const readForAgent = internalQuery({
  args: { chat: vChat, id: v.string() },
  handler: async (ctx, args): Promise<(AgentNote & { content: string; sections: string[] }) | { error: string }> => {
    const reach = await reachOf(ctx, args.chat);
    if (reach.sealed) return { error: SEALED };
    const note = await getNote(ctx, args.id);
    if (!note || !reaches(reach, note)) return { error: NOT_HERE };
    return { ...agentNote(note, await projectNames(ctx)), content: note.content, sections: headingsOf(note.content).map((item) => item.text) };
  },
});

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
    const note = await getNote(ctx, args.id);
    if (!note || !reaches(reach, note)) return { error: NOT_HERE };
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

