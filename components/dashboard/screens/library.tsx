"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  DownloadIcon, FileIcon, FileTextIcon, FolderIcon, LayoutGridIcon, ListIcon, MusicIcon, PlayIcon, SearchIcon, SparklesIcon, Trash2Icon, XIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAction, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { LibraryDetail, LibraryItem } from "@/convex/library";
import { BY, FROM, HOW, KINDS, libraryFileUrl, libraryHref, type LibraryKind } from "@/convex/lib/library";
import { bytes, errorText, fullDate } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { AudioPlayer, VideoPlayer } from "@/components/ui/media-player";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Markdown } from "../chat/markdown";
import { EmptyState, List, ListSkeleton, Page, RelativeTime, TopBar, useSearchParam } from "../common";

/**
 * The Library (issue #216): every file the owner gave Perry and every file
 * Perry made, as a gallery or a list, filtered by kind, who, where from and
 * when, and found by name. Each opens on a page of its own: a preview, where
 * it came from, a download, and delete.
 */

type Option = { value: string; label: string };
const ALL = "all";
const KIND_OPTIONS: Option[] = [{ value: ALL, label: "All kinds" }, ...Object.entries(KINDS).map(([value, label]) => ({ value, label }))];
const BY_OPTIONS: Option[] = [{ value: ALL, label: "Anyone" }, { value: "owner", label: "From you" }, { value: "perry", label: "From Perry" }];
const SINCE_OPTIONS: Option[] = [
  { value: ALL, label: "Any time" }, { value: "today", label: "Today" }, { value: "week", label: "Past week" },
  { value: "month", label: "Past month" }, { value: "year", label: "Past year" },
];
const FROM_OPTIONS: Option[] = [
  { value: ALL, label: "Anywhere" }, { value: "web", label: FROM.web }, { value: "telegram", label: FROM.telegram }, { value: "whatsapp", label: FROM.whatsapp },
  { value: "pet", label: FROM.pet }, { value: "job", label: "Schedules" }, { value: "task", label: "Tasks" }, { value: "project", label: "Projects" },
  { value: "folder", label: FROM.folder },
];

