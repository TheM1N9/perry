import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";

/**
 * Talks to Perry's backend (server/, under /api/backend) from anywhere: the
 * dashboard in a browser, the runner and the CLI. Calls are plain POSTs; live
 * queries re-run when a change event names a table they read, which is how
 * `useQuery` stays current without Convex.
 *
 * The change stream is read with fetch rather than EventSource, so the same
 * code runs in browsers, Node and Bun.
 */

type AnyFunction = FunctionReference<"query" | "mutation" | "action", "public" | "internal">;
type Listener = () => void;

export class BackendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Subscription = {
  name: string;
  args: unknown;
  value?: unknown;
  error?: Error;
  reads: string[] | null;
  loaded: boolean;
  listeners: Set<Listener>;
  inFlight: Promise<void> | null;
  again: boolean;
  /** A value shown before the server confirms it (withOptimisticUpdate). */
  override?: { value: unknown };
};

export const functionName = (ref: AnyFunction | string) => typeof ref === "string" ? ref : getFunctionName(ref);
const keyOf = (name: string, args: unknown) => `${name}\u0000${JSON.stringify(args ?? {})}`;

export class BackendClient {
  private subscriptions = new Map<string, Subscription>();
  private stream: AbortController | null = null;
  private closed = false;
  private readonly base: string;
  private readonly adminKey?: string;
  /** Called when the change stream connects or drops, for anything that shows it. */
  onConnection?: (connected: boolean) => void;

  constructor(base = "", options: { adminKey?: string } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.adminKey = options.adminKey;
  }

