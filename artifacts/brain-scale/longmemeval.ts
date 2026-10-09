import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// bun artifacts/brain-scale/longmemeval.ts <memorybench checkout> <out lme.json> [--questions 50] [--sample 100 --seed 220]
//
// LongMemEval-S (Wu et al., 2024), through Supermemory's MemoryBench (MIT): its LongMemEvalBenchmark downloads
// longmemeval_s_cleaned.json from Hugging Face into the checkout and gives each question its haystack, the ~50
// chat sessions with their dates. Retrieval only, no answering engine and no judge: what counts is whether
// Brain's search puts a turn that holds the answer (the dataset's has_answer, read from the raw file, which
// MemoryBench drops when it splits the questions) in its top k. A stratified sample of the six question types,
// abstention questions left out (they have no answer to find). With --sample, a fixed random sample instead
// (a seeded shuffle of the 470 answerable questions, the seed recorded in the file).
//
// Writes { questions: [{ id, type, question, date, answers: [line ids] }], sessions: [{ question, id, date, lines:
// [{ id, text }] }] }, which lme-seed.ts turns into a Brain, one project per question.

const [checkout, out] = process.argv.slice(2);
if (!checkout || !out) throw new Error("usage: bun artifacts/brain-scale/longmemeval.ts <memorybench checkout> <out lme.json> [--questions 50]");
const argv = process.argv.slice(2);
const option = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const SAMPLE = option("sample") ? Number(option("sample")) : 0;
const SEED = Number(option("seed") ?? 220);
const COUNT = SAMPLE || Number(option("questions") ?? 50);

process.chdir(checkout);
const modulePath = join(checkout, "src", "benchmarks", "longmemeval", "index.ts");
const { LongMemEvalBenchmark } = await import(modulePath);
const bench = new LongMemEvalBenchmark();
await bench.load();

type Raw = { question_id: string; question: string; question_type: string; question_date?: string; answer: string; answer_session_ids?: string[]; haystack_session_ids?: string[]; haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>> };
const rawPath = join(checkout, "data", "benchmarks", "longmemeval", "datasets", "longmemeval_s_cleaned.json");
if (!existsSync(rawPath)) throw new Error(`no ${rawPath}`);
const raw: Raw[] = JSON.parse(readFileSync(rawPath, "utf8"));
const byId = new Map(raw.map((item) => [item.question_id, item]));

type Question = { questionId: string; question: string; questionType: string; metadata?: { questionDate?: string } };
const all: Question[] = bench.getQuestions().filter((question: Question) => !question.questionId.endsWith("_abs"));
const types = [...new Set(all.map((question) => question.questionType))].sort();
const picked: Question[] = [];
if (SAMPLE) {
  let state = SEED >>> 0;
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pool = [...all].sort((a, b) => a.questionId.localeCompare(b.questionId));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  picked.push(...pool.slice(0, SAMPLE));
}
for (let round = 0; !SAMPLE && picked.length < COUNT; round++) {
  let added = false;
  for (const type of types) {
    const ofType = all.filter((question) => question.questionType === type).sort((a, b) => a.questionId.localeCompare(b.questionId));
    if (ofType[round] && picked.length < COUNT) { picked.push(ofType[round]); added = true; }
  }
  if (!added) break;
}

// A message is one line: its blank lines would make it several. Very long ones are cut, as a page holds 100,000 characters.
const flat = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, SAMPLE ? 20_000 : 2000);
const questions: Array<{ id: string; type: string; question: string; date?: string; answers: string[]; answerSessions: string[] }> = [];
const sessions: Array<{ question: string; id: string; date?: string; evidence: boolean; lines: Array<{ id: string; text: string; role: string }> }> = [];
for (const question of picked) {
  const item = byId.get(question.questionId)!;
  const haystack = bench.getHaystackSessions(question.questionId) as Array<{ sessionId: string; messages: Array<{ role: string; content: string }>; metadata?: { date?: string } }>;
  const answers: string[] = [];
  haystack.forEach((session, s) => {
    const lines = session.messages.map((message, t) => {
      const id = `${question.questionId}#${s}#${t}`;
      if (item.haystack_sessions[s]?.[t]?.has_answer) answers.push(id);
      return { id, role: message.role, text: SAMPLE ? flat(message.content) : flat(`${message.role === "user" ? "" : "Assistant: "}${message.content}`) };
    }).filter((line) => line.text);
    const evidence = (item.answer_session_ids ?? []).includes(item.haystack_session_ids?.[s] ?? "");
    sessions.push({ question: question.questionId, id: session.sessionId, date: session.metadata?.date, evidence, lines });
  });
  const answerSessions = sessions.filter((session) => session.question === question.questionId && session.evidence).map((session) => session.id);
  if (answers.length || answerSessions.length) questions.push({ id: question.questionId, type: question.questionType, question: question.question, date: question.metadata?.questionDate, answers, answerSessions });
}
writeFileSync(out, JSON.stringify({ source: "LongMemEval-S via MemoryBench", ...(SAMPLE ? { sample: SAMPLE, seed: SEED } : {}), questions, sessions }));
console.log(JSON.stringify({ questions: questions.length, types, sessions: sessions.length, lines: sessions.reduce((sum, session) => sum + session.lines.length, 0) }));
