import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { loadConversation } from "./brain";
import type { Target } from "./channels";
import { nextRun, timezoneOf } from "./jobs";
import { saveMessages } from "./lib/agent";
import { sendButtons, sendMessage } from "./lib/telegram";

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
      ...(args.buttons ? { buttons: args.buttons } : {}),
    };
    // Whether it may go now is decided and its place taken in one step: messages ready at once (three
    // jobs finishing together) are each counted against the day's limit, not all let through.
    const admitted: { id: Id<"sent">; held: boolean } = await ctx.runMutation(internal.notify.admit, { ...row, keepsRules: target.channel !== "web" && args.from?.kind !== "reminder" });
    if (admitted.held) return true;
    if (!(await send(ctx, target, args.text, args.buttons))) {
      await ctx.runMutation(internal.notify.forget, { id: admitted.id });
      return false;
    }
    if ((args.from?.kind === "job" || args.from?.kind === "watch") && args.from.id) await offerPause(ctx, target, args.origin, args.from);
    return true;
  },
});

/** Say it where the target is, and keep it in that chat's history for the next turn there. */
async function send(ctx: ActionCtx, target: Target, text: string, buttons?: Buttons): Promise<boolean> {
  const install = await ctx.runQuery(internal.installation.get, {});
  // A web chat is behind the dashboard key already; only a messaging app needs an owner who claimed this
  // install. (A web-only owner never claims it, and their reports into a web chat were being dropped.)
  if (target.channel !== "web" && !install?.claimedAt) {
    console.warn("nothing to deliver: install is unclaimed");
    return false;
  }
  try {
    let conversationId: Id<"conversations">;
    if (target.channel === "web") {
      conversationId = target.conversationId;
    } else if (target.channel === "telegram") {
      // Only ever the owner's own chat.
      if (install?.ownerChannel !== "telegram" || target.externalId !== install.ownerExternalId) return false;
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      // Job results are the agent's Markdown; plain alerts read the same either way.
      if (buttons) await sendButtons(token, target.externalId, text, buttons);
      else await sendMessage(token, target.externalId, text, { markdown: true });
      // Made here if the owner has not written since pairing.
      conversationId = target.conversationId ?? (await loadConversation(ctx, "telegram", target.externalId))._id;
    } else {
      // Queued for the connection (server/whatsapp.ts); it goes when WhatsApp is connected. Only ever the owner.
      if (!(await ctx.runMutation(internal.whatsapp.send, { to: target.externalId, text }))) return false;
      conversationId = target.conversationId ?? (await loadConversation(ctx, "whatsapp", target.externalId))._id;
    }
    // It belongs to that chat: shown in its history, and told to the next turn there.
    const chat = await ctx.runQuery(internal.conversations.getById, { id: conversationId });
    if (!chat) return false;
    await saveMessages(ctx, { threadId: chat.threadId, messages: [{ role: "assistant", content: text }] });
    await ctx.runMutation(internal.conversations.noteUnprompted, { id: conversationId, text });
    return true;
  } catch (error) {
    console.error(`could not deliver to the owner: ${String(error)}`);
    return false;
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
    from: "offer", fromId: from.id!, ...(from.name ? { name: from.name } : {}), text, ...(origin ? { origin } : {}), channel: target.channel,
  });
  if (offer && !(await send(ctx, target, text))) await ctx.runMutation(internal.notify.forget, { id: offer });
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
  const midnight = nextRun("0 0 * * *", timezone) - 86_400_000;
  const rows = await ctx.db.query("sent").withIndex("by_sent", (q) => q.gte("sentAt", midnight)).collect();
  // Messages that waited and went out together were one message, and share their sentAt.
  return new Set(rows.filter((row) => row.channel !== "web" && row.from !== "reminder").map((row) => row.sentAt)).size;
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
 * recorded as sent now, before it is sent, so the next one counts it.
 */
export const admit = internalMutation({
  args: { ...vRow, keepsRules: v.boolean() },
  returns: v.object({ id: v.id("sent"), held: v.boolean() }),
  handler: async (ctx, { keepsRules, ...row }) => {
    const wait = keepsRules ? await holdReasonOf(ctx) : null;
    const id = await ctx.db.insert("sent", { ...row, createdAt: Date.now(), ...(wait ? { heldFor: wait } : { sentAt: Date.now() }) });
    // Only what the rules need is kept: the last two weeks.
    for (const old of await ctx.db.query("sent").withIndex("by_sent", (q) => q.gt("sentAt", 0).lt("sentAt", Date.now() - 14 * 86_400_000)).take(50)) {
      await ctx.db.delete(old._id);
    }
    return { id, held: Boolean(wait) };
  },
});

/** It could not be sent after all; it does not count. */
export const forget = internalMutation({
  args: { id: v.id("sent") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.delete(args.id);
    return null;
  },
});

/** Whether the owner has let this job's or watch's last few messages go unanswered, with no offer made yet. */
/** Takes the offer's place, and returns it, when the owner has let this job's or watch's last few go unanswered and has not been asked yet. */
export const claimOffer = internalMutation({
  args: vRow,
  returns: v.union(v.id("sent"), v.null()),
  handler: async (ctx, row) => {
    const install = await ctx.db.query("installation").first();
    const since = install?.ownerWroteAt ?? 0;
    const rows = (await ctx.db.query("sent").withIndex("by_from", (q) => q.eq("fromId", row.fromId!).gt("createdAt", since)).collect())
      .filter((item) => item.sentAt !== undefined);
    if (rows.some((item) => item.from === "offer") || rows.filter((item) => item.from === "job" || item.from === "watch").length < IGNORED_AFTER) return null;
    return await ctx.db.insert("sent", { ...row, createdAt: Date.now(), sentAt: Date.now() });
  },
});

/** What is waiting, oldest first. */
export const held = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"sent">[]> => await ctx.db.query("sent").withIndex("by_sent", (q) => q.eq("sentAt", undefined)).collect(),
});

export const markSent = internalMutation({
  args: { ids: v.array(v.id("sent")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    // One time for all: they went as one message, and count as one (sentToday).
    const now = Date.now();
    for (const id of args.ids) await ctx.db.patch(id, { sentAt: now });
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
    const waiting: Doc<"sent">[] = await ctx.runQuery(internal.notify.held, {});
    if (!waiting.length) return null;
    if (await ctx.runQuery(internal.notify.holdReason, {})) return null;
    const groups = new Map<string, Doc<"sent">[]>();
    for (const row of waiting) groups.set(row.origin ?? "", [...(groups.get(row.origin ?? "") ?? []), row]);
    for (const rows of groups.values()) {
      const origin = rows[0].origin;
      const target: Target | null = await ctx.runQuery(internal.channels.target, { conversationId: origin });
      if (!target) continue;
      const text = rows.length === 1 ? rows[0].text
        : `${rows.length} messages waited for ${rows.every((row) => row.heldFor === "quiet") ? "your quiet hours to end" : "later"}:\n\n${rows.map((row) => row.text).join("\n\n———\n\n")}`;
      if (await send(ctx, target, text, rows.length === 1 ? rows[0].buttons : undefined)) {
        await ctx.runMutation(internal.notify.markSent, { ids: rows.map((row) => row._id) });
      }
    }
    return null;
  },
});
