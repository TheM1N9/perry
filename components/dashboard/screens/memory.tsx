"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookmarkIcon, CalendarDaysIcon, ChevronRightIcon, FileTextIcon, FolderIcon, MessageSquareIcon, SearchIcon, UserIcon, UserRoundIcon, XIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { MemoryView } from "@/convex/dashboard";
import { ENGINE_LABELS, isEngine } from "@/convex/lib/engines";
import { noteHref } from "@/convex/lib/notes";
import type { MemoryPage } from "@/convex/pages";
import { errorText } from "@/lib/format";
import { PERSONALITIES } from "@/lib/persona";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from "../chat/markdown";
import { SaveStatus, useAutosave, type SaveState } from "../autosave";
import { ActionButton, EmptyState, InfoTip, List, ListSkeleton, RelativeTime, Section, TextTip } from "../common";

type Kind = MemoryView["kind"];
const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "profile", label: "About me", hint: "How you like things done. In every chat." },
  { kind: "core", label: "Things to remember", hint: "Facts that stay true, in their section. In every chat." },
  { kind: "daily", label: "Today's journal", hint: "What happened. Today and yesterday are in every chat; older days are recalled." },
];
const ORIGINS = { owner: "From you", tool: "From a chat", job: "From a schedule" } as const;
/** The list shows at most this many; a search finds the rest. */
const LIMIT = 25;

