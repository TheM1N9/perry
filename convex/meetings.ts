import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { calendarItems, calendarPage, joinable, meetingsIn, templateOf, transcriptText, writtenUp, TYPED_HEADING, type MeetingTemplate, type Upcoming } from "./lib/meetings";
import { noteHref } from "./lib/notes";
import { timezoneOf } from "./jobs";
import { insertPage, removePage, scrubbed, writePage } from "./pages";
import { pausedAt } from "./pause";
import { authenticate } from "./runner";
import { insert as insertTodo, runningPets } from "./todos";

/**
 * Meetings: calls the desktop pet listened to, Granola's way. Nothing joins the
 * call; the pet hears the computer's sound and the microphone (pet/listen.js),
 * Whisper writes it down there, and the words come here as they are made. When
 * the owner stops, a runner writes up the page from the transcript and what they
 * typed, using the same answer-only turn that names chats (runner/title.ts).
 *
 * What is said on a call is someone else's words, so:
 * - the write-up's turn has no tools at all, so nothing said can make it do anything;
 * - its lines are saved as from outside (pages.ts, origin "tool"), and never read
 *   as what the owner told Perry; secrets are left out of it (pages.scrubbed);
 * - reading a transcript from a chat counts as reading from outside (mcp.ts);
 * - only the owner starts listening. No tool of Perry's can.
 *
 * The transcript is kept until the meeting is deleted. Sound is never sent here.
 */

/** A pet this quiet was cut off: what it sent is written up. */
const CUT_OFF_MS = 5 * 60_000;
/** The dashboard's "Listen" waits this long for a pet to take it. */
const ASK_WAIT_MS = 45_000;
/** A runner this long writing one up went away. */
const CLAIM_MS = 15 * 60_000;
const MOST_ATTEMPTS = 3;
/** A meeting no runner could write up by then says so, rather than saying "writing" for ever. */
const WRITING_TTL_MS = 24 * 60 * 60_000;
/** The calendar is read this far ahead. */
const LOOK_AHEAD_MS = 24 * 60 * 60_000;

const vKey = v.string();
const vDevice = v.optional(v.id("petDevices"));

export type MeetingSummary = {
  id: Id<"meetings">; title: string; status: Doc<"meetings">["status"]; startedAt: number; endedAt?: number; segments: number; error?: string; noteId?: Id<"notes">; preview?: string;
};
export type MeetingView = MeetingSummary & {
  summary: string; thoughts: string;
  joinUrl?: string; attendees?: string[]; template: MeetingTemplate; heard?: { mic: boolean; system: boolean }; droppedMs?: number; stopAsked: boolean;
  actions: Array<{ text: string; owner?: string; added: boolean }>;
  /** The owner changed the page since the last write-up, so writing it again would replace that. */
  editedSince: boolean;
  /** Time left on someone's write-up, for "waiting for an engine". */
  writingSince?: number;
};
export type MeetingSegment = { seq: number; source: "you" | "them"; startMs: number; endMs: number; text: string };
export type PetMeetings = {
  /** The dashboard's "Listen", waiting for this pet. */
  asked?: { id: Id<"meetings">; title: string };
  /** This pet's meeting, and whether Stop was pressed in the dashboard. */
  listening?: { id: Id<"meetings">; title: string; stopAsked: boolean };
  /** Calendar meetings still to come or just started, soonest first. */
  upcoming: Array<{ eventId: string; title: string; startsAt: number; endsAt: number; joinUrl?: string; attendees?: string[] }>;
  headsUp: boolean;
  notice: boolean;
};

const summaryOf = (meeting: Doc<"meetings">): MeetingSummary => ({
  id: meeting._id, title: meeting.title, status: meeting.status, startedAt: meeting.startedAt, segments: meeting.segments,
  ...(meeting.endedAt ? { endedAt: meeting.endedAt } : {}), ...(meeting.error ? { error: meeting.error } : {}), ...(meeting.noteId ? { noteId: meeting.noteId } : {}),
});

const segmentsOf = (ctx: { db: QueryCtx["db"] }, meetingId: Id<"meetings">) => ctx.db.query("meetingSegments").withIndex("by_meeting", (q) => q.eq("meetingId", meetingId)).collect();

