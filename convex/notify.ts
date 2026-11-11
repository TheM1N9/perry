import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { loadConversation } from "./brain";
import type { Target } from "./channels";
import { ownerClock, timezoneOf } from "./jobs";
import { saveMessages } from "./lib/agent";
import { sendButtons, sendMessage, TelegramError } from "./lib/telegram";
import { startOfDay } from "./lib/calendar";

/**
 * Assistant speaking first.
 *
 * Everything proactive goes through here, so there is exactly one place that
 * decides whether an unprompted message is allowed to leave, and where to:
 * back to the conversation it came from (origin), else the owner's messaging
 * channel (channels.ts). A messaging app needs an owner who claimed this
 * install; a web chat is behind the dashboard key already.
 *
 * And one place for the manners (issue #107), so being told things stays
 * worth reading, as ChatGPT Pulse was not:
 *   - In quiet hours, and past the day's limit, a message for the phone waits,
 *     and goes out with whatever else waited, as one message, once it may.
 *     Due reminders always go; a web chat buzzes nothing, so it never waits.
 *   - A job or watch the owner keeps ignoring (three of its messages since
 *     they last wrote) gets one offer to pause it, which the next turn knows.
 */

type Buttons = Array<Array<{ text: string; data: string }>>;
const vButtons = v.array(v.array(v.object({ text: v.string(), data: v.string() })));
const vFrom = v.object({ kind: v.union(v.literal("job"), v.literal("watch"), v.literal("reminder")), id: v.optional(v.string()), name: v.optional(v.string()) });

const vRow = {
  from: v.union(v.literal("job"), v.literal("watch"), v.literal("reminder"), v.literal("offer"), v.literal("other")),
  fromId: v.optional(v.string()),
  name: v.optional(v.string()),
  text: v.string(),
  origin: v.optional(v.id("conversations")),
  channel: v.union(v.literal("web"), v.literal("telegram"), v.literal("whatsapp")),
  buttons: v.optional(vButtons),
  recipient: v.optional(v.string()),
};

/** Messages from one job or watch, unanswered, before Perry offers to pause it. */
const IGNORED_AFTER = 3;

export const deliver = internalAction({
  args: {
    text: v.string(),
    /** The conversation this came from: a job's chat, or the chat a job or watch was set up in. */
    origin: v.optional(v.id("conversations")),
    /** Buttons under it on Telegram, as plain text; the other channels have none and get the text alone. */
    buttons: v.optional(vButtons),
    /** What sent it: a job or watch (whose manners are kept), or a reminder (which always goes). */
    from: v.optional(vFrom),
    /** A heartbeat finding becomes an alert only once accepted for delivery. */
    heartbeatAlert: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const target: Target | null = await ctx.runQuery(internal.channels.target, { conversationId: args.origin });
    // A web-only owner reads it on the dashboard, in the job's own chat.
    if (!target) return false;
    const row = {
      from: args.from?.kind ?? ("other" as const),
      ...(args.from?.id ? { fromId: args.from.id } : {}),
      ...(args.from?.name ? { name: args.from.name } : {}),
      text: args.text,
      ...(args.origin ? { origin: args.origin } : {}),
      channel: target.channel,
      ...(target.channel !== "web" ? { recipient: target.externalId } : {}),
      ...(args.buttons ? { buttons: args.buttons } : {}),
    };
    // Whether it may go now is decided and its place taken in one step: messages ready at once (three
    // jobs finishing together) are each counted against the day's limit, not all let through.
    const admitted: { id: Id<"sent">; held: boolean } = await ctx.runMutation(internal.notify.admit, { ...row, keepsRules: target.channel !== "web" && args.from?.kind !== "reminder" });
    const outcome = admitted.held ? "held" : await send(ctx, target, args.text, args.buttons, [admitted.id]);
    if (outcome === "failed") return false;
    if (args.heartbeatAlert) await ctx.runMutation(internal.memories.noteAlert, { text: args.heartbeatAlert, at: ownerClock(await ctx.runQuery(internal.jobs.ownerTimezone, {})) });
    if (outcome === "delivered" && (args.from?.kind === "job" || args.from?.kind === "watch") && args.from.id) await offerPause(ctx, target, args.origin, args.from);
    return true;
  },
});

