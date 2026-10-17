"use client";

import Link from "next/link";
import { Component, useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, DownloadIcon, MoreHorizontalIcon, SlidersHorizontalIcon, Maximize2Icon, Minimize2Icon, EyeOffIcon, FileAudioIcon, FileIcon, FileImageIcon, FileTextIcon, FileVideoIcon, FolderOpenIcon, Grid2X2Icon, ListTreeIcon, PinIcon, PlusIcon, XIcon } from "lucide-react";
import { useConnection, useConvex, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkspaceFile } from "@/convex/workspace";
import { useSession } from "@/lib/session";
import { bytes, errorText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AudioPlayer, VideoPlayer } from "@/components/ui/media-player";
import { ENGINE_LABELS, type EngineKind } from "@/convex/lib/engines";
import { resetsText, usedNow, WARN_PERCENT, type EngineUsage } from "@/convex/lib/usage";
import { Markdown } from "./markdown";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

const fileKind = z.enum(["", "image", "media", "document", "other"]);
const fileTypes = [{ value: "", label: "All types" }, { value: "image", label: "Images" }, { value: "media", label: "Audio & video" }, { value: "document", label: "Documents & source" }, { value: "other", label: "Other" }];

const preferences = z.object({
  mode: z.enum(["tree", "gallery"]).default("tree"), selected: z.string().optional(),
  expanded: z.record(z.string(), z.boolean()).default({}),
});

function usePreferences(key: string) {
  const [state, setState] = useState({ key, value: preferences.parse({}) });
  useEffect(() => {
    try { setState({ key, value: preferences.parse(JSON.parse(localStorage.getItem(key) ?? "{}")) }); }
    catch { setState({ key, value: preferences.parse({}) }); }
  }, [key]);
  const value = state.key === key ? state.value : preferences.parse({});
  const update = (patch: Partial<z.infer<typeof preferences>>) => {
    const next = { ...value, ...patch };
    setState({ key, value: next });
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  };
  return [value, update] as const;
}

class WorkspaceBoundary extends Component<{ children: ReactNode; onRetry: () => Promise<unknown>; onClose: () => void }, { error: string; retry: number }> {
  state = { error: "", retry: 0 };
  static getDerivedStateFromError(error: unknown) { return { error: errorText(error) }; }
  render() {
    return this.state.error ? <div role="alert" className="p-4 text-sm"><Button size="sm" variant="ghost" className="mb-3" onClick={this.props.onClose}>Close workspace</Button><p>{this.state.error}</p><Button size="sm" variant="outline" className="mt-3" onClick={() => void this.props.onRetry().then(() => this.setState({ error: "", retry: this.state.retry + 1 }))}>Retry workspace</Button></div>
      : <div key={this.state.retry} className="flex min-h-0 flex-1 flex-col">{this.props.children}</div>;
  }
}

function groupFiles(files: WorkspaceFile[], key: (file: WorkspaceFile) => string) {
  const groups = new Map<string, WorkspaceFile[]>();
  for (const file of files) { const name = key(file); const group = groups.get(name) ?? []; group.push(file); groups.set(name, group); }
  return groups;
}

type Scope = "chat" | "project";

export type ChatContext = { engine?: EngineKind; model?: string; context?: { fill: number; window: number }; usage?: EngineUsage };

/** The group Perry's working files are listed under: what a run wrote on its way, not yet shared as a result. */
const WORKING = "Working files";
const roleLabel = (role: WorkspaceFile["role"]) => role === "working" ? "Working" : role === "input" ? "Input" : "Result";

function KindIcon({ item }: { item: WorkspaceFile }) {
  const Icon = item.preview === "image" ? FileImageIcon : item.preview === "video" ? FileVideoIcon : item.preview === "audio" ? FileAudioIcon : item.preview === "markdown" || item.preview === "text" || item.preview === "pdf" ? FileTextIcon : FileIcon;
  return <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Icon className="size-4" /></span>;
}

