import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { AccountProfile } from "./composio";

/** The accounts connections are signed in to, as far as they have been asked. See composio.accounts. */
export const identities = internalQuery({
  args: { accountIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, { identity?: string; profile?: AccountProfile; checkedAt: number }>> => {
    const found: Record<string, { identity?: string; profile?: AccountProfile; checkedAt: number }> = {};
    for (const accountId of args.accountIds) {
      const row = await ctx.db.query("connectorAccounts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first();
      if (row) found[accountId] = { identity: row.identity, profile: row.profile, checkedAt: row.checkedAt };
    }
    return found;
  },
});

export const remember = internalMutation({
  args: { accountId: v.string(), toolkit: v.string(), identity: v.optional(v.string()), profile: v.optional(v.object({ email: v.optional(v.string()), username: v.optional(v.string()), displayName: v.optional(v.string()), workspace: v.optional(v.string()) })) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("connectorAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).first();
    if (row) await ctx.db.patch(row._id, { identity: args.identity, profile: args.profile, checkedAt: Date.now() });
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
