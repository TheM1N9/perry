"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

function when(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

type Kind = "profile" | "core" | "daily";
const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "profile", label: "Profile", hint: "Standing preferences and relationships. Loaded in every chat." },
  { kind: "core", label: "Long-term", hint: "Durable facts and decisions. Loaded in every chat." },
  { kind: "daily", label: "Daily notes", hint: "What happened each day. Today and yesterday load; older days are searched." },
];
const ORIGINS = { owner: "from you", tool: "from a tool", job: "from a job" } as const;

/**
 * What Assistant knows, and the only place to correct it. The agent writes here
 * through the remember tool; this view exists because a memory it got slightly
 * wrong is worse than one it never stored.
 */
export function Memories({ dashboardKey }: { dashboardKey: string }) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<Kind>("core");
  const [filter, setFilter] = useState<Kind | undefined>(undefined);
  const [refused, setRefused] = useState("");

  const memories = useQuery(api.dashboard.listMemories, {
    key: dashboardKey,
    query: search,
    kind: filter,
  });
  const addMemory = useMutation(api.dashboard.addMemory);
  const deleteMemory = useMutation(api.dashboard.deleteMemory);

  const add = async () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    // A full layer refuses the memory; it stays in the box to be shortened or saved later.
    const reason = await addMemory({ key: dashboardKey, text, kind: draftKind });
    setRefused(reason ?? "");
    if (reason) setDraft(text);
  };

  return (
    <>
      <div className="panel">
        <h3>Teach Assistant something</h3>
        <p className="hint">
          One self-contained sentence that will still make sense in six months.
          {" "}{KINDS.find((item) => item.kind === draftKind)?.hint}
        </p>
        <div className="composer">
          <select value={draftKind} style={{ width: "auto" }} aria-label="Memory layer" onChange={(e) => setDraftKind(e.target.value as Kind)}>
            {KINDS.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
          </select>
          <input
            value={draft}
            placeholder="I drink coffee black"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
          />
          <button
            className="primary"
            disabled={draft.trim().length === 0}
            onClick={() => void add()}
          >
            Add
          </button>
        </div>
        {refused && <p className="hint">{refused}</p>}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Memory</h3>
          <span className="badge">{memories?.length ?? 0} shown</span>
        </div>
        <p className="hint">Keyword search, newest first when the box is empty. The assistant also searches by meaning.</p>

        <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
          {[{ kind: undefined, label: "All" }, ...KINDS].map((item) => (
            <button key={item.label} className={filter === item.kind ? "primary" : "ghost"} onClick={() => setFilter(item.kind)}>
              {item.label}
            </button>
          ))}
        </div>

        <input
          value={search}
          placeholder="Search memories"
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: 8 }}
        />

        {memories === undefined && <div className="empty">Loading.</div>}
        {memories?.length === 0 && (
          <div className="empty">
            {search ? "Nothing matched." : "Assistant has not learned anything yet."}
          </div>
        )}

        {memories?.map((memory) => (
          <div className="item" key={memory.id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
              <div style={{ flex: 1 }}>
                <div>{memory.text}</div>
                <div className="item-meta">
                  <span className="badge">{KINDS.find((item) => item.kind === memory.kind)?.label}</span>
                  {" "}{memory.day ?? when(memory.createdAt)}
                  {memory.origin ? ` · ${ORIGINS[memory.origin]}` : ""}
                  {memory.source === "dreaming" ? " · promoted overnight" : ""}
                  {memory.tags.length > 0 ? ` · ${memory.tags.join(", ")}` : ""}
                </div>
              </div>
              <button
                className="ghost danger"
                onClick={() =>
                  void deleteMemory({ key: dashboardKey, id: memory.id })
                }
              >
                Forget
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