function when(ts: number, day?: string): string {
  // A daily note's day is already a calendar date, so it is shown as written, not shifted by timezone.
  const date = day ? new Date(`${day}T12:00:00`) : new Date(ts);
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * What Perry remembers. The agent writes here through its remember tool; this
 * view exists because a memory it got slightly wrong is worse than none.
 */
/** Memories from before pages, until Perry moves them into theirs; nothing once they are moved. */
export function OlderMemories() {
  const { dashboardKey } = useSession();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  // A link from a reply's "From memory" opens on that memory (?q=its words).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setSearch(q);
  }, []);
  const [filter, setFilter] = useState<Kind | "all">("all");
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const memories = useQuery(api.dashboard.listMemories, { key: dashboardKey, query: term, kind: filter === "all" ? undefined : filter });
  const deleteMemory = useMutation(api.dashboard.deleteMemory);
  const editMemory = useMutation(api.dashboard.editMemory);
  /** The memory being edited, its new words, and why a save was refused. */
  const [editing, setEditing] = useState<{ id: string; text: string; error: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const filterLabel = KINDS.find((item) => item.kind === filter)?.label;

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || savingEdit) return;
    // The same words again, or none: nothing to save, so the editor just closes.
    const before = memories?.find((memory) => memory.id === editing.id)?.text;
    if (!editing.text.trim() || editing.text.trim() === before) return setEditing(null);
    setSavingEdit(true);
    try {
      // Refused (too long for its layer, say), the words stay in the box to be changed again.
      const reason = await editMemory({ key: dashboardKey, id: editing.id, text: editing.text });
      if (reason) setEditing({ ...editing, error: reason });
      else { setEditing(null); toast.success("Saved. Perry uses the new words from the next message."); }
    } catch (cause) {
      setEditing({ ...editing, error: errorText(cause) });
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Only what is not in a page yet: Brain shows Teach Perry something and the memory pages above this, once. */}
      {/* Memories from before pages, until Perry moves them into theirs: none once moved. */}
      {(memories === undefined || memories.length > 0 || term || filter !== "all") && <section aria-label="What Perry remembers" className="space-y-3">
        <h2 className="text-md font-semibold tracking-[-0.01em]">Older memories</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <ToggleGroup value={[filter]} onValueChange={(value) => setFilter((value[0] as Kind | "all" | undefined) ?? "all")} variant="outline" size="sm" aria-label="Filter by kind">
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            {KINDS.map((item) => <ToggleGroupItem key={item.kind} value={item.kind}>{item.label}</ToggleGroupItem>)}
          </ToggleGroup>
          <InputGroup className="h-8 sm:w-64">
            <InputGroupAddon><SearchIcon /></InputGroupAddon>
            <InputGroupInput type="search" aria-label="Search memories" placeholder="Search" value={search} autoComplete="off" onChange={(event) => setSearch(event.target.value)} />
            {search && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}><XIcon /></InputGroupButton></InputGroupAddon>}
          </InputGroup>
        </div>
        {memories !== undefined && (
          <p className="text-sm text-muted-foreground" role="status">
            {memories.length === LIMIT ? `The ${LIMIT} newest` : `${memories.length} ${memories.length === 1 ? "memory" : "memories"}`}
            {filterLabel ? ` in ${filterLabel}` : ""}{term ? ` matching “${term}”` : ""}
            {memories.length === LIMIT ? ". Search to find older ones." : ""}
          </p>
        )}
        {memories === undefined && <ListSkeleton />}
        {memories?.length === 0 && (term || filter !== "all"
          ? <EmptyState title="Nothing matches" action={<Button variant="outline" size="sm" onClick={() => { setSearch(""); setFilter("all"); }}>Clear filters</Button>} />
          : <EmptyState title="None left" />)}
        {memories && memories.length > 0 && (
          <List label="Memories">
            {memories.map((memory) => (
              <li key={memory.id} className="group/memory flex items-start gap-4 px-4 py-3.5">
                {editing?.id === memory.id ? (
                  <form className="min-w-0 flex-1" onSubmit={(event) => void saveEdit(event)}>
                    <Field data-invalid={Boolean(editing.error) || undefined}>
                      <FieldLabel htmlFor={`memory-edit-${memory.id}`} className="sr-only">Edit this memory</FieldLabel>
                      <Textarea id={`memory-edit-${memory.id}`} rows={2} value={editing.text} autoFocus
                        onFocus={(event) => { const end = event.currentTarget.value.length; event.currentTarget.setSelectionRange(end, end); }} aria-invalid={Boolean(editing.error) || undefined} className="min-h-14 resize-none"
                        onChange={(event) => setEditing({ ...editing, text: event.target.value, error: "" })}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditing(null);
                          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
                        }} />
                      {editing.error && <FieldError>{editing.error}</FieldError>}
                    </Field>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <Button type="submit" variant="ghost" size="xs" className="text-primary hover:text-primary" disabled={savingEdit} aria-busy={savingEdit || undefined}>{savingEdit && <Spinner />}Save</Button>
                      <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setEditing(null)} disabled={savingEdit}>Cancel</Button>
                      <span className="ml-1 text-xs text-muted-foreground">Enter saves, Esc cancels</span>
                    </div>
                  </form>
                ) : <>
                <div className="min-w-0 flex-1">
                  <p className="text-md text-pretty [overflow-wrap:anywhere]">{memory.text}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                    <span>{KINDS.find((item) => item.kind === memory.kind)?.label ?? memory.kind}</span>
                    {memory.chat && <TextTip tip="Kept to one chat: no other chat sees it." spoken="kept to one chat">Only in {memory.chat}</TextTip>}
                    {memory.project && (
                      <Tooltip>
                        <TooltipTrigger render={<Link href={`/projects/${memory.projectId}`} />} className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
                          Only in {memory.project}<span className="sr-only"> (kept to a project)</span>
                        </TooltipTrigger>
                        <TooltipContent>Kept to a project: only its chats see it.</TooltipContent>
                      </Tooltip>
                    )}
                    <span>{when(memory.createdAt, memory.day)}</span>
                    {memory.origin && <span>{ORIGINS[memory.origin]}</span>}
                    {memory.source === "dreaming" && <TextTip tip="Promoted from daily notes overnight">Promoted overnight</TextTip>}
                    {memory.tags.length > 0 && <span>{memory.tags.map((tag) => `#${tag}`).join(" ")}</span>}
                    {memory.editedAt && <span title={`Edited ${new Date(memory.editedAt).toLocaleString()}`}>Edited</span>}
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => setEditing({ id: memory.id, text: memory.text, error: "" })}>Edit</Button>
                <ActionButton variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive" action={() => deleteMemory({ key: dashboardKey, id: memory.id })} success="Forgotten."
                  confirm={{ title: "Forget this?", body: <>&ldquo;{memory.text.length > 160 ? `${memory.text.slice(0, 160)}…` : memory.text}&rdquo; is deleted, and Perry won&apos;t recall it again.</>, label: "Forget" }}>
                  Forget
                </ActionButton>
                </>}
              </li>
            ))}
          </List>
        )}
      </section>}
    </div>
  );
}

