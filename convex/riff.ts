import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, mutation, query, type MutationCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { listSkills } from "./lib/skills";
import { CORE_STYLES, DEFAULT_STYLE, isCoreStyle, readStyle, styleLabel } from "./lib/riffStyles";
import { insertPage, writePage } from "./pages";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../runner/home";

/**
 * Riff: a document the owner talks into (notes.ts holds the document, its
 * editing chat and sendLive). This file is what Riff adds around it:
 *
 * - Versions. Every change is kept (riffVersions), so any of Perry's edits can
 *   be undone and an earlier state restored. Runs of dictation and of typing
 *   merge into one version; each accepted edit and each restore is its own.
 * - Proposals. Perry's writes that change words already there are held on the
 *   note (notes.updateForAgent) for the owner to accept or reject here.
 * - Styles. A style is a skill (lib/riffStyles.ts for the core ones).
 * - Hand-offs. "Send to someone" and "turn this into…" start an ordinary chat
 *   with Perry about the document; sending to a contact asks the owner first,
 *   as every send_message does.
 */

type Note = Doc<"notes">;
type Writer = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] };
type Kind = Doc<"riffVersions">["kind"];

const KEEP = 60;
/** A version keeps absorbing the same kind of change for this long. */
const MERGE_MS: Partial<Record<Kind, number>> = { dictation: 2 * 60_000, typing: 5 * 60_000 };
const vKey = v.string();

/** Keep the note as it is now as its newest version. */
export async function recordVersion(ctx: Writer, noteId: Id<"notes">, kind: Kind, label?: string): Promise<Id<"riffVersions"> | null> {
  const note = await ctx.db.get(noteId);
  if (!note?.liveChatId) return null;
  const versions = await ctx.db.query("riffVersions").withIndex("by_note", (q) => q.eq("noteId", noteId)).collect();
  const last = versions.at(-1);
  if (last && last.content === note.content && last.title === note.title) return last._id;
  const now = Date.now();
  const merge = MERGE_MS[kind];
  if (last && merge && last.kind === kind && now - last.at < merge) {
    await ctx.db.patch(last._id, { title: note.title, content: note.content, at: now });
    return last._id;
  }
  const id = await ctx.db.insert("riffVersions", { noteId, title: note.title, content: note.content, kind, ...(label ? { label: label.slice(0, 120) } : {}), at: now });
  for (const old of versions.slice(0, Math.max(0, versions.length + 1 - KEEP))) await ctx.db.delete(old._id);
  return id;
}

/** A Riff document's versions go with it. */
export async function removeVersions(ctx: Writer, noteId: Id<"notes">) {
  for (const version of await ctx.db.query("riffVersions").withIndex("by_note", (q) => q.eq("noteId", noteId)).collect()) await ctx.db.delete(version._id);
}

/** Whether `next` only adds to the end of `current`: dictation, which needs no review. */
export const onlyAdds = (current: string, next: string) => {
  const base = current.replace(/\s+$/, "");
  return !base || (next.startsWith(base) && next.length >= base.length);
};

async function liveNote(ctx: { db: MutationCtx["db"] }, id: Id<"notes">): Promise<Note & { liveChatId: Id<"conversations"> }> {
  const note = await ctx.db.get(id);
  if (!note?.liveChatId) throw new Error("This Riff document was deleted.");
  return note as Note & { liveChatId: Id<"conversations"> };
}

export type RiffVersion = { id: Id<"riffVersions">; kind: Kind; label?: string; title: string; content: string; at: number };

export const versions = query({
  args: { key: vKey, id: v.id("notes") },
  handler: async (ctx, args): Promise<RiffVersion[]> => {
    assertDashboardKey(args.key);
    return (await ctx.db.query("riffVersions").withIndex("by_note", (q) => q.eq("noteId", args.id)).collect())
      .reverse()
      .map((version) => ({ id: version._id, kind: version.kind, ...(version.label ? { label: version.label } : {}), title: version.title, content: version.content, at: version.at }));
  },
});

/**
 * Accept Perry's held edit. Dictation added at the end since it was made is
 * carried over; any other change since means it was made on words that are
 * gone, and it is not applied.
 */
export const accept = mutation({
  args: { key: vKey, id: v.id("notes"), at: v.number() },
  handler: async (ctx, args): Promise<{ ok: true; undo: Id<"riffVersions"> | null } | { ok: false; reason: "changed" | "gone" }> => {
    assertDashboardKey(args.key);
    const note = await liveNote(ctx, args.id);
    const proposal = note.riffProposal;
    if (!proposal || proposal.at !== args.at) return { ok: false, reason: "gone" };
    if (proposal.title !== undefined && proposal.baseRevision !== note.revision) return { ok: false, reason: "changed" };
    const base = proposal.baseContent.replace(/\s+$/, "");
    let content: string;
    if (note.content === proposal.baseContent) content = proposal.content;
    else if (note.content.startsWith(base)) {
      const tail = note.content.slice(base.length).replace(/^\s+/, "");
      content = tail ? `${proposal.content.replace(/\s+$/, "")}\n\n${tail}` : proposal.content;
    } else return { ok: false, reason: "changed" };
    const before = await recordVersion(ctx, note._id, "typing");
    await ctx.db.patch(note._id, { riffProposal: undefined });
    await writePage(ctx, (await ctx.db.get(note._id))!, { content, ...(proposal.title ? { title: proposal.title } : {}) }, { by: "assistant", from: note.liveChatId });
    await recordVersion(ctx, note._id, "edit", proposal.instruction);
    return { ok: true, undo: before };
  },
});