function Filter({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (value: string) => void }) {
  const known = options.some((option) => option.value === value) ? value : ALL;
  return (
    <Select items={options} value={known} onValueChange={(next) => onChange(typeof next === "string" ? next : ALL)}>
      <SelectTrigger aria-label={label} data-filter={label}
        className={cn("h-8 border-transparent bg-transparent px-2 text-muted-foreground hover:bg-muted hover:text-foreground dark:bg-transparent", known !== ALL && "bg-muted text-foreground dark:bg-muted")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const KIND_ICON: Record<LibraryKind, typeof FileIcon> = { image: FileIcon, document: FileTextIcon, media: MusicIcon, other: FileIcon };
const extension = (name: string) => (name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 5) : "");
/** Where it came from, without saying it twice: "Telegram", not "Telegram · Telegram". */
const fromLabel = (item: LibraryItem) => {
  const label = item.source.label;
  return item.from === "folder" || label === "Chat" || label.toLowerCase().includes(FROM[item.from].toLowerCase()) ? FROM[item.from] : `${FROM[item.from]} · ${label}`;
};

export function Library() {
  const { dashboardKey } = useSession();
  const [view, setView] = useSearchParam("view", "gallery");
  const [kind, setKind] = useSearchParam("kind", ALL);
  const [by, setBy] = useSearchParam("by", ALL);
  const [from, setFrom] = useSearchParam("from", ALL);
  const [since, setSince] = useSearchParam("since", ALL);
  const [q, setQ] = useSearchParam("q", "");
  const [typed, setTyped] = useState(q);
  const needle = useDeferredValue(typed.trim());
  const refresh = useAction(api.library.refresh);
  // Opened: what Perry wrote in his folder since, and what is gone, is caught up with.
  useEffect(() => { void refresh({ key: dashboardKey }).catch(() => {}); }, [dashboardKey, refresh]);
  // The search goes in the address once typing settles, so a reload or a link keeps it.
  useEffect(() => {
    const timer = window.setTimeout(() => { if (typed.trim() !== q) setQ(typed.trim()); }, 400);
    return () => window.clearTimeout(timer);
    // setQ changes with the address; only the words matter here.
  }, [typed]);
  const pick = (value: string) => (value === ALL ? undefined : value);
  const data = useQuery(api.library.list, {
    key: dashboardKey, kind: pick(kind), by: pick(by), from: pick(from), since: pick(since), ...(needle ? { query: needle } : {}),
  });
  const fromOptions = [...FROM_OPTIONS, ...(data?.projects ?? []).map((project) => ({ value: project.id, label: project.name }))];
  const filtered = kind !== ALL || by !== ALL || from !== ALL || since !== ALL || Boolean(needle);
  const router = useRouter();
  const clear = () => { setTyped(""); router.replace(view === "list" ? "/library?view=list" : "/library", { scroll: false }); };

  if (data && data.total === 0) {
    return (
      <Page title="Library" wide>
        <EmptyState mascot title="No files yet">Files you send Perry, and files he makes, land here.</EmptyState>
      </Page>
    );
  }
  return (
    <Page title="Library" wide description="Files you gave Perry and files he made.">
      <div className="space-y-3">
        <InputGroup>
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="Search the Library" placeholder="Search by name" value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
          {typed && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setTyped("")}><XIcon /></InputGroupButton></InputGroupAddon>}
        </InputGroup>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filters">
          <Filter label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <Filter label="Who" value={by} options={BY_OPTIONS} onChange={setBy} />
          <Filter label="From" value={from} options={fromOptions} onChange={setFrom} />
          <Filter label="When" value={since} options={SINCE_OPTIONS} onChange={setSince} />
          {filtered && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={clear}>Clear</Button>}
          <span className="flex-1" />
          <ToggleGroup aria-label="View" value={[view === "list" ? "list" : "gallery"]} onValueChange={(next) => { if (next[0]) setView(next[0]); }} spacing={0}>
            <ToggleGroupItem value="gallery" aria-label="Gallery" size="sm"><LayoutGridIcon /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List" size="sm"><ListIcon /></ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className="mt-6" aria-live="polite">
        {data === undefined ? (view === "list" ? <ListSkeleton rows={5} /> : <GallerySkeleton />)
          : data.items.length === 0 ? <EmptyState title="Nothing matches" action={<Button variant="outline" size="sm" onClick={clear}>Clear filters</Button>} />
          : view === "list" ? <Rows items={data.items} /> : <Gallery items={data.items} />}
      </div>
    </Page>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" role="status" aria-label="Loading">
      {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="aspect-square rounded-xl" />)}
    </div>
  );
}

/** What a tile or row shows of a file: the picture itself, a video's first frame, or its kind. */
function Thumb({ item, className }: { item: LibraryItem; className?: string }) {
  if (item.kind === "image" && item.contentType !== "image/svg+xml") {
    // eslint-disable-next-line @next/next/no-img-element -- a file on this computer, served by /api/media
    return <img src={item.url} alt="" loading="lazy" decoding="async" className={cn("size-full object-cover", className)} />;
  }
  if (item.contentType.startsWith("video/")) {
    return (
      <span className={cn("relative block size-full bg-black", className)}>
        <video src={`${item.url}#t=0.1`} preload="metadata" muted playsInline aria-hidden tabIndex={-1} className="size-full object-cover" />
        <PlayIcon className="absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" aria-hidden />
      </span>
    );
  }
  const Icon = KIND_ICON[item.kind];
  return (
    <span className={cn("flex size-full flex-col items-center justify-center gap-1 text-muted-foreground", className)}>
      <Icon className="size-6" aria-hidden />
      {extension(item.name) && <span className="text-2xs font-medium tracking-wide">{extension(item.name)}</span>}
    </span>
  );
}