const PAGE_ICONS = { about: UserIcon, remember: BookmarkIcon, journal: CalendarDaysIcon, person: UserRoundIcon, chat: MessageSquareIcon, page: FileTextIcon } as const;
const GROUPS: Array<{ pinned?: boolean; kinds: Array<MemoryPage["kind"]>; label: string }> = [
  { pinned: true, kinds: ["about", "remember", "journal", "person", "chat", "page"], label: "Pinned: in every chat" },
  { kinds: ["about", "remember"], label: "Not pinned" },
  { kinds: ["journal"], label: "Journal" },
  { kinds: ["person"], label: "People" },
  { kinds: ["chat"], label: "Kept to one chat" },
];
/** Journal days shown before "more". */
const DAYS = 7;

/**
 * Memory as pages (convex/pages.ts): About me, Things to remember, a journal
 * page a day, a page per person, and what a chat kept to itself. Each opens in
 * the page editor, where every memory is a line to read and edit as text.
 */
export function MemoryPages({ filter = "" }: { filter?: string }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const pages = useQuery(api.pages.memoryPages, { key: dashboardKey });
  const usage = useQuery(api.pages.pinnedUsage, { key: dashboardKey });
  const open = useMutation(api.pages.openMemoryPage);
  const [allDays, setAllDays] = useState(false);
  const go = (kind: "about" | "remember" | "journal") => void open({ key: dashboardKey, kind }).then((id) => router.push(noteHref(id)), (cause) => toast.error(`Couldn't open it: ${errorText(cause)}`));
  if (pages === undefined) return <ListSkeleton rows={3} />;
  const has = (kind: MemoryPage["kind"]) => pages.some((page) => page.kind === kind && !page.projectId);
  return (
    <section aria-label="Memory pages" className="space-y-6">
      {GROUPS.map((group) => {
        // Pinned pages (any kind) come first; each other group has the rest of its kind.
        let shown = pages.filter((page) => group.kinds.includes(page.kind) && (group.pinned ? page.pinned || page.pinnedSections?.length : !(page.pinned || page.pinnedSections?.length))
          && (!filter || `${page.title} ${page.project ?? ""}`.toLocaleLowerCase().includes(filter)));
        const more = group.kinds.includes("journal") && !allDays && shown.length > DAYS ? shown.length - DAYS : 0;
        if (more) shown = shown.slice(0, DAYS);
        const starters = group.pinned && !filter ? (["about", "remember"] as const).filter((kind) => !has(kind)) : [];
        if (!shown.length && !starters.length) return null;
        return (
          <div key={group.label}>
            <h2 className="mb-1 text-sm font-medium text-muted-foreground">{group.label}</h2>
            <List label={group.label}>
              {starters.map((kind) => (
                <li key={kind} className="py-2.5">
                  <button type="button" className="flex items-center gap-3 text-md font-medium hover:underline underline-offset-2" onClick={() => go(kind)} data-memory-page={kind}>
                    {kind === "about" ? <UserIcon className="size-4 text-muted-foreground" /> : <BookmarkIcon className="size-4 text-muted-foreground" />}
                    {kind === "about" ? "About me" : "Things to remember"}
                  </button>
                </li>
              ))}
              {shown.map((page) => {
                const Icon = PAGE_ICONS[page.kind];
                return (
                  <li key={page.id} className="relative flex items-center gap-3 py-2.5">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <Link href={noteHref(page.id)} data-memory-page={page.kind} className="min-w-0 flex-1 truncate text-md font-medium after:absolute after:inset-0 hover:underline underline-offset-2">{page.title}</Link>
                    {page.project && <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><FolderIcon className="size-3" />{page.project}</span>}
                    {!page.pinned && page.pinnedSections && <span className="shrink-0 truncate text-xs text-muted-foreground">{page.pinnedSections.join(", ")}</span>}
                  </li>
                );
              })}
            </List>
            {group.pinned && usage && (
              <p className="mt-1 text-xs text-muted-foreground" data-usage>
                {usage.used.toLocaleString()} of {usage.budget.toLocaleString()} characters{usage.engine && isEngine(usage.engine) ? ` on ${ENGINE_LABELS[usage.engine]}` : ""}{usage.left.length ? `. Sent as summaries: ${usage.left.join(", ")}.` : "."}
              </p>
            )}
            {more > 0 && <Button variant="ghost" size="xs" className="mt-1 text-muted-foreground" onClick={() => setAllDays(true)}>{more} more {more === 1 ? "day" : "days"}</Button>}
          </div>
        );
      })}
    </section>
  );
}

