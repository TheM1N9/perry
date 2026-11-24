"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleIcon, CircleMinusIcon, CirclePauseIcon, CircleSlashIcon, CircleXIcon, ChevronDownIcon, ListFilterIcon,
  ChevronRightIcon, SearchIcon, XIcon, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useConnection, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { BoardEvent, BoardHolder, BoardStatus, BoardThread, BoardView, BoardWaiting, FeedItem, ThreadView } from "@/convex/board";
import type { InboxItem } from "@/convex/dashboard";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { tickText, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { ProviderIcon } from "../provider-icon";
import { Markdown } from "../chat/markdown";
import { RunSteps } from "../chat/work";
import { ApprovalCard } from "../approval-card";
import { TaskSteering } from "../task-steering";
import { BoardPause } from "../pause";
import { ChannelActions, noticeThread, ThreadActions, type Notice } from "./board-actions";

/*
 * The Board (issue #363), laid out as Vercel Board's own viewer is: a nav of views and channels, the list, and the
 * open thread in a pane beside it (over it on a narrow screen). Flat, one state glyph per item, each item once. It
 * holds what Work and Needs you were: their channels, editing (board-actions.tsx) and what waits on the owner. Text is
 * Perry's own type; ids, channels, times, computers and commands are monospace, as the viewer sets them.
 */

/** Rows drawn at a time; the rest are a click away. */
const PAGE = 60;
/** Activity entries drawn: the latest, newest at the bottom. */
const ACTIVITY = 60;
/** Wide enough for the nav, the list and the pane side by side. */
const WIDE = "(min-width: 1100px)";

// --- State: one glyph and word, everywhere ---------------------------------------------------------------------

const GLYPH: Record<BoardStatus, LucideIcon> = {
  queued: CircleIcon, blocked: CircleDashedIcon, working: CircleDotIcon, waiting: CirclePauseIcon, done: CircleCheckIcon, failed: CircleXIcon,
};
/** Labels that share a status but not a meaning get a glyph of their own: paused is not done, stopped did not finish. */
const LABEL_GLYPH: Record<string, LucideIcon> = { paused: CircleMinusIcon, stopped: CircleSlashIcon, cancelled: CircleSlashIcon };
const WORD: Record<BoardStatus, string> = { queued: "queued", blocked: "waiting", working: "working", waiting: "needs you", done: "done", failed: "failed" };
const TONE: Partial<Record<BoardStatus, string>> = { waiting: "text-warning", failed: "text-destructive" };
/** A label short enough for the state column says more than the bare state ("paused", "stopped"); a longer one goes on line 2. */
const wordOf = (status: BoardStatus, label?: string) => label && label.length <= 10 ? label.toLowerCase() : WORD[status];

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

/** The view of everything on the board, named apart from #tasks (the background tasks' channel). */
const ALL_WORK = "all work";

// --- Channels: as the viewer lists them, grouped -----------------------------------------------------------------

type Channel = { id: string; name: string; group?: string; has: (thread: BoardThread) => boolean };
const KIND_CHANNELS: Channel[] = [
  { id: "chats", name: "chats", has: (thread) => thread.kind === "chat" },
  { id: "tasks", name: "tasks", group: "work", has: (thread) => thread.kind === "task" },
  { id: "jobs", name: "jobs", group: "work", has: (thread) => thread.kind === "job" },
  { id: "heartbeat", name: "heartbeat", group: "work", has: (thread) => thread.kind === "heartbeat" },
  { id: "watches", name: "watches", group: "work", has: (thread) => thread.kind === "watch" },
  { id: "goals", name: "goals", group: "work", has: (thread) => thread.kind === "goal" },
];
const slug = (name: string) => name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "project";
/** The channel a thread is shown in: its project's, else its kind's. */
function channelName(thread: BoardThread, projects: BoardView["projects"]): string {
  const project = thread.projectId && projects.find((item) => item.id === thread.projectId);
  if (project) return slug(project.name);
  // A sub-agent is in its parent's: a chat turn's, a task's or a schedule's.
  if (thread.parent) return thread.parent.startsWith("task:") ? "tasks" : thread.parent.startsWith("job:") ? "jobs" : "chats";
  return KIND_CHANNELS.find((channel) => channel.has(thread))?.name ?? "chats";
}

// --- Tabs: the states the list can be narrowed to ----------------------------------------------------------------

const TABS = ["open", "needs you", "working", "queued", "waiting", "done", "failed", "all"] as const;
type Tab = (typeof TABS)[number];
const TAB_STATUS: Partial<Record<Tab, BoardStatus>> = { "needs you": "waiting", working: "working", queued: "queued", waiting: "blocked", done: "done", failed: "failed" };
/** How a thread stands on the board: one with something waiting on the owner needs them, whatever its last turn did. */
const standing = (thread: BoardThread, waiting?: BoardWaiting): BoardStatus => waiting ? "waiting" : thread.status;
/** Ongoing rather than at work: a watch or a goal is always on, so it counts as open only in its own channel. */
const ongoing = (thread: BoardThread) => thread.kind === "watch" || thread.kind === "goal";
/** Open: not over. */
const isOpen = (status: BoardStatus, thread: BoardThread, channel?: string) => status !== "done" && status !== "failed" && (!ongoing(thread) || channel === (thread.kind === "watch" ? "watches" : "goals"));
const inTab = (status: BoardStatus, thread: BoardThread, tab: Tab, channel?: string, notice?: Notice) =>
  tab === "all" || (tab === "open" ? isOpen(status, thread, channel) : tab === "needs you" ? status === "waiting" || Boolean(notice) : status === TAB_STATUS[tab]);

// --- The address: view, channel, tab, open thread, computer ------------------------------------------------------

type Place = { view: "tasks" | "activity"; channel: string | null; tab: Tab | null; thread: string | null; computer: string | null; q: string | null; sort: "priority" | "updated" | "oldest" | null };
function useAddress() {
  const params = useSearchParams()!;
  const pathname = usePathname()!;
  const router = useRouter();
  const place: Place & { tab: Tab } = {
    view: params.get("view") === "activity" ? "activity" : "tasks",
    channel: params.get("channel"),
    tab: (TABS as readonly string[]).includes(params.get("tab") ?? "") ? params.get("tab") as Tab : "open",
    thread: params.get("thread"),
    computer: params.get("computer"),
    q: params.get("q"),
    sort: params.get("sort") === "updated" ? "updated" : params.get("sort") === "oldest" ? "oldest" : "priority",
  };
  const href = useCallback((next: Partial<Place>) => {
    const query = new URLSearchParams(params);
    for (const [name, value] of Object.entries(next)) {
      if (value && !(name === "view" && value === "tasks") && !(name === "tab" && value === "open") && !(name === "sort" && value === "priority")) query.set(name, value);
      else query.delete(name);
    }
    const search = query.toString();
    return search ? `${pathname}?${search}` : pathname;
  }, [params, pathname]);
  return { ...place, href, go: (next: Partial<Place>) => router.replace(href(next), { scroll: false }) };
}

function useWide() {
  return useSyncExternalStore(
    (change) => { const media = window.matchMedia(WIDE); media.addEventListener("change", change); return () => media.removeEventListener("change", change); },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
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
  const wide = useWide();
  const { unseen, mark } = useSeen(board?.threads);

  const channels = useMemo(() => {
    const projects = (board?.projects ?? [])
      .map((project): Channel => ({ id: `project:${project.id}`, name: slug(project.name), group: "projects", has: (thread) => thread.projectId === project.id }));
    return [...KIND_CHANNELS, ...projects];
  }, [board]);
  const channel = channels.find((item) => item.id === place.channel);
  /** Waiting items by the thread each holds up; one with no thread on the board is a row of its own. */
  const waitingFor = useMemo(() => new Map((board?.waiting ?? []).flatMap((item) => item.thread ? [[item.thread, item] as const] : [])), [board]);
  const loose = useMemo(() => (board?.waiting ?? []).filter((item) => !item.thread), [board]);
  /** What Needs you listed besides questions: a failure, a schedule's news, a watch that fired; each on its thread. */
  const notices = useMemo(() => (inbox ?? []).filter((item): item is Notice => item.kind !== "question"), [inbox]);
  const noticeFor = useMemo(() => new Map(notices.flatMap((item) => { const thread = noticeThread(item); return thread ? [[thread, item] as const] : []; })), [notices]);
  const strays = useMemo(() => notices.filter((item) => !noticeThread(item) || !board?.threads.some((thread) => thread.id === noticeThread(item))), [notices, board]);

  const dialog = useRef<HTMLDivElement>(null);
  // Over the board, focus moves into the open thread, so the keyboard starts where the eye is.
  useEffect(() => { if (place.thread && !wide) dialog.current?.focus(); }, [place.thread, wide]);
  const nav = <Nav board={board} channels={channels} place={place} unseen={unseen} />;
  const menu = <NavMenu channels={channels} place={place} />;
  const pane = !place.thread ? null : place.thread.startsWith("approval:")
    ? <ApprovalPane key={place.thread} id={place.thread} close={place.href({ thread: null })} />
    : <Pane key={place.thread} id={place.thread} close={place.href({ thread: null })} projects={board?.projects ?? []} notice={noticeFor.get(place.thread)} onSeen={mark} overlay={!wide} place={(thread) => place.href({ thread })} />;
  // Work running anywhere: what "pause all" stops.
  const busy = Boolean(board?.threads.some((thread) => !ongoing(thread) && (thread.status === "working" || thread.status === "queued" || thread.status === "waiting")));

  return (
    <div className="flex h-svh min-h-0 text-[13px] leading-5" data-board>
      {wide && <aside aria-label="Board" className="flex w-46 shrink-0 flex-col border-r">{nav}</aside>}
      {/* On a narrow screen the open thread covers the board, which is inert behind it until it closes. */}
      <main id="content" tabIndex={-1} inert={Boolean(pane && !wide) || undefined} className="@container flex min-w-0 flex-1 flex-col outline-none">
        <Header place={place} channel={channel} board={board} wide={wide} nav={menu}
          actions={<>
            <ChannelActions channel={channel?.id} needsYou={place.view === "tasks" && place.tab === "needs you"} notices={notices} compact={!wide} onCreated={id => place.go({ view: "tasks", channel: "tasks", tab: "all", thread: `task:${id}`, q: null, computer: null })} />
            <BoardPause active={busy} compact={!wide} />
          </>} />
        <SearchWork place={place} />
        {place.view === "tasks"
          ? <Tasks board={board} place={place} channel={channel} waitingFor={waitingFor} loose={loose} noticeFor={noticeFor} strays={strays} unseen={unseen} />
          : <Activity board={board} place={place} channel={channel} />}
      </main>
      {pane && wide && <aside aria-label="Thread" className="flex w-[min(440px,36vw)] shrink-0 flex-col border-l">{pane}</aside>}
      {pane && !wide && <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Thread" className="fixed outline-none inset-0 z-40 flex flex-col bg-background text-[13px] leading-5">{pane}</div>}
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

function SearchWork({ place }: { place: ReturnType<typeof useAddress> }) {
  const [draft, setDraft] = useState(place.q ?? "");
  useEffect(() => { setDraft(new URL(window.location.href).searchParams.get("q") ?? ""); }, [place.q]);
  const search = (value: string) => { setDraft(value); window.history.replaceState(null, "", place.href({ q: value || null })); };
  return <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2" data-board-search>
    <InputGroup className="h-9 max-w-xl flex-1">
      <InputGroupAddon><SearchIcon aria-hidden /></InputGroupAddon>
      <InputGroupInput type="search" aria-label="Search board" placeholder="Search tasks, chats, or agents..." value={draft} maxLength={200} onChange={event => search(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); search(""); } }} />
      {place.q && <InputGroupAddon align="inline-end"><InputGroupButton aria-label="Clear board search" size="icon-xs" onClick={() => search("")}><XIcon /></InputGroupButton></InputGroupAddon>}
    </InputGroup>
    {place.view === "tasks" && <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="shrink-0 text-xs" aria-label="Sort board" />}><ListFilterIcon />Sort</DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuRadioGroup value={place.sort ?? "priority"} onValueChange={value => place.go({ sort: value as Place["sort"] })}>
        <DropdownMenuRadioItem value="priority">Needs you first</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="updated">Recently updated</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup></DropdownMenuContent>
    </DropdownMenu>}
  </div>;
}

/** The views and channels, as the viewer's left column has them. On a narrow screen it is the title's menu. */
function Nav({ board, channels, place, unseen }: {
  board?: BoardView; channels: Channel[]; place: ReturnType<typeof useAddress>; unseen: (thread: BoardThread) => boolean;
}) {
  const online = board?.machines.filter((machine) => machine.online).length;
  const item = (active: boolean) => cn("flex h-7 items-center gap-2 rounded-md px-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50", active ? "bg-muted text-foreground" : "text-foreground/80");
  const groups = [...new Set(channels.map((channel) => channel.group ?? ""))];
  return (
    <>
      <div className={cn(HEADER, "gap-1 px-2")}>
        <SidebarTrigger className="text-muted-foreground" />
        <div className="min-w-0 leading-4">
          <p className="truncate font-medium">board</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{online === undefined ? " " : online === 1 ? "1 computer" : `${online} computers`}</p>
        </div>
      </div>
      <nav aria-label="Views and channels" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <Link href={place.href({ view: "activity", channel: null, tab: null, thread: place.thread })} scroll={false} className={item(place.view === "activity" && !place.channel)}
          aria-current={place.view === "activity" && !place.channel ? "page" : undefined}>activity</Link>
        <Link href={place.href({ view: "tasks", channel: null })} scroll={false} className={item(place.view === "tasks" && !place.channel)}
          aria-current={place.view === "tasks" && !place.channel ? "page" : undefined}>
          <span className="flex-1">{ALL_WORK}</span>
        </Link>
        <p className="mt-4 px-2 pb-1 text-[11px] text-muted-foreground">channels</p>
        {groups.map((group) => (
          <div key={group || "top"} className={cn(group && "mt-2")}>
            {group && <p className="px-2 pb-0.5 text-[11px] text-muted-foreground">{group}</p>}
            {channels.filter((channel) => (channel.group ?? "") === group).map((channel) => {
              const changed = board?.threads.some((thread) => channel.has(thread) && unseen(thread));
              return (
                <Link key={channel.id} href={place.href({ channel: channel.id })} scroll={false} className={item(place.channel === channel.id)} data-channel={channel.name}
                  aria-current={place.channel === channel.id ? "page" : undefined}>
                  <span className={cn("flex-1 truncate font-mono text-[12px]", changed && "font-semibold text-foreground")}>#{channel.name}</span>
                  {changed && <span className="size-1.5 rounded-full bg-foreground" role="img" aria-label="Changed since you looked" />}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}

/** The same views and channels as menu items, for a narrow screen's title. */
function NavMenu({ channels, place }: { channels: Channel[]; place: ReturnType<typeof useAddress> }) {
  const groups = [...new Set(channels.map((channel) => channel.group ?? ""))];
  return (
    <>
      <DropdownMenuItem render={<Link href={place.href({ view: "activity", channel: null, tab: null })} scroll={false} />}>activity</DropdownMenuItem>
      <DropdownMenuItem render={<Link href={place.href({ view: "tasks", channel: null })} scroll={false} />}>
        <span className="flex-1">{ALL_WORK}</span>
      </DropdownMenuItem>
      {groups.map((group) => (
        <DropdownMenuGroup key={group || "top"}>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px]">{group || "channels"}</DropdownMenuLabel>
          {channels.filter((channel) => (channel.group ?? "") === group).map((channel) => (
            <DropdownMenuItem key={channel.id} render={<Link href={place.href({ channel: channel.id })} scroll={false} />}><span className="font-mono text-[12px]">#{channel.name}</span></DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ))}
    </>
  );
}

/** The list's header: what it is, a word on its order, and on the right the filter and whether it is live. */
function Header({ place, channel, board, wide, nav, actions }: { place: ReturnType<typeof useAddress>; channel?: Channel; board?: BoardView; wide: boolean; nav: ReactNode; actions: ReactNode }) {
  const connection = useConnection();
  const title = channel ? `#${channel.name}` : place.view === "tasks" ? ALL_WORK : place.view;
  // A word on the order, where the view has one: the channel lists keep the board's own.
  const gloss = place.view === "activity" ? "the latest across every channel" : place.sort === "updated" ? "recently updated" : place.sort === "oldest" ? "oldest first" : channel ? undefined : "needs you first";
  const machines = board?.machines ?? [];
  return (
    <header className={HEADER}>
      {!wide && <SidebarTrigger className="-ml-1.5 text-muted-foreground" />}
      {wide ? <h1 className={cn("shrink-0 font-semibold", channel && "font-mono")}>{title}</h1> : (
        <DropdownMenu>
          <DropdownMenuTrigger className="flex min-w-0 shrink-0 items-center gap-1 rounded-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`${title}: choose a view or channel`}>
            <h1 className={cn(channel && "font-mono")}>{title}</h1><ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 text-[13px]">{nav}</DropdownMenuContent>
        </DropdownMenu>
      )}
      {gloss && <span className="min-w-0 truncate text-[12px] text-muted-foreground @max-[36rem]:hidden">{gloss}</span>}
      <span className="flex-1" />
      {actions}
      {machines.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={place.computer ? `Computer: ${place.computer}` : "Filter by computer"} className={cn("text-muted-foreground", place.computer && "text-foreground")} />}>
            <ListFilterIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 text-[13px]">
            <DropdownMenuGroup>
              <DropdownMenuLabel>computer</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={place.computer ?? ""} onValueChange={(value) => place.go({ computer: (value as string) || null })}>
                <DropdownMenuRadioItem value="">every computer</DropdownMenuRadioItem>
                {machines.map((machine) => <DropdownMenuRadioItem key={machine.name} value={machine.name}>{machine.name}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-muted-foreground" data-live={connection}>
        <span aria-hidden className={cn("size-1.5 rounded-full", connection === "connected" ? "bg-foreground" : "border border-muted-foreground")} />
        {connection === "connected" ? "live" : "reconnecting"}
      </span>
    </header>
  );
}

/** Whether a thread passes the computer filter: what holds it now, or held it last. */
const onComputer = (thread: BoardThread, computer: string | null) => !computer || thread.holder?.machine === computer;

function Tasks({ board, place, channel, waitingFor, loose, noticeFor, strays, unseen }: {
  board?: BoardView; place: ReturnType<typeof useAddress>; channel?: Channel; waitingFor: Map<string, BoardWaiting>; loose: BoardWaiting[];
  noticeFor: Map<string, Notice>; strays: Notice[]; unseen: (thread: BoardThread) => boolean;
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
  const matches = (thread: BoardThread, tab = place.tab) => inTab(standing(thread, waitingFor.get(thread.id)), thread, tab, channel?.id, noticeFor.get(thread.id))
    && onComputer(thread, place.computer) && matching.has(thread.id);
  // Opened or closed by hand; otherwise a parent is open while one of its agents runs, or one is the thread open.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const expanded = (thread: BoardThread) => toggled[thread.id]
    ?? Boolean(agentsOf.get(thread.id)?.some((agent) => agent.status === "working" || agent.id === place.thread || Boolean(place.q?.trim()) && matches(agent)));
  const toggle = (thread: BoardThread) => setToggled((current) => ({
    ...Object.fromEntries(Object.entries(current).filter(([id]) => agentsOf.has(id))), [thread.id]: !expanded(thread),
  }));
  const scoped = (board?.threads ?? []).filter(thread => !thread.parent && (!channel || channel.has(thread)));
  const threads = scoped.filter(thread => matches(thread) || Boolean(agentsOf.get(thread.id)?.some(agent => matches(agent))))
    // What needs the owner leads, whatever the order its threads came in.
    .sort((a, b) => place.sort === "updated" ? b.updatedAt - a.updatedAt : place.sort === "oldest" ? a.startedAt - b.startedAt : Number(Boolean(waitingFor.get(b.id))) - Number(Boolean(waitingFor.get(a.id))));
  const matchingLoose = !channel && !place.computer ? loose.filter(item => searchText(place.q, `${item.text} ${item.where ?? ""}`)) : [];
  const matchingStrays = !channel && !place.computer ? strays.filter(item => searchText(place.q, `${item.title} ${item.text}`)) : [];
  const looseShown = place.tab === "open" || place.tab === "needs you" || place.tab === "all" ? matchingLoose : [];
  const straysShown = place.tab === "needs you" || place.tab === "all" ? matchingStrays : [];
  const counts = Object.fromEntries(TABS.map(tab => [tab, scoped.filter(thread => matches(thread, tab) || agentsOf.get(thread.id)?.some(agent => matches(agent, tab))).length
    + (["open", "needs you", "all"].includes(tab) ? matchingLoose.length : 0) + (["needs you", "all"].includes(tab) ? matchingStrays.length : 0)]));
  // On a phone the tabs scroll sideways: the one chosen is kept in view, not left past the edge.
  const tabs = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = tabs.current;
    const active = nav?.querySelector<HTMLElement>("[aria-current=page]");
    if (!nav || !active) return;
    const reveal = () => active.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    nav.querySelectorAll("a").forEach(link => observer.observe(link));
    return () => observer.disconnect();
  }, [place.tab]);
  const fresh = useArrivals(board ? [...looseShown.map((item) => item.id), ...straysShown.map((item) => `${item.kind}:${item.id}`), ...threads.map((thread) => thread.id)] : undefined);
  return (
    <>
      {/* One line that scrolls sideways on a phone, inset like the rows under it. */}
      <nav ref={tabs} aria-label="States" className="relative flex shrink-0 scroll-px-4 gap-x-4 overflow-x-auto px-4 pt-2.5 [scrollbar-width:none]" data-tabs>
        {TABS.map((tab) => (
          <Link key={tab} href={place.href({ tab })} scroll={false} aria-current={place.tab === tab ? "page" : undefined}
            className={cn("flex shrink-0 items-baseline gap-1 border-b border-transparent pb-1.5 whitespace-nowrap outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              place.tab === tab ? "border-foreground text-foreground" : "text-muted-foreground")}>
            {tab}{board && counts[tab] > 0 && <span className={cn("nums font-mono text-[11px]", tab === "needs you" && "text-warning")} data-needs-you-tab={tab === "needs you" ? "" : undefined}>{counts[tab]}</span>}
          </Link>
        ))}
        {/* A scrolled row drops its end padding; this keeps the last tab inset from the edge as the first is. */}
        <span aria-hidden className="w-0 shrink-0" />
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
        {!board && <div className="space-y-3 px-4 py-2" role="status" aria-label="Loading">{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-9" />)}</div>}
        {board && threads.length + looseShown.length + straysShown.length === 0 && <div className="space-y-1 px-4 py-6 text-muted-foreground" data-empty>
          <p>{place.q?.trim() ? "No work matches your search." : "No work in this view."}</p>
          {place.q?.trim() ? <Link href={place.href({ q: null })} className="text-foreground underline underline-offset-4">Clear search</Link>
            : place.tab !== "all" ? <Link href={place.href({ tab: "all" })} className="text-foreground underline underline-offset-4">View all work</Link> : <p className="text-xs">Create a task above to give Perry something to work on.</p>}
        </div>}
        <ul aria-label="Threads" className="max-w-[54rem]" data-rows>
          {looseShown.map((item) => <WaitingRow key={item.id} item={item} href={place.href({ thread: item.id })} selected={place.thread === item.id} fresh={fresh(item.id)} />)}
          {threads.slice(0, shown).map((thread) => (
            <ThreadRow key={thread.id} thread={thread} href={place.href({ thread: thread.id })} selected={place.thread === thread.id} waiting={waitingFor.get(thread.id)}
              notice={place.tab === "needs you" ? noticeFor.get(thread.id) : undefined} channel={channel ? "" : channelName(thread, board!.projects)} fresh={fresh(thread.id)} changed={unseen(thread)}
              agents={agentsOf.get(thread.id)} expanded={expanded(thread)} onToggle={() => toggle(thread)} agentHref={(id) => place.href({ thread: id })} openThread={place.thread} />
          ))}
          {straysShown.map((item) => <StrayRow key={`${item.kind}:${item.id}`} item={item} fresh={fresh(`${item.kind}:${item.id}`)} />)}
        </ul>
        {threads.length > shown && <button type="button" className="mx-4 my-2 text-muted-foreground hover:text-foreground" onClick={() => setShown(shown + PAGE)}>show {Math.min(PAGE, threads.length - shown)} more</button>}
      </div>
    </>
  );
}

/** A row's columns: state, title, channel and age; the channel only where the list is wide enough for it. */
const ROW = "grid grid-cols-[0.875rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 px-4 py-1.5 outline-none hover:bg-muted/60 focus-visible:bg-muted @min-[36rem]:grid-cols-[7.5rem_minmax(0,1fr)_auto_auto] @min-[36rem]:gap-x-3";

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
      : thread.now ? <span className="block truncate">{thread.status === "blocked" && thread.label.length > 10 ? `${thread.label.toLowerCase()} · ${thread.now}` : thread.now}</span> : null;
  return (
    <li data-row={thread.id} data-status={status} className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
      <Link href={href} scroll={false} aria-current={selected ? "true" : undefined} className={cn(ROW, selected && "bg-muted")}>
        <State status={status} label={waiting ? undefined : thread.label} live={!ongoing(thread)} compact />
        <span className={cn("truncate", changed ? "font-semibold" : "font-medium")}>{thread.title}</span>
        {/* Inside a channel every row is in it: the column stays, empty, so the rows still line up. */}
        <span className="truncate font-mono text-[12px] text-muted-foreground @max-[36rem]:hidden">{channel && `#${channel}`}</span>
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
        <State status="waiting" compact />
        <span className="truncate font-medium">{item.where ?? "approval"}</span>
        <span className="font-mono text-[12px] text-muted-foreground @max-[36rem]:hidden">approval</span>
        <span className="justify-self-end font-mono text-[12px] text-muted-foreground"><Age at={item.at} /></span>
        <span className="col-start-2 col-end-[-1] min-w-0 text-[12px] text-muted-foreground" data-line><Wants item={item} /></span>
      </Link>
    </li>
  );
}

const STRAY: Partial<Record<InboxItem["kind"], string>> = { delivery: "delivery" };

/** Something Needs you listed with no thread on the board (a notification that did not arrive): a row that opens it. */
function StrayRow({ item, fresh }: { item: Notice; fresh: boolean }) {
  const href = item.kind === "delivery" ? (item.chatId ? `/chat/${item.chatId}` : "/settings/notifications") : item.kind === "watch" ? item.url : "chatId" in item && item.chatId ? `/chat/${item.chatId}` : "/board";
  return (
    <li data-row={`${item.kind}:${item.id}`} data-status="waiting" data-stray className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
      <Link href={href} className={ROW}>
        <State status="waiting" compact />
        <span className="truncate font-medium">{item.title}</span>
        <span className="font-mono text-[12px] text-muted-foreground @max-[36rem]:hidden">{STRAY[item.kind] ?? "update"}</span>
        <span className="justify-self-end font-mono text-[12px] text-muted-foreground"><Age at={item.at} /></span>
        <span className="col-start-2 col-end-[-1] min-w-0 truncate text-[12px] text-muted-foreground" data-line>{firstLine(item.text)}</span>
      </Link>
    </li>
  );
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
            : event.verb === "approval" ? event.text : thread?.now ?? (event.text !== thread?.title ? event.text : undefined);
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
  const status = asking ? "waiting" : thread.status;
  // A sub-agent was asked by the turn that started it; a chat or task by you; the rest by Perry.
  const rootBy = thread.kind === "agent" ? actor(view.parent?.holder) : thread.kind === "chat" || thread.kind === "task" ? "you" : "perry";
  const said = view.feed.filter((item) => item.kind === "said" || item.kind === "update");
  // A finished task's plan is as it was left: a step still marked under way was not finished, not in progress.
  const ended = thread.status === "done" || thread.status === "failed";
  const conversation = thread.kind !== "goal";
  const steerable = task?.status === "running" && task.conversationId && task.turns ? task : undefined;

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
          <State status={status} label={asking ? undefined : thread.label} live={!ongoing(thread)} className="font-semibold" />
          {thread.holder && status === "working" && !ongoing(thread) && <span className="text-muted-foreground" data-holder>· by <span className="font-mono">{holderWords(thread.holder)}</span> · <Ticking since={thread.startedAt} className="font-mono" /></span>}
          {thread.holder && !going(thread.status) && thread.finishedAt !== undefined && <span className="text-muted-foreground" data-holder>· <span className="font-mono">{holderWords(thread.holder)}</span> · took <span className="font-mono">{span(thread.finishedAt - thread.startedAt)}</span></span>}
        </p>
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
            {view.plan && <Field label={thread.kind === "goal" ? `milestones ${view.plan.filter((step) => step.status === "done").length}/${view.plan.length}` : ended ? "plan" : `plan ${view.plan.filter((step) => step.status === "done").length}/${view.plan.length}`}><Plan steps={view.plan} ended={ended} /></Field>}
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
                    <div className="text-[13px] [&_.prose-chat]:text-[13px] [&_[data-work-timeline]]:pt-0.5"><RunSteps runIds={[item.runId]} live={going(item.status)} held={item.status === "waiting"} unresponsive={item.status === "blocked"} omitText={item.omit} /></div>
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
  const approvals = useQuery(api.approvals.pending, { key: dashboardKey });
  const now = useNow(1_000);
  const approval = approvals?.find((item) => `approval:${item.id}` === id && item.expiresAt > now);
  return (
    <article aria-label="Approval" className="flex min-h-0 flex-1 flex-col" data-pane={id}>
      <div className={HEADER}>
        <h2 className="min-w-0 flex-1 truncate font-semibold">approval</h2>
        <Button variant="ghost" size="icon-sm" className="-mr-1.5 text-muted-foreground" aria-label="Close" render={<Link href={close} scroll={false} />}><XIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {approvals === undefined ? <Skeleton className="h-24" />
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

/** A task's plan, a line a step, with the glyphs the states use. `ended`: no step of a finished task is under way. */
function Plan({ steps, ended = false }: { steps: NonNullable<BoardViewPlan>; ended?: boolean }) {
  return (
    <ol className="space-y-0.5" data-plan>
      {steps.map((step, index) => {
        const shown = ended && step.status === "active" ? "unfinished" : step.status;
        const { glyph: Glyph, word } = shown === "unfinished" ? { glyph: CircleDashedIcon, word: "not finished" } : STEP[step.status];
        return (
          <li key={index} data-step={shown} className={cn("flex items-start gap-1.5", shown === "active" ? "text-foreground" : "text-muted-foreground", step.status === "skipped" && "line-through")}>
            <Glyph aria-hidden className="mt-[3px] size-3.5 shrink-0" /><span className="sr-only">{word}: </span><span className="min-w-0">{step.title}</span>
          </li>
        );
      })}
    </ol>
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
