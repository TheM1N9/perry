import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { decryptCredential, encryptCredential } from "./lib/credential-encryption";

function retainedJSON(value: string): string {
  return JSON.stringify(JSON.parse(value), (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const context = record.contextInfo;
    if (record.ephemeralMessage || record.viewOnceMessage || record.viewOnceMessageV2 || record.viewOnceMessageV2Extension
      || context && typeof context === "object" && (context as Record<string, unknown>).expiration) {
      return { conversation: "Disappearing or view-once content was not retained." };
    }
    return item;
  });
}

export const keepMessage = internalMutation({
  args: { key: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (Buffer.byteLength(args.value) > 256 * 1024) return null;
    const old = await ctx.db.query("whatsappProtocol").withIndex("by_key", q => q.eq("key", args.key)).unique();
    const fields = { key: args.key, value: encryptCredential("whatsappAuth", JSON.stringify({ key: args.key, value: retainedJSON(args.value) })), createdAt: Date.now() };
    if (old) await ctx.db.patch(old._id, fields);
    else await ctx.db.insert("whatsappProtocol", fields);
    const rows = await ctx.db.query("whatsappProtocol").withIndex("by_created").order("desc").collect();
    for (const [index, row] of rows.entries()) if (index >= 500 || row.createdAt < Date.now() - 86400_000) await ctx.db.delete(row._id);
    return null;
  },
});

export const message = internalQuery({
  args: { key: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("whatsappProtocol").withIndex("by_key", q => q.eq("key", args.key)).unique();
    if (!row || row.createdAt < Date.now() - 86400_000) return null;
    const decoded = JSON.parse(decryptCredential("whatsappAuth", row.value));
    if (decoded.key !== args.key) throw new Error("WhatsApp message does not match its saved protocol record.");
    return decoded.value;
  },
});

export const enqueue = internalMutation({
  args: { account: v.string(), remote: v.string(), messageId: v.string(), payload: v.string(), mode: v.union(v.literal("self"), v.literal("separate")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = JSON.stringify([args.account, args.remote, args.messageId]);
    if (await ctx.db.query("whatsappInbox").withIndex("by_key", q => q.eq("key", key)).unique()) return null;
    if (Buffer.byteLength(args.payload) > 1024 * 1024) throw new Error("WhatsApp message envelope exceeds 1 MB.");
    const now = Date.now();
    await ctx.db.insert("whatsappInbox", { ...args, payload: encryptCredential("whatsappAuth", JSON.stringify({ key, payload: retainedJSON(args.payload) })), key, state: "pending", attempts: 0, createdAt: now, nextAt: now });
    for (const state of ["done", "failed"] as const) {
      const old = await ctx.db.query("whatsappInbox").withIndex("by_state", q => q.eq("state", state).lt("createdAt", now - 7 * 86400_000)).take(50);
      for (const row of old) await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const next = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, args) => {
    const pending = await ctx.db.query("whatsappInbox").withIndex("by_state", q => q.eq("state", "pending")).take(100);
    const row = pending.find(item => item.account === args.account);
    if (!row || row.nextAt > Date.now()) return null;
    if (row.acceptedAt !== undefined) { await ctx.db.patch(row._id, { state: "done", payload: undefined }); return null; }
    let decoded: { key?: unknown; payload?: unknown };
    try {
      decoded = JSON.parse(decryptCredential("whatsappAuth", row.payload ?? ""));
      if (decoded.key !== row.key || typeof decoded.payload !== "string") throw new Error("Mismatched message.");
    } catch {
      await ctx.db.patch(row._id, { state: "failed", payload: undefined, error: "Perry could not unlock this saved incoming message. Resend it after checking the credential key and database." });
      return null;
    }
    await ctx.db.patch(row._id, { nextAt: Date.now() + 90_000 });
    return { ...row, payload: decoded.payload };
  },
});

export const recover = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    for (const row of await ctx.db.query("whatsappInbox").withIndex("by_state", q => q.eq("state", "pending")).collect()) await ctx.db.patch(row._id, { nextAt: Date.now() });
    return null;
  },
});

export const finish = internalMutation({
  args: { id: v.id("whatsappInbox"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.state !== "pending") return null;
    const attempts = row.attempts + 1;
    if (!args.error || row.acceptedAt !== undefined) await ctx.db.patch(row._id, { state: "done", payload: undefined, error: undefined });
    else await ctx.db.patch(row._id, { state: attempts >= 5 ? "failed" : "pending", attempts, nextAt: Date.now() + Math.min(60_000, 1000 * 2 ** attempts), error: args.error.slice(0, 500), ...(attempts >= 5 ? { payload: undefined } : {}) });
    return null;
  },
});
