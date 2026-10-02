import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// node artifacts/brain-scale/lme-seed.ts <lme.json> <home> [--vectors <models dir>]
//
// LongMemEval-S as a Brain (longmemeval.ts picks the questions): one project per question, so each question's
// haystack is searched only from a chat in its project; each session a journal page of that project on the
// session's day, each message a line of it. Written into <home>/perry.sqlite as Perry at main 34628c4 leaves rows
// (vectors inside them with --vectors, from main's model), with <home>/lme-labels.json mapping each question to
// the ids of the lines that hold its answer. Node, not Bun (Bun has no node:sqlite).

const [file, home] = process.argv.slice(2);
if (!file || !home) throw new Error("usage: node artifacts/brain-scale/lme-seed.ts <lme.json> <home> [--vectors <models dir>]");
const argv = process.argv.slice(2);
const at = argv.indexOf("--vectors");
const VECTORS = at >= 0 ? argv[at + 1] : undefined;
const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

type Lme = { questions: Array<{ id: string; type: string; question: string; date?: string; answers: string[] }>; sessions: Array<{ question: string; id: string; date?: string; lines: Array<{ id: string; text: string }> }> };
const lme: Lme = JSON.parse(readFileSync(file, "utf8"));
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const newId = () => { let id = ""; for (const byte of randomBytes(26)) id += ALPHABET[byte % 32]; return id; };
const journalTitle = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(/,/g, "");

mkdirSync(home, { recursive: true });
const path = join(home, "perry.sqlite");
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) rmSync(path + suffix);
const db = new DatabaseSync(path);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
db.exec(`CREATE TABLE IF NOT EXISTS _ids (id TEXT PRIMARY KEY, tbl TEXT NOT NULL) WITHOUT ROWID`);
for (const table of ["notes", "memories", "projects"]) db.exec(`CREATE TABLE IF NOT EXISTS "doc_${table}" (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, doc TEXT NOT NULL)`);
let last = 0;
const insert = (table: string, doc: Record<string, unknown>, when: number) => {
  const id = newId();
  last = when > last ? when : last + 0.001;
  db.prepare("INSERT INTO _ids (id, tbl) VALUES (?, ?)").run(id, table);
  db.prepare(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`).run(id, last, JSON.stringify(doc));
  return id;
};

type Row = { key: string; doc: Record<string, unknown>; at: number };
const rows: Row[] = [];
const projects = new Map<string, string>();
db.exec("BEGIN");
for (const question of lme.questions) projects.set(question.id, insert("projects", { name: `LongMemEval ${question.id}`, instructions: "", createdAt: 0, updatedAt: 0 }, 1));
// Sessions of a question that fall on the same day share that day's journal page.
const days = new Map<string, Array<{ id: string; text: string; at: number }>>();
for (const session of lme.sessions) {
  if (!projects.has(session.question)) continue;
  const at = session.date ? Date.parse(session.date) : Date.UTC(2023, 0, 1);
  const day = new Date(at).toISOString().slice(0, 10);
  const key = `${session.question}|${day}`;
  const list = days.get(key) ?? [];
  session.lines.forEach((line, index) => list.push({ ...line, at: at + index * 1000 }));
  days.set(key, list);
}
for (const [key, lines] of days) {
  const [question, day] = key.split("|");
  const projectId = projects.get(question)!;
  const content = `${lines.map((line) => `- ${line.text}`).join("\n")}\n`;
  const title = journalTitle(day);
  const pageId = insert("notes", { title, content, revision: 1, search: `${title}\n\n${content}`, by: "assistant", linesAt: 1, projectId, kind: "journal", day, createdAt: lines[0].at, updatedAt: lines.at(-1)!.at }, lines[0].at);
  lines.forEach((line, order) => rows.push({ key: line.id, at: line.at, doc: { text: line.text, tags: [], source: "page", createdAt: line.at, kind: "daily", pageId, order, by: "assistant", projectId, day } }));
}
if (VECTORS) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = VECTORS;
  const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  for (let i = 0; i < rows.length; i += 64) {
    const batch = rows.slice(i, i + 64);
    const vectors = (await extractor(batch.map((row) => String(row.doc.text)), { pooling: "mean", normalize: true })).tolist() as number[][];
    batch.forEach((row, index) => { row.doc.vector = Buffer.from(new Float32Array(vectors[index]).buffer).toString("base64"); row.doc.vectorModel = MODEL; });
    if (i % 6400 === 0) console.log(`vectors: ${i} of ${rows.length}`);
  }
}
const ids = new Map<string, string>();
for (const row of rows.sort((a, b) => a.at - b.at)) ids.set(row.key, insert("memories", row.doc, row.at));
db.exec("COMMIT");
db.close();
const labels = lme.questions.map((question) => ({ kind: question.type, question: question.question, project: projects.get(question.id), ids: question.answers.map((answer) => ids.get(answer)).filter(Boolean) }));
writeFileSync(join(home, "lme-labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
writeFileSync(join(home, "stats.json"), `${JSON.stringify({ source: "LongMemEval-S", questions: labels.length, lines: rows.length, pages: days.size }, null, 2)}\n`);
console.log(JSON.stringify({ questions: labels.length, lines: rows.length, pages: days.size }));
