import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** The accounts connections are signed in to, as far as they have been asked. See composio.accounts. */
export const identities = internalQuery({
  args: { accountIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, { identity?: string; checkedAt: number }>> => {
    const found: Record<string, { identity?: string; checkedAt: number }> = {};
    for (const accountId of args.accountIds) {
      const row = await ctx.db.query("connectorAccounts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first();
      if (row) found[accountId] = { identity: row.identity, checkedAt: row.checkedAt };
    }
    return found;
  },
});

export const remember = internalMutation({
  args: { accountId: v.string(), toolkit: v.string(), identity: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("connectorAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).first();
    if (row) await ctx.db.patch(row._id, { identity: args.identity, checkedAt: Date.now() });
    else await ctx.db.insert("connectorAccounts", { ...args, checkedAt: Date.now() });
    return null;
  },
});

export const forget = internalMutation({
  args: { accountId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("connectorAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).first();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