/** "Call, Nov 4, 3:15 PM", on the owner's clock. */
async function defaultTitle(ctx: { db: QueryCtx["db"] }, at: number): Promise<string> {
  const timeZone = await timezoneOf(ctx);
  return `Call, ${new Date(at).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/** Listening is over: written up if there is anything to write up from. */
async function closeOut(ctx: MutationCtx, meeting: Doc<"meetings">, error?: string) {
  const now = Date.now();
  const note = meeting.noteId ? await ctx.db.get(meeting.noteId) : null;
  const anything = meeting.segments > 0 || Boolean(note?.content.trim());
  await ctx.db.patch(meeting._id, {
    status: anything ? "writing" : "failed",
    endedAt: now, aliveAt: now, stopAsked: undefined, attempts: 0, claimedAt: undefined,
    error: error ?? (anything ? undefined : "Perry didn't hear anything on this call. Check that sound was playing and the microphone was on."),
  });
}

async function mine(ctx: { db: QueryCtx["db"] }, id: Id<"meetings">): Promise<Doc<"meetings">> {
  const meeting = await ctx.db.get(id);
  if (!meeting) throw new Error("This meeting was deleted.");
  return meeting;
}

// --- The pet ---------------------------------------------------------------------------------------

/**
 * This pet starts listening: a new meeting and its page, or the one the
 * dashboard asked for. One left open by a pet that was cut off is closed first.
 */
export const start = mutation({
  args: {
    key: vKey, device: vDevice, title: v.optional(v.string()), eventId: v.optional(v.string()), joinUrl: v.optional(v.string()), askedId: v.optional(v.id("meetings")),
  },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const speech = (await ctx.db.query("installation").first())?.meetingSpeech ?? { provider: "local" as const, model: "small" as const, language: "en", vocabulary: "" };
    for (const open of await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "listening")).collect()) {
      if (open.device === args.device) await closeOut(ctx, open, "Perry was cut off before this call ended, so this is what he heard until then.");
    }
    const asked = args.askedId ? await ctx.db.get(args.askedId) : null;
    if (args.askedId && (asked?.status !== "asked" || asked.device !== args.device)) throw new Error("This listening request has expired.");
    const eventId = args.eventId ?? asked?.eventId;
    const event = eventId ? await ctx.db.query("upcomingMeetings").withIndex("by_event", (q) => q.eq("eventId", eventId)).first() : null;
    if (event) await ctx.db.patch(event._id, { dismissedAt: now });
    const given = (args.title ?? event?.title)?.trim().slice(0, 160);
    const title = given || asked?.title || await defaultTitle(ctx, now);
    const fields = {
      speech,
      status: "listening" as const, device: args.device, startedAt: now, aliveAt: now, segments: 0,
      noteId: asked?.noteId ?? await insertPage(ctx, { title, content: "", author: { by: "owner" } }),
      ...(given || asked?.named ? { named: true } : {}),
      ...(event ? { eventId: event.eventId } : {}),
      ...(event?.attendees ? { attendees: event.attendees } : {}),
    };
    const joinUrl = joinable(args.joinUrl ?? event?.joinUrl);
    if (asked?.status === "asked") {
      await ctx.db.patch(asked._id, { ...fields, ...(joinUrl ? { joinUrl } : {}) });
      return { id: asked._id, title, startedAt: now, speech };
    }
    const id = await ctx.db.insert("meetings", { title, ...fields, ...(joinUrl ? { joinUrl } : {}) });
    return { id, title, startedAt: now, speech };
  },
});

/** Which sides it could hear, once it knows. */
export const heard = mutation({
  args: { key: vKey, device: vDevice, id: v.id("meetings"), mic: v.boolean(), system: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const meeting = await ctx.db.get(args.id);
    if (meeting && meeting.device === args.device && meeting.status === "listening") await ctx.db.patch(args.id, { heard: { mic: args.mic, system: args.system } });
    return null;
  },
});

/** Still listening; `gone` when the owner deleted it meanwhile, which stops the pet. */
export const alive = mutation({
  args: { key: vKey, device: vDevice, id: v.id("meetings") },
  handler: async (ctx, args): Promise<{ gone: boolean }> => {
    assertDashboardKey(args.key);
    const meeting = await ctx.db.get(args.id);
    if (!meeting || meeting.device !== args.device || meeting.status !== "listening") return { gone: true };
    if (meeting.status === "listening") await ctx.db.patch(args.id, { aliveAt: Date.now() });
    return { gone: false };
  },
});

/** What was just said. Sent again after a failure, the same words are only saved once. */
export const appendSegments = mutation({
  args: {
    key: vKey, device: vDevice, id: v.id("meetings"), droppedMs: v.optional(v.number()),
    segments: v.array(v.object({ seq: v.number(), source: v.union(v.literal("you"), v.literal("them")), startMs: v.number(), endMs: v.number(), text: v.string() })),
  },
  handler: async (ctx, args): Promise<{ gone: boolean }> => {
    assertDashboardKey(args.key);
    const meeting = await ctx.db.get(args.id);
    if (!meeting || meeting.device !== args.device || meeting.status !== "listening") return { gone: true };
    let added = 0;
    for (const segment of args.segments) {
      const text = segment.text.trim().slice(0, 4000);
      if (!text) continue;
      const existing = await ctx.db.query("meetingSegments").withIndex("by_meeting", (q) => q.eq("meetingId", args.id).eq("seq", segment.seq)).first();
      if (existing) continue;
      await ctx.db.insert("meetingSegments", { ...segment, text, meetingId: args.id });
      added += 1;
    }
    await ctx.db.patch(args.id, { segments: meeting.segments + added, aliveAt: Date.now(), ...(args.droppedMs ? { droppedMs: args.droppedMs } : {}) });
    return { gone: false };
  },
});

/** Everything heard is written down: over to a runner for the write-up. */
export const finish = mutation({
  args: { key: vKey, device: vDevice, id: v.id("meetings"), droppedMs: v.optional(v.number()), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const meeting = await ctx.db.get(args.id);
    if (!meeting || meeting.device !== args.device || meeting.status !== "listening") return null;
    if (args.droppedMs) await ctx.db.patch(args.id, { droppedMs: args.droppedMs });
    await closeOut(ctx, meeting, args.error?.slice(0, 500));
    return null;
  },
});

/** It could not hear anything after all: nothing happened, so nothing is left behind. */
export const abandon = mutation({
  args: { key: vKey, device: vDevice, id: v.id("meetings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const meeting = await ctx.db.get(args.id);
    if (meeting && meeting.device === args.device && meeting.status === "listening") await removeMeeting(ctx, args.id);
    return null;
  },
});

/** What the pet's page watches: small, because he stays mounted for days. No transcripts. */
export const pet = query({
  args: { key: vKey, device: vDevice },
  handler: async (ctx, args): Promise<PetMeetings> => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const install = await ctx.db.query("installation").first();
    const [nearest] = await runningPets(ctx, now);
    const askedRows = nearest?.device === args.device ? await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "asked").gt("startedAt", now - ASK_WAIT_MS)).collect() : [];
    const asked = askedRows.find((row) => row.device === args.device);
    const listening = (await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "listening")).collect()).find((row) => row.device === args.device);
    const rows = await ctx.db.query("upcomingMeetings").collect();
    return {
      ...(asked ? { asked: { id: asked._id, title: asked.title } } : {}),
      ...(listening ? { listening: { id: listening._id, title: listening.title, stopAsked: listening.stopAsked === true } } : {}),
      upcoming: rows.filter((row) => !row.dismissedAt && row.endsAt > now).sort((a, b) => a.startsAt - b.startsAt).slice(0, 5)
        .map((row) => ({ eventId: row.eventId, title: row.title, startsAt: row.startsAt, endsAt: row.endsAt, ...(row.joinUrl ? { joinUrl: row.joinUrl } : {}), ...(row.attendees ? { attendees: row.attendees.slice(0, 5) } : {}) })),
      headsUp: install?.meetingHeadsUp !== false,
      notice: install?.meetingNotice !== false,
    };
  },
});

/** "Not now" on the heads-up. */
export const dismissUpcoming = mutation({
  args: { key: vKey, eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await ctx.db.query("upcomingMeetings").withIndex("by_event", (q) => q.eq("eventId", args.eventId)).first();
    if (row) await ctx.db.patch(row._id, { dismissedAt: Date.now() });
    return null;
  },
});

// --- The dashboard ---------------------------------------------------------------------------------

export const list = query({
  args: { key: vKey },
  handler: async (ctx, args): Promise<MeetingSummary[]> => {
    assertDashboardKey(args.key);
    const rows = await ctx.db.query("meetings").withIndex("by_started").order("desc").take(200);
    return await Promise.all(rows.filter((row) => row.status !== "asked" || row.startedAt > Date.now() - ASK_WAIT_MS).map(async (row) => {
      const note = row.noteId ? await ctx.db.get(row.noteId) : null;
      const preview = note?.content.replace(/[#*_`>-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
      return { ...summaryOf(row), ...(preview ? { preview } : {}) };
    }));
  },
});

