// Synthetic E2E stimulus only; no application startup or user data.
import fs from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = resolve(".batch-work/batch-2/coordinator/ui");
const fixture = JSON.parse(fs.readFileSync(join(root, "fixture.json"), "utf8"));
const within = relative(root, resolve(fixture.home));
if (!within || within.startsWith("..") || isAbsolute(within) || fixture.token !== "batch-ui-fake-runner") throw Error("Disposable batch2 fixture required");
const sql = new DatabaseSync(join(fixture.home, "fixture.sqlite"));
try {
  const id = fixture.messageIds[198];
  const row = sql.prepare('SELECT doc FROM doc_agentMessages WHERE _id = ?').get(id);
  const doc = JSON.parse(row.doc);
  doc.text = "Changed fixture message 199";
  doc.message.content = doc.text;
  sql.prepare('UPDATE doc_agentMessages SET doc = ? WHERE _id = ?').run(JSON.stringify(doc), id);
} finally { sql.close(); }
// A normal authenticated mutation emits the conversation dependency of the
// message query. The changed row is then read through production BackendClient.
const result = await fetch("http://127.0.0.1:17484/api/backend/call", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "dashboard:setChatPinned", args: { key: "batch-ui-synthetic", id: fixture.conversationId, pinned: true } }) });
if (!result.ok) throw Error(await result.text());
console.log("Changed one synthetic row and invalidated its production query.");