function Gallery({ items }: { items: LibraryItem[] }) {
  return (
    <ul aria-label="Library" className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4" data-view="gallery">
      {items.map((item) => (
        <li key={item.id} className="group/tile min-w-0" data-kind={item.kind} data-by={item.by} data-from={item.from}>
          {item.contentType.startsWith("audio/") ? (
            // A voice note or song plays where it is; its name opens it.
            <div className="relative flex aspect-square flex-col overflow-hidden rounded-xl bg-muted/60">
              <Thumb item={item} className="flex-1" />
              <AudioPlayer src={item.url} name={item.name} compact className="mx-1.5 mb-1.5 w-[calc(100%-0.75rem)] max-w-none border-transparent" />
            </div>
          ) : (
            <Link href={libraryHref(item.id)} tabIndex={-1} aria-hidden className="block aspect-square overflow-hidden rounded-xl bg-muted/60">
              <Thumb item={item} className="transition-transform duration-300 group-hover/tile:scale-[1.02]" />
            </Link>
          )}
          <Link href={libraryHref(item.id)} className="mt-1.5 block truncate text-sm font-medium underline-offset-2 hover:underline" title={item.name}>
            {item.name}
          </Link>
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            {item.by === "perry" && <SparklesIcon className="size-3 shrink-0" aria-label="Made by Perry" />}
            <RelativeTime at={item.createdAt} />
          </p>
        </li>
      ))}
    </ul>
  );
}

function Rows({ items }: { items: LibraryItem[] }) {
  return (
    <List label="Library">
      {items.map((item) => (
        <li key={item.id} className="relative flex items-center gap-3 py-2.5" data-kind={item.kind} data-by={item.by} data-from={item.from}>
          <span className="size-10 shrink-0 overflow-hidden rounded-lg bg-muted/60"><Thumb item={item} /></span>
          <div className="min-w-0 flex-1">
            <Link href={libraryHref(item.id)} className="block truncate text-md after:absolute after:inset-0 hover:underline underline-offset-2">{item.name}</Link>
            <p className="truncate text-xs text-muted-foreground">
              {bytes(item.size)} · {BY[item.by]} · {fromLabel(item)}{item.project ? ` · ${item.project.name}` : ""}
            </p>
          </div>
          <RelativeTime at={item.createdAt} className="shrink-0 text-xs text-muted-foreground" />
        </li>
      ))}
    </List>
  );
}

// --- One item ------------------------------------------------------------------------------------

export function LibraryItemScreen() {
  const { dashboardKey } = useSession();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const item = useQuery(api.library.get, { key: dashboardKey, id });
  useEffect(() => { if (item) document.title = `${item.name} · Perry`; }, [item?.name]);
  if (item === undefined) return <Page title="Library"><ListSkeleton rows={4} /></Page>;
  if (item === null) {
    return (
      <Page title="Library">
        <EmptyState mascot title="This file isn't here" action={<Button variant="outline" size="sm" render={<Link href="/library" />}>Library</Button>}>
          It may have been deleted.
        </EmptyState>
      </Page>
    );
  }
  return <ItemView item={item} />;
}

