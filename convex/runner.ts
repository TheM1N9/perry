import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { vPolicy } from "./schema";

/**
 * The protocol between Assistant and a machine the owner has connected.
 *
 * These are public functions because the runner is not a browser session and
 * has no Convex identity. It authenticates with a token that this deployment
 * minted, held in a file on that machine and sent with every call. One token
 * per machine, revocable from the dashboard.
 *
 * The runner opens the connection and keeps it. Its work (Codex turns, see
 * codex.ts) reaches it over the change stream it already has open, so nothing
 * has to listen on a port and nothing has to be reachable from the internet.
 * That is the whole reason this design is safe to hand to someone who is not
 * thinking about firewalls.
 */

/** Constant time, so a token cannot be recovered a character at a time. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authenticate(
  ctx: { db: { query: (t: "runners") => any } },
  token: string,
): Promise<Doc<"runners">> {
  const runner = await ctx.db
    .query("runners")
    .withIndex("by_token", (q: any) => q.eq("token", token))
    .unique();

  if (!runner || runner.revoked || !sameToken(runner.token, token)) {
    throw new Error("This runner token is not valid. Run `pnpm run connect` again.");
  }
  return runner;
}

export type Policy = "ask" | "review" | "trust";

/** A runner's approval policy. Runners from before policies stored only autoApprove. */
export function policyOf(runner: Doc<"runners">): Policy {
  return runner.policy ?? (runner.autoApprove ? "trust" : "ask");
}

// --- Runner side ---------------------------------------------------------

/**
 * Called once at startup, and then on a timer, so the dashboard can show it.
 * A policy is sent only when the runner was started with --policy; otherwise
 * the one chosen in the dashboard stands. autoApprove is the older form of
 * the same setting.
 */
export const checkIn = mutation({
  args: {
    token: v.string(),
    platform: v.optional(v.string()),
    hostname: v.optional(v.string()),
    workdir: v.optional(v.string()),
    policy: v.optional(vPolicy),
    autoApprove: v.optional(v.boolean()),
  },
  returns: v.object({ name: v.string(), policy: vPolicy }),
  handler: async (ctx, args): Promise<{ name: string; policy: Policy }> => {
    const runner = await authenticate(ctx, args.token);
    const policy = args.policy
      ?? (args.autoApprove === undefined ? policyOf(runner) : args.autoApprove ? "trust" : "ask");

    await ctx.db.patch(runner._id, {
      platform: args.platform ?? runner.platform,
      hostname: args.hostname ?? runner.hostname,
      workdir: args.workdir ?? runner.workdir,
      policy,
      autoApprove: policy === "trust",
      lastSeenAt: Date.now(),
    });

    return { name: runner.name, policy };
  },
});

// --- Assistant side ----------------------------------------------------------

export const createToken = internalMutation({
  args: { name: v.string(), token: v.string() },
  returns: v.id("runners"),
  handler: async (ctx, args): Promise<Id<"runners">> => {
    return await ctx.db.insert("runners", {
      name: args.name.slice(0, 80),
      token: args.token,
      autoApprove: false,
      revoked: false,
      createdAt: Date.now(),
    });
  },
});

export const listRunners = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"runners">[]> => {
    return await ctx.db.query("runners").order("desc").take(20);
  },
});

/** A runner counts as online if it has checked in within the last 90 seconds. */
export const liveRunner = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"runners"> | null> => {
    const runners = await ctx.db.query("runners").take(20);
    const cutoff = Date.now() - 90_000;

    const live = runners
      .filter((r) => !r.revoked && (r.lastSeenAt ?? 0) > cutoff)
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

    return live[0] ?? null;
  },
});

/** Chosen in the dashboard. Every request reads it, so it applies at once. */
export const setPolicy = internalMutation({
  args: { runnerId: v.string(), policy: vPolicy },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const id = ctx.db.normalizeId("runners", args.runnerId);
    if (!id) return null;
    await ctx.db.patch(id, { policy: args.policy, autoApprove: args.policy === "trust" });
    return null;
  },
});

export const revokeRunner = internalMutation({
  args: { runnerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const id = ctx.db.normalizeId("runners", args.runnerId);
    if (!id) return null;
    await ctx.db.patch(id, { revoked: true });
    // Chats that ran on it move to whichever runner is online next.
    for (const chat of await ctx.db.query("conversations").collect()) {
      if (chat.codexRunnerId === id) await ctx.db.patch(chat._id, { codexRunnerId: undefined });
    }
    return null;
  },
});