export function TeachForm() {
  const { dashboardKey } = useSession();
  const addMemory = useMutation(api.dashboard.addMemory);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<Kind>("core");
  const [refused, setRefused] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    setRefused("");
    try {
      // A full layer refuses the memory; it stays in the box to be shortened or saved later.
      const reason = await addMemory({ key: dashboardKey, text, kind });
      if (reason) setRefused(reason);
      else { setDraft(""); toast.success("Remembered. Perry uses it from the next message."); }
    } catch (cause) {
      setRefused(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void add(event)} aria-label="Teach Perry something">
      <Field data-invalid={Boolean(refused) || undefined}>
        <FieldLabel htmlFor="memory-text">Teach Perry something</FieldLabel>
        <Textarea id="memory-text" rows={2} value={draft} placeholder="I take my coffee black."
          aria-invalid={Boolean(refused) || undefined} className="min-h-14 resize-none"
          onChange={(event) => { setDraft(event.target.value); setRefused(""); }}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        {refused && <FieldError>{refused}</FieldError>}
      </Field>
      <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
        <Select items={KINDS.map((item) => ({ value: item.kind, label: item.label }))} value={kind} onValueChange={(value) => { if (value) setKind(value as Kind); }}>
          <SelectTrigger aria-label="Where to keep it" size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>{KINDS.map((item) => <SelectItem key={item.kind} value={item.kind}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <InfoTip>{KINDS.find((item) => item.kind === kind)?.hint ?? ""}</InfoTip>
        <span className="flex-1" />
        {(draft.trim() || saving) && <Button type="submit" size="sm" disabled={saving} aria-busy={saving || undefined}>{saving && <Spinner />}Remember</Button>}
      </div>
    </form>
  );
}

const BY = { owner: "You", assistant: "Your assistant", job: "A schedule" } as const;

/**
 * Settings → General: the assistant's name and personality, each saved as you
 * type. Their earlier versions are under Brain → About me, with its own.
 */
export function YourAssistant() {
  const { dashboardKey } = useSession();
  const persona = useQuery(api.dashboard.getPersona, { key: dashboardKey });
  const saveIdentity = useMutation(api.dashboard.saveIdentity);
  const name = useAutosave({ saved: persona?.name ?? "", save: (text) => saveIdentity({ key: dashboardKey, name: text }) });
  const personality = useAutosave({ saved: persona?.personality ?? "", save: (text) => saveIdentity({ key: dashboardKey, personality: text }) });
  // The two fields save on their own; one line says how both went.
  const both = [name.state, personality.state];
  const identity: SaveState = both.find((state) => state.status === "error") ?? both.find((state) => state.status === "saving")
    ?? both.find((state) => state.status === "saved") ?? { status: "idle" };

  return (
    <Section title="Your assistant">
      {persona === undefined ? <ListSkeleton rows={2} /> : (
        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="identity-name">Name</FieldLabel>
            <Input id="identity-name" value={name.value} maxLength={40} placeholder={persona.defaultName} className="max-w-xs" {...name.field}
              onChange={(event) => name.change(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void name.flush(); } }} />
          </Field>
          <Field>
            <FieldLabel htmlFor="identity-personality">Personality</FieldLabel>
            <Textarea id="identity-personality" rows={3} maxLength={600} value={personality.value} placeholder="Leave empty for the default: direct, clear and concise." {...personality.field}
              onChange={(event) => personality.change(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void personality.flush(); } }} />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Start from a preset">
              {PERSONALITIES.map((item) => (
                <Button key={item.id} type="button" variant={personality.value === item.text ? "secondary" : "outline"} size="xs" className="rounded-full" onClick={() => personality.change(item.text, { now: true })}>
                  {item.label}
                </Button>
              ))}
            </div>
          </Field>
          <SaveStatus state={identity} idle="Saves as you type." onRetry={() => { void name.flush(); void personality.flush(); }} />
        </div>
      )}
    </Section>
  );
}

