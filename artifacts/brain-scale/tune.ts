import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";
import { RANKING, rankRecall, type DateRange, type RecallParts, type Ranking } from "../../convex/lib/recall";

// bun artifacts/brain-scale/tune.ts <seed home> <out.json>
//
// The weights Brain ranks with (convex/lib/recall.ts RANKING), measured rather than guessed: a Perry on a copy
// of the synthetic Brain gathers, for each labelled question, what each way of searching found (memories:recall
// with parts), once; then every combination on a small grid is ranked here with the same rankRecall, and recall
// @1/@5/@10 reported for each. Coarse on purpose: 116 questions would reward a fine grid for luck.

const [seedHome, out] = process.argv.slice(2);
const p = await perry({ name: "brain-tune", outDir: join(process.env.PERRY_E2E_DIR ?? ".", "tune-out"), runnerEnv: () => ({}), engine: null });
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(join(seedHome, `perry.sqlite${suffix}`))) copyFileSync(join(seedHome, `perry.sqlite${suffix}`), join(p.home, `perry.sqlite${suffix}`));
if (process.env.PERRY_E2E_MODELS) cpSync(process.env.PERRY_E2E_MODELS, join(p.home, "models"), { recursive: true });
const labels: Array<{ kind: string; question: string; ids: string[] }> = JSON.parse(readFileSync(join(seedHome, "labels.json"), "utf8"));
type Line = { id: string; text: string; createdAt: number; kind?: string; type?: "fact" | "preference" | "episode"; day?: string; eventAt?: number };
const gathered: Array<{ label: typeof labels[number]; parts: RecallParts; lines: Map<string, Line>; range: DateRange | null; now: number }> = [];
try {
  p.start("server");
  await p.until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "start", 900);
  await p.until(() => !(p.rows("installation")[0]?.embeddedBefore) && p.sql<{ n: number }>(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.embeddedWith') IS NULL`)[0].n < 50, "embedding", 7200);
  const chat = await p.call<string>("dashboard:createChat", { key: p.KEY });
  for (const label of labels) {
    const [found] = await p.call<Array<{ parts: RecallParts; lines: Record<string, Line>; range: DateRange | null; now: number }>>("memories:recall", { query: label.question, limit: 25, chat, parts: true });
    gathered.push({ label, parts: found.parts, lines: new Map(Object.entries(found.lines)), range: found.range, now: found.now });
  }
} finally {
  await p.finish({});
  await sleep(500);
}

writeFileSync(out.replace(/\.json$/, "-parts.json"), JSON.stringify(gathered.map((item) => ({ ...item, lines: Object.fromEntries(item.lines) }))));
const score = (ranking: Ranking) => {
  const ranks = gathered.map(({ label, parts, lines, range, now }) => {
    const rank = rankRecall(label.question, parts, lines, now, range, ranking).findIndex((line) => label.ids.includes(line.id));
    return rank < 0 ? Infinity : rank + 1;
  });
  const at = (k: number) => Math.round((1000 * ranks.filter((rank) => rank <= k).length) / ranks.length) / 10;
  return { at1: at(1), at5: at(5), at10: at(10) };
};
const results: Array<{ ranking: Ranking; recall: ReturnType<typeof score> }> = [];
for (const k of [10, 30]) for (const words of [0.6, 0.8, 1]) for (const exact of [0, 0.5, 1, 2]) for (const margin of [1, 0.05, 0.03]) for (const episodeFloor of [0.5, 0.75, 0.9]) for (const mentioned of [0.5, 1]) {
  const ranking = { ...RANKING, k, words, exact, margin, episodeFloor, mentioned };
  results.push({ ranking, recall: score(ranking) });
}
results.sort((a, b) => b.recall.at10 - a.recall.at10 || b.recall.at5 - a.recall.at5 || b.recall.at1 - a.recall.at1);
writeFileSync(out, `${JSON.stringify({ current: { ranking: RANKING, recall: score(RANKING) }, best: results.slice(0, 15), worst: results.at(-1) }, null, 2)}\n`);
console.log(JSON.stringify({ current: score(RANKING), best: results.slice(0, 5) }, null, 2));
