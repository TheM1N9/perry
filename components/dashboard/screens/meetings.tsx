"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { HeadphonesIcon, SquareIcon, Trash2Icon, MessageSquareIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { MEETING_TEMPLATES, clockOf } from "@/convex/lib/meetings";
import type { MeetingSummary, MeetingView } from "@/convex/meetings";
import type { NoteView } from "@/convex/notes";
import { noteHref } from "@/convex/lib/notes";
import { useSession } from "@/lib/session";
import { errorText, useNow } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { NoteEditor } from "@/components/notes/editor";
import { inspectMarkdown } from "@/components/notes/markdown";
import { ActionButton, EmptyState, List, ListSkeleton, Page, RelativeTime, StatusBadge } from "../common";
import { useNoteSaves } from "./notes";

const labels = { asked: "Waiting for the pet", listening: "Listening", writing: "Writing notes", done: "Ready", failed: "Needs attention" } as const;

function MeetingStatus({ meeting, now }: { meeting: MeetingSummary; now: number }) {
  return <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <StatusBadge tone={meeting.status === "failed" ? "warning" : meeting.status === "listening" ? "success" : undefined}>{labels[meeting.status]}</StatusBadge>
    <span className="tabular-nums">{clockOf((meeting.endedAt ?? now) - meeting.startedAt)}</span>
  </span>;
}

export function Meetings() {
  const { dashboardKey: key } = useSession();
  const meetings = useQuery(api.meetings.list, { key });
  const ask = useMutation(api.meetings.ask);
  const router = useRouter();
  const now = useNow(1000);
  return <Page title="Meetings" description="Listen with the desktop pet. Keep a transcript, your notes, and what comes next."
    actions={<ActionButton action={async () => {
      const result = await ask({ key });
      if ("error" in result) throw new Error(result.error);
      router.push(`/meetings/${result.id}`);
    }}><HeadphonesIcon />Listen to a call</ActionButton>}>
    <UpcomingMeetings />
    {meetings === undefined ? <ListSkeleton rows={4} /> : meetings.length === 0 ? <EmptyState mascot title="Your next call, written down">
      Start listening when your call begins. Perry hears your microphone and the computer’s sound, then writes up the decisions and next steps. Only text is saved.
    </EmptyState> : <List label="Meetings">{meetings.map((meeting) => <li key={meeting.id} className="flex items-start gap-3 py-4">
      <HeadphonesIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1"><Link href={`/meetings/${meeting.id}`} className="font-medium hover:underline underline-offset-2">{meeting.title}</Link>
        {meeting.preview && <p className="mt-1 truncate text-sm text-muted-foreground">{meeting.preview}</p>}
        <div className="mt-2"><MeetingStatus meeting={meeting} now={now} /></div>
      </div><RelativeTime at={meeting.startedAt} />
    </li>)}</List>}
  </Page>;
}

