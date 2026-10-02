"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookUserIcon, FileTextIcon, FileUpIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { noteHref } from "@/convex/lib/notes";
import type { Found } from "@/convex/pages";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BrainMap } from "../brain-map/brain-map";
import { EmptyState, List, ListSkeleton, Page } from "../common";
import { MemoryPages, OlderMemories } from "./memory";
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
  // List or Map (issue #225), in the address so Back and a link keep it. List unless asked.
  const map = params.get("view") === "map";
  const notes = useQuery(api.notes.list, map ? "skip" : { key: dashboardKey });
  const create = useMutation(api.notes.create);
  const open = useMutation(api.pages.openMemoryPage);
  const [filter, setFilter] = useState(params.get("q") ?? "");
  const file = useRef<HTMLInputElement>(null);
  const needle = filter.trim().toLocaleLowerCase();
  const setView = (next: string | undefined) => {
    if (!next || (next === "map") === map) return;
    router.replace(next === "map" ? "/brain?view=map" : "/brain");
  };

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
      wide={map ? "full" : false}
      actions={<>
        <ToggleGroup value={[map ? "map" : "list"]} onValueChange={(value) => setView(value[0])} size="sm" spacing={0} aria-label="View">
          <ToggleGroupItem value="list">List</ToggleGroupItem>
          <ToggleGroupItem value="map">Map</ToggleGroupItem>
        </ToggleGroup>
        <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" aria-label="Open a Markdown file"
          onChange={(event) => { void openFile(event.target.files?.[0]); event.target.value = ""; }} />
        <Button variant="outline" onClick={() => file.current?.click()}><FileUpIcon />Open .md</Button>
        <Button onClick={() => void newPage()}><PlusIcon />New page</Button>
      </>}
    >
      {map ? <BrainMap /> : <div className="space-y-8">
        <InputGroup>
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="Search Brain" placeholder="Search Brain" value={filter} autoComplete="off" onChange={(event) => setFilter(event.target.value)} />
          {filter && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setFilter("")}><XIcon /></InputGroupButton></InputGroupAddon>}
        </InputGroup>
        {needle.length >= 2 && <FoundLines term={filter.trim()} />}
        <MemoryPages filter={needle} />
        <section aria-label="Pages" className="space-y-1">
          <h2 className="text-sm font-medium text-muted-foreground">Pages</h2>
          {notes === undefined ? <ListSkeleton rows={3} /> : pages.length === 0 ? (
            <EmptyState title={needle ? "No page title matches" : "No pages yet"}>{needle ? undefined : "Start one, or ask Perry to write something down."}</EmptyState>
          ) : <NoteRows notes={pages} />}
        </section>
        <OlderMemories />
      </div>}
    </Page>
  );
}

const KIND = { profile: "About me", core: "Things to remember", daily: "Journal", page: "Page" } as const;

/** Lines that match the search, in memory and pages alike, by words or meaning (pages.search). */
function FoundLines({ term }: { term: string }) {
  const { dashboardKey } = useSession();
  const search = useAction(api.pages.search);
  const [found, setFound] = useState<{ term: string; hits: Found[] } | null>(null);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void search({ key: dashboardKey, query: term, limit: 12 })
        .then((hits) => { if (current) setFound({ term, hits }); }, () => { if (current) setFound({ term, hits: [] }); });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [dashboardKey, search, term]);
  if (found?.term !== term) return <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />Searching…</p>;
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
                {hit.page ? `${hit.page.title}${hit.section ? ` › ${hit.section}` : ""}` : `${KIND[hit.kind]}, not yet in a page`}
              </p>
            </div>
          </li>
        ))}
      </List>
    </section>
  );
}
