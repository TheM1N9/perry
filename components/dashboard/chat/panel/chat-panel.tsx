"use client";

import {
  Component, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode,
} from "react";
import { BotIcon, FolderIcon, GaugeIcon, GlobeIcon, ListChecksIcon, Maximize2Icon, Minimize2Icon, PanelRightIcon, PlusIcon, XIcon, type LucideIcon } from "lucide-react";
import { useConnection, useConvex } from "@/client/react";
import type { Id } from "@/convex/_generated/dataModel";
import { matches } from "@/convex/lib/shortcuts";
import { useIsMobile } from "@/hooks/use-mobile";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { errorText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrowserPanel } from "../browser-panel";
import { Details, type ChatDetails } from "./details";
import { FilesSurface } from "./files";
import { usePanelState, type PanelState, type SurfaceId } from "./store";
import { WorkSurface } from "./work";
import { AgentsSurface } from "../agents";

/**
 * The panel beside a chat, after T3 Code's right panel (RightPanelTabs.tsx, PreviewPanelShell.tsx): tabs of
 * surfaces (Details, Files, Browser, Work), and "Open a surface" while it has none. On a wide window it is a
 * column docked beside the chat, which narrows the chat, resized from its left edge, its width kept per chat;
 * narrower, it floats over the chat; on a phone, it is a sheet over the whole screen.
 */

const DEFAULT_WIDTH = 540;
const MIN_WIDTH = 360;
const MAX_FRACTION = 0.7;
/** Below this the chat's composer is cramped, so the panel never takes the chat narrower. */
const CHAT_MIN_WIDTH = 360;
/** Below this window width the panel floats instead. */
const DOCK_FROM = 1100;
/** How long opening and closing the docked panel animates (its duration-200). */
const MOTION_MS = 200;
const WIDTH = "--chat-panel-width";

type Surface = { id: SurfaceId; label: string; letter: string; icon: LucideIcon };
const SURFACE_LIST: Surface[] = [
  { id: "details", label: "Details", letter: "D", icon: GaugeIcon },
  { id: "files", label: "Files", letter: "F", icon: FolderIcon },
  { id: "browser", label: "Browser", letter: "B", icon: GlobeIcon },
  { id: "agents", label: "Agents", letter: "A", icon: BotIcon },
  { id: "work", label: "Work", letter: "W", icon: ListChecksIcon },
];
const SURFACE = Object.fromEntries(SURFACE_LIST.map((surface) => [surface.id, surface])) as Record<SurfaceId, Surface>;

/** Open layers that own the keyboard, so a bare letter is not a surface's: the panel's own sheet is not one of them. */
const BLOCKING = ["dialog-content", "alert-dialog-content", "sheet-content", "dropdown-menu-content", "dropdown-menu-sub-content", "select-content", "popover-content"]
  .map((slot) => `[data-slot="${slot}"]:is([data-open],[data-ending-style])`).join(",");
/** Where a letter is typing; contenteditable=false islands do not count. */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="application"]';

/** The panel's state for the open chat, and what changes it: ChatScreen holds it, so its header's toggle and the panel agree. */
export function useChatPanel(chatKey: string) {
  const [state, update] = usePanelState(chatKey);
  /** Where focus goes once the panel shows what the owner just asked for: the launcher, or the tab just opened. */
  const focus = useRef<"launcher" | "tab" | null>(null);
  const show = () => { focus.current = state.tabs.length ? "tab" : "launcher"; update((was) => ({ ...was, open: true, active: was.active && was.tabs.includes(was.active) ? was.active : was.tabs[0] ?? null })); };
  const close = () => update((was) => ({ ...was, open: false }));
  return {
    chatKey, state, focus, show, close,
    toggle: () => state.open ? close() : show(),
    openSurface: (id: SurfaceId) => {
      focus.current = "tab";
      update((was) => ({ ...was, open: true, active: id, tabs: was.tabs.includes(id) ? was.tabs : [...was.tabs, id] }));
    },
    activate: (id: SurfaceId) => update((was) => was.tabs.includes(id) ? { ...was, active: id } : was),
    /** Closing the last tab closes the panel; closing the one shown shows its neighbour. */
    closeSurface: (id: SurfaceId) => update((was) => {
      const index = was.tabs.indexOf(id);
      if (index < 0) return was;
      const tabs = was.tabs.filter((tab) => tab !== id);
      return { ...was, tabs, open: tabs.length > 0 && was.open, active: was.active === id ? tabs[Math.min(index, tabs.length - 1)] ?? null : was.active };
    }),
    setWidth: (width: number) => update((was) => ({ ...was, width: Math.round(width), wide: undefined })),
    setWide: (wide: boolean) => update((was) => ({ ...was, wide })),
    setScope: (scope: PanelState["scope"]) => update((was) => ({ ...was, scope })),
  };
}
export type ChatPanelControl = ReturnType<typeof useChatPanel>;

