import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CREDENTIAL_PREFIX, credentialKey, decryptCredential, encryptCredential, protectCredential } from "../convex/lib/credential-encryption";

const TABLES = ["vault", "secrets"] as const;
const CHECK = "Perry credential encryption key check v1";
const hasTable = (sql: DatabaseSync, table: string) => Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

/** Called before opening the backend to requests. No fallback to a fresh key for protected data. */
export function initializeCredentialEncryption(sql: DatabaseSync, home: string): void {
  prepareCredentialKey(sql, home);
  // Validate/migrate the live database before any future backup can copy plaintext.
  migrateCredentialDatabase(sql);
  migrateCredentialBackups(join(home, "backups"));
}

/** Setup may call this on a new, empty SQLite file; it never rewrites data. */
export function prepareCredentialKey(sql: DatabaseSync, home: string): void {
  const keyFile = join(home, "credential-key");
  const backups = join(home, "backups");
  if (existsSync(keyFile)) {
    noLink(keyFile);
    const saved = readFileSync(keyFile, "utf8").trim();
    if (process.env.PERRY_CREDENTIAL_KEY && process.env.PERRY_CREDENTIAL_KEY !== saved) throw new Error("Perry's configured credential key differs from its persisted key. Restore the original key.");
    process.env.PERRY_CREDENTIAL_KEY = saved;
  } else {
    // An explicit recovery key may restore a missing file; automatic replacement may not.
    if (!process.env.PERRY_CREDENTIAL_KEY && (protectedDatabase(sql) || protectedBackups(backups))) {
      throw new Error("Perry's credential key is missing. Restore credential-key from your secure key backup before starting Perry.");
    }
    process.env.PERRY_CREDENTIAL_KEY ??= randomBytes(32).toString("hex");
    credentialKey();
    validateProtectedDatabase(sql);
    for (const file of backupFiles(backups)) {
      if (/\.json$/i.test(file)) {
        // Preflight encrypted rows before persisting a supplied recovery key.
        protectBackupJson(parseDocument(readFileSync(file, "utf8")));
      } else {
        const backup = new DatabaseSync(file, { readOnly: true });
        try { validateProtectedDatabase(backup); } finally { backup.close(); }
      }
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const fd = openSync(keyFile, "wx", 0o600);
    try { writeFileSync(fd, `${process.env.PERRY_CREDENTIAL_KEY}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  credentialKey();
}

function noLink(file: string) {
  if (lstatSync(file).isSymbolicLink()) throw new Error("Credential migration refuses filesystem links.");
}

function parseDocument(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error("Perry could not read a credential document or backup. Restore an intact copy before retrying."); }
}

function protectedDatabase(sql: DatabaseSync): boolean {
  if (hasTable(sql, "_credential_encryption")) return true;
  return TABLES.some((table) => hasTable(sql, `doc_${table}`) && Boolean(sql.prepare(`SELECT 1 FROM "doc_${table}" WHERE json_extract(doc, '$.value') LIKE ? LIMIT 1`).get(`${CREDENTIAL_PREFIX}%`)));
}

function validateProtectedDatabase(sql: DatabaseSync) {
  if (hasTable(sql, "_credential_encryption")) {
    const marker = sql.prepare("SELECT keyCheck FROM _credential_encryption WHERE id = 1").get() as { keyCheck: string } | undefined;
    if (marker && decryptCredential("secrets", marker.keyCheck) !== CHECK) throw new Error("Perry's credential key check failed.");
  }
  for (const table of TABLES) {
    if (!hasTable(sql, `doc_${table}`)) continue;
    for (const row of sql.prepare(`SELECT doc FROM "doc_${table}"`).iterate() as Iterable<{ doc: string }>) {
      const fields = parseDocument(row.doc) as { value?: unknown };
      if (typeof fields.value === "string" && fields.value.startsWith(CREDENTIAL_PREFIX)) decryptCredential(table, fields.value);
    }
  }
}

/** Whole migration commits atomically. A durable pending flag retries physical cleanup after a crash. */
export function migrateCredentialDatabase(sql: DatabaseSync): void {
  credentialKey();
  sql.exec("PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
  let marker: { keyCheck: string; cleanup: number } | undefined;
  const changes: Array<{ table: string; id: string; doc: string }> = [];
  try {
    marker = hasTable(sql, "_credential_encryption")
      ? sql.prepare("SELECT keyCheck, cleanup FROM _credential_encryption WHERE id = 1").get() as typeof marker
      : undefined;
    if (marker && decryptCredential("secrets", marker.keyCheck) !== CHECK) throw new Error("Perry's credential key check failed.");
    for (const table of TABLES) {
      if (!hasTable(sql, `doc_${table}`)) continue;
      for (const row of sql.prepare(`SELECT _id, doc FROM "doc_${table}"`).all() as Array<{ _id: string; doc: string }>) {
        const fields = parseDocument(row.doc) as Record<string, unknown>;
        const protectedFields = protectCredential(table, fields);
        if (protectedFields !== fields) changes.push({ table, id: row._id, doc: JSON.stringify(protectedFields) });
      }
    }
    if (!marker || changes.length) {
      sql.exec("CREATE TABLE IF NOT EXISTS _credential_encryption (id INTEGER PRIMARY KEY CHECK(id = 1), keyCheck TEXT NOT NULL, cleanup INTEGER NOT NULL)");
      for (const row of changes) sql.prepare(`UPDATE "doc_${row.table}" SET doc = ? WHERE _id = ?`).run(row.doc, row.id);
      sql.prepare("INSERT INTO _credential_encryption (id, keyCheck, cleanup) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET cleanup = 1").run(encryptCredential("secrets", CHECK));
    }
    sql.exec("COMMIT");
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
  if (!marker || marker.cleanup || changes.length) {
    checkpoint(sql);
    sql.exec("VACUUM");
    checkpoint(sql);
    sql.exec("UPDATE _credential_encryption SET cleanup = 0 WHERE id = 1");
    checkpoint(sql);
  }
}

function checkpoint(sql: DatabaseSync) {
  const result = sql.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number };
  if (result.busy) throw new Error("Credential migration needs exclusive database access. Close other Perry processes and retry.");
}

type BackupStaging = { file: string; original: string };
// Distinct from a backup: never parse or promote a partial write as original data.
const STAGING_NAME = /^(.+\.json)\.perry-credential-[a-f0-9]{32}\.tmp$/i;

/** Exact Finder metadata name only; validate its buddy-container header, not its payload. */
function finderMetadata(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    const header = Buffer.alloc(36);
    if (!stat.isFile() || readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    if (header.readUInt32BE(0) !== 1 || header.toString("ascii", 4, 8) !== "Bud1") return false;
    const root = header.readUInt32BE(8), size = header.readUInt32BE(12);
    return root === header.readUInt32BE(16) && root >= 32 && root % 32 === 0 && size >= 8 && root + 4 + size <= stat.size;
  } finally { closeSync(fd); }
}

function checkStaging(staging: BackupStaging): void {
  noLink(staging.file);
  if (!existsSync(staging.original)) throw new Error("Credential backup staging has no matching original. Preserve it for manual recovery.");
  noLink(staging.original);
  if (!lstatSync(staging.file).isFile() || !lstatSync(staging.original).isFile()) {
    throw new Error("Credential backup staging and its original must be regular files. Preserve them for manual recovery.");
  }
}

function discardStaging(staging: BackupStaging): void {
  checkStaging(staging);
  // Only the intact, authenticated original is authoritative; never promote staging.
  protectBackupJson(parseDocument(readFileSync(staging.original, "utf8")));
  unlinkSync(staging.file);
}

function backupFiles(dir: string, staging?: BackupStaging[]): string[] {
  if (!existsSync(dir)) return [];
  noLink(dir);
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    noLink(file);
    const match = STAGING_NAME.exec(name);
    if (match) {
      const item = { file, original: join(dir, match[1]) };
      checkStaging(item);
      staging?.push(item);
      return [];
    }
    if (lstatSync(file).isDirectory()) return backupFiles(file, staging);
    if (name === ".DS_Store") {
      try { if (finderMetadata(file)) return []; }
      catch { /* Report a constant diagnostic for unverified metadata. */ }
      throw new Error("Unrecognized Finder metadata in Perry's backups needs review before credential migration can finish.");
    }
    if (/\.(sqlite|db|json)$/i.test(name)) return [file];
    if (/(?:-wal|-shm|-journal)$/.test(name) && existsSync(file.replace(/(?:-wal|-shm|-journal)$/, ""))) return [];
    throw new Error("An unsupported file in Perry's backups needs review before credential migration can finish.");
  });
}

/** Preserve the existing JSON backup shape, encrypting any credential table arrays. */
function protectBackupJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(protectBackupJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => {
    if (name === "vault" || name === "secrets") {
      if (!Array.isArray(child)) throw new Error("An unsupported credential backup needs review.");
      return [name, child.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("An invalid credential backup needs review.");
        return protectCredential(name, row as Record<string, unknown>);
      })];
    }
    return [name, protectBackupJson(child)];
  }));
}

function protectedBackups(dir: string): boolean {
  return backupFiles(dir).some((file) => {
    if (/\.json$/i.test(file)) return readFileSync(file, "utf8").includes(CREDENTIAL_PREFIX);
    const sql = new DatabaseSync(file, { readOnly: true });
    try { return protectedDatabase(sql); } finally { sql.close(); }
  });
}

/** Existing SQLite/JSON backups stay restorable with the same ids and metadata. */
export function migrateCredentialBackups(dir: string): void {
  const staging: BackupStaging[] = [];
  const files = backupFiles(dir, staging);
  for (const item of staging) discardStaging(item);
  for (const file of files) {
    if (!/\.json$/i.test(file)) {
      const sql = new DatabaseSync(file);
      try { migrateCredentialDatabase(sql); } finally { sql.close(); }
      continue;
    }
    const original = readFileSync(file, "utf8");
    const parsed = parseDocument(original);
    const protectedJson = JSON.stringify(protectBackupJson(parsed));
    if (JSON.stringify(parsed) === protectedJson) continue;
    const temporary = `${file}.perry-credential-${randomBytes(16).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try { writeFileSync(fd, protectedJson); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, file);
    } catch (error) {
      if (existsSync(temporary)) discardStaging({ file: temporary, original: file });
      throw error;
    }
  }
}
