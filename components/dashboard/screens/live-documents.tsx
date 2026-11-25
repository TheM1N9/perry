"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowUpIcon, ChevronDownIcon, CopyIcon, CpuIcon, DownloadIcon, EllipsisIcon, FileCodeIcon, HistoryIcon, LibraryIcon, MicIcon, PlusIcon, SendIcon, SparklesIcon, SquareIcon, Trash2Icon, UserRoundIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { NoteSummary, NoteView } from "@/convex/notes";
import type { Id } from "@/convex/_generated/dataModel";
import type { RiffStyle, RiffVersion } from "@/convex/riff";
import { matches } from "@/convex/lib/shortcuts";
import { chatModel, currentModel, effortUnused, modelKey } from "@/convex/lib/commands";
import { parseModelKey } from "@/convex/lib/engines";
import { useSession } from "@/lib/session";
import { copyText, errorText } from "@/lib/format";
import { randomUUID } from "@/lib/uuid";
import { turnErrorCopy } from "@/lib/turn-errors";
import { cn } from "@/lib/utils";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { useIsMobile } from "@/hooks/use-mobile";
import { NoteEditor } from "@/components/notes/editor";
import { inspectMarkdown } from "@/components/notes/markdown";
import { useLiveSpeech } from "@/components/notes/live-speech";
import { RiffDiff } from "@/components/notes/riff-diff";
import { Dock, DockRow, Ghost, Meters, StylePicker, useMinute, versionTime } from "@/components/notes/riff-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyState, ListSkeleton, Page, TopBar } from "../common";
import { useNoteSaves } from "./notes";
import { ModelMenu, shortModelName } from "../chat/model-menu";
import { Markdown } from "../chat/markdown";

/* ================================ Home ================================ */

const DAY = 86_400_000;
function groupOf(at: number, now: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return "Today";
  if (at >= start.getTime() - 6 * DAY) return "This week";
  return "Earlier";
}

