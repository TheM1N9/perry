import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * Perry's documents, in SQLite on this machine.
 *
 * The backend in convex/ was written against Convex's `ctx.db`, and uses a
 * small slice of it: get, insert, patch, replace, delete, normalizeId, and
 * query with withIndex (eq and range bounds), order, filter, first, unique,
 * collect and take, plus search indexes and vector indexes (an action's
 * ctx.vectorSearch). This is that slice, so the same functions run here
 * unchanged.
 *
 * Each table is a SQLite table of JSON documents; each schema index is an
 * index on the same json_extract expressions the queries use, followed by
 * _creationTime, which is how Convex orders ties. Every id is recorded with its
 * table, so get() needs only the id, as in Convex.
 *
 * A search index is an FTS5 table kept in step with its documents by SQLite
 * triggers, so whatever writes a document (this code, an import, an older
 * Perry after a downgrade) keeps it current; it is rebuilt from the documents
 * when it is new or does not add up. A vector index keeps each document's
 * vector out of its JSON, as raw float32 in a table of its own, and searches
 * them in this process (VectorIndex): one SQLite file either way.
 */

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value | undefined };
export type Doc = { _id: string; _creationTime: number } & Record<string, unknown>;
export type IndexDef = { name: string; fields: string[] };
export type SearchDef = { name: string; searchField: string; filterFields: string[] };
export type VectorDef = { name: string; vectorField: string; dimensions: number; filterFields: string[] };
export type TableDef = { indexes: IndexDef[]; searchIndexes: SearchDef[]; vectorIndexes?: VectorDef[] };

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const docTable = (table: string) => quote(`doc_${table}`);
const searchTable = (table: string, index: string) => quote(`_search_${table}_${index}`);
const searchIds = (table: string, index: string) => quote(`_search_${table}_${index}_ids`);
const searchVocab = (table: string, index: string) => quote(`_search_${table}_${index}_vocab`);
const vectorTable = (table: string, index: string) => quote(`_vector_${table}_${index}`);
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

// --- Word search (FTS5) ------------------------------------------------------

/**
 * How words are split, for every language: letters, digits and the marks
 * that Devanagari, Telugu and other scripts write vowels with stay in a word;
 * accents are ignored ("cafe" finds "café").
 */
const TOKENIZER = `unicode61 remove_diacritics 2 categories 'L* N* Co M*'`;
/** Bumped when the index's shape changes, so it is built again from the documents. */
const SEARCH_VERSION = "fts5-1";
/** A word in more than this share of the documents says little; it is left out when the query has rarer ones. */
const COMMON_SHARE = 0.04;

