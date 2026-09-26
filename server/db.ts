import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * Perry's documents, in SQLite on this machine.
 *
 * The backend in convex/ was written against Convex's `ctx.db`, and uses a
 * small slice of it: get, insert, patch, replace, delete, normalizeId, and
 * query with withIndex (eq and range bounds), order, filter, first, unique,
 * collect and take, plus one keyword search index. This is that slice, so the
 * same functions run here unchanged.
 *
 * Each table is a SQLite table of JSON documents; each schema index is an
 * index on the same json_extract expressions the queries use, followed by
 * _creationTime, which is how Convex orders ties. Every id is recorded with its
 * table, so get() needs only the id, as in Convex.
 */

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value | undefined };
export type Doc = { _id: string; _creationTime: number } & Record<string, unknown>;
export type IndexDef = { name: string; fields: string[] };
export type SearchDef = { name: string; searchField: string; filterFields: string[] };
export type TableDef = { indexes: IndexDef[]; searchIndexes: SearchDef[] };

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const docTable = (table: string) => quote(`doc_${table}`);
/** The expression an index is built on, and a query must use verbatim for SQLite to pick the index. */
const extract = (field: string) => `json_extract(doc, '$.${field.replace(/'/g, "''")}')`;

/** Values as SQLite compares them: json_extract gives 1 and 0 for true and false. */
function param(value: unknown): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return JSON.stringify(value);
}

function newId(): string {
  // 26 characters of base32, like Convex's ids in spirit: opaque and unguessable.
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(26);
  let id = "";
  for (const byte of bytes) id += alphabet[byte % 32];
  return id;
}

