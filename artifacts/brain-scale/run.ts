import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/brain-scale/run.ts <outDir> --seed <seed home> --stage <label> [--checks]
//
// Issue #220: Brain holding up after years of heavy use. A Perry from the production build (`pnpm build` first)
// on a spare port, its PERRY_HOME in PERRY_E2E_DIR (W:\perry-tests\brain-scale on the owner's machine), started on
// a copy of a synthetic three-year Brain (generate.ts: ~100,000 lines, as Perry at main 34628c4 leaves them,
// vectors inside the rows). Fake engines only: Grok is the fake ACP agent (artifacts/engine-acp/fake-agent.ts);
// Codex and Claude Code are signed out in homes of their own. The sentence models come from PERRY_E2E_MODELS.
//
// It measures, for the stage it is run on (main, then each step):
//   - how long the server takes to start on the Brain (migrations included) and to be searchable by meaning;
//   - search latency, p50 and p95, over the labelled questions (Brain's search, and recall as a chat's tools do);
//   - recall@1, @5 and @10 over the labelled questions, overall and by kind (words, meaning, languages, latest,
//     person);
//   - how long a remember into Things to remember takes (a page of thousands of lines);
//   - what a turn is sent: the size of the instructions and the recalled block, per engine once budgets are per
//     engine;
//   - the server's memory (working set of its process tree) after searching.
// With --checks it also runs the checks of the steps that have landed (below), and writes screenshots.
//
// Ways it could fail, written down before the checks.
// Step 1, storage and index:
//   1. The move of vectors out of the rows loses one (a line no longer found by meaning), keeps a stale one (a vector
//      for words since edited), breaks on a malformed vector (one that is not 384 floats), or is not idempotent
//      (a second start moves or rewrites anything again).
//   2. The word index misses lines: those written before it existed, those an older Perry writes after a downgrade,
//      edits (old words still found, new ones not), deletions (a deleted line still found), or lines of a page saved
//      whole; or it finds a word only as a whole word when the last one is still being typed.
//   3. Search returns superseded lines, lines a chat may not see (another project, another chat, a chat with someone
//      else), or ranks a thin word match ("I", "my") over a real one.
//   4. Re-embedding with a new model stops search by meaning while it runs, starts over after a restart instead of
//      resuming, never finishes, or mixes vectors of two models in one comparison.
//   5. Latency or memory grows with the Brain: search past a few hundred ms at 100,000 lines, or the server holding
//      every vector as JSON.
//   6. A query in Hindi or Telugu finds nothing in English, or the other way round.
//   7. Dates in a question ("in March 2025", "last week") are ignored, or a date filter drops the answer.
//   8. The database is no longer one SQLite file in PERRY_HOME, or an older Perry cannot open it.
// Step 2, budget per engine:
//   9. A turn is still capped at 32,000 characters, or goes past the engine's share of its context window.
//  10. About me is cut, or a big pinned section is dropped without a word: Perry must be told what was condensed and
//      how to read the rest.
//  11. The pinned block changes from turn to turn when nothing pinned changed (no prompt caching), or the lines that
//      match the message are left out when their section was condensed.
//  12. A section summary goes stale and is never written again, or a missing summary loses the section.
// Step 3, compaction with the owner's approval:
//  13. A proposal changes Brain before the owner says yes; a decline changes anything; an edit is not what is applied.
//  14. Applying loses a line's history (originals deleted, not kept), or undo does not bring back the lines as they
//      were, with their ids, or leaves the merged line behind.
//  15. The proposal does not reach Needs you or the phone, expires in minutes like a command approval, or a second
//      run proposes the same thing again while one is waiting.
//  16. Journal rollups lose days, or merge near-duplicates that say different things.
// Step 4, archive after three months unused:
//  17. A line used in the last three months is archived; About me or an owner-pinned line is archived.
//  18. An archived line is still sent with turns or found by normal search; or deep search does not find it.
//  19. Using an archived line (recalled into a turn, cited, opened) does not bring it back.
//  20. The archive cannot be seen or restored in Brain, or the setting does not change the age.
//  21. The archive pass runs on every start and rewrites rows, or past expires_at lines are not archived.
// Step 5, big pages:
//  22. A section past the threshold is not split, or the split loses lines, their ids, sections or provenance.
//  23. remember writes into the old section instead of the sub-page, or the parent page no longer links to it.
//  24. A pinned section's sub-page is no longer loaded, or is loaded twice.
//  25. Splitting runs again on every save.

const args = process.argv.slice(2);
const outDir = args[0];
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const seedHome = flag("seed");
const stage = flag("stage") ?? "unnamed";
if (!outDir || !seedHome) throw new Error("usage: bun artifacts/brain-scale/run.ts <outDir> --seed <seed home> --stage <label> [--checks]");
mkdirSync(outDir, { recursive: true });
const MODELS = process.env.PERRY_E2E_MODELS ?? "";

type Label = { kind: string; question: string; text?: string; ids: string[]; project?: string };
// The synthetic Brain's questions, or LongMemEval-S's (lme-seed.ts), each asked from a chat in its question's project.
const LME = existsSync(join(seedHome, "lme-labels.json"));
const labels: Label[] = JSON.parse(readFileSync(join(seedHome, LME ? "lme-labels.json" : "labels.json"), "utf8"));
const stats = JSON.parse(readFileSync(join(seedHome, "stats.json"), "utf8"));

let fakeHome = "";
const p = await perry({
  name: `brain-scale-${stage}`,
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "signed in for the test");
    const codexHome = join(home, "codex-signed-out");
    const claudeHome = join(home, "claude-signed-out");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    return {
      PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome,
      CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "",
    };
  },
});
const { KEY, call, check, notes, until } = p;

