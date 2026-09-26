import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { chunkWhatsApp, toWhatsApp } from "./lib/whatsappFormat";

/**
 * WhatsApp, as a linked device (Baileys, the WhatsApp Web protocol), the way
 * OpenClaw does it. Two ways to set it up, chosen on the dashboard:
 *
 *   self       Perry links to the owner's own WhatsApp, and they talk to it in
 *              their "Message yourself" chat. Linking proves it is them.
 *   separate   Perry links to a number of its own (a spare SIM or eSIM), and
 *              the owner messages it like a contact, claiming it with the
 *              pairing code, as on Telegram.
 *
 * It answers the owner only and never writes to anyone else: WhatsApp does
 * not allow automating an account, and a number that only talks to its owner
 * is the least likely to be banned for it. The connection lives in the server
 * process (server/whatsapp.ts); this is its state, its outbox, and what comes
 * in from it.
 */

const vMode = v.union(v.literal("self"), v.literal("separate"));
const vStatus = v.union(v.literal("starting"), v.literal("qr"), v.literal("code"), v.literal("connected"), v.literal("disconnected"), v.literal("logged-out"), v.literal("off"));

async function linkRow(ctx: QueryCtx): Promise<Doc<"whatsappLink"> | null> {
  return await ctx.db.query("whatsappLink").first();
}
async function install(ctx: QueryCtx) {
  return await ctx.db.query("installation").first();
}

/** A JID without its device part, so the owner's phone and linked devices are one chat. */
export const bareJid = (jid: string) => jid.replace(/:\d+(?=@)/, "");

// --- Dashboard -------------------------------------------------------------

export type WhatsAppView = {
  mode?: "self" | "separate";
  wanted: boolean;
  status: Doc<"whatsappLink">["status"] | "never";
  qr?: string;
  code?: string;
  /** The linked number, as +digits. */
  number?: string;
  error?: string;
  /** The owner has claimed it (separate) or linked their own (self). */
  paired: boolean;
  /** For a separate number not yet claimed: the code to send it from the owner's phone. */
  pairingCode?: string;
  homeChannel: "telegram" | "whatsapp";
  telegramPaired: boolean;
};

const numberOf = (jid?: string) => jid ? `+${bareJid(jid).split("@")[0]}` : undefined;

export const status = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<WhatsAppView> => {
    assertDashboardKey(args.key);
    const link = await linkRow(ctx);
    const owner = await install(ctx);
    const telegramPaired = Boolean(owner?.claimedAt && owner.ownerChannel === "telegram");
    const paired = Boolean(owner?.whatsappOwner);
    const pairingLive = owner?.pairingCode && (owner.pairingExpiresAt ?? 0) > Date.now();
    return {
      mode: link?.mode,
      wanted: link?.wanted ?? false,
      status: link?.status ?? "never",
      qr: link?.qr,
      code: link?.code,
      number: numberOf(link?.me),
      error: link?.error,
      paired,
      pairingCode: link?.mode === "separate" && link.status === "connected" && !paired && pairingLive ? owner!.pairingCode : undefined,
      homeChannel: owner?.homeChannel ?? (telegramPaired || !paired ? "telegram" : "whatsapp"),
      telegramPaired,
    };
  },
});

/** Start linking: the server shows a QR (or, given the phone's number, a code to type on it). */
export const startLinking = mutation({
  args: { key: v.string(), mode: vMode, phone: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const phone = args.phone?.replace(/\D/g, "") || undefined;
    if (args.phone !== undefined && (!phone || phone.length < 8)) throw new Error("Enter the phone's number with its country code, like +91 98765 43210.");
    const link = await linkRow(ctx);
    const next = { mode: args.mode, wanted: true, phone, status: "starting" as const, qr: undefined, code: undefined, error: undefined, updatedAt: Date.now() };
    if (link) await ctx.db.patch(link._id, next);
    else await ctx.db.insert("whatsappLink", next);
    // A separate number is claimed with a code sent from the owner's phone, as on Telegram.
    if (args.mode === "separate") await ctx.runMutation(internal.installation.startPairing, {});
    return null;
  },
});

