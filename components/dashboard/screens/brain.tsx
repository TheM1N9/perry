"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArchiveIcon, BookUserIcon, ChevronRightIcon, FileTextIcon, FileUpIcon, PlusIcon, SearchIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { noteHref } from "@/convex/lib/notes";
import type { Found } from "@/convex/pages";
import type { ProposalView } from "@/convex/compaction";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, List, ListSkeleton, Page } from "../common";
import { MemoryPages, OlderMemories, TeachForm } from "./memory";
import { NoteRows } from "./notes";

/**
 * Brain (issue #210): everything Perry knows and everything you write, as
 * pages. What is pinned is in every chat; the journal, people, and your other
 * pages are recalled when they bear on a chat. One search finds a line in any
 * of them, by its words or its meaning.
 */
export function Brain() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const notes = useQuery(api.notes.list, { key: dashboardKey });
  const create = useMutation(api.notes.create);
  const open = useMutation(api.pages.openMemoryPage);
  const [filter, setFilter] = useState(params.get("q") ?? "");
  const [deep, setDeep] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const needle = filter.trim().toLocaleLowerCase();

  // The old About you links (/about, /memory?tab=about) open About me.
  useEffect(() => {
    if (params.get("open") !== "about" && params.get("tab") !== "about") return;
    void open({ key: dashboardKey, kind: "about" }).then((id) => router.replace(noteHref(id)), () => {});
  }, [dashboardKey, open, params, router]);

  const newPage = async (title?: string, content?: string) => {
    try {
      const id = await create({ key: dashboardKey, ...(title ? { title } : {}), ...(content !== undefined ? { content } : {}) });
      router.push(noteHref(id));
    } catch (cause) {
      toast.error(`Couldn't make it: ${errorText(cause)}`);
    }
  };
  // A Markdown file from elsewhere opens as a new page.
  const openFile = async (picked: File | undefined) => {
    if (!picked) return;
    await newPage(picked.name.replace(/\.(md|markdown|txt)$/i, ""), await picked.text());
  };
  // Your own pages only: About me, Things to remember, journal days and people are listed above, in their groups.
  const pages = (notes ?? []).filter((note) => !note.kind && !note.pinned && !note.pinnedSections?.length
    && (!needle || `${note.title} ${note.preview} ${note.project ?? ""}`.toLocaleLowerCase().includes(needle)));

  return (
    <Page
      title="Brain"
      description="All of it stays on this computer."
      actions={<>
        <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" aria-label="Open a Markdown file"
          onChange={(event) => { void openFile(event.target.files?.[0]); event.target.value = ""; }} />
        <Button variant="outline" onClick={() => file.current?.click()}><FileUpIcon />Open .md</Button>
        <Button onClick={() => void newPage()}><PlusIcon />New page</Button>
      </>}
    >
      <div className="space-y-8">
        <InputGroup>
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="Search Brain" placeholder="Search Brain" value={filter} autoComplete="off" onChange={(event) => setFilter(event.target.value)} />
          {filter && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setFilter("")}><XIcon /></InputGroupButton></InputGroupAddon>}
        </InputGroup>
        {needle.length >= 2 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch id="brain-deep" checked={deep} onCheckedChange={setDeep} />
            <label htmlFor="brain-deep">Include archive</label>
          </div>
        )}
        {needle.length >= 2 && <FoundLines term={filter.trim()} deep={deep} />}
        {!needle && <TeachForm />}
        <MemoryPages filter={needle} />
        {!needle && <BrainChanges />}
        {!needle && <Archive />}
        <section aria-label="Pages" className="space-y-1">
          <h2 className="text-sm font-medium text-muted-foreground">Pages</h2>
          {notes === undefined ? <ListSkeleton rows={3} /> : pages.length === 0 ? (
            <EmptyState title={needle ? "No page title matches" : "No pages yet"}>{needle ? undefined : "Start one, or ask Perry to write something down."}</EmptyState>
          ) : <NoteRows notes={pages} />}
        </section>
        <OlderMemories />
      </div>
    </Page>
  );
}

/**
 * Changes to Brain the owner approved (compaction.ts): what Perry tidied with
 * their yes, newest first, each with Undo; and how many wait in Needs you.
 */
