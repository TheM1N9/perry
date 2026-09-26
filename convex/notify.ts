import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { loadConversation } from "./brain";
import { saveMessages } from "./lib/agent";
import { sendMessage } from "./lib/telegram";

/**
 * Assistant speaking first.
 *
 * Everything proactive goes through here, so there is exactly one place that
 * decides whether an unprompted message is allowed to leave. If nobody has
 * claimed this install, nothing does.
 */
export const toOwner = internalAction({
  args: { text: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const install = await ctx.runQuery(internal.installation.get, {});

    if (!install?.claimedAt || !install.ownerExternalId) {
      console.warn("nothing to notify: install is unclaimed");
      return false;
    }
    if (install.ownerChannel !== "telegram") {
      // The dashboard reads from the database, so a web owner sees it anyway.
      return false;
    }

    try {
      const token: string | null = await ctx.runQuery(internal.secrets.get, {
        name: "TELEGRAM_BOT_TOKEN",
      });
      // Job results are the agent's Markdown; plain alerts read the same either way.
      await sendMessage(token, install.ownerExternalId, args.text, { markdown: true });
      // It belongs to the owner's Telegram chat too: shown in its history, and told to the next turn there.
      // Made here if the owner has not written since pairing.
      const chat = await loadConversation(ctx, "telegram", install.ownerExternalId);
      await saveMessages(ctx, { threadId: chat.threadId, messages: [{ role: "assistant", content: args.text }] });
      await ctx.runMutation(internal.conversations.noteUnprompted, { id: chat._id, text: args.text });
      return true;
    } catch (error) {
      console.error(`could not notify owner: ${String(error)}`);
      return false;
    }
  },
});
