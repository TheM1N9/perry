"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronRightIcon, CodeIcon, CopyIcon, PinIcon, DownloadIcon, FileTextIcon, FolderIcon, FolderInputIcon, LinkIcon, MessageSquareIcon, MoreHorizontalIcon,
  SparklesIcon, Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { headingsOf, noteHref } from "@/convex/lib/notes";
import type { NoteSummary, NoteView } from "@/convex/notes";
import type { LineView } from "@/convex/pages";
import { copyText, errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { NoteAutosave } from "@/components/notes/autosave";
import { NoteEditor } from "@/components/notes/editor";
import { inspectMarkdown } from "@/components/notes/markdown";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SaveStatus, type SaveState } from "../autosave";
import { LocalMap } from "../brain-map/local-map";
import { AboutVersions } from "./memory";
import { EmptyState, List, ListSkeleton, Page, RelativeTime, StatusBadge, TopBar } from "../common";

/** Notes as rows: title, where, the first words, and when last changed. */
export function NoteRows({ notes, hideProject }: { notes: NoteSummary[]; hideProject?: boolean }) {
  return (
    <List label="Pages">
      {notes.map((note) => (
        <li key={note.id} className="relative flex items-start gap-3 py-3">
          <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <Link href={noteHref(note.id)} className="block truncate text-md font-medium after:absolute after:inset-0 hover:underline underline-offset-2">{note.title}</Link>
            {note.preview && <p className="mt-0.5 truncate text-sm text-muted-foreground">{note.preview}</p>}
          </div>
          {!hideProject && note.project && <StatusBadge>{note.project}</StatusBadge>}
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {note.pinned && <PinIcon className="size-3" aria-label="Pinned to every chat" />}
            {note.by === "assistant" && <SparklesIcon className="size-3" aria-label="Perry changed it last" />}
            <RelativeTime at={note.updatedAt} />
          </span>
        </li>
      ))}
    </List>
  );
}

/** One note, from the address. */
export function NoteScreen() {
  const { dashboardKey } = useSession();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const note = useQuery(api.notes.get, { key: dashboardKey, id });
  useEffect(() => { if (note) document.title = `${note.title} · Perry`; }, [note?.title]);

  if (note === undefined) return <Page title="Page"><ListSkeleton rows={4} /></Page>;
  if (note === null) {
    return (
      <Page title="Page">
        <EmptyState mascot title="This page isn't here" action={<Button variant="outline" size="sm" render={<Link href="/brain" />}>Brain</Button>}>
          It may have been deleted.
        </EmptyState>
      </Page>
    );
  }
  return <NoteEditing key={note.id} note={note} />;
}

/** The note's saves (NoteAutosave), made once for the note and fed each newer version the server sends. */
function useNoteSaves(note: NoteView) {
  const { dashboardKey } = useSession();
  const save = useMutation(api.notes.save);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [controller] = useState(() => {
    const made = new NoteAutosave((noteId, patch) => saveRef.current({ key: dashboardKey, id: noteId, ...patch }));
    made.receive(note);
    return made;
  });
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => controller.receive(note), [controller, note]);
  // Closing the tab with words still to save asks first, and saves them meanwhile.
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (!controller.dirty) return;
      void controller.flush();
      event.preventDefault();
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [controller]);
  // Leaving by an in-app link: what is typed is saved on the way out (never over a newer note).
  useEffect(() => () => { void controller.flush().finally(() => controller.dispose()); }, [controller]);
  return { controller, state };
}

