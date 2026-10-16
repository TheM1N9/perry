/**
 * Fake-data backend E2E; no HTTP listeners, engines, real home or credentials.
 * Run: pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/secrets-at-rest/run.ts
 * Failure inventory: artifacts/secrets-at-rest/failure-cases.md (written first).
 * Repeatable artifact: .batch-work/batch-1/251/e2e-result.json
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const scratchRoot = resolve(".batch-work/batch-1/251");
mkdirSync(scratchRoot, { recursive: true });
const home = mkdtempSync(join(scratchRoot, "e2e-"));
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = "synthetic-251-dashboard";
process.env.PERRY_ENGINE = "fake";
delete process.env.PERRY_CREDENTIAL_KEY;
process.env.COMPOSIO_API_KEY = "synthetic-env-fallback";
const { initializeCredentialEncryption, migrateCredentialDatabase, migrateCredentialBackups } = await import("../../server/credential-encryption");
const { decryptCredential, encryptCredential } = await import("../../convex/lib/credential-encryption");
const { Runtime } = await import("../../server/runtime");
const vault = await import("../../convex/vault");
const secrets = await import("../../convex/secrets");
const { default: schema } = await import("../../convex/schema");
const checks: Array<{ name: string; passed: boolean }> = [];
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); checks.push({ name, passed: true }); }
  catch { checks.push({ name, passed: false }); }
}
// Never persist assertion messages: comparison libraries include plaintext actual/expected.
const secret = () => `synthetic-${randomBytes(12).toString("hex")}-ü🔑`;
const oldLogin = secret(), oldKey = secret(), nextLogin = secret(), nextKey = secret();
const database = join(home, "perry.sqlite");
const backups = join(home, "backups");
mkdirSync(backups);
// Synthetic Finder buddy-container header and in-range root, no user metadata.
const finderFixture = Buffer.alloc(4096);
finderFixture.writeUInt32BE(1, 0); finderFixture.write("Bud1", 4, "ascii");
finderFixture.writeUInt32BE(2048, 8); finderFixture.writeUInt32BE(1264, 12); finderFixture.writeUInt32BE(2048, 16);
finderFixture.writeUInt32BE(1, 2052); finderFixture.writeUInt32BE(2048 | 5, 2060);
writeFileSync(join(backups, ".DS_Store"), finderFixture);
let sql = new DatabaseSync(database);
sql.exec(`CREATE TABLE doc_vault (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, doc TEXT NOT NULL);
CREATE TABLE doc_secrets (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, doc TEXT NOT NULL);
CREATE TABLE _ids (id TEXT PRIMARY KEY, tbl TEXT NOT NULL) WITHOUT ROWID;`);
sql.prepare("INSERT INTO doc_vault VALUES (?, ?, ?)").run("legacy-login", 1, JSON.stringify({ label: "Legacy", username: "fake", value: oldLogin, by: "owner", updatedAt: 1 }));
sql.prepare("INSERT INTO doc_secrets VALUES (?, ?, ?)").run("legacy-key", 2, JSON.stringify({ name: "COMPOSIO_API_KEY", value: oldKey, updatedAt: 2 }));
sql.exec("INSERT INTO _ids VALUES ('legacy-login', 'vault'), ('legacy-key', 'secrets')");
sql.prepare("VACUUM INTO ?").run(join(backups, "legacy.sqlite"));
writeFileSync(join(backups, "legacy.json"), JSON.stringify({ tables: { vault: [{ _id: "legacy-login", value: oldLogin }], secrets: [{ _id: "legacy-key", value: oldKey }] } }));
await check("bootstrap migrates live and historical backups", () => {
  initializeCredentialEncryption(sql, home);
  assert(existsSync(join(home, "credential-key")));
  assert.deepEqual(readFileSync(join(backups, ".DS_Store")), finderFixture);
  assert.equal(decryptCredential("vault", JSON.parse(sql.prepare("SELECT doc FROM doc_vault").get()!.doc as string).value), oldLogin);
});
const runtime = new Runtime(sql, schema as never, { vault, secrets }, { storageDir: join(home, "storage") });
const query = async (name: string, args: object = {}) => (await runtime.runQuery(name, args, { internal: true })).value;
const mutate = (name: string, args: object) => runtime.runMutation(name, args, { internal: true });
await check("legacy consumers and service preview still work", async () => {
  assert.equal(await query("secrets:get", { name: "COMPOSIO_API_KEY" }), oldKey);
  assert.equal((await mutate("vault:reveal", { id: "legacy-login" }) as { value: string }).value, oldLogin);
  assert((await query("secrets:status") as Array<{ preview?: string }>).some(row => row.preview === `…${oldKey.slice(-4)}`));
  assert(!JSON.stringify(await query("vault:list")).includes(oldLogin));
});
await check("save, replace, reveal, redaction and empty env fallback", async () => {
  const saved = await mutate("vault:save", { label: "New", value: nextLogin, by: "owner" }) as { id: string };
  const again = await mutate("vault:save", { label: "New", value: nextLogin, by: "assistant" }) as { id: string; replaced: boolean };
  assert(again.replaced); assert.equal(again.id, saved.id);
  assert.equal((await mutate("vault:reveal", { id: saved.id }) as { value: string }).value, nextLogin);
  await mutate("secrets:set", { name: "COMPOSIO_API_KEY", value: nextKey });
  assert.equal(await query("secrets:get", { name: "COMPOSIO_API_KEY" }), nextKey);
  assert.equal(await query("vault:anySaved", { text: `before ${nextLogin} after` }), true);
  const ctx = { db: { query: (table: string) => runtime.store.query(table) } } as never;
  assert((await vault.keptSecrets(ctx)).some(item => item.value === nextKey));
  assert((await vault.savedValues(ctx)).includes(nextLogin));
  await mutate("secrets:set", { name: "COMPOSIO_API_KEY", value: "" });
  assert.equal(await query("secrets:get", { name: "COMPOSIO_API_KEY" }), process.env.COMPOSIO_API_KEY);
  await mutate("secrets:clear", { name: "COMPOSIO_API_KEY" });
  assert.equal(await query("secrets:get", { name: "COMPOSIO_API_KEY" }), process.env.COMPOSIO_API_KEY);
});
await check("legacy import and metadata patch retain encryption", async () => {
  await runtime.importDocuments("vault", [{ _id: "imported", _creationTime: 3, label: "Imported", value: oldLogin, by: "owner", updatedAt: 3 }]);
  runtime.store.patch("imported", { note: "metadata only" });
  assert.equal(decryptCredential("vault", runtime.store.get("imported")!.value as string), oldLogin);
  assert(!JSON.stringify(runtime.store.all("vault")).includes(oldLogin));
});
await check("fresh nonces, empty and reserved-prefix literals roundtrip", async () => {
  assert.notEqual(encryptCredential("vault", nextLogin), encryptCredential("vault", nextLogin));
  assert.equal(decryptCredential("vault", encryptCredential("vault", "")), "");
  const literal = "perry:credential:v999:literal";
  const saved = await mutate("vault:save", { label: "Reserved", value: literal, by: "owner" }) as { id: string };
  assert.equal((await mutate("vault:reveal", { id: saved.id }) as { value: string }).value, literal);
});
await check("wrong key, tampering, wrong table and unknown versions fail closed", () => {
  const encrypted = encryptCredential("vault", nextLogin);
  assert.throws(() => decryptCredential("secrets", encrypted));
  assert.throws(() => decryptCredential("vault", encrypted.replace("v1:", "v2:")));
  assert.throws(() => decryptCredential("vault", `${encrypted.slice(0, -2)}${encrypted.endsWith("00") ? "01" : "00"}`));
  const saved = process.env.PERRY_CREDENTIAL_KEY;
  process.env.PERRY_CREDENTIAL_KEY = randomBytes(32).toString("hex");
  try { assert.throws(() => migrateCredentialDatabase(sql)); }
  finally { process.env.PERRY_CREDENTIAL_KEY = saved; }
});
await check("migration atomic failure and cleanup retry", () => {
  const isolated = new DatabaseSync(":memory:");
  try {
    isolated.exec("CREATE TABLE doc_vault (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)");
    isolated.prepare("INSERT INTO doc_vault VALUES (?, ?)").run("a", JSON.stringify({ value: oldLogin }));
    isolated.prepare("INSERT INTO doc_vault VALUES (?, ?)").run("b", JSON.stringify({ value: "perry:credential:v99:broken" }));
    assert.throws(() => migrateCredentialDatabase(isolated));
    assert.equal(JSON.parse(isolated.prepare("SELECT doc FROM doc_vault WHERE _id='a'").get()!.doc as string).value, oldLogin);
    isolated.exec("DELETE FROM doc_vault WHERE _id='b'");
    isolated.prepare("INSERT INTO doc_vault VALUES (?, ?)").run("b", JSON.stringify({ value: oldKey }));
    isolated.exec("CREATE TRIGGER fail_second BEFORE UPDATE ON doc_vault WHEN old._id = 'b' BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END");
    assert.throws(() => migrateCredentialDatabase(isolated));
    assert.equal(JSON.parse(isolated.prepare("SELECT doc FROM doc_vault WHERE _id='a'").get()!.doc as string).value, oldLogin);
    assert(!isolated.prepare("SELECT 1 FROM sqlite_master WHERE name='_credential_encryption'").get());
  } finally { isolated.close(); }
  sql.exec("UPDATE _credential_encryption SET cleanup = 1");
  migrateCredentialDatabase(sql);
  assert.equal(sql.prepare("SELECT cleanup FROM _credential_encryption").get()!.cleanup, 0);
});
await check("encrypted backups restore and migration is repeatable", () => {
  const backup = new DatabaseSync(join(backups, "legacy.sqlite"));
  try { assert.equal(decryptCredential("secrets", JSON.parse(backup.prepare("SELECT doc FROM doc_secrets").get()!.doc as string).value), oldKey); }
  finally { backup.close(); }
  const json = JSON.parse(readFileSync(join(backups, "legacy.json"), "utf8"));
  assert.equal(decryptCredential("vault", json.tables.vault[0].value), oldLogin);
  initializeCredentialEncryption(sql, home);
});
await check("key loss refuses replacement even after all credentials removed", () => {
  const emptied = new DatabaseSync(":memory:");
  migrateCredentialDatabase(emptied);
  const keyFile = join(home, "credential-key"), hold = join(home, "key-recovery");
  renameSync(keyFile, hold);
  const saved = process.env.PERRY_CREDENTIAL_KEY;
  delete process.env.PERRY_CREDENTIAL_KEY;
  try {
    assert.throws(() => initializeCredentialEncryption(sql, home)); assert(!existsSync(keyFile));
    assert.throws(() => initializeCredentialEncryption(emptied, join(home, "empty-store")));
  } finally { emptied.close(); renameSync(hold, keyFile); process.env.PERRY_CREDENTIAL_KEY = saved; }
});
await check("invalid backup JSON errors never disclose its contents", () => {
  const file = join(backups, "invalid.json");
  writeFileSync(file, `{invalid:${nextKey}`);
  try {
    let message = "";
    try { migrateCredentialBackups(backups); } catch (error) { message = (error as Error).message; }
    assert(message.length > 0); assert(!message.includes(nextKey));
  } finally { rmSync(file); }
});
await check("unsupported backup files fail closed without replacement", () => {
  const file = join(backups, "unsupported.zip"); writeFileSync(file, "synthetic");
  try { assert.throws(() => migrateCredentialBackups(backups)); }
  finally { rmSync(file); }
});
await check("verified exact Finder metadata is preserved while nested legacy backups migrate", () => {
  const folder = join(backups, "finder-metadata");
  mkdirSync(folder);
  const metadata = join(folder, ".DS_Store"), file = join(folder, "legacy.json");
  writeFileSync(metadata, finderFixture);
  writeFileSync(file, JSON.stringify({ vault: [{ value: oldLogin }] }));
  initializeCredentialEncryption(sql, home);
  assert.deepEqual(readFileSync(metadata), finderFixture);
  assert.equal(decryptCredential("vault", JSON.parse(readFileSync(file, "utf8")).vault[0].value), oldLogin);
});
await check("disguised or malformed Finder metadata fails with a constant content-free error", () => {
  const folder = join(backups, "invalid-finder");
  mkdirSync(folder);
  const file = join(folder, ".DS_Store");
  const changed = (offset: number, value: number) => { const bytes = Buffer.from(finderFixture); bytes.writeUInt32BE(value, offset); return bytes; };
  const fixtures = [
    Buffer.from(oldLogin), Buffer.from(JSON.stringify({ secrets: [{ value: oldKey }] })),
    finderFixture.subarray(0, 8), finderFixture.subarray(0, 35),
    changed(0, 2), changed(4, 0), changed(16, 4096), changed(12, 0xffffffff),
    changed(12, 0), changed(8, 0),
  ];
  try {
    for (const fixture of fixtures) {
      writeFileSync(file, fixture);
      let message = "";
      try { initializeCredentialEncryption(sql, home); } catch (error) { message = (error as Error).message; }
      assert.equal(message, "Unrecognized Finder metadata in Perry's backups needs review before credential migration can finish.");
      assert.deepEqual(readFileSync(file), fixture);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
await check("metadata-like filenames and data-bearing metadata directories are not exempted", () => {
  const folder = join(backups, "metadata-lookalikes");
  mkdirSync(folder);
  try {
    for (const name of [".ds_store", "._DS_Store", ".DS_Store.bak", "Thumbs.db.unsupported"]) {
      const file = join(folder, name);
      writeFileSync(file, finderFixture);
      assert.throws(() => initializeCredentialEncryption(sql, home));
      assert.deepEqual(readFileSync(file), finderFixture);
      rmSync(file);
    }
    const directory = join(folder, ".DS_Store");
    mkdirSync(directory);
    const unsupported = join(directory, "unsupported.txt");
    writeFileSync(unsupported, "synthetic data");
    assert.throws(() => initializeCredentialEncryption(sql, home));
    assert.equal(readFileSync(unsupported, "utf8"), "synthetic data");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
await check("Finder metadata links still fail closed without changing their target", () => {
  const folder = join(backups, "metadata-link"), target = join(home, "metadata-link-target");
  mkdirSync(folder); mkdirSync(target);
  writeFileSync(join(target, "untouched"), "synthetic data");
  const link = join(folder, ".DS_Store");
  try {
    fs.symlinkSync(target, link, "junction");
    assert(fs.lstatSync(link).isSymbolicLink());
    assert.throws(() => initializeCredentialEncryption(sql, home));
    assert.equal(readFileSync(join(target, "untouched"), "utf8"), "synthetic data");
  } finally { rmSync(folder, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});
for (const failure of ["write", "fsync"] as const) {
  await check(`failed staging ${failure} closes and removes staging, preserves original and retries`, () => {
    const folder = join(backups, `failure-${failure}`);
    mkdirSync(folder);
    const file = join(folder, "original.json");
    const original = JSON.stringify({ vault: [{ value: oldLogin }], secrets: [{ value: oldKey }] });
    writeFileSync(file, original);
    const native = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync };
    const descriptors = new Set<number>();
    let injected = 0, closed = 0, rejected = false;
    try {
      // Inject native filesystem failures only into this exact disposable staging path.
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const fd = native.openSync(...args);
        if (typeof args[0] === "string" && args[0].startsWith(`${file}.perry-credential-`) && args[0].endsWith(".tmp")) descriptors.add(fd);
        return fd;
      }) as typeof fs.openSync;
      fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
        if (failure === "write" && typeof args[0] === "number" && descriptors.has(args[0]) && !injected) {
          injected++;
          native.writeFileSync(args[0], "{partial");
          throw new Error("synthetic staging write failure");
        }
        return native.writeFileSync(...args);
      }) as typeof fs.writeFileSync;
      fs.fsyncSync = (fd: number) => {
        if (failure === "fsync" && descriptors.has(fd) && !injected) {
          injected++; throw new Error("synthetic staging fsync failure");
        }
        return native.fsyncSync(fd);
      };
      fs.closeSync = (fd: number) => {
        if (descriptors.has(fd)) closed++;
        return native.closeSync(fd);
      };
      syncBuiltinESMExports();
      try { initializeCredentialEncryption(sql, home); } catch { rejected = true; }
    } finally {
      Object.assign(fs, native); syncBuiltinESMExports();
    }
    assert(rejected); assert.equal(injected, 1); assert.equal(closed, 1);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(readdirSync(folder), ["original.json"]);
    initializeCredentialEncryption(sql, home);
    const encrypted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(decryptCredential("vault", encrypted.vault[0].value), oldLogin);
    assert.equal(decryptCredential("secrets", encrypted.secrets[0].value), oldKey);
  });
}
await check("interrupted partial and complete staging are discarded, original is migrated", () => {
  for (const state of ["partial", "complete"]) {
    const folder = join(backups, `interrupted-${state}`);
    mkdirSync(folder);
    const file = join(folder, "original.json");
    const staging = `${file}.perry-credential-${randomBytes(16).toString("hex")}.tmp`;
    writeFileSync(file, JSON.stringify({ vault: [{ value: oldLogin }] }));
    writeFileSync(staging, state === "partial" ? "{partial" : JSON.stringify({ vault: [{ value: encryptCredential("vault", nextLogin) }] }));
    initializeCredentialEncryption(sql, home);
    assert(!existsSync(staging));
    assert.equal(decryptCredential("vault", JSON.parse(readFileSync(file, "utf8")).vault[0].value), oldLogin);
    assert.deepEqual(readdirSync(folder), ["original.json"]);
  }
});
await check("failed staging cleanup preserves original and staging until a successful retry", () => {
  const folder = join(backups, "cleanup-failure");
  mkdirSync(folder);
  const file = join(folder, "original.json");
  const original = JSON.stringify({ vault: [{ value: oldLogin }] });
  writeFileSync(file, original);
  const staging = `${file}.perry-credential-${randomBytes(16).toString("hex")}.tmp`;
  writeFileSync(staging, "{partial");
  const nativeUnlink = fs.unlinkSync;
  let rejected = false, injected = 0;
  try {
    fs.unlinkSync = (target) => {
      if (target === staging) { injected++; throw new Error("synthetic staging cleanup failure"); }
      return nativeUnlink(target);
    };
    syncBuiltinESMExports();
    try { initializeCredentialEncryption(sql, home); } catch { rejected = true; }
  } finally { fs.unlinkSync = nativeUnlink; syncBuiltinESMExports(); }
  assert(rejected); assert.equal(injected, 1);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(staging, "utf8"), "{partial");
  initializeCredentialEncryption(sql, home);
  assert(!existsSync(staging));
  assert.equal(decryptCredential("vault", JSON.parse(readFileSync(file, "utf8")).vault[0].value), oldLogin);
});
await check("orphan staging and invalid or unauthenticated originals are preserved", () => {
  const folder = join(backups, "manual-recovery");
  mkdirSync(folder);
  try {
    const file = join(folder, "original.json");
    const staging = `${file}.perry-credential-${randomBytes(16).toString("hex")}.tmp`;
    writeFileSync(staging, "{partial");
    assert.throws(() => initializeCredentialEncryption(sql, home));
    assert.equal(readFileSync(staging, "utf8"), "{partial");
    for (const original of ["{invalid", JSON.stringify({ vault: [{ value: "perry:credential:v99:broken" }] })]) {
      writeFileSync(file, original);
      assert.throws(() => initializeCredentialEncryption(sql, home));
      assert.equal(readFileSync(staging, "utf8"), "{partial");
      assert.equal(readFileSync(file, "utf8"), original);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
await check("staging directories, unrelated temporary files and legacy names are not deleted", () => {
  const folder = join(backups, "unrelated-staging");
  mkdirSync(folder);
  try {
    const file = join(folder, "original.json");
    writeFileSync(file, JSON.stringify({ vault: [{ value: oldLogin }] }));
    const stagedDirectory = `${file}.perry-credential-${randomBytes(16).toString("hex")}.tmp`;
    mkdirSync(stagedDirectory);
    assert.throws(() => initializeCredentialEncryption(sql, home));
    assert(fs.lstatSync(stagedDirectory).isDirectory());
    fs.rmdirSync(stagedDirectory);
    const unrelated = join(folder, "unrelated.tmp");
    writeFileSync(unrelated, "synthetic unrelated data");
    assert.throws(() => initializeCredentialEncryption(sql, home));
    assert.equal(readFileSync(unrelated, "utf8"), "synthetic unrelated data");
    rmSync(unrelated);
    const legacy = `${file}.${randomBytes(8).toString("hex")}.json`;
    writeFileSync(legacy, "{partial");
    assert.throws(() => initializeCredentialEncryption(sql, home));
    assert.equal(readFileSync(legacy, "utf8"), "{partial");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
await check("physical database, WAL and backup bytes have no fixture plaintext", () => {
  sql.prepare("VACUUM INTO ?").run(join(backups, "new.sqlite"));
  sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of walk(home).filter(file => !file.endsWith("credential-key"))) {
    const bytes = readFileSync(file);
    for (const fixture of [oldLogin, oldKey, nextLogin, nextKey]) assert(!bytes.includes(Buffer.from(fixture)));
  }
});
sql.close();
await check("process restart with persisted key unlocks saved logins", async () => {
  delete process.env.PERRY_CREDENTIAL_KEY;
  sql = new DatabaseSync(database);
  initializeCredentialEncryption(sql, home);
  const restarted = new Runtime(sql, schema as never, { vault, secrets }, { storageDir: join(home, "storage") });
  assert.equal((await restarted.runMutation("vault:reveal", { id: "legacy-login" }, { internal: true }) as { value: string }).value, oldLogin);
  sql.close();
});
// Verify final artifact contains only names/booleans; discard all synthetic key/data state.
const report = { issue: 251, runtime: process.versions.bun ? "bun" : "node", passed: checks.every(check => check.passed), checks };
writeFileSync(join(scratchRoot, "e2e-result.json"), JSON.stringify(report, null, 2));
rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
