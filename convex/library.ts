import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { kindOf, libraryFileUrl, previewOf, SINCE, type LibraryBy, type LibraryFrom, type LibraryHow, type LibraryKind, type LibrarySince } from "./lib/library";
import { ABSOLUTE_PATH, describePath } from "./media";
import { vLibraryFrom, vLibraryKind } from "./schema";
import { HOME, PATHS } from "../runner/home";

/**
 * The Library (issue #216): every file the owner gave Perry and every file
 * Perry made, in one place, without a second copy of any of them.
 *
 * Files already live in three places: the uploads folder (what the owner
 * attaches in the web app or the pet, and the pet's looks at the screen),
 * Perry's storage (what comes in on Telegram and WhatsApp, and what a
 * Telegram chat was sent), and wherever Perry saved something on this
 * computer (generated images and browser screenshots in his files folder,
 * files he shared or wrote). chatAttachments ties each to the chat message it
 * came with. The `library` table indexes them: one row per file, keyed by its
 * path or storage id, with who made it and where it came from, which a chat
 * row alone cannot say once a file is in two chats (a branch) or none (one
 * Perry wrote into his folder without sharing it).
 *
 * It is kept up as files are attached (index, called where chatAttachments
 * rows are made), filled once from what was there before (backfill, when
 * Perry starts), and from the files folder (sync: at start, every ten
 * minutes and when the Library is opened), which also lets go of files that
 * are no longer on this computer.
 *
 * Left out on purpose: the small pictures of Perry's browser for the chat's
 * steps (steps/, the newest 300 kept), which belong to their steps; files a
 * step changed outside Perry's files folder (the owner's own code and
 * documents); and anything from a chat with someone else, which stays in that
 * chat. Deleting an item deletes the file when it is in Perry's own folders
 * (uploads, files, storage) and leaves one elsewhere where it is; either way
 * every chat that showed it says it was removed.
 */

type Hint = { by?: LibraryBy; from?: LibraryFrom; how?: LibraryHow };

