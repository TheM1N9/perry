import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const ALLOWED_NAMES = new Set([
  "TELEGRAM_BOT_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "COMPOSIO_API_KEY",
  "GEMINI_API_KEY",
  "PERRY_CARTESIA_API_KEY",
  "PERRY_OPENAI_API_KEY",
  "PERRY_VOICE_PROVIDER",
  "PERRY_WHATSAPP_DRIVER",
  "PERRY_WHATSAPP_CONTROL",
]);

export const has = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
  
    const key = name.toUpperCase();
    const value = process.env[key];
    return { exists: Boolean(value && value.length > 0) };
  },
});

export const get = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const key = name.toUpperCase();
    const value = process.env[key];
    return { value: value && value.length > 0 ? value : null };
  },
});

export const status = query({
  args: {},
  handler: async () => {
    return {
      keys: Array.from(ALLOWED_NAMES).filter((k) => Boolean(process.env[k])),
    };
  },
});

export const list = query({
  args: {},
  handler: async () => {
    return {
      keys: Array.from(ALLOWED_NAMES).filter((k) => Boolean(process.env[k])),
    };
  },
});

export const set = mutation({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {

    const key = name.toUpperCase();
    if (!ALLOWED_NAMES.has(key) && !key.startsWith("PERRY_")) {
      return { error: "Secret not allowed" };
    }
    // Secrets are managed via deployment env; do not mutate process.env here.
    return { ok: true, key };
  },
});

export const save = mutation({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {

    const key = name.toUpperCase();
    if (!ALLOWED_NAMES.has(key) && !key.startsWith("PERRY_")) {
      return { error: "Secret not allowed" };
    }
    // Do not persist runtime secret; set via deployment environment variables.
    return { ok: false, key, error: "Set secret via deployment environment variables" };
  },
});

export const clear = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {

    const key = name.toUpperCase();
    return { ok: true, key };
  },
});