function fieldOf(doc: Doc, path: string): unknown {
  let value: unknown = doc;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Filters: q.eq(q.field("x"), 1), q.and(...), … ---------------------------

type Expr = { op: string; args: unknown[] } | { field: string };
const isExpr = (value: unknown): value is Expr => typeof value === "object" && value !== null && ("op" in value || "field" in value) && Object.keys(value).length <= 2;

const filterBuilder = {
  field: (field: string) => ({ field }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", args: [a, b] }),
  neq: (a: unknown, b: unknown) => ({ op: "neq", args: [a, b] }),
  lt: (a: unknown, b: unknown) => ({ op: "lt", args: [a, b] }),
  lte: (a: unknown, b: unknown) => ({ op: "lte", args: [a, b] }),
  gt: (a: unknown, b: unknown) => ({ op: "gt", args: [a, b] }),
  gte: (a: unknown, b: unknown) => ({ op: "gte", args: [a, b] }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  not: (a: unknown) => ({ op: "not", args: [a] }),
};

function evaluate(expr: unknown, doc: Doc): unknown {
  if (!isExpr(expr)) return expr;
  if ("field" in expr) return fieldOf(doc, expr.field);
  const values = expr.args.map((arg) => evaluate(arg, doc));
  const [a, b] = values as [never, never];
  switch (expr.op) {
    case "eq": return same(a, b);
    case "neq": return !same(a, b);
    case "lt": return a < b;
    case "lte": return a <= b;
    case "gt": return a > b;
    case "gte": return a >= b;
    case "and": return values.every(Boolean);
    case "or": return values.some(Boolean);
    case "not": return !a;
    default: throw new Error(`Unsupported filter operator: ${expr.op}`);
  }
}

// --- Keyword search --------------------------------------------------------

const tokens = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Relevance for a keyword search: how many of the query's words the text has
 * (the last one may be a prefix, as it is typed), then the shorter text, then
 * the newer. Convex ranks with BM25; this keeps its useful properties for
 * Perry's two uses, finding a memory's exact duplicate and recalling by words.
 */
export function relevance(query: string, text: string): number {
  const wanted = [...new Set(tokens(query))];
  if (wanted.length === 0) return 0;
  const have = tokens(text);
  const set = new Set(have);
  let matched = 0;
  wanted.forEach((word, index) => {
    if (set.has(word) || (index === wanted.length - 1 && have.some((token) => token.startsWith(word)))) matched++;
  });
  return matched === 0 ? 0 : matched * 1_000_000 - Math.min(have.length, 999_999);
}

// --- The store ---------------------------------------------------------------

export class Store {
  private lastCreation = 0;

  constructor(readonly sql: DatabaseSync, readonly tables: Record<string, TableDef>) {
    sql.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;");
    sql.exec(`CREATE TABLE IF NOT EXISTS _ids (id TEXT PRIMARY KEY, tbl TEXT NOT NULL) WITHOUT ROWID`);
    for (const [table, def] of Object.entries(tables)) {
      sql.exec(`CREATE TABLE IF NOT EXISTS ${docTable(table)} (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, doc TEXT NOT NULL)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS ${quote(`i_${table}_by_creation_time`)} ON ${docTable(table)} (_creationTime)`);
      for (const index of def.indexes) {
        sql.exec(`CREATE INDEX IF NOT EXISTS ${quote(`i_${table}_${index.name}`)} ON ${docTable(table)} (${[...index.fields.map(extract), "_creationTime"].join(", ")})`);
      }
    }
  }

  /** A strictly increasing creation time, so documents made in the same millisecond keep their order. */
  private creationTime(): number {
    const now = Date.now();
    this.lastCreation = now > this.lastCreation ? now : this.lastCreation + 0.001;
    return this.lastCreation;
  }

  private table(name: string): TableDef {
    const def = this.tables[name];
    if (!def) throw new Error(`No table named "${name}" in the schema.`);
    return def;
  }

  tableOf(id: unknown): string | null {
    if (typeof id !== "string" || !id) return null;
    const row = this.sql.prepare("SELECT tbl FROM _ids WHERE id = ?").get(id) as { tbl: string } | undefined;
    return row?.tbl ?? null;
  }

  /**
   * The table an id argument names, for validation: a document's, or
   * "_storage" for a stored file, whose id lives in _storage (runtime.ts), so
   * v.id("_storage") holds for what ctx.storage.store returned.
   */
  idTable(id: unknown): string | null {
    const table = this.tableOf(id);
    if (table || typeof id !== "string" || !id) return table;
    const file = this.sql.prepare("SELECT 1 AS found FROM _storage WHERE id = ?").get(id) as { found: number } | undefined;
    return file ? "_storage" : null;
  }

  private row(table: string, id: string): Doc | null {
    const row = this.sql.prepare(`SELECT _id, _creationTime, doc FROM ${docTable(table)} WHERE _id = ?`).get(id) as { _id: string; _creationTime: number; doc: string } | undefined;
    return row ? { _id: row._id, _creationTime: row._creationTime, ...JSON.parse(row.doc) } : null;
  }

  get(id: unknown, reads?: Set<string>): Doc | null {
    const table = this.tableOf(id);
    if (!table) return null;
    reads?.add(table);
    return this.row(table, id as string);
  }

  normalizeId(table: string, id: unknown): string | null {
    return this.tableOf(id) === table ? (id as string) : null;
  }

  insert(table: string, value: Record<string, unknown>, keep?: { _id: string; _creationTime: number }): string {
    this.table(table);
    const id = keep?._id ?? newId();
    const { _id: _ignoredId, _creationTime: _ignoredTime, ...fields } = value;
    this.sql.prepare("INSERT INTO _ids (id, tbl) VALUES (?, ?)").run(id, table);
    this.sql.prepare(`INSERT INTO ${docTable(table)} (_id, _creationTime, doc) VALUES (?, ?, ?)`)
      .run(id, keep?._creationTime ?? this.creationTime(), JSON.stringify(fields));
    return id;
  }

  private write(id: string, next: (current: Doc) => Record<string, unknown>): string {
    const table = this.tableOf(id);
    const current = table ? this.row(table, id) : null;
    if (!table || !current) throw new Error(`Document ${id} does not exist.`);
    const { _id, _creationTime, ...fields } = next(current);
    // A field set to undefined is removed, as in Convex.
    const kept = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    this.sql.prepare(`UPDATE ${docTable(table)} SET doc = ? WHERE _id = ?`).run(JSON.stringify(kept), id);
    return table;
  }

  patch(id: string, value: Record<string, unknown>): string {
    return this.write(id, (current) => ({ ...current, ...value }));
  }

  replace(id: string, value: Record<string, unknown>): string {
    return this.write(id, () => value);
  }

  delete(id: string): string {
    const table = this.tableOf(id);
    if (!table) throw new Error(`Document ${id} does not exist.`);
    this.sql.prepare(`DELETE FROM ${docTable(table)} WHERE _id = ?`).run(id);
    this.sql.prepare("DELETE FROM _ids WHERE id = ?").run(id);
    return table;
  }

  query(table: string, reads?: Set<string>): Query {
    this.table(table);
    return new Query(this, table, reads);
  }

  /** Every document of a table, oldest first; for export and import. */
  all(table: string): Doc[] {
    return (this.sql.prepare(`SELECT _id, _creationTime, doc FROM ${docTable(table)} ORDER BY _creationTime`).all() as Array<{ _id: string; _creationTime: number; doc: string }>)
      .map((row) => ({ _id: row._id, _creationTime: row._creationTime, ...JSON.parse(row.doc) }));
  }

  /** @internal rows for a query plan; used by Query. */
  rows(sqlText: string, params: SQLInputValue[]): Iterable<Doc> {
    const statement = this.sql.prepare(sqlText);
    const iterator = statement.iterate(...params) as Iterable<{ _id: string; _creationTime: number; doc: string }>;
    return (function* () {
      for (const row of iterator) yield { _id: row._id, _creationTime: row._creationTime, ...JSON.parse(row.doc) } as Doc;
    })();
  }
}

type Bound = { field: string; op: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown };

class RangeBuilder {
  bounds: Bound[] = [];
  eq(field: string, value: unknown) { this.bounds.push({ field, op: "eq", value }); return this; }
  gt(field: string, value: unknown) { this.bounds.push({ field, op: "gt", value }); return this; }
  gte(field: string, value: unknown) { this.bounds.push({ field, op: "gte", value }); return this; }
  lt(field: string, value: unknown) { this.bounds.push({ field, op: "lt", value }); return this; }
  lte(field: string, value: unknown) { this.bounds.push({ field, op: "lte", value }); return this; }
}

class SearchBuilder {
  text = "";
  field = "";
  filters: Bound[] = [];
  search(field: string, text: string) { this.field = field; this.text = text; return this; }
  eq(field: string, value: unknown) { this.filters.push({ field, op: "eq", value }); return this; }
}

const SQL_OP = { eq: "IS", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

export class Query implements AsyncIterable<Doc> {
  private indexFields: string[] | null = null;
  private bounds: Bound[] = [];
  private direction: "asc" | "desc" = "asc";
  private filters: unknown[] = [];
  private search: SearchBuilder | null = null;

  constructor(private store: Store, private table: string, private reads?: Set<string>) {}

  withIndex(name: string, range?: (q: RangeBuilder) => RangeBuilder) {
    const def = this.store.tables[this.table];
    const fields = name === "by_creation_time" ? [] : name === "by_id" ? ["_id"] : def.indexes.find((index) => index.name === name)?.fields;
    if (!fields) throw new Error(`No index "${name}" on table "${this.table}".`);
    this.indexFields = fields;
    this.bounds = range ? range(new RangeBuilder()).bounds : [];
    return this;
  }

  withSearchIndex(name: string, build: (q: SearchBuilder) => SearchBuilder) {
    const def = this.store.tables[this.table].searchIndexes.find((index) => index.name === name);
    if (!def) throw new Error(`No search index "${name}" on table "${this.table}".`);
    this.search = build(new SearchBuilder());
    return this;
  }

  order(direction: "asc" | "desc") {
    this.direction = direction;
    return this;
  }

  filter(predicate: (q: typeof filterBuilder) => unknown) {
    this.filters.push(predicate(filterBuilder));
    return this;
  }

  private *run(limit?: number): Generator<Doc> {
    this.reads?.add(this.table);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const bounds = this.search ? this.search.filters : this.bounds;
    for (const bound of bounds) {
      const column = bound.field === "_creationTime" || bound.field === "_id" ? bound.field : extract(bound.field);
      where.push(`${column} ${SQL_OP[bound.op]} ?`);
      params.push(param(bound.value));
    }
    const fields = this.indexFields ?? [];
    const dir = this.direction === "desc" ? "DESC" : "ASC";
    const orderBy = [...fields.map((field) => `${field === "_id" ? "_id" : extract(field)} ${dir}`), `_creationTime ${dir}`].join(", ");
    const pushLimit = !this.search && this.filters.length === 0 && limit !== undefined;
    const sqlText = `SELECT _id, _creationTime, doc FROM ${docTable(this.table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy}${pushLimit ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : ""}`;
    const matches = (doc: Doc) => this.filters.every((expr) => Boolean(evaluate(expr, doc)));

    if (this.search) {
      const { field, text } = this.search;
      const ranked = [...this.store.rows(sqlText, params)]
        .filter(matches)
        .map((doc) => ({ doc, score: relevance(text, String(fieldOf(doc, field) ?? "")) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.doc._creationTime - a.doc._creationTime)
        .slice(0, Math.min(limit ?? 1024, 1024));
      for (const item of ranked) yield item.doc;
      return;
    }
    let count = 0;
    for (const doc of this.store.rows(sqlText, params)) {
      if (!matches(doc)) continue;
      yield doc;
      if (limit !== undefined && ++count >= limit) return;
    }
  }

  async collect(): Promise<Doc[]> { return [...this.run()]; }
  async take(n: number): Promise<Doc[]> { return [...this.run(n)]; }
  async first(): Promise<Doc | null> { return this.run(1).next().value ?? null; }
  async unique(): Promise<Doc | null> {
    const found = [...this.run(2)];
    if (found.length > 1) throw new Error(`unique() found more than one document in "${this.table}".`);
    return found[0] ?? null;
  }
  async *[Symbol.asyncIterator]() { yield* this.run(); }

  /** Cursor pagination by position in the ordered results, which is all Perry's callers need. */
  async paginate(options: { numItems: number; cursor: string | null }) {
    const all = [...this.run()];
    const start = options.cursor ? Number(options.cursor) || 0 : 0;
    const page = all.slice(start, start + options.numItems);
    const end = start + page.length;
    return { page, isDone: end >= all.length, continueCursor: String(end) };
  }
}