/** Whether `path` is inside `dir`. */
export function within(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Perry's own folders: a file in them is his to delete. */
const ours = (path: string) => within(path, PATHS.uploads) || within(path, PATHS.files);

/** The file's size on this computer, or null when it is not here. */
function sizeHere(path: string): number | null {
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** Where a chat's files came from, as the Library's filter says it. */
function fromChat(chat: Doc<"conversations">): LibraryFrom {
  return chat.jobId ? "job" : chat.taskId ? "task" : chat.channel;
}

async function byPath(ctx: QueryCtx, path: string) {
  return await ctx.db.query("library").withIndex("by_path", (q) => q.eq("localPath", path)).first();
}
async function byStorage(ctx: QueryCtx, id: Id<"_storage">) {
  return await ctx.db.query("library").withIndex("by_storage", (q) => q.eq("storageId", id)).first();
}

/** The pet's pictures of the screen are named so (components/pet/chat.tsx, keepPicture). */
const PET_PICTURE = /^screen-\d{4}-\d\d-\d\d/;

/**
 * Put a chat's file in the Library, once: a file already there (the same
 * path, or the same stored file) is not added again, though one the folder
 * scan found first gains the chat it came from. Nothing from a chat with
 * someone else, no step picture, and no file this computer does not have.
 */
export async function index(ctx: MutationCtx, id: Id<"chatAttachments">, hint: Hint = {}, looks?: Set<string>): Promise<void> {
  const row = await ctx.db.get(id);
  if (!row || row.removedAt || (!row.localPath && !row.storageId)) return;
  if (row.messageKey === "steps") return;
  const chat = await ctx.db.get(row.conversationId);
  if (!chat || chat.contactId) return;
  const written = row.messageKey.startsWith("steps-");
  if (written && !(row.localPath && within(row.localPath, PATHS.files))) return;

  const existing = (row.localPath ? await byPath(ctx, row.localPath) : null) ?? (row.storageId ? await byStorage(ctx, row.storageId) : null);
  const perry = written || row.messageKey.startsWith("codex-");
  const look = hint.how === "look" || Boolean(row.localPath && looks?.has(row.localPath));
  const how: LibraryHow = hint.how ?? (look ? "look"
    : written ? "written"
    : !perry ? "upload"
    : !row.localPath || within(row.localPath, join(PATHS.files, "generated")) ? "generated"
    : within(row.localPath, PATHS.files) && /^browser-/.test(basename(row.localPath)) ? "screenshot"
    : "shared");
  const source = {
    from: hint.from ?? (look || (!perry && PET_PICTURE.test(row.fileName)) ? "pet" : fromChat(chat)),
    conversationId: chat._id,
    messageKey: row.messageKey,
    ...(chat.projectId ? { projectId: chat.projectId } : {}),
    ...(chat.jobId ? { jobId: chat.jobId } : {}),
    ...(chat.taskId ? { taskId: chat.taskId } : {}),
  };
  if (existing) {
    if (!existing.conversationId) {
      // Only folder discoveries gain new provenance; attributed files just regain a chat link.
      await ctx.db.patch(existing._id, existing.how === "folder"
        ? { ...source, by: hint.by ?? (perry || look ? "perry" : "owner"), how }
        : { conversationId: chat._id, messageKey: row.messageKey, projectId: chat.projectId, jobId: chat.jobId, taskId: chat.taskId });
    }
    return;
  }
  const size = row.localPath ? sizeHere(row.localPath) : row.size;
  if (size === null) return;
  const name = row.fileName || describePath(row.localPath ?? "file").fileName;
  await ctx.db.insert("library", {
    name,
    contentType: row.contentType,
    kind: kindOf(row.contentType, name),
    size,
    ...(row.localPath ? { localPath: row.localPath } : { storageId: row.storageId }),
    by: hint.by ?? (perry || look ? "perry" : "owner"),
    how,
    ...source,
    search: name.toLowerCase(),
    createdAt: row.createdAt,
  });
}

/** Index a chat's file as it is attached (media.ts, codex.ts, dashboard.ts). */
export const indexAttachment = internalMutation({
  args: { id: v.id("chatAttachments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await index(ctx, args.id);
    return null;
  },
});

/** A file on this computer put in the Library by itself: a browser screenshot, or one Perry added with library_add. */
export async function addLocal(ctx: MutationCtx, args: { path: string; how: LibraryHow; by: LibraryBy; conversationId?: Id<"conversations">; name?: string }) {
  if (!ABSOLUTE_PATH.test(args.path)) throw new Error("Give the file's absolute path.");
  const size = sizeHere(args.path);
  if (size === null) throw new Error("There is no file at that path on this computer.");
  const chat = args.conversationId ? await ctx.db.get(args.conversationId) : null;
  if (chat?.contactId) throw new Error("A chat with someone else has no Library.");
  const existing = await byPath(ctx, args.path);
  if (existing) return existing._id;
  const described = describePath(args.path);
  const name = (args.name?.trim() || described.fileName).slice(0, 200);
  return await ctx.db.insert("library", {
    name,
    contentType: described.contentType,
    kind: kindOf(described.contentType, name),
    size,
    localPath: args.path,
    by: args.by,
    how: args.how,
    from: chat ? fromChat(chat) : "folder",
    ...(chat ? { conversationId: chat._id } : {}),
    ...(chat?.projectId ? { projectId: chat.projectId } : {}),
    ...(chat?.jobId ? { jobId: chat.jobId } : {}),
    ...(chat?.taskId ? { taskId: chat.taskId } : {}),
    search: name.toLowerCase(),
    createdAt: Date.now(),
  });
}

export const add = internalMutation({
  args: {
    path: v.string(),
    how: v.union(v.literal("added"), v.literal("screenshot")),
    by: v.union(v.literal("owner"), v.literal("perry")),
    conversationId: v.optional(v.id("conversations")),
    name: v.optional(v.string()),
  },
  returns: v.id("library"),
  handler: async (ctx, args) => await addLocal(ctx, args),
});

/** Every chat file from before the Library, indexed; what is indexed already is left as it is. Run when Perry starts. */
export const backfill = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const before = (await ctx.db.query("library").collect()).length;
    const looks = new Set((await ctx.db.query("screenLooks").collect()).flatMap((look) => look.path ? [look.path] : []));
    for (const row of await ctx.db.query("chatAttachments").collect()) await index(ctx, row._id, {}, looks);
    return (await ctx.db.query("library").collect()).length - before;
  },
});

const vFound = v.object({ path: v.string(), size: v.number(), at: v.number() });

/** Files found in Perry's files folder that nothing put in the Library: his, from his folder. */
export const addFound = internalMutation({
  args: { files: v.array(vFound) },
  returns: v.number(),
  handler: async (ctx, args) => {
    let added = 0;
    for (const file of args.files) {
      if (await byPath(ctx, file.path)) continue;
      const { fileName, contentType } = describePath(file.path);
      await ctx.db.insert("library", {
        name: fileName, contentType, kind: kindOf(contentType, fileName), size: file.size, localPath: file.path,
        by: "perry", how: "folder", from: "folder", search: fileName.toLowerCase(), createdAt: file.at,
      });
      added++;
    }
    return added;
  },
});