function ItemView({ item }: { item: LibraryDetail }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const remove = useAction(api.library.remove);
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const download = libraryFileUrl(item.id, true);
  const folder = item.path ? item.path.replace(/[\\/][^\\/]*$/, "") : "";
  const doRemove = async () => {
    setAsking(false);
    setRemoving(true);
    try {
      const done = await remove({ key: dashboardKey, id: item.id });
      toast.success(done.kept ? "Removed from the Library. The file is still on this computer." : "Deleted.");
      router.replace("/library");
    } catch (cause) {
      toast.error(`Couldn't delete it: ${errorText(cause)}`);
      setRemoving(false);
    }
  };
  return (
    <>
      <TopBar actions={<>
        <Button variant="ghost" size="sm" render={<a href={download} download={item.name} />}><DownloadIcon />Download</Button>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={removing} aria-busy={removing || undefined} onClick={() => setAsking(true)}>
          {removing ? <Spinner /> : <Trash2Icon />}Delete
        </Button>
      </>}>
        <Link href="/library" className="text-muted-foreground hover:text-foreground">Library</Link>
        <span className="text-muted-foreground/60" aria-hidden>/</span>
        <span className="truncate">{item.name}</span>
      </TopBar>
      <main id="content" tabIndex={-1} className="flex-1 outline-none">
        <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 sm:px-8 sm:pt-8">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] break-words">{item.name}</h1>
          <div className="mt-6" data-preview={item.preview ?? "none"}>
            <Preview item={item} />
          </div>
          <dl className="mt-8 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm" aria-label="Details">
            <dt className="text-muted-foreground">Size</dt>
            <dd>{bytes(item.size)} · {KINDS[item.kind].replace(/s$/, "").replace("Audio and video", "Audio or video")}</dd>
            <dt className="text-muted-foreground">Added</dt>
            <dd>{fullDate(item.createdAt)}</dd>
            <dt className="text-muted-foreground">By</dt>
            <dd>{BY[item.by]} · {HOW[item.how]}</dd>
            <dt className="text-muted-foreground">From</dt>
            <dd data-source>
              {FROM[item.from]}
              {fromLabel(item) !== FROM[item.from] && <> · {item.source.href ? <Link href={item.source.href} className="underline underline-offset-2 hover:text-foreground">{item.source.label}</Link> : <span className="text-muted-foreground">{item.source.label}</span>}</>}
            </dd>
            {item.project && <><dt className="text-muted-foreground">Project</dt><dd>{item.project.name}</dd></>}
            {item.path && (
              <>
                <dt className="text-muted-foreground">Saved in</dt>
                <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs [overflow-wrap:anywhere]"><FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />{folder}</dd>
              </>
            )}
          </dl>
        </div>
      </main>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {item.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {item.deletes ? "It's deleted from this computer, and its chat says it was removed." : "It leaves the Library and its chat says it was removed. The file stays where it is."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void doRemove()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const TEXT_LIMIT = 200_000;

function Preview({ item }: { item: LibraryDetail }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (item.preview !== "text" && item.preview !== "markdown") return;
    let current = true;
    fetch(item.url).then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((body) => { if (current) setText(body.length > TEXT_LIMIT ? `${body.slice(0, TEXT_LIMIT)}\n…` : body); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [item.preview, item.url]);
  const none = (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl bg-muted/50 py-16 text-muted-foreground">
      <FileIcon className="size-8" aria-hidden />
      <p className="text-sm">No preview for this kind of file.</p>
    </div>
  );
  switch (item.preview) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element -- a file on this computer, served by /api/media
      return <img src={item.url} alt={item.name} className="mx-auto max-h-[70vh] max-w-full rounded-xl object-contain" />;
    case "video": return <VideoPlayer src={item.url} name={item.name} download={libraryFileUrl(item.id, true)} className="max-h-[70vh]" />;
    case "audio": return <AudioPlayer src={item.url} name={item.name} download={libraryFileUrl(item.id, true)} className="max-w-lg" />;
    case "pdf": return <iframe src={item.url} title={item.name} className="h-[70vh] w-full rounded-xl border" />;
    case "markdown":
    case "text":
      if (failed) return none;
      if (text === null) return <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />Loading…</p>;
      return item.preview === "markdown"
        ? <article className="max-h-[70vh] overflow-auto rounded-xl bg-muted/40 px-5 py-4" data-text-preview><Markdown text={text} /></article>
        : <pre className="max-h-[70vh] overflow-auto rounded-xl bg-muted/40 px-5 py-4 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]" data-text-preview>{text}</pre>;
    default: return none;
  }
}
