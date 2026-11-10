"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { DownloadIcon, FilePenLineIcon, MicIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { NoteView } from "@/convex/notes";
import type { Id } from "@/convex/_generated/dataModel";
import { useSession } from "@/lib/session";
import { copyText, errorText } from "@/lib/format";
import { randomUUID } from "@/lib/uuid";
import { NoteEditor } from "@/components/notes/editor";
import { inspectMarkdown } from "@/components/notes/markdown";
import { useLiveSpeech } from "@/components/notes/live-speech";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { EmptyState, List, ListSkeleton, Page, RelativeTime, TopBar } from "../common";
import { SaveStatus } from "../autosave";
import { useNoteSaves } from "./notes";

export function LiveDocuments() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const documents = useQuery(api.notes.listLive, { key: dashboardKey });
  const create = useMutation(api.notes.createLive);
  const [creating, setCreating] = useState(false);
  const make = async () => {
    setCreating(true);
    try { router.push(`/live/${await create({ key: dashboardKey })}`); }
    catch (cause) { toast.error(`Couldn't create a document: ${errorText(cause)}`); setCreating(false); }
  };
  const action = <Button size="sm" className="min-h-11 md:min-h-7" onClick={() => void make()} disabled={creating}><PlusIcon />{creating ? "Creating…" : "New document"}</Button>;
  return (
    <Page title="Riff" description="Think out loud. Perry writes and edits while you keep talking." actions={action}>
      {documents === undefined ? <ListSkeleton rows={4} /> : !documents.length ? (
        <EmptyState title="A document that keeps up with you">
          Speak your draft and ask for changes in the same breath. Rename it, turn a paragraph into bullets, or ask Perry to find an image or link.
        </EmptyState>
      ) : (
        <List label="Riff documents">
          {documents.map((document) => <li key={document.id} className="relative flex items-start gap-3 py-4">
            <FilePenLineIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <Link href={`/live/${document.id}`} className="block truncate font-medium after:absolute after:inset-0 hover:underline">{document.title}</Link>
              {document.preview && <p className="mt-1 truncate text-sm text-muted-foreground">{document.preview}</p>}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground"><RelativeTime at={document.updatedAt} /></span>
          </li>)}
        </List>
      )}
    </Page>
  );
}

export function LiveDocumentScreen() {
  const { dashboardKey } = useSession();
  const { id } = useParams<{ id: string }>()!;
  const note = useQuery(api.notes.get, { key: dashboardKey, id });
  if (note === undefined) return <Page title="Riff"><ListSkeleton rows={4} /></Page>;
  if (!note?.liveChatId) return <Page title="Riff"><EmptyState title="This document isn't here" action={<Button variant="outline" render={<Link href="/live" />}>Riff</Button>} /></Page>;
  return <LiveDocument key={note.id} note={note} chatId={note.liveChatId} />;
}

const MAX_PENDING = 12_000;