export const reject = mutation({
  args: { key: vKey, id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const note = await liveNote(ctx, args.id);
    if (note.riffProposal) await ctx.db.patch(note._id, { riffProposal: undefined });
    return null;
  },
});

/** Put an earlier version back, as a new version of its own (so a restore can be undone too). */
export const restore = mutation({
  args: { key: vKey, id: v.id("notes"), version: v.id("riffVersions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const note = await liveNote(ctx, args.id);
    const version = await ctx.db.get(args.version);
    if (!version || version.noteId !== note._id) throw new Error("That version is no longer kept.");
    await recordVersion(ctx, note._id, "typing");
    await writePage(ctx, note, { title: version.title, content: version.content }, { by: "owner" });
    await ctx.db.patch(note._id, { riffProposal: undefined });
    await recordVersion(ctx, note._id, "restore", version.label ?? undefined);
    return null;
  },
});

export const setStyle = mutation({
  args: { key: vKey, id: v.id("notes"), style: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const note = await liveNote(ctx, args.id);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.style)) throw new Error("That is not a skill's name.");
    await ctx.db.patch(note._id, { riffStyle: args.style === DEFAULT_STYLE ? undefined : args.style });
    return null;
  },
});

export type RiffStyle = { name: string; label: string; description: string; core: boolean; postLimit?: number };

/**
 * The core styles, then the skills in the skills folder that are writing styles (`riff: true` in their
 * frontmatter; lib/riffStyles.ts). Other skills stay out. A style skill of a core style's name takes its place.
 */
export const styles = action({
  args: { key: vKey },
  handler: async (_ctx, args): Promise<RiffStyle[]> => {
    assertDashboardKey(args.key);
    const own = listSkills().filter((skill) => !skill.problem).flatMap((skill): RiffStyle[] => {
      let style: ReturnType<typeof readStyle>;
      try { style = readStyle(readFileSync(join(PATHS.skills, skill.folder, "SKILL.md"), "utf8")); } catch { return []; }
      if (!style.style) return [];
      return [{ name: skill.name, label: styleLabel(skill.name), description: skill.description, core: isCoreStyle(skill.name), ...(style.postLimit ? { postLimit: style.postLimit } : {}) }];
    });
    const core = Object.entries(CORE_STYLES).map(([name, skill]): RiffStyle => {
      const style = readStyle(skill);
      return own.find((item) => item.name === name) ?? { name, label: styleLabel(name), description: style.description ?? "", core: true, ...(style.postLimit ? { postLimit: style.postLimit } : {}) };
    });
    return [...core, ...own.filter((item) => !item.core)];
  },
});

/** What the editing chat is told of the document's style: a core one's words, or the skill to read. */
export function styleNote(style: string | undefined): string {
  const name = style ?? DEFAULT_STYLE;
  if (isCoreStyle(name)) return `Write in the document's style, "${styleLabel(name)}":\n${readStyle(CORE_STYLES[name]).body}`;
  return `Write in the document's style: follow the skill $${name}.`;
}

/** A copy as an ordinary Brain page, which the owner then finds in Brain. */
export const toBrain = mutation({
  args: { key: vKey, id: v.id("notes") },
  handler: async (ctx, args): Promise<Id<"notes">> => {
    assertDashboardKey(args.key);
    const note = await liveNote(ctx, args.id);
    if (!note.content.trim()) throw new Error("There is nothing in this document yet.");
    return await insertPage(ctx, { title: note.title, content: note.content, author: { by: "owner" } });
  },
});

/**
 * A chat with Perry about this document: to send it to someone (send_message,
 * which asks the owner before anything goes out) or to make something of it.
 */
export const handOff = mutation({
  args: { key: vKey, id: v.id("notes"), to: v.union(v.literal("someone"), v.literal("perry")), text: v.string() },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    assertDashboardKey(args.key);
    const note = await liveNote(ctx, args.id);
    const text = args.text.trim().slice(0, 2_000);
    if (!text) throw new Error(args.to === "someone" ? "Say who to send it to." : "Say what to make of it.");
    if (!note.content.trim()) throw new Error("There is nothing in this document yet.");
    const chat = await ctx.runMutation(api.dashboard.createChat, { key: args.key });
    await ctx.db.patch(chat, { title: args.to === "someone" ? `Send “${note.title}”` : `“${note.title}”: ${text}`.slice(0, 80) });
    const about = `My Riff document “${note.title}” (note id ${note._id}; read it with read_note).`;
    await ctx.runMutation(api.dashboard.sendChat, {
      key: args.key, id: chat,
      text: args.to === "someone"
        ? `Send ${about} to ${text}. Send its text as written, without adding to it. Use send_message, so I approve it before it goes.`
        : `${about}\n\n${text}`,
    });
    return chat;
  },
});
