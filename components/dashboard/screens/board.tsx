"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeftIcon, CalendarClockIcon, CheckCircle2Icon, ChevronRightIcon, CircleHelpIcon, EyeIcon, FolderIcon, HeartPulseIcon,
  LayersIcon, ListChecksIcon, MessageSquareIcon, OctagonXIcon, ShieldAlertIcon, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { BoardEvent, BoardHolder, BoardStatus, BoardThread, BoardView, BoardVerb, FeedItem } from "@/convex/board";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { ago, tickText, timeOf, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ListSkeleton, Page, StatusBadge, type Tone } from "../common";
import { ProviderIcon } from "../provider-icon";
import { Markdown } from "../chat/markdown";
import { PlanChecklist } from "../chat/plan";
import { RunSteps } from "../chat/work";

/** Rows shown at a time; the rest are a click away. */
const PAGE = 30;

type Channel = { id: string; label: string; icon: LucideIcon; has: (thread: BoardThread) => boolean };
const KINDS: Channel[] = [
  { id: "chats", label: "Chats", icon: MessageSquareIcon, has: (thread) => thread.kind === "chat" },
  { id: "tasks", label: "Tasks", icon: ListChecksIcon, has: (thread) => thread.kind === "task" },
  { id: "jobs", label: "Jobs", icon: CalendarClockIcon, has: (thread) => thread.kind === "job" },
  { id: "heartbeat", label: "Heartbeat", icon: HeartPulseIcon, has: (thread) => thread.kind === "heartbeat" },
  { id: "watches", label: "Watches", icon: EyeIcon, has: (thread) => thread.kind === "watch" },
];
const ALL: Channel = { id: "all", label: "All", icon: LayersIcon, has: () => true };

const TONE: Record<BoardStatus, Tone> = { queued: "neutral", working: "info", waiting: "warning", blocked: "warning", done: "success", failed: "danger" };
const STATUSES: Array<{ value: BoardStatus | "all"; label: string }> = [
  { value: "all", label: "Every status" }, { value: "working", label: "Working" }, { value: "waiting", label: "Needs you" },
  { value: "blocked", label: "Blocked" }, { value: "queued", label: "Queued" }, { value: "done", label: "Done" }, { value: "failed", label: "Failed" },
];
const VERB: Record<BoardVerb, string> = {
  queued: "queued", started: "started", posted: "posted", asked: "asked you", approval: "needs approval",
  finished: "finished", failed: "failed", stopped: "stopped", fired: "fired",
};
const DOT: Record<BoardVerb, string> = {
  queued: "bg-muted-foreground/50", started: "bg-primary", posted: "bg-primary", asked: "bg-warning", approval: "bg-warning",
  finished: "bg-success", failed: "bg-destructive", stopped: "bg-muted-foreground/50", fired: "bg-primary",
};
/** Still to happen or going on: what a channel counts. A watch is always on, so it is not counted. */
const live = (thread: BoardThread) => thread.kind !== "watch" && thread.status !== "done" && thread.status !== "failed";

/** "12s", "4m 12s", "2h 5m", "3d 4h". */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The board's place in the address: the channel, the thread open in it, and on a narrow screen, threads or activity. */
function useAddress() {
  const params = useSearchParams()!;
  const pathname = usePathname()!;
  const router = useRouter();
  const href = useCallback((next: Partial<Record<"channel" | "thread" | "view", string | null>>) => {
    const query = new URLSearchParams(params);
    for (const [name, value] of Object.entries(next)) {
      if (value && !(name === "channel" && value === "all") && !(name === "view" && value === "threads")) query.set(name, value);
      else query.delete(name);
    }
    const search = query.toString();
    return search ? `${pathname}?${search}` : pathname;
  }, [params, pathname]);
  return {
    channel: params.get("channel") ?? "all",
    thread: params.get("thread"),
    view: params.get("view") === "activity" ? "activity" as const : "threads" as const,
    href,
    go: (next: Parameters<typeof href>[0]) => router.replace(href(next), { scroll: false }),
  };
}