function LiveDocument({ note, chatId }: { note: NoteView; chatId: Id<"conversations"> }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const { controller, state } = useNoteSaves(note);
  const draft = state.draft ?? note;
  const chat = useQuery(api.dashboard.getChat, { key: dashboardKey, id: chatId });
  const send = useMutation(api.notes.sendLive);
  const stopEdits = useMutation(api.dashboard.stopChat);
  const remove = useMutation(api.notes.remove);
  const [removing, setRemoving] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState("");
  const [transcript, setTranscript] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [source, setSource] = useState(false);
  const pendingRef = useRef("");
  const batch = useRef<{ id: string; text: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const automatic = useRef(false);
  const downloadUrl = useRef<string | undefined>(undefined);
  const storage = `perry.live.${note.id}`;
  const latest = useRef<() => Promise<void>>(async () => {});

  const keepPending = (text: string) => {
    pendingRef.current = text;
    if (mounted.current) setPending(text);
    try {
      if (text) sessionStorage.setItem(storage, JSON.stringify({ pending: text, batch: batch.current }));
      else sessionStorage.removeItem(storage);
      if (mounted.current) setStorageError("");
    } catch {
      if (mounted.current) setStorageError("Your browser couldn't keep unsent words. Copy them before leaving this page.");
    }
  };
  const schedule = () => {
    if (!timer.current && !inFlight.current && automatic.current) {
      timer.current = setTimeout(() => { timer.current = undefined; void latest.current(); }, 2_000);
    }
  };
  const speech = useLiveSpeech((text) => {
    setTranscript((previous) => `${previous}\n${text}`.trim().slice(-12_000));
    const next = [pendingRef.current, text].filter(Boolean).join(" ");
    keepPending(next);
    if (next.length > MAX_PENDING) {
      speech.stop();
      automatic.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
      setError("There are too many unsent words. Copy them below, discard them, then send smaller parts as typed instructions.");
    } else schedule();
  });

  latest.current = async () => {
    if (inFlight.current || !pendingRef.current.trim()) return;
    if (pendingRef.current.length > MAX_PENDING) { setError("Copy and discard the unsent words, then send smaller parts as typed instructions."); return; }
    inFlight.current = true;
    setSending(true);
    const current = batch.current ?? { id: randomUUID(), text: pendingRef.current };
    batch.current = current;
    keepPending(pendingRef.current);
    try {
      if (!await controller.flush()) throw new Error("Save your document or resolve the conflicting edits first. Your spoken words are kept below.");
      if (!mounted.current) return;
      await send({ key: dashboardKey, id: note.id, text: current.text, batchId: current.id });
      batch.current = null;
      keepPending(pendingRef.current.slice(current.text.length).trimStart());
      if (mounted.current) setError("");
    } catch (cause) {
      automatic.current = false;
      speech.stop();
      if (mounted.current) setError(errorText(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSending(false);
        if (pendingRef.current) schedule();
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    try {
      const kept = JSON.parse(sessionStorage.getItem(storage) ?? "null");
      if (kept && typeof kept.pending === "string") {
        if (kept.batch && typeof kept.batch.id === "string" && kept.batch.id.length <= 80 && typeof kept.batch.text === "string" && kept.pending.startsWith(kept.batch.text)) batch.current = kept.batch;
        keepPending(kept.pending.slice(0, MAX_PENDING + 2_000));
      }
    } catch { setError("Couldn't restore unsent words from this browser session."); }
    return () => {
      mounted.current = false;
      automatic.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    };
  }, [storage]);
  useEffect(() => { document.title = `${draft.title} · Riff · Perry`; }, [draft.title]);
  useEffect(() => {
    if (state.status !== "conflict") return;
    automatic.current = false;
    clearTimeout(timer.current);
    timer.current = undefined;
    speech.stop();
  }, [state.status]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void controller.flush(true); }
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [controller]);
  const format = useMemo(() => inspectMarkdown(draft.content), [draft.content]);
  const download = () => {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    const url = downloadUrl.current = URL.createObjectURL(new Blob([`# ${draft.title}\n\n${draft.content}`], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${draft.title.replace(/[\\/:*?"<>|]/g, " ").trim() || "document"}.md`;
    anchor.click();
  };
  const submit = () => {
    const text = instruction.trim();
    if (!text || sending) return;
    if (pendingRef.current.length + text.length + 1 > MAX_PENDING) { setError("Send the kept words first, or copy and discard them before continuing."); return; }
    keepPending([pendingRef.current, text].filter(Boolean).join(" "));
    setTranscript((previous) => `${previous}\n${text}`.trim().slice(-12_000));
    setInstruction("");
    void latest.current();
  };

  return <>
    <TopBar actions={<>
      <Button variant="ghost" size="sm" className="min-h-11 md:min-h-7" onClick={download}><DownloadIcon />Export</Button>
      <Button variant="ghost" size="icon-sm" className="size-11 md:size-7" aria-label="Delete document" onClick={() => setRemoving(true)}><Trash2Icon /></Button>
    </>}>
      <Link href="/live" className="text-muted-foreground hover:text-foreground">Riff</Link>
      <span aria-hidden className="text-muted-foreground">/</span><span className="truncate">{draft.title}</span>
    </TopBar>
    <main id="content" tabIndex={-1} className="flex-1 outline-none">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-10">
        <section aria-label="Document" className="min-w-0">
          <input aria-label="Document title" value={draft.title} maxLength={160} placeholder="Untitled document"
            className="mb-2 w-full rounded-sm bg-transparent text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => controller.edit({ title: event.target.value })} onBlur={() => void controller.flush()} />
          <div className="mb-6 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <SaveStatus state={state.status === "error" ? { status: "error", error: state.error } : { status: state.status === "saving" ? "saving" : state.status === "dirty" ? "editing" : state.status === "saved" ? "saved" : "idle" }} onRetry={() => void controller.flush(true)} />
            <Button variant="ghost" size="sm" aria-pressed={source} onClick={() => setSource(!source)}>Markdown</Button>
          </div>
          {state.status === "conflict" && <div role="alert" className="mb-5 space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
            <p>Perry changed this document while you typed. Your version is still here. Resolve this before sending more instructions.</p>
            <div className="flex flex-wrap gap-2 max-md:[&_button]:min-h-11">
              <Button size="sm" variant="outline" onClick={() => void copyText(draft.content).then(() => toast.success("Your version copied."), () => toast.error("Couldn't copy. Select and copy your version from the editor."))}>Copy mine</Button>
              <Button size="sm" variant="outline" onClick={() => controller.useLatest()}>Load Perry's</Button>
              <Button size="sm" onClick={() => controller.keepMine()}>Keep mine</Button>
            </div>
          </div>}
          {source || !format.supported ? <>
            {!format.supported && <p className="mb-3 text-xs text-muted-foreground">{format.reason} Edit the Markdown to keep its formatting.</p>}
            <Textarea aria-label="Document Markdown" value={draft.content} rows={24} className="min-h-[55vh] font-mono text-base md:text-sm" onChange={(event) => controller.edit({ content: event.target.value })} onBlur={() => void controller.flush()} />
          </> : <NoteEditor value={draft.content} label="Document body" onChange={(content) => controller.edit({ content })} onBlur={() => void controller.flush()} />}
        </section>
        <aside aria-label="Live editing" className="min-w-0 border-t pt-6 lg:sticky lg:top-16 lg:self-start lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
          <h2 className="text-base font-semibold">Think out loud</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Keep talking while Perry edits. Say “turn that into bullets” or “find an image of Einstein.” You can type in the document too.</p>
          <Button className="mt-4 min-h-11 w-full" variant={speech.phase === "off" ? "default" : "outline"}
            disabled={!speech.supported || speech.phase === "stopping" || (speech.phase === "off" && state.status === "conflict")}
            onClick={() => {
              if (speech.phase !== "off") speech.stop();
              else { automatic.current = true; speech.start(); if (pendingRef.current) schedule(); }
            }}>
            {speech.phase === "off" ? <MicIcon /> : <SquareIcon />}
            {speech.phase === "off" ? "Start listening" : speech.phase === "starting" ? "Opening microphone…" : speech.phase === "stopping" ? "Stopping…" : "Stop listening"}
          </Button>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{speech.supported ? "Uses your browser's speech service, which may process audio online. Listening stops when you leave this page or switch tabs." : "Voice needs a browser with speech recognition on localhost or HTTPS. You can still type instructions below."}</p>
          <p role="status" className="mt-4 text-sm text-muted-foreground">{sending ? "Sending your words…" : chat?.isRunning ? "Perry is editing. Keep talking." : speech.phase === "listening" ? "Listening. Speak naturally." : "Ready when you are."}</p>
          {(error || speech.error || storageError || chat?.lastError) && <p role="alert" className="mt-3 text-sm text-destructive">{error || speech.error || storageError || chat?.lastError}</p>}
          {(transcript || speech.interim) && <section aria-label="Transcript" className="mt-5">
            <h3 className="text-xs font-medium text-muted-foreground">What you said</h3>
            <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">{transcript}{speech.interim && <span className="text-muted-foreground"> {speech.interim}</span>}</div>
          </section>}
          {pending && <div className="mt-4 space-y-2">
            <p className="text-xs font-medium">Unsent words</p>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm" data-live-unsent>{pending}</p>
            <div className="flex flex-wrap gap-2 max-md:[&_button]:min-h-11">
              <Button size="sm" variant="outline" disabled={sending || state.status === "conflict"} onClick={() => void latest.current()}>Send kept words</Button>
              <Button size="sm" variant="ghost" onClick={() => void copyText(pending).then(() => toast.success("Unsent words copied."), (cause) => toast.error(errorText(cause)))}>Copy</Button>
              <Button size="sm" variant="ghost" disabled={sending || speech.phase !== "off"} onClick={() => { batch.current = null; keepPending(""); setError(""); }}>Discard</Button>
            </div>
          </div>}
          <form className="mt-5 space-y-2 border-t pt-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <label htmlFor="live-instruction" className="text-xs font-medium">Or type an instruction</label>
            <Textarea id="live-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={MAX_PENDING} rows={3} placeholder="Rename this to Brain dump…" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); } }} />
            <Button type="submit" size="sm" variant="outline" className="min-h-11 md:min-h-7" disabled={!instruction.trim() || sending || state.status === "conflict"}>Apply instruction</Button>
          </form>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
            <Link href={`/chat/${chatId}`} className="text-muted-foreground underline underline-offset-4">Editing chat & approvals</Link>
            {chat?.isRunning && <Button size="sm" variant="ghost" className="min-h-11 md:min-h-7" onClick={() => {
              automatic.current = false; clearTimeout(timer.current); timer.current = undefined; speech.stop();
              void stopEdits({ key: dashboardKey, id: chatId }).catch((cause) => setError(errorText(cause)));
            }}>Stop edits</Button>}
          </div>
        </aside>
      </div>
    </main>
    <AlertDialog open={removing} onOpenChange={setRemoving}>
      <AlertDialogContent size="sm"><AlertDialogHeader><AlertDialogTitle>Delete this document?</AlertDialogTitle><AlertDialogDescription>“{draft.title}” will be deleted. Its editing chat is kept.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={chat?.isRunning || sending} onClick={() => {
          speech.stop(); automatic.current = false; clearTimeout(timer.current); timer.current = undefined;
          void remove({ key: dashboardKey, id: note.id }).then(() => { controller.dispose(); batch.current = null; keepPending(""); router.replace("/live"); }, (cause) => toast.error(errorText(cause)));
        }}>Delete</AlertDialogAction></AlertDialogFooter>
        {chat?.isRunning && <p className="text-xs text-muted-foreground">Stop the edits before deleting this document.</p>}
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