/**
 * About me's versions (it is USER.md: persona.ts keeps each), and the
 * assistant's name and personality's: see who changed what, and bring an
 * older one back. Shown under the About me page.
 */
export function AboutVersions() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const userHistory = useQuery(api.dashboard.personaHistory, { key: dashboardKey, kind: "user" });
  const identityHistory = useQuery(api.dashboard.personaHistory, { key: dashboardKey, kind: "identity" });
  const restore = useMutation(api.dashboard.restorePersonaVersion);
  const redo = useMutation(api.dashboard.redoOnboarding);

  const restoreButton = (id: string, what: string) => (
    <ActionButton variant="ghost" size="sm" action={() => restore({ key: dashboardKey, id: id as Id<"persona"> })} success="Restored. The version it replaced stays in history."
      confirm={{ title: `Restore this ${what}?`, body: "It becomes the current version. What it replaces stays in history, so you can switch back.", label: "Restore" }}>
      Restore
    </ActionButton>
  );

  return (
    <div data-about-versions>
      <Section title="History">
        {(userHistory === undefined || identityHistory === undefined) && <ListSkeleton rows={2} />}
        {userHistory?.length === 0 && identityHistory?.length === 0 && <EmptyState title="No versions yet" />}
        {((userHistory?.length ?? 0) > 0 || (identityHistory?.length ?? 0) > 0) && (
          <List label="Versions">
            {userHistory?.map((version, index) => (
              <li key={version.id} className="flex items-start gap-4 px-4 py-3">
                <Collapsible className="min-w-0 flex-1">
                  <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 rounded-md text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
                    About me{index === 0 && <span className="font-normal text-muted-foreground"> (current)</span>}
                  </CollapsibleTrigger>
                  <p className="mt-0.5 pl-5 text-xs text-muted-foreground">{BY[version.by]} · <RelativeTime at={version.createdAt} /></p>
                  <CollapsibleContent>
                    <ScrollArea className="mt-2 ml-1.5 border-l-2" viewportClassName="max-h-80"><div className="py-1 pr-4 pl-4 text-sm"><Markdown text={version.text ?? ""} /></div></ScrollArea>
                  </CollapsibleContent>
                </Collapsible>
                {index > 0 && restoreButton(version.id, "About me")}
              </li>
            ))}
            {identityHistory?.map((version, index) => (
              <li key={version.id} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1 pl-5">
                  <p className="text-sm font-medium">{version.name}{index === 0 && <span className="font-normal text-muted-foreground"> (current)</span>}</p>
                  {version.personality && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{version.personality}</p>}
                  <p className="mt-0.5 text-xs text-muted-foreground">{BY[version.by]} · <RelativeTime at={version.createdAt} /></p>
                </div>
                {index > 0 && restoreButton(version.id, "name and personality")}
              </li>
            ))}
          </List>
        )}
      </Section>

      <Section title="Start over" description="Nothing is lost: what you save becomes the newest version.">
        <ActionButton variant="outline" action={async () => { await redo({ key: dashboardKey }); router.push("/welcome"); }}>Open the welcome page</ActionButton>
      </Section>
    </div>
  );
}
