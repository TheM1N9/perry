import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

type Hit = { id: string; text: string; score: number; pageId?: string; page?: { id: string; title: string } };
const result: Record<string, unknown> = { stage, seed: stats };
const CHECKS = Number(flag("checks") ?? 0);
const { sql, rows } = p;
const backups = () => (existsSync(join(p.home, "backups")) ? readdirSync(join(p.home, "backups")) : []).filter((name) => name.startsWith("perry-before-brain-index"));
const count = (statement: string, params: Array<string | number> = []) => sql<{ n: number }>(statement, params)[0]?.n ?? 0;

let server: ReturnType<typeof p.start> | null = null;
async function startServer() {
  const started = Date.now();
  server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 900);
  return round((Date.now() - started) / 1000);
}
async function restart() {
  p.stop(server);
  await sleep(3_000);
  return await startServer();
}
const searchFor = (query: string, chat?: string) => chat ? call<Hit[]>("memories:recall", { query, limit: 10, chat }) : call<Hit[]>("pages:search", { key: KEY, query, limit: 10 });
const found = async (query: string, id: string, chat?: string) => (await searchFor(query, chat)).some((hit) => hit.id === id);

try {
  // What the seed holds, as main left it: vectors inside the rows.
  const seeded = CHECKS >= 1 && !flag("only") ? count(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.vector') IS NOT NULL`) : 0;
  result.startSeconds = await startServer();
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  const chat = await call<string>("dashboard:createChat", { key: KEY });
  const chats = new Map<string, string>();
  const chatFor = async (label: Label) => {
    if (!label.project) return chat;
    if (!chats.has(label.project)) chats.set(label.project, await call<string>("dashboard:createChat", { key: KEY, projectId: label.project }));
    return chats.get(label.project)!;
  };

  // --only <n>: the checks of one step alone (on a seed already brought up to date, say).
  const ONLY = flag("only") ? Number(flag("only")) : 0;
  const stepOn = (n: number) => (ONLY ? ONLY === n : CHECKS >= n);
  if (stepOn(1)) {
    // --- Step 1: the move out of the rows, after a backup, once ------------------------------------------------------
    const left = count(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.vector') IS NOT NULL OR json_extract(doc, '$.vectorModel') IS NOT NULL`);
    const indexed = count(`SELECT count(*) AS n FROM "_vector_memories_by_embedding"`);
    const backedUp = backups();
    const inBackup = backedUp.length ? spawnSync("node", ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(String(db.prepare("SELECT count(*) AS n FROM doc_memories WHERE json_extract(doc, '$.vector') IS NOT NULL").get().n));`, join(p.home, "backups", backedUp[0])], { encoding: "utf8" }).stdout : "0";
    check("1. a backup of the whole database is written before the move, with every row as it was", backedUp.length === 1 && Number(inBackup) === seeded, { backups: backedUp, seeded, inBackup: Number(inBackup) });
    check("1. every vector moved out of its row into the vector index, none left inside a row", left === 0 && indexed >= seeded - 5 && seeded > 0, { left, indexed, seeded });
    const sample = sql<{ _id: string; doc: string }>(`SELECT _id, doc FROM "doc_memories" ORDER BY _id LIMIT 200`);
    result.restartSeconds = await restart();
    const again = sql<{ _id: string; doc: string }>(`SELECT _id, doc FROM "doc_memories" ORDER BY _id LIMIT 200`);
    const unchanged = again.length === sample.length && sample.every((row, index) => again[index]._id === row._id && JSON.parse(again[index].doc).text === JSON.parse(row.doc).text && !JSON.parse(again[index].doc).vector);
    const moves = (p.logs.server.match(/moved \d+ vectors/g) ?? []).length;
    check("1. a second start moves nothing and writes no second backup", backups().length === 1 && unchanged && moves === 1, { backups: backups().length, moves });

    // --- Step 1: the word index keeps up with every way a line changes ------------------------------------------------
    const word = `zebracorn${Date.now() % 100000}`;
    const added = await call<{ id: string }>("memories:add", { text: `The ${word} lamp is in the attic, behind the blue trunk.`, tags: [], source: "test", kind: "core", section: "Home" });
    check("2. a line written now is found by its words at once", await found(word, added.id), { id: added.id });
    check("2. the last word, still being typed, is found as a prefix", await found(word.slice(0, -3), added.id));
    await call("memories:edit", { id: added.id, text: `The quokkalamp${word.slice(9)} lamp is in the garage now.` });
    check("2. an edit: the old words no longer find it, the new ones do", !(await found(word, added.id)) && await found(`quokkalamp${word.slice(9)}`, added.id));
    await call("memories:removeMany", { ids: [added.id] });
    check("2. a deleted line is not found", !(await found(`quokkalamp${word.slice(9)}`, added.id)));
    // An older Perry, or any other process, writing a row straight into SQLite: the triggers index it.
    const outside = `seedout${Date.now().toString(36)}`;
    sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, 'memories')`, [outside]);
    sql(`INSERT INTO "doc_memories" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [outside, Date.now(), JSON.stringify({ text: `Wrote the narwhalfig plan straight into SQLite.`, tags: [], source: "test", kind: "core", createdAt: Date.now() })]);
    check("2. a row another process writes is found by its words", await found("narwhalfig", outside));
    // A Perry from before the index, which had no triggers: the rows it wrote are indexed when this one starts.
    for (const trigger of ["ai", "au", "ad"]) sql(`DROP TRIGGER IF EXISTS "_search_memories_search_text_${trigger}"`);
    const before = `seedold${Date.now().toString(36)}`;
    sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, 'memories')`, [before]);
    sql(`INSERT INTO "doc_memories" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [before, Date.now(), JSON.stringify({ text: "The axolotlpie recipe came from an older Perry.", tags: [], source: "test", kind: "core", createdAt: Date.now() })]);
    await restart();
    check("2. rows written without the triggers are indexed at the next start", await found("axolotlpie", before));

    // --- Step 1: what a chat may see ------------------------------------------------------------------------------
    const projectLine = sql<{ _id: string; text: string; projectId: string }>(`SELECT _id, json_extract(doc, '$.text') AS text, json_extract(doc, '$.projectId') AS projectId FROM "doc_memories" WHERE json_extract(doc, '$.projectId') IS NOT NULL AND json_extract(doc, '$.kind') = 'page' LIMIT 1`)[0];
    if (projectLine) {
      const inProject = await call<string>("dashboard:createChat", { key: KEY, projectId: projectLine.projectId });
      const outsideHits = await searchFor(projectLine.text, chat);
      const insideHits = await searchFor(projectLine.text, inProject);
      check("3. a project's line is found from its chats and from no other", !outsideHits.some((hit) => hit.id === projectLine._id) && insideHits.some((hit) => hit.id === projectLine._id));
    }
    const fact = await call<{ id: string }>("memories:add", { text: "Our water purifier is an Aquaguard Ritz with a copper filter.", tags: [], source: "test", kind: "core", section: "Home" });
    const newer = await call<{ id: string }>("memories:add", { text: "Our water purifier is now a Kent Grand Plus with a UV lamp.", tags: [], source: "test", kind: "core", section: "Home", supersedes: [fact.id] });
    const purifier = await searchFor("which water purifier do we have");
    const vectorOfOld = count(`SELECT count(*) AS n FROM "_vector_memories_by_embedding" WHERE id = ?`, [fact.id]);
    const relation = rows("memories").find((row) => row._id === newer.id)?.relation;
    check("3. a superseded line is not found, and its vector is gone; the line that updates it is found and says so", !purifier.some((hit) => hit.id === fact.id) && purifier.some((hit) => hit.id === newer.id) && vectorOfOld === 0
      && relation?.how === "updates" && relation?.to === fact.id, { found: purifier.slice(0, 5).map((hit) => hit.text), vectorOfOld, relation });

    // --- Step 1: what a line is and when it happens ----------------------------------------------------------------
    const exam = await call<{ id: string }>("memories:add", { text: "Kavya's maths olympiad is on 14 November 2026 at Glendale.", tags: [], source: "test", kind: "daily", type: "episode", expiresAt: Date.UTC(2026, 10, 15) });
    const examRow = rows("memories").find((row) => row._id === exam.id)!;
    check("7. a line keeps its type, when what it says happens, and until when it holds", examRow.type === "episode" && new Date(examRow.eventAt).toISOString().startsWith("2026-11-14") && examRow.expiresAt === Date.UTC(2026, 10, 15), { type: examRow.type, eventAt: examRow.eventAt, expiresAt: examRow.expiresAt });

    // --- Step 1: re-embedding with the new model, in the background, resumable --------------------------------------
    const install = () => rows("installation")[0] ?? {};
    const onModel = (model: string) => count(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.embeddedWith') = ?`, [model]);
    const OLD = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
    await until(() => Boolean(install().embeddedWith), "the model in use noted", 120);
    const NEW = install().embeddedWith as string;
    result.embedModel = NEW;
    if (NEW !== OLD) {
      await until(() => install().embeddedBefore === OLD && onModel(NEW) > 500, "re-embedding under way", 600);
      const probe = labels.find((label) => label.kind === "meaning")!;
      const midway = (await searchFor(probe.question)).some((hit) => probe.ids.includes(hit.id));
      check("4. while every line is embedded again, search by meaning goes on (both models searched)", midway, { onNew: onModel(NEW), onOld: onModel(OLD) });
      const beforeRestart = onModel(NEW);
      await restart();
      await sleep(5_000);
      const afterRestart = onModel(NEW);
      // Resumed, or already done before the restart came (a small Brain): never fewer lines on the new model than before.
      check("4. re-embedding resumes after a restart rather than starting over", afterRestart >= beforeRestart && (install().embeddedBefore === OLD || onModel(OLD) === 0), { beforeRestart, afterRestart });
      const embedStarted = Date.now();
      await until(() => !install().embeddedBefore, "re-embedding to finish", 3600);
      result.reembedMinutes = round((Date.now() - embedStarted) / 60000);
      check("4. re-embedding finishes: every current line is on the new model, and the old one is no longer searched", onModel(OLD) === 0 && !install().embeddedBefore, { onNew: onModel(NEW) });
    }
    await until(() => (install().mentionsAt ?? 0) === Number.MAX_SAFE_INTEGER, "who each line mentions to be read", 900);
    const sister = await searchFor("what does my sister do these days?", chat);
    const divya = rows("notes").find((row) => row.kind === "person" && row.title === "Divya");
    check("6. a person called what the owner calls them (\"my sister\") finds what is said of them", Boolean(divya) && sister.some((hit) => hit.pageId === divya!._id || /Divya/.test(hit.text)), { top: sister.slice(0, 3).map((hit) => hit.text) });
    const files = readdirSync(p.home).filter((name) => /\.(sqlite|db)(-wal|-shm)?$/.test(name));
    check("8. Brain is still one SQLite file in Perry's home", files.every((name) => name.startsWith("perry.sqlite")), { files });
  }

  if (stepOn(2)) {
    // --- Step 2: what a message carries, per engine ---------------------------------------------------------------
    type Context = { instructions: string; recalled: string; digest: string };
    const ENGINES = ["codex", "claude", "grok", "antigravity"] as const;
    const budgetOf = (engine: string) => Math.round(Math.min(24_000, Math.max(6_000, ({ codex: 272_000, claude: 200_000, grok: 256_000, antigravity: 1_000_000 } as Record<string, number>)[engine] * 0.05)) * 3.5);
    const sizes: Record<string, unknown> = {};
    let withinAll = true;
    for (const engine of ENGINES) {
      const sent = await call<Context>("memories:context", { query: "when is the Hetzner quote from?", chat, engine });
      const pinned = sent.recalled.split("\n## From pinned sections sent condensed")[0].split("\n## Possibly relevant")[0];
      const aboutLen = sent.instructions.length;
      sizes[engine] = { instructions: sent.instructions.length, recalled: sent.recalled.length, pinned: pinned.length, budget: budgetOf(engine) };
      // About me rides with the instructions and counts against the budget; the rest of what is pinned must fit with it.
      if (pinned.length > budgetOf(engine) + 2_000 || aboutLen === 0) withinAll = false;
    }
    result.messageSizePerEngine = sizes;
    const codex = await call<Context>("memories:context", { query: "when is the Hetzner quote from?", chat, engine: "codex" });
    const pinnedOf = (engine: string) => (sizes[engine] as { pinned: number }).pinned;
    check("9. a message is sized to its engine's window, not 32,000 characters: within each engine's share, most of it used, and more on a bigger window", withinAll && pinnedOf("codex") >= 0.6 * budgetOf("codex") && pinnedOf("antigravity") > pinnedOf("codex") && pinnedOf("codex") > pinnedOf("claude"), sizes);
    const aboutPage = rows("notes").find((row) => row.kind === "about" && !row.projectId);
    const aboutLines = aboutPage ? (aboutPage.content as string).split("\n").map((line: string) => line.replace(/^[-*]\s+/, "").trim()).filter((line: string) => line && !line.startsWith("#")) : [];
    check("10. About me goes whole", aboutLines.length > 0 && aboutLines.every((line: string) => codex.instructions.includes(line)), { lines: aboutLines.length });
    check("10. big sections are sent condensed, saying so and where to read the rest", /\(condensed\)/.test(codex.recalled) && /brain_read page="[^"]+" section="[^"]+"/.test(codex.recalled));
    const again = await call<Context>("memories:context", { query: "what did Kavya eat yesterday?", chat, engine: "codex" });
    check("11. the pinned block is the same from message to message when nothing pinned changed (prompt caching)", again.digest === codex.digest);
    const matching = codex.recalled.split("## From pinned sections sent condensed")[1]?.split("\n## ")[0] ?? "";
    check("11. a line of a condensed section that bears on the message is sent with it", /Hetzner/.test(matching), { matching: matching.slice(0, 400) });
    const due = await call<{ due?: Array<{ page: string; section?: string; lines: number }> }>("pages:summarizeForAgent", {});
    const first = due.due?.find((item) => item.section);
    check("12. the sections due a summary are listed for the nightly consolidation", Boolean(first), { due: due.due?.slice(0, 5) });
    if (first) {
      const summary = `Work in short: Tidewell's clients pay net 45; ${first.lines} lines of decisions, retainers and who owns what.`;
      const saved = await call<{ saved?: unknown; error?: string }>("pages:summarizeForAgent", { page: first.page, section: first.section, text: summary });
      const after = await call<Context>("memories:context", { query: "when is the Hetzner quote from?", chat, engine: "codex" });
      check("12. a written summary is what its section is sent as, and changes the pinned block once", Boolean(saved.saved) && after.recalled.includes(summary.slice(0, 40)) && after.digest !== codex.digest);
    }
    await call("pages:writeLately", { text: "Lately: Kavya's olympiad prep, the Hetzner move at Tidewell, Amma's knee physio twice a week." });
    const lately = await call<Context>("memories:context", { query: "anything new?", chat, engine: "codex" });
    const latelyAt = lately.recalled.indexOf("## Lately");
    const rememberAt = lately.recalled.indexOf("## Things to remember");
    check("12. the Lately page comes right after About me, before Things to remember", latelyAt >= 0 && (rememberAt < 0 || latelyAt < rememberAt));
  }

  // --- Measurements ------------------------------------------------------------------------------------------------
  // Search by meaning is ready once a question that shares no word with its answer finds it.
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

  result.serverMemoryMB = memoryOf(server!.pid!);
  result.databaseMB = Math.round(statSync(join(p.home, "perry.sqlite")).size / 1024 / 1024);
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
