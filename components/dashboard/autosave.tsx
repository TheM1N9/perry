"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorText } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A text that saves itself, with no Save button: a short pause in typing
 * saves it, and so does leaving the field. Nothing typed is lost by leaving
 * the page either: an in-app link saves on the way out, and closing the tab
 * while a save is still to go asks first, as the browser does for any form.
 *
 * `saved` is the text as the server has it. The field shows it until it is
 * edited, and again once you leave the field with everything saved, so a
 * change made elsewhere (by Perry, or a restore) shows up. The server's
 * mutations here only write when the text differs, so saving the same words
 * twice is harmless; a save is skipped anyway when nothing changed since the
 * last one.
 */

export type SaveState = { status: "idle" | "editing" | "saving" | "saved" | "recovered" | "error"; error?: string };

/** How long typing must pause before it is saved. */
const PAUSE = 800;

export function useAutosave({ draftKey, saved, save, pause = PAUSE }: { draftKey: string; saved: string; save: (text: string) => Promise<unknown>; pause?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>({ status: "idle" });
  /** What still has to reach the server, or null when nothing does. */
  const pending = useRef<{ text: string; save: (text: string) => Promise<unknown>; draftKey: string } | null>(null);
  /** The last text the server took, to skip a save that changes nothing. */
  const last = useRef(saved);
  const flight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<number>(undefined);
  const focused = useRef(false);
  const savedOnce = useRef(false);
  const mounted = useRef(true);
  const recovered = useRef(false);

  useEffect(() => {
    if (recovered.current) return;
    recovered.current = true;
    try {
      const text = sessionStorage.getItem(`perry.autosave.${draftKey}`);
      if (text !== null && text !== saved) {
        pending.current = { text, save, draftKey };
        setDraft(text);
        setState({ status: "recovered" });
      }
    } catch { /* Storage may be unavailable; ordinary saves still work. */ }
  }, [draftKey, saved, save]);

  // A change from elsewhere: follow it, unless you are typing or a save is on its way.
  useEffect(() => {
    if (pending.current !== null || flight.current) return;
    last.current = saved;
    if (!focused.current) setDraft(null);
  }, [saved]);

  const run = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (flight.current) {
      // One save at a time; the newest words go once this one lands.
      const ok = await flight.current;
      return !ok || pending.current === null ? ok : run();
    }
    const job = pending.current;
    if (job === null) return true;
    const { text } = job;
    const forget = () => {
      try {
        const key = `perry.autosave.${job.draftKey}`;
        if (sessionStorage.getItem(key) === text) sessionStorage.removeItem(key);
      } catch { /* Saving does not require browser storage. */ }
    };
    if (text.trim() === last.current.trim()) {
      pending.current = null;
      forget();
      if (mounted.current) setState((current) => current.status === "editing" || current.status === "error" || current.status === "recovered" ? { status: savedOnce.current ? "saved" : "idle" } : current);
      return true;
    }
    if (mounted.current) setState({ status: "saving" });
    const attempt = Promise.resolve().then(() => job.save(text)).then(() => {
      last.current = text;
      savedOnce.current = true;
      forget();
      if (pending.current === job) pending.current = null;
      return true;
    }, (cause: unknown) => {
      if (mounted.current) setState({ status: "error", error: errorText(cause) });
      return false;
    });
    flight.current = attempt;
    const ok = await attempt;
    flight.current = null;
    if (!ok) return false;
    if (pending.current !== null) return run();
    if (mounted.current) {
      setState({ status: "saved" });
      if (!focused.current) setDraft(null);
    }
    return true;
  }, []);

  const change = useCallback((text: string, { now = false } = {}) => {
    setDraft(text);
    pending.current = { text, save, draftKey };
    try { sessionStorage.setItem(`perry.autosave.${draftKey}`, text); } catch { /* The beforeunload guard still protects unsaved edits. */ }
    setState((current) => current.status === "error" ? current : { status: "editing" });
    window.clearTimeout(timer.current);
    if (now) void run();
    else timer.current = window.setTimeout(() => void run(), pause);
  }, [draftKey, pause, run, save]);

  // Closing the tab with words still to save asks first, and saves them meanwhile.
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (pending.current === null && !flight.current) return;
      void run();
      event.preventDefault();
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [run]);
  // Leaving by an in-app link unmounts the field: what is typed is saved on the way out.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
      if (pending.current === null && !flight.current) return;
      void run().then((ok) => { if (!ok) toast.error("Couldn't save what you typed. Return to the field and try again."); });
    };
  }, [run]);

  return {
    /** What the field shows. */
    value: draft ?? saved,
    /** Typed: saved after a pause. With `now`, saved at once (a preset picked, say). */
    change,
    /** Save now: Ctrl+Enter, or Try again. Resolves to whether it saved. */
    flush: run,
    state,
    /** For the field: it follows the server unless focused, and saves when left. */
    field: {
      onFocus: () => { focused.current = true; },
      onBlur: () => {
        focused.current = false;
        void run().then((ok) => { if (mounted.current && ok && pending.current === null && !flight.current) setDraft(null); });
      },
    },
  };
}

/** The quiet line under a field that saves itself: Saving…, Saved, or what went wrong and a way to try again. */
export function SaveStatus({ state, onRetry, className, idle }: { state: SaveState; onRetry: () => void; className?: string; idle?: string }) {
  const words = state.status === "saving" ? "Saving…" : state.status === "saved" ? "Saved" : state.status === "idle" ? idle : undefined;
  return (
    <p className={cn("min-h-5 text-xs text-muted-foreground", state.status === "error" && "text-destructive", className)} role="status" aria-live="polite" data-save={state.status}>
      {state.status === "recovered" ? <>Recovered an unsaved draft. <button type="button" className="font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={onRetry}>Save draft</button></> : state.status === "error" ? (
        <>
          Couldn&apos;t save: {state.error}{" "}
          <button type="button" className="font-medium underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50" onClick={onRetry}>Try again</button>
        </>
      ) : words}
    </p>
  );
}