/** The file locations to check outside a database transaction. */
export const syncItems = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("library").collect()).map((item) => ({
    id: item._id, localPath: item.localPath, storageId: item.storageId,
  })),
});

/** Let go of library rows whose files sync found missing. */
export const dropMissing = internalMutation({
  args: { ids: v.array(v.id("library")) },
  returns: v.number(),
  handler: async (ctx, args) => {
    let dropped = 0;
    for (const id of args.ids) {
      if (!await ctx.db.get(id)) continue;
      await ctx.db.delete(id);
      dropped++;
    }
    return dropped;
  },
});

/** The files in Perry's files folder, newest first: not its hidden folders, and no more than enough. */
function walk(dir: string, depth = 0, found: Array<typeof vFound.type> = []): Array<typeof vFound.type> {
  if (depth > 6 || found.length >= 5000) return found;
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(/*turbopackIgnore: true*/ dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, depth + 1, found);
    else if (entry.isFile()) {
      try {
        const info = statSync(/*turbopackIgnore: true*/ path);
        found.push({ path, size: info.size, at: Math.round(info.mtimeMs) });
      } catch {}
    }
    if (found.length >= 5000) break;
  }
  return found;
}

/** Bring the Library up to date with the files folder, and let go of what is gone. */
export const sync = internalAction({
  args: {},
  returns: v.object({ added: v.number(), dropped: v.number() }),
  handler: async (ctx): Promise<{ added: number; dropped: number }> => {
    const files = walk(PATHS.files);
    let added = 0;
    for (let at = 0; at < files.length; at += 250) added += await ctx.runMutation(internal.library.addFound, { files: files.slice(at, at + 250) });
    const missing: Id<"library">[] = [];
    for (const item of await ctx.runQuery(internal.library.syncItems, {})) {
      const here = item.localPath ? sizeHere(item.localPath) !== null : item.storageId ? Boolean(await ctx.storage.getMetadata(item.storageId)) : false;
      if (!here) missing.push(item.id);
    }
    const dropped: number = await ctx.runMutation(internal.library.dropMissing, { ids: missing });
    return { added, dropped };
  },
});

let refreshedAt = 0;
/** The Library was opened: bring it up to date, at most every half a minute. */
export const refresh = action({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    if (Date.now() - refreshedAt < 30_000) return null;
    refreshedAt = Date.now();
    await ctx.runAction(internal.library.sync, {});
    return null;
  },
});

// --- What the dashboard and Perry's tools read -----------------------------------------------

export type LibraryItem = {
  id: Id<"library">;
  name: string;
  contentType: string;
  kind: LibraryKind;
  size: number;
  by: LibraryBy;
  from: LibraryFrom;
  how: LibraryHow;
  createdAt: number;
  url: string;
  /** Where it came from, as a link: its chat, or a schedule or task's chat; none when that is gone. */
  source: { label: string; href?: string };
  project?: { id: Id<"projects">; name: string };
};

export type LibraryDetail = LibraryItem & {
  preview: ReturnType<typeof previewOf>;
  /** Where the file is on this computer; none for one in Perry's storage. */
  path?: string;
  /** Deleting it deletes the file (it is in Perry's own folders); otherwise the file stays where it is. */
  deletes: boolean;
};

const vFilter = {
  kind: v.optional(vLibraryKind),
  by: v.optional(v.union(v.literal("owner"), v.literal("perry"))),
  /** One of where it came from, "project" for any project's, or a project's id. */
  from: v.optional(v.union(vLibraryFrom, v.literal("project"), v.id("projects"))),
  since: v.optional(v.union(v.literal("today"), v.literal("week"), v.literal("month"), v.literal("year"))),
  /** Words in its name. */
  query: v.optional(v.string()),
};
type Filter = { kind?: LibraryKind; by?: LibraryBy; from?: LibraryFrom | "project" | Id<"projects">; since?: LibrarySince; query?: string };

async function view(ctx: QueryCtx, item: Doc<"library">, names: Map<string, string | null>): Promise<LibraryItem> {
  const name = async (id: string | undefined, read: () => Promise<string | null>) => {
    if (!id) return null;
    if (!names.has(id)) names.set(id, await read());
    return names.get(id) ?? null;
  };
  const chat = item.conversationId ? await ctx.db.get(item.conversationId) : null;
  const job = await name(item.jobId, async () => (await ctx.db.get(item.jobId!))?.name ?? null);
  const task = await name(item.taskId, async () => (await ctx.db.get(item.taskId!))?.title ?? null);
  const project = await name(item.projectId, async () => (await ctx.db.get(item.projectId!))?.name ?? null);
  const label = item.from === "folder" ? "Perry's files folder"
    : job ?? task ?? (chat ? chat.title?.trim() || "Chat" : "Chat deleted");
  return {
    id: item._id, name: item.name, contentType: item.contentType, kind: item.kind, size: item.size, by: item.by, from: item.from,
    how: item.how, createdAt: item.createdAt, url: libraryFileUrl(item._id),
    source: { label, ...(chat ? { href: `/chat/${chat._id}` } : {}) },
    ...(item.projectId && project ? { project: { id: item.projectId, name: project } } : {}),
  };
}

