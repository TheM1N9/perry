"use client";

import Link from "next/link";
import { Component, useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { ArrowLeftIcon, ChevronRightIcon, DownloadIcon, MoreHorizontalIcon, SlidersHorizontalIcon, Maximize2Icon, Minimize2Icon, EyeOffIcon, FileIcon, Grid2X2Icon, ListTreeIcon, PinIcon, PlusIcon, XIcon } from "lucide-react";
import { useConnection, useConvex, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkspaceFile } from "@/convex/workspace";
import { useSession } from "@/lib/session";
import { bytes, errorText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AudioPlayer, VideoPlayer } from "@/components/ui/media-player";
import { StatusBadge } from "../common";
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

/** Shared right panel. Browser supplies its real-session view here without another sidebar. */
export function WorkspacePanel({ conversationId, project, open, onOpenChange, browser }: {
  conversationId: Id<"conversations"> | null;
  project?: { id: Id<"projects">; name: string };
  open: boolean; onOpenChange: (open: boolean) => void; browser?: ReactNode;
}) {
  const client = useConvex();
  const mobile = useIsMobile();
  const [width, setWidth] = useState(380);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    try { const saved = Number(localStorage.getItem("perry.workspace.width")); if (saved >= 300 && saved <= 640) setWidth(saved); } catch {}
  }, []);
  function resize(value: number) {
    const next = Math.max(300, Math.min(640, value));
    setWidth(next);
    try { localStorage.setItem("perry.workspace.width", String(next)); } catch {}
  }
  const content = <WorkspaceBoundary key={conversationId ?? "new"} onRetry={() => client.refresh()} onClose={() => onOpenChange(false)}><PanelContent conversationId={conversationId} project={project} browser={browser} expanded={expanded} onExpand={() => setExpanded(!expanded)} onClose={() => onOpenChange(false)} /></WorkspaceBoundary>;
  if (mobile) return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent showCloseButton={false} className="w-full max-w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-full motion-reduce:transition-none"><SheetTitle className="sr-only">Chat workspace</SheetTitle><SheetDescription className="sr-only">Files, work and the live browser associated with this chat.</SheetDescription>{content}</SheetContent></Sheet>;
  if (!open) return null;
  return <aside aria-label="Chat workspace" className="relative flex h-full min-h-0 shrink-0 flex-col border-l bg-background" style={{ width: expanded ? "min(65%, calc(100% - 340px))" : `min(${width}px, 50%)` }}>
    <div role="separator" aria-label="Resize workspace" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={640} aria-valuenow={width} tabIndex={0}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize focus-visible:bg-primary/20"
      onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? 20 : -20)); } }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(window.innerWidth - event.clientX); }} />
    {content}
  </aside>;
}