export const get = query({
  args: { key: vKey, id: v.string() },
  handler: async (ctx, args): Promise<MeetingView | null> => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("meetings", args.id);
    const meeting = id ? await ctx.db.get(id) : null;
    if (!meeting) return null;
    const note = meeting.noteId ? await ctx.db.get(meeting.noteId) : null;
    const content = note?.content ?? "";
    const written = meeting.writtenRevision !== undefined;
    const divider = `\n\n## ${TYPED_HEADING}\n\n`;
    const exact = meeting.typed?.trim() ? content.indexOf(`${divider}${meeting.typed.trim()}`) : -1;
    const boundary = exact >= 0 ? exact : meeting.typed?.trim() ? content.indexOf(divider) : -1;
    return {
      ...summaryOf(meeting),
      summary: written ? (boundary >= 0 ? content.slice(0, boundary) : content) : "",
      thoughts: written ? (boundary >= 0 ? content.slice(boundary + divider.length).trim() : meeting.typed ?? "") : content,
      ...(!note ? { noteId: undefined } : {}),
      ...(meeting.joinUrl ? { joinUrl: meeting.joinUrl } : {}),
      ...(meeting.attendees ? { attendees: meeting.attendees } : {}),
      ...(meeting.heard ? { heard: meeting.heard } : {}),
      ...(meeting.droppedMs ? { droppedMs: meeting.droppedMs } : {}),
      template: templateOf(meeting.template),
      stopAsked: meeting.stopAsked === true,
      actions: (meeting.actions ?? []).map((action) => ({ text: action.text, ...(action.owner ? { owner: action.owner } : {}), added: Boolean(action.todoId) })),
      editedSince: Boolean(note && meeting.writtenRevision !== undefined && note.revision !== meeting.writtenRevision),
      ...(meeting.status === "writing" && meeting.endedAt ? { writingSince: meeting.endedAt } : {}),
    };
  },
});

