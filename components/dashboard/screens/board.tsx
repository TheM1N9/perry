"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleIcon, CircleMinusIcon, CirclePauseIcon, CircleSlashIcon, CircleXIcon, ChevronDownIcon, ListFilterIcon,
  ChevronRightIcon, FileTextIcon, ListChecksIcon, SearchIcon, XIcon, Columns3Icon, ListIcon, ActivityIcon, BellIcon, ArrowUpRightIcon, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConnection, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { BoardEvent, BoardHolder, BoardStatus, BoardThread, BoardView, BoardWaiting, FeedItem, ThreadView } from "@/convex/board";
import type { InboxItem } from "@/convex/dashboard";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { PICKED_BY, routeLabel } from "@/convex/lib/routing";
import { tickText, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ProviderIcon } from "../provider-icon";
import { Markdown } from "../chat/markdown";
import { RunSteps } from "../chat/work";
import { ApprovalCard } from "../approval-card";
import { TaskSteering } from "../task-steering";
import { BoardPause } from "../pause";
import { ChannelActions, MarkUpdateRead, noticeThread, ThreadActions, type Notice } from "./board-actions";

/** Rows drawn at a time; the rest are a click away. */
const PAGE = 60;
/** Activity entries drawn: the latest, newest at the bottom. */
const ACTIVITY = 60;

// --- State: one glyph and word, everywhere ---------------------------------------------------------------------

const GLYPH: Record<BoardStatus, LucideIcon> = {
  queued: CircleIcon, blocked: CircleDashedIcon, working: CircleDotIcon, waiting: CirclePauseIcon, done: CircleCheckIcon, failed: CircleXIcon,
};
/** Labels that share a status but not a meaning get a glyph of their own: paused is not done, stopped did not finish. */
const LABEL_GLYPH: Record<string, LucideIcon> = { paused: CircleMinusIcon, stopped: CircleSlashIcon, cancelled: CircleSlashIcon, tracked: ListChecksIcon, "result ready": FileTextIcon };
const WORD: Record<BoardStatus, string> = { queued: "queued", blocked: "waiting", working: "working", waiting: "needs you", done: "done", failed: "failed" };
const TONE: Partial<Record<BoardStatus, string>> = { waiting: "text-warning", failed: "text-destructive" };
/** A label short enough for the state column says more than the bare state ("paused", "stopped"); a longer one goes on line 2. */
const wordOf = (status: BoardStatus, label?: string) => label && label.length <= 12 ? label.toLowerCase() : WORD[status];

/** `compact`: in a narrow list the glyph stands alone, its word still there for a screen reader and on hover. */
function State({ status, label, live = true, compact = false, className }: { status: BoardStatus; label?: string; live?: boolean; compact?: boolean; className?: string }) {
  const Glyph = (label && LABEL_GLYPH[label.toLowerCase()]) || GLYPH[status];
  const word = wordOf(status, label);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", TONE[status], className)} data-state={status} title={compact ? word : undefined}>
      <Glyph aria-hidden className={cn("size-3.5 shrink-0", status === "working" && live && "motion-safe:[&>circle:last-child]:animate-pulse")} />
      <span className={cn("truncate", compact && "@max-[36rem]:sr-only")}>{word}</span>
    </span>
  );
}