/** The Library's items, newest first, as filtered; never anything of a chat with someone else. */
async function listed(ctx: QueryCtx, filter: Filter, limit = 2000): Promise<LibraryItem[]> {
  const since = filter.since ? Date.now() - SINCE[filter.since] * 86_400_000 : 0;
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const names = new Map<string, string | null>();
  const found: LibraryItem[] = [];
  for await (const item of ctx.db.query("library").withIndex("by_created").order("desc")) {
    if (item.createdAt < since) break;
    if (filter.kind && item.kind !== filter.kind) continue;
    if (filter.by && item.by !== filter.by) continue;
    if (filter.from === "project" ? !item.projectId : filter.from && filter.from in FROM_SET ? item.from !== filter.from : filter.from && item.projectId !== filter.from) continue;
    if (words.some((word) => !item.search.includes(word))) continue;
    // A chat with someone else never puts a file here; this keeps it so whatever wrote the row.
    if (item.conversationId && (await ctx.db.get(item.conversationId))?.contactId) continue;
    found.push(await view(ctx, item, names));
    if (found.length >= limit) break;
  }
  return found;
}
const FROM_SET: Record<string, true> = { web: true, telegram: true, whatsapp: true, pet: true, job: true, task: true, folder: true };

const KIND_SET: Record<string, true> = { image: true, document: true, media: true, other: true };

/** The Library page's items, by the filters in its address; one it does not know is left out, rather than refused. */
export const list = query({
  args: { key: v.string(), kind: v.optional(v.string()), by: v.optional(v.string()), from: v.optional(v.string()), since: v.optional(v.string()), query: v.optional(v.string()) },
  handler: async (ctx, { key, ...asked }): Promise<{ items: LibraryItem[]; total: number; projects: Array<{ id: Id<"projects">; name: string }> }> => {
    assertDashboardKey(key);
    const project = asked.from ? ctx.db.normalizeId("projects", asked.from) : null;
    const filter: Filter = {
      ...(asked.kind && KIND_SET[asked.kind] ? { kind: asked.kind as LibraryKind } : {}),
      ...(asked.by === "owner" || asked.by === "perry" ? { by: asked.by } : {}),
      ...(asked.from && (FROM_SET[asked.from] || asked.from === "project") ? { from: asked.from as LibraryFrom | "project" } : project ? { from: project } : {}),
      ...(asked.since && asked.since in SINCE ? { since: asked.since as LibrarySince } : {}),
      ...(asked.query?.trim() ? { query: asked.query } : {}),
    };
    const items = await listed(ctx, filter);
    const total = (await ctx.db.query("library").collect()).length;
    const projects = (await ctx.db.query("projects").collect()).map((project) => ({ id: project._id, name: project.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return { items, total, projects };
  },
});

export const get = query({
  args: { key: v.string(), id: v.string() },
  handler: async (ctx, args): Promise<LibraryDetail | null> => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("library", args.id);
    const item = id ? await ctx.db.get(id) : null;
    if (!item || (item.conversationId && (await ctx.db.get(item.conversationId))?.contactId)) return null;
    return {
      ...await view(ctx, item, new Map()),
      preview: previewOf(item.contentType, item.name),
      ...(item.localPath ? { path: item.localPath } : {}),
      deletes: !item.localPath || ours(item.localPath),
    };
  },
});

/** Where an item's file is, for the local media server (app/api/media/library). */
export const file = query({
  args: { key: v.string(), id: v.string() },
  returns: v.union(v.null(), v.object({ path: v.string(), name: v.string(), contentType: v.string() })),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("library", args.id);
    const item = id ? await ctx.db.get(id) : null;
    if (!item || (item.conversationId && (await ctx.db.get(item.conversationId))?.contactId)) return null;
    const path = item.localPath ?? (item.storageId ? join(HOME, "storage", item.storageId) : null);
    return path ? { path, name: item.name, contentType: item.contentType } : null;
  },
});

/** For Perry's tools: the owner's Library as filtered, never from a chat with someone else. */
export const find = internalQuery({
  args: { ...vFilter, limit: v.optional(v.number()), conversationId: v.optional(v.id("conversations")) },
  handler: async (ctx, { limit, conversationId, ...filter }): Promise<Array<LibraryItem & { path?: string }>> => {
    const chat = conversationId ? await ctx.db.get(conversationId) : null;
    if (chat?.contactId) return [];
    const items = await listed(ctx, filter, Math.min(Math.max(limit ?? 20, 1), 100));
    return await Promise.all(items.map(async (item) => {
      const row = await ctx.db.get(item.id);
      return { ...item, ...(row?.localPath ? { path: row.localPath } : {}) };
    }));
  },
});

// --- Deleting ----------------------------------------------------------------------------------

/**
 * Take an item out of the Library and out of every chat that showed it: each
 * of those chats keeps the file's name, marked removed. A stored copy is
 * deleted here; the caller deletes a file on disk when it is in Perry's own
 * folders, and says where it is otherwise.
 */
export const forget = internalMutation({
  args: { id: v.id("library") },
  returns: v.union(v.null(), v.object({ path: v.optional(v.string()), deletes: v.boolean() })),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);
    if (!item) return null;
    if (item.conversationId && (await ctx.db.get(item.conversationId))?.contactId) throw new Error("A chat with someone else has no Library.");
    const rows = [
      ...(item.localPath ? await ctx.db.query("chatAttachments").withIndex("by_path", (q) => q.eq("localPath", item.localPath)).collect() : []),
      ...(item.storageId ? await ctx.db.query("chatAttachments").withIndex("by_storage", (q) => q.eq("storageId", item.storageId)).collect() : []),
    ];
    const stored = new Set<Id<"_storage">>(item.storageId ? [item.storageId] : []);
    const at = Date.now();
    for (const row of rows) {
      if (row.storageId) stored.add(row.storageId);
      if (!row.removedAt) await ctx.db.patch(row._id, { localPath: undefined, storageId: undefined, removedAt: at });
    }
    for (const id of stored) await ctx.storage.delete(id);
    await ctx.db.delete(item._id);
    return { ...(item.localPath ? { path: item.localPath } : {}), deletes: !item.localPath || ours(item.localPath) };
  },
});

