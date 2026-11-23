"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { BrowserInput } from "@/lib/browser-protocol";

const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
type Pointer = Extract<BrowserInput, { type: "pointer" }>;
type Wheel = Extract<BrowserInput, { type: "wheel" }>;

export function BrowserPage({ image, imageRef, title, paused, viewport, onInput }: {
  image: string;
  imageRef: RefObject<HTMLImageElement | null>;
  title: string;
  paused: boolean;
  viewport: { width: number; height: number };
  onInput: (input: BrowserInput) => Promise<void>;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const input = useRef(onInput);
  input.current = onInput;
  const pointer = useRef<Pointer | null>(null);
  const wheel = useRef<Wheel | null>(null);
  const schedule = useRef(() => {});
  const last = useRef({ x: 0, y: 0 });
  const pressed = useRef(new Set<Pointer["button"]>());
  const clicks = useRef({ at: 0, x: 0, y: 0, count: 0, button: "none" });
  const flushPointer = () => {
    const next = pointer.current;
    pointer.current = null;
    if (next) void input.current(next);
  };

  useEffect(() => {
    const element = surface.current;
    if (!element || !paused) return;
    let active = true;
    let frame = 0;
    let sending = false;
    const enqueue = () => {
      if (active && !sending && !frame && (pointer.current || wheel.current)) frame = requestAnimationFrame(() => void pump());
    };
    // Keep at most one unsent move and wheel, even over a slow connection.
    const pump = async () => {
      frame = 0;
      if (!active) return;
      sending = true;
      const move = pointer.current;
      const turn = wheel.current;
      pointer.current = null;
      wheel.current = null;
      try {
        if (move) await input.current(move);
        if (turn && active) await input.current(turn);
      } finally {
        sending = false;
        enqueue();
      }
    };
    const scroll = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
      const pending = wheel.current;
      wheel.current = {
        type: "wheel",
        x: Math.max(0, Math.min(viewport.width, (event.clientX - rect.left) * viewport.width / rect.width)),
        y: Math.max(0, Math.min(viewport.height, (event.clientY - rect.top) * viewport.height / rect.height)),
        deltaX: Math.max(-3000, Math.min(3000, (pending?.deltaX ?? 0) + event.deltaX * scale)),
        deltaY: Math.max(-3000, Math.min(3000, (pending?.deltaY ?? 0) + event.deltaY * scale)),
      };
      enqueue();
    };
    element.addEventListener("wheel", scroll, { passive: false });
    schedule.current = enqueue;
    return () => {
      active = false;
      schedule.current = () => {};
      cancelAnimationFrame(frame);
      element.removeEventListener("wheel", scroll);
      pointer.current = null;
      wheel.current = null;
      pressed.current.clear();
    };
  }, [paused, viewport.width, viewport.height]);

  function release() {
    flushPointer();
    for (const button of pressed.current) void input.current({ type: "pointer", phase: "mouseReleased", ...last.current, button, buttons: 0, clickCount: 1, modifiers: 0 });
    pressed.current.clear();
  }
  function commit(element: HTMLTextAreaElement) {
    const text = element.value;
    element.value = "";
    if (text) for (let start = 0; start < text.length; start += 10_000) void input.current({ type: "text", text: text.slice(start, start + 10_000) });
  }

  return <div ref={surface} role="application" aria-label={paused ? "Browser page. Click to type. Escape returns to browser controls." : "Browser page, view only. Pause to take over."}
    tabIndex={paused ? 0 : -1}
    className="group/page relative w-full overflow-hidden bg-white outline-offset-2 focus-within:outline-2 focus-within:outline-primary"
    style={{ aspectRatio: `${viewport.width}/${viewport.height}`, touchAction: paused ? "none" : "auto" }}
    onFocus={(event) => { if (paused && event.target === event.currentTarget) keyboard.current?.focus({ preventScroll: true }); }}
    onContextMenu={(event) => { if (paused) event.preventDefault(); }}
    onPointerDown={(event) => {
      if (!paused) return;
      event.preventDefault();
      keyboard.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = event.currentTarget.getBoundingClientRect();
      const at = { x: Math.max(0, Math.min(viewport.width, (event.clientX - rect.left) * viewport.width / rect.width)), y: Math.max(0, Math.min(viewport.height, (event.clientY - rect.top) * viewport.height / rect.height)) };
      last.current = at;
      const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
      const previous = clicks.current;
      const now = performance.now();
      const count = now - previous.at < 500 && previous.button === button && Math.hypot(at.x - previous.x, at.y - previous.y) < 5 ? previous.count % 3 + 1 : 1;
      clicks.current = { at: now, ...at, count, button };
      pressed.current.add(button);
      flushPointer();
      void input.current({ type: "pointer", phase: "mousePressed", ...at, button, buttons: event.buttons, clickCount: count, modifiers: modifiers(event) });
    }}
    onPointerMove={(event) => {
      if (!paused) return;
      const rect = event.currentTarget.getBoundingClientRect();
      last.current = { x: Math.max(0, Math.min(viewport.width, (event.clientX - rect.left) * viewport.width / rect.width)), y: Math.max(0, Math.min(viewport.height, (event.clientY - rect.top) * viewport.height / rect.height)) };
      pointer.current = { type: "pointer", phase: "mouseMoved", ...last.current, button: pressed.current.values().next().value ?? "none", buttons: event.buttons, clickCount: 0, modifiers: modifiers(event) };
      schedule.current();
    }}
    onPointerUp={(event) => {
      if (!paused) return;
      flushPointer();
      const rect = event.currentTarget.getBoundingClientRect();
      last.current = { x: Math.max(0, Math.min(viewport.width, (event.clientX - rect.left) * viewport.width / rect.width)), y: Math.max(0, Math.min(viewport.height, (event.clientY - rect.top) * viewport.height / rect.height)) };
      const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
      pressed.current.delete(button);
      void input.current({ type: "pointer", phase: "mouseReleased", ...last.current, button, buttons: event.buttons, clickCount: clicks.current.count, modifiers: modifiers(event) });
    }}
    onPointerCancel={release} onLostPointerCapture={release}>
    {/* Frames stay in the owner's DOM; subsequent frames update this image directly. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img ref={imageRef} src={`data:image/jpeg;base64,${image}`} alt={`Live page: ${title}`} draggable={false} className="pointer-events-none h-full w-full select-none" />
    {paused && <textarea ref={keyboard} aria-label="Type into browser page" autoComplete="off" autoCapitalize="off" spellCheck={false}
      className="absolute left-0 top-0 size-px resize-none opacity-0" onBlur={release}
      onInput={(event) => { if (!(event.nativeEvent as InputEvent).isComposing) commit(event.currentTarget); }}
      onCompositionEnd={(event) => commit(event.currentTarget)}
      onPaste={(event) => { event.preventDefault(); const text = event.clipboardData.getData("text"); if (text) { event.currentTarget.value = text; commit(event.currentTarget); } }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          void input.current({ type: "key", key: event.key, code: event.code, keyCode: 27, modifiers: modifiers(event) });
          event.currentTarget.blur();
          surface.current?.closest("section")?.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')?.focus();
          return;
        }
        if (event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)) return;
        if ((event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) || event.getModifierState("AltGraph")) return;
        if (["Shift", "Control", "Alt", "Meta", "Dead", "Process"].includes(event.key)) return;
        event.preventDefault();
        void input.current({ type: "key", key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event) });
      }} />}
    {!paused && <span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-foreground/75 px-2.5 py-1 text-2xs font-medium text-background opacity-0 group-hover/page:opacity-100">Pause to take over</span>}
  </div>;
}