/** The header's button for the panel, pressed while it is open. */
export function ChatPanelToggle({ panel }: { panel: ChatPanelControl }) {
  const { shortcuts, mac, label } = useShortcuts();
  return <Tooltip>
    <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Chat panel" aria-pressed={panel.state.open} data-chat-panel-toggle
      aria-keyshortcuts={shortcuts.chatPanel.replace("CommandOrControl", mac ? "Meta" : "Control")}
      className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground" onClick={panel.toggle} />}><PanelRightIcon /></TooltipTrigger>
    <TooltipContent>Chat panel <Kbd>{label("chatPanel")}</Kbd></TooltipContent>
  </Tooltip>;
}

/** Whether the window is wide enough to dock the panel; unknown until measured. One frame's measure per resize, dropped on unmount. */
function useRoomy() {
  const [roomy, setRoomy] = useState<boolean>();
  useEffect(() => {
    let frame = 0;
    const measure = () => { frame = 0; setRoomy(window.innerWidth >= DOCK_FROM); };
    const onResize = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    measure();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); if (frame) window.cancelAnimationFrame(frame); };
  }, []);
  return roomy;
}

const focusToggle = () => document.querySelector<HTMLButtonElement>("[data-chat-panel-toggle]")?.focus();

export function ChatPanel({ panel, conversationId, project, details, flags }: {
  panel: ChatPanelControl;
  conversationId: Id<"conversations"> | null;
  project?: { id: Id<"projects">; name: string };
  details: ChatDetails;
  /** The server's switches for Files (PERRY_WORKSPACE) and Browser (PERRY_BROWSER_VIEW). */
  flags: { files: boolean; browser: boolean };
}) {
  const mobile = useIsMobile();
  const roomy = useRoomy();
  const mode = mobile ? "sheet" : roomy === undefined ? null : roomy ? "docked" : "overlay";
  const { state } = panel;
  const [menuOpen, setMenuOpen] = useState(false);
  if (!state.open && menuOpen) setMenuOpen(false);
  const unstarted = "Available once this chat has started.";
  const reasons: Record<SurfaceId, string | null> = {
    details: null,
    files: flags.files ? null : "Available when Perry's workspace is on (PERRY_WORKSPACE=1).",
    browser: !flags.browser ? "Available when Perry's browser is on (PERRY_BROWSER_VIEW=1)." : conversationId ? null : unstarted,
    agents: conversationId ? null : unstarted,
    work: conversationId ? null : unstarted,
  };

  // The panel's own keys (Settings → Keyboard shortcuts): show or hide it, and pick a surface for it.
  const { shortcuts, mac } = useShortcuts();
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;
    if (matches(event, shortcuts.chatPanel, mac)) {
      event.preventDefault();
      panel.toggle();
    } else if (matches(event, shortcuts.panelSurface, mac)) {
      event.preventDefault();
      // With no tabs the launcher is the picker; with some, the "+" menu is, and it takes focus.
      if (!state.open) panel.show();
      if (state.tabs.length) { panel.focus.current = null; setMenuOpen(true); }
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const wide = state.wide ?? (mode === "overlay" && state.active === "browser");
  const body = (visible: boolean) => visible && <PanelBody panel={panel} mode={mode ?? "docked"} reasons={reasons} conversationId={conversationId} project={project}
    details={details} wide={wide} menuOpen={menuOpen} onMenuOpen={setMenuOpen} />;

  if (!mode) return null;
  if (mode === "sheet") return <Sheet open={state.open} onOpenChange={(open) => { if (!open) panel.close(); }}>
    <SheetContent showCloseButton={false} className="w-full max-w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-full motion-reduce:transition-none" data-chat-panel data-panel-mode="sheet">
      <SheetTitle className="sr-only">Chat panel</SheetTitle><SheetDescription className="sr-only">Details, files, the live browser, agents and the work of this chat.</SheetDescription>
      {body(true)}
    </SheetContent>
  </Sheet>;
  if (mode === "overlay") return state.open ? <Overlay panel={panel} wide={wide}>{body(true)}</Overlay> : null;
  return <Docked panel={panel} wide={wide}>{(visible) => body(visible)}</Docked>;
}

/** Narrower windows: floating over the chat, so the chat never moves; Escape closes it. */
function Overlay({ panel, wide, children }: { panel: ChatPanelControl; wide: boolean; children: ReactNode }) {
  const host = useRef<HTMLElement>(null);
  // Closed with focus inside, focus goes back to the toggle once the window is gone.
  useLayoutEffect(() => {
    const element = host.current;
    return () => { if (element?.contains(document.activeElement)) queueMicrotask(() => { if (document.activeElement === document.body) focusToggle(); }); };
  }, []);
  return <aside ref={host} id="chat-panel" aria-label="Chat panel" data-chat-panel data-panel-mode="overlay"
    className="absolute top-14 right-3 z-30 flex h-[min(44rem,calc(100%-4.5rem))] min-h-0 flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-float ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150 motion-reduce:animate-none"
    style={{ width: wide ? "min(780px, calc(100% - 1.5rem))" : "min(400px, calc(100% - 1.5rem))" }}
    onKeyDown={(event) => { if (event.key === "Escape" && !(event.target as HTMLElement).closest('[role="application"]')) { event.stopPropagation(); panel.close(); } }}>
    {children}
  </aside>;
}

/**
 * Wide windows: a column beside the chat. Its width animates only as it opens or closes; collapsed it is inert,
 * and what it shows is let go once it has closed, so a closed panel draws nothing and the browser stops streaming.
 */
function Docked({ panel, wide, children }: { panel: ChatPanelControl; wide: boolean; children: (visible: boolean) => ReactNode }) {
  const { open } = panel.state;
  const host = useRef<HTMLDivElement | null>(null);
  const [maxWidth, setMaxWidth] = useState(() => Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_FRACTION)));
  // The cap: 70% of the window, and never so wide the chat beside it is cramped. The row is measured, not the window,
  // so the sidebar opening narrows it too; only the cap is kept, so an unchanged one renders nothing.
  const attach = useCallback((element: HTMLDivElement) => {
    host.current = element;
    const row = element.parentElement;
    const measure = () => setMaxWidth(Math.max(MIN_WIDTH, Math.min(Math.floor(window.innerWidth * MAX_FRACTION), row ? row.clientWidth - CHAT_MIN_WIDTH : Infinity)));
    measure();
    const observer = new ResizeObserver(measure);
    if (row) observer.observe(row);
    return () => { observer.disconnect(); host.current = null; };
  }, []);
  const width = wide ? maxWidth : Math.max(MIN_WIDTH, Math.min(maxWidth, panel.state.width ?? DEFAULT_WIDTH));

  // Width animates for an open or a close only: any other change turns the transition off in the same commit.
  const [motion, setMotion] = useState({ open, width, animate: true });
  if (motion.open !== open || motion.width !== width) setMotion({ open, width, animate: motion.open !== open });

  // What it shows stays while it closes, then goes.
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) { setShown(true); return; }
    const timer = window.setTimeout(() => setShown(false), MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Closing, focus leaves before the panel goes inert, for the toggle, so it is not dropped on the page
  // (or was already, with the tab that had it).
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const active = document.activeElement;
    if (wasOpen.current && !open && (element.contains(active) || active === document.body)) focusToggle();
    wasOpen.current = open;
    element.toggleAttribute("inert", !open);
  }, [open]);

  return <div ref={attach} id="chat-panel" role="complementary" aria-label="Chat panel" data-chat-panel data-panel-mode="docked" data-open={open || undefined}
    className={cn("relative flex h-full min-h-0 max-w-full min-w-0 shrink-0 flex-col self-stretch bg-background transition-[width] duration-200 ease-out motion-reduce:transition-none",
      open ? "border-l" : "pointer-events-none")}
    style={{ [WIDTH]: `${width}px`, width: open ? `var(${WIDTH})` : "0px", transitionDuration: motion.animate ? undefined : "0ms" } as CSSProperties}>
    {open && <ResizeHandle width={width} min={MIN_WIDTH} max={maxWidth} onCommit={panel.setWidth} />}
    <div className="h-full min-h-0 w-full overflow-clip">
      <div className="flex h-full min-h-0 flex-col" style={{ width: `calc(var(${WIDTH}) - 1px)` }}>{children(open || shown)}</div>
    </div>
  </div>;
}

