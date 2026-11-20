import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { decryptCredential } from "./lib/credential-encryption";
import { KEYS, type Key, type KeyName } from "./lib/scroll/types";

/**
 * internet_scroll's memory and keys (lib/scroll). What a topic has shown is
 * kept per topic, so the next run of it returns only what is new; the keys
 * for the optional sources are the owner's logins in Settings → Logins &
 * secrets, found by name, read here and never handed to the agent.
 */

/** The most posts a topic remembers: about a month of daily runs at the most a run shows. */
const KEEP = 2_500;
/** A topic not scrolled for this long is forgotten. */
const IDLE_MS = 90 * 24 * 60 * 60 * 1000;

export const seen = internalQuery({
  args: { topic: v.string() },
  handler: async (ctx, args): Promise<string[]> =>
    (await ctx.db.query("scrollSeen").withIndex("by_topic", (q) => q.eq("topic", args.topic)).unique())?.keys ?? [],
});

/** Add what a run showed; the oldest fall off past the cap, and long-idle topics go. */
export const remember = internalMutation({
  args: { topic: v.string(), keys: v.array(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const row = await ctx.db.query("scrollSeen").withIndex("by_topic", (q) => q.eq("topic", args.topic)).unique();
    // seenKey bounds every key, so what is stored is what the next run compares.
    const fresh = args.keys.filter((key) => key.length <= 300);
    const keep = new Set(fresh);
    const keys = [...(row?.keys ?? []).filter((key) => !keep.has(key)), ...fresh].slice(-KEEP);
    if (row) await ctx.db.patch(row._id, { keys, updatedAt: now });
    else await ctx.db.insert("scrollSeen", { topic: args.topic, keys, updatedAt: now });
    for (const idle of await ctx.db.query("scrollSeen").withIndex("by_updated", (q) => q.lt("updatedAt", now - IDLE_MS)).take(50)) await ctx.db.delete(idle._id);
  },
});

const named = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The keys the owner has saved for the optional sources, by the login's name, or in the environment. */
export const keys = internalQuery({
  args: {},
  handler: async (ctx): Promise<Partial<Record<KeyName, Key>>> => {
    const logins = await ctx.db.query("vault").collect();
    const found: Partial<Record<KeyName, Key>> = {};
    for (const [name, spec] of Object.entries(KEYS) as Array<[KeyName, (typeof KEYS)[KeyName]]>) {
      const wanted = new Set<string>(spec.names.map(named));
      const login = logins.filter((row) => wanted.has(named(row.label))).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (login) {
        const value = decryptCredential("vault", login.value).trim();
        if (value) found[name] = { value, ...(login.username ? { username: login.username } : {}) };
        continue;
      }
      const env = process.env[spec.env]?.trim();
      if (name === "reddit") {
        const secret = process.env.REDDIT_CLIENT_SECRET?.trim();
        if (env && secret) found.reddit = { username: env, value: secret };
      } else if (env) found[name] = { value: env };
    }
    return found;
  },
});
