"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/** Stable event identity, with the handler from the latest committed render. */
export function useChatEvent<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
  const current = useRef(handler);
  useLayoutEffect(() => { current.current = handler; });
  return useCallback((...args: Args) => current.current(...args), []);
}

/** JSON query payloads have no row identities after a changed response. One map
 * lookup and serialization per record keeps unchanged rows, in linear work. */
export function useStableRecords<T>(records: T[], key: (record: NoInfer<T>) => string): T[] {
  const committed = useRef(new Map<string, { json: string; value: T }>());
  const result = useMemo(() => {
    const next = new Map<string, { json: string; value: T }>();
    const values = records.map((record) => {
      const id = key(record);
      const json = JSON.stringify(record);
      const previous = committed.current.get(id);
      const entry = previous?.json === json ? previous : { json, value: record };
      next.set(id, entry);
      return entry.value;
    });
    return { next, values };
  }, [records, key]);
  useLayoutEffect(() => { committed.current = result.next; }, [result]);
  return result.values;
}

/** Wake only when time changes the screen. Select at render so a deadline
 * crossed before effect setup still wakes once. */
export function useChatDeadline(deadlines: Array<number | undefined>) {
  const [revision, wake] = useState(0);
  const now = Date.now();
  const next = Math.min(...deadlines.filter((time): time is number => time !== undefined && time > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => wake((value) => value + 1), Math.min(Math.max(1, next - Date.now()), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [next, revision]);
  return revision;
}
