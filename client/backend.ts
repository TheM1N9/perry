import { readsChanged } from "../lib/notes-read-dependencies";
import { CHAT_PAGE_SIZE, isChatHistory, isChatPayload, retainedChatBytes, RECENT_CHAT_BYTES, RECENT_CHAT_LIMIT, RECENT_CHAT_TTL } from "./recent-chat";
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
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number, readonly admission = false) {
    super(message);
  }
}

const retryableReadError = (error: unknown): error is BackendError => error instanceof BackendError
  && [500, 502, 503, 504].includes(error.status) && !/dashboard key|DASHBOARD_KEY/i.test(error.message);

/** The server may have committed a write whose acknowledgement never arrived. */
export class WriteOutcomeUnknownError extends BackendError {
  readonly outcome = "unknown";
  constructor(readonly cause: unknown) {
    super("Perry could not confirm this change. It may have been saved. Check the current state before trying again.", 504);
    this.name = "WriteOutcomeUnknownError";
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
  controller?: AbortController;
  retry?: ReturnType<typeof setTimeout>;
  retryDelay?: number;
  serverFailures?: number;
  retryAt?: number;
  again: boolean;
  idleAt?: number;
  expiry?: ReturnType<typeof setTimeout>;
  revision: number;
  retainedBytes?: number;
  /** A value shown before the server confirms it (withOptimisticUpdate). */
  override?: { value: unknown };
};

export const functionName = (ref: AnyFunction | string) => typeof ref === "string" ? ref : getFunctionName(ref);
const keyOf = (name: string, args: unknown) => `${name}\u0000${JSON.stringify(args ?? {})}`;

export class BackendClient {
  private subscriptions = new Map<string, Subscription>();
  private stream: AbortController | null = null;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly base: string;
  private readonly adminKey?: string;
  private hoverTimer?: ReturnType<typeof setTimeout>;
  private prefetching = false;
  private activeQueries = 0;
  private queryWaiters = new Set<() => void>();
  private refreshPending?: { due: Map<Subscription, number>; promise: Promise<unknown>; resolve: (value: unknown) => void; timer?: ReturnType<typeof setTimeout> };
  /** Lets pagination discard its load-more fallback on redaction/session changes. */
  chatCacheGeneration = 0;
  /** Called when the change stream connects or drops, for anything that shows it. */
  onConnection?: (connected: boolean) => void;
  private connection: "connecting" | "connected" | "disconnected" = "connecting";
  private connectionListeners = new Set<Listener>();

  connectionSnapshot = () => this.connection;
  subscribeConnection = (listener: Listener) => {
    this.connectionListeners.add(listener);
    this.connect();
    return () => { this.connectionListeners.delete(listener); };
  };

  private setConnection(connected: boolean) {
    if (!connected) this.discardIdleHistory();
    this.connection = connected ? "connected" : "disconnected";
    this.onConnection?.(connected);
    for (const listener of this.connectionListeners) listener();
  }
  /** Browser analytics receives only the operation name, outcome and duration. */
  onOperation?: (name: string, kind: "mutation" | "action", success: boolean, durationMs: number) => void;

  constructor(base = "", options: { adminKey?: string } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.adminKey = options.adminKey;
  }