export const remove = action({
  args: { key: v.string(), id: v.id("library") },
  returns: v.object({ kept: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ kept?: string }> => {
    assertDashboardKey(args.key);
    const done: { path?: string; deletes: boolean } | null = await ctx.runMutation(internal.library.forget, { id: args.id });
    if (!done) throw new Error("It's already gone from the Library.");
    if (done.path && done.deletes) {
      // Out of the Library and every chat already; a file that cannot be deleted now (open elsewhere) is said to stay.
      try { rmSync(/*turbopackIgnore: true*/ done.path, { force: true }); } catch { return { kept: done.path }; }
    }
    return done.path && !done.deletes ? { kept: done.path } : {};
  },
});

/**
 * A chat is being deleted (dashboard.deleteChat): its files stay in the
 * Library, each pointing at another chat that still has it, or at none. A
 * stored file only this chat had is deleted with the chat, and leaves.
 */
export async function chatDeleted(ctx: MutationCtx, conversationId: Id<"conversations">) {
  for (const item of await ctx.db.query("library").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect()) {
    const others = [
      ...(item.localPath ? await ctx.db.query("chatAttachments").withIndex("by_path", (q) => q.eq("localPath", item.localPath)).collect() : []),
      ...(item.storageId ? await ctx.db.query("chatAttachments").withIndex("by_storage", (q) => q.eq("storageId", item.storageId)).collect() : []),
    ].filter((row) => row.conversationId !== conversationId && !row.removedAt);
    const other = others[0] ? await ctx.db.get(others[0].conversationId) : null;
    if (other && !other.contactId) {
      await ctx.db.patch(item._id, {
        conversationId: other._id, messageKey: others[0].messageKey,
        projectId: other.projectId, jobId: other.jobId, taskId: other.taskId,
      });
    } else if (item.localPath) {
      await ctx.db.patch(item._id, { conversationId: undefined, messageKey: undefined });
    } else {
      await ctx.db.delete(item._id);
    }
  }
}

/** Whether a stored file is still shown in a chat other than this one, so deleting this chat must keep it. */
export async function storedElsewhere(ctx: QueryCtx, storageId: Id<"_storage">, conversationId: Id<"conversations">): Promise<boolean> {
  const rows = await ctx.db.query("chatAttachments").withIndex("by_storage", (q) => q.eq("storageId", storageId)).collect();
  return rows.some((row) => row.conversationId !== conversationId);
}
