// node artifacts/brain-scale/sqlite-batch.cjs <perry.sqlite> <items.json>
// Inserts many documents into Perry's SQLite store in one transaction, as an older Perry left them: each item is
// [table, id, creationTime, doc]. Run through Node, as the harness's sql() is (Bun has no node:sqlite); the server's
// triggers keep the word index in step.
const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 20000");
const items = JSON.parse(readFileSync(process.argv[3], "utf8"));
const ids = db.prepare('INSERT INTO "_ids" (id, tbl) VALUES (?, ?)');
const docs = {};
db.exec("BEGIN IMMEDIATE");
try {
  for (const [table, id, at, doc] of items) {
    ids.run(id, table);
    docs[table] ??= db.prepare('INSERT INTO "doc_' + table + '" (_id, _creationTime, doc) VALUES (?, ?, ?)');
    docs[table].run(id, at, JSON.stringify(doc));
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
process.stdout.write(String(items.length));