/** What was said, in order. */
export const transcript = query({
  args: { key: vKey, id: v.string() },
  handler: async (ctx, args): Promise<MeetingSegment[]> => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("meetings", args.id);
    if (!id) return [];
    return (await segmentsOf(ctx, id)).sort((a, b) => a.startMs - b.startMs || a.seq - b.seq).map(({ seq, source, startMs, endMs, text }) => ({ seq, source, startMs, endMs, text }));
  },
});

/** The dashboard's Listen: the pet the owner touched last takes it, as with a look at the screen (screen.ts). */
export const ask = mutation({
  args: { key: vKey, title: v.optional(v.string()), eventId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ id: Id<"meetings"> } | { error: string }> => {
    assertDashboardKey(args.key);
    const active = await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "listening")).first();
    if (active) return { id: active._id };
    const waiting = await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "asked").gt("startedAt", Date.now() - ASK_WAIT_MS)).first();
    if (waiting) return { id: waiting._id };
    const [pet] = await runningPets(ctx);
    if (!pet) return { error: "The desktop pet does the listening, and it isn't running. Turn it on in Settings → Desktop pet." };
    const now = Date.now();
    const event = args.eventId ? await ctx.db.query("upcomingMeetings").withIndex("by_event", (q) => q.eq("eventId", args.eventId!)).first() : null;
    if (args.eventId && (!event || event.endsAt <= now)) return { error: "This calendar meeting has ended or is no longer available. Refresh your calendar." };
    const title = (args.title ?? event?.title)?.trim().slice(0, 160) || await defaultTitle(ctx, now);
    const id = await ctx.db.insert("meetings", { title, status: "asked", device: pet.device, startedAt: now, aliveAt: now, segments: 0, ...(args.title?.trim() || event ? { named: true } : {}), ...(event ? { eventId: event.eventId, attendees: event.attendees, joinUrl: event.joinUrl } : {}) });
    return { id };
  },
});

