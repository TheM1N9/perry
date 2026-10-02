import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// bun artifacts/brain-scale/longmemeval.ts <memorybench checkout> <out lme.json> [--questions 50]
//
// LongMemEval-S (Wu et al., 2024), through Supermemory's MemoryBench (MIT): its LongMemEvalBenchmark downloads
// longmemeval_s_cleaned.json from Hugging Face into the checkout and gives each question its haystack, the ~50
// chat sessions with their dates. Retrieval only, no answering engine and no judge: what counts is whether
// Brain's search puts a turn that holds the answer (the dataset's has_answer, read from the raw file, which
// MemoryBench drops when it splits the questions) in its top k. A stratified sample of the six question types,
// abstention questions left out (they have no answer to find).
//
// Writes { questions: [{ id, type, question, date, answers: [line ids] }], sessions: [{ question, id, date, lines:
// [{ id, text }] }] }, which lme-seed.ts turns into a Brain, one project per question.

const [checkout, out] = process.argv.slice(2);
if (!checkout || !out) throw new Error("usage: bun artifacts/brain-scale/longmemeval.ts <memorybench checkout> <out lme.json> [--questions 50]");
const argv = process.argv.slice(2);
const at = argv.indexOf("--questions");
const COUNT = at >= 0 ? Number(argv[at + 1]) : 50;

process.chdir(checkout);
const modulePath = join(checkout, "src", "benchmarks", "longmemeval", "index.ts");
const { LongMemEvalBenchmark } = await import(modulePath);
const bench = new LongMemEvalBenchmark();
await bench.load();

type Raw = { question_id: string; question: string; question_type: string; question_date?: string; answer: string; haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>> };
const rawPath = join(checkout, "data", "benchmarks", "longmemeval", "datasets", "longmemeval_s_cleaned.json");
if (!existsSync(rawPath)) throw new Error(`no ${rawPath}`);
const raw: Raw[] = JSON.parse(readFileSync(rawPath, "utf8"));
const byId = new Map(raw.map((item) => [item.question_id, item]));

type Question = { questionId: string; question: string; questionType: string; metadata?: { questionDate?: string } };
const all: Question[] = bench.getQuestions().filter((question: Question) => !question.questionId.endsWith("_abs"));
const types = [...new Set(all.map((question) => question.questionType))].sort();
const picked: Question[] = [];
for (let round = 0; picked.length < COUNT; round++) {
  let added = false;
  for (const type of types) {
    const ofType = all.filter((question) => question.questionType === type).sort((a, b) => a.questionId.localeCompare(b.questionId));
    if (ofType[round] && picked.length < COUNT) { picked.push(ofType[round]); added = true; }
  }
  if (!added) break;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 2000);
const questions: Array<{ id: string; type: string; question: string; date?: string; answers: string[] }> = [];
const sessions: Array<{ question: string; id: string; date?: string; lines: Array<{ id: string; text: string }> }> = [];
for (const question of picked) {
  const item = byId.get(question.questionId)!;
  const haystack = bench.getHaystackSessions(question.questionId) as Array<{ sessionId: string; messages: Array<{ role: string; content: string }>; metadata?: { date?: string } }>;
  const answers: string[] = [];
  haystack.forEach((session, s) => {
    const lines = session.messages.map((message, t) => {
      const id = `${question.questionId}#${s}#${t}`;
      if (item.haystack_sessions[s]?.[t]?.has_answer) answers.push(id);
      return { id, text: flat(`${message.role === "user" ? "" : "Assistant: "}${message.content}`) };
    }).filter((line) => line.text);
    sessions.push({ question: question.questionId, id: session.sessionId, date: session.metadata?.date, lines });
  });
  if (answers.length) questions.push({ id: question.questionId, type: question.questionType, question: question.question, date: question.metadata?.questionDate, answers });
}
writeFileSync(out, JSON.stringify({ source: "LongMemEval-S via MemoryBench", questions, sessions }));
console.log(JSON.stringify({ questions: questions.length, types, sessions: sessions.length, lines: sessions.reduce((sum, session) => sum + session.lines.length, 0) }));
