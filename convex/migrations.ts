import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * One-off data changes, run with `pnpm exec convex run migrations:<name>`.
 * Each is safe to re-run: it only touches rows that still need it.
 */

/**
 * Clear what modes and the AI Gateway left on existing rows: the mode on chats,
 * runs and Codex turns, a chat's engine (and a gateway model, which Codex
 * cannot run), and the install-wide engine choice. Repeat until it reports 0.
 */
export const retireModesAndGateway = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let changed = 0;
    for (const chat of await ctx.db.query("conversations").collect()) {
      if (chat.mode === undefined && chat.engine === undefined) continue;
      await ctx.db.patch(chat._id, {
        mode: undefined,
        engine: undefined,
        ...(chat.engine === "gateway" ? { model: undefined } : {}),
      });
      changed += 1;
    }
    for (const table of ["runs", "codexTurns"] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        if (row.mode === undefined) continue;
        await ctx.db.patch(row._id, { mode: undefined });
        changed += 1;
      }
    }
    for (const install of await ctx.db.query("installation").collect()) {
      if (install.chatEngine === undefined) continue;
      await ctx.db.patch(install._id, { chatEngine: undefined });
      changed += 1;
    }
    return changed;
  },
});