export const stop = mutation({
  args: { key: vKey, id: v.id("meetings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const meeting = await mine(ctx, args.id);
    if (meeting.status === "listening") await ctx.db.patch(args.id, { stopAsked: true });
    return null;
  },
});

/** Write it up again, with this template if given; also how a failed one is tried again. */
export const regenerate = mutation({
  args: { key: vKey, id: v.id("meetings"), template: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const meeting = await mine(ctx, args.id);
    if (meeting.status === "listening" || meeting.status === "asked") throw new Error("It's still listening to this call.");
    if (meeting.status === "writing") throw new Error("Perry is already writing this up.");
    await ctx.db.patch(args.id, { status: "writing", attempts: 0, claim: undefined, claimedAt: undefined, error: undefined, endedAt: meeting.endedAt ?? Date.now(), ...(args.template ? { template: templateOf(args.template) } : {}) });
    return null;
  },
});

export const rename = mutation({
  args: { key: vKey, id: v.id("meetings"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const meeting = await mine(ctx, args.id);
    const title = args.title.trim().slice(0, 160);
    if (!title) return null;
    await ctx.db.patch(args.id, { title, named: true });
    const note = meeting.noteId ? await ctx.db.get(meeting.noteId) : null;
    if (note) await writePage(ctx, note, { title }, { by: "owner" });
    return null;
  },
});

/** An action item from the write-up, onto the owner's to-do list. Only they do this: a call's words never add to it. */
export const addAction = mutation({
  args: { key: vKey, id: v.id("meetings"), index: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const meeting = await mine(ctx, args.id);
    const actions = [...(meeting.actions ?? [])];
    const action = actions[args.index];
    if (!action || action.todoId) return null;
    actions[args.index] = { ...action, todoId: await insertTodo(ctx, { title: action.text.slice(0, 200), by: "owner" }) };
    await ctx.db.patch(args.id, { actions });
    return null;
  },
});

async function removeMeeting(ctx: MutationCtx, id: Id<"meetings">, keepNote = false) {
  const meeting = await ctx.db.get(id);
  if (!meeting) return;
  for (const segment of await segmentsOf(ctx, id)) await ctx.db.delete(segment._id);
  if (meeting.noteId && !keepNote) await removePage(ctx, meeting.noteId);
  await ctx.db.delete(id);
}

/** Delete a meeting, what was said in it and its page. A pet still listening hears it is gone and stops. */
export const remove = mutation({
  args: { key: vKey, id: v.id("meetings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    await removeMeeting(ctx, args.id);
    return null;
  },
});

export const settings = query({
  args: { key: vKey },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    return { headsUp: install?.meetingHeadsUp !== false, notice: install?.meetingNotice !== false, speech: install?.meetingSpeech ?? { provider: "local" as const, model: "small" as const, language: "en", vocabulary: "" } };
  },
});

export const setSettings = mutation({
  args: { key: vKey, headsUp: v.optional(v.boolean()), notice: v.optional(v.boolean()), speech: v.optional(v.object({ provider: v.union(v.literal("local"), v.literal("groq")), model: v.union(v.literal("small"), v.literal("large-v3-turbo")), language: v.string(), vocabulary: v.string() })) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    if (args.speech && (!/^(auto|[a-z]{2})$/.test(args.speech.language) || args.speech.vocabulary.length > 800)) throw new Error("Choose a speech language and keep vocabulary under 800 characters.");
    if (args.speech?.provider === "local" && args.speech.language === "auto") throw new Error("Choose a language for the local speech model.");
    await ctx.db.patch(install._id, { ...(args.headsUp === undefined ? {} : { meetingHeadsUp: args.headsUp }), ...(args.notice === undefined ? {} : { meetingNotice: args.notice }), ...(args.speech ? { meetingSpeech: args.speech } : {}) });
    return null;
  },
});

// --- The runner's write-up -------------------------------------------------------------------------

/** Meetings waiting for a write-up. Only ids: the words come with the claim, so a long transcript is not sent each time this is read. */
export const pendingNotes = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Array<{ id: Id<"meetings"> }>> => {
    await authenticate(ctx, args.token);
    // Writing up takes a model call: paused, none is made (pause.ts).
    if (await pausedAt(ctx)) return [];
    const now = Date.now();
    const rows = await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "writing")).collect();
    return rows.filter((row) => (row.claimedAt ?? 0) < now - CLAIM_MS).slice(0, 5).map((row) => ({ id: row._id }));
  },
});