  /** A path this server answers on, e.g. an upload or storage address the backend gave out. */
  resolve(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${this.base}${path}`;
  }

  async call<T = unknown>(ref: AnyFunction | string, args: unknown = {}): Promise<{ value: T; reads?: string[]; writes?: string[] }> {
    const response = await fetch(this.resolve(this.adminKey ? "/api/backend/admin" : "/api/backend/call"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.adminKey ? { "x-perry-key": this.adminKey } : {}) },
      body: JSON.stringify({ path: functionName(ref), args: args ?? {} }),
    });
    const body = await response.json().catch(() => ({ error: `The server answered ${response.status}.` })) as { value?: T; reads?: string[]; writes?: string[]; error?: string };
    if (!response.ok || body.error) throw new BackendError(body.error ?? `The server answered ${response.status}.`, response.status);
    return { value: body.value as T, reads: body.reads, writes: body.writes };
  }

  async query<Q extends FunctionReference<"query", any>>(ref: Q, args?: FunctionArgs<Q>): Promise<FunctionReturnType<Q>> {
    return (await this.call<FunctionReturnType<Q>>(ref as AnyFunction, args)).value;
  }

  async mutation<M extends FunctionReference<"mutation", any>>(ref: M, args?: FunctionArgs<M>): Promise<FunctionReturnType<M>> {
    const result = await this.call<FunctionReturnType<M>>(ref as AnyFunction, args);
    await this.refresh(result.writes);
    return result.value;
  }

  async action<A extends FunctionReference<"action", any>>(ref: A, args?: FunctionArgs<A>): Promise<FunctionReturnType<A>> {
    const value = (await this.call<FunctionReturnType<A>>(ref as AnyFunction, args)).value;
    await this.refresh();
    return value;
  }

  // --- Live queries ---------------------------------------------------------------

  /** The current state of a live query; subscribe() keeps it current. */
  snapshot(name: string, args: unknown): { value?: unknown; error?: Error; loaded: boolean } {
    const sub = this.subscriptions.get(keyOf(name, args));
    if (!sub) return { loaded: false };
    if (sub.override) return { value: sub.override.value, loaded: true };
    return { value: sub.value, error: sub.error, loaded: sub.loaded };
  }

  subscribe(name: string, args: unknown, listener: Listener): () => void {
    const key = keyOf(name, args);
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = { name, args, reads: null, loaded: false, listeners: new Set(), inFlight: null, again: false };
      this.subscriptions.set(key, sub);
      void this.fetch(sub);
    }
    sub.listeners.add(listener);
    this.connect();
    return () => {
      sub!.listeners.delete(listener);
      if (sub!.listeners.size === 0) {
        // Kept a moment, so a component that remounts does not start from nothing.
        setTimeout(() => { if (sub!.listeners.size === 0) this.subscriptions.delete(key); }, 5_000);
      }
    };
  }

  /** Like Convex's onUpdate: call back with every new result until unsubscribed. */
  onUpdate<Q extends FunctionReference<"query", any>>(ref: Q, args: FunctionArgs<Q>, onResult: (value: FunctionReturnType<Q>) => void, onError?: (error: Error) => void): () => void {
    const name = functionName(ref as AnyFunction);
    let last: unknown = Symbol("none");
    return this.subscribe(name, args, () => {
      const state = this.snapshot(name, args);
      if (state.error) { onError?.(state.error); return; }
      if (!state.loaded || state.value === last) return;
      last = state.value;
      onResult(state.value as FunctionReturnType<Q>);
    });
  }

  private notify(sub: Subscription) {
    for (const listener of [...sub.listeners]) listener();
  }

  private fetch(sub: Subscription): Promise<void> {
    if (sub.inFlight) { sub.again = true; return sub.inFlight; }
    sub.inFlight = (async () => {
      do {
        sub.again = false;
        try {
          const result = await this.call(sub.name, sub.args);
          const changed = !sub.loaded || sub.error || JSON.stringify(result.value) !== JSON.stringify(sub.value);
          sub.reads = result.reads ?? null;
          sub.error = undefined;
          sub.loaded = true;
          if (changed) sub.value = result.value;
          if (changed) this.notify(sub);
        } catch (error) {
          // The server unreachable (restarting, say) is not the query's error: what is shown stays,
          // and the change stream fetches everything again once it reconnects.
          if (!(error instanceof BackendError)) break;
          sub.error = error;
          sub.loaded = true;
          this.notify(sub);
        }
      } while (sub.again);
      sub.inFlight = null;
    })();
    return sub.inFlight;
  }

  /** Re-run the live queries that read any of these tables; all of them when not known. */
  refresh(tables?: string[]): Promise<unknown> {
    const wanted = tables ? new Set(tables) : null;
    const due = [...this.subscriptions.values()].filter((sub) =>
      sub.listeners.size > 0 && (!wanted || sub.reads === null || sub.reads.some((table) => wanted.has(table))));
    return Promise.all(due.map((sub) => this.fetch(sub)));
  }

  /** For withOptimisticUpdate: read and replace a live query's value until the server answers. */
  optimisticStore(overrides: Subscription[]) {
    return {
      getQuery: <Q extends FunctionReference<"query", any>>(ref: Q, args: FunctionArgs<Q>): FunctionReturnType<Q> | undefined =>
        this.snapshot(functionName(ref as AnyFunction), args).value as FunctionReturnType<Q> | undefined,
      setQuery: <Q extends FunctionReference<"query", any>>(ref: Q, args: FunctionArgs<Q>, value: FunctionReturnType<Q> | undefined) => {
        const sub = this.subscriptions.get(keyOf(functionName(ref as AnyFunction), args));
        if (!sub) return;
        sub.override = { value };
        overrides.push(sub);
        this.notify(sub);
      },
    };
  }

  clearOverrides(overrides: Subscription[]) {
    for (const sub of overrides) {
      delete sub.override;
      this.notify(sub);
    }
  }

  // --- The change stream --------------------------------------------------------------

  private connect() {
    if (this.stream || this.closed) return;
    const controller = new AbortController();
    this.stream = controller;
    void (async () => {
      let delay = 1_000;
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(this.resolve("/api/backend/events"), { signal: controller.signal, headers: { accept: "text/event-stream" } });
          if (!response.ok || !response.body) throw new Error(`events: ${response.status}`);
          this.onConnection?.(true);
          delay = 1_000;
          // Whatever changed while disconnected is unknown, so everything is fetched again.
          void this.refresh();
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
              if (!data) continue;
              try { void this.refresh((JSON.parse(data) as { tables: string[] }).tables); } catch {}
            }
          }
        } catch {
          if (controller.signal.aborted) break;
        }
        this.onConnection?.(false);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    })();
  }

  /**
   * Let go of the change stream while a page is hidden in the browser's
   * back/forward cache, and pick it up again when it is shown. A cached page
   * that kept its stream would hold one of the few connections a browser
   * allows per host, and a handful of them stall every request after.
   */
  suspend() {
    this.stream?.abort();
    this.stream = null;
  }

  resume() {
    if (this.closed || this.stream) return;
    if ([...this.subscriptions.values()].some((sub) => sub.listeners.size > 0)) this.connect();
  }

  close() {
    this.closed = true;
    this.stream?.abort();
    this.stream = null;
    this.subscriptions.clear();
  }
}