/** What the workspace window shows: one card, or all of them stacked. */
export type WorkspaceView = "all" | "context" | "files" | "browser";
const TITLES: Record<WorkspaceView, string> = { all: "Workspace", context: "Context", files: "Files", browser: "Browser" };

/**
 * The chat's workspace, as a window floating over the chat (not a column beside it, so the chat never moves): one
 * card, picked by its button in the chat's header, or every card stacked. On a phone, a sheet over the whole screen.
 */
export function WorkspacePanel({ conversationId, project, view, onViewChange, browser, context }: {
  conversationId: Id<"conversations"> | null;
  project?: { id: Id<"projects">; name: string };
  view: WorkspaceView | null; onViewChange: (view: WorkspaceView | null) => void; browser?: ReactNode;
  /** What the Context card says: the chat's engine and model, how full its context is, and the engine's plan. */
  context?: ChatContext;
}) {
  const client = useConvex();
  const mobile = useIsMobile();
  const [browsing, setBrowsing] = useState(false);
  // The live page is drawn at 1280px: showing it, the window opens wide so it can be read, unless the owner narrows it.
  const [chosenWide, setChosenWide] = useState<boolean>();
  useEffect(() => setChosenWide(undefined), [view]);
  const wide = chosenWide ?? (view === "browser" || (view === "all" && browsing));
  const close = () => onViewChange(null);
  if (!view && !mobile) return null;
  const content = view && <WorkspaceBoundary key={conversationId ?? "new"} onRetry={() => client.refresh()} onClose={close}><PanelContent view={view} conversationId={conversationId} project={project} browser={browser} context={context} expanded={wide} onExpand={mobile ? undefined : () => setChosenWide(!wide)} onBrowsing={setBrowsing} onClose={close} /></WorkspaceBoundary>;
  if (mobile) return <Sheet open={Boolean(view)} onOpenChange={(open) => { if (!open) close(); }}><SheetContent showCloseButton={false} className="w-full max-w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-full motion-reduce:transition-none"><SheetTitle className="sr-only">Chat workspace</SheetTitle><SheetDescription className="sr-only">Context, files and the live browser of this chat.</SheetDescription>{content}</SheetContent></Sheet>;
  return <aside aria-label="Chat workspace" data-view={view}
    className="absolute top-14 right-3 z-30 flex max-h-[calc(100%-4.5rem)] min-h-0 flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-float ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150 motion-reduce:animate-none"
    style={{ width: wide ? "min(780px, calc(100% - 1.5rem))" : "min(400px, calc(100% - 1.5rem))" }}
    onKeyDown={(event) => { if (event.key === "Escape" && !(event.target as HTMLElement).closest('[role="application"]')) { event.stopPropagation(); close(); } }}>
    {content}
  </aside>;
}

/** Which cards are open in the stack, kept for the next visit: Context and Files open, Browser closed (opening it starts the live view). */
const cardPrefs = z.object({ context: z.boolean().default(true), files: z.boolean().default(true), browser: z.boolean().default(false) });

/** One of the stack's cards: a titled box that opens and closes, with a little on its right while closed. */
function PanelCard({ id, title, open, onOpenChange, aside, children }: { id: string; title: string; open: boolean; onOpenChange: (open: boolean) => void; aside?: ReactNode; children: ReactNode }) {
  return <Collapsible open={open} onOpenChange={onOpenChange} className="rounded-xl bg-card ring-1 ring-foreground/10" data-card={id}>
    <div className="flex items-center gap-2 pr-2">
      <CollapsibleTrigger className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-xl py-3 pl-3.5 text-left text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        {title}<ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-closed:-rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      {aside}
    </div>
    <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
      <div className="pb-3">{children}</div>
    </CollapsibleContent>
  </Collapsible>;
}

