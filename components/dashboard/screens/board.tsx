"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleIcon, CirclePauseIcon, CircleXIcon, ChevronDownIcon, ListFilterIcon,
  MoreHorizontalIcon, XIcon, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useConnection, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { BoardEvent, BoardHolder, BoardStatus, BoardThread, BoardView, BoardWaiting, FeedItem, ThreadView } from "@/convex/board";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { tickText, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { ProviderIcon } from "../provider-icon";
import { Markdown } from "../chat/markdown";
import { RunSteps } from "../chat/work";

/*
 * The Board (issue #363, v2), laid out as Vercel Board's own viewer is: a nav of views and channels, the list, and the
 * open thread in a pane beside it (over it on a narrow screen). Monospace, flat, one state glyph per item, each item
 * once. Why each part is as it is: .claude-task/DESIGN-v2.md in the PR that made it.
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
const WORD: Record<BoardStatus, string> = { queued: "queued", blocked: "waiting", working: "working", waiting: "needs you", done: "done", failed: "failed" };
const TONE: Partial<Record<BoardStatus, string>> = { waiting: "text-warning", failed: "text-destructive" };
/** A label short enough for the state column says more than the bare state ("paused", "stopped"); a longer one goes on line 2. */
const wordOf = (status: BoardStatus, label?: string) => label && label.length <= 10 ? label.toLowerCase() : WORD[status];

function State({ status, label, live = true, className }: { status: BoardStatus; label?: string; live?: boolean; className?: string }) {
  const Glyph = GLYPH[status];
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", TONE[status], className)} data-state={status}>
      <Glyph aria-hidden className={cn("size-3.5 shrink-0", status === "working" && live && "motion-safe:[&>circle:last-child]:animate-pulse")} />
      <span className="truncate">{wordOf(status, label)}</span>
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
  { id: "chats", name: "chats", has: (thread) => thread.kind === "chat" },
  { id: "tasks", name: "tasks", group: "work", has: (thread) => thread.kind === "task" },
  { id: "jobs", name: "jobs", group: "work", has: (thread) => thread.kind === "job" },
  { id: "heartbeat", name: "heartbeat", group: "work", has: (thread) => thread.kind === "heartbeat" },
  { id: "watches", name: "watches", group: "work", has: (thread) => thread.kind === "watch" },
];
const slug = (name: string) => name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "project";
/** The channel a thread is shown in: its project's, else its kind's. */
function channelName(thread: BoardThread, projects: BoardView["projects"]): string {
  const project = thread.projectId && projects.find((item) => item.id === thread.projectId);
  return project ? slug(project.name) : KIND_CHANNELS.find((channel) => channel.has(thread))!.name;
}

// --- Tabs: the states the list can be narrowed to ----------------------------------------------------------------

const TABS = ["open", "needs you", "working", "queued", "waiting", "done", "failed", "all"] as const;
type Tab = (typeof TABS)[number];
const TAB_STATUS: Partial<Record<Tab, BoardStatus>> = { "needs you": "waiting", working: "working", queued: "queued", waiting: "blocked", done: "done", failed: "failed" };
/** Open: not over. A watch is always on, so it counts as open only in its own channel. */
const isOpen = (thread: BoardThread, channel?: string) => thread.status !== "done" && thread.status !== "failed" && (thread.kind !== "watch" || channel === "watches");
const inTab = (thread: BoardThread, tab: Tab, channel?: string) => tab === "all" || (tab === "open" ? isOpen(thread, channel) : thread.status === TAB_STATUS[tab]);

// --- The address: view, channel, tab, open thread, computer ------------------------------------------------------

type Place = { view: "tasks" | "activity"; channel: string | null; tab: Tab | null; thread: string | null; computer: string | null };
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
  };
  const href = useCallback((next: Partial<Place>) => {
    const query = new URLSearchParams(params);
    for (const [name, value] of Object.entries(next)) {
      if (value && !(name === "view" && value === "tasks") && !(name === "tab" && value === "open")) query.set(name, value);
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
  const place = useAddress();
  const wide = useWide();
  const { unseen, mark } = useSeen(board?.threads);

  const channels = useMemo(() => {
    const projects = (board?.projects ?? []).filter((project) => board?.threads.some((thread) => thread.projectId === project.id))
      .map((project): Channel => ({ id: `project:${project.id}`, name: slug(project.name), group: "projects", has: (thread) => thread.projectId === project.id }));
    return [...KIND_CHANNELS, ...projects];
  }, [board]);
  const channel = channels.find((item) => item.id === place.channel);
  /** Waiting items by the thread each holds up; one with no thread on the board is a row of its own. */
  const waitingFor = useMemo(() => new Map((board?.waiting ?? []).flatMap((item) => item.thread ? [[item.thread, item] as const] : [])), [board]);
  const loose = useMemo(() => (board?.waiting ?? []).filter((item) => !item.thread), [board]);
  const open = board ? board.threads.filter((thread) => isOpen(thread)).length + loose.length : undefined;

  const nav = <Nav board={board} channels={channels} place={place} open={open} unseen={unseen} />;
  const menu = <NavMenu channels={channels} place={place} open={open} />;
  const pane = place.thread
    ? <Pane key={place.thread} id={place.thread} close={place.href({ thread: null })} projects={board?.projects ?? []} waiting={waitingFor.get(place.thread)} onSeen={mark} overlay={!wide} />
    : null;

  return (
    <div className="flex h-svh min-h-0 font-mono text-[13px] leading-5" data-board>
      {wide && <aside aria-label="Board" className="flex w-46 shrink-0 flex-col border-r">{nav}</aside>}
      <main id="content" tabIndex={-1} className="@container flex min-w-0 flex-1 flex-col outline-none">
        <Header place={place} channel={channel} board={board} wide={wide} nav={menu} />
        {place.view === "tasks"
          ? <Tasks board={board} place={place} channel={channel} waitingFor={waitingFor} loose={loose} unseen={unseen} />
          : <Activity board={board} place={place} channel={channel} />}
      </main>
      {pane && wide && <aside aria-label="Thread" className="flex w-[min(440px,36vw)] shrink-0 flex-col border-l">{pane}</aside>}
      {pane && !wide && <div role="dialog" aria-label="Thread" className="fixed inset-0 z-40 flex flex-col bg-background font-mono text-[13px] leading-5">{pane}</div>}
    </div>
  );
}

const HEADER = "flex h-12 shrink-0 items-center gap-2 border-b px-4";

/** The views and channels, as the viewer's left column has them. On a narrow screen it is the title's menu. */
function Nav({ board, channels, place, open, unseen }: {
  board?: BoardView; channels: Channel[]; place: ReturnType<typeof useAddress>; open?: number; unseen: (thread: BoardThread) => boolean;
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
          <p className="truncate text-[11px] text-muted-foreground">{online === undefined ? " " : online === 1 ? "1 computer" : `${online} computers`}</p>
        </div>
      </div>
      <nav aria-label="Views and channels" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <Link href={place.href({ view: "activity", channel: null, tab: null, thread: place.thread })} scroll={false} className={item(place.view === "activity" && !place.channel)}
          aria-current={place.view === "activity" && !place.channel ? "page" : undefined}>activity</Link>
        <Link href={place.href({ view: "tasks", channel: null })} scroll={false} className={item(place.view === "tasks" && !place.channel)}
          aria-current={place.view === "tasks" && !place.channel ? "page" : undefined}>
          <span className="flex-1">tasks</span>{open ? <span className="nums text-[11px] text-muted-foreground" data-open-count>{open}</span> : null}
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
                  <span className={cn("flex-1 truncate", changed && "font-semibold text-foreground")}>#{channel.name}</span>
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
function NavMenu({ channels, place, open }: { channels: Channel[]; place: ReturnType<typeof useAddress>; open?: number }) {
  const groups = [...new Set(channels.map((channel) => channel.group ?? ""))];
  return (
    <>
      <DropdownMenuItem render={<Link href={place.href({ view: "activity", channel: null, tab: null })} scroll={false} />}>activity</DropdownMenuItem>
      <DropdownMenuItem render={<Link href={place.href({ view: "tasks", channel: null })} scroll={false} />}>
        <span className="flex-1">tasks</span>{open ? <span className="nums text-[11px] text-muted-foreground">{open}</span> : null}
      </DropdownMenuItem>
      {groups.map((group) => (
        <DropdownMenuGroup key={group || "top"}>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px]">{group || "channels"}</DropdownMenuLabel>
          {channels.filter((channel) => (channel.group ?? "") === group).map((channel) => (
            <DropdownMenuItem key={channel.id} render={<Link href={place.href({ channel: channel.id })} scroll={false} />}>#{channel.name}</DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ))}
    </>
  );
}

/** The list's header: what it is, a word on its order, and on the right the filter and whether it is live. */
function Header({ place, channel, board, wide, nav }: { place: ReturnType<typeof useAddress>; channel?: Channel; board?: BoardView; wide: boolean; nav: ReactNode }) {
  const connection = useConnection();
  const title = channel ? `#${channel.name}` : place.view;
  const gloss = place.view === "activity" ? "the latest across every channel" : "needs you first";
  const machines = board?.machines ?? [];
  return (
    <header className={HEADER}>
      {!wide && <SidebarTrigger className="-ml-1.5 text-muted-foreground" />}
      {wide ? <h1 className="shrink-0 font-semibold">{title}</h1> : (
        <DropdownMenu>
          <DropdownMenuTrigger className="flex min-w-0 shrink-0 items-center gap-1 rounded-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`${title}: choose a view or channel`}>
            <h1>{title}</h1><ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 font-mono text-[13px]">{nav}</DropdownMenuContent>
        </DropdownMenu>
      )}
      <span className="min-w-0 truncate text-[12px] text-muted-foreground @max-[36rem]:hidden">{gloss}</span>
      <span className="flex-1" />
      {machines.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={place.computer ? `Computer: ${place.computer}` : "Filter by computer"} className={cn("text-muted-foreground", place.computer && "text-foreground")} />}>
            <ListFilterIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 font-mono text-[13px]">
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
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground" data-live={connection}>
        <span aria-hidden className={cn("size-1.5 rounded-full", connection === "connected" ? "bg-foreground" : "border border-muted-foreground")} />
        {connection === "connected" ? "live" : "reconnecting"}
      </span>
    </header>
  );
}

/** Whether a thread passes the computer filter: what holds it now, or held it last. */
const onComputer = (thread: BoardThread, computer: string | null) => !computer || thread.holder?.machine === computer;

function Tasks({ board, place, channel, waitingFor, loose, unseen }: {
  board?: BoardView; place: ReturnType<typeof useAddress>; channel?: Channel; waitingFor: Map<string, BoardWaiting>; loose: BoardWaiting[];
  unseen: (thread: BoardThread) => boolean;
}) {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [place.channel, place.tab, place.computer]);
  const threads = (board?.threads ?? []).filter((thread) => (!channel || channel.has(thread)) && inTab(thread, place.tab, channel?.id) && onComputer(thread, place.computer));
  const looseShown = !channel && !place.computer && (place.tab === "open" || place.tab === "needs you" || place.tab === "all") ? loose : [];
  const fresh = useArrivals(board ? [...looseShown.map((item) => item.id), ...threads.map((thread) => thread.id)] : undefined);
  return (
    <>
      <nav aria-label="States" className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 px-4 pt-2.5" data-tabs>
        {TABS.map((tab) => (
          <Link key={tab} href={place.href({ tab })} scroll={false} aria-current={place.tab === tab ? "page" : undefined}
            className={cn("border-b border-transparent pb-1.5 whitespace-nowrap outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              place.tab === tab ? "border-foreground text-foreground" : "text-muted-foreground")}>{tab}</Link>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
        {!board && <div className="space-y-3 px-4 py-2" role="status" aria-label="Loading">{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-9" />)}</div>}
        {board && threads.length + looseShown.length === 0 && <p className="px-4 py-3 text-muted-foreground" data-empty>nothing here</p>}
        <ul aria-label="Threads" data-rows>
          {looseShown.map((item) => <WaitingRow key={item.id} item={item} fresh={fresh(item.id)} />)}
          {threads.slice(0, shown).map((thread) => (
            <ThreadRow key={thread.id} thread={thread} href={place.href({ thread: thread.id })} selected={place.thread === thread.id} waiting={waitingFor.get(thread.id)}
              channel={channelName(thread, board!.projects)} fresh={fresh(thread.id)} changed={unseen(thread)} />
          ))}
        </ul>
        {threads.length > shown && <button type="button" className="mx-4 my-2 text-muted-foreground hover:text-foreground" onClick={() => setShown(shown + PAGE)}>show {Math.min(PAGE, threads.length - shown)} more</button>}
      </div>
    </>
  );
}

/** A row's columns: state, title, channel and age; the channel only where the list is wide enough for it. */
const ROW = "grid grid-cols-[6.75rem_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-1.5 outline-none hover:bg-muted/60 focus-visible:bg-muted @min-[36rem]:grid-cols-[7.5rem_minmax(0,1fr)_auto_auto]";

/** A command or a question waiting on the owner, as line 2 says it: a command on one line, as code. */
function Wants({ item }: { item: BoardWaiting }) {
  return item.command
    ? <code className="inline-block max-w-full truncate rounded bg-muted px-1.5 align-bottom text-[12px]" title={item.text} data-command>{item.text}</code>
    : <span className="block truncate" title={item.text}>{item.text}</span>;
}

function ThreadRow({ thread, href, selected, waiting, channel, fresh, changed }: {
  thread: BoardThread; href: string; selected: boolean; waiting?: BoardWaiting; channel: string; fresh: boolean; changed: boolean;
}) {
  const status = waiting && thread.status !== "failed" ? "waiting" : thread.status;
  const line: ReactNode = waiting ? <Wants item={waiting} />
    : thread.status === "working" && thread.kind !== "watch" ? <span className="block truncate">{actor(thread.holder)}{thread.now ? ` · ${thread.now}` : ""}</span>
      : thread.now ? <span className="block truncate">{thread.status === "blocked" && thread.label.length > 10 ? `${thread.label.toLowerCase()} · ${thread.now}` : thread.now}</span> : null;
  return (
    <li data-row={thread.id} data-status={status} className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
      <Link href={href} scroll={false} aria-current={selected ? "true" : undefined} className={cn(ROW, selected && "bg-muted")}>
        <State status={status} label={waiting ? undefined : thread.label} live={thread.kind !== "watch"} />
        <span className={cn("truncate", changed ? "font-semibold" : "font-medium")}>{thread.title}</span>
        <span className="truncate text-[12px] text-muted-foreground @max-[36rem]:hidden">#{channel}</span>
        <span className="justify-self-end text-[12px] text-muted-foreground" data-age>
          {thread.status === "working" && thread.kind !== "watch" ? <Ticking since={thread.startedAt} format={short} /> : <Age at={thread.updatedAt} />}
        </span>
        {line && <span className="col-start-2 col-end-[-1] min-w-0 text-[12px] text-muted-foreground" data-line>{line}</span>}
      </Link>
    </li>
  );
}

/** An approval whose chat has no thread on the board: a row of its own, opening where it is answered. */
function WaitingRow({ item, fresh }: { item: BoardWaiting; fresh: boolean }) {
  return (
    <li data-row={item.id} data-status="waiting" className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
      <Link href={item.href} className={ROW}>
        <State status="waiting" />
        <span className="truncate font-medium">{item.where ?? "approval"}</span>
        <span className="text-[12px] text-muted-foreground @max-[36rem]:hidden">approval</span>
        <span className="justify-self-end text-[12px] text-muted-foreground"><Age at={item.at} /></span>
        <span className="col-start-2 col-end-[-1] min-w-0 text-[12px] text-muted-foreground" data-line><Wants item={item} /></span>
      </Link>
    </li>
  );
}

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
      return true;
    }).sort((a, b) => a.at - b.at).slice(-ACTIVITY);
  }, [board, threads, channel, place.computer]);
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
      {entries.length > 0 && <Divider>today</Divider>}
      <ol aria-label="Activity" aria-live="polite" aria-relevant="additions" className="pb-3" data-activity>
        {entries.map((event) => {
          const thread = event.thread ? threads.get(event.thread) : undefined;
          const by = event.verb === "queued" || event.verb === "fired" || !thread?.holder ? "perry" : actor({ ...thread.holder, ...(event.machine ? { machine: event.machine } : {}) });
          const target = thread ? place.href({ thread: thread.id }) : event.href;
          const status = thread?.status ?? (event.status ?? "waiting");
          // What it says now: the approval's command, else its thread's line, else what the event said.
          const detail = event.verb === "approval" ? event.text : thread?.now ?? (event.text !== thread?.title ? event.text : undefined);
          return (
            <li key={event.id} data-entry={event.thread ?? event.id} data-event={event.verb} className={cn(fresh(event.id) && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out")}>
              <Message who={by} at={event.at} where={thread ? channelName(thread, board!.projects) : undefined} href={target} engine={by === "perry" ? undefined : thread?.holder?.engine}>
                <p className="truncate">{thread?.title ?? event.text}</p>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground" data-line>
                  <State status={status} label={thread?.label} live={thread?.kind !== "watch"} className="shrink-0 text-foreground/80" />
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
      <span className="truncate font-semibold">{who}</span>
      {where && <span className="shrink-0 text-[12px] text-muted-foreground">in #{where}</span>}
      <span className="shrink-0 text-[12px] text-muted-foreground"><Age at={at} /></span>
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

const NOUN: Record<BoardThread["kind"], string> = { chat: "chat", task: "task", job: "job", heartbeat: "heartbeat", watch: "watch" };

/** One thread, as the viewer's pane has it: its state and outcome on top with what you can do, then the conversation. */
function Pane({ id, close, projects, waiting, onSeen, overlay }: {
  id: string; close: string; projects: BoardView["projects"]; waiting?: BoardWaiting; onSeen: (thread: BoardThread) => void; overlay: boolean;
}) {
  const { dashboardKey } = useSession();
  const view = useQuery(api.board.thread, { key: dashboardKey, id });
  const thread = view?.thread;
  useEffect(() => { if (thread) onSeen(thread); }, [thread, onSeen]);
  const closer = (
    <Button variant="ghost" size="icon-sm" className="-mr-1.5 text-muted-foreground" aria-label="Close" render={<Link href={close} scroll={false} />}><XIcon /></Button>
  );
  if (view === undefined) return <><div className={HEADER}><span className="flex-1" />{closer}</div><div className="space-y-2 p-4" role="status" aria-label="Loading"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div></>;
  if (!view || !thread) return <><div className={HEADER}><span className="flex-1" />{closer}</div><p className="p-4 text-muted-foreground">this thread is gone</p></>;

  const runs = view.feed.filter((item) => item.kind === "run");
  const asking = view.feed.find((item) => item.kind === "approval" || item.kind === "question") as Extract<FeedItem, { kind: "approval" | "question" }> | undefined;
  const result = [...view.feed].reverse().find((item) => item.kind === "result") as Extract<FeedItem, { kind: "result" }> | undefined;
  const error = [...view.feed].reverse().find((item) => item.kind === "error") as Extract<FeedItem, { kind: "error" }> | undefined;
  const status = asking && thread.status !== "failed" ? "waiting" : thread.status;
  const action = asking
    ? { label: asking.kind === "approval" ? "review" : "answer", href: asking.href }
    : thread.chatId ? { label: "open chat", href: `/chat/${thread.chatId}` } : { label: "open in work", href: thread.href };
  const more = [
    ...(thread.chatId && action.label !== "open chat" ? [{ label: "open chat", href: `/chat/${thread.chatId}` }] : []),
    ...(thread.kind !== "chat" && action.label !== "open in work" ? [{ label: "open in work", href: thread.href }] : []),
  ];
  const rootBy = thread.kind === "chat" || thread.kind === "task" ? "you" : "perry";
  const said = view.feed.filter((item) => item.kind === "said" || item.kind === "update");

  return (
    <article aria-labelledby="pane-title" className="flex min-h-0 flex-1 flex-col" data-pane={thread.id}>
      <div className={HEADER}>
        <h2 id="pane-title" className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{NOUN[thread.kind]}</span> <span className="text-[12px] text-muted-foreground">in #{channelName(thread, projects)}</span>
          {overlay && <span className="sr-only">: {thread.title}</span>}
        </h2>
        {closer}
      </div>

      <section aria-label="State" className="shrink-0 space-y-2.5 border-b px-4 py-3" data-task-block>
        <p className="font-semibold [overflow-wrap:anywhere]" data-title>{thread.title}</p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px]">
          <State status={status} label={asking ? undefined : thread.label} live={thread.kind !== "watch"} className="font-semibold" />
          {thread.holder && status === "working" && thread.kind !== "watch" && <span className="text-muted-foreground" data-holder>· by {holderWords(thread.holder)} · <Ticking since={thread.startedAt} /></span>}
          {thread.holder && !going(thread.status) && thread.finishedAt !== undefined && <span className="text-muted-foreground" data-holder>· {holderWords(thread.holder)} · took {span(thread.finishedAt - thread.startedAt)}</span>}
        </p>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
          {asking && <Field label={asking.kind === "approval" ? "approval" : "question"}>
            {asking.kind === "approval" || waiting?.command
              ? <code className="block rounded bg-muted px-1.5 py-0.5 break-words whitespace-pre-wrap" data-command>{asking.text}</code>
              : <span className="whitespace-pre-wrap">{asking.text}</span>}
          </Field>}
          {error && <Field label="reason"><span className="whitespace-pre-wrap">{error.text}</span></Field>}
          {error?.step && <Field label="last step"><span data-last-step>{error.step}</span></Field>}
          {result && !error && <Field label={result.reply ? "reply" : "result"}><Clamp><div className="text-[13px] [&_*]:font-mono [&_.prose-chat]:text-[13px]"><Markdown text={result.text} /></div></Clamp></Field>}
          {view.plan && <Field label={`plan ${view.plan.filter((step) => step.status === "done").length}/${view.plan.length}`}><Plan steps={view.plan} /></Field>}
        </dl>
        <div className="flex items-center gap-1.5">
          <Button size="sm" render={<Link href={action.href} />} data-action>{action.label}</Button>
          {more.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="secondary" size="icon-sm" aria-label="More" />}><MoreHorizontalIcon /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40 font-mono text-[13px]">
                {more.map((item) => <DropdownMenuItem key={item.label} render={<Link href={item.href} />}>{item.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </section>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain" data-conversation>
        <div className="flex-1" />
        <Divider>{dayOf(thread.startedAt)}</Divider>
        <Message who={rootBy} at={thread.startedAt}>
          <Clamp lines><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{thread.ask}</p></Clamp>
        </Message>
        {(runs.length > 0 || said.length > 0) && <Divider>{runs.length === 1 ? "1 turn" : `${runs.length} turns`}</Divider>}
        <ol aria-label="Turns" className="pb-3" data-feed>
          {view.feed.map((item) => {
            if (item.kind === "run") {
              return (
                <li key={item.id} data-feed-run={item.status}>
                  <Message who={actor(item.holder)} at={item.at} engine={item.holder?.engine}>
                    {runs.length > 1 && item.status !== "done" && <State status={item.status} label={item.label} className="text-[12px]" />}
                    <div className="text-[13px] [&_.prose-chat]:text-[13px] [&_[data-work-timeline]]:pt-0.5 [&_*]:font-mono"><RunSteps runIds={[item.runId]} live={going(item.status)} held={item.status === "waiting"} unresponsive={item.status === "blocked"} omitText={item.omit} /></div>
                  </Message>
                </li>
              );
            }
            if (item.kind === "said") return <li key={item.id}><Message who="you" at={item.at}><p className="whitespace-pre-wrap">{item.text}</p></Message></li>;
            if (item.kind === "update") return <li key={item.id}><Message who="perry" at={item.at}><p className="whitespace-pre-wrap">{item.text}</p></Message></li>;
            return null;
          })}
        </ol>
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

/** A task's plan, a line a step, with the glyphs the states use. */
function Plan({ steps }: { steps: NonNullable<BoardViewPlan> }) {
  return (
    <ol className="space-y-0.5" data-plan>
      {steps.map((step, index) => {
        const { glyph: Glyph, word } = STEP[step.status];
        return (
          <li key={index} className={cn("flex items-start gap-1.5", step.status === "active" ? "text-foreground" : "text-muted-foreground", step.status === "skipped" && "line-through")}>
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