/** Take one, with all it needs. Null when it is gone or taken. */
export const claimNotes = mutation({
  args: { token: v.string(), id: v.id("meetings") },
  handler: async (ctx, args): Promise<{ claim: string; title: string; named: boolean; transcript: string; typed: string; template: MeetingTemplate; attendees: string[] } | null> => {
    await authenticate(ctx, args.token);
    if (await pausedAt(ctx)) return null;
    const meeting = await ctx.db.get(args.id);
    const now = Date.now();
    if (meeting?.status !== "writing" || (meeting.claimedAt ?? 0) >= now - CLAIM_MS) return null;
    const claim = crypto.randomUUID();
    await ctx.db.patch(args.id, { claimedAt: now, claim });
    const note = meeting.noteId ? await ctx.db.get(meeting.noteId) : null;
    return {
      claim,
      title: meeting.title,
      named: meeting.named === true,
      transcript: transcriptText(await segmentsOf(ctx, args.id)),
      typed: meeting.typed ?? note?.content ?? "",
      template: templateOf(meeting.template),
      attendees: meeting.attendees ?? [],
    };
  },
});

export const renewNotes = mutation({
  args: { token: v.string(), id: v.id("meetings"), claim: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token);
    const meeting = await ctx.db.get(args.id);
    if (meeting?.status === "writing" && meeting.claim === args.claim) await ctx.db.patch(args.id, { claimedAt: Date.now() });
    return null;
  },
});

export const retryNotes = internalMutation({
  args: { id: v.id("meetings"), claim: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const meeting = await ctx.db.get(args.id);
    if (meeting?.status === "writing" && meeting.claim === args.claim) await ctx.db.patch(args.id, { claim: undefined, claimedAt: undefined });
    return null;
  },
});

/**
 * The write-up, or why not. It goes on the owner's page, above what they typed,
 * which is kept word for word; what they typed while it was being written is
 * kept too. Marked as from outside, because a call's words are in it.
 */
export const finishNotes = mutation({
  args: {
    token: v.string(), id: v.id("meetings"), claim: v.string(), title: v.optional(v.string()), markdown: v.optional(v.string()),
    actions: v.optional(v.array(v.object({ text: v.string(), owner: v.optional(v.string()) }))), error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token);
    const meeting = await ctx.db.get(args.id);
    if (!meeting || meeting.status !== "writing" || meeting.claim !== args.claim) return null;
    if (!args.markdown?.trim()) {
      const attempts = (meeting.attempts ?? 0) + 1;
      const failed = attempts >= MOST_ATTEMPTS;
      await ctx.db.patch(args.id, { attempts, claimedAt: Date.now(), ...(failed ? { status: "failed" as const, claim: undefined, error: `Perry couldn't write this up: ${(args.error ?? "no answer").slice(0, 300)}. The transcript is safe; try again.` } : {}) });
      if (!failed) await ctx.scheduler.runAfter(5_000, internal.meetings.retryNotes, { id: args.id, claim: args.claim });
      return null;
    }
    const clean = await scrubbed(ctx, args.markdown);
    const title = !meeting.named && args.title?.trim() ? args.title.trim().slice(0, 160) : meeting.title;
    let note = meeting.noteId ? await ctx.db.get(meeting.noteId) : null;
    if (!note) {
      // Its page was deleted from Brain: the write-up makes a new one.
      const noteId = await insertPage(ctx, { title, content: "", author: { by: "assistant", outside: true } });
      await ctx.db.patch(args.id, { noteId });
      note = await ctx.db.get(noteId);
    }
    const typed = meeting.typed ?? note!.content;
    await writePage(ctx, note!, { title, content: writtenUp(clean.text, typed) }, { by: "assistant", outside: true });
    const revision = (await ctx.db.get(note!._id))!.revision;
    await ctx.db.patch(args.id, {
      title, status: "done", typed, writtenRevision: revision, writtenAt: Date.now(), claim: undefined, claimedAt: undefined, attempts: 0,
      // A new write-up's actions are new, but what is already on the to-do list stays marked.
      actions: (args.actions ?? []).slice(0, 50).map((action) => ({ text: action.text.slice(0, 300), ...(action.owner ? { owner: action.owner.slice(0, 80) } : {}), ...(meeting.actions?.find((old) => old.text === action.text)?.todoId ? { todoId: meeting.actions.find((old) => old.text === action.text)!.todoId } : {}) })),
    });
    return null;
  },
});

// --- Perry's tools ---------------------------------------------------------------------------------

