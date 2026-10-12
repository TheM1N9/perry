"use client";

import Link from "next/link";
import { Component, useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { ArrowLeftIcon, DownloadIcon, EyeOffIcon, FileIcon, Grid2X2Icon, ListTreeIcon, PinIcon, PlusIcon, XIcon } from "lucide-react";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkspaceFile } from "@/convex/workspace";
import { useSession } from "@/lib/session";
import { bytes, errorText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

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

class WorkspaceBoundary extends Component<{ children: ReactNode }, { error: string; retry: number }> {
  state = { error: "", retry: 0 };
  static getDerivedStateFromError(error: unknown) { return { error: errorText(error) }; }
  render() {
    return this.state.error ? <div role="alert" className="p-4 text-sm"><p>{this.state.error}</p><Button size="sm" variant="outline" className="mt-3" onClick={() => this.setState({ error: "", retry: this.state.retry + 1 })}>Retry workspace</Button></div>
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
  const mobile = useIsMobile();
  const [width, setWidth] = useState(380);
  useEffect(() => {
    const saved = Number(localStorage.getItem("perry.workspace.width"));
    if (saved >= 300 && saved <= 640) setWidth(saved);
  }, []);
  function resize(value: number) {
    const next = Math.max(300, Math.min(640, value));
    setWidth(next);
    try { localStorage.setItem("perry.workspace.width", String(next)); } catch {}
  }
  const content = <WorkspaceBoundary key={conversationId ?? "new"}><PanelContent conversationId={conversationId} project={project} browser={browser} onClose={() => onOpenChange(false)} /></WorkspaceBoundary>;
  if (mobile) return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent showCloseButton={false} className="w-full max-w-full gap-0 sm:max-w-full"><SheetTitle className="sr-only">Chat workspace</SheetTitle><SheetDescription className="sr-only">Files and work associated with this chat.</SheetDescription>{content}</SheetContent></Sheet>;
  if (!open) return null;
  return <aside aria-label="Chat workspace" className="relative flex h-full min-h-0 shrink-0 flex-col border-l bg-background" style={{ width: `min(${width}px, 50vw)` }}>
    <div role="separator" aria-label="Resize workspace" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={640} aria-valuenow={width} tabIndex={0}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize focus-visible:bg-primary/20"
      onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? 20 : -20)); } }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(window.innerWidth - event.clientX); }} />
    {content}
  </aside>;
}

function PanelContent({ conversationId, project, browser, onClose }: {
  conversationId: Id<"conversations"> | null; project?: { id: Id<"projects">; name: string }; browser?: ReactNode; onClose: () => void;
}) {
  const [tab, setTab] = useState("files");
  const [scope, setScope] = useState<Scope>("chat");
  const scopeKey = `perry.workspace.scope.${conversationId ?? "new"}`;
  useEffect(() => { setScope(project && localStorage.getItem(scopeKey) === "project" ? "project" : "chat"); }, [scopeKey, project?.id]);
  const actualScope = project ? scope : "chat";
  return <>
    <header className="flex shrink-0 items-center justify-between border-b p-3">
      <h2 className="text-sm font-semibold">Workspace</h2>
      <Button size="icon-sm" variant="ghost" aria-label="Close workspace" onClick={onClose}><XIcon /></Button>
    </header>
    <nav aria-label="Workspace views" className="flex shrink-0 gap-1 border-b px-3 py-2">
      {["files", "work", ...(browser ? ["browser"] : [])].map((value) => <Button key={value} size="sm" variant={tab === value ? "secondary" : "ghost"} aria-pressed={tab === value} onClick={() => setTab(value)}>{value[0]?.toUpperCase()}{value.slice(1)}</Button>)}
    </nav>
    {tab !== "browser" && <div className="shrink-0 border-b p-3">
      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">Scope
        <select aria-label="Workspace scope" className="min-w-0 max-w-60 rounded-md border bg-background p-1.5 text-foreground" value={actualScope} onChange={(event) => { const next = event.target.value === "project" ? "project" : "chat"; setScope(next); try { localStorage.setItem(scopeKey, next); } catch {} }}>
          <option value="chat">This chat</option>{project && <option value="project">Project: {project.name}</option>}
        </select>
      </label>
    </div>}
    {tab === "browser" ? browser : !conversationId ? <p className="p-4 text-sm text-muted-foreground">This chat has no {tab} yet. Files you upload and work started here will appear here.</p>
      : tab === "files" ? <Files key={`${conversationId}:${actualScope}`} conversationId={conversationId} scope={actualScope} />
      : <Work conversationId={conversationId} scope={actualScope} />}
  </>;
}

