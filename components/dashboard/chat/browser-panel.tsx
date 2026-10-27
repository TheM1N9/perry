"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, MoreHorizontalIcon, GlobeIcon, PauseIcon, PlayIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InfoTip } from "../common";
import { Spinner } from "./work";
import { BrowserImportDialog } from "./browser-import-dialog";
import { useSession } from "@/lib/session";
import { browserIdentity, browserState, importPreview, importProfile, importResult, type BrowserRequest, type BrowserState } from "@/lib/browser-protocol";

const frameSchema = z.object({ image: z.string(), identity: browserIdentity, capturedAt: z.number() });
const sessionsSchema = z.array(z.object({ site: z.string(), source: z.string(), count: z.number(), note: z.string() }));

/** The Browser surface of the chat panel (panel/chat-panel.tsx), which owns opening, closing, resizing and widening it. */
export function BrowserPanel({ conversationId, onClose }: { conversationId: string; onClose?: () => void }) {
  const { dashboardKey } = useSession();
  const [state, setState] = useState<BrowserState | null>(null);
  const stateRef = useRef(state);
  const [frame, setFrame] = useState<z.infer<typeof frameSchema> | null>(null);
  const [connection, setConnection] = useState("Connecting");
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [typing, setTyping] = useState("");
  const [dialogText, setDialogText] = useState("");
  const [settings, setSettings] = useState(false);
  const [profiles, setProfiles] = useState<z.infer<typeof importProfile>[]>([]);
  const [profile, setProfile] = useState("");
  const [preview, setPreview] = useState<z.infer<typeof importPreview> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [results, setResults] = useState<z.infer<typeof importResult>>([]);
  const [sessions, setSessions] = useState<z.infer<typeof sessionsSchema>>([]);
  const [busy, setBusy] = useState(false);
  const requests = useRef<AbortController | null>(null);
  const manualQueue = useRef(Promise.resolve());
  const currentTab = state?.tabs.find((item) => item.id === state.identity?.tabId);
  const paused = state?.state === "paused";
  const activeIdentity = state?.identity;
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    return () => { controller.abort(); stateRef.current = null; };
  }, [conversationId, dashboardKey]);

  const call = useCallback(async (request: BrowserRequest, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch("/api/browser", { method: "POST", headers: { "content-type": "application/json", "x-perry-key": dashboardKey }, body: JSON.stringify({ conversationId, request }), cache: "no-store", signal: AbortSignal.any([...(signal ? [signal] : []), ...(requests.current ? [requests.current.signal] : [])]) });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(data).error);
    return data;
  }, [conversationId, dashboardKey]);
  const apply = useCallback((next: BrowserState) => { stateRef.current = next; setState(next); }, []);

  // The panel's width in device pixels, in steps, so the frames Chrome sends are as sharp as the panel and no bigger.
  const sectionRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.min(1280, Math.max(320, Math.ceil(element.clientWidth * (window.devicePixelRatio || 1) / 160) * 160)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // One open response the server writes the browser's state and its frames to as they change (server/browser-stream.ts);
  // dropped, it is opened again after a second.
  useEffect(() => {
    if (!width) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout>;
    let abort = new AbortController();
    async function listen() {
      abort = new AbortController();
      try {
        const response = await fetch("/api/browser/stream", { method: "POST", headers: { "content-type": "application/json", "x-perry-key": dashboardKey }, body: JSON.stringify({ conversationId, width }), cache: "no-store", signal: abort.signal });
        if (!response.ok || !response.body) throw new Error(z.object({ error: z.string() }).safeParse(await response.json().catch(() => null)).data?.error ?? "Browser connection lost. Retrying.");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !active) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const message = z.union([z.object({ state: browserState }), z.object({ frame: frameSchema })]).parse(JSON.parse(line));
            if ("state" in message) {
              apply(message.state);
              if (!message.state.identity) setFrame(null);
              setConnection(message.state.state === "disconnected" ? "Disconnected" : "Connected"); setConnectionError("");
            } else setFrame(message.frame);
          }
        }
        if (active) throw new Error("Browser connection lost. Retrying.");
      } catch (cause) {
        if (!active) return;
        setFrame(null); setConnection("Reconnecting"); setConnectionError(cause instanceof Error ? cause.message : "Browser connection lost. Retrying.");
        retry = setTimeout(() => void listen(), 1000);
      }
    }
    void listen();
    return () => { active = false; clearTimeout(retry); abort.abort(); setFrame(null); };
  }, [conversationId, dashboardKey, width, apply]);

  // A wheel sends many small turns: added up while one scroll is on its way, and sent as one after.
  const wheel = useRef<{ busy: boolean; deltaY: number; at: { x: number; y: number } }>({ busy: false, deltaY: 0, at: { x: 0, y: 0 } });
  async function scroll(at: { x: number; y: number }, deltaY: number) {
    const expected = stateRef.current?.identity;
    const pending = wheel.current;
    pending.deltaY += deltaY; pending.at = at;
    if (pending.busy) return;
    pending.busy = true;
    try {
      while (pending.deltaY) {
        const current = stateRef.current;
        const amount = Math.max(-3000, Math.min(3000, pending.deltaY));
        pending.deltaY = 0;
        if (current?.state !== "paused" || !expected || JSON.stringify(current.identity) !== JSON.stringify(expected)) break;
        await call({ action: "scroll", identity: expected, ...pending.at, deltaY: amount }).catch(() => {});
      }
    } finally { pending.busy = false; pending.deltaY = 0; }
  }
  useEffect(() => { setUrl(currentTab?.url === "about:blank" ? "" : currentTab?.url ?? ""); }, [currentTab?.url]);

  async function act(request: BrowserRequest) {
    setError("");
    try { const next = browserState.parse(await call(request)); apply(next); if (next.state === "closed" || next.state === "disconnected") setFrame(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Browser action failed."); setFrame(null); }
  }
  function manual(request: Omit<Extract<BrowserRequest, { action: "text" }>, "identity"> | Omit<Extract<BrowserRequest, { action: "key" }>, "identity">) {
    // Serialize owner keystrokes without ever queuing agent actions.
    const expected = stateRef.current?.identity;
    manualQueue.current = manualQueue.current.then(async () => {
      const current = stateRef.current;
      if (current?.state === "paused" && expected && JSON.stringify(current.identity) === JSON.stringify(expected)) await act({ ...request, identity: expected });
    });
  }
  async function run<T>(work: () => Promise<T>) {
    setBusy(true); setError("");
    try { return await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Browser operation failed."); }
    finally { setBusy(false); }
  }
  async function openSettings() {
    setSettings((value) => !value);
    if (state?.importEnabled) await run(async () => setProfiles(z.array(importProfile).parse(await call({ action: "profiles" })).filter(item => item.browser === "Firefox")));
    if (paused && activeIdentity && state?.source !== "chrome") await run(async () => setSessions(sessionsSchema.parse(await call({ action: "sessions", identity: activeIdentity }))));
  }
  const point = (event: { currentTarget: HTMLElement; clientX: number; clientY: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1280, (event.clientX - rect.left) * 1280 / rect.width)), y: Math.max(0, Math.min(900, (event.clientY - rect.top) * 900 / rect.height)) };
  };
  const visibleFrame = frame && state?.identity && JSON.stringify(frame.identity) === JSON.stringify(state.identity) && connection === "Connected" ? frame : null;

  const open = Boolean(state?.identity);
  const status = connection !== "Connected" ? { text: connection === "Connecting" ? "Connecting…" : `${connection}…`, tone: "bg-muted-foreground/50" }
    : paused ? { text: "You're in control", tone: "bg-warning" }
    : state?.state === "live" ? { text: "Perry is browsing", tone: "bg-success motion-safe:animate-pulse" }
    : { text: "Not open", tone: "bg-muted-foreground/40" };

  return <section ref={sectionRef} className="flex h-full min-h-0 flex-col text-sm" aria-label="Live browser" data-browser-state={state?.state ?? "loading"}>
    <div className="flex shrink-0 items-center gap-2 px-3 py-2">
      <span className={`size-2 shrink-0 rounded-full ${status.tone}`} aria-hidden />
      <span role="status" className="mr-auto min-w-0 truncate text-xs font-medium text-muted-foreground">{state?.source === "chrome" ? "Chrome · " : ""}{status.text}{state?.loading ? " · Loading" : ""}</span>
      {open && (paused ? <Button size="sm" onClick={() => activeIdentity && void act({ action: "resume", identity: activeIdentity })}><PlayIcon />Resume Perry</Button>
        : <Button size="sm" variant="outline" onClick={() => { setFrame(null); void act({ action: "takeover" }); }}><PauseIcon />Pause & take over</Button>)}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Browser actions" />}><MoreHorizontalIcon /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {state?.importEnabled && <DropdownMenuItem onClick={() => setImportOpen(true)}>Import from browser</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => void openSettings()}>Connections</DropdownMenuItem>
          {open && <DropdownMenuItem disabled={!paused} onClick={() => activeIdentity && void act({ action: "close", identity: activeIdentity })}>{state?.source === "chrome" ? "Disconnect Chrome" : "Close browser"}</DropdownMenuItem>}
          {onClose && <DropdownMenuItem onClick={onClose}>Return to chat</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {open && <div className="shrink-0 border-y bg-muted/30">
      {state && state.tabs.length > 0 && (paused || state.tabs.length > 1) && <div className="flex items-center gap-1 overflow-x-auto px-2 pt-1.5" aria-label="Browser tabs">
        {state.tabs.map((tab) => {
          const current = tab.id === state.identity?.tabId;
          return <span key={tab.id} className={`flex h-7 max-w-44 shrink-0 items-center rounded-md text-xs ${current ? "bg-background shadow-xs ring-1 ring-border" : "text-muted-foreground"}`}>
            <button type="button" disabled={!paused || current} className="min-w-0 truncate px-2.5 py-1 enabled:cursor-pointer enabled:hover:text-foreground" onClick={() => state.identity && void act({ action: "tab", identity: state.identity, tabId: tab.id })}>{tab.title || "New tab"}</button>
            {current && paused && <Button size="icon-xs" variant="ghost" className="mr-0.5 size-5" aria-label="Close current browser tab" onClick={() => state.identity && void act({ action: "closeTab", identity: state.identity })}><XIcon className="size-3" /></Button>}
          </span>;
        })}
        {paused && <Button size="icon-sm" variant="ghost" className="size-7" aria-label="New browser tab" onClick={() => state.identity && void act({ action: "newTab", identity: state.identity })}><PlusIcon /></Button>}
      </div>}
      <form className="flex items-center gap-1 p-1.5" onSubmit={(event) => { event.preventDefault(); if (state?.identity && url) void act({ action: "navigate", identity: state.identity, url: /^https?:\/\//i.test(url) ? url : `https://${url}` }); }}>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Go back" disabled={!paused} onClick={() => state?.identity && void act({ action: "back", identity: state.identity })}><ArrowLeftIcon /></Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Reload browser page" disabled={!paused} onClick={() => state?.identity && void act({ action: "reload", identity: state.identity })}><RefreshCwIcon /></Button>
        <Input aria-label="Browser address" value={url} disabled={!paused} onChange={(event) => setUrl(event.target.value)} onFocus={(event) => event.currentTarget.select()} className="h-8 min-w-0 flex-1 rounded-full bg-background px-3 text-xs disabled:opacity-100 disabled:text-muted-foreground" placeholder={paused ? "Type an address" : ""} />
        <Button type="submit" size="icon-sm" variant="ghost" aria-label="Go to address" className={paused && url && url !== currentTab?.url ? "" : "hidden"}><ArrowRightIcon /></Button>
      </form>
    </div>}
    {connectionError && !error && <p role="status" className="border-b p-3 text-muted-foreground">{connectionError}</p>}
    {error && <p role="alert" className="border-b p-3 text-destructive">{error}</p>}
    {state?.error && <p role="alert" className="border-b p-3 text-destructive">{state.error}</p>}
    <div className="min-h-0 flex-1 overflow-auto">
      {!open && state ? <div className="flex flex-col items-center px-6 py-14 text-center" data-browser-empty>
        <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground"><GlobeIcon className="size-5" /></span>
        <p className="mt-3 text-sm font-medium">Perry's browser</p>
        <p className="mt-1 max-w-64 text-xs leading-relaxed text-muted-foreground">Perry browses here for this chat. Watch it work, or take over to sign in somewhere for it.</p>
        <Button size="sm" className="mt-4" disabled={busy} onClick={() => void run(() => act({ action: "start" }))}>{busy ? "Opening…" : "Open browser"}</Button>
      </div> : visibleFrame ? <div className="p-2"><div role="application" aria-label={paused ? "Browser page. Click to focus, type or paste; Tab moves within the page. Escape returns focus to browser controls." : "Browser page, view only. Pause to take over."} tabIndex={paused ? 0 : -1} className="group/page relative aspect-[1280/900] w-full overflow-hidden rounded-md bg-white ring-1 ring-border outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
        onClick={(event) => {
          // Where the click fell, read before focusing: focus must not scroll the panel and move the page under it.
          const at = point(event);
          event.currentTarget.focus({ preventScroll: true });
          if (paused && activeIdentity) void act({ action: "click", identity: activeIdentity, ...at });
        }}
        onWheel={(event) => { if (paused) void scroll(point(event), event.deltaY); }}
        onPaste={(event) => { if (paused) { event.preventDefault(); manual({ action: "text", text: event.clipboardData.getData("text").slice(0, 10000) }); } }}
        onKeyDown={(event) => {
          if (!paused) return;
          if (event.key === "Escape") { event.currentTarget.blur(); return; }
          if (event.key === "v" && (event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) manual({ action: "text", text: event.key });
          else manual({ action: "key", key: event.key, code: event.code, keyCode: event.keyCode, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
        }}>
        {/* Owner-only ephemeral image. No URL key, media record, disk capture or model attachment. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/jpeg;base64,${visibleFrame.image}`} alt={`Live page: ${currentTab?.title || "Browser"}`} draggable={false} className="pointer-events-none h-full w-full" />
        {!paused && <span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-foreground/75 px-2.5 py-1 text-2xs font-medium text-background opacity-0 transition-opacity group-hover/page:opacity-100">View only · take over to use it</span>}
      </div></div> : <div className="p-2"><div className="grid aspect-[1280/900] w-full place-items-center rounded-md bg-muted/40 text-xs text-muted-foreground ring-1 ring-border"><p className="flex items-center gap-2"><Spinner />{connection !== "Connected" ? `${connection}…` : "Loading page…"}</p></div></div>}
      {paused && <Collapsible className="px-3 py-1">
        <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="group -ml-2 text-muted-foreground" />}><ChevronRightIcon className="transition-transform group-data-panel-open:rotate-90" />Type into page</CollapsibleTrigger>
        <CollapsibleContent className="pt-2"><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (typing) { manual({ action: "text", text: typing }); setTyping(""); } }}>
          <Input type="password" autoComplete="off" value={typing} onChange={(event) => setTyping(event.target.value)} aria-label="Text for the focused browser field" placeholder="Text for the focused page field" className="min-w-0 flex-1" />
          <Button type="submit" size="sm" variant="outline" disabled={!typing}>Type</Button>
        </form></CollapsibleContent>
      </Collapsible>}
      {state?.dialog && <div className="space-y-2 border-t p-3"><p>Page {state.dialog.type}: {state.dialog.message}</p>{state.dialog.type === "prompt" && <Input aria-label="Page dialog response" type="password" autoComplete="off" value={dialogText} onChange={(event) => setDialogText(event.target.value)} className="w-full" />}<Button size="sm" disabled={!paused} onClick={() => state.identity && void act({ action: "dialog", identity: state.identity, accept: true, text: dialogText })}>Accept dialog</Button>{" "}<Button size="sm" variant="outline" disabled={!paused} onClick={() => state.identity && void act({ action: "dialog", identity: state.identity, accept: false })}>Dismiss</Button></div>}
      {state?.upload && paused && <label className="block border-t p-3">Choose a file for this page<Input type="file" className="mt-2 block max-w-full" onChange={(event) => { const file = event.target.files?.[0]; const identity = state.identity; if (!file || !identity) return; void run(async () => { const response = await fetch("/api/browser/upload", { method: "POST", headers: { "x-perry-key": dashboardKey, "x-perry-chat": conversationId, "x-browser-identity": JSON.stringify(identity), "x-file-name": encodeURIComponent(file.name) }, body: file }); const result: unknown = await response.json(); if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error); apply(browserState.parse(result)); }); }} /></label>}
      {!!state?.downloads.length && <div className="border-t p-3"><p className="font-medium">Downloads</p>{state.downloads.map((download) => <p key={download.id} className="break-words">{download.name} · {download.state === "completed" ? "Saved to this chat’s Files" : download.state}</p>)}</div>}
      {settings && <div className="space-y-3 border-t p-3">
        <div className="flex items-center justify-between"><p className="font-medium">Connections</p><Button size="icon-sm" variant="ghost" aria-label="Close connections" onClick={() => setSettings(false)}><XIcon /></Button></div>
        {state?.identity && <label className="flex items-center gap-2 text-xs"><Checkbox checked={state.private} disabled={!paused} onCheckedChange={(checked) => activeIdentity && void act({ action: "privacy", identity: activeIdentity, private: checked })} /><span>Hide agent screenshots<InfoTip>Perry can still read page text after you resume.</InfoTip></span></label>}
        {!state?.importEnabled ? <p className="text-xs text-muted-foreground">Open Perry locally to connect your browser.</p> : <>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>Import from browser</Button>
          {profiles.length > 0 && state?.source !== "chrome" && <Collapsible>
          <CollapsibleTrigger render={<Button size="sm" variant="ghost" className="group -ml-2" />}><ChevronRightIcon className="group-data-panel-open:rotate-90" />Import from Firefox</CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
          <Select value={profile || null} items={profiles.map((item) => ({ value: item.id, label: `${item.browser} · ${item.label}` }))} onValueChange={(value) => { if (typeof value === "string") { setProfile(value); setPreview(null); setConfirmed(false); } }}>
            <SelectTrigger aria-label="Source browser profile" className="w-full"><SelectValue placeholder="Firefox profile" /></SelectTrigger>
            <SelectContent alignItemWithTrigger={false} className="max-w-80">{profiles.map((item) => <SelectItem key={item.id} value={item.id} disabled={!item.supported}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={!profile || !paused || busy} onClick={() => void run(async () => { const next = importPreview.parse(await call({ action: "previewImport", profileId: profile })); setPreview(next); const here = currentTab?.url && /^https?:/.test(currentTab.url) ? new URL(currentTab.url).hostname : ""; setSelected(next.sites.filter((site) => site.site === here && site.supported).map((site) => site.site)); setConfirmed(false); setResults([]); })}>Preview sites</Button>
          {profiles.every(item => !item.supported) && <p className="text-xs text-muted-foreground">Close Firefox to use its profile.</p>}
          {preview && <>
            <Button size="sm" variant="ghost" onClick={() => { setSelected(preview.sites.filter((site) => site.supported).map((site) => site.site)); setConfirmed(false); }}>Select all supported sites</Button>
            <div className="max-h-60 space-y-2 overflow-auto">{preview.sites.map((site) => <label key={site.site} className="flex items-start gap-2"><Checkbox className="mt-1" disabled={!site.supported} checked={selected.includes(site.site)} onCheckedChange={(checked) => { setSelected((items) => checked ? [...items, site.site] : items.filter((item) => item !== site.site)); setConfirmed(false); }} /><span className="min-w-0 flex-1"><span className="block break-all">{site.site}</span><span className="block text-xs leading-relaxed text-muted-foreground">{site.supported} supported · {site.expired} expired · {site.unsupported} unsupported · {site.replaces} destination cookies replaced</span></span></label>)}</div>
            <label className="flex items-start gap-2 text-xs"><Checkbox className="mt-0.5" checked={confirmed} onCheckedChange={setConfirmed} /><span>Allow {selected.length} sites and replace their sessions.</span></label>
            <Button size="sm" disabled={!confirmed || !selected.length || busy || !paused} onClick={() => activeIdentity && void run(async () => { setResults(importResult.parse(await call({ action: "import", identity: activeIdentity, ticket: preview.ticket, sites: selected, confirmed: true }))); setPreview(null); setConfirmed(false); setSessions(sessionsSchema.parse(await call({ action: "sessions", identity: activeIdentity }))); })}>Import</Button>
          </>}
          </CollapsibleContent></Collapsible>}
        </>}
        {results.map((result) => <p key={result.site} role="status" className="text-xs">{result.site} · {result.status} ({result.count}): {result.note}</p>)}
        {!!sessions.length && state?.source !== "chrome" && <><p className="font-medium">Imported sites</p>{sessions.map((item) => <div key={item.site} className="flex items-center justify-between gap-2"><p className="truncate text-xs">{item.site}</p><Button size="sm" variant="outline" disabled={!paused || busy} onClick={() => activeIdentity && void run(async () => { await call({ action: "removeSession", identity: activeIdentity, site: item.site }); setSessions((items) => items.filter((entry) => entry.site !== item.site)); })}>Remove</Button></div>)}</>}
      </div>}
    </div>
    <BrowserImportDialog open={importOpen} onOpenChange={setImportOpen} state={state} call={call} apply={apply} />
  </section>;
}
