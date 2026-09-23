import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Where Assistant's service keys live.
 *
 * Every key is read here rather than straight from `process.env`, and the
 * database wins over the environment. That single rule is what lets the
 * dashboard change a key without a terminal, while an install that was set up
 * with `pnpm exec convex env set` keeps working untouched.
 *
 * Keys are write-and-forget: they go in, and nothing ever reads one back out
 * to a browser. The dashboard sees whether a key is set, where it came from,
 * and its last four characters. That is enough to tell two keys apart and not
 * enough to use one.
 */

export const SECRET_NAMES = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "COMPOSIO_API_KEY",
  "DAYTONA_API_KEY",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

export const SECRET_LABELS: Record<SecretName, { label: string; hint: string }> = {
  TELEGRAM_BOT_TOKEN: {
    label: "Telegram bot token",
    hint: "From @BotFather. Changing it points Assistant at a different bot, so re-register the webhook afterwards.",
  },
  TELEGRAM_WEBHOOK_SECRET: {
    label: "Telegram webhook secret",
    hint: "Shared with Telegram so a stranger cannot post fake updates. Change it and re-register the webhook.",
  },
  COMPOSIO_API_KEY: {
    label: "Composio key",
    hint: "Gmail, Calendar, Notion and the rest. Without it no accounts can be connected.",
  },
  DAYTONA_API_KEY: {
    label: "Daytona key",
    hint: "The cloud sandbox. Not needed if Assistant runs on your own machine instead.",
  },
};

/**
 * Resolve one key. Database first, environment second.
 *
 * Everything that needs a key goes through here, so there is one place to look
 * when a key appears to be wrong.
 */
export const get = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("secrets")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();

    if (row && row.value.length > 0) return row.value;
    return process.env[args.name] ?? null;
  },
});

export type SecretStatus = {
  name: string;
  label: string;
  hint: string;
  set: boolean;
  source: "dashboard" | "environment" | "none";
  preview?: string;
  updatedAt?: number;
};

/** What the dashboard is allowed to know: set or not, from where, last four. */
export const status = internalQuery({
  args: {},
  handler: async (ctx): Promise<SecretStatus[]> => {
    const rows = await ctx.db.query("secrets").collect();
    const stored = new Map(rows.map((r) => [r.name, r]));

    return SECRET_NAMES.map((name) => {
      const row = stored.get(name);
      const fromDb = row && row.value.length > 0;
      const value = fromDb ? row.value : (process.env[name] ?? "");

      return {
        name,
        label: SECRET_LABELS[name].label,
        hint: SECRET_LABELS[name].hint,
        set: value.length > 0,
        source: fromDb ? "dashboard" : value.length > 0 ? "environment" : "none",
        preview: value.length > 0 ? `…${value.slice(-4)}` : undefined,
        updatedAt: row?.updatedAt,
      };
    });
  },
});

export const set = internalMutation({
  args: { name: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isSecretName(args.name)) return null;

    const value = args.value.trim();
    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("secrets", { name: args.name, value, updatedAt: Date.now() });
    }
    return null;
  },
});

/**
 * Drop the stored value. If the deployment still has an environment variable
 * of the same name, that takes over again rather than leaving nothing.
 */
export const clear = internalMutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});
