import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/brain-scale/lme-run.ts <lme.json> <outDir> --stage <label> [--batch 10] [--from 0] [--to 100]
//
// LongMemEval-S retrieval against Brain's own search (issue #220), for main and after each step. lme.json comes
// from longmemeval.ts (MemoryBench's loader; a fixed random sample of 100 answerable questions, seed 220).
//
// Each question's haystack goes into a fresh test Perry the way Perry stores what it writes: every session is a
// page written through brain_write's own path (notes:createForAgent, from a chat in the question's own project,
// so its lines are kept by pages.syncLines and embedded by memories.embedMissing), one line per message, "User:"
// or "Assistant:" before it. Ten questions share a Perry, each in a project of its own, so no question's search
// sees another's haystack. Once every line has a vector, the question is asked the way the recall tool asks it
// (memories:recall from a chat in that project, 20 results), and what comes back is scored: recall@5/@10/@20
// at the turn (a line that is one of the turns holding the answer, has_answer) and at the session (a line from
// an evidence session, answer_session_ids). Retrieval only: no answering model and no judge, so these numbers
// are not answer accuracy, and not comparable with the accuracy vendors publish. Fake engines only; the
// sentence model is local (PERRY_E2E_MODELS).

const args = process.argv.slice(2);
const [file, outDir] = args;
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
if (!file || !outDir) throw new Error("usage: bun artifacts/brain-scale/lme-run.ts <lme.json> <outDir> --stage <label>");
const STAGE = flag("stage") ?? "unnamed";
const BATCH = Number(flag("batch") ?? 10);
const MODELS = process.env.PERRY_E2E_MODELS ?? "";
mkdirSync(outDir, { recursive: true });

type Session = { question: string; id: string; date?: string; evidence: boolean; lines: Array<{ id: string; text: string; role: string }> };
type Question = { id: string; type: string; question: string; date?: string; answers: string[]; answerSessions: string[] };
const lme = JSON.parse(readFileSync(file, "utf8")) as { sample?: number; seed?: number; questions: Question[]; sessions: Session[] };
const FROM = Number(flag("from") ?? 0);
const TO = Number(flag("to") ?? lme.questions.length);
const questions = lme.questions.slice(FROM, TO);

type Scored = { id: string; type: string; turn: number; session: number; ms: number; lines: number; pages: number };
const scored: Scored[] = [];
const resultFile = join(outDir, "result.json");
const previous: Scored[] = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")).questions ?? [] : [];
const done = new Set(previous.map((item) => item.id));
scored.push(...previous);

const percentile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0; };
const round = (value: number) => Math.round(value * 10) / 10;
const PAGE_LIMIT = 90_000;

function summary() {
  const at = (list: Scored[], k: number, by: "turn" | "session") => round((100 * list.filter((item) => item[by] <= k).length) / Math.max(1, list.length));
  const block = (list: Scored[]) => ({
    n: list.length,
    turn: { at5: at(list, 5, "turn"), at10: at(list, 10, "turn"), at20: at(list, 20, "turn") },
    session: { at5: at(list, 5, "session"), at10: at(list, 10, "session"), at20: at(list, 20, "session") },
  });
  const types = [...new Set(scored.map((item) => item.type))].sort();
  return {
    stage: STAGE, source: "LongMemEval-S (longmemeval_s_cleaned.json) via Supermemory's MemoryBench loader", sample: lme.sample, seed: lme.seed,
    method: "each session a page via notes:createForAgent in the question's own project, one line per message; asked with memories:recall (limit 20) from a chat in that project",
    all: block(scored),
    byType: Object.fromEntries(types.map((type) => [type, block(scored.filter((item) => item.type === type))])),
    latency: { p50ms: round(percentile(scored.map((item) => item.ms), 0.5)), p95ms: round(percentile(scored.map((item) => item.ms), 0.95)) },
    linesPerQuestion: { mean: Math.round(scored.reduce((sum, item) => sum + item.lines, 0) / Math.max(1, scored.length)), min: Math.min(...scored.map((item) => item.lines)), max: Math.max(...scored.map((item) => item.lines)) },
    questions: scored,
  };
}