  /** A path this server answers on, e.g. an upload or storage address the backend gave out. */
  resolve(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${this.base}${path}`;
  }

  async call<T = unknown>(ref: AnyFunction | string, args: unknown = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ value: T; reads?: string[]; writes?: string[] }> {
    if (this.closed) throw new BackendError("This backend connection is closed.", 499);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("The backend request timed out.", "TimeoutError")), options.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      const response = await fetch(this.resolve(this.adminKey ? "/api/backend/admin" : "/api/backend/call"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.adminKey ? { "x-perry-key": this.adminKey } : {}) },
        body: JSON.stringify({ path: functionName(ref), args: args ?? {} }),
        signal,
      });
      const body = await response.json().catch(() => {
        signal.throwIfAborted();
        return { error: `The server answered ${response.status}.` };
      }) as { value?: T; reads?: string[]; writes?: string[]; error?: string };
      if (!response.ok || body.error) {
        const retryAfter = response.headers.get("retry-after");
        const retryMs = retryAfter ? /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : NaN;
        const error = new BackendError(body.error ?? `The server answered ${response.status}.`, response.status,
          Number.isFinite(retryMs) ? retryMs > 2_147_483_647 ? Infinity : Math.max(250, retryMs) : undefined,
          ["minute", "concurrent"].includes(response.headers.get("x-perry-admission") ?? ""));
        if (response.status === 401 || response.status === 403 || /dashboard key|DASHBOARD_KEY/i.test(error.message)) this.clearChatCache(error);
        throw error;
      }
      return { value: body.value as T, reads: body.reads, writes: body.writes };
    } finally { clearTimeout(timer); }
  }

  async query<Q extends FunctionReference<"query", any>>(ref: Q, args?: FunctionArgs<Q>): Promise<FunctionReturnType<Q>> {
    return (await this.admittedCall<FunctionReturnType<Q>>(ref as AnyFunction, args, {}, true)).value;
  }

  private async admittedCall<T>(ref: AnyFunction, args: unknown, options: { timeoutMs?: number }, read = false) {
    const stableArgs: unknown = JSON.parse(JSON.stringify(args ?? {}));
    const until = Date.now() + (options.timeoutMs ?? 30_000);
    for (let attempt = 0; ; attempt++) {
      try { return await this.call<T>(ref, stableArgs, { timeoutMs: Math.max(1, until - Date.now()) }); }
      catch (error) {
        const serverRetry = read && retryableReadError(error);
        if (!(error instanceof BackendError) || (!serverRetry && (error.status !== 429 || (!read && !error.admission))) || attempt >= 2) throw error;
        const delay = error.retryAfterMs ?? (serverRetry ? 500 * 2 ** attempt : 1000);
        if (this.closed || Date.now() + delay >= until) throw error;
        await new Promise<void>((resolve, reject) => {
          const done = () => { clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", abort); resolve(); };
          const abort = () => { clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", abort); reject(error); };
          const timer = setTimeout(done, delay);
          this.lifetime.signal.addEventListener("abort", abort, { once: true });
          if (this.lifetime.signal.aborted) abort();
        });
      }
    }
  }

  async mutation<M extends FunctionReference<"mutation", any>>(ref: M, args?: FunctionArgs<M>): Promise<FunctionReturnType<M>> {
    const result = await this.trackedCall<M>(ref, args, "mutation");
    await this.refresh(result.writes);
    return result.value;
  }

  async action<A extends FunctionReference<"action", any>>(ref: A, args?: FunctionArgs<A>): Promise<FunctionReturnType<A>> {
    const value = (await this.trackedCall<A>(ref, args, "action")).value;
    await this.refresh();
    return value;
  }

  private async trackedCall<F extends FunctionReference<"mutation" | "action", any>>(ref: F, args: unknown, kind: "mutation" | "action") {
    const started = performance.now();
    let success = false;
    try {
      const result = await this.admittedCall<FunctionReturnType<F>>(ref as AnyFunction, args, { timeoutMs: kind === "action" ? 120_000 : 30_000 });
      success = true;
      return result;
    } catch (error) {
      // Never replay writes after transport loss; retries need durable operation IDs.
      if (!(error instanceof BackendError)) throw new WriteOutcomeUnknownError(error);
      throw error;
    } finally {
      try { this.onOperation?.(functionName(ref as AnyFunction), kind, success, Math.round(performance.now() - started)); } catch {}
    }
  }

  // --- Live queries ---------------------------------------------------------------

  /** The current state of a live query; subscribe() keeps it current. */
  snapshot(name: string, args: unknown): { value?: unknown; error?: Error; loaded: boolean } {
    this.pruneRecentChats();
    const sub = this.subscriptions.get(keyOf(name, args));
    if (!sub) return { loaded: false };
    if (sub.override) return { value: sub.override.value, loaded: true };
    return { value: sub.value, error: sub.error, loaded: sub.loaded };
  }

  subscribe(name: string, args: unknown, listener: Listener): () => void {
    if (this.closed) return () => {};
    this.pruneRecentChats();
    const stableArgs: unknown = JSON.parse(JSON.stringify(args ?? {}));
    const key = keyOf(name, stableArgs);
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = { name, args: stableArgs, reads: null, loaded: false, listeners: new Set(), inFlight: null, again: false, revision: 0 };
      this.subscriptions.set(key, sub);
    }
    const wasIdle = sub.listeners.size === 0;
    clearTimeout(sub.expiry);
    sub.idleAt = undefined;
    sub.listeners.add(listener);
    // A prefetch's listener can span lock/re-unlock. Its invalidated request
    // cannot satisfy a new subscriber, even though the subscription is active.
    if (wasIdle || (!sub.loaded && sub.revision > 0)) void this.fetch(sub);
    this.connect();
    return () => {
      sub!.listeners.delete(listener);
      if (sub!.listeners.size === 0) {
        this.keepIdle(key, sub!);
      }
    };
  }

  private keepIdle(key: string, sub: Subscription) {
    if (this.subscriptions.get(key) !== sub) return;
    clearTimeout(sub.expiry);
    clearTimeout(sub.retry);
    sub.retry = undefined;
    sub.retryAt = undefined;
    sub.serverFailures = undefined;
    this.refreshPending?.due.delete(sub);
    sub.again = false;
    sub.controller?.abort();
    sub.idleAt = Date.now();
    // Map insertion order is the LRU order, including visits in the same millisecond.
    this.subscriptions.delete(key);
    this.subscriptions.set(key, sub);
    const retained = !sub.error && sub.retainedBytes;
    // A failed snapshot would throw before a retry can mount and subscribe.
    const ttl = sub.error ? 0 : isChatHistory(sub.name) ? (retained ? RECENT_CHAT_TTL : 0) : isChatPayload(sub.name) ? 0 : 5_000;
    if (!ttl) {
      if (this.subscriptions.get(key) === sub) this.subscriptions.delete(key);
      return;
    }
    sub.expiry = setTimeout(() => {
      if (sub.listeners.size === 0 && this.subscriptions.get(key) === sub) this.subscriptions.delete(key);
    }, ttl);
    this.pruneRecentChats();
  }

  private pruneRecentChats() {
    let bytes = 0;
    let count = 0;
    const idle = [...this.subscriptions.entries()].filter(([, sub]) => sub.idleAt !== undefined && isChatHistory(sub.name)).reverse();
    for (const [key, sub] of idle) {
      const size = !sub.error && sub.retainedBytes;
      // In-flight prefetches have no value yet; they are bounded separately.
      if (sub.inFlight && !sub.loaded) continue;
      if (!size || Date.now() - sub.idleAt! >= RECENT_CHAT_TTL || ++count > RECENT_CHAT_LIMIT || bytes + size > RECENT_CHAT_BYTES) {
        clearTimeout(sub.expiry);
        this.subscriptions.delete(key);
      } else bytes += size;
    }
  }

  private discardIdleHistory() {
    for (const [key, sub] of this.subscriptions) {
      if (!isChatHistory(sub.name) || sub.listeners.size) continue;
      clearTimeout(sub.expiry);
      this.subscriptions.delete(key);
    }
  }

  /** One shared intent timer, one request at a time; no background transcript sweep. */
  scheduleChatPrefetch(key: string, id: string): () => void {
    clearTimeout(this.hoverTimer);
    const timer = setTimeout(() => {
      if (this.closed || this.prefetching) return;
      const args = { key, id, paginationOpts: { numItems: CHAT_PAGE_SIZE, cursor: null } };
      if (this.snapshot("dashboard:getChatMessages", args).loaded) return;
      this.prefetching = true;
      const stop = this.subscribe("dashboard:getChatMessages", args, () => {});
      const sub = this.subscriptions.get(keyOf("dashboard:getChatMessages", args));
      const done = () => { stop(); this.prefetching = false; };
      if (sub?.inFlight) void sub.inFlight.finally(done);
      else done();
    }, 140);
    this.hoverTimer = timer;
    return () => clearTimeout(timer);
  }

  /** Call synchronously on lock/unlock, before another session can render. */
  clearChatCache(error?: Error) {
    this.chatCacheGeneration++;
    clearTimeout(this.hoverTimer);
    for (const [key, sub] of this.subscriptions) {
      if (!isChatPayload(sub.name)) continue;
      clearTimeout(sub.expiry);
      sub.revision++;
      clearTimeout(sub.retry);
      sub.retry = undefined;
      sub.retryAt = undefined;
      sub.serverFailures = undefined;
      this.refreshPending?.due.delete(sub);
      sub.controller?.abort();
      sub.again = false;
      sub.value = undefined;
      sub.retainedBytes = 0;
      sub.override = undefined;
      sub.error = error;
      sub.loaded = Boolean(error);
      if (!sub.listeners.size) this.subscriptions.delete(key);
      else this.notify(sub);
    }
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

  /** Bound reconnect/refresh bursts while leaving admission for writes and the other clients. */
  private querySlot(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.queryWaiters.delete(grant);
        signal.removeEventListener("abort", abort);
        this.activeQueries++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.activeQueries--;
          this.queryWaiters.values().next().value?.();
        });
      };
      const abort = () => { this.queryWaiters.delete(grant); signal.removeEventListener("abort", abort); reject(signal.reason); };
      if (signal.aborted) { abort(); return; }
      if (this.activeQueries < 4) grant();
      else { this.queryWaiters.add(grant); signal.addEventListener("abort", abort, { once: true }); }
    });
  }

  private fetch(sub: Subscription): Promise<void> {
    if (sub.retry && (sub.retryAt ?? 0) > Date.now()) return sub.inFlight ?? Promise.resolve();
    clearTimeout(sub.retry);
    sub.retry = undefined;
    sub.retryAt = undefined;
    if (sub.inFlight) { sub.again = true; return sub.inFlight; }
    sub.inFlight = (async () => {
      do {
        sub.again = false;
        const revision = sub.revision;
        const controller = new AbortController();
        sub.controller = controller;
        let release: (() => void) | undefined;
        try {
          release = await this.querySlot(AbortSignal.any([this.lifetime.signal, controller.signal]));
          const result = await this.call(sub.name, sub.args, { signal: controller.signal });
          if (revision !== sub.revision || this.closed) continue;
          const changed = !sub.loaded || sub.error || JSON.stringify(result.value) !== JSON.stringify(sub.value);
          sub.reads = result.reads ?? null;
          sub.error = undefined;
          sub.retryDelay = undefined;
          sub.serverFailures = undefined;
          sub.loaded = true;
          if (changed) sub.value = result.value;
          sub.retainedBytes = retainedChatBytes(sub.name, sub.args, result.value);
          if (changed) this.notify(sub);
        } catch (error) {
          if (revision !== sub.revision || this.closed) continue;
          if (controller.signal.aborted) continue;
          const serverRetry = retryableReadError(error) && (sub.serverFailures ?? 0) < 2;
          if ((error instanceof Error && error.name === "TimeoutError" || error instanceof BackendError && error.status === 429 || serverRetry) && sub.listeners.size) {
            const delay = error instanceof BackendError && error.retryAfterMs !== undefined ? error.retryAfterMs
              : serverRetry ? 500 * 2 ** (sub.serverFailures ?? 0) : sub.retryDelay ?? 500;
            if (!Number.isFinite(delay)) { sub.error = error; sub.loaded = true; this.notify(sub); break; }
            if (serverRetry) sub.serverFailures = (sub.serverFailures ?? 0) + 1;
            sub.retryDelay = Math.min(delay * 2, 10_000);
            sub.retryAt = Date.now() + delay;
            sub.again = false;
            sub.retry = setTimeout(() => {
              sub.retry = undefined;
              sub.retryAt = undefined;
              if (!this.closed && sub.listeners.size && this.subscriptions.get(keyOf(sub.name, sub.args)) === sub) void this.fetch(sub);
            }, delay);
            break;
          }
          // The server unreachable (restarting, say) is not the query's error: what is shown stays,
          // and the change stream fetches everything again once it reconnects.
          if (!(error instanceof BackendError)) break;
          sub.error = error;
          sub.loaded = true;
          this.notify(sub);
        } finally { release?.(); if (sub.controller === controller) sub.controller = undefined; }
      } while (sub.again);
      sub.inFlight = null;
      if (!sub.listeners.size && this.subscriptions.get(keyOf(sub.name, sub.args)) === sub) this.keepIdle(keyOf(sub.name, sub.args), sub);
    })();
    return sub.inFlight;
  }

  /** Re-run the live queries that read any of these tables; all of them when not known. */
  refresh(tables?: string[]): Promise<unknown> {
    const wanted = tables ? new Set(tables) : null;
    // Inactive history is disposable. A write/reconnect must not resurrect a deleted,
    // rewound or newly redacted message; active ordinary updates keep their paint.
    const sensitive = wanted?.has("vault") || wanted?.has("secrets");
    if (sensitive) this.chatCacheGeneration++;
    for (const [key, sub] of this.subscriptions) {
      if (!(isChatHistory(sub.name) || (sensitive && isChatPayload(sub.name))) || (wanted && sub.reads !== null && !readsChanged(sub.reads, wanted) && !sensitive)) continue;
      if (!sub.listeners.size) {
        clearTimeout(sub.expiry);
        this.subscriptions.delete(key);
      } else if (sensitive) {
        sub.revision++;
        sub.value = undefined;
        sub.retainedBytes = 0;
        sub.override = undefined;
        sub.loaded = false;
        this.notify(sub);
      }
    }
    if (this.closed) return Promise.resolve();
    const due = [...this.subscriptions.values()].filter(sub => sub.listeners.size > 0
      && (!wanted || sub.reads === null || readsChanged(sub.reads, wanted) || (sensitive && isChatPayload(sub.name))));
    if (!due.length) return Promise.resolve();
    if (this.refreshPending) { for (const sub of due) this.refreshPending.due.set(sub, sub.revision); return this.refreshPending.promise; }
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>(done => { resolve = done; });
    const pending = { due: new Map(due.map(sub => [sub, sub.revision])), promise, resolve, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.refreshPending = pending;
    pending.timer = setTimeout(() => {
      this.refreshPending = undefined;
      const due = [...pending.due].filter(([sub, revision]) => sub.listeners.size > 0 && sub.revision === revision
        && this.subscriptions.get(keyOf(sub.name, sub.args)) === sub);
      pending.resolve(Promise.all(due.map(([sub]) => this.fetch(sub))));
    }, 250);
    return promise;
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
          this.setConnection(true);
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
        this.setConnection(false);
        if (controller.signal.aborted || this.closed) break;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, delay);
          controller.signal.addEventListener("abort", done, { once: true });
          if (controller.signal.aborted) done();
        });
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
    this.setConnection(false);
  }

  resume() {
    if (this.closed || this.stream) return;
    if ([...this.subscriptions.values()].some((sub) => sub.listeners.size > 0)) this.connect();
  }

  close() {
    this.closed = true;
    this.lifetime.abort();
    clearTimeout(this.hoverTimer);
    if (this.refreshPending) { clearTimeout(this.refreshPending.timer); this.refreshPending.resolve(undefined); this.refreshPending = undefined; }
    for (const sub of this.subscriptions.values()) { clearTimeout(sub.expiry); clearTimeout(sub.retry); }
    this.stream?.abort();
    this.stream = null;
    this.subscriptions.clear();
  }
}