/** Unlink: the server logs the device out and forgets it; the owner stops being known on WhatsApp. */
export const unlink = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const link = await linkRow(ctx);
    if (link) await ctx.db.patch(link._id, { wanted: false, status: "off", qr: undefined, code: undefined, error: undefined, updatedAt: Date.now() });
    const owner = await install(ctx);
    if (owner) await ctx.db.patch(owner._id, { whatsappOwner: undefined, ...(owner.homeChannel === "whatsapp" ? { homeChannel: undefined } : {}) });
    return null;
  },
});

/** A fresh code for claiming a separate number, when the last one ran out. */
export const newPairingCode = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    await ctx.runMutation(internal.installation.startPairing, {});
    return null;
  },
});

/** Which app Perry's own messages (the heartbeat, alerts) go to when both are paired. */
export const setHomeChannel = mutation({
  args: { key: v.string(), channel: v.union(v.literal("telegram"), v.literal("whatsapp")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const owner = await install(ctx);
    if (owner) await ctx.db.patch(owner._id, { homeChannel: args.channel });
    return null;
  },
});

// --- The server's connection -----------------------------------------------

export const link = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"whatsappLink"> | null> => await linkRow(ctx),
});

/** What the connection is doing, from server/whatsapp.ts. Linking your own number is the proof it is you. */
export const report = internalMutation({
  args: { status: vStatus, qr: v.optional(v.string()), code: v.optional(v.string()), me: v.optional(v.string()), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await linkRow(ctx);
    if (!link) return null;
    await ctx.db.patch(link._id, {
      status: args.status,
      qr: args.status === "qr" ? args.qr : undefined,
      code: args.status === "code" ? args.code : undefined,
      error: args.error,
      ...(args.me ? { me: bareJid(args.me) } : {}),
      updatedAt: Date.now(),
    });
    if (args.status === "connected" && args.me && link.mode === "self") {
      const owner = await install(ctx);
      if (owner && owner.whatsappOwner !== bareJid(args.me)) {
        await ctx.db.patch(owner._id, { whatsappOwner: bareJid(args.me), claimedAt: owner.claimedAt ?? Date.now() });
      }
    }
    if (args.status === "logged-out") {
      // Unlinked from the phone: the owner links again from the dashboard.
      const owner = await install(ctx);
      if (owner?.whatsappOwner) await ctx.db.patch(owner._id, { whatsappOwner: undefined });
    }
    return null;
  },
});

/** Logged out from the phone: the link waits until the owner asks again, rather than showing new QRs to nobody. */
export const stop = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const link = await linkRow(ctx);
    if (link) await ctx.db.patch(link._id, { wanted: false, updatedAt: Date.now() });
    return null;
  },
});

// --- The outbox --------------------------------------------------------------

/**
 * Queue a message for the owner's WhatsApp chat: Markdown turned into
 * WhatsApp's formatting and split to its length. Only ever the owner.
 */
export async function queueText(ctx: MutationCtx, to: string, markdown: string): Promise<boolean> {
  const owner = await install(ctx);
  if (!owner?.whatsappOwner || bareJid(to) !== owner.whatsappOwner) return false;
  const now = Date.now();
  for (const [index, text] of chunkWhatsApp(toWhatsApp(markdown)).entries()) {
    await ctx.db.insert("whatsappOutbox", { to: owner.whatsappOwner, kind: "text", text, state: "pending", createdAt: now + index, attempts: 0 });
  }
  return true;
}

export const send = internalMutation({
  args: { to: v.string(), text: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => await queueText(ctx, args.to, args.text),
});

/** A file for the owner: a picture, video or voice note shows as one, anything else as a document. */
export const sendFile = internalMutation({
  args: { to: v.string(), storageId: v.optional(v.string()), localPath: v.optional(v.string()), fileName: v.string(), contentType: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const owner = await install(ctx);
    if (!owner?.whatsappOwner || bareJid(args.to) !== owner.whatsappOwner) return false;
    const { to: _to, ...file } = args;
    await ctx.db.insert("whatsappOutbox", { to: owner.whatsappOwner, kind: "file", file, state: "pending", createdAt: Date.now(), attempts: 0 });
    return true;
  },
});

/** "typing…" while a reply is being written. */
export const typing = internalMutation({
  args: { to: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await install(ctx);
    if (owner?.whatsappOwner && bareJid(args.to) === owner.whatsappOwner) {
      await ctx.db.insert("whatsappOutbox", { to: owner.whatsappOwner, kind: "typing", state: "pending", createdAt: Date.now(), attempts: 0 });
    }
    return null;
  },
});

export const pending = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"whatsappOutbox">[]> =>
    await ctx.db.query("whatsappOutbox").withIndex("by_state", (q) => q.eq("state", "pending")).take(20),
});

