import assert from "node:assert/strict";

const now = Date.now();
let fail = false;
let moved = false;
let disconnected = false;
export const calendarCalls = [];
const event = (id, extra = {}) => ({ id, summary: "CI calendar meeting", start: { dateTime: new Date(now + (moved ? 120_000 : 60_000)).toISOString() }, end: { dateTime: new Date(now + 3_600_000).toISOString() }, hangoutLink: "https://meet.google.com/abc-defg-hij", attendees: [{ displayName: "CI colleague", email: "ci@example.test" }], ...extra });
const def = (handler) => ({ perryFunction: true, kind: "action", visibility: "internal", handler });

// Only the external Composio boundary is substituted. Sync, auth, SQLite, queries,
// dashboard requests and pet handoff all run through the production backend.
export const calendarConnector = {
  connectors: def(async () => ({ configured: true, connectors: disconnected ? [] : [{ slug: "googlecalendar" }, { slug: "outlook" }] })),
  execute: def(async (_ctx, { slug, args }) => {
    calendarCalls.push({ slug, args });
    if (fail) return { ok: false, error: "Synthetic provider unavailable" };
    if (slug === "GOOGLECALENDAR_LIST_CALENDARS") return { ok: true, data: { items: args.page_token ? [{ id: "secondary", selected: true }] : [{ id: "primary", selected: true }], ...(args.page_token ? {} : { next_page_token: "calendars-two" }) } };
    if (slug === "GOOGLECALENDAR_EVENTS_LIST") return { ok: true, data: { items: args.pageToken ? [event("next-page")] : [
      event("shared-id"), event("cancelled", { status: "cancelled" }), event("declined", { attendees: [{ self: true, responseStatus: "declined" }] }),
      event("all-day", { start: { date: "2026-11-04" } }), event("focus", { eventType: "focusTime" }), event("backwards", { end: { dateTime: new Date(now).toISOString() } }),
      event("unsafe", { hangoutLink: "https://meet.google.com.evil.test/", attendees: [] }),
    ], ...(!args.pageToken && args.calendarId === "primary" ? { nextPageToken: "events-two" } : {}) } };
    if (slug === "OUTLOOK_LIST_CALENDARS") return { ok: true, data: { value: [{ id: "outlook-calendar" }] } };
    if (slug === "OUTLOOK_LIST_USER_CALENDAR_VIEW") return { ok: true, data: { response_data: { value: [{ id: "shared-id", subject: "CI Outlook meeting", start: { dateTime: new Date(now + 180_000).toISOString().replace(/Z$/, ""), timeZone: "UTC" }, end: { dateTime: new Date(now + 3_600_000).toISOString().replace(/Z$/, ""), timeZone: "UTC" }, onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/ci" } }] } } };
    throw new Error(`Unexpected calendar call ${slug}`);
  }),
};

export async function calendarFlow(call, key, check) {
  await call("meetings:refreshCalendar", { key });
  let data = await call("meetings:recommendations", { key });
  check("calendar lists and event pages include secondary calendars and Outlook", data.events.length === 4 && calendarCalls.some(({ args }) => args.calendarId === "secondary") && calendarCalls.some(({ args }) => args.pageToken === "events-two"));
  check("calendar event IDs are scoped and unwanted invites filtered", new Set(data.events.map((event) => event.eventId)).size === 4 && !data.calendar.error);
  await call("meetings:replaceUpcoming", { events: [], calendar: { at: data.calendar.at - 1, sources: [] } });
  check("an older overlapping refresh cannot erase newer recommendations", (await call("meetings:recommendations", { key })).events.length === 4);
  const first = data.events[0];
  await call("meetings:dismissUpcoming", { key, eventId: first.eventId });
  await call("meetings:refreshCalendar", { key });
  check("calendar dismissal survives refresh", !(await call("meetings:pet", { key })).upcoming.some((event) => event.eventId === first.eventId));
  fail = true;
  await call("meetings:refreshCalendar", { key });
  data = await call("meetings:recommendations", { key });
  check("failed refresh keeps previous meetings and reports stale data", data.events.length === 4 && Boolean(data.calendar.error));
  fail = false;
  moved = true;
  await call("meetings:refreshCalendar", { key });
  check("moving an event allows a new heads-up", (await call("meetings:pet", { key })).upcoming.some((event) => event.eventId === first.eventId));
  await call("todos:presence", { key, idleSeconds: 0 });
  const asked = await call("meetings:ask", { key, eventId: first.eventId });
  assert.ok(asked.id);
  const started = await call("meetings:start", { key, askedId: asked.id });
  const view = await call("meetings:get", { key, id: started.id });
  check("dashboard request preserves calendar title, attendees and join link", view.title === first.title && view.attendees.includes("CI colleague") && view.joinUrl === first.joinUrl);
  await call("meetings:abandon", { key, id: started.id });
  await assert.rejects(call("meetings:refreshCalendar", { key: "wrong-key" }), /key/i);
  check("calendar refresh requires the owner key", true);
  disconnected = true;
  await call("meetings:refreshCalendar", { key });
  check("disconnected calendars clear recommendations", !(await call("meetings:recommendations", { key })).events.length);
  disconnected = false;
  moved = false;
  await call("meetings:refreshCalendar", { key });
}