function UpcomingMeetings() {
  const { dashboardKey: key } = useSession();
  const data = useQuery(api.meetings.recommendations, { key });
  const refresh = useAction(api.meetings.refreshCalendar);
  const ask = useMutation(api.meetings.ask);
  const router = useRouter();
  const now = useNow(30_000);
  return <section aria-label="Upcoming meetings" className="mb-8 rounded-xl border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-medium">Upcoming</h2>
      <div className="flex items-center gap-2">
        {!data?.calendar?.sources.length && <Button size="sm" variant="ghost" render={<Link href="/apps/connectors" />}>Connect calendars</Button>}
        <ActionButton size="sm" variant="outline" action={() => refresh({ key })}>Refresh calendars</ActionButton>
      </div>
    </div>
    {!data ? <p className="mt-3 text-sm text-muted-foreground">Loading calendar meetings…</p> : <>
      {data.calendar?.error && <p role="status" className="mt-3 text-sm text-destructive">{data.calendar.error}</p>}
      <p className="mt-2 text-sm text-muted-foreground">{data.calendar?.sources.length ? `From ${data.calendar.sources.map((source) => source === "googlecalendar" ? "Google Calendar" : "Outlook").join(" and ")}.` : "Connect Google Calendar or Outlook in Apps & skills, then refresh."}
        {data.calendar && <> Last checked <RelativeTime at={data.calendar.at} />.</>} {data.enabled ? "Perry suggests taking notes as meetings begin." : "Desktop calendar heads-ups are off in Settings."}</p>
      {Boolean(data.calendar?.sources.length) && !data.events.filter((event) => event.endsAt > now).length && <p className="mt-4 text-sm">No meetings in the next 24 hours.</p>}
      <ul className="divide-y">{data.events.filter((event) => event.endsAt > now).map((event) => <li key={event.eventId} className="flex flex-wrap items-center gap-3 py-4 last:pb-0">
        <div className="min-w-0 flex-1"><p className="truncate font-medium">{event.title}</p>
          <p className="mt-1 text-xs text-muted-foreground"><time dateTime={new Date(event.startsAt).toISOString()}>{new Date(event.startsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</time>{event.startsAt <= now && " · In progress"}{event.attendees?.length ? ` · ${event.attendees.slice(0, 3).join(", ")}` : ""}</p>
        </div>
        {event.joinUrl && <Button size="sm" variant="ghost" render={<a href={event.joinUrl} target="_blank" rel="noopener noreferrer" />}>Join</Button>}
        <ActionButton size="sm" variant="outline" action={async () => {
          const result = await ask({ key, eventId: event.eventId });
          if ("error" in result) throw new Error(result.error);
          router.push(`/meetings/${result.id}`);
        }}>Start Notetaker</ActionButton>
      </li>)}</ul>
    </>}
  </section>;
}

export function MeetingScreen() {
  const { dashboardKey: key } = useSession();
  const { id } = useParams<{ id: string }>()!;
  const meeting = useQuery(api.meetings.get, { key, id });
  if (meeting === undefined) return <Page title="Meeting"><ListSkeleton rows={4} /></Page>;
  if (!meeting) return <Page title="Meeting"><EmptyState title="This meeting isn’t here" action={<Button render={<Link href="/meetings" />}>Meetings</Button>}>It may have been deleted, or the desktop pet didn’t answer the listening request.</EmptyState></Page>;
  return <MeetingDetail key={meeting.id} meeting={meeting} />;
}

function MeetingDetail({ meeting }: { meeting: MeetingView }) {
  const { dashboardKey: key } = useSession();
  const router = useRouter();
  const segments = useQuery(api.meetings.transcript, { key, id: meeting.id });
  const note = useQuery(api.notes.get, meeting.noteId ? { key, id: meeting.noteId } : "skip");
  const stop = useMutation(api.meetings.stop);
  const regenerate = useMutation(api.meetings.regenerate);
  const remove = useMutation(api.meetings.remove);
  const rename = useMutation(api.meetings.rename);
  const add = useMutation(api.meetings.addAction);
  const createChat = useMutation(api.dashboard.createChat);
  const sendChat = useMutation(api.dashboard.sendChat);
  const now = useNow(1000);
  const [template, setTemplate] = useState(meeting.template);
  const [title, setTitle] = useState(meeting.title);
  const [renaming, setRenaming] = useState(false);
  const [visibleSegments, setVisibleSegments] = useState(200);
  const transcriptBox = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const box = transcriptBox.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, [segments?.length]);
  useEffect(() => setTitle(meeting.title), [meeting.title]);
  useEffect(() => { document.title = `${meeting.title} · Perry`; }, [meeting.title]);
  const live = meeting.status === "listening" || meeting.status === "asked";
  const writing = meeting.status === "writing";
  return <Page title={meeting.title} wide="full" actions={<>
    <Button variant="ghost" render={<Link href="/meetings" />}>All meetings</Button>
    {meeting.status === "listening" && <ActionButton disabled={meeting.stopAsked} action={() => stop({ key, id: meeting.id })}><SquareIcon />{meeting.stopAsked ? "Stopping…" : "Stop listening"}</ActionButton>}
  </>}>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <MeetingStatus meeting={meeting} now={now} />
      <form className="flex items-center gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (renaming || !title.trim() || title.trim() === meeting.title) return;
        setRenaming(true);
        void rename({ key, id: meeting.id, title }).catch((error) => toast.error(errorText(error))).finally(() => setRenaming(false));
      }}>
        <label htmlFor="meeting-title" className="sr-only">Meeting title</label>
        <Input id="meeting-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} className="max-w-72 text-base" />
        <Button type="submit" size="sm" variant="outline" disabled={renaming || !title.trim() || title.trim() === meeting.title}>{renaming ? "Renaming…" : "Rename"}</Button>
      </form>
    </div>
    {(meeting.error || meeting.droppedMs || (meeting.heard && (!meeting.heard.mic || !meeting.heard.system))) && <div role="status" className="mb-6 flex gap-2 rounded-lg border p-3 text-sm">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="space-y-1">
        {meeting.error && <p>{meeting.error}</p>}
        {Boolean(meeting.droppedMs) && <p>Transcription fell behind. About {clockOf(meeting.droppedMs!)} of audio is missing.</p>}
        {meeting.heard && !meeting.heard.system && <p>Microphone only: the computer’s sound could not be captured.</p>}
        {meeting.heard && !meeting.heard.mic && <p>Computer sound only: the microphone could not be captured.</p>}
      </div>
    </div>}
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <section aria-labelledby="transcript-heading" className="min-w-0">
        <h2 id="transcript-heading" className="mb-4 font-semibold">Transcript</h2>
        <div ref={transcriptBox} onScroll={(event) => {
          const box = event.currentTarget;
          following.current = box.scrollHeight - box.clientHeight - box.scrollTop < 40;
        }} className="max-h-[65dvh] space-y-4 overflow-y-auto rounded-xl border p-4" tabIndex={0}>
          {segments && segments.length > visibleSegments && <Button variant="ghost" size="sm" onClick={() => { following.current = false; setVisibleSegments((count) => count + 200); }}>Show earlier speech</Button>}
          {segments === undefined ? <ListSkeleton rows={3} /> : !segments.length ? <p className="text-sm text-muted-foreground">{meeting.status === "asked" ? "Waiting for your desktop pet. Keep it running on your computer." : live ? "Listening. Words will appear as each phrase is transcribed. The speech model downloads on first use." : "No speech was transcribed."}</p>
            : segments.slice(-visibleSegments).map((segment) => <div key={segment.seq}>
              <p className="mb-1 flex gap-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">{segment.source === "you" ? "You" : "Them"}</span><span className="tabular-nums">{clockOf(segment.startMs)}</span></p>
              <p className="max-w-prose whitespace-pre-wrap text-sm leading-relaxed">{segment.text}</p>
            </div>)}
        </div>
      </section>
      <section aria-labelledby="meeting-notes-heading" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 id="meeting-notes-heading" className="font-semibold">{live ? "Your notes" : "Meeting notes"}</h2>
          {meeting.noteId && <Link href={noteHref(meeting.noteId)} className="text-sm text-muted-foreground underline underline-offset-2">Open in Brain</Link>}
        </div>
        {writing && <p role="status" className="mb-4 text-sm text-muted-foreground">Perry is writing up the call. A connected engine is needed; your transcript is saved.</p>}
        {note ? <MeetingNotes key={note.id} note={note} /> : <p className="text-sm text-muted-foreground">{live ? "The notes page will appear when listening starts." : "The notes page was deleted. Writing up the call again creates a new page."}</p>}
      </section>
    </div>
    {!live && <div className="mt-8 flex flex-wrap items-end gap-3 border-t pt-5">
      <div className="grid gap-1.5"><label htmlFor="meeting-template" className="text-xs text-muted-foreground">Notes template</label>
        <select id="meeting-template" value={template} disabled={writing} onChange={(event) => setTemplate(event.target.value as typeof template)} className="h-9 rounded-md border bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-ring">
          {Object.entries(MEETING_TEMPLATES).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>
      </div>
      <ActionButton variant="outline" disabled={writing} confirm={meeting.editedSince ? { title: "Replace your edited notes?", body: "The new write-up replaces the current page. Your original call notes and transcript are kept, and previous page versions remain in Brain.", label: "Write up again" } : undefined}
        action={() => regenerate({ key, id: meeting.id, template })}>{meeting.status === "failed" ? "Retry write-up" : "Write up again"}</ActionButton>
      <ActionButton variant="ghost" action={async () => {
        const chat = await createChat({ key });
        await sendChat({ key, id: chat, text: `Let's review meeting ${meeting.id}. Read its transcript and notes first, then help me with my questions.` });
        router.push(`/chat/${chat}`);
      }}><MessageSquareIcon />Ask Perry</ActionButton>
    </div>}
    {meeting.actions.length > 0 && <section className="mt-8" aria-labelledby="meeting-actions-heading"><h2 id="meeting-actions-heading" className="mb-3 font-semibold">Action items</h2>
      <List label="Action items">{meeting.actions.map((action, index) => <li key={`${index}:${action.text}`} className="flex items-center justify-between gap-4 py-3">
        <div><p className="text-sm">{action.text}</p>{action.owner && <p className="mt-1 text-xs text-muted-foreground">{action.owner}</p>}</div>
        <ActionButton variant="outline" size="sm" disabled={action.added} action={() => add({ key, id: meeting.id, index })}>{action.added ? "Added" : <><PlusIcon />Add to to-dos</>}</ActionButton>
      </li>)}</List>
    </section>}
    <div className="mt-12 border-t pt-4"><ActionButton variant="ghost" className="text-muted-foreground hover:text-destructive" confirm={{ title: "Delete this meeting?", body: "This deletes the transcript and its notes page. To-dos you added stay on your list.", label: "Delete meeting" }}
      action={async () => { await remove({ key, id: meeting.id }); router.push("/meetings"); }}><Trash2Icon />Delete meeting</ActionButton></div>
  </Page>;
}