function PanelContent({ conversationId, project, browser, expanded, onExpand, onClose }: {
  conversationId: Id<"conversations"> | null; project?: { id: Id<"projects">; name: string }; browser?: ReactNode; expanded: boolean; onExpand: () => void; onClose: () => void;
}) {
  const tabKey = `perry.workspace.tab.${conversationId ?? "new"}`;
  const [tab, setTabValue] = useState("files");
  useEffect(() => { try { const saved = localStorage.getItem(tabKey); setTabValue(saved === "work" || (saved === "browser" && browser) ? saved : "files"); } catch {} }, [tabKey, Boolean(browser)]);
  const setTab = (value: string) => { setTabValue(value); try { localStorage.setItem(tabKey, value); } catch {} };
  const connection = useConnection();
  const [scope, setScope] = useState<Scope>("chat");
  const scopeKey = `perry.workspace.scope.${conversationId ?? "new"}`;
  useEffect(() => { try { setScope(project && localStorage.getItem(scopeKey) === "project" ? "project" : "chat"); } catch { setScope("chat"); } }, [scopeKey, project?.id]);
  const actualScope = project ? scope : "chat";
  const scopes = [{ value: "chat", label: "This chat" }, ...(project ? [{ value: "project", label: project.name }] : [])];
  return <Tabs value={tab} onValueChange={(value) => { if (typeof value === "string") setTab(value); }} className="min-h-0 flex-1 gap-0">
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <h2 className="sr-only">Workspace</h2>
      <TabsList variant="line" aria-label="Workspace views" className="mr-auto">
        <TabsTrigger value="files" className="px-2">Files</TabsTrigger>
        <TabsTrigger value="work" className="px-2">Work</TabsTrigger>
        {browser && <TabsTrigger value="browser" className="px-2">Browser</TabsTrigger>}
      </TabsList>
      <Button size="icon-sm" variant="ghost" className="hidden md:inline-flex" aria-label={expanded ? "Restore workspace width" : "Expand workspace"} onClick={onExpand}>{expanded ? <Minimize2Icon /> : <Maximize2Icon />}</Button>
      <Button size="icon-sm" variant="ghost" aria-label="Close workspace" onClick={onClose}><XIcon /></Button>
    </header>
    {connection !== "connected" && <p role="status" className="bg-muted px-3 py-2 text-xs">{connection === "connecting" ? "Connecting to Perry…" : "Reconnecting. Showing the last received state."}</p>}
    {tab !== "browser" && <div className="shrink-0 px-3 pt-3">
      {project ? <Select items={scopes} value={actualScope} onValueChange={(value) => { const next = value === "project" ? "project" : "chat"; setScope(next); try { localStorage.setItem(scopeKey, next); } catch {} }}>
        <SelectTrigger aria-label="Workspace scope" className="h-7 max-w-full border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"><SelectValue /></SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>{scopes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select> : <p className="px-2 text-xs text-muted-foreground">This chat</p>}
    </div>}
    <TabsContent value="files" className="flex min-h-0 flex-col">
      {!conversationId ? <p className="p-4 text-sm text-muted-foreground">Files you upload here will appear here.</p> : <Files key={`${conversationId}:${actualScope}`} conversationId={conversationId} scope={actualScope} scopeId={actualScope === "project" ? project?.id ?? conversationId : conversationId} />}
    </TabsContent>
    <TabsContent value="work" className="flex min-h-0 flex-col">
      {!conversationId ? <p className="p-4 text-sm text-muted-foreground">Work started here will appear here.</p> : <Work conversationId={conversationId} scope={actualScope} />}
    </TabsContent>
    {browser && <TabsContent value="browser" className="min-h-0">{browser}</TabsContent>}
  </Tabs>;

}

function Files({ conversationId, scope, scopeId }: { conversationId: Id<"conversations">; scope: Scope; scopeId: string }) {
  const { dashboardKey: key } = useSession();
  const [prefs, save] = usePreferences(`perry.workspace.${scope}.${scopeId}`);
  const [working, setWorking] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [kind, setKind] = useState<z.infer<typeof fileKind>>("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([]);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState("");
  const args = { key, conversationId, scope };
  const latest = useQuery(api.workspace.latest, args);
  const page = useQuery(api.workspace.files, { ...args, working, hidden, kind: kind || undefined, paginationOpts: { numItems: 50, cursor } });
  const chosen = page?.page.find((item) => item.id === prefs.selected);
  const selected = useQuery(api.workspace.get, prefs.selected ? { ...args, id: prefs.selected } : "skip");
  const view = useMutation(api.workspace.setView);
  const items = page?.page ?? [];
  const groups = groupFiles(items, (item) => item.group);
  const select = (item: WorkspaceFile) => save({ selected: item.id });
  const resetPage = () => { setCursor(null); setCursors([]); };
  function metadata(item: WorkspaceFile, patch: { hidden?: boolean; pinned?: boolean }) {
    void view({ ...args, id: item.id, ...patch }).catch((error: unknown) => setError(errorText(error)));
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    {prefs.selected ? <FilePreview item={chosen ?? selected} onBack={() => save({ selected: undefined })} /> : <>
      {latest && <Button size="sm" variant="ghost" className="mx-3 mt-3 justify-start overflow-hidden bg-primary/5 text-primary hover:bg-primary/10" onClick={() => select(latest)}><FileIcon /><span className="truncate">Latest result: {latest.name}</span></Button>}
      <div className="flex shrink-0 items-center gap-1 px-3 py-3">
        <ToggleGroup aria-label="File view" value={[prefs.mode]} spacing={0} onValueChange={(values) => { const value = values[0]; if (value === "tree" || value === "gallery") save({ mode: value }); }}>
          <ToggleGroupItem value="tree" size="sm" aria-label="Tree view" className="size-7 p-0"><ListTreeIcon className="size-4" /></ToggleGroupItem>
          <ToggleGroupItem value="gallery" size="sm" aria-label="Gallery view" className="size-7 p-0"><Grid2X2Icon className="size-4" /></ToggleGroupItem>
        </ToggleGroup>
        <Select items={fileTypes} value={kind} onValueChange={(value) => { const next = fileKind.safeParse(value); if (next.success) { setKind(next.data); resetPage(); } }}>
          <SelectTrigger aria-label="File type" className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>{fileTypes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant={working || hidden ? "secondary" : "ghost"} aria-label="File filters" />}><SlidersHorizontalIcon /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuCheckboxItem checked={working} onCheckedChange={(value) => { setWorking(value); resetPage(); }}>Working files</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={hidden} onCheckedChange={(value) => { setHidden(value); resetPage(); }}>Show hidden</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon-sm" variant="ghost" aria-label="Attach from Library" onClick={() => setAttaching(true)}><PlusIcon /></Button>
      </div>
      {error && <p role="alert" className="px-3 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-busy={!page}>
        {!page ? <p role="status" className="py-4 text-sm text-muted-foreground">Loading files…</p> : !items.length ? <p className="py-4 text-sm text-muted-foreground">No files in this view. Upload files in this chat or attach a Library item.</p>
          : prefs.mode === "gallery" ? <div className="grid grid-cols-2 gap-x-3 gap-y-4">{items.map((item) => <div key={item.id} className={cn("group/file relative min-w-0", item.hidden && "opacity-50")}>
            <Button variant="ghost" className="block h-auto w-full overflow-hidden p-0 text-left hover:bg-transparent" onClick={() => select(item)}>
              <div className="overflow-hidden rounded-lg"><Thumbnail item={item} /></div>
              <p className="mt-2 truncate pr-6 text-xs font-medium">{item.name}</p>
              <p className="mt-0.5 truncate text-2xs font-normal text-muted-foreground">{item.versionLabel ?? item.role} · {item.status === "ready" ? bytes(item.size) : "Unavailable"}{item.pinned ? " · Pinned" : ""}</p>
            </Button>
            <div className="absolute top-1 right-1 rounded-md bg-background/90"><FileActions item={item} onChange={(patch) => metadata(item, patch)} /></div>
          </div>)}</div>
          : [...groups].map(([group, files]) => <Collapsible key={group} open={prefs.expanded[group] ?? true} onOpenChange={(open) => save({ expanded: { ...prefs.expanded, [group]: open } })} className="mb-3">
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group w-full justify-start px-1 text-xs text-muted-foreground" />}><ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />{group}</CollapsibleTrigger>
            <CollapsibleContent>
              {[...groupFiles(files, (item) => item.versionRoot ?? item.id)].map(([root, versions]) => <div key={root} className="ml-2 border-l pl-2">
                {versions.map((item) => <div key={item.id} className={cn("group/file flex items-center gap-1 rounded-lg hover:bg-muted/60", item.hidden && "opacity-50")}>
                  <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-2 py-2 text-left hover:bg-transparent" onClick={() => select(item)}>
                    <FileIcon className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.name}{item.pinned && <PinIcon className="ml-1 inline size-3 text-muted-foreground" aria-label="Pinned" />}</span><span className="block truncate text-2xs font-normal text-muted-foreground">{item.versionLabel ?? item.role}{versions.length > 1 && item.latest ? " · Latest version" : ""}{item.status !== "ready" ? " · Unavailable" : ""}</span></span>
                  </Button>
                  <FileActions item={item} onChange={(patch) => metadata(item, patch)} />
                </div>)}
              </div>)}
            </CollapsibleContent>
          </Collapsible>)}
        {page && <div className="mt-3 flex items-center justify-between gap-2">
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
    <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`Actions for ${item.name}`} />}><MoreHorizontalIcon /></DropdownMenuTrigger>
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
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeftIcon />All files</Button>
    {item === undefined ? <p role="status" className="py-3 text-sm">Loading file…</p> : !item ? <p className="py-3 text-sm">This file is no longer in this workspace.</p> : <>
      <h3 className="mt-3 break-words text-sm font-semibold">{item.name}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{item.contentType} · {item.versionLabel ?? item.role} · {item.status === "ready" ? "Ready" : "Unavailable"}</p>
      <p className="mt-2 text-xs">{item.provenance === "uploaded" ? "Uploaded here" : item.provenance === "attached" ? "Explicitly attached from Library" : "Produced by this work"}</p>
      <Link href={`/chat/${item.source.conversationId}${item.source.messageKey ? `?message=${encodeURIComponent(item.source.messageKey)}` : item.source.runId ? `?run=${item.source.runId}` : ""}`} className="link mt-1 block text-xs">Source: {item.source.title}{item.source.messageKey ? " · producing message" : ""}</Link>
      {item.source.taskId && <Link href={`/work#task-${item.source.taskId}`} className="link mt-1 block text-xs">Open task in Work</Link>}
      <div className="my-4">
        {item.status !== "ready" ? <p className="text-sm text-muted-foreground">The registered file is missing or its storage is unavailable. Restore it on the host, then retry.</p>
          : item.preview === "image" ? <img key={retry} src={item.url} alt={item.name} className="w-full rounded-lg" onError={() => setError("This image is unavailable. Retry after restoring the file.")} />
          : item.preview === "video" ? <VideoPlayer key={retry} src={item.url} name={item.name} download={`${item.url}&download=1`} />
          : item.preview === "audio" ? <AudioPlayer key={retry} src={item.url} name={item.name} download={`${item.url}&download=1`} />
          : item.preview === "pdf" ? <iframe key={retry} title={item.name} src={item.url} sandbox="" className="h-[60vh] w-full rounded-lg border" />
          : item.preview === "text" || item.preview === "markdown" ? <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">{text ?? "Loading preview…"}</pre>
          : <p className="text-sm text-muted-foreground">Preview is unavailable for this format. Download it to open it.</p>}
      </div>
      {error && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
      <div className="flex gap-2"><Button size="sm" variant="outline" nativeButton={false} render={<a href={`${item.url}&download=1`} download />}> <DownloadIcon />Download</Button>{(error || item.status !== "ready") && <Button size="sm" variant="ghost" onClick={() => { void client.refresh(["library", "workspaceFiles"]); setRetry((was) => was + 1); setError(""); }}>Retry preview</Button>}</div>
    </>}
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

function Work({ conversationId, scope }: { conversationId: Id<"conversations">; scope: Scope }) {
  const { dashboardKey: key } = useSession();
  const [history, setHistory] = useState(false);
  const [selected, setSelected] = useState<string>();
  const preview = useQuery(api.workspace.get, selected ? { key, conversationId, scope, id: selected } : "skip");
  const work = useQuery(api.workspace.work, { key, conversationId, scope, history });
  if (selected) return <FilePreview item={preview} onBack={() => setSelected(undefined)} />;
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    {!work ? <p role="status" className="text-sm text-muted-foreground">Loading work…</p> : !work.length ? <p className="text-sm text-muted-foreground">No work started in this scope yet.</p> : work.map((item) => <article key={item.id} className="border-b py-4 first:pt-1 last:border-0">
      <div className="flex items-start justify-between gap-2"><h3 className="text-sm font-medium">{item.title}</h3><StatusBadge tone={item.error ? "danger" : "neutral"}>{item.status}</StatusBadge></div>
      {item.currentStep && <p className="mt-2 text-xs text-muted-foreground">{item.currentStep}</p>}
      {item.plan.length > 0 && <Collapsible className="mt-2">
        <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="group -ml-2 text-muted-foreground" />}><ChevronRightIcon className="transition-transform group-data-panel-open:rotate-90" />Steps ({item.plan.length})</CollapsibleTrigger>
        <CollapsibleContent><ol className="mt-2 space-y-2 pl-1">{item.plan.map((step, index) => <li key={index} className="text-xs"><span className="mr-2 text-muted-foreground">{step.status === "done" ? "✓" : step.status === "active" ? "→" : "○"}</span>{step.title}</li>)}</ol></CollapsibleContent>
      </Collapsible>}
      {item.error && <p className="mt-2 text-xs text-destructive">{item.error.slice(0, 400)}</p>}
      {item.outputs.length > 0 && <Collapsible className="mt-2">
        <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="group -ml-2 text-muted-foreground" />}><ChevronRightIcon className="transition-transform group-data-panel-open:rotate-90" />Related outputs ({item.outputs.length}{item.outputs.length === 50 ? "+" : ""})</CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-1">{item.outputs.map((output) => <Button key={output.id} variant="ghost" size="sm" onClick={() => setSelected(output.id)} className="w-full justify-start text-xs"><FileIcon /><span className="truncate">{output.name}{output.status !== "ready" ? " · Unavailable" : ""}</span></Button>)}</CollapsibleContent>
      </Collapsible>}
      <Link href={`/work${item.taskId ? `#task-${item.taskId}` : ""}`} className="link mt-3 inline-block text-xs">Open Work</Link>
      <Link href={`/chat/${item.conversationId}`} className="link ml-3 text-xs">Open chat</Link>
    </article>)}
    <label className="mt-2 flex items-center gap-2 text-xs"><Checkbox checked={history} onCheckedChange={setHistory} />Include completed history</label>
    {work && work.length >= (history ? 100 : 25) && <p className="mt-2 text-xs text-muted-foreground">Showing the most recent work. <Link href="/work" className="underline">Open Work for more.</Link></p>}
  </div>;
}