// The Brain, as main left it, and the models.
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(join(seedHome, `perry.sqlite${suffix}`))) copyFileSync(join(seedHome, `perry.sqlite${suffix}`), join(p.home, `perry.sqlite${suffix}`));
if (MODELS && existsSync(MODELS)) cpSync(MODELS, join(p.home, "models"), { recursive: true });

const percentile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };
const round = (value: number) => Math.round(value * 10) / 10;

/** The working set of a process and its children, in MB. */
function memoryOf(pid: number): number {
  if (process.platform !== "win32") {
    const ps = spawnSync("ps", ["-o", "rss=", "--ppid", String(pid), "-p", String(pid)], { encoding: "utf8" });
    return Math.round(ps.stdout.split("\n").map(Number).filter(Boolean).reduce((a, b) => a + b, 0) / 1024);
  }
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize; $ids = @(${pid}); $grew = $true; while ($grew) { $grew = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $grew = $true } } }; ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object -Property WorkingSetSize -Sum).Sum`;
  const ran = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  return Math.round(Number(ran.stdout.trim()) / 1024 / 1024);
}

type Hit = { id: string; text: string; score: number };
const result: Record<string, unknown> = { stage, seed: stats };

try {
  const started = Date.now();
  const server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 900);
  result.startSeconds = round((Date.now() - started) / 1000);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // Search by meaning is ready once a question that shares no word with its answer finds it.
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  const chats = new Map<string, string>();
  const chatFor = async (label: Label) => {
    if (!label.project) return chat;
    if (!chats.has(label.project)) chats.set(label.project, await call<string>("dashboard:createChat", { key: KEY, projectId: label.project }));
    return chats.get(label.project)!;
  };
  const readyStarted = Date.now();
  if (!LME) {
    const probe = labels.find((label) => label.kind === "meaning")!;
    await until(async () => {
      const hits = await call<Hit[]>("pages:search", { key: KEY, query: probe.question, limit: 25 });
      return hits.some((hit) => probe.ids.includes(hit.id));
    }, "search by meaning", 900).catch(() => { notes.meaningNeverReady = true; });
  } else {
    // The model is loaded once a search by meaning has anything to compare with.
    await call("memories:recall", { query: labels[0].question, limit: 5, chat: await chatFor(labels[0]) });
    await sleep(20_000);
  }
  result.meaningReadySeconds = round((Date.now() - readyStarted) / 1000);

  // Latency and recall, Brain's search (everywhere) and a chat's recall.
  const measure = async (name: string, search: (label: Label) => Promise<Hit[]>) => {
    for (const label of labels.slice(0, 5)) await search(label);
    const times: number[] = [];
    const ranks: Array<{ kind: string; rank: number }> = [];
    for (const label of labels) {
      const at = performance.now();
      const hits = await search(label);
      times.push(performance.now() - at);
      const rank = hits.findIndex((hit) => label.ids.includes(hit.id));
      ranks.push({ kind: label.kind, rank: rank < 0 ? Infinity : rank + 1 });
      if (ranks.length % 20 === 0) console.log(`${name}: ${ranks.length} of ${labels.length}, last ${Math.round(times.at(-1)!)} ms`);
    }
    const recallAt = (k: number, kind?: string) => { const of = ranks.filter((item) => !kind || item.kind === kind); return round((100 * of.filter((item) => item.rank <= k).length) / of.length); };
    const kinds = [...new Set(labels.map((label) => label.kind))];
    return {
      p50ms: round(percentile(times, 0.5)), p95ms: round(percentile(times, 0.95)), maxms: round(Math.max(...times)),
      recall: { at1: recallAt(1), at5: recallAt(5), at10: recallAt(10) },
      byKind: Object.fromEntries(kinds.map((kind) => [kind, { n: ranks.filter((item) => item.kind === kind).length, at1: recallAt(1, kind), at5: recallAt(5, kind), at10: recallAt(10, kind) }])),
      missed: labels.filter((_, index) => ranks[index].rank > 10).map((label) => `${label.kind}: ${label.question}`),
    };
  };
  if (!LME) result.brainSearch = await measure("brain", (label) => call<Hit[]>("pages:search", { key: KEY, query: label.question, limit: 10 }));
  result.chatRecall = await measure("recall", async (label) => call<Hit[]>("memories:recall", { query: label.question, limit: 10, chat: await chatFor(label) }));

  // A remember into Things to remember, a page of thousands of lines.
  const writes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const at = performance.now();
    await call("memories:add", { text: `Test fact number ${i} for the write timing, ${Date.now()}.`, tags: [], source: "test", kind: "core", section: "Other" });
    writes.push(performance.now() - at);
  }
  result.rememberMs = { p50: round(percentile(writes, 0.5)), max: round(Math.max(...writes)) };

  // What a turn is sent.
  const context = await call<{ instructions: string; recalled: string }>("memories:context", { query: "what should I cook for Amma this weekend?", chat });
  result.turn = { instructionsChars: context.instructions.length, recalledChars: context.recalled.length, totalChars: context.instructions.length + context.recalled.length };

  result.serverMemoryMB = memoryOf(server.pid!);
  writeFileSync(join(outDir, "measure.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  check("measured", true);
} catch (error) {
  console.error(error);
  notes.error = String(error);
  check("measured", false);
} finally {
  notes.serverLog = p.logs.server.split("\n").filter(Boolean).slice(-40);
  await p.finish(result);
  await sleep(500);
}
