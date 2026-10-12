"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowLeftIcon, GlobeIcon, PauseIcon, PlayIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    if (state?.importEnabled) await run(async () => setProfiles(z.array(importProfile).parse(await call({ action: "profiles" }))));
    if (paused && activeIdentity) await run(async () => setSessions(sessionsSchema.parse(await call({ action: "sessions", identity: activeIdentity }))));
  }
  const point = (event: { currentTarget: HTMLElement; clientX: number; clientY: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1280, (event.clientX - rect.left) * 1280 / rect.width)), y: Math.max(0, Math.min(900, (event.clientY - rect.top) * 900 / rect.height)) };
  };
  const visibleFrame = frame && state?.identity && JSON.stringify(frame.identity) === JSON.stringify(state.identity) && connection === "Connected" ? frame : null;

  return <section className="flex h-full min-h-0 flex-col text-sm" aria-label="Live browser">
    <div className="flex flex-wrap items-center gap-2 border-b p-3">
      <GlobeIcon className="size-4" aria-hidden />
      <span role="status" className="mr-auto font-medium">{connection !== "Connected" ? connection : state?.state === "paused" ? "Paused · You control" : state?.state === "live" ? "Live · Perry controls" : "Browser closed"}{state?.loading ? " · Loading" : ""}</span>
      {state?.identity ? <>
        {paused ? <Button size="sm" variant="outline" onClick={() => activeIdentity && void act({ action: "resume", identity: activeIdentity })}><PlayIcon />Resume Perry</Button>
          : <Button size="sm" onClick={() => { setFrame(null); void act({ action: "takeover" }); }}><PauseIcon />Pause & take over</Button>}
        <Button size="sm" variant="ghost" onClick={() => activeIdentity && void act({ action: "close", identity: activeIdentity })} disabled={!paused}>Close browser</Button>
      </> : <Button size="sm" onClick={() => void act({ action: "start" })}>Open browser</Button>}
      {onClose && <Button size="icon-sm" variant="ghost" aria-label="Return to chat" onClick={onClose}><XIcon /></Button>}
    </div>
    {state?.tabs.length ? <div className="flex shrink-0 gap-1 overflow-x-auto border-b p-2" aria-label="Browser tabs">
      {state.tabs.map((tab) => <Button key={tab.id} size="sm" variant={tab.id === state.identity?.tabId ? "secondary" : "ghost"} disabled={!paused} className="max-w-44 shrink-0" onClick={() => state.identity && void act({ action: "tab", identity: state.identity, tabId: tab.id })}><span className="truncate">{tab.title || "New tab"}</span></Button>)}
      <Button size="icon-sm" variant="ghost" aria-label="New browser tab" disabled={!paused} onClick={() => state.identity && void act({ action: "newTab", identity: state.identity })}><PlusIcon /></Button>
      <Button size="icon-sm" variant="ghost" aria-label="Close current browser tab" disabled={!paused} onClick={() => state.identity && void act({ action: "closeTab", identity: state.identity })}><XIcon /></Button>
    </div> : null}
    <form className="flex shrink-0 gap-1 border-b p-2" onSubmit={(event) => { event.preventDefault(); if (state?.identity) void act({ action: "navigate", identity: state.identity, url: /^https?:\/\//i.test(url) ? url : `https://${url}` }); }}>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Go back" disabled={!paused} onClick={() => state?.identity && void act({ action: "back", identity: state.identity })}><ArrowLeftIcon /></Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Reload browser page" disabled={!paused} onClick={() => state?.identity && void act({ action: "reload", identity: state.identity })}><RefreshCwIcon /></Button>
      <input aria-label="Browser address" value={url} disabled={!paused} onChange={(event) => setUrl(event.target.value)} className="min-w-0 flex-1 rounded border bg-background px-2 py-1" placeholder="https://example.com" />
      <Button type="submit" size="sm" variant="outline" disabled={!paused || !url}>Go</Button>
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
      </div> : <div className="grid min-h-48 place-items-center p-6 text-center text-muted-foreground"><p>{state?.state === "closed" ? "Open the browser to navigate or sign in manually." : connection !== "Connected" ? "Reconnecting to the browser. Previous frames are hidden." : "Waiting for a current frame…"}</p></div>}
      {paused && <form className="flex gap-2 border-t p-2" onSubmit={(event) => { event.preventDefault(); if (typing) { manual({ action: "text", text: typing }); setTyping(""); } }}><input type="password" autoComplete="off" value={typing} onChange={(event) => setTyping(event.target.value)} aria-label="Text for the focused browser field" placeholder="Type into the focused page field" className="min-w-0 flex-1 rounded border px-2 py-1" /><Button type="submit" size="sm" variant="outline">Type</Button></form>}
      {state?.dialog && <div className="space-y-2 border-t p-3"><p>Page {state.dialog.type}: {state.dialog.message}</p>{state.dialog.type === "prompt" && <input aria-label="Page dialog response" type="password" autoComplete="off" value={dialogText} onChange={(event) => setDialogText(event.target.value)} className="w-full rounded border p-2" />}<Button size="sm" disabled={!paused} onClick={() => state.identity && void act({ action: "dialog", identity: state.identity, accept: true, text: dialogText })}>Accept dialog</Button>{" "}<Button size="sm" variant="outline" disabled={!paused} onClick={() => state.identity && void act({ action: "dialog", identity: state.identity, accept: false })}>Dismiss</Button></div>}
      {state?.upload && paused && <label className="block border-t p-3">Choose a file for this page<input type="file" className="mt-2 block max-w-full" onChange={(event) => { const file = event.target.files?.[0]; const identity = state.identity; if (!file || !identity) return; void run(async () => { const response = await fetch("/api/browser/upload", { method: "POST", headers: { "x-perry-key": dashboardKey, "x-perry-chat": conversationId, "x-browser-identity": JSON.stringify(identity), "x-file-name": encodeURIComponent(file.name) }, body: file }); const result: unknown = await response.json(); if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error); apply(browserState.parse(result)); }); }} /></label>}
      {!!state?.downloads.length && <div className="border-t p-3"><p className="font-medium">Downloads</p>{state.downloads.map((download) => <p key={download.id} className="break-words">{download.name} · {download.state === "completed" ? "Saved to this chat’s Files" : download.state}</p>)}</div>}
      <div className="space-y-2 border-t p-3 text-xs text-muted-foreground">
        <p>This is the same browser Perry controls. Manual sign-in stays in this chat’s browser profile. Closing this panel keeps the session and never resumes automation.</p>
        <p>Live frames are sent only to your unlocked dashboard and are not recorded. Page text is visible to Perry when automation resumes. Agent screenshots can contain sensitive page content.</p>
        {state?.identity && <label className="flex items-center gap-2"><input type="checkbox" checked={state.private} disabled={!paused} onChange={(event) => activeIdentity && void act({ action: "privacy", identity: activeIdentity, private: event.target.checked })} />Block agent screenshots and step previews (recommended during sign-in)</label>}
        <Button size="sm" variant="outline" onClick={() => void openSettings()} aria-expanded={settings}>Sessions & import</Button>
      </div>
      {settings && <div className="space-y-3 border-t p-3">
        <p className="font-medium">Import selected login sessions</p>
        {!state?.importEnabled ? <p className="text-muted-foreground">Import is unavailable. It requires PERRY_BROWSER_IMPORT=1 and a local connection on the browser host. You can sign in manually after taking over.</p> : <>
          <p className="text-xs text-muted-foreground">Close Firefox normally, choose a profile, then preview sites. This is a one-time cookie snapshot. Passwords, history, extensions and other site storage are excluded. Chrome, Edge, Brave and Safari import are unsupported.</p>
          <select aria-label="Source browser profile" className="w-full rounded border bg-background p-2" value={profile} onChange={(event) => { setProfile(event.target.value); setPreview(null); setConfirmed(false); }}><option value="">Choose a browser profile</option>{profiles.map((item) => <option key={item.id} value={item.id} disabled={!item.supported}>{item.browser} · {item.label}{item.reason ? ` · ${item.reason}` : ""}</option>)}</select>
          <Button size="sm" variant="outline" disabled={!profile || !paused || busy} onClick={() => void run(async () => { const next = importPreview.parse(await call({ action: "previewImport", profileId: profile })); setPreview(next); const here = currentTab?.url && /^https?:/.test(currentTab.url) ? new URL(currentTab.url).hostname : ""; setSelected(next.sites.filter((site) => site.site === here && site.supported).map((site) => site.site)); setConfirmed(false); setResults([]); })}>Preview sites</Button>
          {!paused && <p>Pause and take over to preview or import.</p>}
          {preview && <>
            <p className="text-xs">Destination: {preview.destination}. Checked sites give Perry access to those accounts. Existing cookies for each checked domain are replaced, including its existing account. Other domains stay unchanged.</p>
            <Button size="sm" variant="outline" onClick={() => { setSelected(preview.sites.filter((site) => site.supported).map((site) => site.site)); setConfirmed(false); }}>Select all supported sites</Button>
            <p className="text-xs text-muted-foreground">Select all grants access to every supported domain in this profile; choose only the accounts you intend to share.</p>
            <div className="max-h-60 space-y-2 overflow-auto">{preview.sites.map((site) => <label key={site.site} className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={!site.supported} checked={selected.includes(site.site)} onChange={(event) => { setSelected((items) => event.target.checked ? [...items, site.site] : items.filter((item) => item !== site.site)); setConfirmed(false); }} /><span className="break-all">{site.site}<span className="block text-xs text-muted-foreground">{site.supported} supported · {site.expired} expired · {site.unsupported} unsupported · {site.replaces} destination cookies replaced</span></span></label>)}</div>
            <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I confirm access to these {selected.length} domains and replacement of their destination sessions.</label>
            <Button size="sm" disabled={!confirmed || !selected.length || busy || !paused} onClick={() => activeIdentity && void run(async () => { setResults(importResult.parse(await call({ action: "import", identity: activeIdentity, ticket: preview.ticket, sites: selected, confirmed: true }))); setPreview(null); setConfirmed(false); setSessions(sessionsSchema.parse(await call({ action: "sessions", identity: activeIdentity }))); })}>Import confirmed sites</Button>
          </>}
        </>}
        {results.map((result) => <p key={result.site} role="status" className="text-xs">{result.site} · {result.status} ({result.count}): {result.note}</p>)}
        {!!sessions.length && <><p className="font-medium">Imported sites</p>{sessions.map((item) => <div key={item.site} className="space-y-1"><p>{item.site} · {item.count} cookies · {item.source}</p><p className="text-xs text-muted-foreground">{item.note}</p><Button size="sm" variant="outline" disabled={!paused || busy} onClick={() => activeIdentity && void run(async () => { await call({ action: "removeSession", identity: activeIdentity, site: item.site }); setSessions((items) => items.filter((entry) => entry.site !== item.site)); })}>Remove local session for {item.site}</Button></div>)}</>}
      </div>}
    </div>
  </section>;
}
