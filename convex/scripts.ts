import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { listScripts, readScript, updateScript, type ScriptSummary, type ScriptVersion } from "./lib/scripts";

/**
 * The owner's short-video scripts on the Work page. Each is a folder of
 * versions and notes in Perry's files (lib/scripts.ts), which Perry writes
 * with save_script and update_script (tools.ts). These read the folders; the
 * scripts table only tells the page when to read them again.
 */

export type ScriptView = ScriptSummary & { all: ScriptVersion[] };

/** A script was saved or changed: the Work page reads it again. */
export const changed = internalMutation({
  args: { channel: v.string(), slug: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("scripts").withIndex("by_folder", (q) => q.eq("channel", args.channel).eq("slug", args.slug)).first();
    if (row) await ctx.db.patch(row._id, { changedAt: Date.now() });
    else await ctx.db.insert("scripts", { ...args, changedAt: Date.now() });
    return null;
  },
});

export const list = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<ScriptSummary[]> => {
    assertDashboardKey(args.key);
    // Read so that a save shows here as it happens; what is shown comes from the folders.
    await ctx.db.query("scripts").collect();
    return listScripts();
  },
});

/** One script with every version; null once its folder is gone. */
export const get = query({
  args: { key: v.string(), channel: v.string(), slug: v.string() },
  handler: async (ctx, args): Promise<ScriptView | null> => {
    assertDashboardKey(args.key);
    await ctx.db.query("scripts").withIndex("by_folder", (q) => q.eq("channel", args.channel).eq("slug", args.slug)).first();
    try {
      const { notes: _notes, ...script } = readScript(args.slug, args.channel);
      return script;
    } catch {
      return null;
    }
  },
});

/** The owner marks a script final for the shoot, shot once filmed, or a draft again. */
export const setStatus = action({
  args: { key: v.string(), channel: v.string(), slug: v.string(), status: v.union(v.literal("draft"), v.literal("final"), v.literal("shot")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const done = updateScript({ slug: args.slug, channel: args.channel, status: args.status });
    await ctx.runMutation(internal.scripts.changed, { channel: done.channel, slug: done.slug });
    return null;
  },
});