function NoteEditing({ note }: { note: NoteView }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const { controller, state } = useNoteSaves(note);
  const draft = state.draft ?? { title: note.title, content: note.content };
  // The editor shows what it can give back unchanged; anything else is edited as Markdown, so nothing is lost.
  const fits = useMemo(() => inspectMarkdown(note.content), [note.id]);
  const [source, setSource] = useState(!fits.supported);
  const [removing, setRemoving] = useState(false);
  const remove = useMutation(api.notes.remove);
  const pin = useMutation(api.pages.pin);
  const pinTo = async (pinned: boolean, section?: string) => {
    try {
      await pin({ key: dashboardKey, id: note.id, pinned, ...(section ? { section } : {}) });
      toast.success(pinned ? "Pinned. Every chat that can read it gets it." : "Unpinned. Perry recalls it when it bears on a chat.");
    } catch (cause) {
      toast.error(`Couldn't change it: ${errorText(cause)}`);
    }
  };
  const sections = useMemo(() => [...new Set(headingsOf(draft.content).map((item) => item.text.replace(/[*_`]/g, "").trim()).filter(Boolean))], [draft.content]);
  const move = useMutation(api.notes.move);
  const projects = useQuery(api.projects.list, { key: dashboardKey });

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void controller.flush(true); }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [controller]);

  // A page of memory keeps its name and place: About me and Things to remember stay too.
  const memory = Boolean(note.kind);
  const lasting = note.kind === "about" || note.kind === "remember" || note.kind === "journey";
  const status: SaveState = state.status === "saving" ? { status: "saving" } : state.status === "dirty" ? { status: "editing" }
    : state.status === "error" ? { status: "error", error: state.error } : state.status === "saved" ? { status: "saved" } : { status: "idle" };
  const download = () => {
    const url = URL.createObjectURL(new Blob([draft.content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "note"}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const copy = (text: string, what: string) => void copyText(text).then(() => toast.success(`${what} copied.`), (cause) => toast.error(`Couldn't copy: ${errorText(cause)}`));
  const moveTo = async (projectId: Id<"projects"> | null) => {
    try {
      await move({ key: dashboardKey, id: note.id, projectId });
      toast.success(projectId ? "Moved. Only that project's chats can reach it now." : "Moved out. All your chats can reach it now.");
    } catch (cause) {
      toast.error(`Couldn't move it: ${errorText(cause)}`);
    }
  };

  return (
    <>
      <TopBar actions={<>
        <Button variant="ghost" size="icon-sm" className={note.pinned ? "text-foreground" : "text-muted-foreground"} aria-pressed={note.pinned}
          aria-label={note.pinned ? "Unpin from every chat" : "Pin to every chat"} title={note.pinned ? "Pinned: in every chat" : "Pin to every chat"} onClick={() => void pinTo(!note.pinned)}>
          {note.pinned ? <PinIcon className="fill-current" /> : <PinIcon />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Page options" />}><MoreHorizontalIcon /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {!memory && <DropdownMenuSub>
              <DropdownMenuSubTrigger><FolderInputIcon />Move to project</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={note.projectId ?? "none"} onValueChange={(value) => void moveTo(value === "none" ? null : value as Id<"projects">)}>
                  <DropdownMenuRadioItem value="none" closeOnClick>No project</DropdownMenuRadioItem>
                  {(projects ?? []).map((project) => <DropdownMenuRadioItem key={project.id} value={project.id} closeOnClick>{project.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>}
            {!note.pinned && sections.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><PinIcon />Pin a section</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  {sections.map((section) => (
                    <DropdownMenuCheckboxItem key={section} checked={note.pinnedSections?.includes(section) ?? false} onCheckedChange={(on) => void pinTo(Boolean(on), section)}>{section}</DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuCheckboxItem checked={source} onCheckedChange={(on) => {
              const back = inspectMarkdown(draft.content);
              if (!on && !back.supported) toast.info(`${back.reason} It stays as Markdown.`);
              setSource(Boolean(on) || !back.supported);
            }}><CodeIcon />Edit as Markdown</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={download}><DownloadIcon />Download .md</DropdownMenuItem>
            <DropdownMenuItem onClick={() => copy(draft.content, "Markdown")}><CopyIcon />Copy as Markdown</DropdownMenuItem>
            <DropdownMenuItem onClick={() => copy(`${window.location.origin}${noteHref(note.id)}`, "Link")}><LinkIcon />Copy link</DropdownMenuItem>
            {!lasting && <DropdownMenuSeparator />}
            {!lasting && <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}><Trash2Icon />Delete</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </>}>
        <Link href="/brain" className="text-muted-foreground hover:text-foreground">Brain</Link>
        <span className="text-muted-foreground/60" aria-hidden>/</span>
        <span className="truncate">{draft.title}</span>
      </TopBar>
      <main id="content" tabIndex={-1} className="flex-1 outline-none">
        <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 sm:px-8 sm:pt-8">
          <input
            aria-label="Title" value={draft.title} maxLength={160} placeholder="Untitled" readOnly={memory}
            className="w-full bg-transparent text-2xl font-semibold tracking-[-0.02em] outline-none placeholder:text-muted-foreground/60"
            onChange={(event) => controller.edit({ title: event.target.value })}
            onBlur={() => void controller.flush()}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (document.querySelector("[data-note-editor], #note-source") as HTMLElement | null)?.focus(); } }}
          />
          <div className="mt-1.5 mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {note.project && <Link href={`/projects/${note.projectId}`} className="inline-flex items-center gap-1 hover:text-foreground" data-project-chip><FolderIcon className="size-3" />{note.project}</Link>}
            {note.kind === "journey" && <span data-journey-note>Every chat of yours can read it</span>}
            {note.from && <Link href={`/chat/${note.from.id}`} className="inline-flex items-center gap-1 hover:text-foreground"><MessageSquareIcon className="size-3" />From “{note.from.title}”</Link>}
            <span className="inline-flex items-center gap-1">{note.by === "assistant" ? <><SparklesIcon className="size-3" />Perry</> : "You"}, <RelativeTime at={note.updatedAt} /></span>
            {(note.pinned || note.pinnedSections?.length) && <span className="inline-flex items-center gap-1" data-pinned><PinIcon className="size-3" />{note.pinned ? "In every chat" : `${note.pinnedSections!.join(", ")} in every chat`}</span>}
            <SaveStatus state={status} onRetry={() => void controller.flush(true)} className="min-h-0" />
          </div>
          {state.status === "conflict" && state.remote && (
            <div role="alert" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" data-conflict>
              <p className="min-w-0 flex-1">{state.remote.by === "assistant" ? "Perry" : "Someone"} changed this note while you typed. Your words are still here.</p>
              <Button size="sm" variant="outline" onClick={() => copy(draft.content, "Your version")}>Copy mine</Button>
              <Button size="sm" variant="outline" onClick={() => controller.useLatest()}>Load theirs</Button>
              <Button size="sm" onClick={() => controller.keepMine()}>Keep mine</Button>
            </div>
          )}
          {!fits.supported && source && <p className="mb-3 text-xs text-muted-foreground">{fits.reason} Edit it as Markdown here.</p>}
          {source ? (
            <Textarea id="note-source" aria-label={`${draft.title} as Markdown`} value={draft.content} rows={20}
              className="min-h-[50vh] font-mono text-sm leading-relaxed"
              onChange={(event) => controller.edit({ content: event.target.value })}
              onBlur={() => void controller.flush()} />
          ) : (
            <NoteEditor value={draft.content} label={draft.title} onChange={(content) => controller.edit({ content })} onBlur={() => void controller.flush()} />
          )}
          {note.kind === "person" && <AlsoAbout id={note.id} name={note.title} />}
          <LocalMap id={note.id} />
          <LineSources id={note.id} memory={memory} />
          {note.kind === "about" && (
            <Collapsible className="mt-3 border-t pt-3">
              <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
                <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />Earlier versions
              </CollapsibleTrigger>
              <CollapsibleContent><AboutVersions /></CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </main>
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this page?</AlertDialogTitle>
            <AlertDialogDescription>“{draft.title}” goes for good, for you and for Perry{memory ? ", with everything remembered in it" : ""}.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove({ key: dashboardKey, id: note.id }).then(() => { controller.dispose(); router.replace("/brain"); toast.success("Page deleted."); }, (cause) => toast.error(`Couldn't delete it: ${errorText(cause)}`))}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * A person's memories that live on other pages (a journal day, someone else's
 * page): each is one memory, kept where it was written, and shown here too.
 */
function AlsoAbout({ id, name }: { id: string; name: string }) {
  const { dashboardKey } = useSession();
  const found = useQuery(api.pages.mentions, { key: dashboardKey, id });
  if (!found?.length) return null;
  return (
    <section aria-label={`Also about ${name}`} className="mt-8" data-also-about>
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">Also about {name}</h2>
      <ul className="divide-y">
        {found.map((mention) => (
          <li key={mention.id} className="relative py-2" data-mention={mention.id}>
            <Link href={noteHref(mention.page.id)} className="block text-sm after:absolute after:inset-0 hover:underline underline-offset-2">{mention.text}</Link>
            <p className="mt-0.5 text-xs text-muted-foreground">{mention.page.title}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const WRITER = { owner: "You", assistant: "Perry", job: "A schedule" } as const;
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Where each line came from (convex/pages.ts): who wrote it, from which chat,
 * when, and when it was last confirmed. Folded away until asked for.
 */
function LineSources({ id, memory }: { id: string; memory: boolean }) {
  const { dashboardKey } = useSession();
  const [open, setOpen] = useState(false);
  const lines = useQuery(api.pages.lines, open ? { key: dashboardKey, id } : "skip");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-10 border-t pt-3" data-sources>
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
        {memory ? "Where each memory came from" : "Where each line came from"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {lines === undefined ? <ListSkeleton rows={2} /> : lines.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nothing written yet.</p> : (
          <ul className="mt-2 divide-y" aria-label="Lines and where they came from">
            {lines.map((line: LineView) => (
              <li key={line.id} className="py-2" data-line={line.id}>
                <p className="truncate text-sm">{line.text}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  {line.section && <span>{line.section}</span>}
                  <span>{line.by ? WRITER[line.by] : "You"}</span>
                  {line.from && <Link href={`/chat/${line.from.id}`} className="hover:text-foreground hover:underline">from “{line.from.title}”</Link>}
                  <span>{day(line.createdAt)}</span>
                  {line.editedAt && <span>edited {day(line.editedAt)}</span>}
                  {line.confirmedAt && <span>confirmed {day(line.confirmedAt)}</span>}
                  {line.origin === "tool" && <span>from a web page or app</span>}
                  {line.tags.length > 0 && <span>{line.tags.map((tag) => `#${tag}`).join(" ")}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