export const listForAgent = internalQuery({
  args: { chat: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<{ meetings: Array<{ id: string; title: string; status: string; started: string; note?: string; link?: string }> } | { error: string }> => {
    const chat = args.chat ? await ctx.db.get(args.chat) : null;
    if (chat?.contactId) return { error: "Meetings are the owner's: a chat with someone else cannot read them." };
    const timeZone = await timezoneOf(ctx);
    const rows = await ctx.db.query("meetings").withIndex("by_started").order("desc").take(30);
    return {
      meetings: rows.filter((row) => row.status !== "asked").map((row) => ({
        id: row._id, title: row.title, status: row.status, started: new Date(row.startedAt).toLocaleString("en-US", { timeZone }),
        ...(row.noteId ? { note: row.noteId, link: noteHref(row.noteId) } : {}),
      })),
    };
  },
});

export const transcriptForAgent = internalQuery({
  args: { chat: v.optional(v.id("conversations")), id: v.string() },
  handler: async (ctx, args): Promise<{ title: string; transcript: string; note?: string } | { error: string }> => {
    const chat = args.chat ? await ctx.db.get(args.chat) : null;
    if (chat?.contactId) return { error: "Meetings are the owner's: a chat with someone else cannot read them." };
    const id = ctx.db.normalizeId("meetings", args.id);
    const meeting = id ? await ctx.db.get(id) : null;
    if (!meeting) return { error: "There is no meeting by that id; list_meetings shows them." };
    return { title: meeting.title, transcript: transcriptText(await segmentsOf(ctx, meeting._id)), ...(meeting.noteId ? { note: meeting.noteId } : {}) };
  },
});

// --- Keeping up ------------------------------------------------------------------------------------

/** A pet that stopped saying it is listening was cut off; an ask nobody took is dropped; a write-up nobody can do says so. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    for (const row of await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "listening")).collect()) {
      if (row.aliveAt < now - CUT_OFF_MS) await closeOut(ctx, row, "Perry was cut off before this call ended, so this is what he heard until then.");
    }
    for (const row of await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "asked")).collect()) {
      if (row.startedAt < now - ASK_WAIT_MS) await removeMeeting(ctx, row._id);
    }
    for (const row of await ctx.db.query("meetings").withIndex("by_status", (q) => q.eq("status", "writing")).collect()) {
      if ((row.endedAt ?? row.startedAt) < now - WRITING_TTL_MS) await ctx.db.patch(row._id, { status: "failed", error: "No engine was free to write this up. The transcript is safe; try again." });
      else if (row.claimedAt && row.claimedAt < now - CLAIM_MS) await ctx.db.patch(row._id, { claim: undefined, claimedAt: undefined });
    }
    return null;
  },
});

/** Calendar recommendations stay available in the dashboard even when the pet is offline. */
export const worthReading = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    return !await pausedAt(ctx);
  },
});

/** What the calendar says now, over what it said: a dismissal stays with its event, and an event no longer there goes. */
export const replaceUpcoming = internalMutation({
  args: {
    events: v.array(v.object({ eventId: v.string(), title: v.string(), startsAt: v.number(), endsAt: v.number(), joinUrl: v.optional(v.string()), attendees: v.optional(v.array(v.string())) })),
    calendar: v.optional(v.object({ at: v.number(), sources: v.array(v.string()) })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (args.calendar && (install?.meetingCalendar?.at ?? 0) > args.calendar.at) return null;
    const rows = await ctx.db.query("upcomingMeetings").collect();
    const seen = new Set(args.events.map((event) => event.eventId));
    const byEvent = new Map(rows.map((row) => [row.eventId, row]));
    for (const row of rows) if (!seen.has(row.eventId)) await ctx.db.delete(row._id);
    for (const event of args.events) {
      const row = byEvent.get(event.eventId);
      if (!row) await ctx.db.insert("upcomingMeetings", event);
      // Moved to another time, it is a new heads-up.
      else await ctx.db.patch(row._id, { ...event, ...(row.startsAt !== event.startsAt ? { dismissedAt: undefined } : {}) });
    }
    if (install && args.calendar) await ctx.db.patch(install._id, { meetingCalendar: args.calendar });
    return null;
  },
});

export const recommendations = query({
  args: { key: vKey },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    const now = Date.now();
    const events = (await ctx.db.query("upcomingMeetings").collect())
      .filter((event) => event.endsAt > now).sort((a, b) => a.startsAt - b.startsAt).slice(0, 20);
    return { events, calendar: install?.meetingCalendar ?? null, enabled: install?.meetingHeadsUp !== false };
  },
});

