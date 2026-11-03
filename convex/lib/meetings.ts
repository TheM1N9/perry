/**
 * What meetings' server, runner and pages share: how a write-up is shaped, how
 * a transcript reads, and what in a calendar counts as a meeting to join. Pure
 * functions with no server imports.
 */

export const MEETING_TEMPLATES = {
  general: {
    label: "General",
    guidance: "Sections: Summary (a few sentences), Decisions, Discussion (grouped by topic), and Next steps. Leave out any section with nothing in it.",
  },
  oneOnOne: {
    label: "1:1",
    guidance: "Sections: How things are going, What came up, Feedback (either way), and Next steps. Keep it plain and personal; leave out any section with nothing in it.",
  },
  sales: {
    label: "Sales call",
    guidance: "Sections: About them (their company and role), What they need, Objections and worries, Budget and timing, and Next steps. Leave out any section with nothing in it.",
  },
  standup: {
    label: "Standup",
    guidance: "Group by person where you can tell who is speaking: what they finished, what is next, and what is in their way. End with Blockers to follow up on.",
  },
} as const;

export type MeetingTemplate = keyof typeof MEETING_TEMPLATES;
export const DEFAULT_TEMPLATE: MeetingTemplate = "general";
export const templateOf = (id?: string): MeetingTemplate => (id && Object.prototype.hasOwnProperty.call(MEETING_TEMPLATES, id) ? (id as MeetingTemplate) : DEFAULT_TEMPLATE);

/** The heading the owner's own typing goes under, kept word for word below what Perry writes. */
export const TYPED_HEADING = "Your notes";
/** Past this much text, a transcript is written up in parts (runner/meeting-notes.ts). */
export const MEETING_PART_CHARS = 90_000;

export type Spoken = { source: "you" | "them"; startMs: number; text: string };

export function clockOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Runs of one voice, in the order they were said. */
export function runsOf(segments: readonly Spoken[]): Spoken[] {
  const runs: Spoken[] = [];
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    const last = runs.at(-1);
    if (last?.source === segment.source) last.text = `${last.text} ${segment.text}`;
    else runs.push({ ...segment });
  }
  return runs;
}

const nameOf = (source: Spoken["source"]) => (source === "you" ? "You" : "Them");

/** The transcript as text: "[12:03] Them: ...", a line for each turn of talking. */
export function transcriptText(segments: readonly Spoken[]): string {
  return runsOf(segments).map((run) => `[${clockOf(run.startMs)}] ${nameOf(run.source)}: ${run.text}`).join("\n");
}

/** What the page says beside its write-up: what Perry wrote, then the owner's own typing, unchanged. */
export function writtenUp(markdown: string, typed: string): string {
  const own = typed.trim();
  return own ? `${markdown.trim()}\n\n## ${TYPED_HEADING}\n\n${own}\n` : `${markdown.trim()}\n`;
}

// --- The calendar ---------------------------------------------------------------------------------

/**
 * Where a calendar may send the owner with one click. Anyone can send an
 * invite, so its link is someone else's words: only these hosts, over https.
 * pet/listen.js checks again before opening anything.
 */
const MEETING_HOSTS = /(^|\.)(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com)$/i;

export function joinable(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && MEETING_HOSTS.test(parsed.hostname) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

const LINK = /https:\/\/[^\s"'<>)\]]+/g;

export type Upcoming = { eventId: string; title: string; startsAt: number; endsAt: number; joinUrl?: string; attendees?: string[] };

type GoogleEvent = {
  id?: unknown; summary?: unknown; status?: unknown; eventType?: unknown; location?: unknown; description?: unknown; hangoutLink?: unknown;
  start?: { dateTime?: unknown }; end?: { dateTime?: unknown };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }> };
  attendees?: Array<{ email?: unknown; displayName?: unknown; self?: unknown; responseStatus?: unknown }>;
};

/** The event list, wherever the connector put it. */
function eventsIn(data: unknown): GoogleEvent[] {
  if (Array.isArray(data)) return data as GoogleEvent[];
  if (!data || typeof data !== "object") return [];
  const body = data as Record<string, unknown>;
  for (const key of ["items", "events"]) if (Array.isArray(body[key])) return body[key] as GoogleEvent[];
  for (const key of ["response_data", "data"]) if (body[key]) return eventsIn(body[key]);
  return [];
}

/**
 * Meetings out of a Google Calendar answer. An event is one when there is a
 * link to join or someone else on it; "Gym" with neither is not. All-day events,
 * focus time, and ones the owner said no to are not.
 */
export function meetingsIn(data: unknown): Upcoming[] {
  const found: Upcoming[] = [];
  for (const event of eventsIn(data)) {
    const startsAt = Date.parse(String(event.start?.dateTime ?? ""));
    const endsAt = Date.parse(String(event.end?.dateTime ?? ""));
    if (typeof event.id !== "string" || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) continue;
    if (event.status === "cancelled" || (typeof event.eventType === "string" && event.eventType !== "default")) continue;
    const people = event.attendees ?? [];
    if (people.some((person) => person.self === true && person.responseStatus === "declined")) continue;
    const others = people.filter((person) => person.self !== true);
    const text = [event.location, event.description].filter((part) => typeof part === "string").join(" ");
    const joinUrl = [event.hangoutLink, ...(event.conferenceData?.entryPoints ?? []).filter((point) => point.entryPointType === "video").map((point) => point.uri), ...(text.match(LINK) ?? [])]
      .map(joinable).find(Boolean);
    if (!joinUrl && !others.length) continue;
    found.push({
      eventId: event.id,
      title: (typeof event.summary === "string" && event.summary.trim().slice(0, 160)) || "Meeting",
      startsAt, endsAt,
      ...(joinUrl ? { joinUrl } : {}),
      ...(others.length ? { attendees: others.map((person) => String(person.displayName ?? person.email ?? "")).filter(Boolean).slice(0, 30) } : {}),
    });
  }
  return found;
}
