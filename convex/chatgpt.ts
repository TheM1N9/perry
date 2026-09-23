import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { authenticate } from "./runner";

/**
 * Answering without the computer.
 *
 * Every turn runs on Codex through the owner's runner. When no runner can take
 * one and the owner has turned this on, the turn is answered in Convex instead
 * (fallback.ts), on the same ChatGPT subscription. For that, each runner pushes
 * the access token its Codex holds, with the account id and expiry. Codex owns
 * the sign-in and refreshes the token on the machine; the refresh token never
 * leaves it.
 *
 * The cost is the access token living in this deployment until it expires:
 * whoever can read the deployment's data can use the subscription until then.
 * So it is off by default, pushed only while it is on, deleted when it is
 * turned off, when its runner is revoked and when it expires, and no public
 * function returns it.
 */

/** Saved on the replies it wrote, so the web chat can say they came without the computer. */
export const FALLBACK_PROVIDER = "chatgpt-fallback";

/** A token this close to expiry is not handed out, so a reply does not start on one about to die. */
const EXPIRY_MARGIN_MS = 60_000;

type TokenCtx = { db: QueryCtx["db"] };

async function tokensOf(ctx: TokenCtx, runnerId: Id<"runners">) {
  return await ctx.db.query("chatgptTokens").withIndex("by_runner", (q) => q.eq("runnerId", runnerId)).collect();
}

async function enabled(ctx: TokenCtx): Promise<boolean> {
  return (await ctx.db.query("installation").unique())?.offlineFallback === true;
}

/** Tokens still worth using, the longest-lived first. */
async function validTokens(ctx: TokenCtx): Promise<Doc<"chatgptTokens">[]> {
  const rows = await ctx.db.query("chatgptTokens").collect();
  return rows.filter((row) => row.expiresAt > Date.now() + EXPIRY_MARGIN_MS).sort((a, b) => b.expiresAt - a.expiresAt);
}

// --- Runner side ---------------------------------------------------------

/**
 * A runner reports the token its Codex holds now. Without one (signed out, or
 * the setting is off), whatever this runner pushed before is deleted.
 */
export const pushToken = mutation({
  args: {
    token: v.string(),
    accessToken: v.optional(v.string()),
    accountId: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const existing = await tokensOf(ctx, runner._id);
    const keep = await enabled(ctx) && args.accessToken && args.accessToken.length <= 20_000
      && args.expiresAt !== undefined && args.expiresAt > Date.now();
    if (!keep) {
      for (const row of existing) await ctx.db.delete(row._id);
      return null;
    }
    const row = { accessToken: args.accessToken!, accountId: args.accountId?.slice(0, 200), expiresAt: args.expiresAt!, updatedAt: Date.now() };
    const [first, ...rest] = existing;
    for (const extra of rest) await ctx.db.delete(extra._id);
    let id = first?._id;
    if (id) await ctx.db.patch(id, row);
    else id = await ctx.db.insert("chatgptTokens", { runnerId: runner._id, ...row });
    await ctx.scheduler.runAt(row.expiresAt, internal.chatgpt.expire, { id });
    return null;
  },
});

export const expire = internalMutation({
  args: { id: v.id("chatgptTokens") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row && row.expiresAt <= Date.now()) await ctx.db.delete(row._id);
    return null;
  },
});

// --- Fallback side -------------------------------------------------------

/** The token for a fallback turn: the chat's own runner's if it is valid, else the freshest. */
export const tokenFor = internalQuery({
  args: { runnerId: v.optional(v.id("runners")) },
  handler: async (ctx, args): Promise<{ accessToken: string; accountId?: string } | null> => {
    if (!(await enabled(ctx))) return null;
    const valid = await validTokens(ctx);
    const row = valid.find((item) => item.runnerId === args.runnerId) ?? valid[0];
    return row ? { accessToken: row.accessToken, accountId: row.accountId } : null;
  },
});

/** ChatGPT refused this token, so no later turn tries it again. */
export const discard = internalMutation({
  args: { accessToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const row of await ctx.db.query("chatgptTokens").collect()) {
      if (row.accessToken === args.accessToken) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/**
 * Queue a turn to be answered in Convex, when no runner can take it. Returns
 * why not otherwise, so the error can say what would make it work.
 */
export async function startFallback(
  ctx: MutationCtx,
  turn: Pick<Doc<"codexTurns">, "conversationId" | "runId" | "prompt" | "history" | "instructions" | "requestedModel" | "attachments">,
): Promise<{ id: Id<"codexTurns"> } | { reason: "off" | "no-token" }> {
  if (!(await enabled(ctx))) return { reason: "off" };
  if ((await validTokens(ctx)).length === 0) return { reason: "no-token" };
  const id = await ctx.db.insert("codexTurns", {
    ...turn,
    fallback: true,
    status: "running",
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.fallback.answer, { id });
  return { id };
}

// --- Dashboard -----------------------------------------------------------

/** The setting, and until when a turn could be answered: never the token itself. */
export const status = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ enabled: boolean; validUntil?: number; machines: Array<{ name: string; expiresAt: number }> }> => {
    assertDashboardKey(args.key);
    const valid = await validTokens(ctx);
    const machines = await Promise.all(valid.map(async (row) => ({
      name: (await ctx.db.get(row.runnerId))?.name ?? "Removed machine",
      expiresAt: row.expiresAt,
    })));
    return { enabled: await enabled(ctx), validUntil: valid[0]?.expiresAt, machines };
  },
});

export const setEnabled = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").unique();
    if (!install) throw new Error("Run pnpm run setup first.");
    await ctx.db.patch(install._id, { offlineFallback: args.enabled });
    // Turned off, no token stays behind; runners push again when it is turned back on.
    if (!args.enabled) {
      for (const row of await ctx.db.query("chatgptTokens").collect()) await ctx.db.delete(row._id);
    }
    return null;
  },
});
