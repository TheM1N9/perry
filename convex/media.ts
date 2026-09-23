import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";

/**
 * Local media: chat files that stay on the owner's machine, wherever the agent
 * or the upload inbox put them. The row records the absolute path; the Next.js
 * server on that machine serves the file from there, by attachment id, and
 * only for rows that exist, so nothing unregistered is ever reachable.
 */
export const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
};

export function describePath(path: string): { fileName: string; contentType: string } {
  const fileName = path.split(/[\\/]/).pop() || "file";
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  return { fileName, contentType: TYPES[extension] ?? "application/octet-stream" };
}

const attachmentShape = v.object({
  url: v.optional(v.string()),
  localPath: v.optional(v.string()),
  fileName: v.string(),
  contentType: v.string(),
});

/** Resolve a queued turn's files without exposing storage ids. Local files go by path. */
export const forTurn = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    attachmentIds: v.array(v.id("chatAttachments")),
  },
  returns: v.array(attachmentShape),
  handler: async (ctx, args) => {
    const result: Array<{ url?: string; localPath?: string; fileName: string; contentType: string }> = [];
    for (const id of args.attachmentIds as Id<"chatAttachments">[]) {
      const row = await ctx.db.get(id);
      if (!row || row.conversationId !== args.conversationId) continue;
      if (row.localPath) {
        result.push({ localPath: row.localPath, fileName: row.fileName, contentType: row.contentType });
        continue;
      }
      const url = row.storageId ? await ctx.storage.getUrl(row.storageId) : null;
      if (url) result.push({ url, fileName: row.fileName, contentType: row.contentType });
    }
    return result;
  },
});

/** The local media server asks this before accepting an upload. */
export const canStoreLocally = query({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    assertDashboardKey(args.key);
    return true;
  },
});

/** Where a local attachment lives, for the local media server. */
export const localAttachment = query({
  args: { key: v.string(), id: v.string() },
  returns: v.union(v.null(), v.object({ localPath: v.string(), fileName: v.string(), contentType: v.string() })),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("chatAttachments", args.id);
    const row = id ? await ctx.db.get(id) : null;
    return row?.localPath ? { localPath: row.localPath, fileName: row.fileName, contentType: row.contentType } : null;
  },
});

/** Codex's share_file: show a file from the owner's machine in the reply to this turn. */
export const shareFromTurn = internalMutation({
  args: { turnId: v.id("codexTurns"), path: v.string() },
  returns: v.object({ fileName: v.string(), contentType: v.string() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.turnId);
    if (!job) throw new Error("This turn is gone.");
    if (!ABSOLUTE_PATH.test(args.path)) throw new Error("Give the file's absolute path.");
    const described = describePath(args.path);
    const mediaKey = `codex-${job._id}`;
    const existing = await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", job.conversationId).eq("messageKey", mediaKey))
      .collect();
    if (!existing.some((row) => row.localPath === args.path)) {
      await ctx.db.insert("chatAttachments", {
        conversationId: job.conversationId,
        messageKey: mediaKey,
        localPath: args.path,
        ...described,
        size: 0,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(job._id, { mediaKey });
    return described;
  },
});
