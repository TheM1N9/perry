import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { loadConversation } from "./brain";
import type { Target } from "./channels";
import { saveMessages } from "./lib/agent";
import { sendMessage } from "./lib/telegram";

/**
 * Assistant speaking first.
 *
 * Everything proactive goes through here, so there is exactly one place that
 * decides whether an unprompted message is allowed to leave, and where to:
 * back to the conversation it came from (origin), else the owner's messaging
 * channel (channels.ts). If nobody has claimed this install, nothing leaves.
 */
export const deliver = internalAction({
  args: {
    text: v.string(),
    /** The conversation this came from: a job's chat, or the chat a job or watch was set up in. */
    origin: v.optional(v.id("conversations")),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const install = await ctx.runQuery(internal.installation.get, {});
    if (!install?.claimedAt) {
      console.warn("nothing to deliver: install is unclaimed");
      return false;
    }
    const target: Target | null = await ctx.runQuery(internal.channels.target, { conversationId: args.origin });
    // A web-only owner reads it on the dashboard, in the job's own chat.
    if (!target) return false;

    try {
      let conversationId: Id<"conversations">;
      if (target.channel === "web") {
        conversationId = target.conversationId;
      } else if (target.channel === "telegram") {
        // Only ever the owner's own chat.
        if (install.ownerChannel !== "telegram" || target.externalId !== install.ownerExternalId) return false;
        const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
        // Job results are the agent's Markdown; plain alerts read the same either way.
        await sendMessage(token, target.externalId, args.text, { markdown: true });
        // Made here if the owner has not written since pairing.
        conversationId = target.conversationId ?? (await loadConversation(ctx, "telegram", target.externalId))._id;
      } else {
        // Queued for the connection (server/whatsapp.ts); it goes when WhatsApp is connected. Only ever the owner.
        if (!(await ctx.runMutation(internal.whatsapp.send, { to: target.externalId, text: args.text }))) return false;
        conversationId = target.conversationId ?? (await loadConversation(ctx, "whatsapp", target.externalId))._id;
      }
      // It belongs to that chat: shown in its history, and told to the next turn there.
      const chat = await ctx.runQuery(internal.conversations.getById, { id: conversationId });
      if (!chat) return false;
      await saveMessages(ctx, { threadId: chat.threadId, messages: [{ role: "assistant", content: args.text }] });
      await ctx.runMutation(internal.conversations.noteUnprompted, { id: conversationId, text: args.text });
      return true;
    } catch (error) {
      console.error(`could not deliver to the owner: ${String(error)}`);
      return false;
    }
  },
});
