import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { authenticate } from "./runner";

/**
 * Approvals for what a runner is asked to do on the owner's machine: a command
 * or file change Codex wants, or a command or write the runner was sent.
 *
 * The runner records each request here and asks in its terminal at the same
 * time; the dashboard shows pending requests live. Whichever answers first
 * wins. A request nobody answers expires, as declined, after APPROVAL_TTL_MS.
 * With auto-approve on, requests are recorded as "auto" so there is still a
 * record of what ran.
 */
export const APPROVAL_TTL_MS = 10 * 60_000;

const vKind = v.union(v.literal("command"), v.literal("file"), v.literal("write"));

export const request = mutation({
  args: {
    token: v.string(),
    kind: vKind,
    title: v.string(),
    detail: v.optional(v.string()),
    cwd: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    auto: v.boolean(),
  },
  returns: v.id("approvals"),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    return await ctx.db.insert("approvals", {
      runnerId: runner._id,
      conversationId: args.conversationId,
      kind: args.kind,
      title: args.title.slice(0, 4000),
      detail: args.detail?.slice(0, 4000),
      cwd: args.cwd,
      status: args.auto ? "auto" : "pending",
      createdAt: Date.now(),
    });
  },
});

/** The runner watches its request here, to hear a dashboard answer. */
export const decision = query({
  args: { token: v.string(), id: v.id("approvals") },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    return row?.runnerId === runner._id ? row.status : null;
  },
});

/** The runner records an answer given in its terminal, or a timeout. */
export const settle = mutation({
  args: { token: v.string(), id: v.id("approvals"), approved: v.boolean(), by: v.union(v.literal("terminal"), v.literal("timeout")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (row?.runnerId !== runner._id || row.status !== "pending") return null;
    await ctx.db.patch(row._id, {
      status: args.by === "timeout" ? "expired" : args.approved ? "approved" : "declined",
      decidedBy: args.by,
      decidedAt: Date.now(),
    });
    return null;
  },
});

export type PendingApproval = {
  id: Id<"approvals">;
  kind: "command" | "file" | "write";
  title: string;
  detail?: string;
  cwd?: string;
  runner: string;
  chat?: { id: Id<"conversations">; title: string };
  createdAt: number;
  expiresAt: number;
};

/** What is waiting for the owner, newest first. */
export const pending = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<PendingApproval[]> => {
    assertDashboardKey(args.key);
    const rows = await ctx.db.query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending").gt("createdAt", Date.now() - APPROVAL_TTL_MS))
      .order("desc")
      .take(20);
    return await Promise.all(rows.map(async (row) => {
      const runner = await ctx.db.get(row.runnerId);
      const chat = row.conversationId ? await ctx.db.get(row.conversationId) : null;
      return {
        id: row._id,
        kind: row.kind,
        title: row.title,
        detail: row.detail,
        cwd: row.cwd,
        runner: runner?.name ?? "a runner",
        chat: chat ? { id: chat._id, title: chat.title ?? "Untitled chat" } : undefined,
        createdAt: row.createdAt,
        expiresAt: row.createdAt + APPROVAL_TTL_MS,
      };
    }));
  },
});

/** The owner's answer from the dashboard. First answer wins. */
export const decide = mutation({
  args: { key: v.string(), id: v.id("approvals"), approved: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "pending" || row.createdAt < Date.now() - APPROVAL_TTL_MS) return false;
    await ctx.db.patch(row._id, { status: args.approved ? "approved" : "declined", decidedBy: "dashboard", decidedAt: Date.now() });
    return true;
  },
});
