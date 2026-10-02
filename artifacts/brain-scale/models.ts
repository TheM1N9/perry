import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// node artifacts/brain-scale/models.ts <seed home> <models dir> <out.json> [--lines 20000] [--only <model>] [--longmemeval <file>]
//
// Which sentence model Brain should search by meaning with (issue #220), decided by measuring rather than by
// reputation. For each candidate, on this computer's CPU, 8-bit as Perry would run it: how fast it embeds lines,
// how big it is, and recall@1/5/10 by meaning alone (exact cosine, no words) on the synthetic Brain's labelled
// questions, over every labelled answer plus `--lines` other lines of the same Brain as distractors; and, with
// --longmemeval (artifacts/brain-scale/longmemeval.ts writes it), the same on LongMemEval-S turns.
//
// Candidates: the model main uses (paraphrase-multilingual-MiniLM-L12-v2), multilingual-e5-small,
// EmbeddingGemma-300m and bge-m3, each with the prefixes its card asks for.

const [seedHome, modelsDir, out] = process.argv.slice(2);
if (!seedHome || !modelsDir || !out) throw new Error("usage: node artifacts/brain-scale/models.ts <seed home> <models dir> <out.json>");
const argv = process.argv.slice(2);
const flag = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const LINES = Number(flag("lines") ?? 20000);
const ONLY = flag("only");
const LME = flag("longmemeval");

