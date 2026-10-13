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
import { useSession } from "@/lib/session";
import { browserIdentity, browserState, importPreview, importProfile, importResult, type BrowserRequest, type BrowserState } from "@/lib/browser-protocol";

const frameSchema = z.object({ image: z.string(), identity: browserIdentity, capturedAt: z.number() });
const sessionsSchema = z.array(z.object({ site: z.string(), source: z.string(), count: z.number(), note: z.string() }));

/** Content slot for #285's WorkspacePanel. The shared shell owns open/close, resizing and expansion. */
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
  const manualQueue = useRef(Promise.resolve());
  const currentTab = state?.tabs.find((item) => item.id === state.identity?.tabId);
  const paused = state?.state === "paused";
  const activeIdentity = state?.identity;
  const chromeConnected = state?.source === "chrome" && !!activeIdentity;

  const call = useCallback(async (request: BrowserRequest, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch("/api/browser", { method: "POST", headers: { "content-type": "application/json", "x-perry-key": dashboardKey }, body: JSON.stringify({ conversationId, request }), cache: "no-store", signal });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(data).error);
    return data;
  }, [conversationId, dashboardKey]);
  const apply = useCallback((next: BrowserState) => { stateRef.current = next; setState(next); }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    async function poll() {
      try {
        const next = browserState.parse(await call({ action: "status" }, AbortSignal.any([abort.signal, AbortSignal.timeout(5000)])));
        if (!active) return;
        apply(next);
        if (next.identity && ["live", "paused"].includes(next.state)) {
          const shot = frameSchema.parse(await call({ action: "frame", identity: next.identity }, AbortSignal.any([abort.signal, AbortSignal.timeout(5000)])));
          if (!active) return;
          // Never display a frame across a page, session or controller change.
          if (JSON.stringify(stateRef.current?.identity) === JSON.stringify(shot.identity)) setFrame(shot);
          else setFrame(null);
        } else setFrame(null);
        setConnection(next.state === "disconnected" ? "Disconnected" : "Connected"); setConnectionError("");
      } catch (cause) {
        if (!active) return;
        setFrame(null); setConnection("Reconnecting"); setConnectionError(cause instanceof Error ? cause.message : "Browser connection lost. Retrying.");
      } finally { if (active) timer = setTimeout(() => void poll(), document.hidden ? 5000 : 1000); }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); abort.abort(); setFrame(null); };
  }, [call, apply]);
  useEffect(() => { setUrl(currentTab?.url === "about:blank" ? "" : currentTab?.url ?? ""); }, [currentTab?.url]);

  async function act(request: BrowserRequest) {
    setError("");
    try { const next = browserState.parse(await call(request)); apply(next); if (next.state === "closed" || next.state === "disconnected") setFrame(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Browser action failed."); setFrame(null); }
  }
  function manual(request: Omit<Extract<BrowserRequest, { action: "text" }>, "identity"> | Omit<Extract<BrowserRequest, { action: "key" }>, "identity">) {
    // Serialize owner keystrokes without ever queuing agent actions.
    manualQueue.current = manualQueue.current.then(async () => {
      const current = stateRef.current;
      if (current?.state === "paused" && current.identity) await act({ ...request, identity: current.identity });
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

  return <section className="flex h-full min-h-0 flex-col text-sm" aria-label="Live browser">
    <div className="flex flex-wrap items-center gap-2 px-3 py-3">
      <GlobeIcon className="size-4 text-muted-foreground" aria-hidden />
      <span role="status" className="mr-auto text-xs font-medium">{state?.source === "chrome" ? "Chrome · " : ""}{connection !== "Connected" ? connection : state?.state === "paused" ? "You control" : state?.state === "live" ? "Perry controls" : "Browser closed"}{state?.loading ? " · Loading" : ""}</span>
      {state?.identity ? <>
        {paused ? <Button size="sm" onClick={() => activeIdentity && void act({ action: "resume", identity: activeIdentity })}><PlayIcon />Resume Perry</Button>
          : <Button size="sm" onClick={() => { setFrame(null); void act({ action: "takeover" }); }}><PauseIcon />Pause & take over</Button>}
      </> : <><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => act({ action: "start" }))}>Open browser</Button>{state?.importEnabled && <Button size="sm" disabled={busy} onClick={() => void run(() => act({ action: "connectChrome" }))}>{busy ? "Connecting…" : "Connect Chrome"}</Button>}</>}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Browser actions" />}><MoreHorizontalIcon /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onClick={() => void openSettings()}>Connections</DropdownMenuItem>
          <DropdownMenuItem disabled={!paused} onClick={() => activeIdentity && void act({ action: "close", identity: activeIdentity })}>{state?.source === "chrome" ? "Disconnect Chrome" : "Close browser"}</DropdownMenuItem>
          {onClose && <DropdownMenuItem onClick={onClose}>Return to chat</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {state?.tabs.length ? <div className="flex shrink-0 gap-1 overflow-x-auto bg-muted/40 px-2 py-1.5" aria-label="Browser tabs">
      {state.tabs.map((tab) => <Button key={tab.id} size="sm" variant={tab.id === state.identity?.tabId ? "secondary" : "ghost"} disabled={!paused} className="h-7 max-w-44 shrink-0 text-xs" onClick={() => state.identity && void act({ action: "tab", identity: state.identity, tabId: tab.id })}><span className="truncate">{tab.title || "New tab"}</span></Button>)}
      <Button size="icon-sm" variant="ghost" aria-label="New browser tab" disabled={!paused} onClick={() => state.identity && void act({ action: "newTab", identity: state.identity })}><PlusIcon /></Button>
      <Button size="icon-sm" variant="ghost" aria-label="Close current browser tab" disabled={!paused} onClick={() => state.identity && void act({ action: "closeTab", identity: state.identity })}><XIcon /></Button>
    </div> : null}
    <form className="flex shrink-0 gap-1 border-b p-2" onSubmit={(event) => { event.preventDefault(); if (state?.identity) void act({ action: "navigate", identity: state.identity, url: /^https?:\/\//i.test(url) ? url : `https://${url}` }); }}>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Go back" disabled={!paused} onClick={() => state?.identity && void act({ action: "back", identity: state.identity })}><ArrowLeftIcon /></Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Reload browser page" disabled={!paused} onClick={() => state?.identity && void act({ action: "reload", identity: state.identity })}><RefreshCwIcon /></Button>
      <Input aria-label="Browser address" value={url} disabled={!paused} onChange={(event) => setUrl(event.target.value)} className="min-w-0 flex-1 bg-muted/50 text-xs" placeholder="https://example.com" />
      <Button type="submit" size="icon-sm" variant="ghost" aria-label="Go to address" disabled={!paused || !url}><ArrowRightIcon /></Button>
    </form>
    {connectionError && !error && <p role="status" className="border-b p-3 text-muted-foreground">{connectionError}</p>}
    {error && <p role="alert" className="border-b p-3 text-destructive">{error}</p>}
    {state?.error && <p role="alert" className="border-b p-3 text-destructive">{state.error}</p>}
    <div className="min-h-0 flex-1 overflow-auto">
      {visibleFrame ? <div role="application" aria-label={paused ? "Browser page. Click to focus, type or paste; Tab moves within the page. Escape returns focus to browser controls." : "Browser page, view only. Pause to take over."} tabIndex={paused ? 0 : -1} className="relative aspect-[1280/900] w-full outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-primary"
        onClick={(event) => { event.currentTarget.focus(); if (paused && activeIdentity) void act({ action: "click", identity: activeIdentity, ...point(event) }); }}
        onWheel={(event) => { if (paused && activeIdentity) void act({ action: "scroll", identity: activeIdentity, ...point(event), deltaY: Math.max(-3000, Math.min(3000, event.deltaY)) }); }}
        onPaste={(event) => { if (paused) { event.preventDefault(); manual({ action: "text", text: event.clipboardData.getData("text").slice(0, 10000) }); } }}
        onKeyDown={(event) => {
          if (!paused) return;
          if (event.key === "Escape") { event.currentTarget.blur(); return; }
          if (event.key === "v" && (event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) manual({ action: "text", text: event.key });
          else manual({ action: "key", key: event.key, code: event.code, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
        }}>
        {/* Owner-only ephemeral image. No URL key, media record, disk capture or model attachment. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/jpeg;base64,${visibleFrame.image}`} alt={`Live page: ${currentTab?.title || "Browser"}`} draggable={false} className="pointer-events-none h-full w-full" />
      </div> : <div className="grid min-h-48 place-items-center p-6 text-center text-sm text-muted-foreground"><p>{state?.state === "closed" ? "No browser connected" : connection !== "Connected" ? "Reconnecting…" : "Loading page…"}</p></div>}
      {paused && <Collapsible className="border-t px-3 py-2">
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
          <div className="flex items-center justify-between gap-2"><span>Chrome<InfoTip>Enable remote debugging in chrome://inspect/#remote-debugging, then allow Chrome's connection prompt. Uses your signed-in session in new chat tabs.</InfoTip></span><Button size="sm" variant="outline" disabled={busy || (!!activeIdentity && (!paused || state?.source !== "chrome"))} onClick={() => void run(() => act(chromeConnected && activeIdentity ? { action: "close", identity: activeIdentity } : { action: "connectChrome" }))}>{chromeConnected ? "Disconnect" : busy ? "Connecting…" : "Connect"}</Button></div>
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
  </section>;
}
