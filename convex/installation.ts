import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { vAccess, vChannel } from "./schema";

/**
 * Who owns this install, and how they proved it.
 *
 * Assistant is one person's assistant. Not one person per row in a users table, one
 * person per deployment: you install it, it is yours, and nobody else's data is
 * anywhere near it. This file is the whole of that idea.
 *
 * Claiming works with a pairing code rather than first-message-wins, because a
 * bot username is guessable and the window between registering the webhook and
 * sending your first message is not zero.
 */

const PAIRING_TTL_MS = 60 * 60 * 1000; // an hour, same as OpenClaw

/** Digits only, no ambiguity when read off a terminal and typed into a phone. */
function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

async function read(ctx: {
  db: { query: (t: "installation") => { unique: () => Promise<Doc<"installation"> | null> } };
}): Promise<Doc<"installation"> | null> {
  return await ctx.db.query("installation").unique();
}

/** Where getting to know each other stands; "offer" is an install from before it existed. */
export type Onboarding = "pending" | "done" | "skipped" | "offer";

/** "offer" clears it, as on an install from before: offered on the chat page, not opened. */
export const setOnboarding = internalMutation({
  args: { state: v.union(v.literal("pending"), v.literal("done"), v.literal("skipped"), v.literal("offer")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const onboarding = args.state === "offer" ? undefined : args.state;
    const install = await read(ctx);
    if (install) await ctx.db.patch(install._id, { onboarding });
    else await ctx.db.insert("installation", { onboarding, createdAt: Date.now() });
    return null;
  },
});

export const get = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"installation"> | null> => {
    return await read(ctx);
  },
});

/** Public-facing view. Never leaks the code once claimed. */
export const status = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    claimed: boolean;
    ownerChannel?: string;
    ownerName?: string;
    pairingCode?: string;
    pairingExpiresAt?: number;
    onboarding: Onboarding;
  }> => {
    const install = await read(ctx);
    // No row yet means setup has not finished making one: a new install, so pending.
    if (!install) return { claimed: false, onboarding: "pending" };

    const claimed = Boolean(install.claimedAt);
    return {
      claimed,
      ownerChannel: install.ownerChannel,
      ownerName: install.ownerName,
      pairingCode: claimed ? undefined : install.pairingCode,
      pairingExpiresAt: claimed ? undefined : install.pairingExpiresAt,
      onboarding: install.onboarding ?? "offer",
    };
  },
});

/**
 * Make the installation row if there is none. Setup calls it when Telegram is
 * skipped: pairing is what otherwise makes the row, and settings such as the
 * timezone, default access and the offline fallback are kept on it.
 */
export const ensure = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!(await read(ctx))) await ctx.db.insert("installation", { onboarding: "pending", createdAt: Date.now() });
    return null;
  },
});

/**
 * Mint a fresh pairing code. Called by setup, and by the dashboard when the
 * code has expired or the owner wants to move Assistant to a different chat.
 */
export const startPairing = internalMutation({
  args: {},
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    const code = newPairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const existing = await read(ctx);

    if (existing) {
      await ctx.db.patch(existing._id, {
        pairingCode: code,
        pairingExpiresAt: expiresAt,
      });
    } else {
      await ctx.db.insert("installation", {
        pairingCode: code,
        pairingExpiresAt: expiresAt,
        onboarding: "pending",
        createdAt: Date.now(),
      });
    }

    return { code, expiresAt };
  },
});

export type ClaimResult =
  | { outcome: "claimed"; }
  | { outcome: "already-owner" }
  | { outcome: "not-owner" }
  | { outcome: "bad-code" }
  | { outcome: "expired" }
  | { outcome: "needs-code" };

/**
 * Decide what to do with an inbound message from `externalId`.
 *
 * Returns "claimed" when this message just took ownership, "already-owner" for
 * the normal case, and everything else means do not process the message.
 */
export const authorize = internalMutation({
  args: {
    channel: vChannel,
    externalId: v.string(),
    name: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<ClaimResult> => {
    const install = await read(ctx);

    // No install row at all means setup never ran. Refuse rather than let the
    // first stranger through.
    if (!install) return { outcome: "needs-code" };

    if (install.claimedAt) {
      const isOwner =
        install.ownerChannel === args.channel &&
        install.ownerExternalId === args.externalId;
      return isOwner ? { outcome: "already-owner" } : { outcome: "not-owner" };
    }

    // Unclaimed. Look for the pairing code anywhere in the message, so both
    // "123456" and "/claim 123456" work.
    const supplied = args.text.match(/\b(\d{6})\b/)?.[1];
    if (!supplied) return { outcome: "needs-code" };

    if (!install.pairingCode || supplied !== install.pairingCode) {
      return { outcome: "bad-code" };
    }
    if (install.pairingExpiresAt && Date.now() > install.pairingExpiresAt) {
      return { outcome: "expired" };
    }

    await ctx.db.patch(install._id, {
      ownerChannel: args.channel,
      ownerExternalId: args.externalId,
      ownerName: args.name,
      claimedAt: Date.now(),
      pairingCode: undefined,
      pairingExpiresAt: undefined,
    });

    return { outcome: "claimed" };
  },
});

export const getSandboxId = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const install = await read(ctx);
    return install?.sandboxId ?? null;
  },
});

export const setSandboxId = internalMutation({
  args: { sandboxId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const install = await read(ctx);
    if (!install) return null;
    await ctx.db.patch(install._id, { sandboxId: args.sandboxId });
    return null;
  },
});

export const setComputeTarget = internalMutation({
  args: { target: v.union(v.literal("sandbox"), v.literal("local")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const install = await read(ctx);
    if (!install) return null;
    await ctx.db.patch(install._id, { computeTarget: args.target });
    return null;
  },
});

/** Whether approval requests also go to the owner on Telegram. */
export const setTelegramApprovals = internalMutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const install = await read(ctx);
    if (!install) return null;
    await ctx.db.patch(install._id, { telegramApprovals: args.enabled });
    return null;
  },
});

/**
 * The access a new chat starts with. Read when a chat is created, so changing
 * it leaves existing chats as they are. Job chats never take it: a job runs
 * supervised unless its chat is set otherwise.
 */
export async function defaultAccess(ctx: Parameters<typeof read>[0]): Promise<"supervised" | "full"> {
  return (await read(ctx))?.defaultAccess ?? "supervised";
}

export const setDefaultAccess = internalMutation({
  args: { access: vAccess },
  returns: v.null(),
  handler: async (ctx, args) => {
    const install = await read(ctx);
    if (!install) throw new Error("Run pnpm run setup first.");
    await ctx.db.patch(install._id, { defaultAccess: args.access });
    return null;
  },
});

/** Hand Assistant to a different chat, or to a different person entirely. */
export const unclaim = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const install = await read(ctx);
    if (!install) return null;

    await ctx.db.patch(install._id, {
      ownerChannel: undefined,
      ownerExternalId: undefined,
      ownerName: undefined,
      claimedAt: undefined,
    });
    return null;
  },
});
