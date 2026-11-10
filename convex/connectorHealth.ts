import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** Health belongs to one provider account, never to a toolkit as a whole. */
export const read = internalQuery({
  args: { accounts: v.array(v.object({ accountId: v.string(), toolkit: v.string() })) },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    for (const account of args.accounts) {
      const row = await ctx.db.query("connectorHealth").withIndex("by_account", (q) => q.eq("accountId", account.accountId).eq("toolkit", account.toolkit)).first();
      if (row?.authExpiredAt !== undefined) result[account.accountId] = row.authExpiredAt;
    }
    return result;
  },
});

/** Start times order concurrent observations: an older failure cannot overwrite
 * a newer successful reconnect. Successful observations retain only that clock. */
export const observe = internalMutation({
  args: { accountId: v.string(), toolkit: v.string(), startedAt: v.number(), expired: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("connectorHealth").withIndex("by_account", (q) => q.eq("accountId", args.accountId).eq("toolkit", args.toolkit)).first();
    // A successful observation wins a millisecond tie. A delayed failure at
    // that same clock must not re-mark an already recovered account.
    if (row && (row.observedAt > args.startedAt || (row.observedAt === args.startedAt && (args.expired || row.authExpiredAt === undefined)))) return null;
    const fields = { observedAt: args.startedAt, authExpiredAt: args.expired ? args.startedAt : undefined };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("connectorHealth", { accountId: args.accountId, toolkit: args.toolkit, ...fields });
    return null;
  },
});

export const forget = internalMutation({
  args: { accountId: v.string(), toolkit: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("connectorHealth").withIndex("by_account", (q) => q.eq("accountId", args.accountId).eq("toolkit", args.toolkit)).first();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