export const calendarStatus = internalMutation({
  args: { at: v.number(), sources: v.array(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (install && (install.meetingCalendar?.at ?? 0) <= args.at) await ctx.db.patch(install._id, { meetingCalendar: args });
  },
});

export const refreshCalendar = action({
  args: { key: vKey },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    await ctx.runAction(internal.meetings.syncCalendar, { force: true });
    return null;
  },
});

/** Composio uses the account selected for each toolkit, as it does for other connected tools. */
export const syncCalendar = internalAction({
  args: { force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.force && !await ctx.runQuery(internal.meetings.worthReading, {})) return null;
    const now = Date.now();
    const connected = await ctx.runAction(internal.composio.connectors, {});
    const sources = connected.connectors.filter((item) => item.slug === "googlecalendar" || item.slug === "outlook").map((item) => item.slug);
    try {
      if (connected.configured && connected.error) throw new Error("Calendar connections could not be read. Check Composio in Apps & skills and refresh.");
      const events: Upcoming[] = [];
      const pages = async (slug: string, input: Record<string, unknown>, tokenName: string) => {
        const items: Record<string, unknown>[] = [];
        let token: string | undefined;
        // A broken continuation must never loop forever or silently replace a complete snapshot.
        for (let page = 0; page < 10; page++) {
          const answer = await ctx.runAction(internal.composio.execute, { slug, args: { ...input, ...(token ? { [tokenName]: token } : {}) } });
          if (!answer.ok) throw new Error("A calendar could not be read. Check its connection and permissions in Apps & skills, then refresh. Previous recommendations are kept until they end.");
          const body = calendarPage(answer.data);
          items.push(...calendarItems(body) as Record<string, unknown>[]);
          const next = body.next_page_token ?? body.nextPageToken;
          if (next === undefined || next === null || next === "") {
            if (body["@odata.nextLink"]) throw new Error("The calendar returned an unsupported continuation. Refresh after updating its Composio toolkit.");
            return items;
          }
          if (typeof next !== "string" || next === token) break;
          token = next;
        }
        throw new Error("This calendar has too many pages to refresh at once. Previous recommendations are kept.");
      };
      for (const source of sources) {
        const google = source === "googlecalendar";
        const calendars = await pages(google ? "GOOGLECALENDAR_LIST_CALENDARS" : "OUTLOOK_LIST_CALENDARS", google ? { max_results: 250, min_access_role: "reader" } : { user_id: "me", top: 100 }, "page_token");
        const selected = calendars.filter((calendar) => typeof calendar.id === "string" && !calendar.deleted && (!google || calendar.selected !== false));
        if (selected.length > 30) throw new Error("More than 30 calendars are selected. Reduce the visible calendars and refresh.");
        for (const calendar of selected) {
          const start = new Date(now - 60 * 60_000).toISOString();
          const end = new Date(now + LOOK_AHEAD_MS).toISOString();
          const rows = await pages(google ? "GOOGLECALENDAR_EVENTS_LIST" : "OUTLOOK_LIST_USER_CALENDAR_VIEW", google
            ? { calendarId: calendar.id, timeMin: start, timeMax: end, singleEvents: true, orderBy: "startTime", maxResults: 250 }
            : { user_id: "me", calendar_id: calendar.id, startDateTime: start, endDateTime: end, top: 100, select: ["id", "subject", "start", "end", "attendees", "isCancelled", "isAllDay", "responseStatus", "onlineMeeting", "onlineMeetingUrl", "bodyPreview"] }, google ? "pageToken" : "page_token");
          for (const event of meetingsIn(rows).filter((event) => event.endsAt > now && event.startsAt < now + LOOK_AHEAD_MS)) {
            events.push({ ...event, eventId: JSON.stringify([source, calendar.id, event.eventId]) });
          }
        }
      }
      await ctx.runMutation(internal.meetings.replaceUpcoming, { events, calendar: { at: now, sources } });
    } catch (error) {
      await ctx.runMutation(internal.meetings.calendarStatus, { at: now, sources, error: error instanceof Error ? error.message : "Calendar refresh failed. Try again." });
    }
    return null;
  },
});