/** Sent, or failed for good after a few tries; either way it leaves the queue. */
export const sent = internalMutation({
  args: { id: v.id("whatsappOutbox"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    if (!args.error) await ctx.db.patch(row._id, { state: "sent", sentAt: Date.now() });
    else if (row.attempts + 1 >= 3) await ctx.db.patch(row._id, { state: "failed", attempts: row.attempts + 1, error: args.error.slice(0, 500) });
    else await ctx.db.patch(row._id, { attempts: row.attempts + 1, error: args.error.slice(0, 500) });
    // Sent messages are not kept: the chat's own history has them.
    const old = await ctx.db.query("whatsappOutbox").withIndex("by_state", (q) => q.eq("state", "sent").lt("createdAt", Date.now() - 86_400_000)).take(100);
    for (const stale of old) await ctx.db.delete(stale._id);
    return null;
  },
});

// --- Coming in -------------------------------------------------------------

const PAIRED = "Paired. I'm yours now, here on WhatsApp too.\n\nJust talk to me. /help lists the commands.";

/**
 * Who a message is from. The owner, known; a separate number being claimed
 * with the pairing code; or anyone else, who gets nothing back.
 */
export const authorize = internalMutation({
  args: { chatId: v.string(), text: v.string() },
  returns: v.union(v.literal("owner"), v.literal("claimed"), v.literal("ignore")),
  handler: async (ctx, args): Promise<"owner" | "claimed" | "ignore"> => {
    const owner = await install(ctx);
    const link = await linkRow(ctx);
    if (!owner || !link?.wanted) return "ignore";
    const chat = bareJid(args.chatId);
    if (owner.whatsappOwner === chat) return "owner";
    if (link.mode !== "separate" || owner.whatsappOwner) return "ignore";
    const supplied = args.text.match(/\b(\d{6})\b/)?.[1];
    if (!supplied || supplied !== owner.pairingCode || Date.now() > (owner.pairingExpiresAt ?? 0)) return "ignore";
    await ctx.db.patch(owner._id, { whatsappOwner: chat, claimedAt: owner.claimedAt ?? Date.now(), pairingCode: undefined, pairingExpiresAt: undefined });
    await queueText(ctx, chat, PAIRED);
    return "claimed";
  },
});

const vIncomingMedia = v.object({ base64: v.string(), fileName: v.string(), contentType: v.string() });

/**
 * A message from WhatsApp, as server/whatsapp.ts received it: the owner's, or
 * a claim; an answer to an approval waiting in this chat; or a turn.
 */
export const receive = internalAction({
  args: { chatId: v.string(), text: v.string(), name: v.optional(v.string()), media: v.optional(v.array(vIncomingMedia)) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const who: "owner" | "claimed" | "ignore" = await ctx.runMutation(internal.whatsapp.authorize, { chatId: args.chatId, text: args.text });
    if (who !== "owner") return null;
    const chatId = bareJid(args.chatId);
    // "1", "2" or "3" (or yes, no, always) answers an approval asked in this chat.
    if (!args.media?.length) {
      const note: string | null = await ctx.runMutation(internal.approvals.answerFromWhatsApp, { chatId, text: args.text });
      if (note) {
        await ctx.runMutation(internal.whatsapp.send, { to: chatId, text: note });
        return null;
      }
    }
    // Files come in the message, so they are stored now and attached to the turn.
    const stored: Array<{ storageId: Id<"_storage">; fileName: string; contentType: string; size: number }> = [];
    for (const item of args.media ?? []) {
      const bytes = Buffer.from(item.base64, "base64");
      const storageId = await ctx.storage.store(new Blob([bytes], { type: item.contentType }));
      stored.push({ storageId, fileName: item.fileName, contentType: item.contentType, size: bytes.byteLength });
    }
    await ctx.scheduler.runAfter(0, internal.brain.handleTurn, {
      channel: "whatsapp",
      externalId: chatId,
      text: args.text,
      title: args.name ? `WhatsApp · ${args.name}` : "WhatsApp",
      ...(stored.length ? { storedMedia: stored } : {}),
    });
    return null;
  },
});