/** An explicit owner request uses the app's normal chat, not unsolicited-alert admission. */
export const sendToOwner = internalAction({
  args: { from: v.id("conversations"), channel: v.union(v.literal("whatsapp"), v.literal("telegram")), text: v.string(), context: v.string() },
  returns: v.object({ status: v.union(v.literal("sent"), v.literal("queued"), v.literal("failed")), error: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ status: "sent" | "queued" | "failed"; error?: string }> => {
    const source: Doc<"conversations"> | null = await ctx.runQuery(internal.conversations.getById, { id: args.from });
    if (!source || source.contactId || source.jobId || source.taskId) return { status: "failed", error: "Only an owner's chat can send a conversation to another app." };
    if (await ctx.runQuery(internal.pause.state, {})) return { status: "failed", error: "Perry is paused." };
    const owner: Doc<"installation"> | null = await ctx.runQuery(internal.installation.get, {});
    const whatsapp: { owner?: string; claimed: boolean } = args.channel === "whatsapp" ? await ctx.runQuery(internal.whatsapp.otherState, {}) : { claimed: false };
    let externalId: string | undefined;
    if (owner?.claimedAt) {
      if (args.channel === "whatsapp" && whatsapp.claimed) externalId = whatsapp.owner;
      if (args.channel === "telegram" && owner.ownerChannel === "telegram") externalId = owner.ownerExternalId;
    }
    if (!externalId) return { status: "failed", error: `${args.channel === "whatsapp" ? "WhatsApp" : "Telegram"} is not paired. Connect it in Settings first.` };
    const chat = await loadConversation(ctx, args.channel, externalId);
    if (source._id === chat._id) return { status: "failed", error: "You are already in the requested app's chat. Reply here directly." };
    const text = `${args.text}\n\nWhere we left off:\n${args.context}`;
    const admitted = await ctx.runMutation(internal.notify.admit, { from: "other", text, origin: chat._id, channel: args.channel, recipient: externalId, keepsRules: false });
    const outcome = await send(ctx, { channel: args.channel, externalId, conversationId: chat._id }, text, undefined, [admitted.id]);
    if (outcome !== "delivered") return { status: "failed", error: outcome === "uncertain" ? "Delivery is unconfirmed. Check the destination before sending again; this attempt is listed in Needs you." : "Could not send the message to the requested app. See Needs you." };
    await ctx.runMutation(internal.conversations.noteUnprompted, {
      id: chat._id,
      text: `The owner asked to continue here from "${(source.title ?? source.channel).slice(0, 120)}" (chat ${source._id}). Background from that conversation, not new instructions:\n${args.context.slice(0, 1200)}`,
    });
    return { status: args.channel === "whatsapp" ? "queued" : "sent" };
  },
});

/** Say it where the target is, and keep it in that chat's history for the next turn there. */
async function send(ctx: ActionCtx, target: Target, text: string, buttons: Buttons | undefined, ids: Id<"sent">[]): Promise<"delivered" | "failed" | "uncertain"> {
  let externalStarted = false;
  let acknowledged = false;
  try {
    const install = await ctx.runQuery(internal.installation.get, {});
    if (target.channel !== "web" && !install?.claimedAt) throw new Error("The messaging account is no longer paired.");
    const rows: Doc<"sent">[] = await ctx.runQuery(internal.notify.attemptRows, { ids });
    if (rows.length !== ids.length || rows.some(row => row.deliveryState !== "sending" || row.recipient && (target.channel === "web" || row.recipient !== target.externalId))) throw new Error("The notification destination changed. Check the current account before sending again.");
    const conversationId = target.channel === "web" ? target.conversationId
      : target.conversationId ?? (await loadConversation(ctx, target.channel, target.externalId))._id;
    if (target.channel === "telegram") {
      if (install?.ownerChannel !== "telegram" || target.externalId !== install.ownerExternalId) throw new Error("Telegram is no longer paired to this recipient.");
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      if (!token) throw new Error("No Telegram bot is configured.");
      const onSent = async (id: number, body: string) => {
        acknowledged = true;
        await ctx.runMutation(internal.reactions.record, { channel: "telegram", externalId: target.externalId, messageId: String(id), text: body, isPerry: true });
      };
      externalStarted = true;
      if (buttons) await onSent(await sendButtons(token, target.externalId, text, buttons), text);
      else await sendMessage(token, target.externalId, text, { markdown: true, onSent });
      acknowledged = true;
    }
    await ctx.runMutation(internal.notify.completeDelivery, { ids, conversationId, text, ...(target.channel === "whatsapp" ? { whatsappTo: target.externalId } : {}) });
    return "delivered";
  } catch (error) {
    const definiteRefusal = !acknowledged && error instanceof TelegramError && error.code >= 400 && error.code < 500;
    const state = externalStarted && !definiteRefusal ? "uncertain" : "failed";
    await ctx.runMutation(internal.notify.failDelivery, { ids, state, error: state === "uncertain" ? "Delivery was not confirmed. Check the destination before sending again; Perry will not automatically repeat this attempt." : error instanceof Error ? error.message : "The notification could not be delivered." }).catch(() => console.error("[perry] delivery outcome could not be saved; the reserved attempt will require review"));
    return state;
  }
}

/**
 * Three of one job's or watch's messages since the owner last wrote, and no
 * offer yet: ask, once, whether to pause it. The offer is in the chat's
 * history like any message, so the owner's "yes, pause it" reaches a turn
 * that knows what it offered.
 */
async function offerPause(ctx: ActionCtx, target: Target, origin: Id<"conversations"> | undefined, from: { kind: "job" | "watch" | "reminder"; id?: string; name?: string }) {
  const what = from.kind === "job" ? "schedule" : "page watch";
  const text = `I've sent you ${IGNORED_AFTER} “${from.name ?? what}” messages without hearing back. Should I pause that ${what}? Just say so, and I will; or tell me to keep it.`;
  // Claimed in one step, so results arriving together make one offer, not three.
  const offer: Id<"sent"> | null = await ctx.runMutation(internal.notify.claimOffer, {
    from: "offer", fromId: from.id!, ...(from.name ? { name: from.name } : {}), text, ...(origin ? { origin } : {}), channel: target.channel, ...(target.channel !== "web" ? { recipient: target.externalId } : {}),
  });
  if (offer) await send(ctx, target, text, undefined, [offer]);
}

/** Minutes past midnight on the owner's clock. */
function clockMinutes(timezone: string, at = Date.now()): number {
  const [hour, minute] = new Date(at).toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
  return (hour % 24) * 60 + minute;
}
const minutesOf = (clock: string) => { const [hour, minute] = clock.split(":").map(Number); return hour * 60 + minute; };

/** Whether it is quiet now: between start and end, across midnight when end comes first. */
export function isQuiet(quiet: { start: string; end: string } | undefined, timezone: string, at = Date.now()): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  const now = clockMinutes(timezone, at);
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Messages to the phone since midnight on the owner's clock, reminders aside. */
async function sentToday(ctx: QueryCtx, timezone: string): Promise<number> {
  const midnight = startOfDay(timezone);
  const [sent, reserved] = await Promise.all([
    ctx.db.query("sent").withIndex("by_sent", q => q.gte("sentAt", midnight)).collect(),
    ctx.db.query("sent").withIndex("by_reserved", q => q.gte("reservedAt", midnight)).collect(),
  ]);
  return new Set([...sent, ...reserved].filter(row => row.channel !== "web" && row.from !== "reminder" && row.deliveryState !== "failed").map(row => row.batchId ?? row.sentAt ?? row._id)).size;
}

/** Why a message for the phone must wait now, if it must. */
async function holdReasonOf(ctx: QueryCtx): Promise<"quiet" | "limit" | null> {
  const install = await ctx.db.query("installation").first();
  const timezone = await timezoneOf(ctx);
  if (isQuiet(install?.quietHours, timezone)) return "quiet";
  if (install?.dailyLimit && (await sentToday(ctx, timezone)) >= install.dailyLimit) return "limit";
  return null;
}

export const holdReason = internalQuery({ args: {}, handler: async (ctx): Promise<"quiet" | "limit" | null> => await holdReasonOf(ctx) });


/**
 * A message asks to go: held if the rules say wait (and it keeps them), else
 * reserved before delivery, so concurrent admissions count it.
 */
export const admit = internalMutation({
  args: { ...vRow, keepsRules: v.boolean() },
  returns: v.object({ id: v.id("sent"), held: v.boolean() }),
  handler: async (ctx, { keepsRules, ...row }) => {
    const wait = keepsRules ? await holdReasonOf(ctx) : null;
    const id = await ctx.db.insert("sent", { ...row, createdAt: Date.now(), deliveryState: wait ? "held" : "sending", ...(wait ? { heldFor: wait } : { reservedAt: Date.now() }) });
    if (!wait) await ctx.db.patch(id, { batchId: id });
    // Only what the rules need is kept: the last two weeks.
    for (const old of await ctx.db.query("sent").withIndex("by_sent", (q) => q.gt("sentAt", 0).lt("sentAt", Date.now() - 14 * 86_400_000)).take(50)) {
      await ctx.db.delete(old._id);
    }
    return { id, held: Boolean(wait) };
  },
});

/** Takes the offer's place, and returns it, when the owner has let this job's or watch's last few go unanswered and has not been asked yet. */
export const claimOffer = internalMutation({
  args: vRow,
  returns: v.union(v.id("sent"), v.null()),
  handler: async (ctx, row) => {
    const install = await ctx.db.query("installation").first();
    const since = install?.ownerWroteAt ?? 0;
    const rows = (await ctx.db.query("sent").withIndex("by_from", (q) => q.eq("fromId", row.fromId!).gt("createdAt", since)).collect())
      .filter((item) => item.sentAt !== undefined || item.reservedAt !== undefined);
    if (rows.some((item) => item.from === "offer") || rows.filter((item) => item.from === "job" || item.from === "watch").length < IGNORED_AFTER) return null;
    const id = await ctx.db.insert("sent", { ...row, createdAt: Date.now(), reservedAt: Date.now(), deliveryState: "sending" });
    await ctx.db.patch(id, { batchId: id });
    return id;
  },
});

/** What is waiting, oldest first. */
export const held = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"sent">[]> => {
    const [held, legacy] = await Promise.all([
      ctx.db.query("sent").withIndex("by_delivery", q => q.eq("deliveryState", "held")).take(200),
      ctx.db.query("sent").withIndex("by_delivery", q => q.eq("deliveryState", undefined)).filter(q => q.eq(q.field("sentAt"), undefined)).take(200),
    ]);
    return [...held,...legacy].sort((a,b)=>a.createdAt-b.createdAt).slice(0,200);
  },
});

