import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getFunctionName } from "convex/server";
import { Store, type Doc, type TableDef } from "./db";
import { ArgumentError, validateArgs } from "./validate";

/**
 * Runs Perry's backend functions (convex/*.ts) on this machine.
 *
 * They were written for Convex, and keep its rules here:
 *   - A query reads; a mutation reads and writes as one transaction that
 *     commits or rolls back whole; an action does anything else, and reaches
 *     the database only through queries and mutations.
 *   - Queries and mutations run one at a time, so a query never sees half a
 *     mutation. They only touch SQLite, so they are quick; actions, which wait
 *     on the network, run alongside.
 *   - ctx.scheduler.runAfter/runAt persist the call; a scheduled mutation runs
 *     exactly once, in the same transaction that removes it from the queue.
 *   - Crons from convex/crons.ts run on timers while this process runs.
 *   - Each committed mutation reports the tables it wrote, which is how the
 *     dashboard and the runner learn a query's answer may have changed.
 *
 * Everything that touches the SQLite connection goes through `exclusive`, as
 * the connection is shared: a statement run while a mutation's transaction is
 * open would silently become part of it.
 */

export type Kind = "query" | "mutation" | "action" | "httpAction";
export type FunctionDef = {
  perryFunction: true;
  kind: Kind;
  visibility: "public" | "internal";
  handler: (ctx: any, args: any) => unknown;
  args?: unknown;
};

type Tx = { reads: Set<string>; writes: Set<string>; scheduled: boolean };
type Schema = { tables: Record<string, { export(): { indexes: Array<{ indexDescriptor: string; fields: string[] }>; searchIndexes: Array<{ indexDescriptor: string; searchField: string; filterFields: string[] }> } }> };
type Crons = { crons: Record<string, { name: string; args: unknown[]; schedule: { type: string; seconds?: number; minutes?: number; hours?: number } }> };
type Router = { lookup(path: string, method: string): [FunctionDef, string, string] | null };

export class NotFound extends Error {}

const isDef = (value: unknown): value is FunctionDef => typeof value === "object" && value !== null && (value as FunctionDef).perryFunction === true;
const nameOf = (ref: unknown): string => typeof ref === "string" ? ref : getFunctionName(ref as never);