function BrainChanges() {
  const { dashboardKey } = useSession();
  const changes = useQuery(api.compaction.list, { key: dashboardKey });
  const undo = useMutation(api.compaction.undo);
  const [undoing, setUndoing] = useState<string | null>(null);
  if (!changes?.length) return null;
  const waiting = changes.filter((change) => change.status === "pending").length;
  const applied = changes.filter((change) => change.status === "applied").slice(0, 8);
  const run = async (id: ProposalView["id"]) => {
    setUndoing(id);
    try {
      const done = await undo({ key: dashboardKey, id });
      if (done.undone) toast.success("Undone. The lines are back as they were.");
      else toast.error(done.error ?? "Couldn't undo it.");
    } catch (cause) {
      toast.error(`Couldn't undo it: ${errorText(cause)}`);
    } finally {
      setUndoing(null);
    }
  };
  return (
    <section aria-label="Tidied" className="space-y-1">
      <h2 className="text-sm font-medium text-muted-foreground">Tidied with your OK</h2>
      {waiting > 0 && <p className="text-sm text-muted-foreground"><Link href="/inbox" className="underline-offset-2 hover:underline">{waiting} waiting in Needs you</Link></p>}
      {applied.length > 0 && (
        <List label="Tidied">
          {applied.map((change) => (
            <li key={change.id} className="flex items-center gap-3 py-2.5" data-change={change.kind}>
              <SparklesIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-md">{change.after[0]}{change.after.length > 1 ? ` (+${change.after.length - 1})` : ""}</p>
                <p className="truncate text-xs text-muted-foreground">{change.before.length} {change.before.length === 1 ? "line" : "lines"}{change.page ? ` · ${change.page.title}` : ""}</p>
              </div>
              <Button variant="ghost" size="sm" disabled={undoing !== null} onClick={() => void run(change.id)}>{undoing === change.id && <Spinner />}Undo</Button>
            </li>
          ))}
        </List>
      )}
    </section>
  );
}

/**
 * Brain's archive (archive.ts): lines unused for months, out of every chat
 * and of normal search; newest first, or those with the words searched, each
 * with Restore.
 */
function Archive() {
  const { dashboardKey } = useSession();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const archived = useQuery(api.archive.list, open ? { key: dashboardKey, ...(words.trim() ? { query: words.trim() } : {}) } : "skip");
  const restore = useMutation(api.archive.restore);
  const bring = async (id: string) => {
    try {
      await restore({ key: dashboardKey, ids: [id] });
      toast.success("Back in Brain.");
    } catch (cause) {
      toast.error(`Couldn't restore it: ${errorText(cause)}`);
    }
  };
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground" data-archive-toggle>
        <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} aria-hidden />Archive
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2" aria-label="Archive">
        <p className="text-xs text-muted-foreground">Lines nobody used for a while. Perry finds them only when he looks deeper.</p>
        <InputGroup>
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="Search the archive" placeholder="Search the archive" value={words} onChange={(event) => setWords(event.target.value)} />
        </InputGroup>
        {archived === undefined ? <ListSkeleton rows={2} /> : !archived.lines.length ? <EmptyState title={words.trim() ? "Nothing archived says that" : "Nothing archived"} /> : (
          <List label="Archived lines">
            {archived.lines.map((line) => (
              <li key={line.id} className="flex items-start gap-3 py-2.5" data-archived>
                <ArchiveIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-md">{line.text}</p>
                  {line.page && <p className="mt-0.5 truncate text-xs text-muted-foreground"><Link href={noteHref(line.page.id)} className="hover:underline underline-offset-2">{line.page.title}</Link>{line.section ? ` › ${line.section}` : ""}</p>}
                </div>
                <Button variant="ghost" size="sm" onClick={() => void bring(line.id)}>Restore</Button>
              </li>
            ))}
          </List>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

const KIND = { profile: "About me", core: "Things to remember", daily: "Journal", page: "Page" } as const;

/** Lines that match the search, in memory and pages alike, by words or meaning (pages.search). */
function FoundLines({ term, deep }: { term: string; deep?: boolean }) {
  const { dashboardKey } = useSession();
  const search = useAction(api.pages.search);
  const [found, setFound] = useState<{ term: string; deep: boolean; hits: Found[] } | null>(null);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void search({ key: dashboardKey, query: term, limit: 12, ...(deep ? { deep: true } : {}) })
        .then((hits) => { if (current) setFound({ term, deep: Boolean(deep), hits }); }, () => { if (current) setFound({ term, deep: Boolean(deep), hits: [] }); });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [dashboardKey, search, term, deep]);
  if (found?.term !== term || found.deep !== Boolean(deep)) return <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />Searching…</p>;
  if (!found.hits.length) return <EmptyState title="Nothing in Brain says that" />;
  return (
    <section aria-label="Found in Brain" className="space-y-1">
      <h2 className="text-sm font-medium text-muted-foreground">Found</h2>
      <List label="Found in Brain">
        {found.hits.map((hit) => (
          <li key={hit.id} className="relative flex items-start gap-3 py-2.5" data-found={hit.kind}>
            {hit.page ? <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : <BookUserIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <div className="min-w-0 flex-1">
              {hit.page
                ? <Link href={noteHref(hit.page.id)} className="block text-md after:absolute after:inset-0 hover:underline underline-offset-2">{hit.text}</Link>
                : <p className="text-md">{hit.text}</p>}
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {hit.archived && <span className="mr-1.5 font-medium" data-found-archived>Archived ·</span>}
                {hit.page ? `${hit.page.title}${hit.section ? ` › ${hit.section}` : ""}` : `${KIND[hit.kind]}, not yet in a page`}
              </p>
            </div>
          </li>
        ))}
      </List>
    </section>
  );
}