/** The words of a query as FTS5 phrases: each quoted, the last one also as a prefix while it is still typed. */
export function searchTerms(text: string): string[] {
  const chunks = text.normalize("NFKC").split(/[\s'’"“”()[\]{}<>,;:!?¿¡|/\\*^~`]+/u).map((chunk) => chunk.replace(/^[.\-–—_]+|[.\-–—_]+$/g, "")).filter((chunk) => /[\p{L}\p{N}]/u.test(chunk));
  return [...new Set(chunks.map((chunk) => chunk.toLocaleLowerCase()))].slice(0, 32);
}
const phrase = (term: string) => `"${term.replace(/"/g, '""')}"`;

// --- The store ---------------------------------------------------------------

export class Store {
  private lastCreation = 0;
  private vectors = new Map<string, VectorIndex>();

  constructor(readonly sql: DatabaseSync, readonly tables: Record<string, TableDef>) {
    sql.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;");
    sql.exec(`CREATE TABLE IF NOT EXISTS _ids (id TEXT PRIMARY KEY, tbl TEXT NOT NULL) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _indexes (name TEXT PRIMARY KEY, version TEXT NOT NULL)`);
    for (const [table, def] of Object.entries(tables)) {
      sql.exec(`CREATE TABLE IF NOT EXISTS ${docTable(table)} (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, doc TEXT NOT NULL)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS ${quote(`i_${table}_by_creation_time`)} ON ${docTable(table)} (_creationTime)`);
      for (const index of def.indexes) {
        sql.exec(`CREATE INDEX IF NOT EXISTS ${quote(`i_${table}_${index.name}`)} ON ${docTable(table)} (${[...index.fields.map(extract), "_creationTime"].join(", ")})`);
      }
      for (const index of def.searchIndexes) this.ensureSearch(table, index);
      for (const index of def.vectorIndexes ?? []) {
        sql.exec(`CREATE TABLE IF NOT EXISTS ${vectorTable(table, index.name)} (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, vec BLOB NOT NULL)`);
        // A deleted document's vector goes with it, whoever deletes it.
        sql.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(`_vector_${table}_${index.name}_ad`)} AFTER DELETE ON ${docTable(table)} BEGIN DELETE FROM ${vectorTable(table, index.name)} WHERE id = old._id; END`);
        this.vectors.set(`${table}:${index.name}`, new VectorIndex(sql, table, index));
      }
    }
  }

  /**
   * A search index: its FTS5 table, the ids its rows stand for, and the
   * triggers that keep both in step with the documents. Built from the
   * documents when new, when its shape changed, or when its count of rows is
   * not the documents' (an older Perry ran without the triggers); that is
   * derived data, so nothing of the owner's is touched.
   */
  private ensureSearch(table: string, index: SearchDef) {
    const name = `search:${table}:${index.name}`;
    const version = `${SEARCH_VERSION}:${index.searchField}:${TOKENIZER}`;
    const known = (this.sql.prepare("SELECT version FROM _indexes WHERE name = ?").get(name) as { version: string } | undefined)?.version;
    const fts = searchTable(table, index.name);
    const ids = searchIds(table, index.name);
    const field = extract(index.searchField).replace("doc,", "new.doc,");
    const prefix = `_search_${table}_${index.name}`;
    if (known !== version) {
      for (const suffix of ["ai", "au", "ad"]) this.sql.exec(`DROP TRIGGER IF EXISTS ${quote(`${prefix}_${suffix}`)}`);
      this.sql.exec(`DROP TABLE IF EXISTS ${searchVocab(table, index.name)}`);
      this.sql.exec(`DROP TABLE IF EXISTS ${fts}`);
      this.sql.exec(`DROP TABLE IF EXISTS ${ids}`);
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${ids} (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE)`);
    this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(body, tokenize = "${TOKENIZER}", prefix = '2 3')`);
    this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${searchVocab(table, index.name)} USING fts5vocab(${fts}, 'row')`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(`${prefix}_ai`)} AFTER INSERT ON ${docTable(table)} BEGIN
      INSERT OR IGNORE INTO ${ids} (id) VALUES (new._id);
      INSERT INTO ${fts} (rowid, body) SELECT rowid, coalesce(${field}, '') FROM ${ids} WHERE id = new._id;
    END`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(`${prefix}_au`)} AFTER UPDATE OF doc ON ${docTable(table)}
      WHEN ${field.replace("new.doc,", "old.doc,")} IS NOT ${field} BEGIN
      DELETE FROM ${fts} WHERE rowid = (SELECT rowid FROM ${ids} WHERE id = new._id);
      INSERT OR IGNORE INTO ${ids} (id) VALUES (new._id);
      INSERT INTO ${fts} (rowid, body) SELECT rowid, coalesce(${field}, '') FROM ${ids} WHERE id = new._id;
    END`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(`${prefix}_ad`)} AFTER DELETE ON ${docTable(table)} BEGIN
      DELETE FROM ${fts} WHERE rowid = (SELECT rowid FROM ${ids} WHERE id = old._id);
      DELETE FROM ${ids} WHERE id = old._id;
    END`);
    const counts = this.sql.prepare(`SELECT (SELECT count(*) FROM ${docTable(table)}) AS docs, (SELECT count(*) FROM ${ids}) AS indexed`).get() as { docs: number; indexed: number };
    if (known === version && counts.docs === counts.indexed) return;
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      this.sql.exec(`DELETE FROM ${fts}`);
      this.sql.exec(`DELETE FROM ${ids}`);
      this.sql.exec(`INSERT INTO ${ids} (id) SELECT _id FROM ${docTable(table)} ORDER BY _creationTime`);
      this.sql.exec(`INSERT INTO ${fts} (rowid, body) SELECT i.rowid, coalesce(${extract(index.searchField).replace("doc,", "d.doc,")}, '') FROM ${ids} i JOIN ${docTable(table)} d ON d._id = i.id`);
      this.sql.prepare("INSERT INTO _indexes (name, version) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version").run(name, version);
      this.sql.exec("COMMIT");
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  /** The FTS5 query for a search: its rarer words, any of them, best first by BM25. Null when it has none. */
  matchFor(table: string, index: string, text: string): string | null {
    const terms = searchTerms(text);
    if (!terms.length) return null;
    const typing = !/\s$/.test(text);
    const total = (this.sql.prepare(`SELECT count(*) AS n FROM ${searchIds(table, index)}`).get() as { n: number }).n;
    const vocab = this.sql.prepare(`SELECT doc FROM ${searchVocab(table, index)} WHERE term = ?`);
    // A word that splits into several (a code, a date) is kept: it is a phrase, and phrases are rare.
    const common = (term: string) => /^[\p{L}\p{N}\p{M}]+$/u.test(term) && ((vocab.get(term.normalize("NFD").replace(/[̀-ͯ]/g, "")) as { doc: number } | undefined)?.doc ?? 0) > Math.max(50, total * COMMON_SHARE);
    const rare = terms.filter((term) => !common(term));
    const kept = rare.length ? rare : terms;
    const last = terms[terms.length - 1];
    return kept.map((term) => (term === last && typing && /^[\p{L}\p{N}\p{M}]+$/u.test(term) ? `${phrase(term)} OR ${phrase(term)}*` : phrase(term))).join(" OR ");
  }

  /** The vector index of a table, for ctx.vectorSearch. */
  vectorIndex(table: string, index: string): VectorIndex {
    const found = this.vectors.get(`${table}:${index}`);
    if (!found) throw new Error(`No vector index "${index}" on table "${table}".`);
    return found;
  }

  /**
   * A document's vector fields, taken out of what goes into its JSON and kept
   * in their own table: a number array is stored, null or undefined removes it,
   * and a field left out keeps what is there unless the document is replaced.
   */
  private takeVectors(table: string, id: string, fields: Record<string, unknown>, replacing: boolean): Record<string, unknown> {
    const defs = this.tables[table]?.vectorIndexes ?? [];
    if (!defs.length) return fields;
    const rest = { ...fields };
    for (const def of defs) {
      const has = def.vectorField in rest;
      const value = rest[def.vectorField];
      delete rest[def.vectorField];
      if (!has && !replacing) continue;
      this.vectorIndex(table, def.name).put(id, Array.isArray(value) ? value as number[] : null);
    }
    return rest;
  }

  /** A document whose filter fields may have changed, for the vector indexes' copies of them. */
  private touched(table: string, id: string) {
    for (const def of this.tables[table]?.vectorIndexes ?? []) this.vectorIndex(table, def.name).touch(id);
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
    const { _id: _ignoredId, _creationTime: _ignoredTime, ...given } = value;
    const fields = this.takeVectors(table, id, given, false);
    this.sql.prepare("INSERT INTO _ids (id, tbl) VALUES (?, ?)").run(id, table);
    this.sql.prepare(`INSERT INTO ${docTable(table)} (_id, _creationTime, doc) VALUES (?, ?, ?)`)
      .run(id, keep?._creationTime ?? this.creationTime(), JSON.stringify(fields));
    this.touched(table, id);
    return id;
  }

  private write(id: string, value: Record<string, unknown>, replacing: boolean): string {
    const table = this.tableOf(id);
    const current = table ? this.row(table, id) : null;
    if (!table || !current) throw new Error(`Document ${id} does not exist.`);
    const { _id, _creationTime, ...fields } = replacing ? value : { ...current, ...value };
    // A field set to undefined is removed, as in Convex.
    const kept = Object.fromEntries(Object.entries(this.takeVectors(table, id, fields, replacing)).filter(([, field]) => field !== undefined));
    this.sql.prepare(`UPDATE ${docTable(table)} SET doc = ? WHERE _id = ?`).run(JSON.stringify(kept), id);
    this.touched(table, id);
    return table;
  }

  patch(id: string, value: Record<string, unknown>): string {
    return this.write(id, value, false);
  }

  replace(id: string, value: Record<string, unknown>): string {
    return this.write(id, value, true);
  }

  delete(id: string): string {
    const table = this.tableOf(id);
    if (!table) throw new Error(`Document ${id} does not exist.`);
    this.sql.prepare(`DELETE FROM ${docTable(table)} WHERE _id = ?`).run(id);
    this.sql.prepare("DELETE FROM _ids WHERE id = ?").run(id);
    this.touched(table, id);
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
  private searchName = "";

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
    this.searchName = name;
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
      // Any of the query's rarer words, best first by BM25 (Convex ranks its search the same way), within the filters.
      const match = this.store.matchFor(this.table, this.searchName, this.search.text);
      if (!match) return;
      const filters = where.map((clause) => clause.replace(/json_extract\(doc,/g, "json_extract(d.doc,").replace(/^(_creationTime|_id) /, "d.$1 "));
      const cap = Math.min(limit ?? 1024, 1024);
      const searchSql = `SELECT d._id AS _id, d._creationTime AS _creationTime, d.doc AS doc FROM ${searchTable(this.table, this.searchName)} f
        JOIN ${searchIds(this.table, this.searchName)} i ON i.rowid = f.rowid JOIN ${docTable(this.table)} d ON d._id = i.id
        WHERE f.body MATCH ?${filters.length ? ` AND ${filters.join(" AND ")}` : ""} ORDER BY bm25(${searchTable(this.table, this.searchName)}), d._creationTime DESC${this.filters.length ? "" : ` LIMIT ${cap}`}`;
      let count = 0;
      for (const doc of this.store.rows(searchSql, [match, ...params])) {
        if (!matches(doc)) continue;
        yield doc;
        if (++count >= cap) return;
      }
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
  async first(): Promise<Doc | null> {
    // Closed once it has its row: an unfinished statement keeps a read snapshot open,
    // which keeps the WAL from checkpointing and fails the next write once any other
    // connection (a script, a test) has written.
    const rows = this.run(1);
    try { return rows.next().value ?? null; } finally { rows.return(undefined); }
  }
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

// --- Vector search ---------------------------------------------------------------

type VectorFilter = { op: "eq"; field: string; value: unknown } | { op: "or"; args: VectorFilter[] };
const vectorFilterBuilder = {
  eq: (field: string, value: unknown): VectorFilter => ({ op: "eq", field, value }),
  or: (...args: VectorFilter[]): VectorFilter => ({ op: "or", args }),
};
export type VectorQuery = { vector: number[]; limit?: number; filter?: (q: typeof vectorFilterBuilder) => VectorFilter };

/** 32 bits a word, up to 1,024 dimensions. */
const WORDS = 32;
const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
const floatsOf = (blob: Uint8Array) => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

/**
 * One vector index: each document's vector as raw float32 in a table of its
 * own (never inside the document's JSON), and in this process a bit per
 * dimension of each (its sign, once the mean of all of them is taken away:
 * sentence models put most vectors in one corner, where raw signs say little),
 * with the values of the index's filter fields.
 * A search compares the bits with the query's first, which takes a few
 * milliseconds for 100,000 vectors, and then reads the closest few hundred in
 * full from SQLite to rank them by cosine. So memory stays small (about
 * 140 bytes a vector) and nothing but SQLite holds the vectors.
 *
 * What this process writes marks the documents it touched, and they are read
 * again before the next search, so a write rolled back is never seen; what
 * another process wrote (PRAGMA data_version) loads it all again.
 */
export class VectorIndex {
  private loaded = false;
  private dataVersion = -1;
  private ids: string[] = [];
  private rowids: number[] = [];
  private dims = new Uint16Array(0);
  private bits = new Uint32Array(0);
  private filters: unknown[][] = [];
  private slots = new Map<string, number>();
  private dirty = new Set<string>();
  /** The mean vector of each length, and how many vectors it was taken over: past twice as many, it is taken again. */
  private means = new Map<number, { mean: Float32Array; over: number }>();
  private readonly sql: DatabaseSync;
  private readonly table: string;
  readonly def: VectorDef;

  constructor(sql: DatabaseSync, table: string, def: VectorDef) {
    this.sql = sql;
    this.table = table;
    this.def = def;
  }

  /** Store a document's vector, or with null remove it. Part of the caller's transaction. */
  put(id: string, vector: number[] | null) {
    if (vector === null) {
      this.sql.prepare(`DELETE FROM ${vectorTable(this.table, this.def.name)} WHERE id = ?`).run(id);
    } else {
      if (!vector.length || vector.length > WORDS * 32 || vector.some((x) => typeof x !== "number" || !Number.isFinite(x))) throw new Error(`A vector for ${this.def.name} must be up to ${WORDS * 32} finite numbers.`);
      const norm = Math.hypot(...vector) || 1;
      const floats = new Float32Array(vector.map((x) => x / norm));
      this.sql.prepare(`INSERT INTO ${vectorTable(this.table, this.def.name)} (id, vec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET vec = excluded.vec`)
        .run(id, new Uint8Array(floats.buffer));
    }
    this.dirty.add(id);
  }

  /** A document changed: its filter fields are read again before the next search. */
  touch(id: string) {
    if (this.loaded) this.dirty.add(id);
  }

  /** How many vectors it holds, by the value of its first filter field (the model that made them, for memories). */
  counts(): Record<string, number> {
    this.fresh();
    const counts: Record<string, number> = {};
    for (let slot = 0; slot < this.ids.length; slot++) {
      if (!this.ids[slot]) continue;
      const key = String(this.filters[slot]?.[0] ?? "");
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  private selectRows(where = "") {
    const fields = this.def.filterFields.map((field, index) => `${extract(field).replace("doc,", "d.doc,")} AS f${index}`);
    return `SELECT v.rowid AS rowid, v.id AS id, v.vec AS vec${fields.length ? `, ${fields.join(", ")}` : ""} FROM ${vectorTable(this.table, this.def.name)} v JOIN ${docTable(this.table)} d ON d._id = v.id${where}`;
  }

  private place(row: { rowid: number; id: string; vec: Uint8Array } & Record<string, unknown>) {
    const floats = floatsOf(row.vec);
    let slot = this.slots.get(row.id);
    if (slot === undefined) {
      slot = this.ids.length;
      this.slots.set(row.id, slot);
      this.ids.push(row.id);
      this.rowids.push(row.rowid);
      if (slot >= this.dims.length) {
        const size = Math.max(1024, this.dims.length * 2);
        const dims = new Uint16Array(size); dims.set(this.dims); this.dims = dims;
        const bits = new Uint32Array(size * WORDS); bits.set(this.bits); this.bits = bits;
      }
    }
    this.ids[slot] = row.id;
    this.rowids[slot] = row.rowid;
    this.dims[slot] = floats.length;
    this.filters[slot] = this.def.filterFields.map((_, index) => row[`f${index}`] ?? undefined);
    const base = slot * WORDS;
    this.bits.fill(0, base, base + WORDS);
    const mean = this.means.get(floats.length)?.mean;
    for (let d = 0; d < floats.length; d++) if (floats[d] > (mean ? mean[d] : 0)) this.bits[base + (d >>> 5)] |= 1 << (d & 31);
  }

  /** The mean of every vector of each length, in one pass over the table. */
  private takeMeans() {
    const sums = new Map<number, { sum: Float64Array; over: number }>();
    for (const row of this.sql.prepare(`SELECT vec FROM ${vectorTable(this.table, this.def.name)}`).iterate() as Iterable<{ vec: Uint8Array }>) {
      const floats = floatsOf(row.vec);
      const entry = sums.get(floats.length) ?? { sum: new Float64Array(floats.length), over: 0 };
      for (let d = 0; d < floats.length; d++) entry.sum[d] += floats[d];
      entry.over++;
      sums.set(floats.length, entry);
    }
    this.means.clear();
    for (const [dims, { sum, over }] of sums) this.means.set(dims, { mean: Float32Array.from(sum, (x) => x / over), over });
  }

  private remove(id: string) {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.slots.delete(id);
    this.ids[slot] = "";
    this.dims[slot] = 0;
  }

  /** Up to date with SQLite: everything again after another process wrote, else what this one touched. */
  private fresh() {
    const version = (this.sql.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    const grown = [...this.means.values()].some((entry) => this.ids.length > entry.over * 2 + 1000) || (!this.means.size && this.ids.length > 1000);
    if (!this.loaded || version !== this.dataVersion || grown) {
      this.takeMeans();
      this.ids = []; this.rowids = []; this.filters = []; this.slots.clear(); this.dims = new Uint16Array(0); this.bits = new Uint32Array(0);
      for (const row of this.sql.prepare(this.selectRows()).iterate() as Iterable<{ rowid: number; id: string; vec: Uint8Array }>) this.place(row);
      this.loaded = true;
      this.dataVersion = version;
      this.dirty.clear();
      return;
    }
    if (!this.dirty.size) return;
    const one = this.sql.prepare(this.selectRows(" WHERE v.id = ?"));
    for (const id of this.dirty) {
      const row = one.get(id) as ({ rowid: number; id: string; vec: Uint8Array } & Record<string, unknown>) | undefined;
      if (row) this.place(row); else this.remove(id);
    }
    this.dirty.clear();
  }

  /** The documents whose vectors are closest to the query's, by cosine, best first; at most 256, as in Convex. */
  search(query: VectorQuery): Array<{ _id: string; _score: number }> {
    this.fresh();
    const limit = Math.max(1, Math.min(query.limit ?? 10, 256));
    const norm = Math.hypot(...query.vector) || 1;
    const target = new Float32Array(query.vector.map((x) => x / norm));
    const filter = query.filter?.(vectorFilterBuilder);
    const fields = this.def.filterFields;
    const passes = (slot: number, expr: VectorFilter): boolean => expr.op === "or"
      ? expr.args.some((arg) => passes(slot, arg))
      : same(this.filters[slot][fields.indexOf(expr.field)] ?? undefined, expr.value ?? undefined);
    const words = Math.ceil(target.length / 32);
    const signs = new Uint32Array(words);
    const mean = this.means.get(target.length)?.mean;
    for (let d = 0; d < target.length; d++) if (target[d] > (mean ? mean[d] : 0)) signs[d >>> 5] |= 1 << (d & 31);
    // The bits first: how many signs differ, for every vector of the query's length that passes the filter.
    const distance = new Uint16Array(this.ids.length).fill(65535);
    const histogram = new Uint32Array(words * 32 + 2);
    let candidates = 0;
    for (let slot = 0; slot < this.ids.length; slot++) {
      if (this.dims[slot] !== target.length || (filter && !passes(slot, filter))) continue;
      let differ = 0;
      const base = slot * WORDS;
      for (let w = 0; w < words; w++) differ += popcount(this.bits[base + w] ^ signs[w]);
      distance[slot] = differ;
      histogram[differ]++;
      candidates++;
    }
    if (!candidates) return [];
    // The closest few hundred by bits are ranked in full: enough that the truly closest are among them.
    const keep = Math.min(candidates, Math.max(RESCORE, limit * 20));
    let threshold = 0;
    for (let seen = 0; threshold < histogram.length; threshold++) { seen += histogram[threshold]; if (seen >= keep) break; }
    const picked: number[] = [];
    for (let slot = 0; slot < this.ids.length; slot++) if (distance[slot] <= threshold) picked.push(slot);
    const bySlot = new Map(picked.map((slot) => [this.rowids[slot], slot]));
    const read = this.sql.prepare(`SELECT rowid, vec FROM ${vectorTable(this.table, this.def.name)} WHERE rowid IN (SELECT value FROM json_each(?))`);
    const scored: Array<{ _id: string; _score: number }> = [];
    for (const row of read.all(JSON.stringify(picked.map((slot) => this.rowids[slot]))) as Array<{ rowid: number; vec: Uint8Array }>) {
      const slot = bySlot.get(row.rowid);
      if (slot === undefined) continue;
      const floats = floatsOf(row.vec);
      let score = 0;
      for (let d = 0; d < floats.length; d++) score += floats[d] * target[d];
      scored.push({ _id: this.ids[slot], _score: score });
    }
    return scored.sort((a, b) => b._score - a._score).slice(0, limit);
  }
}

/** How many vectors, closest by their bits, are read in full and ranked by cosine. PERRY_VECTOR_RESCORE changes it. */
const RESCORE = Number(process.env.PERRY_VECTOR_RESCORE) || 600;
