"use client";

import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BackendClient, functionName } from "./backend";

/**
 * React hooks for Perry's backend, with the names and behaviour the dashboard
 * used from convex/react: useQuery stays current as the data changes, returns
 * undefined while loading, and throws the query's error to the nearest error
 * boundary; "skip" as args runs nothing.
 */

const Context = createContext<BackendClient | null>(null);

export function BackendProvider({ client, children }: { client: BackendClient; children: ReactNode }) {
  return <Context.Provider value={client}>{children}</Context.Provider>;
}

function useClient(): BackendClient {
  const client = useContext(Context);
  if (!client) throw new Error("Wrap the app in <BackendProvider>.");
  return client;
}

/** The client itself, for a one-off call: `useConvex().query(api.x, args)`. */
export const useConvex = useClient;

type Query = FunctionReference<"query", "public">;

export function useQuery<Q extends Query>(query: Q, args: FunctionArgs<Q> | "skip"): FunctionReturnType<Q> | undefined {
  const client = useClient();
  const name = functionName(query);
  const argsKey = args === "skip" ? null : JSON.stringify(args ?? {});
  const subscribe = useCallback((notify: () => void) => argsKey === null ? () => {} : client.subscribe(name, JSON.parse(argsKey), notify), [client, name, argsKey]);
  const read = useCallback(() => argsKey === null ? undefined : client.snapshot(name, JSON.parse(argsKey)), [client, name, argsKey]);
  // Snapshots are new objects each time; keep the last one while nothing in it changed.
  const last = useRef<{ key: string | null; value?: unknown; error?: Error; loaded: boolean } | undefined>(undefined);
  const stable = useCallback(() => {
    const now = read();
    const previous = last.current;
    if (!now) return undefined;
    if (previous && previous.key === argsKey && previous.value === now.value && previous.error === now.error && previous.loaded === now.loaded) return previous;
    last.current = { key: argsKey, ...now };
    return last.current;
  }, [read, argsKey]);
  const state = useSyncExternalStore(subscribe, stable, () => undefined);
  if (state?.error) throw state.error;
  return state?.loaded ? state.value as FunctionReturnType<Q> : undefined;
}

type Mutation = FunctionReference<"mutation", "public">;
type OptimisticStore = ReturnType<BackendClient["optimisticStore"]>;

export function useMutation<M extends Mutation>(mutation: M) {
  const client = useClient();
  // `api.x.y` is a new reference on every access, so the name is what keeps this stable across renders.
  const name = functionName(mutation);
  return useMemo(() => {
    const make = (optimistic?: (store: OptimisticStore, args: FunctionArgs<M>) => void) => {
      const run = async (args: FunctionArgs<M>): Promise<FunctionReturnType<M>> => {
        const overrides: Parameters<BackendClient["optimisticStore"]>[0] = [];
        if (optimistic) optimistic(client.optimisticStore(overrides), args);
        try {
          return await client.mutation(name as unknown as M, args);
        } finally {
          client.clearOverrides(overrides);
        }
      };
      return Object.assign(run, {
        withOptimisticUpdate: (update: (store: OptimisticStore, args: FunctionArgs<M>) => void) => make(update),
      });
    };
    return make();
  }, [client, name]);
}

type Action = FunctionReference<"action", "public">;

export function useAction<A extends Action>(action: A) {
  const client = useClient();
  const name = functionName(action);
  return useCallback((args: FunctionArgs<A>): Promise<FunctionReturnType<A>> => client.action(name as unknown as A, args), [client, name]);
}

type Paginated = FunctionReference<"query", "public", { paginationOpts: { numItems: number; cursor: string | null } }, { page: unknown[]; isDone: boolean; continueCursor: string }>;
type Item<Q extends Paginated> = FunctionReturnType<Q>["page"][number];
export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

/**
 * Newest pages first, like convex/react's usePaginatedQuery. It is one live
 * query whose size grows with loadMore, so a message arriving while older ones
 * are shown never opens a gap between pages.
 */
export function usePaginatedQuery<Q extends Paginated>(
  query: Q,
  args: Omit<FunctionArgs<Q>, "paginationOpts"> | "skip",
  options: { initialNumItems: number },
): { results: Item<Q>[]; status: PaginationStatus; loadMore: (numItems: number) => void; isLoading: boolean } {
  const argsKey = args === "skip" ? null : JSON.stringify(args);
  const [size, setSize] = useState({ key: argsKey, numItems: options.initialNumItems });
  const numItems = size.key === argsKey ? size.numItems : options.initialNumItems;
  useEffect(() => { if (size.key !== argsKey) setSize({ key: argsKey, numItems: options.initialNumItems }); }, [argsKey, size.key, options.initialNumItems]);
  const shown = useRef<FunctionReturnType<Q> | undefined>(undefined);
  const page = useQuery(query as unknown as Query, (args === "skip" ? "skip" : { ...args, paginationOpts: { numItems, cursor: null } }) as never) as FunctionReturnType<Q> | undefined;
  if (args === "skip") shown.current = undefined;
  else if (page !== undefined) shown.current = page;
  const current = shown.current;
  const loadingMore = current !== undefined && page === undefined;
  const status: PaginationStatus = args === "skip" || current === undefined ? "LoadingFirstPage" : loadingMore ? "LoadingMore" : current.isDone ? "Exhausted" : "CanLoadMore";
  const loadMore = useCallback((more: number) => setSize((previous) => ({ key: argsKey, numItems: (previous.key === argsKey ? previous.numItems : options.initialNumItems) + more })), [argsKey, options.initialNumItems]);
  return { results: (current?.page ?? []) as Item<Q>[], status, loadMore, isLoading: status === "LoadingFirstPage" || status === "LoadingMore" };
}