export class Runtime {
  readonly events = new EventEmitter();
  readonly store: Store;
  private readonly registry = new Map<string, FunctionDef>();
  private queue: Promise<unknown> = Promise.resolve();
  private savepoints = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cronTimers: Array<ReturnType<typeof setInterval>> = [];
  private running = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    readonly sql: DatabaseSync,
    schema: Schema,
    modules: Record<string, Record<string, unknown>>,
    private readonly options: { storageDir: string; crons?: Crons; http?: Router },
  ) {
    const tables: Record<string, TableDef> = {};
    for (const [name, table] of Object.entries(schema.tables)) {
      const exported = table.export();
      tables[name] = {
        indexes: exported.indexes.map((index) => ({ name: index.indexDescriptor, fields: index.fields })),
        searchIndexes: exported.searchIndexes.map((index) => ({ name: index.indexDescriptor, searchField: index.searchField, filterFields: index.filterFields })),
      };
    }
    this.store = new Store(sql, tables);
    sql.exec(`CREATE TABLE IF NOT EXISTS _scheduled (id TEXT PRIMARY KEY, name TEXT NOT NULL, args TEXT NOT NULL, runAt REAL NOT NULL, createdAt REAL NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS _scheduled_by_time ON _scheduled (runAt)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _storage (id TEXT PRIMARY KEY, contentType TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL, createdAt REAL NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _uploads (ticket TEXT PRIMARY KEY, expiresAt REAL NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    mkdirSync(options.storageDir, { recursive: true });
    for (const [module, exports] of Object.entries(modules)) {
      for (const [name, value] of Object.entries(exports)) {
        if (isDef(value)) this.registry.set(`${module}:${name}`, value);
      }
    }
  }

  functions(): string[] {
    return [...this.registry.keys()];
  }

  /** One at a time: queries, mutations and every other use of the connection. */
  exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private def(name: string, kind?: Kind): FunctionDef {
    const def = this.registry.get(name);
    if (!def || (kind && def.kind !== kind)) throw new NotFound(`No ${kind ?? "function"} named ${name}.`);
    return def;
  }

  // --- Contexts ----------------------------------------------------------------

  private reader(tx: Tx) {
    const store = this.store;
    return {
      get: async (id: string) => store.get(id, tx.reads),
      query: (table: string) => store.query(table, tx.reads),
      normalizeId: (table: string, id: string) => store.normalizeId(table, id),
    };
  }

  private writer(tx: Tx) {
    const store = this.store;
    const wrote = (table: string) => { tx.writes.add(table); };
    return {
      ...this.reader(tx),
      insert: async (table: string, value: Record<string, unknown>) => { tx.writes.add(table); return store.insert(table, value); },
      patch: async (id: string, value: Record<string, unknown>) => { wrote(store.patch(id, value)); },
      replace: async (id: string, value: Record<string, unknown>) => { wrote(store.replace(id, value)); },
      delete: async (id: string) => { wrote(store.delete(id)); },
    };
  }

  private queryCtx(tx: Tx) {
    return {
      db: this.reader(tx),
      storage: this.storageReader(),
      auth: { getUserIdentity: async () => null },
      runQuery: (ref: unknown, args?: unknown) => this.inlineQuery(nameOf(ref), args ?? {}, tx),
    };
  }

  private mutationCtx(tx: Tx) {
    return {
      ...this.queryCtx(tx),
      db: this.writer(tx),
      storage: { ...this.storageReader(), generateUploadUrl: async () => this.uploadUrlInTx(), delete: async (id: string) => this.deleteFileInTx(id) },
      scheduler: this.scheduler(tx),
      runMutation: (ref: unknown, args?: unknown) => this.inlineMutation(nameOf(ref), args ?? {}, tx),
    };
  }

  private actionCtx() {
    return {
      auth: { getUserIdentity: async () => null },
      runQuery: (ref: unknown, args?: unknown) => this.runQuery(nameOf(ref), args ?? {}, { internal: true }).then((result) => result.value),
      runMutation: (ref: unknown, args?: unknown) => this.runMutation(nameOf(ref), args ?? {}, { internal: true }),
      runAction: (ref: unknown, args?: unknown) => this.runAction(nameOf(ref), args ?? {}, { internal: true }),
      scheduler: {
        runAfter: (delay: number, ref: unknown, args?: unknown) => this.exclusive(() => this.schedule(nameOf(ref), args ?? {}, Date.now() + delay)).then((id) => { this.wake(); return id; }),
        runAt: (at: number | Date, ref: unknown, args?: unknown) => this.exclusive(() => this.schedule(nameOf(ref), args ?? {}, Number(at))).then((id) => { this.wake(); return id; }),
        cancel: (id: string) => this.exclusive(() => { this.sql.prepare("DELETE FROM _scheduled WHERE id = ?").run(id); }),
      },
      storage: {
        store: (blob: Blob) => this.storeFile(blob),
        get: (id: string) => this.readFile(id),
        getUrl: async (id: string) => this.urlFor(id),
        getMetadata: (id: string) => this.exclusive(() => this.metadata(id)),
        generateUploadUrl: () => this.exclusive(() => this.uploadUrlInTx()),
        delete: (id: string) => this.exclusive(() => this.deleteFileInTx(id)),
      },
    };
  }

  private scheduler(tx: Tx) {
    return {
      runAfter: async (delay: number, ref: unknown, args?: unknown) => { tx.scheduled = true; return this.schedule(nameOf(ref), args ?? {}, Date.now() + delay); },
      runAt: async (at: number | Date, ref: unknown, args?: unknown) => { tx.scheduled = true; return this.schedule(nameOf(ref), args ?? {}, Number(at)); },
      cancel: async (id: string) => { this.sql.prepare("DELETE FROM _scheduled WHERE id = ?").run(id); },
    };
  }

  // --- Running functions ---------------------------------------------------------

  private async inlineQuery(name: string, args: unknown, tx: Tx) {
    const def = this.def(name, "query");
    validateArgs(args, def.args, (id) => this.store.idTable(id));
    return await def.handler(this.queryCtx(tx), args);
  }

  /** A mutation called from a mutation joins its transaction, and rolls back alone if it throws. */
  private async inlineMutation(name: string, args: unknown, tx: Tx) {
    const def = this.def(name, "mutation");
    validateArgs(args, def.args, (id) => this.store.idTable(id));
    const savepoint = `sp${++this.savepoints}`;
    this.sql.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await def.handler(this.mutationCtx(tx), args);
      this.sql.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.sql.exec(`ROLLBACK TO ${savepoint}`);
      this.sql.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  private visible(def: FunctionDef, internal: boolean | undefined, name: string) {
    if (def.visibility === "internal" && !internal) throw new NotFound(`No public function named ${name}.`);
  }

  async runQuery(name: string, args: unknown, options: { internal?: boolean } = {}): Promise<{ value: unknown; reads: string[] }> {
    const def = this.def(name, "query");
    this.visible(def, options.internal, name);
    return this.exclusive(async () => {
      validateArgs(args, def.args, (id) => this.store.idTable(id));
      const tx: Tx = { reads: new Set(), writes: new Set(), scheduled: false };
      const value = await def.handler(this.queryCtx(tx), args);
      return { value, reads: [...tx.reads] };
    });
  }

  async runMutation(name: string, args: unknown, options: { internal?: boolean; before?: () => void; onCommit?: (writes: string[]) => void } = {}): Promise<unknown> {
    const def = this.def(name, "mutation");
    this.visible(def, options.internal, name);
    return this.exclusive(async () => {
      validateArgs(args, def.args, (id) => this.store.idTable(id));
      const tx: Tx = { reads: new Set(), writes: new Set(), scheduled: false };
      this.sql.exec("BEGIN IMMEDIATE");
      try {
        options.before?.();
        const value = await def.handler(this.mutationCtx(tx), args);
        this.sql.exec("COMMIT");
        this.committed(tx);
        options.onCommit?.([...tx.writes]);
        return value;
      } catch (error) {
        this.sql.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async runAction(name: string, args: unknown, options: { internal?: boolean } = {}): Promise<unknown> {
    const def = this.def(name, "action");
    this.visible(def, options.internal, name);
    await this.exclusive(() => validateArgs(args, def.args, (id) => this.store.idTable(id)));
    return await def.handler(this.actionCtx(), args);
  }

  /** Any kind, by name; what the backend API and scripts call. */
  async call(name: string, args: unknown, options: { internal?: boolean } = {}): Promise<{ value: unknown; reads?: string[]; writes?: string[] }> {
    const def = this.def(name);
    if (def.kind === "query") return this.runQuery(name, args, options);
    if (def.kind === "mutation") {
      let writes: string[] = [];
      const value = await this.runMutation(name, args, { ...options, onCommit: (tables) => { writes = tables; } });
      return { value, writes };
    }
    if (def.kind === "action") return { value: await this.runAction(name, args, options) };
    throw new NotFound(`${name} is an HTTP action.`);
  }

  kindOf(name: string): Kind | null {
    return this.registry.get(name)?.kind ?? null;
  }

  async runHttp(path: string, request: Request): Promise<Response> {
    const found = this.options.http?.lookup(path, request.method);
    if (!found) return new Response("Not found", { status: 404 });
    return await found[0].handler(this.actionCtx(), request) as Response;
  }

  private committed(tx: Tx) {
    if (tx.writes.size) this.events.emit("change", [...tx.writes]);
    if (tx.scheduled) this.wake();
  }

  // --- Scheduling ------------------------------------------------------------------

  private schedule(name: string, args: unknown, runAt: number): string {
    this.def(name);
    const id = randomBytes(12).toString("hex");
    this.sql.prepare("INSERT INTO _scheduled (id, name, args, runAt, createdAt) VALUES (?, ?, ?, ?, ?)").run(id, name, JSON.stringify(args ?? {}), runAt, Date.now());
    return id;
  }

  private wake() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
  }

  private async tick() {
    this.timer = null;
    if (this.stopped) return;
    try {
      const due = await this.exclusive(() => this.sql.prepare("SELECT id, name, args FROM _scheduled WHERE runAt <= ? ORDER BY runAt LIMIT 100").all(Date.now()) as Array<{ id: string; name: string; args: string }>);
      for (const row of due) {
        const def = this.registry.get(row.name);
        const args = JSON.parse(row.args);
        const remove = () => { this.sql.prepare("DELETE FROM _scheduled WHERE id = ?").run(row.id); };
        if (!def) {
          console.error(`Scheduled function ${row.name} no longer exists; dropping it.`);
          await this.exclusive(remove);
          continue;
        }
        if (def.kind === "mutation") {
          // Exactly once: taken off the queue in the transaction that runs it.
          await this.runMutation(row.name, args, { internal: true, before: remove }).catch((error) => {
            console.error(`Scheduled ${row.name} failed: ${error instanceof Error ? error.stack : String(error)}`);
            return this.exclusive(remove);
          });
          continue;
        }
        // Actions run at most once, alongside each other, as in Convex.
        await this.exclusive(remove);
        const run = this.call(row.name, args, { internal: true }).catch((error) => {
          console.error(`Scheduled ${row.name} failed: ${error instanceof Error ? error.stack : String(error)}`);
        });
        this.running.add(run);
        void run.finally(() => this.running.delete(run));
      }
      const next = await this.exclusive(() => (this.sql.prepare("SELECT MIN(runAt) AS next FROM _scheduled").get() as { next: number | null }).next);
      if (!this.stopped) {
        const wait = next === null ? 60_000 : Math.max(0, Math.min(next - Date.now(), 60_000));
        this.timer = setTimeout(() => void this.tick(), due.length === 100 ? 0 : wait);
      }
    } catch (error) {
      console.error(`The scheduler failed: ${String(error)}`);
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), 5_000);
    }
  }

  /** Scheduled functions and crons start; before this, functions only run when called. */
  start() {
    this.stopped = false;
    this.wake();
    for (const [label, cron] of Object.entries(this.options.crons?.crons ?? {})) {
      const { type, seconds = 0, minutes = 0, hours = 0 } = cron.schedule;
      if (type !== "interval") { console.error(`Cron "${label}" has an unsupported schedule and will not run.`); continue; }
      const every = (seconds + minutes * 60 + hours * 3600) * 1000;
      let busy = false;
      this.cronTimers.push(setInterval(() => {
        if (busy || this.stopped) return;
        busy = true;
        void this.call(cron.name, cron.args[0] ?? {}, { internal: true })
          .catch((error) => console.error(`Cron "${label}" failed: ${error instanceof Error ? error.stack : String(error)}`))
          .finally(() => { busy = false; });
      }, every));
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.cronTimers) clearInterval(timer);
    this.cronTimers = [];
    await Promise.allSettled([...this.running]);
  }

  // --- Files -----------------------------------------------------------------------

  private filePath(id: string) {
    // Ids made here are 32 hex characters; ones imported from Convex keep their own form.
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("Not a file id.");
    return join(this.options.storageDir, id);
  }

  /** Where a stored file is fetched from: this server, relative, so it works from any address the dashboard is open on. */
  urlFor(id: string): string {
    return `/api/backend/storage/${id}`;
  }

  async storeFile(blob: Blob): Promise<string> {
    const bytes = Buffer.from(await blob.arrayBuffer());
    const id = randomBytes(16).toString("hex");
    writeFileSync(this.filePath(id), bytes);
    await this.exclusive(() => {
      this.sql.prepare("INSERT INTO _storage (id, contentType, size, sha256, createdAt) VALUES (?, ?, ?, ?, ?)")
        .run(id, blob.type || null, bytes.length, createHash("sha256").update(bytes).digest("base64"), Date.now());
    });
    return id;
  }

  async readFile(id: string): Promise<Blob | null> {
    const meta = await this.exclusive(() => this.metadata(id));
    if (!meta) return null;
    return new Blob([readFileSync(this.filePath(id))], meta.contentType ? { type: meta.contentType } : {});
  }

  private metadata(id: string): { storageId: string; _id: string; size: number; sha256: string; contentType?: string; _creationTime: number } | null {
    const row = this.sql.prepare("SELECT id, contentType, size, sha256, createdAt FROM _storage WHERE id = ?").get(id) as { id: string; contentType: string | null; size: number; sha256: string; createdAt: number } | undefined;
    return row ? { storageId: row.id, _id: row.id, size: row.size, sha256: row.sha256, contentType: row.contentType ?? undefined, _creationTime: row.createdAt } : null;
  }

  private storageReader() {
    return {
      getUrl: async (id: string) => this.metadata(id) ? this.urlFor(id) : null,
      getMetadata: async (id: string) => this.metadata(id),
    };
  }

  private deleteFileInTx(id: string) {
    this.sql.prepare("DELETE FROM _storage WHERE id = ?").run(id);
    try { rmSync(this.filePath(id), { force: true }); } catch {}
  }

  /** A one-time address to upload a file to, good for an hour, as Convex's upload URLs are. */
  private uploadUrlInTx(): string {
    const ticket = randomBytes(24).toString("hex");
    this.sql.prepare("INSERT INTO _uploads (ticket, expiresAt) VALUES (?, ?)").run(ticket, Date.now() + 3_600_000);
    return `/api/backend/storage/upload?ticket=${ticket}`;
  }

  /** Take an upload made to an address from generateUploadUrl; null if the address is unknown or used. */
  async acceptUpload(ticket: string, blob: Blob): Promise<string | null> {
    const valid = await this.exclusive(() => {
      const row = this.sql.prepare("SELECT expiresAt FROM _uploads WHERE ticket = ?").get(ticket) as { expiresAt: number } | undefined;
      this.sql.prepare("DELETE FROM _uploads WHERE ticket = ? OR expiresAt < ?").run(ticket, Date.now());
      return Boolean(row && row.expiresAt >= Date.now());
    });
    return valid ? await this.storeFile(blob) : null;
  }

  async fileInfo(id: string) {
    return await this.exclusive(() => this.metadata(id));
  }

  // --- Small persistent values, for the server's own bookkeeping ------------------

  kv = {
    get: (key: string) => this.exclusive(() => (this.sql.prepare("SELECT value FROM _kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null),
    set: (key: string, value: string) => this.exclusive(() => { this.sql.prepare("INSERT INTO _kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); }),
  };

  // --- Import ------------------------------------------------------------------------

  /** Put documents in as they are, keeping their ids and creation times; for moving data in from Convex. */
  async importDocuments(table: string, docs: Doc[]): Promise<number> {
    return this.exclusive(() => {
      this.sql.exec("BEGIN IMMEDIATE");
      try {
        let count = 0;
        for (const doc of docs) {
          if (this.store.tableOf(doc._id)) continue;
          this.store.insert(table, doc, { _id: doc._id, _creationTime: doc._creationTime });
          count++;
        }
        this.sql.exec("COMMIT");
        if (count) this.events.emit("change", [table]);
        return count;
      } catch (error) {
        this.sql.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async importFile(id: string, bytes: Buffer, contentType: string | undefined, createdAt: number): Promise<void> {
    if (!existsSync(this.filePath(id))) writeFileSync(this.filePath(id), bytes);
    await this.exclusive(() => {
      this.sql.prepare("INSERT OR IGNORE INTO _storage (id, contentType, size, sha256, createdAt) VALUES (?, ?, ?, ?, ?)")
        .run(id, contentType ?? null, bytes.length, createHash("sha256").update(bytes).digest("base64"), createdAt);
    });
  }
}

export { ArgumentError };
