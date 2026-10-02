import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/brain-scale/debug.ts <seed home> [question…]: a Perry on a copy of a seed, each labelled question's
// answer and what Brain's search, its words alone and the chat's recall return for it. For looking, not a check.
// With KEEP=<dir>, the Brain once moved and embedded again is kept there as a seed of its own, for runs that need
// not wait for the re-embedding (labels and stats copied with it).

const [seedHome, ...asked] = process.argv.slice(2);
const p = await perry({ name: "brain-debug", outDir: join(process.env.PERRY_E2E_DIR ?? ".", "debug-out"), runnerEnv: () => ({}), engine: null });
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(join(seedHome, `perry.sqlite${suffix}`))) copyFileSync(join(seedHome, `perry.sqlite${suffix}`), join(p.home, `perry.sqlite${suffix}`));
if (process.env.PERRY_E2E_MODELS) cpSync(process.env.PERRY_E2E_MODELS, join(p.home, "models"), { recursive: true });
const labels: Array<{ kind: string; question: string; text: string; ids: string[] }> = JSON.parse(readFileSync(join(seedHome, "labels.json"), "utf8"));
try {
  const server = p.start("server");
  await p.until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "start", 600);
  await p.until(() => !(p.rows("installation")[0]?.embeddedBefore) && p.sql<{ n: number }>(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.embeddedWith') IS NULL`)[0].n < 50, "embedding", 3600);
  for (const label of labels.filter((item) => !asked.length || asked.some((q) => item.question.includes(q)))) {
    const brain = await p.call<Array<{ id: string; text: string; score: number }>>("pages:search", { key: p.KEY, query: label.question, limit: 10 });
    const words = await p.call<Array<{ id: string; text: string }>>("memories:search", { query: label.question, limit: 10, everywhere: true });
    const rank = brain.findIndex((hit) => label.ids.includes(hit.id));
    const wordRank = words.findIndex((hit) => label.ids.includes(hit.id));
    console.log(`\n[${label.kind}] ${label.question}\n  answer: ${label.text}\n  brain rank ${rank + 1 || "-"}, words rank ${wordRank + 1 || "-"}`);
    for (const hit of brain.slice(0, 3)) console.log(`   ${hit.score.toFixed(4)} ${hit.text.slice(0, 100)}`);
  }
  if (process.env.KEEP) {
    p.stop(server);
    await sleep(3_000);
    mkdirSync(process.env.KEEP, { recursive: true });
    for (const file of ["perry.sqlite", "perry.sqlite-wal", "perry.sqlite-shm"]) if (existsSync(join(p.home, file))) copyFileSync(join(p.home, file), join(process.env.KEEP, file));
    for (const file of ["labels.json", "stats.json"]) copyFileSync(join(seedHome, file), join(process.env.KEEP, file));
  }
} finally {
  await p.finish({});
  await sleep(500);
}