type Drag = {
  pointerId: number; target: HTMLElement; host: HTMLElement; startX: number; x: number; start: number; width: number;
  min: number; max: number; frame: number; commit: (width: number) => void; onBlur: () => void;
};

/**
 * The docked panel's left edge, dragged to resize it (useResizeDrag.ts in T3 Code). The drag moves a CSS variable,
 * one frame at a time, and saves once on release; what it needs is read when it starts. Unmounted mid-drag, or the
 * pointer lost, it ends there. Arrow keys resize it too.
 */
function ResizeHandle({ width, min, max, onCommit }: { width: number; min: number; max: number; onCommit: (width: number) => void }) {
  const drag = useRef<Drag | null>(null);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  const finish = useCallback((commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    // First, since releasing the pointer sends lostpointercapture back here.
    drag.current = null;
    if (active.frame) window.cancelAnimationFrame(active.frame);
    window.removeEventListener("blur", active.onBlur);
    try { if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId); } catch {}
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    active.host.style.removeProperty("transition-property");
    if (!commit) { active.host.style.setProperty(WIDTH, `${active.start}px`); return; }
    active.width = clamp(active.start + active.startX - active.x, active.min, active.max);
    active.host.style.setProperty(WIDTH, `${active.width}px`);
    if (active.width !== active.start) active.commit(active.width);
  }, []);
  useEffect(() => () => finish(false), [finish]);
  const nudge = (to: number) => onCommit(clamp(to, min, max));
  return <div role="separator" aria-orientation="vertical" aria-label="Resize the chat panel" aria-controls="chat-panel" tabIndex={0}
    aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} data-panel-resize
    className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none select-none"
    onPointerDown={(event) => {
      const host = event.currentTarget.closest<HTMLElement>("[data-chat-panel]");
      if (event.button !== 0 || drag.current || !host) return;
      const target = event.currentTarget;
      try { target.setPointerCapture(event.pointerId); } catch { return; }
      event.preventDefault();
      // Leaving the window mid-drag keeps the width it had.
      const onBlur = () => finish(true);
      window.addEventListener("blur", onBlur);
      host.style.setProperty("transition-property", "none");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      drag.current = { pointerId: event.pointerId, target, host, startX: event.clientX, x: event.clientX, start: width, width, min, max, frame: 0, commit: onCommit, onBlur };
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      active.x = event.clientX;
      if (active.frame) return;
      active.frame = window.requestAnimationFrame(() => {
        active.frame = 0;
        active.width = clamp(active.start + active.startX - active.x, active.min, active.max);
        active.host.style.setProperty(WIDTH, `${active.width}px`);
      });
    }}
    onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current.x = event.clientX; finish(true); } }}
    onPointerCancel={() => finish(true)}
    onLostPointerCapture={() => finish(true)}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 64 : 16;
      const to = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step : event.key === "Home" ? min : event.key === "End" ? max : null;
      if (to === null) return;
      event.preventDefault();
      nudge(to);
    }}>
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-ring group-active:bg-primary/60" />
  </div>;
}

