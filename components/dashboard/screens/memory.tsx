"use client";

import { useRouter } from "next/navigation";
import { ChevronRightIcon, PencilIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { MemoryView } from "@/convex/dashboard";
import { errorText } from "@/lib/format";
import { PERSONALITIES } from "@/lib/persona";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Markdown } from "../chat/markdown";
import { ActionButton, EmptyState, List, ListSkeleton, Page, RelativeTime, Section, StatusBadge, useTab } from "../common";

const TABS = ["memories", "about"] as const;

export function Memory() {
  const [tab, setTab] = useTab(TABS, "memories");
  return (
    <Page title="Memory" description="What Perry knows about you, and the place to correct it. All of it stays on this computer.">
      <Tabs value={tab} onValueChange={(value) => setTab(value as (typeof TABS)[number])}>
        <TabsList variant="line" className="mb-6 w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0 [&>button]:pb-2.5">
          <TabsTrigger value="memories">Memories</TabsTrigger>
          <TabsTrigger value="about">About you</TabsTrigger>
        </TabsList>
        <TabsContent value="memories"><Memories /></TabsContent>
        <TabsContent value="about"><AboutYou /></TabsContent>
      </Tabs>
    </Page>
  );
}

type Kind = MemoryView["kind"];
const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "profile", label: "Profile", hint: "Standing preferences and relationships. Loaded in every chat." },
  { kind: "core", label: "Long-term", hint: "Durable facts and decisions. Loaded in every chat." },
  { kind: "daily", label: "Daily notes", hint: "What happened each day. Today and yesterday load; older days are searched." },
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
function Memories() {
  const { dashboardKey } = useSession();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
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
      <TeachForm />
      <section aria-label="What Perry remembers" className="space-y-3">
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
          ? <EmptyState title="Nothing matches" action={<Button variant="outline" size="sm" onClick={() => { setSearch(""); setFilter("all"); }}>Clear filters</Button>}>Try other words, or look in every kind.</EmptyState>
          : <EmptyState mascot title="Nothing saved yet">Ask Perry to remember something in a chat, or add it above.</EmptyState>)}
        {memories && memories.length > 0 && (
          <List label="Memories">
            {memories.map((memory) => (
              <li key={memory.id} className="group/memory flex items-start gap-4 px-4 py-3.5">
                {editing?.id === memory.id ? (
                  <form className="min-w-0 flex-1" onSubmit={(event) => void saveEdit(event)}>
                    <Field data-invalid={Boolean(editing.error) || undefined}>
                      <FieldLabel htmlFor={`memory-edit-${memory.id}`} className="sr-only">Edit this memory</FieldLabel>
                      <Textarea id={`memory-edit-${memory.id}`} rows={2} value={editing.text} autoFocus aria-invalid={Boolean(editing.error) || undefined} className="min-h-14 resize-none"
                        onChange={(event) => setEditing({ ...editing, text: event.target.value, error: "" })}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditing(null);
                          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
                        }} />
                      {editing.error && <FieldError>{editing.error}</FieldError>}
                    </Field>
                    <div className="mt-2 flex gap-2">
                      <Button type="submit" size="sm" disabled={savingEdit || !editing.text.trim() || editing.text.trim() === memory.text}>{savingEdit && <Spinner />}Save</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={savingEdit}>Cancel</Button>
                    </div>
                  </form>
                ) : <>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] text-pretty [overflow-wrap:anywhere]">{memory.text}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                    <StatusBadge>{KINDS.find((item) => item.kind === memory.kind)?.label ?? memory.kind}</StatusBadge>
                    <span>{when(memory.createdAt, memory.day)}</span>
                    {memory.origin && <span>{ORIGINS[memory.origin]}</span>}
                    {memory.source === "dreaming" && <span title="Promoted from daily notes overnight">Promoted overnight</span>}
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
      </section>
    </div>
  );
}

function TeachForm() {
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
      else { setDraft(""); toast.success("Saved. Perry uses it from the next message."); }
    } catch (cause) {
      setRefused(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void add(event)} className="rounded-xl border bg-card p-4">
      <Field data-invalid={Boolean(refused) || undefined}>
        <FieldLabel htmlFor="memory-text">Teach Perry something</FieldLabel>
        <Textarea id="memory-text" rows={2} value={draft} placeholder="One sentence that will still make sense in six months, like: I take my coffee black."
          aria-invalid={Boolean(refused) || undefined} className="min-h-14 resize-none"
          onChange={(event) => { setDraft(event.target.value); setRefused(""); }}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        {refused && <FieldError>{refused}</FieldError>}
      </Field>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select items={KINDS.map((item) => ({ value: item.kind, label: item.label }))} value={kind} onValueChange={(value) => { if (value) setKind(value as Kind); }}>
          <SelectTrigger aria-label="Where to keep it" size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>{KINDS.map((item) => <SelectItem key={item.kind} value={item.kind}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{KINDS.find((item) => item.kind === kind)?.hint}</p>
        <Button type="submit" size="sm" disabled={!draft.trim() || saving}>{saving && <Spinner />}Save</Button>
      </div>
    </form>
  );
}

const BY = { owner: "You", assistant: "Your assistant", job: "A schedule" } as const;

/** USER.md and the assistant's name and personality: edit either, see who changed what, and bring an older version back. */
function AboutYou() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const persona = useQuery(api.dashboard.getPersona, { key: dashboardKey });
  const userHistory = useQuery(api.dashboard.personaHistory, { key: dashboardKey, kind: "user" });
  const identityHistory = useQuery(api.dashboard.personaHistory, { key: dashboardKey, kind: "identity" });
  const saveUserMd = useMutation(api.dashboard.saveUserMd);
  const saveIdentity = useMutation(api.dashboard.saveIdentity);
  const restore = useMutation(api.dashboard.restorePersonaVersion);
  const redo = useMutation(api.dashboard.redoOnboarding);

  const [userMd, setUserMd] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [personality, setPersonality] = useState<string | null>(null);
  const [saving, setSaving] = useState<"" | "user" | "identity">("");
  /** USER.md reads as a document; Edit (or a double click) turns it into its Markdown. */
  const [editingUser, setEditingUser] = useState(false);
  const stopEditingUser = () => { setUserMd(null); setEditingUser(false); };

  // A draft follows the saved text until it is edited, so a change made elsewhere (by the assistant, or a restore) shows up.
  const savedUser = persona?.user ?? "";
  const draftUser = userMd ?? savedUser;
  useEffect(() => { if (userMd === savedUser) setUserMd(null); }, [userMd, savedUser]);

  if (persona === undefined) return <ListSkeleton rows={2} />;
  const draftName = name ?? persona.name;
  const draftPersonality = personality ?? persona.personality;
  const identityDirty = draftName.trim() !== persona.name || draftPersonality.trim() !== persona.personality;
  const userDirty = draftUser.trim() !== savedUser.trim();

  const save = async (what: "user" | "identity") => {
    setSaving(what);
    try {
      const { changed } = what === "user"
        ? await saveUserMd({ key: dashboardKey, text: draftUser })
        : await saveIdentity({ key: dashboardKey, name: draftName, personality: draftPersonality });
      if (what === "user") stopEditingUser(); else { setName(null); setPersonality(null); }
      toast.success(changed ? "Saved. It applies from the next reply." : "Nothing changed.");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSaving("");
    }
  };
  const restoreButton = (id: string, what: string) => (
    <ActionButton variant="ghost" size="sm" action={() => restore({ key: dashboardKey, id: id as Id<"persona"> })} success="Restored. The version it replaced stays in history."
      confirm={{ title: `Restore this ${what}?`, body: "It becomes the current version. What it replaces stays in history, so you can switch back.", label: "Restore" }}>
      Restore
    </ActionButton>
  );

  return (
    <div>
      <Section title="Your assistant" description="Its name and how it comes across. Both go into every chat.">
        <form className="space-y-4 rounded-xl border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void save("identity"); }}>
          <Field>
            <FieldLabel htmlFor="identity-name">Name</FieldLabel>
            <Input id="identity-name" value={draftName} maxLength={40} placeholder={persona.defaultName} onChange={(event) => setName(event.target.value)} className="max-w-xs" />
          </Field>
          <Field>
            <FieldLabel htmlFor="identity-personality">Personality</FieldLabel>
            <Textarea id="identity-personality" rows={3} maxLength={600} value={draftPersonality} placeholder="Leave empty for the default: direct, clear and concise." onChange={(event) => setPersonality(event.target.value)} />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Start from a preset">
              {PERSONALITIES.map((item) => (
                <Button key={item.id} type="button" variant={draftPersonality === item.text ? "secondary" : "outline"} size="xs" className="rounded-full" onClick={() => setPersonality(item.text)}>
                  {item.label}
                </Button>
              ))}
            </div>
          </Field>
          <Button type="submit" disabled={!identityDirty || saving === "identity"}>{saving === "identity" && <Spinner />}Save</Button>
        </form>
      </Section>

      <Section title="USER.md" description={`Who you are, in your words. ${persona.name} reads all of it before every reply, and keeps it current as you talk.`}>
        {editingUser ? (
          <form className="rounded-xl border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void save("user"); }}>
            <Field>
              <FieldLabel htmlFor="user-md" className="sr-only">USER.md</FieldLabel>
              <Textarea id="user-md" value={draftUser} autoFocus placeholder={"# About you\n\n## Work\n\n## A typical day\n\n…"} onChange={(event) => setUserMd(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") stopEditingUser();
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
                }}
                className="min-h-72 font-mono text-[13px] leading-relaxed" spellCheck />
              <FieldDescription>Markdown. Ctrl+Enter saves, Esc cancels.</FieldDescription>
            </Field>
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={!userDirty || saving === "user"}>{saving === "user" && <Spinner />}Save</Button>
              <Button type="button" variant="ghost" onClick={stopEditingUser}>Cancel</Button>
            </div>
          </form>
        ) : savedUser.trim() ? (
          <article aria-label="USER.md" className="group/doc relative rounded-xl border bg-card py-5 pr-24 pl-6" onDoubleClick={() => setEditingUser(true)}>
            <Button variant="ghost" size="sm" className="absolute top-3 right-3 text-muted-foreground" onClick={() => setEditingUser(true)}><PencilIcon />Edit</Button>
            <Markdown text={savedUser} />
            {userHistory?.[0] && <p className="mt-5 border-t pt-3 text-xs text-muted-foreground">Last changed by {BY[userHistory[0].by].toLowerCase()}, <RelativeTime at={userHistory[0].createdAt} />.</p>}
          </article>
        ) : (
          <EmptyState title="Nothing here yet" action={<Button variant="outline" size="sm" onClick={() => setEditingUser(true)}><PencilIcon />Write it</Button>}>
            Your work, your day, the people who matter and how you like replies. {persona.name} fills it in as you talk, too.
          </EmptyState>
        )}
      </Section>

      <Section title="History" description="Every saved version, newest first. Restoring one keeps the version it replaces.">
        {(userHistory === undefined || identityHistory === undefined) && <ListSkeleton rows={2} />}
        {userHistory?.length === 0 && identityHistory?.length === 0 && <EmptyState title="No versions yet">Saving either of the above starts the history.</EmptyState>}
        {((userHistory?.length ?? 0) > 0 || (identityHistory?.length ?? 0) > 0) && (
          <List label="Versions">
            {userHistory?.map((version, index) => (
              <li key={version.id} className="flex items-start gap-4 px-4 py-3">
                <Collapsible className="min-w-0 flex-1">
                  <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm font-medium">
                    <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
                    USER.md{index === 0 && <span className="font-normal text-muted-foreground">(current)</span>}
                  </CollapsibleTrigger>
                  <p className="mt-0.5 pl-5 text-xs text-muted-foreground">{BY[version.by]} · <RelativeTime at={version.createdAt} /></p>
                  <CollapsibleContent>
                    <div className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted/60 px-4 py-3 text-sm"><Markdown text={version.text ?? ""} /></div>
                  </CollapsibleContent>
                </Collapsible>
                {index > 0 && restoreButton(version.id, "USER.md")}
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

      <Section title="Start over" description="Go through the welcome page again. What you save there becomes the newest version; nothing is lost.">
        <ActionButton variant="outline" action={async () => { await redo({ key: dashboardKey }); router.push("/welcome"); }}>Open the welcome page</ActionButton>
      </Section>
    </div>
  );
}
