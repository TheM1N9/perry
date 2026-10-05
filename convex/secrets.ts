import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getUserId } from "./lib/auth";

/** Whether a secret exists. */
export const has = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const key = name.toUpperCase();
    if (!key.startsWith("PERRY_")) return { exists: false };
    const value = process.env[key];
    return { exists: Boolean(value && value.length > 0) };
  },
});

/** Save a secret (stored in env for this process; in a real setup encrypted at rest). */
export const save = mutation({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {
    const userId = await getUserId(ctx);
    if (!userId) return { error: "Not authenticated" };
    const key = name.toUpperCase();
    if (!key.startsWith("PERRY_")) {
      return { error: "Secret names must start with PERRY_" };
    }
    // Note: Convex env vars are set at deployment; here we only record intent
    // (runner reads process.env). This is a no-op storage-wise by design in dev.
    return { ok: true, key };
  },
});

/** List known secret keys (names only). */
export const list = query({
  args: {},
  handler: async () => {
    return {
      keys: [
        "PERRY_CARTESIA_API_KEY",
        "PERRY_OPENAI_API_KEY",
        "PERRY_VOICE_PROVIDER",
      ],
    };
  },
});
