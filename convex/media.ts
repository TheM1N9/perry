import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const attachmentShape = v.object({
  url: v.string(),
  fileName: v.string(),
  contentType: v.string(),
});

/** Resolve storage-backed files for a queued turn without exposing storage ids. */
export const forTurn = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    attachmentIds: v.array(v.id("chatAttachments")),
  },
  returns: v.array(attachmentShape),
  handler: async (ctx, args) => {
    const result: Array<{ url: string; fileName: string; contentType: string }> = [];
    for (const id of args.attachmentIds as Id<"chatAttachments">[]) {
      const row = await ctx.db.get(id);
      if (!row || row.conversationId !== args.conversationId) continue;
      const url = await ctx.storage.getUrl(row.storageId);
      if (url) result.push({ url, fileName: row.fileName, contentType: row.contentType });
    }
    return result;
  },
});
