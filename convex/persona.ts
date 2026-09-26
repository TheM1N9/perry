import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";

/**
 * Who the owner is and who the assistant is, the way OpenClaw keeps USER.md
 * and IDENTITY.md: two documents every turn starts with.
 *
 *   USER.md    the owner, in Markdown: what to call them, their work, a typical
 *              day, people who matter, how they like replies, what they want
 *              help with, and their boundaries. Loaded whole into every turn.
 *   identity   the assistant's name and personality, set by the owner.
 *
 * Standing rules for how to work stay in profile memory (memories.ts); these
 * are who, not how. Each write adds a row, so the newest is current and the
 * rest are history (schema.ts, persona).
 */

export const DEFAULT_NAME = "Perry";
/** Versions kept per document; older ones are dropped as new ones arrive. */
const HISTORY = 50;

export type By = "owner" | "assistant" | "job";
const vBy = v.union(v.literal("owner"), v.literal("assistant"), v.literal("job"));

async function latest(ctx: QueryCtx, kind: "user" | "identity"): Promise<Doc<"persona"> | null> {
  return await ctx.db.query("persona").withIndex("by_kind", (q) => q.eq("kind", kind)).order("desc").first();
}

async function trim(ctx: MutationCtx, kind: "user" | "identity") {
  const old = await ctx.db.query("persona").withIndex("by_kind", (q) => q.eq("kind", kind)).order("desc").collect();
  for (const row of old.slice(HISTORY)) await ctx.db.delete(row._id);
}

export type Persona = { user: string; name: string; personality: string };

export async function readPersona(ctx: QueryCtx): Promise<Persona> {
  const [user, identity] = await Promise.all([latest(ctx, "user"), latest(ctx, "identity")]);
  return {
    user: user?.text ?? "",
    name: identity?.name?.trim() || DEFAULT_NAME,
    personality: identity?.personality?.trim() ?? "",
  };
}

/**
 * What the owner asked to be called: the welcome page's "What should I call
 * you?", which USER.md keeps as "**Call them:**" under "# About <name>".
 * Read from USER.md itself, so an edit there (theirs or the assistant's) shows.
 */
export function callName(userMd: string): string | undefined {
  const line = /^\s*[-*]\s*\*\*Call them:\*\*\s*(.+?)\s*$/im.exec(userMd)?.[1];
  const heading = /^#\s+About\s+(.+?)\s*$/im.exec(userMd)?.[1];
  const name = (line ?? (heading && !/^(the owner|you|me)$/i.test(heading) ? heading : undefined))?.replace(/[*_`]/g, "").trim();
  return name ? name.slice(0, 40) : undefined;
}

export const current = internalQuery({
  args: {},
  handler: async (ctx): Promise<Persona> => await readPersona(ctx),
});

/** What a turn's instructions open and close with: who the assistant is, and who the owner is. */
export const forPrompt = internalQuery({
  args: {},
  returns: v.object({ identity: v.string(), user: v.string() }),
  handler: async (ctx) => {
    const persona = await readPersona(ctx);
    return {
      identity: `Your name is ${persona.name}.${persona.personality ? ` Your personality, as the owner set it: ${persona.personality}` : ""}`,
      // Whole, however long: this is the owner's own account of themselves.
      user: persona.user.trim() ? `## About the owner (USER.md)\n\n${persona.user.trim()}` : "",
    };
  },
});

/** Save USER.md, unless it is unchanged. */
export const writeUser = internalMutation({
  args: { text: v.string(), by: vBy },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if ((await latest(ctx, "user"))?.text?.trim() === text) return { changed: false };
    await ctx.db.insert("persona", { kind: "user", text, by: args.by, createdAt: Date.now() });
    await trim(ctx, "user");
    return { changed: true };
  },
});

/** Change the assistant's name, personality or both; what is not given stays as it was. */
export const writeIdentity = internalMutation({
  args: { name: v.optional(v.string()), personality: v.optional(v.string()), by: vBy },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const now = await readPersona(ctx);
    const name = (args.name ?? now.name).trim().slice(0, 40) || DEFAULT_NAME;
    const personality = (args.personality ?? now.personality).trim().slice(0, 600);
    if (name === now.name && personality === now.personality) return { changed: false };
    await ctx.db.insert("persona", { kind: "identity", name, personality, by: args.by, createdAt: Date.now() });
    await trim(ctx, "identity");
    return { changed: true };
  },
});

export type PersonaVersion = { id: string; kind: "user" | "identity"; text?: string; name?: string; personality?: string; by: By; createdAt: number };

export const history = internalQuery({
  args: { kind: v.union(v.literal("user"), v.literal("identity")), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PersonaVersion[]> => {
    const rows = await ctx.db.query("persona").withIndex("by_kind", (q) => q.eq("kind", args.kind)).order("desc").take(Math.min(args.limit ?? 20, HISTORY));
    return rows.map((row) => ({ id: row._id, kind: row.kind, text: row.text, name: row.name, personality: row.personality, by: row.by, createdAt: row.createdAt }));
  },
});

/** Bring back an older version as the newest one, so the one it replaces stays in history too. */
export const restore = internalMutation({
  args: { id: v.id("persona") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return false;
    await ctx.db.insert("persona", { kind: row.kind, text: row.text, name: row.name, personality: row.personality, by: "owner", createdAt: Date.now() });
    await trim(ctx, row.kind);
    return true;
  },
});