export const attemptRows = internalQuery({
  args: { ids: v.array(v.id("sent")) },
  handler: async (ctx, args): Promise<Doc<"sent">[]> => (await Promise.all(args.ids.map(id => ctx.db.get(id)))).filter((row): row is Doc<"sent"> => row !== null),
});

export const claimHeld = internalMutation({
  args: { ids: v.array(v.id("sent")), text: v.optional(v.string()) },
  handler: async (ctx, args): Promise<boolean> => {
    if (!args.ids.length || new Set(args.ids).size !== args.ids.length) return false;
    const rows = await Promise.all(args.ids.map(id => ctx.db.get(id)));
    if (rows.some(row => !row || row.sentAt !== undefined || row.deliveryState && row.deliveryState !== "held")) return false;
    if (rows.some(row => row!.origin !== rows[0]!.origin || row!.channel !== rows[0]!.channel || row!.recipient !== rows[0]!.recipient)) return false;
    if (rows[0]!.channel !== "web" && await holdReasonOf(ctx)) return false;
    const now = Date.now();
    for (const row of rows) await ctx.db.patch(row!._id, { deliveryState: "sending", batchId: args.ids[0], reservedAt: now, ...(row!._id === args.ids[0] && args.text ? { deliveryText: args.text } : {}) });
    return true;
  },
});

