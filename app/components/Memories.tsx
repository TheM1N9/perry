"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

function when(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * What Assistant knows, and the only place to correct it. The agent writes here
 * through the remember tool; this view exists because a memory it got slightly
 * wrong is worse than one it never stored.
 */
export function Memories({ dashboardKey }: { dashboardKey: string }) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");

  const memories = useQuery(api.dashboard.listMemories, {
    key: dashboardKey,
    query: search,
  });
  const addMemory = useMutation(api.dashboard.addMemory);
  const deleteMemory = useMutation(api.dashboard.deleteMemory);

  const add = async () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    await addMemory({ key: dashboardKey, text });
  };

  return (
    <>
      <div className="panel">
        <h3>Teach Assistant something</h3>
        <p className="hint">
          One self-contained sentence that will still make sense in six months.
        </p>
        <div className="composer">
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
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Memory</h3>
          <span className="badge">{memories?.length ?? 0} shown</span>
        </div>
        <p className="hint">Full-text search, newest first when the box is empty.</p>

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
                  {when(memory.createdAt)}
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