function Files({ conversationId, scope }: { conversationId: Id<"conversations">; scope: Scope }) {
  const { dashboardKey: key } = useSession();
  const [prefs, save] = usePreferences(`perry.workspace.${scope === "chat" ? conversationId : `project.${conversationId}`}`);
  const [working, setWorking] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [kind, setKind] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([]);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState("");
  const args = { key, conversationId, scope };
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
      <div className="flex shrink-0 flex-wrap items-center gap-2 p-3">
        <Button size="icon-sm" variant={prefs.mode === "tree" ? "secondary" : "ghost"} aria-label="Tree view" aria-pressed={prefs.mode === "tree"} onClick={() => save({ mode: "tree" })}><ListTreeIcon /></Button>
        <Button size="icon-sm" variant={prefs.mode === "gallery" ? "secondary" : "ghost"} aria-label="Gallery view" aria-pressed={prefs.mode === "gallery"} onClick={() => save({ mode: "gallery" })}><Grid2X2Icon /></Button>
        <select aria-label="File type" value={kind} onChange={(event) => { setKind(event.target.value); resetPage(); }} className="min-w-0 flex-1 rounded-md border bg-background p-1.5 text-xs"><option value="">All file types</option><option value="image">Images</option><option value="media">Audio and video</option><option value="document">Documents and source</option><option value="other">Other</option></select>
        <Button size="icon-sm" variant="ghost" aria-label="Attach from Library" onClick={() => setAttaching(true)}><PlusIcon /></Button>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={working} onChange={(event) => { setWorking(event.target.checked); resetPage(); }} />Working files</label>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={hidden} onChange={(event) => { setHidden(event.target.checked); resetPage(); }} />Show hidden</label>
      </div>
      {error && <p role="alert" className="px-3 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-busy={!page}>
        {!page ? <p role="status" className="py-4 text-sm text-muted-foreground">Loading files…</p> : !items.length ? <p className="py-4 text-sm text-muted-foreground">No files in this view. Upload files in this chat or attach a Library item.</p>
          : prefs.mode === "gallery" ? <div className="grid grid-cols-2 gap-2">{items.map((item) => <div key={item.id} className={cn("overflow-hidden rounded-lg border", item.hidden && "opacity-50")}>
            <button className="w-full text-left focus-visible:outline-2 focus-visible:outline-ring" onClick={() => select(item)}><Thumbnail item={item} /><p className="truncate px-2 pt-2 text-xs font-medium">{item.name}</p><p className="px-2 pb-2 text-2xs text-muted-foreground">{item.versionLabel ?? item.role} · {item.status === "ready" ? bytes(item.size) : "Unavailable"}</p></button><FileActions item={item} onChange={(patch) => metadata(item, patch)} />
          </div>)}</div>
          : [...groups].map(([group, files]) => <details key={group} open={prefs.expanded[group] ?? true} onToggle={(event) => { const open = event.currentTarget.open; if ((prefs.expanded[group] ?? true) !== open) save({ expanded: { ...prefs.expanded, [group]: open } }); }} className="mb-3">
            <summary className="cursor-pointer py-2 text-xs font-medium">{group}</summary>
            {[...groupFiles(files, (item) => item.versionRoot ?? item.id)].map(([root, versions]) => <div key={root} className="ml-1 border-l pl-2">
              {versions.map((item) => <div key={item.id} className={cn("mb-1 rounded-md border p-2", item.hidden && "opacity-50")}>
                <button className="flex w-full items-start gap-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring" onClick={() => select(item)}><FileIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.name}{item.pinned && " · Pinned"}</span><span className="text-muted-foreground">{item.versionLabel ?? item.role}{item.latest && item.role === "output" ? " · Latest result" : ""}{item.status !== "ready" ? " · Unavailable" : ""}</span></span></button>
                <FileActions item={item} onChange={(patch) => metadata(item, patch)} />
              </div>)}
            </div>)}
          </details>)}
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
  return <div className="flex items-center gap-1 px-1 py-1">
    <Button size="icon-sm" variant="ghost" aria-label={`${item.pinned ? "Unpin" : "Pin"} ${item.name}`} aria-pressed={item.pinned} onClick={() => onChange({ pinned: !item.pinned })}><PinIcon className="size-3" /></Button>
    <Button size="icon-sm" variant="ghost" aria-label={`${item.hidden ? "Show" : "Hide"} ${item.name}`} onClick={() => onChange({ hidden: !item.hidden })}><EyeOffIcon className="size-3" /></Button>
  </div>;
}