function PanelContent({ view, conversationId, project, browser, context, expanded, onExpand, onBrowsing, onClose }: {
  view: WorkspaceView; conversationId: Id<"conversations"> | null; project?: { id: Id<"projects">; name: string }; browser?: ReactNode; context?: ChatContext; expanded: boolean; onExpand?: () => void; onBrowsing: (open: boolean) => void; onClose: () => void;
}) {
  const [cards, setCards] = useState(cardPrefs.parse({}));
  useEffect(() => {
    let saved = cardPrefs.parse({});
    try { saved = cardPrefs.parse(JSON.parse(localStorage.getItem("perry.workspace.cards") ?? "{}")); } catch {}
    setCards(saved);
    onBrowsing(Boolean(browser) && saved.browser);
  }, [Boolean(browser)]);
  const toggle = (card: keyof typeof cards, open: boolean) => {
    const next = { ...cards, [card]: open };
    setCards(next);
    if (card === "browser") onBrowsing(open);
    try { localStorage.setItem("perry.workspace.cards", JSON.stringify(next)); } catch {}
  };
  const connection = useConnection();
  const [scope, setScope] = useState<Scope>("chat");
  const scopeKey = `perry.workspace.scope.${conversationId ?? "new"}`;
  useEffect(() => { try { setScope(project && localStorage.getItem(scopeKey) === "project" ? "project" : "chat"); } catch { setScope("chat"); } }, [scopeKey, project?.id]);
  const actualScope = project ? scope : "chat";
  const scopes = [{ value: "chat", label: "This chat" }, ...(project ? [{ value: "project", label: project.name }] : [])];
  const files = <>
    {project && <div className="px-2 pb-1">
      <Select items={scopes} value={actualScope} onValueChange={(value) => { const next = value === "project" ? "project" : "chat"; setScope(next); try { localStorage.setItem(scopeKey, next); } catch {} }}>
        <SelectTrigger aria-label="Workspace scope" className="h-7 max-w-full border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"><SelectValue /></SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>{scopes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>}
    {!conversationId ? <p className="px-3.5 text-sm text-muted-foreground">Files you send here, and the ones Perry makes, show up here.</p> : <Files key={`${conversationId}:${actualScope}`} conversationId={conversationId} scope={actualScope} scopeId={actualScope === "project" ? project?.id ?? conversationId : conversationId} />}
  </>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex shrink-0 items-center gap-1 border-b py-1.5 pr-1.5 pl-4">
      <h2 className="mr-auto text-sm font-semibold">{TITLES[view]}</h2>
      {onExpand && <Button size="icon-sm" variant="ghost" aria-label={expanded ? "Narrow the window" : "Widen the window"} onClick={onExpand}>{expanded ? <Minimize2Icon /> : <Maximize2Icon />}</Button>}
      <Button size="icon-sm" variant="ghost" aria-label="Close workspace" onClick={onClose}><XIcon /></Button>
    </header>
    {connection !== "connected" && <p role="status" className="mx-3 mt-3 rounded-lg bg-muted px-3 py-2 text-xs">{connection === "connecting" ? "Connecting to Perry…" : "Reconnecting. Showing the last received state."}</p>}
    {view === "all" ? <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <PanelCard id="context" title="Context" open={cards.context} onOpenChange={(open) => toggle("context", open)}
        aside={!cards.context && context?.context ? <span className="nums text-xs text-muted-foreground">{Math.round(context.context.fill * 100)}% used</span> : undefined}>
        <ContextCard context={context} />
      </PanelCard>
      <PanelCard id="files" title="Files" open={cards.files} onOpenChange={(open) => toggle("files", open)}>{files}</PanelCard>
      {browser && <PanelCard id="browser" title="Browser" open={cards.browser} onOpenChange={(open) => toggle("browser", open)}>
        {/* Mounted only while open: closed, the live view stops and nothing streams. */}
        {cards.browser && browser}
      </PanelCard>}
    </div> : <div className="min-h-0 flex-1 overflow-y-auto py-3" data-card={view}>
      {view === "context" ? <ContextCard context={context} /> : view === "files" ? files : browser ?? <p className="px-4 text-sm text-muted-foreground">Perry's browser is off here.</p>}
    </div>}
  </div>;
}

/** The chat's engine and model, how much of its context it has used, and how much of the engine's plan is left. */
function ContextCard({ context }: { context?: ChatContext }) {
  const now = Date.now();
  const used = context?.context;
  const windows = context?.usage?.limits?.windows ?? [];
  const tokens = (count: number) => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(count % 1_000_000 ? 1 : 0)}M` : `${Math.round(count / 1000)}k`;
  return <div className="space-y-4 px-3.5 text-sm">
    <div data-context-used>
      {used ? <>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium nums">{Math.round(used.fill * 100)}% used</span>
          <span className="nums text-xs text-muted-foreground">{tokens(used.fill * used.window)} / {tokens(used.window)}</span>
        </div>
        <Meter value={used.fill} label="Context used" />
        <p className="mt-1.5 text-xs text-muted-foreground">Perry saves what matters to Brain before the engine compacts it.</p>
      </> : <p className="text-xs text-muted-foreground">How full the context is shows after Perry's next reply.</p>}
    </div>
    {context?.engine && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">Engine</dt><dd className="truncate text-right">{ENGINE_LABELS[context.engine]}</dd>
      <dt className="text-muted-foreground">Model</dt><dd className="truncate text-right">{context.model ?? "Default"}</dd>
      {context.usage?.limits?.plan && <><dt className="text-muted-foreground">Plan</dt><dd className="truncate text-right">{context.usage.limits.plan}</dd></>}
    </dl>}
    {windows.length > 0 && <div className="space-y-2.5" data-plan-usage>
      {windows.map((window) => {
        const percent = usedNow(window, now);
        return <div key={window.id}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span>{window.label}</span>
            <span className="nums text-muted-foreground">{Math.round(percent)}%{resetsText(window, now) ? ` · ${resetsText(window, now)}` : ""}</span>
          </div>
          <Meter value={percent / 100} label={`${window.label} plan used`} tone={percent >= 100 ? "out" : percent >= WARN_PERCENT ? "low" : "ok"} />
        </div>;
      })}
    </div>}
  </div>;
}

function Meter({ value, label, tone = "ok" }: { value: number; label: string; tone?: "ok" | "low" | "out" }) {
  const percent = Math.max(0, Math.min(100, value * 100));
  return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
    <div className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", tone === "out" ? "bg-destructive" : tone === "low" ? "bg-warning" : "bg-primary")} style={{ width: `${percent}%` }} />
  </div>;
}

function Files({ conversationId, scope, scopeId }: { conversationId: Id<"conversations">; scope: Scope; scopeId: string }) {
  const { dashboardKey: key } = useSession();
  const [prefs, save] = usePreferences(`perry.workspace.${scope}.${scopeId}`);
  const [hidden, setHidden] = useState(false);
  const [kind, setKind] = useState<z.infer<typeof fileKind>>("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([]);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState("");
  const args = { key, conversationId, scope };
  const latest = useQuery(api.workspace.latest, args);
  // What a run writes is registered as working; it is listed too, in its own group, since often it is all a chat has.
  const page = useQuery(api.workspace.files, { ...args, working: true, hidden, kind: kind || undefined, paginationOpts: { numItems: 50, cursor } });
  const chosen = page?.page.find((item) => item.id === prefs.selected);
  const selected = useQuery(api.workspace.get, prefs.selected ? { ...args, id: prefs.selected } : "skip");
  const view = useMutation(api.workspace.setView);
  const items = page?.page ?? [];
  const results = items.filter((item) => item.role !== "working");
  const groups = groupFiles(results, (item) => item.group);
  const working = items.filter((item) => item.role === "working");
  if (working.length) groups.set(WORKING, working);
  const select = (item: WorkspaceFile) => save({ selected: item.id });
  const resetPage = () => { setCursor(null); setCursors([]); };
  function metadata(item: WorkspaceFile, patch: { hidden?: boolean; pinned?: boolean }) {
    void view({ ...args, id: item.id, ...patch }).catch((error: unknown) => setError(errorText(error)));
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    {prefs.selected ? <FilePreview item={chosen ?? selected} onBack={() => save({ selected: undefined })} /> : <>
      {latest && <Button size="sm" variant="ghost" className="mx-3 mt-3 justify-start overflow-hidden bg-primary/5 text-primary hover:bg-primary/10" onClick={() => select(latest)}><FileIcon /><span className="truncate">Latest result: {latest.name}</span></Button>}
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        <ToggleGroup aria-label="File view" value={[prefs.mode]} spacing={0} onValueChange={(values) => { const value = values[0]; if (value === "tree" || value === "gallery") save({ mode: value }); }}>
          <ToggleGroupItem value="tree" size="sm" aria-label="Tree view" className="size-7 p-0"><ListTreeIcon className="size-4" /></ToggleGroupItem>
          <ToggleGroupItem value="gallery" size="sm" aria-label="Gallery view" className="size-7 p-0"><Grid2X2Icon className="size-4" /></ToggleGroupItem>
        </ToggleGroup>
        <Select items={fileTypes} value={kind} onValueChange={(value) => { const next = fileKind.safeParse(value); if (next.success) { setKind(next.data); resetPage(); } }}>
          <SelectTrigger aria-label="File type" className="mr-auto h-7 w-auto min-w-0 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>{fileTypes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant={hidden ? "secondary" : "ghost"} aria-label="File filters" />}><SlidersHorizontalIcon /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuCheckboxItem checked={hidden} onCheckedChange={(value) => { setHidden(value); resetPage(); }}>Show hidden</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon-sm" variant="ghost" aria-label="Attach from Library" onClick={() => setAttaching(true)}><PlusIcon /></Button>
      </div>
      {error && <p role="alert" className="px-3 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-busy={!page}>
        {!page ? <p role="status" className="py-4 text-sm text-muted-foreground">Loading files…</p> : !items.length ? <div className="flex flex-col items-center px-4 py-12 text-center" data-files-empty>
            <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><FolderOpenIcon className="size-5" /></span>
            <p className="mt-3 text-sm font-medium">{kind || hidden ? "No files match" : "No files yet"}</p>
            <p className="mt-1 max-w-60 text-xs text-muted-foreground">{kind || hidden ? "Try another type, or clear the filters." : "Files Perry makes, and the ones you send in this chat, show up here."}</p>
          </div>
          : prefs.mode === "gallery" ? <div className="grid grid-cols-2 gap-x-3 gap-y-4">{items.map((item) => <div key={item.id} className={cn("group/file relative min-w-0", item.hidden && "opacity-50")}>
            <Button variant="ghost" className="block h-auto w-full overflow-hidden p-0 text-left hover:bg-transparent" onClick={() => select(item)}>
              <div className="overflow-hidden rounded-lg"><Thumbnail item={item} /></div>
              <p className="mt-2 truncate pr-6 text-xs font-medium">{item.name}</p>
              <p className="mt-0.5 truncate text-2xs font-normal text-muted-foreground">{item.versionLabel ?? roleLabel(item.role)} · {item.status === "ready" ? bytes(item.size) : "Unavailable"}{item.pinned ? " · Pinned" : ""}</p>
            </Button>
            <div className="absolute top-1 right-1 rounded-md bg-background/90"><FileActions item={item} onChange={(patch) => metadata(item, patch)} /></div>
          </div>)}</div>
          : [...groups].map(([group, files]) => <Collapsible key={group} open={prefs.expanded[group] ?? (group !== WORKING || !results.length)} onOpenChange={(open) => save({ expanded: { ...prefs.expanded, [group]: open } })} className="mb-2" data-file-group={group === WORKING ? "working" : "results"}>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group h-7 w-full justify-start gap-1 px-1 text-xs font-medium text-muted-foreground" />}><ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" /><span className="truncate">{group}</span><span className="nums ml-auto font-normal">{files.length}</span></CollapsibleTrigger>
            <CollapsibleContent className="pt-0.5">
              {[...groupFiles(files, (item) => item.versionRoot ?? item.id)].map(([root, versions]) => <div key={root} className={cn(versions.length > 1 && "ml-3 border-l pl-1")}>
                {versions.map((item) => <div key={item.id} className={cn("group/file flex items-center gap-1 rounded-lg pr-1 hover:bg-muted/60", item.hidden && "opacity-50")}>
                  <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-2 py-1.5 text-left hover:bg-transparent" onClick={() => select(item)}>
                    <KindIcon item={item} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-normal">{item.name}{item.pinned && <PinIcon className="ml-1 inline size-3 text-muted-foreground" aria-label="Pinned" />}</span><span className="block truncate text-xs font-normal text-muted-foreground">{[item.versionLabel ?? roleLabel(item.role), versions.length > 1 && item.latest ? "Latest version" : "", item.status === "ready" ? bytes(item.size) : "Unavailable"].filter(Boolean).join(" · ")}</span></span>
                  </Button>
                  <FileActions item={item} onChange={(patch) => metadata(item, patch)} />
                </div>)}
              </div>)}
            </CollapsibleContent>
          </Collapsible>)}
        {page && (cursors.length > 0 || !page.isDone) && <div className="mt-3 flex items-center justify-between gap-2">
          {cursors.length > 0 && <Button size="sm" variant="outline" onClick={() => { setCursor(cursors.at(-1) ?? null); setCursors((was) => was.slice(0, -1)); }}>Previous files</Button>}
          {!page.isDone && <Button size="sm" variant="outline" onClick={() => { setCursors((was) => [...was, cursor]); setCursor(page.continueCursor); }}>Next files</Button>}
        </div>}
      </div>
    </>}
    {attaching && <AttachLibrary conversationId={conversationId} onClose={() => setAttaching(false)} />}
  </div>;
}

function FileActions({ item, onChange }: { item: WorkspaceFile; onChange: (patch: { pinned?: boolean; hidden?: boolean }) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground transition-opacity [@media(hover:hover)]:opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100 aria-expanded:opacity-100" aria-label={`Actions for ${item.name}`} />}><MoreHorizontalIcon /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-32">
      <DropdownMenuItem onClick={() => onChange({ pinned: !item.pinned })}><PinIcon />{item.pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => onChange({ hidden: !item.hidden })}><EyeOffIcon />{item.hidden ? "Show in workspace" : "Hide from workspace"}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function Thumbnail({ item }: { item: WorkspaceFile }) {
  const [unavailable, setUnavailable] = useState(false);
  const [duration, setDuration] = useState("");
  if (item.status !== "ready" || unavailable) return <div className="grid aspect-video place-items-center bg-muted text-xs text-muted-foreground">Preview unavailable</div>;
  if (item.preview === "image") return <img src={item.url} alt={item.name} loading="lazy" onError={() => setUnavailable(true)} className="aspect-video w-full bg-muted object-cover" />;
  if (item.preview === "video") return <div className="relative"><video src={item.url} muted playsInline preload="metadata" onError={() => setUnavailable(true)} onLoadedMetadata={(event) => { const seconds = event.currentTarget.duration; if (Number.isFinite(seconds)) setDuration(`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`); }} className="aspect-video w-full bg-muted object-cover" aria-label={item.name} />{duration && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">{duration}</span>}</div>;
  return <div className="flex aspect-video items-center justify-center gap-2 bg-muted text-xs text-muted-foreground"><FileIcon className="size-6" />{item.preview === "audio" ? "Audio" : "Document"}</div>;
}

function FilePreview({ item, onBack }: { item: WorkspaceFile | null | undefined; onBack: () => void }) {
  const client = useConvex();
  const [text, setText] = useState<string>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setText(undefined); setError("");
    if (!item || (item.preview !== "text" && item.preview !== "markdown")) return;
    const controller = new AbortController();
    void fetch(item.url, { headers: { Range: "bytes=0-196607" }, signal: controller.signal }).then(async (response) => { if (!response.ok) throw new Error("This file is unavailable. Restore it on the host and retry."); const content = await response.text(); setText(content + (item.size > 196608 ? "\n\n[Preview truncated; download to read the full file.]" : "")); }).catch((error: unknown) => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  }, [item?.url, item?.preview, retry]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <Button size="icon-sm" variant="ghost" aria-label="All files" onClick={onBack}><ArrowLeftIcon /></Button>
      <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={item?.name}>{item?.name ?? "File"}</h3>
      {item && item.status === "ready" && <Button size="icon-sm" variant="ghost" aria-label="Download" nativeButton={false} render={<a href={`${item.url}&download=1`} download />}><DownloadIcon /></Button>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
    {item === undefined ? <p role="status" className="py-3 text-sm text-muted-foreground">Loading file…</p> : !item ? <p className="py-3 text-sm text-muted-foreground">This file is no longer in this workspace.</p> : <>
      <p className="text-xs text-muted-foreground">
        {[item.provenance === "uploaded" ? "Sent here" : item.provenance === "attached" ? "Attached from Library" : "Made by Perry", item.versionLabel ?? roleLabel(item.role), item.status === "ready" ? bytes(item.size) : "Unavailable"].join(" · ")}
        {" · "}<Link href={`/chat/${item.source.conversationId}${item.source.messageKey ? `?message=${encodeURIComponent(item.source.messageKey)}` : item.source.runId ? `?run=${item.source.runId}` : ""}`} className="link">{item.source.title}</Link>
        {item.source.taskId && <>{" · "}<Link href={`/work#task-${item.source.taskId}`} className="link">Task</Link></>}
      </p>
      <div className="my-3">
        {item.status !== "ready" ? <p className="text-sm text-muted-foreground">The registered file is missing or its storage is unavailable. Restore it on the host, then retry.</p>
          : item.preview === "image" ? <img key={retry} src={item.url} alt={item.name} className="w-full rounded-lg" onError={() => setError("This image is unavailable. Retry after restoring the file.")} />
          : item.preview === "video" ? <VideoPlayer key={retry} src={item.url} name={item.name} download={`${item.url}&download=1`} />
          : item.preview === "audio" ? <AudioPlayer key={retry} src={item.url} name={item.name} download={`${item.url}&download=1`} />
          : item.preview === "pdf" ? <iframe key={retry} title={item.name} src={item.url} sandbox="" className="h-[60vh] w-full rounded-lg border" />
          : item.preview === "markdown" && text !== undefined ? <div className="rounded-lg border p-4" data-file-text><Markdown text={text} /></div>
          : item.preview === "text" || item.preview === "markdown" ? <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words" data-file-text>{text ?? "Loading preview…"}</pre>
          : <p className="text-sm text-muted-foreground">Preview is unavailable for this format. Download it to open it.</p>}
      </div>
      {error && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
      {(error || item.status !== "ready") && <Button size="sm" variant="outline" onClick={() => { void client.refresh(["library", "workspaceFiles"]); setRetry((was) => was + 1); setError(""); }}>Retry preview</Button>}
    </>}
    </div>
  </div>;
}

function AttachLibrary({ conversationId, onClose }: { conversationId: Id<"conversations">; onClose: () => void }) {
  const { dashboardKey: key } = useSession();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  const library = useQuery(api.library.list, { key, query });
  const attach = useMutation(api.workspace.attach);
  return <div className="flex min-h-0 flex-1 flex-col border-t p-3">
    <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Attach from Library</h3><Button size="icon-sm" variant="ghost" aria-label="Close Library picker" onClick={onClose}><XIcon /></Button></div>
    <Input autoFocus aria-label="Find a Library file" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Library" className="my-3" />
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="min-h-0 max-h-64 overflow-y-auto">{library === undefined ? <p role="status">Loading Library…</p> : library.items.slice(0, 50).map((item) => <Button variant="ghost" key={item.id} disabled={!!pending} className="block w-full truncate text-left text-xs" onClick={() => { setPending(item.id); void attach({ key, conversationId, id: item.id }).then(onClose).catch((error: unknown) => setError(errorText(error))).finally(() => setPending(undefined)); }}>{pending === item.id ? "Attaching… " : ""}{item.name}</Button>)}</div>
  </div>;
}