/** The tab bar, then the surface shown, or the launcher while there is none. */
function PanelBody({ panel, mode, reasons, conversationId, project, details, wide, menuOpen, onMenuOpen }: {
  panel: ChatPanelControl; mode: "docked" | "overlay" | "sheet"; reasons: Record<SurfaceId, string | null>;
  conversationId: Id<"conversations"> | null; project?: { id: Id<"projects">; name: string }; details: ChatDetails;
  wide: boolean; menuOpen: boolean; onMenuOpen: (open: boolean) => void;
}) {
  const client = useConvex();
  const connection = useConnection();
  const root = useRef<HTMLDivElement>(null);
  const { state } = panel;
  const active = state.active && state.tabs.includes(state.active) ? state.active : null;

  // Focus follows what the owner asked for, after the docked panel stops being inert.
  useEffect(() => {
    const want = panel.focus.current;
    if (!want || !state.open) return;
    panel.focus.current = null;
    const target = want === "tab" && active ? root.current?.querySelector<HTMLElement>(`[data-panel-tab="${active}"]`) : root.current?.querySelector<HTMLElement>("[data-panel-launcher]");
    target?.focus({ preventScroll: true });
  }, [state.open, active, state.tabs.length, panel.focus]);

  const step = (event: ReactKeyboardEvent, id: SurfaceId) => {
    const index = state.tabs.indexOf(id);
    const next = event.key === "ArrowRight" ? state.tabs[(index + 1) % state.tabs.length] : event.key === "ArrowLeft" ? state.tabs[(index - 1 + state.tabs.length) % state.tabs.length]
      : event.key === "Home" ? state.tabs[0] : event.key === "End" ? state.tabs.at(-1) : undefined;
    if (event.key === "Delete") { event.preventDefault(); panel.focus.current = "tab"; panel.closeSurface(id); return; }
    if (!next) return;
    event.preventDefault();
    panel.activate(next);
    root.current?.querySelector<HTMLElement>(`[data-panel-tab="${next}"]`)?.focus();
  };

  const surface = !active ? null : reasons[active] ? <Unavailable surface={SURFACE[active]} reason={reasons[active]} />
    : active === "details" ? <Details details={details} />
    : active === "files" ? <FilesSurface conversationId={conversationId} project={project} scope={state.scope} onScope={panel.setScope} />
    : active === "agents" && conversationId ? <AgentsSurface conversationId={conversationId} />
    : active === "work" && conversationId ? <WorkSurface conversationId={conversationId} project={project} scope={state.scope} onScope={panel.setScope} onOpenFiles={reasons.files ? undefined : () => panel.openSurface("files")} />
    // Mounted only while its tab is shown: hidden, the live view stops and nothing streams.
    : active === "browser" && conversationId ? <div className="flex min-h-0 flex-1 flex-col" data-surface="browser"><BrowserPanel key={conversationId} conversationId={conversationId} onClose={() => panel.closeSurface("browser")} /></div>
    : null;

  return <div ref={root} className="flex min-h-0 flex-1 flex-col">
    <div className="flex h-12 shrink-0 items-center gap-1 border-b pr-1.5 pl-2" data-panel-tabbar>
      {/* Scrolls sideways when tabs run out of room, which clips anything drawn outside a tab: their focus rings are inset. */}
      <div role="tablist" aria-label="Chat panel" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {state.tabs.map((id) => {
          const { label, icon: Icon } = SURFACE[id];
          const selected = id === active;
          return <div key={id} className={cn("group/tab flex h-7 shrink-0 items-center rounded-md text-xs", selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); panel.closeSurface(id); } }}>
            <button type="button" role="tab" id={`chat-panel-tab-${id}`} aria-selected={selected} aria-controls="chat-panel-surface" tabIndex={selected ? 0 : -1} data-panel-tab={id}
              className="flex h-full cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
              onClick={() => panel.activate(id)} onKeyDown={(event) => step(event, id)}><Icon className="size-3.5 shrink-0" />{label}</button>
            <button type="button" aria-label={`Close ${label}`} data-panel-tab-close={id}
              className={cn("mr-1 grid size-5 cursor-pointer place-items-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset [@media(hover:hover)]:opacity-0 group-hover/tab:opacity-100", selected && "[@media(hover:hover)]:opacity-100")}
              onClick={() => { panel.focus.current = "tab"; panel.closeSurface(id); }}><XIcon className="size-3" /></button>
          </div>;
        })}
        <AddMenu open={menuOpen} onOpenChange={onMenuOpen} reasons={reasons} onPick={panel.openSurface} />
      </div>
      {mode !== "sheet" && <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={wide ? "Narrow the panel" : "Widen the panel"} onClick={() => panel.setWide(!wide)}>{wide ? <Minimize2Icon /> : <Maximize2Icon />}</Button>}
      <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label="Close panel" onClick={panel.close}><XIcon /></Button>
    </div>
    {connection !== "connected" && <p role="status" className="mx-3 mt-3 rounded-lg bg-muted px-3 py-2 text-xs">{connection === "connecting" ? "Connecting to Perry…" : "Reconnecting. Showing the last received state."}</p>}
    <div id="chat-panel-surface" role={active ? "tabpanel" : undefined} aria-labelledby={active ? `chat-panel-tab-${active}` : undefined} className="flex min-h-0 flex-1 flex-col" data-panel-surface={active ?? "launcher"}>
      {active ? <PanelBoundary key={`${panel.chatKey}:${active}`} onRetry={() => client.refresh()} onClose={() => panel.closeSurface(active)}>{surface}</PanelBoundary>
        : <Launcher reasons={reasons} enabled={state.open} onPick={panel.openSurface} />}
    </div>
  </div>;
}