function MeetingNotes({ note }: { note: NoteView }) {
  const { controller, state } = useNoteSaves(note);
  const content = state.draft?.content ?? note.content;
  const source = !useMemo(() => inspectMarkdown(note.content), [note.content]).supported;
  return <div>
    <p role="status" className="mb-2 text-xs text-muted-foreground">{state.status === "saved" ? "Saved" : state.status === "saving" ? "Saving…" : state.status === "dirty" ? "Unsaved changes" : state.error}</p>
    {state.status === "conflict" && <div className="mb-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => controller.keepMine()}>Keep my notes</Button><Button size="sm" variant="ghost" onClick={() => controller.useLatest()}>Load saved notes</Button></div>}
    {state.status === "error" && <Button size="sm" variant="outline" onClick={() => void controller.flush(true)}>Retry save</Button>}
    {source ? <Textarea aria-label="Meeting notes in Markdown" value={content} onChange={(event) => controller.edit({ content: event.target.value })} onBlur={() => void controller.flush()} className="min-h-72 text-base" />
      : <NoteEditor label="Meeting notes" value={content} onChange={(value) => controller.edit({ content: value })} onBlur={() => void controller.flush()} />}
  </div>;
}

export function MeetingSettings() {
  const { dashboardKey: key } = useSession();
  const settings = useQuery(api.meetings.settings, { key });
  const save = useMutation(api.meetings.setSettings);
  return <div className="mt-5 space-y-4">{([
    ["headsUp", "Meeting heads-ups", "Suggest taking notes for upcoming Google Calendar and Outlook meetings connected through Composio. You choose when to listen."],
    ["notice", "Notice calls", "Ask to listen when another app uses the microphone. Listening always needs your click."],
  ] as const).map(([field, label, detail]) => <div key={field} className="flex items-start gap-3">
    <Switch id={`meeting-${field}`} checked={settings?.[field] ?? true} disabled={!settings} className="mt-0.5" onCheckedChange={(value) => void save({ key, [field]: value }).catch((error) => toast.error(errorText(error)))} />
    <div className="text-sm"><label htmlFor={`meeting-${field}`} className="font-medium">{label}</label><p className="mt-0.5 text-pretty text-muted-foreground">{detail}</p></div>
  </div>)}</div>;
}