/** "12s", "4m", "2h", "3d": an age as the viewer writes it. */
function short(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
/** "in 4h" as the pane says it (rounded, as Intl's relative time is), without the "in": a schedule's next run. */
function ahead(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(ms / 3_600_000);
  return hours < 24 ? `${hours}h` : `${Math.round(ms / 86_400_000)}d`;
}
/** "4m 12s": how long something has run, to the second. */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/** A time that runs, written each second without rendering what holds it. */
function Ticking({ since, format = span, className }: { since: number; format?: (ms: number) => string; className?: string }) {
  return <span className={cn("nums", className)} ref={tickText((now) => format(now - since))} />;
}

const going = (status: BoardStatus) => status === "working" || status === "waiting" || status === "blocked";
/** Who did it, as the viewer names an agent: "codex via PC". */
const actor = (holder?: BoardHolder) => holder?.engine ? `${holder.engine}${holder.machine ? ` via ${holder.machine}` : ""}` : holder?.machine ?? "perry";

// --- Channels: as the viewer lists them, grouped -----------------------------------------------------------------

type Channel = { id: string; name: string; group?: string; has: (thread: BoardThread) => boolean };
const KIND_CHANNELS: Channel[] = [
  { id: "chats", name: "Chats", has: (thread) => thread.kind === "chat" },
  { id: "tasks", name: "Tasks", group: "Work", has: (thread) => thread.kind === "task" },
  { id: "jobs", name: "Schedules", group: "Work", has: (thread) => thread.kind === "job" },
  { id: "heartbeat", name: "Heartbeat", group: "Work", has: (thread) => thread.kind === "heartbeat" },
  { id: "watches", name: "Page watches", group: "Work", has: (thread) => thread.kind === "watch" },
  { id: "goals", name: "Goals", group: "Work", has: (thread) => thread.kind === "goal" },
];
/** The channel a thread is shown in: its project's, else its kind's. */
function channelName(thread: BoardThread, projects: BoardView["projects"]): string {
  const project = thread.projectId && projects.find((item) => item.id === thread.projectId);
  if (project) return project.name;
  // A sub-agent is in its parent's: a chat turn's, a task's or a schedule's.
  if (thread.parent) return thread.parent.startsWith("task:") ? "tasks" : thread.parent.startsWith("job:") ? "jobs" : "chats";
  return KIND_CHANNELS.find((channel) => channel.has(thread))?.name ?? "chats";
}

// --- Tabs: the states the list can be narrowed to ----------------------------------------------------------------

const TABS = ["open", "needs you", "updates", "working", "queued", "waiting", "done", "failed", "all"] as const;
type Tab = (typeof TABS)[number];
const TAB_STATUS: Partial<Record<Tab, BoardStatus>> = { "needs you": "waiting", working: "working", queued: "queued", waiting: "blocked", done: "done", failed: "failed" };
/** How a thread stands on the board: one with something waiting on the owner needs them, whatever its last turn did. */
const standing = (thread: BoardThread, waiting?: BoardWaiting): BoardStatus => waiting ? "waiting" : thread.status;
/** Ongoing rather than at work: a watch or a goal is always on, so it counts as open only in its own channel. */
const ongoing = (thread: BoardThread) => thread.kind === "watch" || thread.kind === "goal";
const savedTask = (thread: BoardThread) => thread.kind === "task" && (thread.label === "Tracked" || thread.label === "Result ready");
/** Open work can progress or needs a decision; passive records remain in Waiting and All. */
const isOpen = (status: BoardStatus, thread: BoardThread, channel?: string) => status !== "done" && status !== "failed" && (status === "waiting" || !savedTask(thread)) && (!ongoing(thread) || channel === (thread.kind === "watch" ? "watches" : "goals"));
const inTab = (status: BoardStatus, thread: BoardThread, tab: Tab, channel?: string) =>
  tab === "all" || (tab === "open" ? isOpen(status, thread, channel) : tab === "needs you" ? status === "waiting" : status === TAB_STATUS[tab]);

// --- The address: view, channel, tab, open thread, computer ------------------------------------------------------

type Place = { view: "tasks" | "activity"; layout: "kanban" | "list"; channel: string | null; tab: Tab | null; thread: string | null; computer: string | null; q: string | null; sort: "priority" | "updated" | "oldest" | null };
function useAddress() {
  const params = useSearchParams()!;
  const pathname = usePathname()!;
  const router = useRouter();
  const place: Place & { tab: Tab } = {
    view: params.get("view") === "activity" ? "activity" : "tasks",
    layout: params.get("layout") === "list" ? "list" : "kanban",
    channel: params.get("channel"),
    tab: (TABS as readonly string[]).includes(params.get("tab") ?? "") ? params.get("tab") as Tab : "all",
    thread: params.get("thread"),
    computer: params.get("computer"),
    q: params.get("q"),
    sort: params.get("sort") === "updated" ? "updated" : params.get("sort") === "oldest" ? "oldest" : "priority",
  };
  const href = useCallback((next: Partial<Place>) => {
    const query = new URLSearchParams(params);
    for (const [name, value] of Object.entries(next)) {
      if (value && !(name === "view" && value === "tasks") && !(name === "layout" && value === "kanban") && !(name === "tab" && value === "all") && !(name === "sort" && value === "priority")) query.set(name, value);
      else query.delete(name);
    }
    const search = query.toString();
    return search ? `${pathname}?${search}` : pathname;
  }, [params, pathname]);
  return { ...place, href, go: (next: Partial<Place>) => router.replace(href(next), { scroll: false }) };
}

const SEEN = "perry.board.seen";
type Seen = { since: number; at: Record<string, number> };

/** Which threads changed since last opened, kept in this browser and only for threads still on the board. */
function useSeen(threads: BoardThread[] | undefined) {
  const [seen, setSeen] = useState<Seen | null>(null);
  useEffect(() => {
    let stored: Seen | null = null;
    try { stored = JSON.parse(window.localStorage.getItem(SEEN) ?? "null") as Seen | null; } catch {}
    setSeen(stored && typeof stored.since === "number" && stored.at && typeof stored.at === "object" ? stored : { since: Date.now(), at: {} });
  }, []);
  // Storage can be full or blocked; the marks then last for this visit.
  useEffect(() => {
    if (!seen) return;
    try { window.localStorage.setItem(SEEN, JSON.stringify(seen)); } catch {}
  }, [seen]);
  const ready = seen !== null;
  const ids = useMemo(() => new Set(threads?.map((thread) => thread.id)), [threads]);
  const mark = useCallback((thread: BoardThread) => {
    if (!ready) return;
    setSeen((current) => {
      if (!current || (current.at[thread.id] ?? current.since) >= thread.updatedAt) return current;
      const at = Object.fromEntries(Object.entries(current.at).filter(([id]) => ids.has(id)));
      at[thread.id] = thread.updatedAt;
      return { since: current.since, at };
    });
  }, [ids, ready]);
  const unseen = useCallback((thread: BoardThread) => Boolean(seen && thread.updatedAt > (seen.at[thread.id] ?? seen.since)), [seen]);
  return { unseen, mark };
}

/** Rows there when the list first drew come in still; later ones fade in. */
function useArrivals(ids: string[] | undefined) {
  const known = useRef<Set<string> | null>(null);
  if (ids && !known.current) known.current = new Set(ids);
  const key = ids?.join("|");
  // Replaced, not added to, so a tab open for days keeps only the rows on the board.
  useEffect(() => { if (ids) known.current = new Set(ids); }, [key]);
  return (id: string) => Boolean(known.current && !known.current.has(id));
}

// --- The Board ----------------------------------------------------------------------------------------------------

/**
 * What Perry is doing, everywhere at once (issue #363): views and channels on the left, the list, and the open
 * thread beside it. Read-only: answering and approving stay where they already are.
 */
export function Board() {
  const { dashboardKey } = useSession();
  const board = useQuery(api.board.get, { key: dashboardKey });
  const inbox = useQuery(api.dashboard.getInbox, { key: dashboardKey });
  const place = useAddress();
  const { unseen, mark } = useSeen(board?.threads);

  const channels = useMemo(() => {
    const projects = (board?.projects ?? [])
      .map((project): Channel => ({ id: `project:${project.id}`, name: project.name, group: "Projects", has: (thread) => thread.projectId === project.id }));
    return [...KIND_CHANNELS, ...projects];
  }, [board]);
  const channel = channels.find((item) => item.id === place.channel);
  /** Waiting items by the thread each holds up; one with no thread on the board is a row of its own. */
  const waitingFor = useMemo(() => new Map((board?.waiting ?? []).flatMap((item) => item.thread ? [[item.thread, item] as const] : [])), [board]);
  const loose = useMemo(() => (board?.waiting ?? []).filter((item) => !item.thread), [board]);
  /** What Needs you listed besides questions: a failure, a schedule's news, a watch that fired; each on its thread. */
  const notices = useMemo(() => (inbox ?? []).filter((item): item is Notice => item.kind !== "question"), [inbox]);
  const noticeFor = useMemo(() => new Map(notices.flatMap((item) => { const thread = noticeThread(item); return thread ? [[thread, item] as const] : []; })), [notices]);
  const updates = useMemo(() => notices.filter(item => {
    const thread = board?.threads.find(thread => thread.id === noticeThread(item));
    return searchText(place.q, `${item.title} ${item.text}`) && (!channel || Boolean(thread && channel.has(thread)))
      && (!place.computer || Boolean(thread && onComputer(thread, place.computer)));
  }), [notices, board, place.q, place.computer, channel]);

  const openedThread = useRef<string | null>(null);
  if (place.thread) openedThread.current = place.thread;
  const pane = !place.thread ? null : place.thread.startsWith("update:")
    ? <UpdatePane id={place.thread} notices={inbox === undefined ? undefined : notices} close={place.href({ thread: null })} />
    : place.thread.startsWith("approval:")
    ? <ApprovalPane key={place.thread} id={place.thread} close={place.href({ thread: null })} />
    : <Pane key={place.thread} id={place.thread} close={place.href({ thread: null })} projects={board?.projects ?? []} notice={noticeFor.get(place.thread)} onSeen={mark} overlay place={(thread) => place.href({ thread })} />;
  // Work running anywhere: what "pause all" stops.
  const busy = Boolean(board?.threads.some((thread) => !ongoing(thread) && (thread.status === "working" || thread.status === "queued" || thread.status === "waiting")));

  return (
    <div className="flex h-svh min-h-0 min-w-0 text-sm leading-5" data-board>
      <main id="content" tabIndex={-1} className="@container flex min-w-0 flex-1 flex-col outline-none">
        <Header place={place} board={board} updates={updates.length}
          actions={<>
            <ChannelActions channel={channel?.id} updates={place.view === "tasks" && place.tab === "updates"} notices={updates} compact={false} onCreated={id => place.go({ view: "tasks", channel: "tasks", tab: "all", thread: `task:${id}`, q: null, computer: null })} />
            <BoardPause active={busy} compact />
          </>} />
        <SearchWork place={place} channels={channels} board={board} />
        {place.view === "tasks"
          ? <Tasks board={board} place={place} channel={channel} waitingFor={waitingFor} loose={loose} noticeFor={noticeFor} updates={inbox === undefined ? undefined : updates} unseen={unseen} />
          : <Activity board={board} place={place} channel={channel} />}
      </main>
      <Sheet open={Boolean(place.thread)} onOpenChange={open => { if (!open) place.go({ thread: null }); }}>
        <SheetContent showCloseButton={false} className="gap-0 text-sm outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-xl" aria-describedby={undefined}
          finalFocus={() => {
            const id = CSS.escape(openedThread.current ?? "");
            return document.querySelector<HTMLElement>(`[data-card="${id}"] > a, [data-row="${id}"] > a`)
              ?? document.querySelector<HTMLInputElement>("[data-board-search] input");
          }}>
          <SheetTitle className="sr-only">Work details</SheetTitle>
          {pane}
        </SheetContent>
      </Sheet>
    </div>
  );
}

const HEADER = "flex h-12 shrink-0 items-center gap-2 border-b px-4";

const searchText = (query: string | null, text: string) => {
  if (!query?.trim()) return true;
  const lower = text.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => lower.includes(word));
};
const matchesSearch = (thread: BoardThread, query: string | null, projects: BoardView["projects"] = []) => !query?.trim() || searchText(query,
  [thread.title, thread.ask, thread.now, thread.label, thread.kind, thread.holder?.engine, thread.holder?.model, thread.holder?.machine, projects.find(project => project.id === thread.projectId)?.name].filter(Boolean).join(" "));

const TAB_LABEL: Record<Tab, string> = { all: "All work", open: "Active work", "needs you": "Needs you", updates: "Updates", working: "Working", queued: "Queued", waiting: "Waiting", done: "Done", failed: "Failed" };