/** A surface whose tab was kept but which cannot show here, and why. */
function Unavailable({ surface, reason }: { surface: Surface; reason: string }) {
  const Icon = surface.icon;
  return <div className="flex flex-col items-center px-6 py-14 text-center" data-surface-unavailable={surface.id}>
    <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><Icon className="size-5" /></span>
    <p className="mt-3 text-sm font-medium">{surface.label}</p>
    <p className="mt-1 max-w-64 text-xs text-muted-foreground">{reason}</p>
  </div>;
}

/** Why a row cannot be picked, on hover and to a screen reader. */
function Reason({ reason, trigger }: { reason: string; trigger: ReactElement }) {
  return <Tooltip>
    <TooltipTrigger render={trigger} />
    <TooltipContent side="top">{reason}</TooltipContent>
  </Tooltip>;
}

/**
 * "Open a surface": each one, with its letter. Arrow keys and Enter pick one; so does its letter alone, from
 * anywhere but a text field or an open dialog or menu. Rows that cannot be picked here are faded, and say why.
 */
function Launcher({ reasons, enabled, onPick }: { reasons: Record<SurfaceId, string | null>; enabled: boolean; onPick: (id: SurfaceId) => void }) {
  const [highlight, setHighlight] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const usable = SURFACE_LIST.filter((surface) => !reasons[surface.id]);
  const index = usable.length ? Math.min(highlight, usable.length - 1) : -1;

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const surface = usable.find((item) => item.letter.toLowerCase() === event.key.toLowerCase());
    if (!surface) return;
    const own = ref.current;
    if ([...document.querySelectorAll(BLOCKING)].some((layer) => !own || !layer.contains(own))) return;
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof Element && target.closest(TYPING)) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(surface.id);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !usable.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); setHighlight((index + 1) % usable.length); }
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); setHighlight(index === -1 ? usable.length - 1 : (index - 1 + usable.length) % usable.length); }
    else if (event.key === "Enter" && event.target === event.currentTarget && index !== -1) { event.preventDefault(); onPick(usable[index].id); }
  };

  return <div ref={ref} role="menu" tabIndex={0} onKeyDown={onKeyDown} aria-label="Open a surface" aria-activedescendant={index !== -1 ? `chat-panel-open-${usable[index].id}` : undefined}
    data-panel-launcher={usable.map((surface) => surface.letter).join("")}
    className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-12 outline-none">
    <div className="w-full max-w-xs py-6">
      <h3 className="mb-3 text-center text-sm font-medium" aria-hidden>Open a surface</h3>
      <div className="flex flex-col gap-0.5" role="none">
        {SURFACE_LIST.map((surface) => {
          const Icon = surface.icon;
          const reason = reasons[surface.id];
          const row = <><Icon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{surface.label}</span><Kbd>{surface.letter}</Kbd></>;
          if (reason) return <Reason key={surface.id} reason={reason} trigger={<div role="menuitem" tabIndex={0} aria-disabled="true" data-launcher-row={surface.id} data-unavailable
            className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{row}<span className="sr-only">. {reason}</span></div>} />;
          const position = usable.indexOf(surface);
          return <button key={surface.id} type="button" role="menuitem" tabIndex={-1} id={`chat-panel-open-${surface.id}`} data-launcher-row={surface.id} aria-keyshortcuts={surface.letter}
            className={cn("flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-muted motion-reduce:transition-none", position === index && "bg-muted")}
            onMouseEnter={() => setHighlight(position)} onMouseLeave={() => setHighlight((current) => current === position ? -1 : current)}
            onClick={() => onPick(surface.id)}>{row}</button>;
        })}
      </div>
    </div>
  </div>;
}

