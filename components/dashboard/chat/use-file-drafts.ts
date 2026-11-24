"use client";

import { useCallback, useReducer, useRef, type SetStateAction } from "react";
import { toast } from "sonner";

export function useFileDrafts(scope: string) {
  const drafts = useRef(new Map<string, File[]>());
  const [, redraw] = useReducer(value => value + 1, 0);
  const setFiles = useCallback((change: SetStateAction<File[]>) => {
    const before = drafts.current.get(scope) ?? [];
    const next = typeof change === "function" ? change(before) : change;
    if (next.reduce((total, file) => total + file.size, 0) > 100 * 1024 ** 2) { toast.error("Keep unsent attachments under 100 MB per chat."); return; }
    drafts.current.delete(scope);
    if (next.length) drafts.current.set(scope, next);
    const bytes = () => [...drafts.current.values()].flat().reduce((total, file) => total + file.size, 0);
    let evicted = false;
    for (const key of drafts.current.keys()) {
      if (drafts.current.size <= 8 && bytes() <= 100 * 1024 ** 2) break;
      if (key === scope) continue;
      drafts.current.delete(key); evicted = true;
    }
    if (evicted) toast.info("Older unsent file drafts were released to save memory. Attach those files again when you return.");
    redraw();
  }, [scope]);
  return [drafts.current.get(scope) ?? [], setFiles] as const;
}