function Thumbnail({ item }: { item: WorkspaceFile }) {
  const [unavailable, setUnavailable] = useState(false);
  const [duration, setDuration] = useState("");
  if (item.status !== "ready" || unavailable) return <div className="grid aspect-video place-items-center bg-muted text-xs text-muted-foreground">Preview unavailable</div>;
  if (item.preview === "image") return <img src={item.url} alt={item.name} loading="lazy" onError={() => setUnavailable(true)} className="aspect-video w-full bg-muted object-cover" />;
  if (item.preview === "video") return <div className="relative"><video src={item.url} muted playsInline preload="metadata" onError={() => setUnavailable(true)} onLoadedMetadata={(event) => { const seconds = event.currentTarget.duration; if (Number.isFinite(seconds)) setDuration(`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`); }} className="aspect-video w-full bg-muted object-cover" aria-label={item.name} />{duration && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">{duration}</span>}</div>;
  return <div className="flex aspect-video items-center justify-center gap-2 bg-muted text-xs text-muted-foreground"><FileIcon className="size-6" />{item.preview === "audio" ? "Audio" : item.contentType}</div>;
}

function FilePreview({ item, onBack }: { item: WorkspaceFile | null | undefined; onBack: () => void }) {
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
      <Link href={`/chat/${item.source.conversationId}${item.source.messageKey ? `?message=${encodeURIComponent(item.source.messageKey)}` : ""}`} className="mt-1 block text-xs underline">Source: {item.source.title}{item.source.messageKey ? " · producing message" : ""}</Link>
      {item.source.taskId && <Link href={`/work#task-${item.source.taskId}`} className="mt-1 block text-xs underline">Open task in Work</Link>}
      <div className="my-4">
        {item.status !== "ready" ? <p className="text-sm text-muted-foreground">The registered file is missing or its storage is unavailable. Restore it on the host, then retry.</p>
          : item.preview === "image" ? <img src={item.url} alt={item.name} className="w-full rounded-lg" onError={() => setError("This image is unavailable. Retry after restoring the file.")} />
          : item.preview === "video" ? <video src={item.url} controls playsInline className="w-full rounded-lg" onError={() => setError("This video is unavailable.")} />
          : item.preview === "audio" ? <audio src={item.url} controls className="w-full" onError={() => setError("This audio is unavailable.")} />
          : item.preview === "pdf" ? <iframe title={item.name} src={item.url} sandbox="" className="h-[60vh] w-full rounded-lg border" />
          : item.preview === "text" || item.preview === "markdown" ? <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">{text ?? "Loading preview…"}</pre>
          : <p className="text-sm text-muted-foreground">Preview is unavailable for this format. Download it to open it.</p>}
      </div>
      {error && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
      <div className="flex gap-2"><Button size="sm" variant="outline" render={<a href={`${item.url}&download=1`} download />}> <DownloadIcon />Download</Button><Button size="sm" variant="ghost" onClick={() => { setRetry((was) => was + 1); setError(""); }}>Retry preview</Button></div>
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
    <input autoFocus aria-label="Find a Library file" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Library" className="my-2 rounded-md border bg-background p-2 text-sm" />
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="min-h-0 max-h-64 overflow-y-auto">{library === undefined ? <p role="status">Loading Library…</p> : library.items.slice(0, 50).map((item) => <button key={item.id} disabled={!!pending} className="block w-full truncate rounded-md p-2 text-left text-xs hover:bg-muted disabled:opacity-50" onClick={() => { setPending(item.id); void attach({ key, conversationId, id: item.id }).then(onClose).catch((error: unknown) => setError(errorText(error))).finally(() => setPending(undefined)); }}>{pending === item.id ? "Attaching… " : ""}{item.name}</button>)}</div>
  </div>;
}

function Work({ conversationId, scope }: { conversationId: Id<"conversations">; scope: Scope }) {
  const { dashboardKey: key } = useSession();
  const [history, setHistory] = useState(false);
  const work = useQuery(api.workspace.work, { key, conversationId, scope, history });
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    {!work ? <p role="status" className="text-sm text-muted-foreground">Loading work…</p> : !work.length ? <p className="text-sm text-muted-foreground">No work started in this scope yet.</p> : work.map((item) => <article key={item.id} className="mb-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2"><h3 className="text-sm font-medium">{item.title}</h3><span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs capitalize">{item.status}</span></div>
      {item.currentStep && <p className="mt-2 text-xs text-muted-foreground">{item.currentStep}</p>}
      {item.plan.length > 0 && <ol className="mt-2 space-y-1">{item.plan.map((step, index) => <li key={index} className="text-xs"><span className="mr-1 text-muted-foreground">{step.status === "done" ? "✓" : step.status === "active" ? "→" : "○"}</span>{step.title}</li>)}</ol>}
      {item.error && <p className="mt-2 text-xs text-destructive">{item.error.slice(0, 400)}</p>}
      <Link href={`/work${item.taskId ? `#task-${item.taskId}` : ""}`} className="mt-2 inline-block text-xs underline">Open Work</Link>
      <Link href={`/chat/${item.conversationId}`} className="ml-3 text-xs underline">Open chat</Link>
    </article>)}
    <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={history} onChange={(event) => setHistory(event.target.checked)} />Include completed history</label>
    {work && work.length >= (history ? 100 : 25) && <p className="mt-2 text-xs text-muted-foreground">Showing the most recent work. <Link href="/work" className="underline">Open Work for more.</Link></p>}
  </div>;
}
