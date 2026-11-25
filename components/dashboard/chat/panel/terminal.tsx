"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/format";
import { MachineHeader, useMachine } from "./machine";
import "@xterm/xterm/css/xterm.css";

export function TerminalSurface({ conversationId, project }: { conversationId: Id<"conversations">; project?: { id: Id<"projects">; name: string } }) {
  const machine = useMachine(conversationId);
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null);
  const latest = useRef(machine); latest.current = machine;
  const session = machine.state?.terminals.filter(terminal => terminal.status === "running").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? [...machine.state?.terminals ?? []].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const live = useRef(session); live.current = session;
  const written = useRef({ session: "", offset: 0 });
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => { if (terminal.current) terminal.current.options.screenReaderMode = screenReader; }, [ready, screenReader]);
  useEffect(() => {
    setReady(false);
    setLoadError("");
    written.current = { session: "", offset: 0 };
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    let instance: Terminal | undefined;
    let pending = "", sending = false;
    const send = async () => {
      if (sending || disposed || !pending || !live.current || live.current.status !== "running") return;
      sending = true;
      try {
        while (pending && !disposed) { const text = pending.slice(0, 16384); pending = pending.slice(text.length); await latest.current.run({ kind: "terminal.input", sessionId: live.current!.sessionId, text }); }
      } catch { pending = ""; }
      finally { sending = false; }
    };
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed || !host.current) return;
      instance = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 2000, convertEol: false });
      const fit = new FitAddon(); instance.loadAddon(fit); instance.open(host.current); terminal.current = instance;
      instance.onData(text => { if (live.current?.status !== "running") return; if (pending.length + text.length > 16384) { latest.current.setError("Terminal input is still sending. Wait before typing more."); return; } pending += text; if (timer) clearTimeout(timer); timer = setTimeout(() => void send(), 20); });
      instance.onResize(({ cols, rows }) => { if (live.current?.status === "running") { if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (live.current) void latest.current.run({ kind: "terminal.resize", sessionId: live.current.sessionId, cols: Math.max(20, Math.min(400, cols)), rows: Math.max(5, Math.min(200, rows)) }).catch(() => {}); }, 200); } });
      observer = new ResizeObserver(() => fit.fit()); observer.observe(host.current); fit.fit(); setReady(true);
    }).catch((cause) => {
      if (disposed) return;
      observer?.disconnect();
      clearTimeout(timer); clearTimeout(resizeTimer);
      terminal.current = null;
      instance?.dispose();
      instance = undefined;
      setLoadError(errorText(cause));
    });
    return () => { disposed = true; clearTimeout(timer); clearTimeout(resizeTimer); observer?.disconnect(); terminal.current = null; instance?.dispose(); };
  }, [attempt]);
  useEffect(() => {
    if (!ready || !terminal.current || !session) return;
    const start = session.offset - session.output.length;
    if (written.current.session !== session.sessionId || written.current.offset < start) { terminal.current.reset(); written.current = { session: session.sessionId, offset: start }; }
    terminal.current.write(session.output.slice(Math.max(0, written.current.offset - start)));
    written.current.offset = session.offset;
  }, [ready, session?.sessionId, session?.offset, session?.output]);
  return <section className="flex min-h-0 flex-1 flex-col" data-surface="terminal" aria-label="Terminal">
    <MachineHeader machine={machine} project={project} />
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
      <Button size="sm" variant="ghost" aria-pressed={screenReader} onClick={() => setScreenReader(value => !value)}>Screen reader</Button>
      {session?.status === "running" ? <><span className="min-w-0 flex-1 truncate font-mono" title={session.cwd}>{session.cwd}</span><Button size="sm" variant="outline" disabled={machine.busy} onClick={() => void machine.run({ kind: "terminal.close", sessionId: session.sessionId }).catch(() => {})}>Close terminal</Button></>
        : <><span className="flex-1 text-muted-foreground">Commands run directly on this computer.</span><Button size="sm" disabled={machine.busy || !machine.state?.runner?.online || !ready} onClick={() => void machine.run({ kind: "terminal.open", cols: Math.max(20, Math.min(400, terminal.current?.cols ?? 80)), rows: Math.max(5, Math.min(200, terminal.current?.rows ?? 24)) }).then(() => terminal.current?.focus()).catch(() => {})}>{machine.busy ? "Opening…" : "Open terminal"}</Button></>}
    </div>
    {loadError && <div className="space-y-2 p-3 text-sm" role="alert"><p>Couldn't load the terminal: {loadError}</p><Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div>}
    <div className="min-h-40 flex-1 overflow-hidden bg-black p-2" ref={host} data-terminal />
  </section>;
}
