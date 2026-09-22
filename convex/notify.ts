import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { sendMessage } from "./lib/telegram";

/**
 * Perry speaking first.
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
      await sendMessage(install.ownerExternalId, args.text);
      return true;
    } catch (error) {
      console.error(`could not notify owner: ${String(error)}`);
      return false;
    }
  },
});