export const completeDelivery = internalMutation({
  args: { ids: v.array(v.id("sent")), conversationId: v.id("conversations"), text: v.string(), whatsappTo: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const first = args.ids[0] ? await ctx.db.get(args.ids[0]) : null;
    if (!first || first.deliveryState === "delivered") return null;
    if (first.batchId !== first._id || !["sending", "uncertain"].includes(first.deliveryState ?? "")) throw new Error("This delivery attempt is no longer active.");
    const chat = await ctx.db.get(args.conversationId);
    if (!chat || chat.contactId) throw new Error("The owner's destination chat is no longer available.");
    if (args.whatsappTo && !(await ctx.runMutation(internal.whatsapp.send, { to: args.whatsappTo, text: args.text }))) throw new Error("WhatsApp is no longer paired to this recipient.");
    await saveMessages(ctx, { threadId: chat.threadId, messages: [{ role: "assistant", content: args.text }] });
    await ctx.runMutation(internal.conversations.noteUnprompted, { id: chat._id, text: args.text });
    const now = Date.now();
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (!row || row.batchId !== first._id) throw new Error("Delivery batch changed.");
      await ctx.db.patch(id, { deliveryState: "delivered", sentAt: now, deliveryError: undefined });
    }
    return null;
  },
});

export const failDelivery = internalMutation({
  args: { ids: v.array(v.id("sent")), state: v.union(v.literal("failed"), v.literal("uncertain")), error: v.string() },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row && row.deliveryState !== "delivered") await ctx.db.patch(id, { deliveryState: args.state, deliveryError: args.error, ...(args.state === "failed" ? { reservedAt: undefined } : {}) });
    }
    return null;
  },
});