for (let start = 0; start < questions.length; start += BATCH) {
  const batch = questions.slice(start, start + BATCH).filter((question) => !done.has(question.id));
  if (!batch.length) continue;
  let fakeHome = "";
  const p = await perry({
    name: `lme-${STAGE}-${FROM + start}`,
    outDir: join(outDir, `batch-${FROM + start}`),
    runnerEnv: (home) => {
      fakeHome = join(home, "fake-grok");
      mkdirSync(fakeHome, { recursive: true });
      const codexHome = join(home, "codex-signed-out");
      const claudeHome = join(home, "claude-signed-out");
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(claudeHome, { recursive: true });
      return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
    },
  });
  const { KEY, call, until, sql } = p;
  if (MODELS && existsSync(MODELS)) cpSync(MODELS, join(p.home, "models"), { recursive: true });
  try {
    p.start("server");
    await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 300);
    await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
    // Each question's haystack, session by session, through brain_write's path.
    const where = new Map<string, { chat: string; lines: Map<string, { session: string; evidence: boolean; answer: boolean }>; count: number; pages: number }>();
    for (const question of batch) {
      const project = await call<string>("projects:create", { key: KEY, name: `LongMemEval ${question.id}` });
      const chat = await call<string>("dashboard:createChat", { key: KEY, projectId: project });
      const lines = new Map<string, { session: string; evidence: boolean; answer: boolean }>();
      let count = 0;
      let pages = 0;
      const answers = new Set(question.answers);
      for (const session of lme.sessions.filter((item) => item.question === question.id)) {
        // A session longer than a page holds is written as several pages.
        const parts: Array<typeof session.lines> = [[]];
        let size = 0;
        for (const line of session.lines) {
          const cost = line.text.length + 20;
          if (size + cost > PAGE_LIMIT && parts.at(-1)!.length) { parts.push([]); size = 0; }
          parts.at(-1)!.push(line);
          size += cost;
        }
        for (const [index, part] of parts.entries()) {
          const title = `Chat on ${(session.date ?? "").slice(0, 10)}${parts.length > 1 ? `, part ${index + 1}` : ""} (${session.id})`;
          const content = `${part.map((line) => `- ${line.role === "user" ? "User" : "Assistant"}: ${line.text}`).join("\n")}\n`;
          const made = await call<{ created?: { id: string }; error?: string }>("notes:createForAgent", { chat, title, content, project: "this project" });
          if (!made.created) { console.error(`${question.id} ${session.id}: ${made.error}`); continue; }
          pages++;
          const rows = sql<{ _id: string; order: number }>(`SELECT _id, json_extract(doc, '$.order') AS "order" FROM "doc_memories" WHERE json_extract(doc, '$.pageId') = ? ORDER BY json_extract(doc, '$.order')`, [made.created.id]);
          // One line per message, in order; a page that read back differently is counted as it is.
          rows.forEach((row, at) => {
            const line = part[at];
            if (line) lines.set(row._id, { session: session.id, evidence: session.evidence, answer: answers.has(line.id) });
          });
          count += rows.length;
        }
      }
      where.set(question.id, { chat, lines, count, pages });
      console.log(`${question.id}: ${count} lines in ${pages} pages`);
    }
    // Every line embedded: by the model main uses (vectorModel) or the one in use since (embeddedWith).
    const total = [...where.values()].reduce((sum, item) => sum + item.count, 0);
    const embedded = () => sql<{ n: number }>(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.kind') = 'page' AND (json_extract(doc, '$.vectorModel') IS NOT NULL OR json_extract(doc, '$.embeddedWith') IS NOT NULL)`)[0].n;
    const embedStarted = Date.now();
    await until(() => embedded() >= total, `${total} lines to be embedded`, 3600).catch(() => console.error(`only ${embedded()} of ${total} lines embedded`));
    console.log(`embedded ${embedded()} of ${total} in ${Math.round((Date.now() - embedStarted) / 1000)} s`);
    for (const question of batch) {
      const { chat, lines, count, pages } = where.get(question.id)!;
      await call("memories:recall", { query: question.question, limit: 20, chat });
      const at = performance.now();
      const hits = await call<Array<{ id: string }>>("memories:recall", { query: question.question, limit: 20, chat });
      const ms = performance.now() - at;
      const turn = hits.findIndex((hit) => lines.get(hit.id)?.answer);
      const session = hits.findIndex((hit) => lines.get(hit.id)?.evidence);
      scored.push({ id: question.id, type: question.type, turn: turn < 0 ? 99 : turn + 1, session: session < 0 ? 99 : session + 1, ms: round(ms), lines: count, pages });
    }
  } catch (error) {
    console.error(error);
  } finally {
    await p.finish({ stage: STAGE });
    await sleep(1_000);
  }
  writeFileSync(resultFile, `${JSON.stringify(summary(), null, 2)}\n`);
  const now = summary();
  console.log(`after ${scored.length}: turn@10 ${now.all.turn.at10}, session@10 ${now.all.session.at10}, p50 ${now.latency.p50ms} ms`);
}
const final = summary();
writeFileSync(resultFile, `${JSON.stringify(final, null, 2)}\n`);
console.log(JSON.stringify({ ...final, questions: undefined }, null, 2));