export function LiveDocuments() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const documents = useQuery(api.notes.listLive, { key: dashboardKey });
  const create = useMutation(api.notes.createLive);
  const [creating, setCreating] = useState(false);
  const now = useMinute();
  const make = async () => {
    if (creating) return;
    setCreating(true);
    try { router.push(`/live/${await create({ key: dashboardKey })}`); }
    catch (cause) { toast.error(`Couldn't create a document: ${errorText(cause)}`); setCreating(false); }
  };
  const latest = useRef(make);
  latest.current = make;
  // N makes a new document from anywhere on the page but a field.
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [role='dialog']")) return;
      event.preventDefault();
      void latest.current();
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, []);
  const groups = useMemo(() => {
    const out: Array<{ name: string; items: NoteSummary[] }> = [];
    for (const document of documents ?? []) {
      const name = groupOf(document.updatedAt, now);
      const group = out.at(-1)?.name === name ? out.at(-1)! : (out.push({ name, items: [] }), out.at(-1)!);
      group.items.push(document);
    }
    return out;
  }, [documents, now]);
  const action = (
    <Button size="sm" className="min-h-11 md:min-h-8" onClick={() => void make()} disabled={creating} data-riff-new>
      <PlusIcon />New<Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground max-md:hidden">N</Kbd>
    </Button>
  );
  return (
    <Page title="Riff" actions={action}>
      {documents === undefined ? <ListSkeleton rows={4} /> : !documents.length ? (
        <EmptyState title="No documents yet" action={<Button onClick={() => void make()} disabled={creating}><MicIcon />Start a document</Button>}>
          Talk, and Perry writes it down. Ask for changes as you go.
        </EmptyState>
      ) : (
        <div className="space-y-8" data-riff-list>
          {groups.map((group) => (
            <section key={group.name} aria-label={group.name}>
              <h2 className="mb-1 text-xs font-medium text-muted-foreground">{group.name}</h2>
              <ul className="-mx-3">
                {group.items.map((document) => (
                  <li key={document.id}>
                    <Link href={`/live/${document.id}`} className="block rounded-lg px-3 py-3 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="block truncate font-medium">{document.title}</span>
                      <span className="mt-0.5 block truncate text-sm text-muted-foreground">{document.preview || "Empty"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
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

/* ============================== Document ============================== */

const MAX_PENDING = 12_000;
/** What a document is called before it has a name (v1 named them "Untitled document"). */
const UNTITLED = new Set(["Untitled", "Untitled document"]);
/** Held this long, letting go of the hotkey stops listening; a shorter press keeps it on. */
const HOLD_MS = 400;
type Batch = { id: string; text: string };
type Settling = { text: string; sentAt: number };
type TypedReceipt = { id: string; text: string; selection?: string; runId?: Id<"runs">; status: "sending" | "acknowledged" | "unknown" };

function LiveDocument({ note, chatId }: { note: NoteView; chatId: Id<"conversations"> }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const mobile = useIsMobile();
  const { shortcuts, mac, label: shortcutLabel } = useShortcuts();
  const { controller, state } = useNoteSaves(note);
  const draft = state.draft ?? note;
  const chat = useQuery(api.dashboard.getChat, { key: dashboardKey, id: chatId });
  // The document's model and thinking are its editing chat's, the ones its runs use: picked here, kept with it,
  // and the owner's default engine and model until picked (dashboard.createChat). The chat composer's picker.
  const modelOptions = useQuery(api.models.options, { key: dashboardKey });
  const setChatModel = useMutation(api.dashboard.setChatModel);
  const setChatEffort = useMutation(api.dashboard.setChatEffort);
  const models = modelOptions?.models;
  const engine = chat?.engine;
  const modelId = chat?.model || currentModel(models ?? [], undefined, engine);
  const modelInfo = chatModel(models ?? [], modelId, engine);
  const effort = modelInfo && effortUnused(modelInfo, chat?.effort || undefined) ? undefined : chat?.effort || undefined;
  const pickModel = (key: string) => {
    const parsed = parseModelKey(key);
    const next = { id: parsed.id, engine: parsed.engine ?? engine };
    if (!next.engine) return;
    void setChatModel({ key: dashboardKey, id: chatId, model: next.id || undefined, engine: next.engine }).catch((cause) => toast.error(errorText(cause)));
  };
  const pickEffort = (next: string | undefined) => void setChatEffort({ key: dashboardKey, id: chatId, effort: next }).catch((cause) => toast.error(errorText(cause)));
  const [dockHeight, setDockHeight] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const send = useMutation(api.notes.sendLive);
  const stopEdits = useMutation(api.dashboard.stopChat);
  const remove = useMutation(api.notes.remove);
  const acceptEdit = useMutation(api.riff.accept);
  const rejectEdit = useMutation(api.riff.reject);
  const restoreVersion = useMutation(api.riff.restore);
  const setStyle = useMutation(api.riff.setStyle);
  const toBrain = useMutation(api.riff.toBrain);
  const handOff = useMutation(api.riff.handOff);
  const listStyles = useAction(api.riff.styles);
  const [styles, setStyles] = useState<RiffStyle[] | undefined>(undefined);
  const [styleOpen, setStyleOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const versions = useQuery(api.riff.versions, historyOpen ? { key: dashboardKey, id: note.id } : "skip");
  const [preview, setPreview] = useState<RiffVersion | null>(null);
  const [handing, setHanding] = useState<"someone" | "perry" | null>(null);
  const [removing, setRemoving] = useState(false);
  const [instruction, setInstruction] = useState("");
  const instructionRef = useRef("");
  const [typed, setTyped] = useState<TypedReceipt | null>(null);
  const typedRef = useRef<TypedReceipt | null>(null);
  const typedSending = useRef(false);
  const typedRun = useQuery(api.notes.liveRun, typed?.runId ? { key: dashboardKey, id: note.id, runId: typed.runId } : "skip");
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const dismissedRef = useRef<string | null>(null);
  const [pending, setPending] = useState("");
  const [settling, setSettling] = useState<Settling[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [source, setSource] = useState(false);
  const [changed, setChanged] = useState(false);
  const selection = useRef("");
  const pendingRef = useRef("");
  const batch = useRef<Batch | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const automatic = useRef(false);
  const downloadUrl = useRef<string | undefined>(undefined);
  const storage = `perry.live.${note.id}`;
  const latest = useRef<() => Promise<void>>(async () => {});
  const style = note.riffStyle ?? "notes";
  const postLimit = styles?.find((item) => item.name === style)?.postLimit ?? (style === "thread" ? 280 : undefined);
  const proposal = note.riffProposal;

  useEffect(() => {
    let live = true;
    listStyles({ key: dashboardKey }).then((list) => { if (live) setStyles(list); }, () => { if (live) setStyles([]); });
    return () => { live = false; };
  }, [dashboardKey, listStyles, styleOpen]);

  const persistPending = () => {
    if (!mounted.current) return;
    try {
      if (pendingRef.current || instructionRef.current || typedRef.current || dismissedRef.current) sessionStorage.setItem(storage, JSON.stringify({ pending: pendingRef.current, instruction: instructionRef.current, batch: batch.current, typed: typedRef.current, dismissedError: dismissedRef.current }));
      else sessionStorage.removeItem(storage);
      if (mounted.current) setStorageError("");
    } catch {
      if (mounted.current) setStorageError("This browser couldn't keep your unsent words. Copy them before leaving.");
    }
  };
  const keepPending = (text: string) => {
    pendingRef.current = text;
    if (mounted.current) setPending(text);
    persistPending();
  };
  const keepTyped = (receipt: TypedReceipt | null) => {
    if (!mounted.current) return;
    typedRef.current = receipt;
    setTyped(receipt);
    persistPending();
  };
  const keepInstruction = (text: string) => {
    instructionRef.current = text.slice(0, 4_000);
    setInstruction(instructionRef.current);
    persistPending();
  };
  const dismissEngineError = () => {
    dismissedRef.current = chat?.lastErrorRunId ?? null;
    setDismissedError(dismissedRef.current);
    if (typedRef.current?.status === "unknown" || typedRef.current?.runId === dismissedRef.current) keepTyped(null);
    else persistPending();
  };
  const halt = () => {
    automatic.current = false;
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const schedule = () => {
    if (!timer.current && !inFlight.current && automatic.current) {
      timer.current = setTimeout(() => { timer.current = undefined; void latest.current(); }, 2_000);
    }
  };
  const speech = useLiveSpeech((text) => {
    const next = [pendingRef.current, text].filter(Boolean).join(" ");
    keepPending(next);
    if (next.length > MAX_PENDING) {
      speech.stop();
      halt();
      setError("Too many unsent words. Copy them, then discard.");
    } else schedule();
  });

  latest.current = async () => {
    if (inFlight.current || !pendingRef.current.trim()) return;
    if (pendingRef.current.length > MAX_PENDING) { setError("Too many unsent words. Copy them, then discard."); return; }
    inFlight.current = true;
    setSending(true);
    const current = batch.current ?? { id: randomUUID(), text: pendingRef.current };
    batch.current = current;
    keepPending(pendingRef.current);
    try {
      if (!await controller.flush()) throw new Error("Settle the conflicting edits first. Your words are kept.");
      if (!mounted.current) return;
      await send({ key: dashboardKey, id: note.id, text: current.text, batchId: current.id, ...(selection.current ? { selection: selection.current } : {}) });
      batch.current = null;
      if (mounted.current) setSettling((items) => [...items, { text: current.text, sentAt: Date.now() }]);
      keepPending(pendingRef.current.slice(current.text.length).trimStart());
      if (mounted.current) setError("");
    } catch (cause) {
      halt();
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

  // Restore words this tab had not sent yet (a reload, a crash).
  useEffect(() => {
    mounted.current = true;
    try {
      const kept = JSON.parse(sessionStorage.getItem(storage) ?? "null");
      if (kept && typeof kept.pending === "string") {
        if (typeof kept.instruction === "string" && kept.instruction.length <= 4_000) {
          instructionRef.current = kept.instruction; setInstruction(kept.instruction);
        }
        const receipt = kept.typed;
        if (receipt && typeof receipt.id === "string" && receipt.id.length <= 80 && typeof receipt.text === "string" && receipt.text.trim() && receipt.text.length <= 4_000
          && (receipt.selection === undefined || typeof receipt.selection === "string" && receipt.selection.length <= 4_000)
          && (receipt.runId === undefined || typeof receipt.runId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(receipt.runId))) {
          typedRef.current = { id: receipt.id, text: receipt.text, ...(receipt.selection ? { selection: receipt.selection } : {}), ...(receipt.runId ? { runId: receipt.runId } : {}), status: receipt.runId ? "acknowledged" : "unknown" };
          setTyped(typedRef.current);
        }
        if (typeof kept.dismissedError === "string" && kept.dismissedError.length <= 128) {
          dismissedRef.current = kept.dismissedError; setDismissedError(kept.dismissedError);
        }
        if (kept.batch && typeof kept.batch.id === "string" && kept.batch.id.length <= 80 && typeof kept.batch.text === "string" && kept.pending.startsWith(kept.batch.text)) batch.current = kept.batch;
        keepPending(kept.pending.slice(0, MAX_PENDING + 2_000));
      }
    } catch { setError("Couldn't restore unsent words from this browser session."); }
    return () => {
      mounted.current = false;
      halt();
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    };
  }, [storage]);

  // Sent words settle once Perry has written (or proposed), or his turn ends; if it failed they are unsent again.
  // A turn too short for this page to see running still ends it, a moment after it was sent.
  const ranSince = useRef(false);
  const errorBefore = useRef<string | undefined>(undefined);
  const lastError = chat?.lastError;
  const lastErrorRun = chat?.lastErrorRunId;
  useEffect(() => { if (chat?.isRunning) ranSince.current = true; }, [chat?.isRunning]);
  useEffect(() => {
    if (!settling.length) { errorBefore.current = lastErrorRun; return; }
    if (chat === undefined || chat?.isRunning) return;
    const wait = setTimeout(() => {
      ranSince.current = false;
      setSettling((items) => {
        if (items.length && lastErrorRun && lastErrorRun !== errorBefore.current) {
          keepPending([items.map((item) => item.text).join(" "), pendingRef.current].filter(Boolean).join(" "));
          halt();
        }
        return [];
      });
    }, ranSince.current ? 0 : 3_000);
    return () => clearTimeout(wait);
  }, [chat === undefined, chat?.isRunning, settling.length, lastErrorRun]);
  useEffect(() => {
    const at = Math.max(note.by === "assistant" ? note.updatedAt : 0, proposal?.at ?? 0);
    if (at) setSettling((items) => items.some((item) => item.sentAt <= at) ? items.filter((item) => item.sentAt > at) : items);
  }, [note.by, note.updatedAt, proposal?.at]);

  useEffect(() => { document.title = `${draft.title} · Riff · Perry`; }, [draft.title]);
  useEffect(() => {
    if (state.status !== "conflict") return;
    halt();
    speech.stop();
  }, [state.status]);
  useEffect(() => { setChanged(false); }, [proposal?.at]);

  const listening = speech.phase !== "off";
  const toggleMic = () => {
    if (listening) { speech.stop(); return; }
    automatic.current = true;
    speech.start();
    if (pendingRef.current) schedule();
  };

  const accept = async () => {
    if (!proposal) return;
    try {
      const result = await acceptEdit({ key: dashboardKey, id: note.id, at: proposal.at });
      if (!result.ok) { if (result.reason === "changed") setChanged(true); return; }
      const undo = result.undo;
      if (undo) toast("Edit accepted", { duration: 6_000, action: { label: "Undo", onClick: () => void restoreVersion({ key: dashboardKey, id: note.id, version: undo }).catch((cause) => toast.error(errorText(cause))) } });
    } catch (cause) { toast.error(errorText(cause)); }
  };
  const reject = () => void rejectEdit({ key: dashboardKey, id: note.id }).catch((cause) => toast.error(errorText(cause)));
  const redo = async () => {
    const ask = proposal?.instruction;
    reject();
    if (ask) await submit(ask);
  };
  const restore = async (version: RiffVersion) => {
    try {
      if (!await controller.flush(true)) throw new Error("Settle the conflicting edits first.");
      await restoreVersion({ key: dashboardKey, id: note.id, version: version.id });
      setPreview(null);
      setHistoryOpen(false);
      toast.success(`Restored the version from ${versionTime(version.at)}`);
    } catch (cause) { toast.error(errorText(cause)); }
  };

  const typedBusy = Boolean(typed && (typed.status === "sending" || typed.status === "unknown" || typedRun === undefined || typedRun === null || typedRun?.status === "running"));
  const submit = async (text = instructionRef.current.trim(), retry?: TypedReceipt) => {
    if (!text || typedSending.current || !retry && typedBusy) return;
    const submittedDraft = instructionRef.current;
    const receipt: TypedReceipt = { id: randomUUID(), text, selection: retry ? retry.selection : selection.current.slice(0, 4_000), status: "sending" };
    typedSending.current = true;
    keepTyped(receipt);
    let dispatched = false;
    try {
      if (!await controller.flush()) throw new Error("Settle the conflicting edits first.");
      if (!mounted.current) { keepTyped({ ...receipt, status: "unknown" }); return; }
      dispatched = true;
      const result = await send({ key: dashboardKey, id: note.id, text, batchId: receipt.id, typed: true, ...(receipt.selection ? { selection: receipt.selection } : {}) });
      keepTyped({ ...receipt, ...(result ? { runId: result.runId } : {}), status: result ? "acknowledged" : "unknown" });
      if (mounted.current) {
        if (!retry && instructionRef.current === submittedDraft && submittedDraft.trim() === text) keepInstruction("");
        setError("");
      }
    } catch (cause) {
      keepTyped(dispatched ? { ...receipt, status: "unknown" } : null);
      if (mounted.current) setError(errorText(cause));
    } finally { typedSending.current = false; }
  };

  // Keys: the Riff hotkey (hold to talk, tap to toggle), Esc and Ctrl/⌘+Enter on an edit, Ctrl/⌘+S to save.
  const keys = useRef({ toggleMic, accept, reject, stop: () => speech.stop(), listening, proposal: Boolean(proposal), preview: Boolean(preview) });
  keys.current = { toggleMic, accept, reject, stop: () => speech.stop(), listening, proposal: Boolean(proposal), preview: Boolean(preview) };
  useEffect(() => {
    let held: { at: number; code: string; started: boolean } | null = null;
    const down = (event: KeyboardEvent) => {
      const k = keys.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void controller.flush(true); return; }
      if (matches(event, shortcuts.riffTalk, mac)) {
        event.preventDefault();
        if (event.repeat || held) return;
        held = { at: Date.now(), code: event.code, started: !k.listening };
        k.toggleMic();
        return;
      }
      if (k.proposal && !k.preview && (event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void k.accept(); return; }
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (k.listening) { k.stop(); return; }
        if (k.proposal && !k.preview && !(event.target as HTMLElement | null)?.closest("[role='dialog'], [role='menu']")) k.reject();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (!held || (event.code !== held.code && !["Alt", "Control", "Meta", "Shift"].includes(event.key))) return;
      const { at, started } = held;
      held = null;
      if (started && Date.now() - at >= HOLD_MS) keys.current.stop();
    };
    const blur = () => { held = null; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, [controller, shortcuts.riffTalk, mac]);

  const format = useMemo(() => inspectMarkdown(draft.content), [draft.content]);
  const markdown = `# ${draft.title}\n\n${draft.content}`;
  const download = () => {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    const url = downloadUrl.current = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${draft.title.replace(/[\\/:*?"<>|]/g, " ").trim() || "document"}.md`;
    anchor.click();
  };
  const saveToBrain = async () => {
    try {
      if (!await controller.flush(true)) throw new Error("Settle the conflicting edits first.");
      const page = await toBrain({ key: dashboardKey, id: note.id });
      toast.success("Saved to Brain", { action: { label: "Open", onClick: () => router.push(`/brain/${page}`) } });
    } catch (cause) { toast.error(errorText(cause)); }
  };
  const empty = !draft.content.trim();
  const settlingText = settling.map((item) => item.text).join(" ");
  const startsSentence = !draft.content.trim() || /[.!?:]\s*$|\n\s*$/.test(draft.content);
  const working = Boolean(chat?.isRunning) || sending;
  const hotkey = shortcutLabel("riffTalk");

  /* ---- The dock's row: what there is to decide, most pressing first ---- */
  let row: ReactNode = null;
  if (state.status === "conflict") {
    row = <DockRow key="conflict" actions={<>
      <Button size="sm" variant="ghost" onClick={() => void copyText(draft.content).then(() => toast.success("Your version copied."), () => toast.error("Couldn't copy."))}>Copy mine</Button>
      <Button size="sm" variant="outline" onClick={() => controller.useLatest()}>Load Perry's</Button>
      <Button size="sm" onClick={() => controller.keepMine()}>Keep mine</Button>
    </>}>Perry changed this while you typed.</DockRow>;
  } else if (preview) {
    row = <DockRow key="preview" actions={<>
      <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
      <Button size="sm" onClick={() => void restore(preview)}>Restore</Button>
    </>}>Version from {versionTime(preview.at)}</DockRow>;
  } else if (proposal && changed) {
    row = <DockRow key="changed" actions={<>
      <Button size="sm" variant="ghost" onClick={reject}>Discard</Button>
      {proposal.instruction && <Button size="sm" onClick={() => void redo()}>Redo on latest</Button>}
    </>}>The document changed since this edit.</DockRow>;
  } else if (proposal) {
    row = <DockRow key={`edit-${proposal.at}`} actions={<>
      <Button size="sm" variant="ghost" onClick={reject} data-riff-reject>Reject<Kbd className="ml-1 max-md:hidden">Esc</Kbd></Button>
      <Button size="sm" onClick={() => void accept()} data-riff-accept>Accept<Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground max-md:hidden">{mac ? "⌘↵" : "Ctrl ↵"}</Kbd></Button>
    </>}><span className="line-clamp-2 md:truncate md:block">{proposal.instruction ? `“${proposal.instruction}”` : "Perry's edit"}</span></DockRow>;
  } else if (typed?.status === "unknown" || typed?.runId && typedRun === null) {
    row = <DockRow key="typed-unknown" tone="error" actions={<>
      <Button size="sm" variant="ghost" onClick={() => void copyText(typed.text).then(() => toast.success("Instruction copied."), cause => toast.error(errorText(cause)))}>Copy</Button>
      <Button size="sm" variant="outline" render={<Link href="/settings/engines" />}>Settings</Button>
      <Button size="sm" variant="outline" onClick={() => { keepTyped(null); setError(""); }}>Dismiss</Button>
    </>}><p>{error || "Couldn't confirm this instruction's status. Check the document and History before sending again."}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">{typed.text}</p></DockRow>;
  } else if (error || speech.error || storageError) {
    row = <DockRow key="error" tone="error" actions={pending ? <>
      <Button size="sm" variant="ghost" onClick={() => void copyText(pending).then(() => toast.success("Copied."), (cause) => toast.error(errorText(cause)))}>Copy</Button>
      <Button size="sm" variant="ghost" disabled={sending || listening} onClick={() => { batch.current = null; keepPending(""); setError(""); }}>Discard</Button>
      <Button size="sm" variant="outline" disabled={sending} onClick={() => { automatic.current = true; void latest.current(); }}>Retry</Button>
    </> : storageError && instruction ? <Button size="sm" variant="outline" onClick={() => void copyText(instruction).then(() => toast.success("Instruction copied."), cause => toast.error(errorText(cause)))}>Copy instruction</Button>
      : <Button size="sm" variant="ghost" onClick={() => setError("")}>Dismiss</Button>}>{error || speech.error || storageError}</DockRow>;
  } else if (lastError && lastErrorRun && !working && dismissedError !== lastErrorRun) {
    const failure = turnErrorCopy(chat?.lastErrorCode);
    row = <DockRow key={`engine-${lastErrorRun}`} tone="error" actions={<>
      <Button size="sm" variant="ghost" onClick={dismissEngineError}>Dismiss</Button>
      <Button size="sm" variant="outline" render={<Link href="/settings/engines" />}>Settings</Button>
      {typed?.runId === lastErrorRun && typedRun?.status === "error"
        ? <Button size="sm" onClick={() => void submit(typed.text, typed)}>Retry instruction</Button>
        : pending && <Button size="sm" variant="outline" onClick={() => { automatic.current = true; void latest.current(); }}>Retry</Button>}
    </>}><p>{failure.title}</p><p className="mt-1 text-foreground">{failure.guidance}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{lastError}</p>{typed?.runId === lastErrorRun && <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">{typed.text}</p>}</DockRow>;
  } else if (typed?.runId && typedRun?.current && typedRun.status !== "running") {
    row = <DockRow key={`result-${typed.runId}`} actions={<Button size="sm" variant="ghost" onClick={() => keepTyped(null)}>Dismiss</Button>}>
      <p className="font-medium">No edit waiting for review</p>
      <p className="mb-1 mt-2 text-xs text-muted-foreground">Last reply</p>
      {typedRun.reply ? <div className="max-h-60 overflow-y-auto [overflow-wrap:anywhere]"><Markdown text={typedRun.reply} /></div> : <p>The request ended without a written reply. Review the document and History.</p>}
    </DockRow>;
  }

  const modelChip = "h-11 shrink-0 gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground md:h-8 md:px-2.5";
  const chip = <><CpuIcon className="size-3.5 shrink-0" /><span className="whitespace-nowrap" data-riff-model>{modelInfo ? shortModelName(modelInfo.name) : "Default"}</span><ChevronDownIcon className="size-3 shrink-0 opacity-60" /></>;
  const menu = <ModelMenu models={models} model={engine && modelId ? modelKey(engine, modelId) : undefined} onModel={pickModel} modelInfo={modelInfo} effort={effort} onEffort={pickEffort} />;
  const micLabel = !speech.supported ? "Voice needs a browser with speech recognition" : listening ? "Stop listening" : "Start listening";

  return <>
    <TopBar solid actions={<>
      <StylePicker styles={styles} current={style} open={styleOpen} onOpenChange={setStyleOpen}
        onPick={(name) => void setStyle({ key: dashboardKey, id: note.id, style: name }).catch((cause) => toast.error(errorText(cause)))} />
      <Popover open={historyOpen && !mobile} onOpenChange={setHistoryOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="size-11 max-md:hidden md:size-8" aria-label="History" data-riff-history-button />}>
          <HistoryIcon />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 gap-0 p-1.5" data-riff-history>
          <HistoryList versions={versions} preview={preview} onPick={(version) => { setPreview(version); setHistoryOpen(false); }} />
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="min-h-11 max-md:hidden md:min-h-8" data-riff-send-button />}><SendIcon />Send</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <SendItems empty={empty} onBrain={saveToBrain} onCopy={() => void copyText(markdown).then(() => toast.success("Copied as Markdown."), (cause) => toast.error(errorText(cause)))} onDownload={download} onHand={setHanding} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-11 md:size-8" aria-label="More" />}><EllipsisIcon /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <div className="md:hidden">
            <DropdownMenuItem onClick={() => setHistoryOpen(true)}><HistoryIcon />History</DropdownMenuItem>
            <SendItems empty={empty} onBrain={saveToBrain} onCopy={() => void copyText(markdown).then(() => toast.success("Copied as Markdown."), (cause) => toast.error(errorText(cause)))} onDownload={download} onHand={setHanding} />
            <DropdownMenuSeparator />
          </div>
          <DropdownMenuItem onClick={() => setSource(!source)}><FileCodeIcon />{source ? "Edit as text" : "Edit Markdown"}</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}><Trash2Icon />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>}>
      <Link href="/live" className="text-muted-foreground hover:text-foreground">Riff</Link>
      <span aria-hidden className="text-muted-foreground">/</span><span className="truncate" data-riff-crumb>{draft.title}</span>
    </TopBar>
    <main id="content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-[42.5rem] flex-col px-5 pt-6 sm:px-8 md:pt-14">
        {preview ? <h1 className="mb-6 text-[1.625rem] font-semibold leading-tight tracking-[-0.02em] md:text-[2rem]">{preview.title}</h1>
          : proposal?.title && proposal.title !== draft.title ? <h1 className="mb-6 text-[1.625rem] font-semibold leading-tight tracking-[-0.02em] md:text-[2rem]"><del className="text-muted-foreground">{draft.title}</del> <ins className="rounded-[3px] bg-primary/12 no-underline">{proposal.title}</ins></h1>
          : <input aria-label="Title" value={UNTITLED.has(draft.title) ? "" : draft.title} maxLength={160} placeholder="Untitled" data-riff-title
            className="mb-6 w-full rounded-sm bg-transparent text-[1.625rem] font-semibold leading-tight tracking-[-0.02em] outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 md:text-[2rem]"
            onChange={(event) => controller.edit({ title: event.target.value || "Untitled" })} onBlur={() => void controller.flush()} />}
        <section aria-label="Document" className="min-w-0 flex-1 cursor-text" onMouseDown={(event) => {
          // The blank page below the words is part of the page: a click there writes at the end.
          if (event.target !== event.currentTarget) return;
          const editor = event.currentTarget.querySelector<HTMLElement>("[data-note-editor]");
          if (!editor) return;
          event.preventDefault();
          editor.focus();
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        }}>
          {preview ? <RiffDiff before={draft.content} after={preview.content} />
            : proposal ? <RiffDiff before={proposal.baseContent} after={proposal.content} />
            : source || !format.supported ? <>
              {!format.supported && <p className="mb-3 text-xs text-muted-foreground">{format.reason} Edit the Markdown to keep its formatting.</p>}
              <Textarea aria-label="Document Markdown" value={draft.content} rows={24} className="min-h-[50vh] font-mono text-base md:text-sm" onChange={(event) => controller.edit({ content: event.target.value })} onBlur={() => void controller.flush()} />
            </> : <NoteEditor value={draft.content} label="Document" toolbar={false} placeholder="Start talking, or type" className={cn("riff-text", empty ? "min-h-[40vh]" : "min-h-0")}
              onSelection={(text) => { selection.current = text; }} clearance={{ top: 48, bottom: dockHeight }}
              onChange={(content) => controller.edit({ content })} onBlur={() => void controller.flush()} />}
          {!preview && <Ghost settling={settlingText} unsent={pending} heard={speech.interim} startsSentence={startsSentence} clearance={dockHeight} />}
        </section>
        <div className="mt-8 min-h-4"><Meters content={preview?.content ?? proposal?.content ?? draft.content} postLimit={postLimit} /></div>
        <Dock row={row} onHeight={setDockHeight}>
          <Tooltip>
            <TooltipTrigger render={
              <Button type="button" size="icon" aria-label={micLabel} aria-pressed={listening} disabled={!speech.supported || speech.phase === "stopping" || (!listening && state.status === "conflict")}
                onClick={toggleMic} data-riff-mic data-phase={speech.phase}
                className={cn("size-12 shrink-0 rounded-full transition-colors duration-150 md:size-10",
                  listening ? "bg-foreground text-background hover:bg-foreground/90" : "bg-primary text-primary-foreground hover:bg-primary/90")} />
            }>
              {listening ? <SquareIcon className="size-3.5 fill-current" /> : <MicIcon />}
            </TooltipTrigger>
            <TooltipContent>{speech.supported ? <>{listening ? "Stop" : "Talk"} <span className="opacity-70">· hold or tap {hotkey}</span></> : "Voice needs Chrome, Edge or Safari on localhost or HTTPS. You can still type."}</TooltipContent>
          </Tooltip>
          <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <input value={instruction} onChange={(event) => keepInstruction(event.target.value)} maxLength={4_000} aria-label="Ask for a change" data-riff-ask
              placeholder={listening ? "Listening…" : "Ask for a change"}
              className="h-10 min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground md:text-sm" />
            {/* One status and one way to stop at a time: listening (the mic stops it), Perry writing (× stops him), or idle. */}
            {instruction.trim() && <Button type="submit" size="icon-sm" disabled={typedBusy} className="size-10 shrink-0 rounded-full md:size-8" aria-label={typedBusy ? "Waiting for previous instruction" : "Send instruction"}><ArrowUpIcon /></Button>}
            {listening ? null : working ? <Tooltip>
                <TooltipTrigger render={<Button type="button" variant="ghost" size="sm" className="min-h-11 shrink-0 gap-1.5 text-muted-foreground md:min-h-8" data-riff-stop aria-label="Perry is writing. Stop"
                  onClick={() => { halt(); speech.stop(); void stopEdits({ key: dashboardKey, id: chatId }).catch((cause) => setError(errorText(cause))); }} />}>
                  Writing…<XIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>Stop Perry</TooltipContent>
              </Tooltip>
              : !instruction.trim() && speech.supported && <Kbd className="mr-1 shrink-0 max-md:hidden" data-riff-hotkey>{hotkey}</Kbd>}
          </form>
          {!listening && !working && (mobile
            ? <Button type="button" variant="ghost" size="sm" className={modelChip} aria-label={`Model: ${modelInfo?.name ?? "default"}`} data-riff-model-chip onClick={() => setModelOpen(true)}>{chip}</Button>
            : <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className={modelChip} aria-label={`Model: ${modelInfo?.name ?? "default"}`} data-riff-model-chip />}>{chip}</PopoverTrigger>
              <PopoverContent side="top" align="end" sideOffset={18} className="w-80 gap-0 p-1.5" data-riff-models>{menu}</PopoverContent>
            </Popover>)}
        </Dock>
      </div>
    </main>

    <Sheet open={historyOpen && mobile} onOpenChange={setHistoryOpen}>
      <SheetContent side="bottom" className="max-h-[70dvh] rounded-t-2xl" data-riff-history>
        <SheetHeader className="border-b"><SheetTitle>History</SheetTitle></SheetHeader>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          <HistoryList versions={versions} preview={preview} onPick={(version) => { setPreview(version); setHistoryOpen(false); }} />
        </div>
      </SheetContent>
    </Sheet>

    <Sheet open={modelOpen && mobile} onOpenChange={setModelOpen}>
      <SheetContent side="bottom" className="max-h-[80dvh] gap-0 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]" data-riff-models>
        <SheetHeader className="pb-1"><SheetTitle>Model</SheetTitle></SheetHeader>
        <div className="overflow-y-auto px-1.5">{menu}</div>
      </SheetContent>
    </Sheet>

    <HandOff open={handing} onClose={() => setHanding(null)} onSend={async (to, text) => {
      if (!await controller.flush(true)) throw new Error("Settle the conflicting edits first.");
      const chat = await handOff({ key: dashboardKey, id: note.id, to, text });
      router.push(`/chat/${chat}`);
    }} />

    <AlertDialog open={removing} onOpenChange={setRemoving}>
      <AlertDialogContent size="sm"><AlertDialogHeader><AlertDialogTitle>Delete this document?</AlertDialogTitle><AlertDialogDescription>“{draft.title}” and its history will be deleted.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={chat?.isRunning || sending} onClick={() => {
          speech.stop(); halt();
          void remove({ key: dashboardKey, id: note.id }).then(() => { controller.dispose(); batch.current = null; keepPending(""); router.replace("/live"); }, (cause) => toast.error(errorText(cause)));
        }}>Delete</AlertDialogAction></AlertDialogFooter>
        {chat?.isRunning && <p className="text-xs text-muted-foreground">Stop Perry's writing before deleting this document.</p>}
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function HistoryList({ versions, preview, onPick }: { versions: RiffVersion[] | undefined; preview: RiffVersion | null; onPick: (version: RiffVersion) => void }) {
  if (versions === undefined) return <p className="px-2.5 py-2 text-sm text-muted-foreground">Loading…</p>;
  if (!versions.length) return <p className="px-2.5 py-2 text-sm text-muted-foreground">Each change you and Perry make is kept here.</p>;
  return (
    <ol aria-label="Versions" className="max-h-[min(26rem,60vh)] overflow-y-auto">
      {versions.map((version, index) => {
        const label = version.kind === "edit" ? (version.label ? `“${version.label}”` : "Perry's edit") : version.kind === "restore" ? "Restored" : version.kind === "dictation" ? "Dictation" : "Your edits";
        const current = index === 0;
        return <li key={version.id}>
          <button type="button" disabled={current} aria-current={preview?.id === version.id} data-version={version.kind} onClick={() => onPick(version)}
            className={cn("grid min-h-11 w-full grid-cols-[1fr_auto] items-center gap-3 rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:hover:bg-transparent md:min-h-9",
              preview?.id === version.id && "bg-accent")}>
            <span className="truncate">{label}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{current ? "Now" : versionTime(version.at)}</span>
          </button>
        </li>;
      })}
    </ol>
  );
}

function SendItems({ empty, onBrain, onCopy, onDownload, onHand }: { empty: boolean; onBrain: () => void; onCopy: () => void; onDownload: () => void; onHand: (to: "someone" | "perry") => void }) {
  return <>
    <DropdownMenuItem disabled={empty} onClick={onBrain}><LibraryIcon />Save to Brain</DropdownMenuItem>
    <DropdownMenuItem disabled={empty} onClick={onCopy}><CopyIcon />Copy Markdown</DropdownMenuItem>
    <DropdownMenuItem disabled={empty} onClick={onDownload}><DownloadIcon />Download .md</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem disabled={empty} onClick={() => onHand("someone")}><UserRoundIcon />Send to someone…</DropdownMenuItem>
    <DropdownMenuItem disabled={empty} onClick={() => onHand("perry")}><SparklesIcon />Turn it into…</DropdownMenuItem>
  </>;
}

function HandOff({ open, onClose, onSend }: { open: "someone" | "perry" | null; onClose: () => void; onSend: (to: "someone" | "perry", text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [shown, setShown] = useState<"someone" | "perry">("someone");
  useEffect(() => { if (open) { setShown(open); setText(""); setProblem(""); } }, [open]);
  return (
    <Dialog open={open !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{shown === "someone" ? "Send to someone" : "Turn it into…"}</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || busy) return;
          setBusy(true);
          onSend(shown, text).then(() => onClose(), (cause) => setProblem(errorText(cause))).finally(() => setBusy(false));
        }}>
          <Input autoFocus value={text} onChange={(event) => { setText(event.target.value); setProblem(""); }} aria-label={shown === "someone" ? "Who" : "What"}
            placeholder={shown === "someone" ? "Asha on WhatsApp" : "a LinkedIn post, a slide outline…"} />
          <p className="text-xs text-muted-foreground">{shown === "someone" ? "Perry asks you before anything is sent." : "Opens a chat with Perry about this document."}</p>
          {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!text.trim() || busy}>{busy ? "Opening…" : shown === "someone" ? "Send" : "Start"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
