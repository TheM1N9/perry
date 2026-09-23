import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

/**
 * The protocol between Assistant and a machine the owner has connected.
 *
 * These are public functions because the runner is not a browser session and
 * has no Convex identity. It authenticates with a token that this deployment
 * minted, held in a file on that machine and sent with every call. One token
 * per machine, revocable from the dashboard.
 *
 * The runner opens the connection and keeps it. Convex pushes queued work down
 * the socket the runner already has open, so nothing has to listen on a port
 * and nothing has to be reachable from the internet. That is the whole reason
 * this design is safe to hand to someone who is not thinking about firewalls.
 */

const MAX_OUTPUT = 20_000;

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

// --- Runner side ---------------------------------------------------------

/**
 * Called once at startup, and then on a timer, so the dashboard can show it.
 * `fallback` says whether the owner lets turns be answered without this
 * machine, which is when the runner pushes its ChatGPT token (chatgpt.ts),
 * and `holdsToken` whether Convex still has the one it pushed.
 */
export const checkIn = mutation({
  args: {
    token: v.string(),
    platform: v.optional(v.string()),
    hostname: v.optional(v.string()),
    workdir: v.optional(v.string()),
    autoApprove: v.optional(v.boolean()),
  },
  returns: v.object({ name: v.string(), fallback: v.boolean(), holdsToken: v.boolean() }),
  handler: async (ctx, args): Promise<{ name: string; fallback: boolean; holdsToken: boolean }> => {
    const runner = await authenticate(ctx, args.token);

    await ctx.db.patch(runner._id, {
      platform: args.platform ?? runner.platform,
      hostname: args.hostname ?? runner.hostname,
      workdir: args.workdir ?? runner.workdir,
      autoApprove: args.autoApprove ?? runner.autoApprove,
      lastSeenAt: Date.now(),
    });

    const install = await ctx.db.query("installation").unique();
    const held = await ctx.db.query("chatgptTokens").withIndex("by_runner", (q) => q.eq("runnerId", runner._id)).first();
    return { name: runner.name, fallback: install?.offlineFallback === true, holdsToken: held !== null };
  },
});

/**
 * Work waiting for this machine. The runner subscribes to this, so Convex
 * pushes new commands down the connection the runner already opened.
 */
export const queued = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Doc<"commands">[]> => {
    const runner = await authenticate(ctx, args.token);
    return await ctx.db
      .query("commands")
      .withIndex("by_runner_status", (q) =>
        q.eq("runnerId", runner._id).eq("status", "queued"),
      )
      .take(5);
  },
});

export const claimCommand = mutation({
  args: { token: v.string(), commandId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const runner = await authenticate(ctx, args.token);
    const id = ctx.db.normalizeId("commands", args.commandId);
    if (!id) return false;

    const command = await ctx.db.get(id);
    // Only the owning runner, and only if nobody else took it first.
    if (!command || command.runnerId !== runner._id) return false;
    if (command.status !== "queued") return false;

    await ctx.db.patch(id, { status: "running", startedAt: Date.now() });
    return true;
  },
});

export const finishCommand = mutation({
  args: {
    token: v.string(),
    commandId: v.string(),
    status: v.union(v.literal("done"), v.literal("denied"), v.literal("error")),
    exitCode: v.optional(v.number()),
    output: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const runner = await authenticate(ctx, args.token);
    const id = ctx.db.normalizeId("commands", args.commandId);
    if (!id) return null;

    const command = await ctx.db.get(id);
    if (!command || command.runnerId !== runner._id) return null;

    await ctx.db.patch(id, {
      status: args.status,
      exitCode: args.exitCode,
      output: args.output?.slice(0, MAX_OUTPUT),
      truncated: args.truncated,
      error: args.error?.slice(0, 2000),
      finishedAt: Date.now(),
    });
    return null;
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
    // Its ChatGPT token goes with it.
    for (const row of await ctx.db.query("chatgptTokens").withIndex("by_runner", (q) => q.eq("runnerId", id)).collect()) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const enqueue = internalMutation({
  args: {
    runnerId: v.id("runners"),
    kind: v.union(
      v.literal("exec"),
      v.literal("read"),
      v.literal("write"),
      v.literal("list"),
    ),
    operationId: v.string(),
    command: v.optional(v.string()),
    path: v.optional(v.string()),
    text: v.optional(v.string()),
    cwd: v.optional(v.string()),
  },
  returns: v.id("commands"),
  handler: async (ctx, args): Promise<Id<"commands">> => {
    return await ctx.db.insert("commands", {
      ...args,
      status: "queued",
      createdAt: Date.now(),
    });
  },
});

export const getCommand = internalQuery({
  args: { commandId: v.id("commands") },
  handler: async (ctx, args): Promise<Doc<"commands"> | null> => {
    return await ctx.db.get(args.commandId);
  },
});

export const abandonCommand = internalMutation({
  args: { commandId: v.id("commands"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.status === "done") return null;
    await ctx.db.patch(args.commandId, {
      status: "error",
      error: args.error,
      finishedAt: Date.now(),
    });
    return null;
  },
});

export const findByOperation = internalQuery({
  args: { operationId: v.string() },
  handler: async (ctx, args): Promise<Doc<"commands"> | null> => {
    return await ctx.db
      .query("commands")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .first();
  },
});

export const recentCommands = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<"commands">[]> => {
    return await ctx.db
      .query("commands")
      .withIndex("by_created")
      .order("desc")
      .take(Math.min(args.limit ?? 25, 100));
  },
});
