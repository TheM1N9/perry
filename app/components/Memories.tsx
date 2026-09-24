"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/convex/_generated/api";
import { ActionButton, Empty, Icon, Loading, Section, Spinner, errorText, useToast } from "./ui";

/** The list shows at most this many; a search finds the rest. */
const LIMIT = 25;

function when(ts: number, day?: string): string {
  // A daily note's day is already a calendar date, so it is shown as written, not shifted by timezone.
  const date = day ? new Date(`${day}T12:00:00`) : new Date(ts);
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

type Kind = "profile" | "core" | "daily";
const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "profile", label: "Profile", hint: "Standing preferences and relationships. Loaded in every chat." },
  { kind: "core", label: "Long-term", hint: "Durable facts and decisions. Loaded in every chat." },
  { kind: "daily", label: "Daily notes", hint: "What happened each day. Today and yesterday load; older days are searched." },
];
const ORIGINS = { owner: "From you", tool: "From a tool", job: "From a job" } as const;

/**
 * What Perry knows, and the only place to correct it. The agent writes here
 * through the remember tool; this view exists because a memory it got slightly
 * wrong is worse than one it never stored.
 */
export function Memories({ dashboardKey }: { dashboardKey: string }) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<Kind>("core");
  const [filter, setFilter] = useState<Kind | undefined>(undefined);
  const [refused, setRefused] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const memories = useQuery(api.dashboard.listMemories, {
    key: dashboardKey,
    query: term,
    kind: filter,
  });
  const addMemory = useMutation(api.dashboard.addMemory);
  const deleteMemory = useMutation(api.dashboard.deleteMemory);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || saving) return;
    setSaving(true);
    setRefused("");
    try {
      // A full layer refuses the memory; it stays in the box to be shortened or saved later.
      const reason = await addMemory({ key: dashboardKey, text, kind: draftKind });
      if (reason) setRefused(reason);
      else { setDraft(""); toast({ tone: "success", text: "Saved. Perry will use it from the next message." }); }
    } catch (cause) {
      setRefused(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const filterLabel = KINDS.find((item) => item.kind === filter)?.label;

  return (
    <>
      <Section title="Teach Perry something" description="One self-contained sentence that will still make sense in six months.">
        <form className="section-pad" onSubmit={(event) => void add(event)}>
          <div className="field">
            <label htmlFor="memory-text">Memory</label>
            <textarea id="memory-text" className="textarea" rows={2} value={draft} placeholder="For example: I take my coffee black…" aria-invalid={Boolean(refused) || undefined} aria-describedby={refused ? "memory-error" : "memory-kind-hint"}
              onChange={(e) => { setDraft(e.target.value); setRefused(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            {refused && <p className="field-error" id="memory-error" role="alert">{refused}</p>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ margin: 0, flex: "1 1 220px" }}>
              <label htmlFor="memory-kind">Where to keep it</label>
              <select id="memory-kind" className="select" value={draftKind} onChange={(e) => setDraftKind(e.target.value as Kind)}>
                {KINDS.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn-primary btn-md" disabled={draft.trim().length === 0 || saving} aria-busy={saving || undefined}>{saving && <Spinner />}{saving ? "Saving…" : "Save memory"}</button>
          </div>
          <p className="field-hint" id="memory-kind-hint" style={{ marginTop: 8 }}>{KINDS.find((item) => item.kind === draftKind)?.hint}</p>
        </form>
      </Section>

      <Section plain title="What Perry remembers" description="Newest first. A keyword search here; Perry also searches by meaning.">
          <div className="filters">
            <div className="segmented" role="group" aria-label="Filter by kind">
              {[{ kind: undefined, label: "All" }, ...KINDS].map((item) => (
                <button type="button" key={item.label} aria-pressed={filter === item.kind} onClick={() => setFilter(item.kind)}>{item.label}</button>
              ))}
            </div>
            <div className="input-group search-input">
              <label htmlFor="memory-search" className="sr-only">Search memories</label>
              <input id="memory-search" className="input" type="search" value={search} placeholder="Search memories…" autoComplete="off" onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 32 }} />
              <span style={{ position: "absolute", left: 10, color: "var(--text-3)", pointerEvents: "none" }}><Icon name="search" size={14} /></span>
            </div>
          </div>
          {memories !== undefined && <p className="result-count" role="status">
            {memories.length === LIMIT ? `Showing the ${LIMIT} most recent` : `${memories.length} ${memories.length === 1 ? "memory" : "memories"}`}
            {filterLabel ? ` in ${filterLabel}` : ""}{term ? ` matching “${term}”` : ""}
            {memories.length === LIMIT ? ". Search to find older ones." : ""}
          </p>}
          <div className="section-body">
            {memories === undefined && <Loading />}
            {memories?.length === 0 && (term || filter
              ? <Empty icon="search" title="Nothing matches" action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => { setSearch(""); setFilter(undefined); }}>Clear filters</button>}>Try other words, or look in all kinds.</Empty>
              : <Empty icon="memory" title="Nothing saved yet">Ask Perry to remember something in chat, or add it above.</Empty>)}
            {memories?.map((memory) => (
              <div className="item" key={memory.id}>
                <div className="item-main">
                  <div style={{ fontSize: 13.5, overflowWrap: "anywhere" }}>{memory.text}</div>
                  <div className="item-meta">
                    <span className="tag">{KINDS.find((item) => item.kind === memory.kind)?.label ?? memory.kind}</span>
                    <span>{when(memory.createdAt, memory.day)}</span>
                    {memory.origin && <span>{ORIGINS[memory.origin]}</span>}
                    {memory.source === "dreaming" && <span title="Promoted from daily notes overnight">Promoted overnight</span>}
                    {memory.tags.length > 0 && <span>{memory.tags.map((tag) => `#${tag}`).join(" ")}</span>}
                  </div>
                </div>
                <div className="item-side">
                  <ActionButton variant="ghost" className="btn-danger-ghost" action={() => deleteMemory({ key: dashboardKey, id: memory.id })} success="Forgotten."
                    confirm={{ title: "Forget this memory?", body: <>“{memory.text.length > 160 ? `${memory.text.slice(0, 160)}…` : memory.text}” will be deleted, and Perry won&apos;t recall it again.</>, confirmLabel: "Forget" }}>Forget</ActionButton>
                </div>
              </div>
            ))}
          </div>
      </Section>
    </>
  );
}