const SEEN = "perry.board.seen";
type Seen = { since: number; at: Record<string, number> };

/**
 * Which threads changed since the owner last opened them, kept in this browser.
 * Only threads still on the board are kept, so the record never outgrows it.
 */
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
  // A new function once the record has loaded, so a thread opened before then is marked when it has.
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

/**
 * What Perry is doing, everywhere at once (issue #363): each piece of work as a
 * thread in its channel, with who holds it and how it stands, a feed of what it
 * did, what waits on the owner, and everything as it happens.
 */
export function Board() {
  const { dashboardKey } = useSession();
  const board = useQuery(api.board.get, { key: dashboardKey });
  const address = useAddress();
  const { unseen, mark } = useSeen(board?.threads);
  const channels = useMemo(() => {
    const projects = (board?.projects ?? []).filter((project) => board?.threads.some((thread) => thread.projectId === project.id))
      .map((project): Channel => ({ id: `project:${project.id}`, label: project.name, icon: FolderIcon, has: (thread) => thread.projectId === project.id }));
    return [ALL, ...KINDS, ...projects];
  }, [board]);
  const channel = channels.find((item) => item.id === address.channel) ?? ALL;

  return (
    <Page title="Board" wide="full" actions={
      <Tabs value={address.view} onValueChange={(view) => address.go({ view: view as string, thread: null })} className={cn("xl:hidden", address.thread && "hidden")}>
        <TabsList aria-label="Show">
          <TabsTrigger value="threads">Threads</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
      </Tabs>
    }>
      {/* On a phone an open thread has the screen to itself; its back link returns to all of this. */}
      <WaitingOnYou threads={board?.threads} className={cn(address.thread && "max-lg:hidden")} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[11rem_minmax(0,1fr)_20rem]">
        <nav aria-label="Channels" className="max-lg:hidden lg:sticky lg:top-16 lg:self-start">
          <ul className="space-y-0.5">
            {channels.map((item, index) => (
              <li key={item.id} className={cn(index === KINDS.length + 1 && "mt-4 border-t pt-4")}>
                <Link href={address.href({ channel: item.id, thread: null })} scroll={false} aria-current={item.id === channel.id ? "page" : undefined}
                  className={cn("flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                    item.id === channel.id && "bg-muted font-medium text-foreground")}>
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <Count threads={board?.threads.filter(item.has)} />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Tabs value={channel.id} onValueChange={(id) => address.go({ channel: id as string, thread: null })} className={cn("lg:hidden", address.thread && "hidden")}>
          <TabsList variant="line" aria-label="Channels" className="w-full justify-start overflow-x-auto border-b [scrollbar-width:none] [&>button]:flex-none [&>button]:px-0">
            {channels.map((item) => <TabsTrigger key={item.id} value={item.id}>{item.label}<Count threads={board?.threads.filter(item.has)} /></TabsTrigger>)}
          </TabsList>
        </Tabs>

        <section aria-label={channel.label} className="min-w-0">
          <div className={cn(address.view === "activity" && !address.thread && "max-xl:hidden")}>
            {address.thread
              ? <Thread key={address.thread} id={address.thread} back={address.href({ thread: null })} backLabel={channel.label} onSeen={mark} />
              : <Threads board={board} channel={channel} href={(id) => address.href({ thread: id })} unseen={unseen} />}
          </div>
          {address.view === "activity" && !address.thread && <div className="xl:hidden"><Activity board={board} channel={channel} href={(id) => address.href({ thread: id, view: null })} /></div>}
        </section>

        <aside aria-label="Activity" className="max-xl:hidden xl:sticky xl:top-16 xl:max-h-[calc(100dvh-5rem)] xl:self-start xl:overflow-y-auto xl:overscroll-contain">
          <Activity board={board} channel={channel} href={(id) => address.href({ thread: id, view: null })} />
        </aside>
      </div>
    </Page>
  );
}

function Count({ threads }: { threads?: BoardThread[] }) {
  const count = threads?.filter(live).length ?? 0;
  if (!count) return null;
  return <span className="nums text-xs font-normal text-muted-foreground"><span className="sr-only">, </span>{count}<span className="sr-only"> active</span></span>;
}

/**
 * What waits on the owner: approvals from Needs you, and the questions tasks
 * stopped on. Each opens where it is answered.
 */
function WaitingOnYou({ threads, className }: { threads?: BoardThread[]; className?: string }) {
  const { dashboardKey } = useSession();
  const approvals = useQuery(api.approvals.pending, { key: dashboardKey });
  const now = useNow(5_000);
  const items = [
    ...(approvals ?? []).filter((approval) => approval.expiresAt > now).map((approval) => ({
      id: approval.id, icon: ShieldAlertIcon, kind: "Approval", title: approval.title, mono: approval.kind === "command",
      where: approval.chat?.title, href: approval.chat ? `/chat/${approval.chat.id}` : "/inbox", action: "Review", at: approval.createdAt,
    })),
    ...(threads ?? []).flatMap((thread) => thread.question ? [{
      id: thread.id, icon: CircleHelpIcon, kind: "Question", title: thread.question, mono: false,
      where: thread.title, href: thread.href, action: "Answer", at: thread.updatedAt,
    }] : []),
  ].sort((a, b) => b.at - a.at);
  if (!items.length) return null;
  return (
    <section aria-labelledby="waiting-on-you" className={cn("mb-8", className)}>
      <h2 id="waiting-on-you" className="mb-3 flex items-center gap-2 text-sm font-semibold">
        Waiting on you <span className="nums font-normal text-muted-foreground">{items.length}</span>
      </h2>
      <ul className="-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0" data-waiting-on-you>
        {items.map((item) => (
          <li key={item.id} className="w-72 shrink-0 snap-start">
            <Link href={item.href} className="group flex h-full flex-col rounded-lg border px-3.5 py-3 outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
              <span className="flex items-center gap-1.5 text-xs text-warning"><item.icon className="size-3.5" aria-hidden />{item.kind}</span>
              <span className={cn("mt-1.5 line-clamp-2 text-sm font-medium text-pretty [overflow-wrap:anywhere]", item.mono && "font-mono text-[0.8125rem]")}>{item.title}</span>
              {item.where && item.where !== item.title && <span className="mt-1 truncate text-xs text-muted-foreground">{item.where}</span>}
              <span className="mt-auto inline-flex items-center gap-1 pt-3 text-sm font-medium text-primary">{item.action}<ChevronRightIcon className="size-3.5 transition-transform duration-150 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden /></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Holder({ holder, className }: { holder?: BoardHolder; className?: string }) {
  if (!holder || (!holder.engine && !holder.machine)) return null;
  const words = [holder.engine && ENGINE_LABELS[holder.engine], holder.model, holder.machine].filter(Boolean).join(" · ");
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} data-holder>
      {holder.engine && <ProviderIcon engine={holder.engine} className="size-3.5" aria-hidden />}
      <span className="truncate">{words}</span>
    </span>
  );
}

/** How long it has been going, written each second without rendering the row; or how long it took. */
function Elapsed({ thread }: { thread: BoardThread }) {
  if (thread.kind === "watch" || (thread.kind !== "chat" && thread.status === "queued" && !thread.holder)) return null;
  if (thread.finishedAt !== undefined) return <span className="nums shrink-0">{span(thread.finishedAt - thread.startedAt)}</span>;
  if (thread.status === "done" || thread.status === "failed") return null;
  return <span className="nums shrink-0" ref={tickText((now) => span(now - thread.startedAt))} />;
}

function Threads({ board, channel, href, unseen }: {
  board?: BoardView; channel: Channel; href: (id: string) => string; unseen: (thread: BoardThread) => boolean;
}) {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [channel.id]);
  if (!board) return <ListSkeleton rows={4} />;
  const threads = board.threads.filter(channel.has);
  if (!threads.length) return <EmptyState title="Nothing here yet" />;
  return (
    <>
      <h2 className="sr-only">Threads</h2>
      <ul className="divide-y" data-threads>
        {threads.slice(0, shown).map((thread) => {
          const fresh = unseen(thread);
          return (
            <li key={thread.id} data-thread={thread.id} data-status={thread.status}>
              <Link href={href(thread.id)} className="group flex flex-col gap-1 py-3.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
                <span className="flex min-w-0 items-center gap-2">
                  {fresh && <span className="size-1.5 shrink-0 rounded-full bg-primary" role="img" aria-label="New activity" />}
                  <span className={cn("min-w-0 flex-1 truncate underline-offset-2 group-hover:underline", fresh ? "font-semibold" : "font-medium")}>{thread.title}</span>
                  <StatusBadge tone={TONE[thread.status]} pulse={thread.status === "working" && thread.kind !== "watch"}>{thread.label}</StatusBadge>
                </span>
                {thread.now && <span className={cn("line-clamp-2 text-sm text-pretty [overflow-wrap:anywhere]", thread.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{thread.now}</span>}
                <span className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
                  <Holder holder={thread.holder} />
                  <Elapsed thread={thread} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {threads.length > shown && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, threads.length - shown)} more</Button>
        </div>
      )}
    </>
  );
}

/** One thread: what was asked, who has it, and everything it did since, newest at the bottom. */
function Thread({ id, back, backLabel, onSeen }: { id: string; back: string; backLabel: string; onSeen: (thread: BoardThread) => void }) {
  const { dashboardKey } = useSession();
  const view = useQuery(api.board.thread, { key: dashboardKey, id });
  const thread = view?.thread;
  useEffect(() => { if (thread) onSeen(thread); }, [thread, onSeen]);
  const backLink = (
    <Button variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground" render={<Link href={back} scroll={false} />}>
      <ArrowLeftIcon />{backLabel}
    </Button>
  );
  if (view === undefined) return <div role="status" aria-label="Loading">{backLink}<Skeleton className="h-6 w-2/3" /><Skeleton className="mt-3 h-4 w-1/2" /><ListSkeleton rows={3} /></div>;
  if (view === null || !thread) return <div>{backLink}<EmptyState title="This thread is gone" /></div>;
  const going = thread.status === "working" || thread.status === "waiting" || thread.status === "blocked";
  const several = view.feed.filter((entry) => entry.kind === "run").length > 1;
  return (
    <article aria-labelledby="thread-title" className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150" data-thread-view={thread.id}>
      {backLink}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 id="thread-title" className="text-xl font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{thread.title}</h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <StatusBadge tone={TONE[thread.status]} pulse={thread.status === "working" && thread.kind !== "watch"}>{thread.label}</StatusBadge>
            <Holder holder={thread.holder} />
            <Elapsed thread={thread} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {thread.chatId && <Button variant="outline" size="sm" render={<Link href={`/chat/${thread.chatId}`} />}><MessageSquareIcon />Open chat</Button>}
          {thread.kind !== "chat" && <Button variant="ghost" size="sm" render={<Link href={thread.href} />}>Open in Work</Button>}
        </div>
      </div>

      <Ask text={thread.ask} />
      {view.plan && <PlanChecklist steps={view.plan} active={going} className="mt-4" />}

      <ol className="mt-6 space-y-4" aria-label="Feed" data-feed>
        {view.feed.map((item) => <FeedEntry key={item.id} item={item} holder={thread.holder} several={several} />)}
      </ol>
      {view.feed.length === 0 && <p className="mt-6 text-sm text-muted-foreground">{thread.status === "queued" ? "Not started yet." : "Nothing recorded yet."}</p>}
    </article>
  );
}

/** What it was asked, a few lines with the rest a click away. */
function Ask({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 6;
  return (
    <figure className="mt-6 border-l-2 pl-3.5" data-ask>
      <figcaption className="text-xs font-medium text-muted-foreground">Asked</figcaption>
      <p className={cn("mt-1 text-sm whitespace-pre-wrap text-pretty [overflow-wrap:anywhere]", long && !open && "line-clamp-6")}>{text}</p>
      {long && <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</Button>}
    </figure>
  );
}

const sameHolder = (a?: BoardHolder, b?: BoardHolder) => a?.engine === b?.engine && a?.model === b?.model && a?.machine === b?.machine;

/**
 * One entry of a thread's feed. A turn gets a line of its own (when it started, how it went) only where there are
 * several to tell apart, and names who held it only when that differs from the thread's holder.
 */
function FeedEntry({ item, holder, several }: { item: FeedItem; holder?: BoardHolder; several: boolean }) {
  switch (item.kind) {
    case "run": {
      const going = item.status === "working" || item.status === "waiting" || item.status === "blocked";
      const other = !sameHolder(item.holder, holder);
      return (
        <li data-feed-run={item.status}>
          {(several || other) && (
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <time dateTime={new Date(item.at).toISOString()} className="nums">{timeOf(item.at)}</time>
              {other && <Holder holder={item.holder} />}
              {several && item.status !== "done" && <StatusBadge tone={TONE[item.status]} pulse={item.status === "working"}>{item.label}</StatusBadge>}
            </p>
          )}
          <RunSteps runIds={[item.runId]} live={going} held={item.status === "waiting"} unresponsive={item.status === "blocked"} omitText={item.omit} />
        </li>
      );
    }
    case "said":
      return <li className="text-sm" data-feed-said><span className="text-xs font-medium text-muted-foreground">You</span><p className="mt-0.5 whitespace-pre-wrap text-pretty">{item.text}</p></li>;
    case "update":
      return <li className="text-sm text-pretty" data-feed-update>{item.text}</li>;
    case "approval":
    case "question": {
      const Icon = item.kind === "approval" ? ShieldAlertIcon : CircleHelpIcon;
      return (
        <li className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft/40 px-3.5 py-3 sm:flex-row sm:items-center" data-feed-waiting={item.kind}>
          <Icon className="size-4 shrink-0 text-warning max-sm:hidden" aria-hidden />
          <p className={cn("min-w-0 flex-1 text-sm text-pretty [overflow-wrap:anywhere]", item.kind === "approval" && "font-mono text-[0.8125rem]")}>
            <span className="sr-only">{item.kind === "approval" ? "Needs your approval: " : "Asks you: "}</span>{item.text}
          </p>
          <Button size="sm" render={<Link href={item.href} />}>{item.kind === "approval" ? "Review" : "Answer"}</Button>
        </li>
      );
    }
    case "result":
      return (
        <li className="border-t pt-4" data-feed-result>
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-success"><CheckCircle2Icon className="size-3.5" aria-hidden />{item.reply ? "Reply" : "Result"}</p>
          <div className="text-sm"><Markdown text={item.text} /></div>
        </li>
      );
    case "error":
      return (
        <li className="border-t pt-4" data-feed-error>
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-destructive"><OctagonXIcon className="size-3.5" aria-hidden />Failed</p>
          {item.step && <p className="mb-1 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-last-step>Last step: <span className="text-foreground">{item.step}</span></p>}
          <p className="text-sm whitespace-pre-wrap text-pretty text-destructive [overflow-wrap:anywhere]">{item.text}</p>
        </li>
      );
  }
}

/** Everything as it happens, across the channel open on the left; narrowed by status and by computer. */
function Activity({ board, channel, href }: { board?: BoardView; channel: Channel; href: (id: string) => string }) {
  const [status, setStatus] = useState<BoardStatus | "all">("all");
  const [machine, setMachine] = useState("all");
  const [shown, setShown] = useState(PAGE);
  const now = useNow();
  const threads = useMemo(() => new Map(board?.threads.map((thread) => [thread.id, thread])), [board]);
  // Events there when the rail first drew come in still; only later ones slide in.
  const known = useRef<Set<string> | null>(null);
  if (board && !known.current) known.current = new Set(board.events.map((event) => event.id));
  // Replaced, not added to, so a tab left open for days keeps only the events on the rail.
  useEffect(() => { if (board) known.current = new Set(board.events.map((event) => event.id)); }, [board]);
  useEffect(() => setShown(PAGE), [channel.id, status, machine]);

  const machines = board?.machines ?? [];
  const machineItems = [{ value: "all", label: "Every computer" }, ...machines.map((item) => ({ value: item.name, label: item.name }))];
  const computer = machines.length > 1 && machines.some((item) => item.name === machine) ? machine : "all";
  const events = (board?.events ?? []).filter((event) => {
    const thread = event.thread ? threads.get(event.thread) : undefined;
    if (channel.id !== "all" && !(thread && channel.has(thread))) return false;
    if (status !== "all" && (event.status ?? thread?.status) !== status) return false;
    if (computer !== "all" && (event.machine ?? thread?.holder?.machine) !== computer) return false;
    return true;
  });
  const filtered = status !== "all" || computer !== "all";

  return (
    <div data-activity>
      <h2 className="text-sm font-semibold">Activity</h2>
      <div className="mt-2 mb-3 flex flex-wrap items-center gap-2">
        <Select items={STATUSES} value={status} onValueChange={(value) => setStatus((value ?? "all") as BoardStatus | "all")}>
          <SelectTrigger size="sm" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="end">
            {STATUSES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {machines.length > 1 && (
          <Select items={machineItems} value={computer} onValueChange={(value) => setMachine(value ?? "all")}>
            <SelectTrigger size="sm" aria-label="Computer"><SelectValue /></SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="end">
              {machineItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
      {!board && <ListSkeleton rows={4} />}
      {board && events.length === 0 && (filtered
        ? <EmptyState title="Nothing matches" action={<Button variant="outline" size="sm" onClick={() => { setStatus("all"); setMachine("all"); }}>Clear filters</Button>} />
        : <EmptyState title="No activity yet" />)}
      {events.length > 0 && (
        <ol aria-label="Activity" aria-live="polite" aria-relevant="additions" className="space-y-0.5">
          {events.slice(0, shown).map((event) => (
            <EventRow key={event.id} event={event} thread={event.thread ? threads.get(event.thread) : undefined} href={href} now={now}
              fresh={Boolean(known.current && !known.current.has(event.id))} />
          ))}
        </ol>
      )}
      {events.length > shown && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShown(shown + PAGE)}>Show more</Button>
        </div>
      )}
    </div>
  );
}

function EventRow({ event, thread, href, now, fresh }: { event: BoardEvent; thread?: BoardThread; href: (id: string) => string; now: number; fresh: boolean }) {
  const target = thread ? href(thread.id) : event.href;
  const body = (
    <>
      <span className={cn("mt-[0.4375rem] size-1.5 shrink-0 rounded-full", DOT[event.verb])} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">
          <span className="font-medium underline-offset-2 group-hover:underline">{thread?.title ?? "Approval"}</span>{" "}
          <span className="text-muted-foreground">{VERB[event.verb]}{event.machine && (event.verb === "started" || event.verb === "posted") ? ` on ${event.machine}` : ""}</span>
        </span>
        {event.text && event.text !== thread?.title && <span className={cn("mt-0.5 line-clamp-2 text-xs text-pretty [overflow-wrap:anywhere]", event.verb === "failed" ? "text-destructive" : "text-muted-foreground")}>{event.text}</span>}
      </span>
      <time dateTime={new Date(event.at).toISOString()} className="nums mt-px shrink-0 text-xs text-muted-foreground">{ago(event.at, now)}</time>
    </>
  );
  const className = "group flex gap-2.5 rounded-md px-2 py-2 outline-none transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <li data-event={event.verb} className={cn(fresh && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200 motion-safe:ease-out")}>
      {target ? <Link href={target} className={className}>{body}</Link> : <div className={className}>{body}</div>}
    </li>
  );
}