function SearchWork({ place, channels, board }: { place: ReturnType<typeof useAddress>; channels: Channel[]; board?: BoardView }) {
  const [draft, setDraft] = useState(place.q ?? "");
  useEffect(() => { setDraft(new URL(window.location.href).searchParams.get("q") ?? ""); }, [place.q]);
  const search = (value: string) => { setDraft(value); window.history.replaceState(null, "", place.href({ q: value || null })); };
  const channel = channels.find(item => item.id === place.channel);
  const filtered = Boolean(place.channel || place.computer || place.q || place.view === "tasks" && !["all", "updates"].includes(place.tab));
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6" data-board-search>
    <InputGroup className="h-10 min-w-44 flex-1 sm:max-w-sm">
      <InputGroupAddon><SearchIcon aria-hidden /></InputGroupAddon>
      <InputGroupInput type="search" aria-label="Search board" placeholder="Search your work..." value={draft} maxLength={200} onChange={event => search(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); search(""); } }} />
      {place.q && <InputGroupAddon align="inline-end"><InputGroupButton aria-label="Clear board search" size="icon-xs" onClick={() => search("")}><XIcon /></InputGroupButton></InputGroupAddon>}
    </InputGroup>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-10 max-w-48" aria-label="Filter by source" />}>
        <span className="truncate">{channel?.name ?? "All sources"}</span><ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60dvh] w-56 overflow-y-auto">
        <DropdownMenuRadioGroup value={place.channel ?? ""} onValueChange={value => place.go({ channel: value || null })}>
          <DropdownMenuRadioItem closeOnClick value="">All sources</DropdownMenuRadioItem>
          {([undefined, "Work", "Projects"] as const).map(group => <DropdownMenuGroup key={group ?? "chats"}>
            {group && <><DropdownMenuSeparator /><DropdownMenuLabel>{group}</DropdownMenuLabel></>}
            {channels.filter(item => item.group === group).map(item => <DropdownMenuRadioItem closeOnClick key={item.id} value={item.id}>{item.name}</DropdownMenuRadioItem>)}
          </DropdownMenuGroup>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {place.view === "tasks" && place.tab !== "updates" && <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-10" aria-label="Filter by status" />}><span>{TAB_LABEL[place.tab]}</span><ChevronDownIcon /></DropdownMenuTrigger>
      <DropdownMenuContent align="start"><DropdownMenuRadioGroup value={place.tab} onValueChange={value => place.go({ tab: value as Tab })}>
        {(["all", "open", "needs you", "working", "queued", "waiting", "done", "failed"] as const).map(tab => <DropdownMenuRadioItem closeOnClick key={tab} value={tab}>{TAB_LABEL[tab]}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup></DropdownMenuContent>
    </DropdownMenu>}
    {(board?.machines.length ?? 0) > 1 && <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-10 max-w-48" aria-label="Filter by computer" />}><span className="truncate">{place.computer ?? "All computers"}</span><ChevronDownIcon /></DropdownMenuTrigger>
      <DropdownMenuContent align="start"><DropdownMenuRadioGroup value={place.computer ?? ""} onValueChange={value => place.go({ computer: value || null })}>
        <DropdownMenuRadioItem closeOnClick value="">All computers</DropdownMenuRadioItem>
        {board?.machines.map(machine => <DropdownMenuRadioItem closeOnClick key={machine.name} value={machine.name}>{machine.name}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup></DropdownMenuContent>
    </DropdownMenu>}
    {place.view === "tasks" && place.tab !== "updates" && <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="h-10 px-3" aria-label="Sort board" />}><ListFilterIcon /><span className="sr-only sm:not-sr-only">Sort</span></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuRadioGroup value={place.sort ?? "priority"} onValueChange={value => place.go({ sort: value as Place["sort"] })}>
        <DropdownMenuRadioItem closeOnClick value="priority">Needs you first</DropdownMenuRadioItem>
        <DropdownMenuRadioItem closeOnClick value="updated">Recently updated</DropdownMenuRadioItem>
        <DropdownMenuRadioItem closeOnClick value="oldest">Oldest first</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup></DropdownMenuContent>
    </DropdownMenu>}
    {filtered && <Button variant="ghost" className="h-10" render={<Link href={place.href({ channel: null, computer: null, q: null, tab: place.tab === "updates" ? "updates" : "all" })} scroll={false} />}>Clear filters</Button>}
  </div>;
}

function Header({ place, board, updates, actions }: { place: ReturnType<typeof useAddress>; board?: BoardView; updates: number; actions: ReactNode }) {
  const connection = useConnection();
  const views = [
    { label: "Kanban", icon: Columns3Icon, active: place.view === "tasks" && place.tab !== "updates" && place.layout === "kanban", href: place.href({ view: "tasks", layout: "kanban", tab: place.tab === "updates" ? "all" : place.tab }) },
    { label: "List", icon: ListIcon, active: place.view === "tasks" && place.tab !== "updates" && place.layout === "list", href: place.href({ view: "tasks", layout: "list", tab: place.tab === "updates" ? "all" : place.tab }) },
    { label: "Updates", icon: BellIcon, active: place.view === "tasks" && place.tab === "updates", href: place.href({ view: "tasks", tab: "updates", thread: null }) },
    { label: "Activity", icon: ActivityIcon, active: place.view === "activity", href: place.href({ view: "activity", thread: null }) },
  ];
  return <header className="shrink-0 border-b px-4 pt-4 sm:px-6 sm:pt-5">
    <div className="flex items-start gap-3">
      <SidebarTrigger className="-ml-2 mt-1 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">Board</h1>
        <p className="mt-1 text-sm text-muted-foreground @max-[28rem]:hidden">Your work, from request to result.</p>
      </div>
      <div className="flex shrink-0 items-center gap-1 [&_button]:min-h-10">{actions}</div>
    </div>
    <div className="mt-4 flex min-w-0 items-center justify-between gap-2">
      <nav aria-label="Board views" className="flex min-w-0 gap-1 overflow-x-auto">
        {views.map(({ label, icon: Icon, active, href }) => <Link key={label} href={href} scroll={false} aria-current={active ? "page" : undefined}
          className={cn("flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          <Icon aria-hidden className="size-4 @max-[28rem]:hidden" />{label}
          {label === "Updates" && updates > 0 && <span className="rounded bg-muted px-1.5 text-xs tabular-nums">{updates}</span>}
        </Link>)}
      </nav>
      <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex" data-live={connection}>
        <span aria-hidden className={cn("size-1.5 rounded-full", connection === "connected" ? "bg-foreground" : "border border-muted-foreground")} />
        {connection === "connected" ? "Live" : "Reconnecting"}
        {board && <span className="sr-only">, {board.machines.filter(machine => machine.online).length} computers online</span>}
      </span>
    </div>
  </header>;
}

/** Whether a thread passes the computer filter: what holds it now, or held it last. */
const onComputer = (thread: BoardThread, computer: string | null) => !computer || thread.holder?.machine === computer;

function Tasks({ board, place, channel, waitingFor, loose, noticeFor, updates, unseen }: {
  board?: BoardView; place: ReturnType<typeof useAddress>; channel?: Channel; waitingFor: Map<string, BoardWaiting>; loose: BoardWaiting[];
  noticeFor: Map<string, Notice>; updates?: Notice[]; unseen: (thread: BoardThread) => boolean;
}) {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [place.channel, place.tab, place.computer, place.q, place.sort]);
  // Sub-agents are listed under the thread that started them, never on their own.
  const agentsOf = useMemo(() => {
    const map = new Map<string, BoardThread[]>();
    for (const thread of board?.threads ?? []) if (thread.parent) map.set(thread.parent, [...(map.get(thread.parent) ?? []), thread]);
    for (const list of map.values()) list.sort((a, b) => a.startedAt - b.startedAt);
    return map;
  }, [board]);
  const matching = useMemo(() => new Set(board?.threads.filter(thread => matchesSearch(thread, place.q, board.projects)).map(thread => thread.id)), [board, place.q]);
  const matches = (thread: BoardThread, tab = place.tab) => inTab(standing(thread, waitingFor.get(thread.id)), thread, tab, channel?.id)
    && onComputer(thread, place.computer) && matching.has(thread.id);
  // Opened or closed by hand; otherwise a parent is open while one of its agents runs, or one is the thread open.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  useEffect(() => setToggled({}), [place.channel, place.tab, place.computer, place.q]);
  const expanded = (thread: BoardThread) => toggled[thread.id]
    ?? Boolean(agentsOf.get(thread.id)?.some((agent) => standing(agent, waitingFor.get(agent.id)) === "waiting" || agent.status === "working" || agent.id === place.thread || matches(agent) && (Boolean(place.q?.trim()) || place.tab !== "all" || Boolean(place.computer))));
  const toggle = (thread: BoardThread) => setToggled((current) => ({
    ...Object.fromEntries(Object.entries(current).filter(([id]) => agentsOf.has(id))), [thread.id]: !expanded(thread),
  }));
  const scoped = (board?.threads ?? []).filter(thread => !thread.parent && (!channel || channel.has(thread)));
  const needsOwner = (thread: BoardThread) => standing(thread, waitingFor.get(thread.id)) === "waiting"
    || Boolean(agentsOf.get(thread.id)?.some(agent => standing(agent, waitingFor.get(agent.id)) === "waiting"));
  const priority: Record<BoardStatus, number> = { waiting: 0, working: 1, blocked: 2, queued: 3, failed: 4, done: 4 };
  const threads = scoped.filter(thread => matches(thread) || Boolean(agentsOf.get(thread.id)?.some(agent => matches(agent))))
    // What needs the owner leads, whatever the order its threads came in.
    .sort((a, b) => place.sort === "updated" ? b.updatedAt - a.updatedAt : place.sort === "oldest" ? a.startedAt - b.startedAt
      : Number(needsOwner(b)) - Number(needsOwner(a))
        || priority[standing(a, waitingFor.get(a.id))] - priority[standing(b, waitingFor.get(b.id))]
        || (a.inLine ?? Number.MAX_SAFE_INTEGER) - (b.inLine ?? Number.MAX_SAFE_INTEGER));
  const matchingLoose = !channel && !place.computer ? loose.filter(item => searchText(place.q, `${item.text} ${item.where ?? ""}`)) : [];

  const looseShown = place.tab === "open" || place.tab === "needs you" || place.tab === "all" ? matchingLoose : [];
  const updatesShown = place.tab === "updates" ? updates ?? [] : [];
  const counts = Object.fromEntries(TABS.map(tab => [tab, tab === "updates" ? updates?.length ?? 0 : scoped.filter(thread => matches(thread, tab) || agentsOf.get(thread.id)?.some(agent => matches(agent, tab))).length
    + (["open", "needs you", "all"].includes(tab) ? matchingLoose.length : 0)]));
  const fresh = useArrivals(board ? [...looseShown.map((item) => item.id), ...threads.map((thread) => thread.id)] : undefined);
  const total = place.tab === "updates" ? updates?.length ?? 0 : threads.length + looseShown.length;
  const noun = place.tab === "updates" ? "update" : "work item";
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm sm:px-6">
        <p className="text-muted-foreground" role="status">{board ? `${total} ${noun}${total === 1 ? "" : "s"}` : "Loading your work..."}</p>
        {place.tab !== "updates" && (counts["needs you"] > 0 || place.tab === "needs you") && <Link href={place.href({ tab: place.tab === "needs you" ? "all" : "needs you" })} scroll={false}
          className="inline-flex min-h-10 items-center gap-2 rounded-md bg-warning/10 px-3 font-medium text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring" data-needs-you-tab>
          <CirclePauseIcon aria-hidden className="size-4" />Needs you <span className="tabular-nums">{counts["needs you"]}</span>{place.tab === "needs you" && <XIcon aria-hidden className="size-3.5" />}
        </Link>}
      </div>
      {place.layout === "kanban" && place.tab !== "updates" ? <Kanban board={board} threads={threads} loose={looseShown} place={place} waitingFor={waitingFor} noticeFor={noticeFor} agentsOf={agentsOf} expanded={expanded} toggle={toggle} matches={matches} unseen={unseen} fresh={fresh} allCount={counts.all} /> :
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
        {(!board || place.tab === "updates" && updates === undefined) && <div className="space-y-3 px-4 py-2" role="status" aria-label="Loading">{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-9" />)}</div>}
        {board && (place.tab !== "updates" || updates !== undefined) && threads.length + looseShown.length + updatesShown.length === 0 && <div className="space-y-1 px-4 py-6 text-muted-foreground" data-empty>
          <p>{place.q?.trim() ? "No work in this view matches your search." : place.tab === "needs you" ? "Nothing needs your decision." : place.tab === "updates" ? "You're up to date." : "No work in this view."}</p>
          {!place.q?.trim() && place.tab === "needs you" && !!updates?.length && <Link href={place.href({ tab: "updates" })} scroll={false} className="inline-flex min-h-11 items-center underline underline-offset-4">Read {updates.length} {updates.length === 1 ? "update" : "updates"}</Link>}
          {place.q?.trim() ? <div className="flex flex-wrap gap-x-4">
            {place.tab !== "all" && counts.all > 0 && <Link href={place.href({ tab: "all" })} scroll={false} className="inline-flex min-h-11 items-center text-foreground underline underline-offset-4">Search all statuses</Link>}
            <Link href={place.href({ q: null })} scroll={false} className="inline-flex min-h-11 items-center text-foreground underline underline-offset-4">Clear search</Link>
          </div>
            : place.tab !== "all" ? <Link href={place.href({ tab: "all" })} className="text-foreground underline underline-offset-4">View all work</Link> : <p className="text-xs">Create a task above to give Perry something to work on.</p>}
        </div>}
        {place.tab === "open" && scoped.some(savedTask) && <p className="px-4 py-2 text-xs text-muted-foreground" data-saved-plans>Saved plans and results are in <Link href={place.href({ tab: "waiting", thread: null })} scroll={false} className="underline underline-offset-4">Waiting</Link>.</p>}
        <ul aria-label="Threads" className="max-w-[54rem]" data-rows>
          {looseShown.map((item) => <WaitingRow key={item.id} item={item} href={item.kind === "question" ? item.href : place.href({ thread: item.id })} selected={place.thread === item.id} fresh={fresh(item.id)} />)}
          {threads.slice(0, shown).map((thread) => (
            <ThreadRow key={thread.id} thread={thread} href={place.href({ thread: thread.id })} selected={place.thread === thread.id} waiting={waitingFor.get(thread.id)}
              channel={channel ? "" : channelName(thread, board!.projects)} fresh={fresh(thread.id)} changed={unseen(thread)}
              agents={agentsOf.get(thread.id)} expanded={expanded(thread)} onToggle={() => toggle(thread)} agentHref={(id) => place.href({ thread: id })} openThread={place.thread} />
          ))}
          {updatesShown.slice(0, shown).map((item) => <UpdateRow key={`${item.kind}:${item.id}`} item={item} href={place.href({ thread: updateId(item) })} selected={place.thread === updateId(item)} />)}
        </ul>
        {Math.max(threads.length, updatesShown.length) > shown && <button type="button" className="mx-4 my-2 min-h-11 text-muted-foreground hover:text-foreground" onClick={() => setShown(shown + PAGE)}>show more</button>}
      </div>}
    </>
  );
}

const CARD_PAGE = 10;
const COLUMNS: Array<{ status: BoardStatus; label: string; hint: string }> = [
  { status: "waiting", label: "Needs you", hint: "Questions and approvals" },
  { status: "working", label: "Working", hint: "Running work and active monitors" },
  { status: "queued", label: "Queued", hint: "Ready to start" },
  { status: "blocked", label: "Waiting", hint: "Plans, results and other waits" },
  { status: "failed", label: "Failed", hint: "Something went wrong" },
  { status: "done", label: "Done", hint: "Finished, stopped or cancelled" },
];

function Kanban({ board, threads, loose, place, waitingFor, noticeFor, agentsOf, expanded, toggle, matches, unseen, fresh, allCount }: {
  board?: BoardView; threads: BoardThread[]; loose: BoardWaiting[]; place: ReturnType<typeof useAddress>;
  waitingFor: Map<string, BoardWaiting>; noticeFor: Map<string, Notice>; agentsOf: Map<string, BoardThread[]>;
  expanded: (thread: BoardThread) => boolean; toggle: (thread: BoardThread) => void;
  matches: (thread: BoardThread) => boolean; unseen: (thread: BoardThread) => boolean; fresh: (id: string) => boolean;
  allCount: number;
}) {
  const [shown, setShown] = useState<Partial<Record<BoardStatus, number>>>({});
  useEffect(() => setShown({}), [place.channel, place.tab, place.computer, place.q, place.sort]);
  const requestAgentOf = (thread: BoardThread) => agentsOf.get(thread.id)?.find(agent => matches(agent) && standing(agent, waitingFor.get(agent.id)) === "waiting");
  const columnOf = (thread: BoardThread) => requestAgentOf(thread) ? "waiting" : standing(thread, waitingFor.get(thread.id));
  const groups = COLUMNS.map(column => ({ ...column, threads: threads.filter(thread => columnOf(thread) === column.status) }));
  const empty = board && threads.length + loose.length === 0;
  const filtered = Boolean(place.q?.trim() || place.channel || place.computer);
  const columns = groups.filter(column => !filtered && place.tab === "all" || column.threads.length > 0 || column.status === "waiting" && loose.length > 0 || column.status === TAB_STATUS[place.tab]);
  return <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-muted/25 px-4 pb-5 sm:px-6" data-kanban tabIndex={0} role="region" aria-label="Kanban board">
    {!board ? <div className="grid gap-4 py-3 sm:grid-cols-3" role="status" aria-label="Loading">{[0, 1, 2].map(index => <Skeleton key={index} className="h-52 rounded-xl" />)}</div>
      : empty ? <div className="mx-auto max-w-md py-16 text-center" data-empty>
        <CircleCheckIcon className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
        <h2 className="font-semibold">{place.q?.trim() ? "No matching work" : place.tab === "needs you" ? "Nothing needs your decision" : "No work in this view"}</h2>
        <p className="mt-2 text-muted-foreground">{place.q?.trim() ? "Try a different search or clear your filters." : place.tab === "all" && !place.channel && !place.computer ? "Create a task above. Its progress and result will appear here." : "Change your filters to see the rest of your work."}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {place.tab !== "all" && allCount > 0 && <Button variant="outline" className="min-h-11" render={<Link href={place.href({ tab: "all" })} scroll={false} />}>{place.q?.trim() ? "Search all statuses" : "View all work"}</Button>}
          {place.q?.trim() && <Button variant="outline" className="min-h-11" render={<Link href={place.href({ q: null })} scroll={false} />}>Clear search</Button>}
        </div>
      </div>
      : <div className="flex min-h-full flex-col gap-4 pt-1 @min-[48rem]:h-full @min-[48rem]:flex-row @min-[48rem]:items-start">
        {columns.map(column => {
          const requests = column.status === "waiting" ? loose : [];
          const count = column.threads.length + requests.length;
          const limit = shown[column.status] ?? CARD_PAGE;
          const Glyph = GLYPH[column.status];
          return <section key={column.status} aria-label={column.label} data-kanban-column={column.status}
            className={cn("flex min-w-0 shrink-0 flex-col rounded-xl p-2 @min-[48rem]:h-full @min-[48rem]:w-72", count === 0 && "@min-[48rem]:w-44")}>
            <div className="flex items-center gap-2 px-2 pt-2" data-column-heading>
              <Glyph aria-hidden className="size-4" />
              <h2 className="flex-1 font-semibold">{column.label}</h2><span className="rounded-md px-2 py-0.5 text-xs tabular-nums" data-column-count>{count}</span>
            </div>
            <p className="mb-3 mt-1 px-2 text-xs text-muted-foreground">{column.hint}</p>
            <ul className="space-y-2 @min-[48rem]:min-h-0 @min-[48rem]:flex-1 @min-[48rem]:overflow-y-auto" aria-label={`${column.label} work`}>
              {requests.slice(0, limit).map(item => <li key={item.id} data-card={item.id}>
                <Link href={item.kind === "question" ? item.href : place.href({ thread: item.id })} scroll={false} className={cn(CARD, place.thread === item.id && "ring-2 ring-ring")}>
                  <span className="text-xs font-medium text-warning">{item.kind === "question" ? "Question" : "Approval"}</span>
                  <h3 className="mt-2 line-clamp-2 font-semibold [overflow-wrap:anywhere]">{item.where ?? "Request in chat"}</h3>
                  <p className={cn("mt-2 line-clamp-3 text-sm text-muted-foreground [overflow-wrap:anywhere]", item.command && "font-mono text-xs")} data-command={item.command || undefined}>{item.text}</p>
                  <div className="mt-4 flex items-center justify-between gap-2 text-xs"><span className="font-medium">{item.kind === "question" ? "Answer question" : "Review approval"}</span><Age at={item.at} /></div>
                </Link>
              </li>)}
              {column.threads.slice(0, Math.max(0, limit - requests.length)).map(thread => <WorkCard key={thread.id} thread={thread} place={place} waiting={waitingFor.get(thread.id)} notice={noticeFor.get(thread.id)}
                channel={channelName(thread, board.projects)} agents={agentsOf.get(thread.id) ?? []} expanded={expanded(thread)} toggle={() => toggle(thread)}
                matches={matches} waitingFor={waitingFor} requestAgent={requestAgentOf(thread)} changed={unseen(thread)} fresh={fresh(thread.id)} />)}
            </ul>
            {count === 0 && <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">Nothing here</p>}
            {count > limit && <button type="button" className="mt-2 flex min-h-11 w-full items-center justify-center rounded-lg text-sm font-medium text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => setShown(current => ({ ...current, [column.status]: limit + CARD_PAGE }))} aria-label={`Show more ${column.label}`}>
              Show {Math.min(CARD_PAGE, count - limit)} more <span className="ml-1 text-xs font-normal">({count - limit} remaining)</span>
            </button>}
          </section>;
        })}
      </div>}
  </div>;
}

const CARD = "block min-w-0 rounded-lg border bg-background p-4 text-foreground shadow-xs outline-none transition-[border-color,box-shadow] hover:border-foreground/25 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

function WorkCard({ thread, place, waiting, notice, channel, agents, expanded, toggle, matches, waitingFor, requestAgent, changed, fresh }: {
  thread: BoardThread; place: ReturnType<typeof useAddress>; waiting?: BoardWaiting; notice?: Notice; channel: string;
  agents: BoardThread[]; expanded: boolean; toggle: () => void; matches: (thread: BoardThread) => boolean;
  waitingFor: Map<string, BoardWaiting>; changed: boolean; fresh: boolean;
  requestAgent?: BoardThread;
}) {
  const status = standing(thread, waiting);
  const relevantAgents = agents.filter(agent => matches(agent) || agent.id === place.thread);
  const [agentLimit, setAgentLimit] = useState(CARD_PAGE);
  useEffect(() => setAgentLimit(CARD_PAGE), [place.q, place.tab, place.computer]);
  const agentRequests = agents.filter(agent => standing(agent, waitingFor.get(agent.id)) === "waiting").length;
  const action = waiting ? waiting.kind === "approval" ? "Review approval" : "Answer question"
    : status === "waiting" ? "Answer question" : thread.label === "Result ready" ? "Review result"
    : status === "failed" ? "View error" : status === "done" && !["Stopped", "Cancelled"].includes(thread.label) ? "Open result" : "View details";
  const summary = waiting?.text ?? thread.question ?? thread.now ?? firstLine(thread.ask);
  return <li data-card={thread.id} data-status={status} className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150")}>
    <Link href={place.href({ thread: thread.id })} scroll={false} aria-current={place.thread === thread.id ? "true" : undefined} className={cn(CARD, place.thread === thread.id && "ring-2 ring-ring")}>
      <div className="flex items-center justify-between gap-2 text-xs"><span className="min-w-0 truncate text-muted-foreground">{channel}</span>{changed && <span className="shrink-0 font-medium">New activity</span>}</div>
      <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-5 [overflow-wrap:anywhere]">{thread.title}</h3>
      {requestAgent && <p className="mt-2 text-xs font-medium text-warning [overflow-wrap:anywhere]">Decision needed by {requestAgent.title}</p>}
      <p className={cn("mt-2 line-clamp-3 min-h-5 text-sm text-muted-foreground [overflow-wrap:anywhere]", waiting?.command && "font-mono text-xs")} title={summary} data-line>{summary}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <State status={status} label={waiting ? undefined : thread.label} live={!ongoing(thread)} />
        {thread.inLine ? <span data-in-line>{thread.inLine === 1 ? "Next in line" : `${thread.inLine} in line`}</span> : null}
        {thread.nextAt && status !== "failed" ? <span data-next-run>Next in {ahead(thread.nextAt - Date.now())}</span> : null}
      </div>
      {thread.holder?.machine && <p className="mt-1 truncate text-xs text-muted-foreground">{actor(thread.holder)}</p>}
      {!matches(thread) && relevantAgents.length > 0 && <p className="mt-2 text-xs font-medium">Matching work in {relevantAgents.length === 1 ? "1 agent" : `${relevantAgents.length} agents`}</p>}
      <div className="mt-4 flex items-center justify-between gap-2 border-t pt-3 text-xs">
        <span className="inline-flex items-center gap-1 font-medium">{action}<ArrowUpRightIcon aria-hidden className="size-3.5" /></span>
        <span className="shrink-0 text-muted-foreground" data-age>{status === "working" && !ongoing(thread) ? <Ticking since={thread.startedAt} format={short} /> : <Age at={thread.updatedAt} />}</span>
      </div>
    </Link>
    {agents.length > 0 && <div className="mx-1 rounded-b-lg border border-t-0 bg-background px-3" data-agents={agents.length}>
      <button type="button" className="flex min-h-11 w-full items-center gap-1 text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded} onClick={toggle} data-agents-toggle>
        <ChevronRightIcon className={cn("size-3.5 shrink-0", expanded && "rotate-90")} aria-hidden /><span>{agentsWord(agents)}{agentRequests ? `, ${agentRequests} need you` : ""}</span>
      </button>
      {expanded && <ul aria-label={`Agents of ${thread.title}`} className="pb-2" data-agent-rows>
        {relevantAgents.slice(0, agentLimit).map(agent => <li key={agent.id} data-agent data-row={agent.id}>
          <Link href={place.href({ thread: agent.id })} scroll={false} aria-current={place.thread === agent.id ? "true" : undefined} className="flex min-h-11 flex-col gap-1 rounded-md border-t px-1 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <span className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">{agent.title}</span><State status={standing(agent, waitingFor.get(agent.id))} label={waitingFor.has(agent.id) ? undefined : agent.label} className="text-xs" />
            {waitingFor.has(agent.id) && <span className="text-xs font-medium">{waitingFor.get(agent.id)?.kind === "approval" ? "Review approval" : "Answer question"}</span>}
          </Link>
        </li>)}
        {relevantAgents.length > agentLimit && <li><button type="button" className="min-h-11 text-xs underline" onClick={() => setAgentLimit(current => current + CARD_PAGE)}>Show more agents</button></li>}
        {relevantAgents.length === 0 && <li className="py-2 text-xs text-muted-foreground">No agents match these filters.</li>}
      </ul>}
    </div>}
  </li>;
}

/** A row's columns: state, title, channel and age; the channel only where the list is wide enough for it. */
const ROW = "grid grid-cols-[6rem_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 border-b border-border/50 px-4 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[36rem]:grid-cols-[7.5rem_minmax(0,1fr)_auto_auto]";

/** A command or a question waiting on the owner, as line 2 says it: a command on one line, as code. */
function Wants({ item }: { item: BoardWaiting }) {
  return item.command
    ? <code className="inline-block max-w-full truncate rounded bg-muted px-1.5 align-bottom text-[12px]" title={item.text} data-command>{item.text}</code>
    : <span className="block truncate" title={item.text}>{item.text}</span>;
}

function ThreadRow({ thread, href, selected, waiting, notice, channel, fresh, changed, agents, expanded = false, onToggle, agentHref, openThread }: {
  thread: BoardThread; href: string; selected: boolean; waiting?: BoardWaiting; notice?: Notice; channel: string; fresh: boolean; changed: boolean;
  /** The sub-agents its turns started, listed under it; open or closed by its toggle. */
  agents?: BoardThread[]; expanded?: boolean; onToggle?: () => void; agentHref?: (id: string) => string; openThread?: string | null;
}) {
  const status = standing(thread, waiting);
  const line: ReactNode = waiting ? <Wants item={waiting} />
    : notice ? <span className="block truncate">{firstLine(notice.text)}</span>
    : thread.status === "working" && !ongoing(thread) ? <span className="block truncate"><span className="font-mono">{actor(thread.holder)}</span>{thread.now ? ` · ${thread.now}` : ""}</span>
      : thread.now ? <span className="block truncate">{thread.status === "blocked" && thread.label.length > 12 ? `${thread.label.toLowerCase()} · ${thread.now}` : thread.now}</span> : null;
  return (
    <li data-row={thread.id} data-status={status} className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
      <Link href={href} scroll={false} aria-current={selected ? "true" : undefined} className={cn(ROW, selected && "bg-muted")}>
        <State status={status} label={waiting ? undefined : thread.label} live={!ongoing(thread)} className="text-xs" />
        <span className={cn("line-clamp-2 [overflow-wrap:anywhere]", changed ? "font-semibold" : "font-medium")}>{thread.title}</span>
        {/* Inside a channel every row is in it: the column stays, empty, so the rows still line up. */}
        <span className="truncate font-mono text-[12px] text-muted-foreground @max-[36rem]:hidden">{channel && channel}</span>
        <span className="justify-self-end font-mono text-[12px] text-muted-foreground" data-age>
          {waiting ? <Age at={thread.updatedAt} />
            : thread.inLine ? <span data-in-line>{thread.inLine === 1 ? "next" : `${thread.inLine} in line`}</span>
              // A schedule that failed says so first, and when: its next run is in its pane, not competing with the failure.
              : thread.nextAt && thread.status !== "failed" ? <span data-next-run title={new Date(thread.nextAt).toLocaleString()}>next {ahead(thread.nextAt - Date.now())}</span>
                : thread.status === "working" && !ongoing(thread) ? <Ticking since={thread.startedAt} format={short} /> : <Age at={thread.updatedAt} />}
        </span>
        {line && <span className="col-start-2 col-end-[-1] min-w-0 text-[12px] text-muted-foreground" data-line>{line}</span>}
      </Link>
      {agents && agents.length > 0 && <Agents agents={agents} expanded={expanded} onToggle={onToggle!} href={agentHref!} open={openThread ?? null} parent={thread.title} />}
    </li>
  );
}

/** "3 agents · 2 running": how a parent's sub-agents stand, in a few words. */
function agentsWord(agents: BoardThread[]) {
  const running = agents.filter((agent) => agent.status === "working").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  return [agents.length === 1 ? "1 agent" : `${agents.length} agents`, running ? `${running} running` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
}

/**
 * A parent's sub-agents: a toggle under its row saying how they stand, and when open, a row each, nested under it,
 * with its own state, title, holder while it runs, and how long it has run or took.
 */
function Agents({ agents, expanded, onToggle, href, open, parent }: {
  agents: BoardThread[]; expanded: boolean; onToggle: () => void; href: (id: string) => string; open: string | null; parent: string;
}) {
  const running = agents.some((agent) => agent.status === "working");
  return (
    <div data-agents={agents.length}>
      <div className="grid grid-cols-[0.875rem_minmax(0,1fr)] gap-x-2.5 px-4 @min-[36rem]:grid-cols-[7.5rem_minmax(0,1fr)] @min-[36rem]:gap-x-3">
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={`${agentsWord(agents)}, under ${parent}`}
          className="col-start-2 -mt-1 mb-1 inline-flex w-fit items-center gap-1 rounded-sm text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50" data-agents-toggle>
          <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none", expanded && "rotate-90")} />
          <span className={cn(running && "text-foreground")}>{agentsWord(agents)}</span>
        </button>
      </div>
      {expanded && (
        <ul aria-label={`Agents of ${parent}`} className="pb-1" data-agent-rows>
          {agents.map((agent) => (
            <li key={agent.id} data-row={agent.id} data-status={agent.status} data-agent>
              <Link href={href(agent.id)} scroll={false} aria-current={open === agent.id ? "true" : undefined} className={cn(ROW, "py-1", open === agent.id && "bg-muted")}>
                <State status={agent.status} label={agent.label} compact />
                <span className="flex min-w-0 items-baseline gap-1.5 pl-4">
                  <span aria-hidden className="font-mono text-[12px] text-muted-foreground/70">└</span>
                  <span className="truncate">{agent.title}</span>
                </span>
                <span className="@max-[36rem]:hidden" />
                <span className="justify-self-end font-mono text-[12px] text-muted-foreground" data-age>
                  {agent.status === "working" ? <Ticking since={agent.startedAt} format={short} /> : agent.finishedAt !== undefined ? short(agent.finishedAt - agent.startedAt) : <Age at={agent.updatedAt} />}
                </span>
                {(agent.status === "working" || agent.now) && (
                  <span className="col-start-2 col-end-[-1] min-w-0 truncate pl-[2.125rem] text-[12px] text-muted-foreground" data-line>
                    {agent.status === "working" && <span className="font-mono">{agentHolder(agent.holder)}</span>}
                    {agent.status === "working" && agent.now ? " · " : ""}{agent.now}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A sub-agent's holder as a row says it: its model, else its engine, and its computer. */
const agentHolder = (holder?: BoardHolder) => [holder?.model ?? holder?.engine, holder?.machine].filter(Boolean).join(" via ");

/** An approval whose chat has no thread on the board: a row of its own, opening to a pane where it is answered. */
function WaitingRow({ item, href, selected, fresh }: { item: BoardWaiting; href: string; selected: boolean; fresh: boolean }) {
  return (
    <li data-row={item.id} data-status="waiting" className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
      <Link href={href} scroll={false} aria-current={selected ? "true" : undefined} className={cn(ROW, selected && "bg-muted")}>
        <State status="waiting" className="text-xs" />
        <span className="truncate font-medium">{item.where ?? (item.kind === "question" ? "Question in chat" : "approval")}</span>
        <span className="font-mono text-[12px] text-muted-foreground @max-[36rem]:hidden">{item.kind}</span>
        <span className="justify-self-end font-mono text-[12px] text-muted-foreground"><Age at={item.at} /></span>
        <span className="col-start-2 col-end-[-1] min-w-0 text-[12px] text-muted-foreground" data-line><Wants item={item} /></span>
      </Link>
    </li>
  );
}

const STRAY: Partial<Record<InboxItem["kind"], string>> = { delivery: "delivery" };

const updateId = (item: Notice) => `update:${item.kind}:${item.id}`;

/** News stays readable without claiming the owner must make a decision. */
function UpdateRow({ item, href, selected }: { item: Notice; href: string; selected: boolean }) {
  return (
    <li data-row={updateId(item)} data-update-row className={cn("flex items-center", selected && "bg-muted")}>
      <Link href={href} scroll={false} aria-current={selected ? "true" : undefined} className={cn(ROW, "min-w-0 flex-1")}>
        <span className="flex items-center gap-1.5 text-muted-foreground"><CircleIcon className="size-3.5 shrink-0" aria-hidden /><span className="@max-[36rem]:sr-only">update</span></span>
        <span className="truncate font-medium">{item.title}</span>
        <span className="font-mono text-[12px] text-muted-foreground @max-[36rem]:hidden">{STRAY[item.kind] ?? "update"}</span>
        <span className="justify-self-end font-mono text-[12px] text-muted-foreground"><Age at={item.at} /></span>
        <span className="col-start-2 col-end-[-1] min-w-0 truncate text-[12px] text-muted-foreground" data-line>{firstLine(item.text)}</span>
      </Link>
      <MarkUpdateRead notice={item} className="mr-3 min-h-11 shrink-0" />
    </li>
  );
}

function UpdatePane({ id, notices, close }: { id: string; notices?: Notice[]; close: string }) {
  const notice = notices?.find(item => updateId(item) === id);
  const thread = notice && noticeThread(notice);
  const chat = notice && "chatId" in notice && notice.chatId;
  return <article aria-label="Update" className="flex min-h-0 flex-1 flex-col" data-pane={id}>
    <div className={HEADER}>
      <h2 className="min-w-0 flex-1 truncate font-semibold">Update</h2>
      <Button variant="ghost" size="icon-sm" aria-label="Close" render={<Link href={close} scroll={false} />}><XIcon /></Button>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {notices === undefined ? <Skeleton className="h-24" /> : !notice ? <p role="status" className="text-muted-foreground">This update was marked read or is no longer available.</p> : <>
        <div><h3 className="font-medium">{notice.title}</h3><p className="mt-1 text-[12px] text-muted-foreground">For your information. No decision is waiting here.</p></div>
        <Markdown text={notice.text} />
        <div className="flex flex-wrap gap-2">
          <MarkUpdateRead notice={notice} />
          {thread && <Button variant="outline" render={<Link href={`/board?thread=${encodeURIComponent(thread)}`} />}>Open related work</Button>}
          {chat && <Button variant="outline" render={<Link href={`/chat/${chat}`} />}>Open chat</Button>}
          {notice.kind === "watch" && <Button variant="outline" render={<a href={notice.url} target="_blank" rel="noopener noreferrer" />}>Open page</Button>}
          {notice.kind === "delivery" && <Button variant="outline" render={<Link href="/settings/notifications" />}>Notification settings</Button>}
        </div>
        {notice.kind === "delivery" && <p className="text-[12px] text-muted-foreground">Marking this read does not resend the message. Check the destination before sending again.</p>}
      </>}
    </div>
  </article>;
}

const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim() ?? "";

function Age({ at }: { at: number }) {
  const now = useNow(15_000);
  return <time dateTime={new Date(at).toISOString()} className="nums">{short(now - at)}</time>;
}

// --- Activity: one entry per thread, its latest event, newest at the bottom --------------------------------------


function Activity({ board, place, channel }: { board?: BoardView; place: ReturnType<typeof useAddress>; channel?: Channel }) {
  const threads = useMemo(() => new Map(board?.threads.map((thread) => [thread.id, thread])), [board]);
  // Each thread once, by its latest event; an approval with no thread is its own entry.
  const entries = useMemo(() => {
    const latest = new Map<string, BoardEvent>();
    for (const event of board?.events ?? []) {
      const key = event.thread ?? event.id;
      if ((latest.get(key)?.at ?? -1) < event.at) latest.set(key, event);
    }
    return [...latest.values()].filter((event) => {
      const thread = event.thread ? threads.get(event.thread) : undefined;
      if (channel && !(thread && channel.has(thread))) return false;
      if (place.computer && (event.machine ?? thread?.holder?.machine) !== place.computer) return false;
      if (!searchText(place.q, `${event.text ?? ""} ${event.agent?.title ?? ""} ${thread ? [thread.title, thread.ask, thread.now, thread.holder?.engine, thread.holder?.model, thread.holder?.machine].filter(Boolean).join(" ") : ""}`)) return false;
      return true;
    }).sort((a, b) => a.at - b.at).slice(-ACTIVITY);
  }, [board, threads, channel, place.computer, place.q]);
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  // The newest is at the bottom, as the viewer has it: start there, and stay there while you are.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && atEnd.current) node.scrollTop = node.scrollHeight;
  }, [entries.length, entries.at(-1)?.id]);
  const fresh = useArrivals(board ? entries.map((event) => event.id) : undefined);
  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      onScroll={(event) => { const node = event.currentTarget; atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>
      <div className="flex-1" />
      {!board && <div className="space-y-3 p-4" role="status" aria-label="Loading">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-12" />)}</div>}
      {board && entries.length === 0 && <p className="px-4 py-3 text-muted-foreground" data-empty>nothing here</p>}
      <ol aria-label="Activity" aria-live="polite" aria-relevant="additions" className="pb-3" data-activity>
        {entries.map((event) => {
          const thread = event.thread ? threads.get(event.thread) : undefined;
          const by = event.verb === "queued" || event.verb === "fired" || !thread?.holder ? "perry" : actor({ ...thread.holder, ...(event.machine ? { machine: event.machine } : {}) });
          const target = thread ? place.href({ thread: thread.id }) : event.href;
          const status = thread?.status ?? (event.status ?? "waiting");
          // What it says now: the approval's command, else its thread's line, else what the event said.
          // A sub-agent's event says which agent and what it did; anything else, what its thread says now.
          const detail = event.agent ? `agent ${event.agent.title} ${event.verb === "started" ? "started" : event.verb}`
            : event.verb === "approval" || thread?.kind === "agent" && event.text ? event.text : thread?.now ?? (event.text !== thread?.title ? event.text : undefined);
          return (
            <li key={event.id} data-entry={event.thread ?? event.id} data-event={event.verb} className={cn(fresh(event.id) && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
              {(event === entries[0] || dayOf(entries[entries.indexOf(event) - 1].at) !== dayOf(event.at)) && <Divider>{dayOf(event.at)}</Divider>}
              <Message who={by} at={event.at} where={thread ? channelName(thread, board!.projects) : undefined} href={target} engine={by === "perry" ? undefined : thread?.holder?.engine}>
                <p className="truncate">{thread?.title ?? event.text}</p>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground" data-line>
                  <State status={status} label={thread?.label} live={!thread || !ongoing(thread)} className="shrink-0 text-foreground/80" />
                  {detail && <span className="min-w-0 truncate">· {event.verb === "approval" ? <code className="rounded bg-muted px-1">{detail}</code> : detail}</span>}
                </p>
              </Message>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A day's divider, as the viewer draws one. */
function Divider({ children }: { children: ReactNode }) {
  return <p className="mx-4 my-2 flex items-center gap-3 text-[11px] text-muted-foreground after:h-px after:flex-1 after:bg-border">{children}</p>;
}

/** A message, as the viewer shows one: a square avatar, who and where, how long ago, and what was said. */
function Message({ who, at, where, href, engine, children }: { who: string; at: number; where?: string; href?: string; engine?: BoardHolder["engine"]; children: ReactNode }) {
  const head = (
    <p className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate font-mono text-[12px] font-semibold">{who}</span>
      {where && <span className="shrink-0 text-[12px] text-muted-foreground">in <span className="font-mono">#{where}</span></span>}
      <span className="shrink-0 font-mono text-[12px] text-muted-foreground"><Age at={at} /></span>
    </p>
  );
  const body = (
    <>
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded bg-muted text-[11px] font-semibold text-muted-foreground uppercase">
        {engine ? <ProviderIcon engine={engine} className="size-3.5" /> : who.charAt(0)}
      </span>
      <div className="min-w-0 flex-1">{head}{children}</div>
    </>
  );
  const className = "flex gap-2.5 px-4 py-1.5 outline-none";
  return href ? <Link href={href} scroll={false} className={cn(className, "hover:bg-muted/60 focus-visible:bg-muted")}>{body}</Link> : <div className={className}>{body}</div>;
}

// --- The thread pane ----------------------------------------------------------------------------------------------

const NOUN: Record<BoardThread["kind"], string> = { chat: "chat", task: "task", job: "job", heartbeat: "heartbeat", watch: "watch", goal: "goal", agent: "agent" };

/** One thread, as the viewer's pane has it: its state and outcome on top with what you can do, then the conversation. */
function Pane({ id, close, projects, notice, onSeen, overlay, place }: {
  id: string; close: string; projects: BoardView["projects"]; notice?: Notice; onSeen: (thread: BoardThread) => void; overlay: boolean;
  /** The address of another thread on the board, opened in this pane. */
  place: (thread: string) => string;
}) {
  const { dashboardKey } = useSession();
  const view = useQuery(api.board.thread, { key: dashboardKey, id });
  const thread = view?.thread;
  const task = view?.task;
  useEffect(() => { if (thread) onSeen(thread); }, [thread, onSeen]);
  const closer = (
    <Button variant="ghost" size="icon-sm" className="-mr-1.5 text-muted-foreground" aria-label="Close" render={<Link href={close} scroll={false} />}><XIcon /></Button>
  );
  if (view === undefined) return <><div className={HEADER}><span className="flex-1" />{closer}</div><div className="space-y-2 p-4" role="status" aria-label="Loading"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div></>;
  if (!view || !thread) return <><div className={HEADER}><span className="flex-1" />{closer}</div><p className="p-4 text-muted-foreground">this thread is gone</p></>;

  const runs = view.feed.filter((item) => item.kind === "run");
  const asking = view.feed.find((item) => item.kind === "approval" || item.kind === "question") as Extract<FeedItem, { kind: "approval" | "question" }> | undefined;
  // How it ended last: a job that failed and then went through shows the result, not the old error.
  const outcome = [...view.feed].reverse().find((item) => item.kind === "result" || item.kind === "error") as Extract<FeedItem, { kind: "result" | "error" }> | undefined;
  const result = outcome?.kind === "result" ? outcome : undefined;
  const error = outcome?.kind === "error" ? outcome : undefined;
  const status = asking?.kind === "approval" || asking?.kind === "question" && thread.status === "waiting" ? "waiting" : thread.status;
  // A sub-agent was asked by the turn that started it; a chat or task by you; the rest by Perry.
  const rootBy = thread.kind === "agent" ? actor(view.parent?.holder) : thread.kind === "chat" || thread.kind === "task" ? "you" : "perry";
  const said = view.feed.filter((item) => item.kind === "said" || item.kind === "update");
  // A saved checklist describes reported progress; only a live worker can be in progress now.
  const ended = thread.status === "done" || thread.status === "failed";
  const conversation = thread.kind !== "goal";
  const steerable = task?.status === "running" && thread.canSteer ? task : undefined;

  return (
    <article aria-labelledby="pane-title" className="flex min-h-0 flex-1 flex-col" data-pane={thread.id}>
      <div className={HEADER}>
        <h2 id="pane-title" className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{NOUN[thread.kind]}</span> <span className="text-[12px] text-muted-foreground">in #{channelName(thread, projects)}</span>
          {overlay && <span className="sr-only">: {thread.title}</span>}
        </h2>
        {closer}
      </div>

      {/* One scroll: the state block, then the conversation right under it, newest at the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <section aria-label="State" className="space-y-2.5 border-b px-4 py-3" data-task-block>
        <p className="font-semibold [overflow-wrap:anywhere]" data-title>{thread.title}</p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px]">
          <State status={status} label={status === thread.status ? thread.label : undefined} live={!ongoing(thread)} className="font-semibold" />
          {thread.holder && status === "working" && !ongoing(thread) && <span className="text-muted-foreground" data-holder>· by <span className="font-mono">{holderWords(thread.holder)}</span> · <Ticking since={thread.startedAt} className="font-mono" /></span>}
          {thread.holder && !going(thread.status) && thread.finishedAt !== undefined && <span className="text-muted-foreground" data-holder>· <span className="font-mono">{holderWords(thread.holder)}</span> · took <span className="font-mono">{span(thread.finishedAt - thread.startedAt)}</span></span>}
        </p>
        {task?.status === "running" && !thread.canSteer && thread.now && <p className="text-[12px] text-muted-foreground" data-task-presence>{thread.now}</p>}
        {thread.sourceChatId && <Button size="sm" variant="outline" render={<Link href={`/chat/${thread.sourceChatId}`} />}>open source chat</Button>}
        <ThreadActions thread={thread} task={task} question={asking?.kind === "question" ? asking.text : undefined} approval={asking?.kind === "approval" ? asking.id : undefined} notice={notice} shown={[error?.text, result?.text]}
          fields={<>
            {!!thread.dependencies?.length && <Field label="waits for"><ul className="space-y-1" data-task-dependencies>{thread.dependencies.map(dependency => <li key={dependency.id} className="flex items-baseline gap-2">
              {dependency.status === "missing" ? <span>{dependency.title}</span> : <Link href={place(`task:${dependency.id}`)} scroll={false} className="min-w-0 flex-1 truncate underline underline-offset-4">{dependency.title}</Link>}
              <span className={cn("shrink-0 text-muted-foreground", (dependency.status === "failed" || dependency.status === "cancelled" || dependency.status === "missing") && "text-warning")}>{dependency.status}</span>
            </li>)}</ul></Field>}
            {error && <Field label="reason"><span className="whitespace-pre-wrap">{error.text}</span></Field>}
            {error?.step && <Field label="last step"><span data-last-step>{error.step}</span></Field>}
            {result && !error && <Field label={result.reply ? "reply" : "result"}><Clamp><div className="text-[13px] [&_.prose-chat]:text-[13px]"><Markdown text={result.text} /></div></Clamp></Field>}
            {view.parent && <Field label="part of"><Link href={place(view.parent.id)} scroll={false} className="underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground" data-parent-link>{view.parent.title}</Link></Field>}
            {view.agents && <Field label={view.agents.length === 1 ? "agent" : "agents"}>
              <ul className="space-y-0.5" data-pane-agents>
                {view.agents.map((agent) => (
                  <li key={agent.id} className="flex min-w-0 items-center gap-2">
                    <State status={agent.status} label={agent.label} compact className="shrink-0 [&>span]:sr-only" />
                    <Link href={place(agent.id)} scroll={false} className="min-w-0 truncate underline-offset-2 hover:underline">{agent.title}</Link>
                    <span className="ml-auto shrink-0 font-mono text-muted-foreground">{agent.status === "working" ? <Ticking since={agent.startedAt} format={short} /> : agent.finishedAt !== undefined ? short(agent.finishedAt - agent.startedAt) : null}</span>
                  </li>
                ))}
              </ul>
            </Field>}
            {view.plan && <Field label={thread.kind === "goal" ? `milestones ${view.plan.filter((step) => step.status === "done").length}/${view.plan.length}` : ended ? "plan" : `plan ${view.plan.filter((step) => step.status === "done").length}/${view.plan.length}`}><Plan steps={view.plan} running={thread.kind === "goal" || thread.status === "working"} /></Field>}
          </>} />
      </section>

      {conversation && <div className="flex flex-1 flex-col" data-conversation>
        <Divider>{dayOf(thread.startedAt)}</Divider>
        <Message who={rootBy} at={thread.startedAt} engine={thread.kind === "agent" ? view.parent?.holder?.engine : undefined}>
          <Clamp lines><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{thread.ask}</p></Clamp>
        </Message>
        {(runs.length > 0 || said.length > 0) && <Divider>{runs.length === 1 ? "1 turn" : `${runs.length} turns`}</Divider>}
        {/* A sub-agent's own: what it has written so far, live, and once over, its answer. */}
        {thread.kind === "agent" && (view.output || going(thread.status) || view.steps) && (
          <Message who={`sub-agent${thread.holder?.machine ? ` via ${thread.holder.machine}` : ""}`} at={thread.startedAt} engine={thread.holder?.engine}>
            {/* Its own steps (commands, searches, file changes), live, as a turn's; then what it wrote. */}
            {view.steps && <div className="text-[13px] [&_.prose-chat]:text-[13px] [&_[data-work-timeline]]:pt-0.5" data-agent-steps><RunSteps runIds={[view.steps.runId]} agent={view.steps.agent} live={going(thread.status)} /></div>}
            {view.output
              ? <div className="text-[13px] [&_.prose-chat]:text-[13px]" data-agent-output><Markdown text={view.output} streaming={thread.status === "working"} /></div>
              : <p className="text-muted-foreground">Working…</p>}
          </Message>
        )}
        <ol aria-label="Turns" className="pb-3" data-feed>
          {view.feed.map((item) => {
            if (item.kind === "run") {
              return (
                <li key={item.id} data-feed-run={item.status}>
                  <Message who={actor(item.holder)} at={item.at} engine={item.holder?.engine}>
                    {runs.length > 1 && item.status !== "done" && <State status={item.status} label={item.label} className="text-[12px]" />}
                    <div className="text-[13px] [&_.prose-chat]:text-[13px] [&_[data-work-timeline]]:pt-0.5"><RunSteps runIds={[item.runId]} live={going(item.status)} held={item.status === "waiting"} unresponsive={item.label === "Computer not responding"} omitText={item.omit} /></div>
                    {item.route && <details className="mt-2 text-[12px]" data-route>
                      <summary className="min-h-11 cursor-pointer rounded-sm py-3 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2">Engine, model and thinking</summary>
                      <div className="space-y-1 pb-2 [overflow-wrap:anywhere]">
                        <p>{routeLabel(item.route)} <span className="text-muted-foreground">· {item.route.tier} tier</span></p>
                        <p className="text-muted-foreground">{PICKED_BY[item.route.by]}. {item.route.why}{item.route.retried ? " This run recovered from a usage limit." : ""}</p>
                      </div>
                    </details>}
                  </Message>
                </li>
              );
            }
            if (item.kind === "said") return <li key={item.id}><Message who="you" at={item.at}><p className="whitespace-pre-wrap">{item.text}</p></Message></li>;
            if (item.kind === "update") return <li key={item.id}><Message who="perry" at={item.at}><p className="whitespace-pre-wrap">{item.text}</p></Message></li>;
            return null;
          })}
        </ol>
        {/* A running task's composer, as a thread's: what to change while it works (Work's update box). */}
        {steerable && <div className="sticky bottom-0 mt-auto border-t bg-background px-4 py-2.5" data-composer><TaskSteering task={steerable} compact /></div>}
      </div>}
      </div>
    </article>
  );
}

/** An approval whose chat has no thread on the board, answered in a pane of its own. */
function ApprovalPane({ id, close }: { id: string; close: string }) {
  const { dashboardKey } = useSession();
  const selected = useQuery(api.approvals.active, { key: dashboardKey, id: id.slice("approval:".length) });
  const now = useNow(1_000);
  const approval = selected && selected.expiresAt > now ? selected : null;
  return (
    <article aria-label="Approval" className="flex min-h-0 flex-1 flex-col" data-pane={id}>
      <div className={HEADER}>
        <h2 className="min-w-0 flex-1 truncate font-semibold">approval</h2>
        <Button variant="ghost" size="icon-sm" className="-mr-1.5 text-muted-foreground" aria-label="Close" render={<Link href={close} scroll={false} />}><XIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selected === undefined ? <Skeleton className="h-24" />
          : approval ? <div className="text-[13px] [&_pre]:px-2.5 [&_pre]:py-2 [&_pre]:text-[13px] [&_pre]:[overflow-wrap:normal]"><ApprovalCard approval={approval} now={now} bare /></div>
            : <p className="px-1 text-muted-foreground">That approval was answered or has expired.</p>}
      </div>
    </article>
  );
}

const holderWords = (holder: BoardHolder) => [holder.engine && ENGINE_LABELS[holder.engine].toLowerCase(), holder.model].filter(Boolean).join(" · ") + (holder.machine ? ` via ${holder.machine}` : "");
const dayOf = (at: number) => {
  const day = new Date(at).toDateString();
  return day === new Date().toDateString() ? "today" : day === new Date(Date.now() - 86_400_000).toDateString() ? "yesterday" : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

type BoardViewPlan = ThreadView["plan"];
const STEP: Record<NonNullable<BoardViewPlan>[number]["status"], { glyph: LucideIcon; word: string }> = {
  pending: { glyph: CircleIcon, word: "pending" }, active: { glyph: CircleDotIcon, word: "in progress" }, done: { glyph: CircleCheckIcon, word: "done" }, skipped: { glyph: CircleDashedIcon, word: "skipped" },
};

/** Preserve reported steps without presenting an old active marker as a live worker. */
function Plan({ steps, running }: { steps: NonNullable<BoardViewPlan>; running: boolean }) {
  return (
    <div>
      {!running && steps.some(step => step.status === "active" || step.status === "pending") && <p className="mb-1 text-muted-foreground" data-plan-recorded>Last recorded checklist. Unchecked steps have not been confirmed.</p>}
      <ol className="space-y-0.5" data-plan>
        {steps.map((step, index) => {
          const shown = !running && (step.status === "active" || step.status === "pending") ? "unconfirmed" : step.status;
          const { glyph: Glyph, word } = shown === "unconfirmed" ? { glyph: CircleIcon, word: "not confirmed" } : STEP[step.status];
          return (
            <li key={index} data-step={shown} className={cn("flex items-start gap-1.5", shown === "active" ? "text-foreground" : "text-muted-foreground", step.status === "skipped" && "line-through")}>
              <Glyph aria-hidden className="mt-[3px] size-3.5 shrink-0" /><span className="sr-only">{word}: </span><span className="min-w-0">{step.title}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd></>;
}

/** Long text, a few lines with the rest a click away. */
function Clamp({ children, lines = false }: { children: ReactNode; lines?: boolean }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = box.current; if (node) setLong(node.scrollHeight > node.clientHeight + 2); }, [children]);
  return (
    <div>
      <div ref={box} className={cn(!open && (lines ? "max-h-[7.5rem]" : "max-h-40"), "overflow-hidden")}>{children}</div>
      {(long || open) && <button type="button" className="mt-0.5 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "show less" : "show all"}</button>}
    </div>
  );
}
