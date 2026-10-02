import { readFileSync, writeFileSync } from "node:fs";

// bun artifacts/brain-scale/lme-merge.ts <out.json> <result.json>…: one LongMemEval result from several workers'
// (lme-run.ts with --from/--to), each question once, summed again the way lme-run.ts sums it.

const [out, ...inputs] = process.argv.slice(2);
type Scored = { id: string; type: string; turn: number; session: number; ms: number; lines: number; pages: number };
const parts = inputs.map((file) => JSON.parse(readFileSync(file, "utf8")));
const seen = new Map<string, Scored>();
for (const part of parts) for (const item of part.questions as Scored[]) seen.set(item.id, item);
const scored = [...seen.values()];
const round = (value: number) => Math.round(value * 10) / 10;
const percentile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0; };
const at = (list: Scored[], k: number, by: "turn" | "session") => round((100 * list.filter((item) => item[by] <= k).length) / Math.max(1, list.length));
const block = (list: Scored[]) => ({
  n: list.length,
  turn: { at5: at(list, 5, "turn"), at10: at(list, 10, "turn"), at20: at(list, 20, "turn") },
  session: { at5: at(list, 5, "session"), at10: at(list, 10, "session"), at20: at(list, 20, "session") },
});
const types = [...new Set(scored.map((item) => item.type))].sort();
const merged = {
  ...parts[0], all: block(scored), byType: Object.fromEntries(types.map((type) => [type, block(scored.filter((item) => item.type === type))])),
  latency: { p50ms: round(percentile(scored.map((item) => item.ms), 0.5)), p95ms: round(percentile(scored.map((item) => item.ms), 0.95)) },
  linesPerQuestion: { mean: Math.round(scored.reduce((sum, item) => sum + item.lines, 0) / scored.length), min: Math.min(...scored.map((item) => item.lines)), max: Math.max(...scored.map((item) => item.lines)) },
  questions: scored,
};
writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);
console.log(JSON.stringify({ ...merged, questions: undefined }, null, 2));