/** The tab bar's "+": the same surfaces as the launcher, with the same letters while it is open. */
function AddMenu({ open, onOpenChange, reasons, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; reasons: Record<SurfaceId, string | null>; onPick: (id: SurfaceId) => void }) {
  const pick = (id: SurfaceId) => { onOpenChange(false); onPick(id); };
  // Ahead of the menu's own type-to-find, wherever it has put focus; only while it is open.
  const onLetter = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const surface = SURFACE_LIST.find((item) => !reasons[item.id] && item.letter.toLowerCase() === event.key.toLowerCase());
    if (!surface) return;
    event.preventDefault();
    event.stopPropagation();
    pick(surface.id);
  });
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => onLetter(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open]);
  return <DropdownMenu open={open} onOpenChange={onOpenChange}>
    <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="shrink-0 text-muted-foreground" aria-label="Open in the panel" data-panel-add />}><PlusIcon /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-48">
      {SURFACE_LIST.map((surface) => {
        const Icon = surface.icon;
        const reason = reasons[surface.id];
        const item = <DropdownMenuItem key={surface.id} disabled={Boolean(reason)} data-menu-surface={surface.id} aria-keyshortcuts={surface.letter}
          className={reason ? "data-disabled:pointer-events-auto" : undefined} onClick={() => pick(surface.id)}>
          <Icon />{surface.label}<DropdownMenuShortcut>{surface.letter}</DropdownMenuShortcut>
        </DropdownMenuItem>;
        return reason ? <Reason key={surface.id} reason={reason} trigger={item} /> : item;
      })}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** A surface that throws shows why, with a retry, instead of taking the chat down with it. */
class PanelBoundary extends Component<{ children: ReactNode; onRetry: () => Promise<unknown>; onClose: () => void }, { error: string; retry: number }> {
  state = { error: "", retry: 0 };
  static getDerivedStateFromError(error: unknown) { return { error: errorText(error) }; }
  render() {
    return this.state.error ? <div role="alert" className="p-4 text-sm"><p>{this.state.error}</p><div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => void this.props.onRetry().then(() => this.setState({ error: "", retry: this.state.retry + 1 }))}>Retry</Button><Button size="sm" variant="ghost" onClick={this.props.onClose}>Close tab</Button></div></div>
      : <div key={this.state.retry} className="flex min-h-0 flex-1 flex-col">{this.props.children}</div>;
  }
}