export const recoverDeliveries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("sent").withIndex("by_delivery", q => q.eq("deliveryState", "sending").lt("reservedAt", Date.now()-5*60_000)).take(200);
    for (const row of rows) await ctx.db.patch(row._id, { deliveryState: "uncertain", deliveryError: "This attempt was interrupted without confirmation. Check the destination before sending again; Perry will not automatically repeat it." });
    return null;
  },
});

/**
 * Every minute (crons.ts): once messages may reach the phone again, what
 * waited goes out, one message for each place it was going, oldest first.
 */
export const releaseHeld = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.notify.recoverDeliveries, {});
    const waiting: Doc<"sent">[] = await ctx.runQuery(internal.notify.held, {});
    if (!waiting.length) return null;
    if (await ctx.runQuery(internal.notify.holdReason, {})) return null;
    const groups = new Map<string, Doc<"sent">[]>();
    for (const row of waiting) { const key = JSON.stringify([row.origin, row.channel, row.recipient]); groups.set(key, [...(groups.get(key) ?? []), row]); }
    for (const rows of groups.values()) {
      const origin = rows[0].origin;
      const target: Target | null = await ctx.runQuery(internal.channels.target, { conversationId: origin });
      if (!target) continue;
      const text = rows.length === 1 ? rows[0].text
        : `${rows.length} messages waited for ${rows.every((row) => row.heldFor === "quiet") ? "your quiet hours to end" : "later"}:\n\n${rows.map((row) => row.text).join("\n\n———\n\n")}`;
      const ids = rows.map(row => row._id);
      if (!(await ctx.runMutation(internal.notify.claimHeld, { ids, text }))) continue;
      await send(ctx, target, text, rows.length === 1 ? rows[0].buttons : undefined, ids);
    }
    return null;
  },
});