type Candidate = { id: string; query: string; passage: string; pooling: "mean" | "cls" | "gemma"; license: string };
const CANDIDATES: Candidate[] = [
  { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", query: "", passage: "", pooling: "mean", license: "Apache-2.0" },
  { id: "Xenova/multilingual-e5-small", query: "query: ", passage: "passage: ", pooling: "mean", license: "MIT" },
  { id: "onnx-community/embeddinggemma-300m-ONNX", query: "task: search result | query: ", passage: "title: none | text: ", pooling: "gemma", license: "Gemma Terms of Use" },
  { id: "Xenova/bge-m3", query: "", passage: "", pooling: "cls", license: "MIT" },
];

type Label = { kind: string; question: string; text: string; ids: string[] };
const labels: Label[] = JSON.parse((await import("node:fs")).readFileSync(join(seedHome, "labels.json"), "utf8"));
const db = new DatabaseSync(join(seedHome, "perry.sqlite"), { readOnly: true });
const all = (db.prepare(`SELECT _id AS id, json_extract(doc, '$.text') AS text FROM "doc_memories"`).all() as Array<{ id: string; text: string }>);
db.close();
// A fixed sample: every answer, and the rest picked by a seeded shuffle.
const wanted = new Set(labels.flatMap((label) => label.ids));
let state = 11;
const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
const others = all.filter((row) => !wanted.has(row.id));
for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
const corpus = [...all.filter((row) => wanted.has(row.id)), ...others.slice(0, LINES)];

type Lme = { questions: Array<{ id: string; type: string; question: string; answers: string[] }>; sessions: Array<{ question: string; lines: Array<{ id: string; text: string }> }>; lines: Array<{ id: string; text: string }> };
const lme: Lme | null = LME ? JSON.parse((await import("node:fs")).readFileSync(LME, "utf8")) : null;
if (lme) lme.lines = lme.sessions.flatMap((session) => session.lines);

const { env, pipeline, AutoModel, AutoTokenizer } = await import("@huggingface/transformers");
env.cacheDir = modelsDir;

async function embedderFor(candidate: Candidate): Promise<(texts: string[]) => Promise<number[][]>> {
  if (candidate.pooling === "gemma") {
    const tokenizer = await AutoTokenizer.from_pretrained(candidate.id);
    const model = await AutoModel.from_pretrained(candidate.id, { dtype: "q8" });
    return async (texts) => {
      const inputs = await tokenizer(texts, { padding: true, truncation: true });
      const { sentence_embedding } = await model(inputs);
      return (sentence_embedding.tolist() as number[][]).map((vector) => { const norm = Math.hypot(...vector); return vector.map((x) => x / norm); });
    };
  }
  const extractor = await pipeline("feature-extraction", candidate.id, { dtype: "q8" });
  const pooling = candidate.pooling === "cls" ? "cls" : "mean";
  return async (texts) => (await extractor(texts, { pooling, normalize: true })).tolist() as number[][];
}

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const results: Record<string, unknown> = { lines: corpus.length, labelled: labels.length, cpu: (await import("node:os")).cpus()[0]?.model };

for (const candidate of CANDIDATES) {
  if (ONLY && candidate.id !== ONLY) continue;
  console.log(`== ${candidate.id}`);
  try {
    const loadStarted = performance.now();
    const embed = await embedderFor(candidate);
    const loadMs = performance.now() - loadStarted;
    const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
    const embedAll = async (texts: string[], prefix: string) => {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 32) {
        vectors.push(...await embed(texts.slice(i, i + 32).map((text) => prefix + text)));
        if (i % 3200 === 0) console.log(`  ${i} of ${texts.length}`);
      }
      return vectors;
    };
    const started = performance.now();
    const vectors = await embedAll(corpus.map((row) => row.text), candidate.passage);
    const seconds = (performance.now() - started) / 1000;
    const queryStarted = performance.now();
    const questions = await embedAll(labels.map((label) => label.question), candidate.query);
    const queryMs = (performance.now() - queryStarted) / labels.length;
    const ranks = labels.map((label, index) => {
      const scores = vectors.map((vector, at) => ({ id: corpus[at].id, score: dot(questions[index], vector) })).sort((a, b) => b.score - a.score);
      const rank = scores.findIndex((item) => label.ids.includes(item.id));
      return { kind: label.kind, rank: rank < 0 ? Infinity : rank + 1 };
    });
    const at = (k: number, kind?: string) => { const of = ranks.filter((item) => !kind || item.kind === kind); return Math.round((1000 * of.filter((item) => item.rank <= k).length) / of.length) / 10; };
    const kinds = [...new Set(labels.map((label) => label.kind))];
    const entry: Record<string, unknown> = {
      license: candidate.license, dims: vectors[0].length, loadSeconds: Math.round(loadMs / 100) / 10, linesPerSecond: Math.round(corpus.length / seconds),
      queryMs: Math.round(queryMs), processMB: rss(),
      recall: { at1: at(1), at5: at(5), at10: at(10) },
      byKind: Object.fromEntries(kinds.map((kind) => [kind, { at1: at(1, kind), at5: at(5, kind), at10: at(10, kind) }])),
    };
    if (lme) {
      const lineVectors = await embedAll(lme.lines.map((line) => line.text), candidate.passage);
      const queryVectors = await embedAll(lme.questions.map((question) => question.question), candidate.query);
      const prefixOf = (id: string) => id.split("#")[0];
      const lmeRanks = lme.questions.map((question, index) => {
        const mine = lme.lines.map((line, at) => ({ line, at })).filter(({ line }) => prefixOf(line.id) === question.id);
        const scored = mine.map(({ line, at }) => ({ id: line.id, score: dot(queryVectors[index], lineVectors[at]) })).sort((a, b) => b.score - a.score);
        const rank = scored.findIndex((item) => question.answers.includes(item.id));
        return rank < 0 ? Infinity : rank + 1;
      });
      const lat = (k: number) => Math.round((1000 * lmeRanks.filter((rank) => rank <= k).length) / lmeRanks.length) / 10;
      entry.longmemeval = { questions: lme.questions.length, lines: lme.lines.length, at1: lat(1), at5: lat(5), at10: lat(10) };
    }
    results[candidate.id] = entry;
    console.log(JSON.stringify(entry));
  } catch (error) {
    results[candidate.id] = { error: String(error) };
    console.error(error);
  }
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
}
