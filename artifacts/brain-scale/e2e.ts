import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { FAKE_AGENT, perry, REPO, sleep } from "../engine-acp/harness";
import { GUEST_TOOLS } from "../../convex/lib/engines";
import type { BrainGraph } from "../../convex/lib/graph";

// bun artifacts/brain-scale/e2e.ts <outDir> [--main <a built checkout of main>]
//
// Issue #220 (Brain at scale) with #230 part 3, end to end, on a Brain as main leaves it. Two Perrys on one PERRY_HOME
// in PERRY_E2E_DIR (W:\perry-tests\brain-220 on the owner's machine), each from its production build (`pnpm build`
// first in both): main's (--main, W:\perry-tests\wt-220-main), which writes a Brain of about 1,300 lines over two years
// and embeds it with its sentence model, then this one, which takes that Brain over. No real model turn runs: there is
// no runner while main's Perry runs; afterwards every chat is on Grok played by the fake ACP agent (artifacts/engine-acp/
// fake-agent.ts), which calls Perry's tools over MCP on "TOOL"; Codex and Claude Code are signed out in homes of their
// own, and Grok's command is the fake agent. The sentence models come from PERRY_E2E_MODELS (W:\perry-tests\brain\models):
// nothing is downloaded. No benchmark: a Brain of this size, and the few timings it takes on the way.
//
// Ways it could fail, written down before the checks.
// Taking over main's Brain (steps 1 and 2, on EmbeddingGemma):
//   1. Nothing is backed up first, or the backup misses rows; or the copy is made after something changed.
//   2. A line changes on the way: its id, words, page, section, who wrote it, when; or a vector is left inside a row.
//   3. The dashboard waits for the move or the new model: Perry is not up, or Brain does not open, until it is done.
//   4. Embedding again with the new model shows no progress, counts past the total, or never says it is done.
//   5. Stopped part-way, it starts again from nothing, backs up again, or loses the lines done; or never finishes.
//   6. While it runs, search stops: no words, and no meaning from the lines still on the model before.
//   7. Done, a line is left on the model before, the model before is still searched, or a line has no vector.
//   8. What a turn carries is still 32,000 characters, not the engine's share; About me is cut; a section too big is
//      dropped without a word; Lately is not right after About me.
// Rearranging and compaction (#230 part 3, #220 step 3), always with the owner's yes:
//   9. A proposal changes Brain before the owner answers, a decline changes anything, or a proposal never reaches
//      Needs you; the same is proposed twice.
//  10. A move, split or merge of pages loses a line's id, words, author or date; leaves it on both pages or on neither;
//      puts it on a page other chats read (a project's line on a page every chat reads); a split leaves no link, a
//      merged page is lost or a person's name no longer leads anywhere.
//  11. Condensing deletes the originals, or Undo does not bring them back as the rows they were; Undo of a move, split
//      or merge does not put each line back on its page and section, or leaves the page it made.
//  12. A chat with someone else can propose or see any of it.
// The archive (#220 step 4):
//  13. The first start archives an existing Brain wholesale (nobody kept when a line was used before), or a line past
//      the time it held until stays.
//  14. After three months unused a line stays in every turn; or a line used lately, About me, a page the owner pinned
//      or Lately is archived.
//  15. An archived line is found by normal recall or Brain's search; deep recall and "Include archive" do not find it.
//  16. Recalled from the archive, a line stays archived; Restore does not bring it back; opening a page does not count
//      as using its lines.
//  17. A chat with someone else finds the owner's archive.
// Recall at scale (#230):
//  18. One step out from recall's hits differs from the map's, or still reads the whole map, so it slows with Brain.
// What the owner sees:
//  19. The progress, the proposals in Needs you, what was changed with Undo, the archive in search, Lately: missing,
//      wrong, or throwing, in light or dark; the screenshots show the real screen or the computer's name.

const args = process.argv.slice(2);
const outDir = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--main");
if (!outDir) throw new Error("usage: bun artifacts/brain-scale/e2e.ts <outDir> [--main <checkout of main>]");
const MAIN = resolve(args.includes("--main") ? args[args.indexOf("--main") + 1] : "W:/perry-tests/wt-220-main");
if (!existsSync(join(MAIN, ".next", "BUILD_ID"))) throw new Error(`No build of main in ${MAIN}: pnpm build there first.`);
mkdirSync(outDir, { recursive: true });
const MODELS = process.env.PERRY_E2E_MODELS ?? "W:/perry-tests/brain/models";
const GEMMA = "onnx-community/embeddinggemma-300m-ONNX";
const MINILM = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

let fakeHome = "";
const p = await perry({
  name: "brain-220",
  outDir,
  engine: "grok",
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
const { KEY, BASE, call, check, notes, until, sql, rows, exchange, fakeLog } = p;
type Row = Record<string, any> & { _id: string };
const DAY = 86_400_000;
const now = Date.now();
const timings: Record<string, number> = {};
cpSync(MODELS, join(p.home, "models"), { recursive: true });

// --- Helpers --------------------------------------------------------------------------------------------------------

const log = () => fakeLog(fakeHome);
function toolAnswer(name: string, input: object): any {
  const entry = log().filter((item) => item.mcp && item.tool === name && JSON.stringify(item.args) === JSON.stringify(input)).at(-1);
  if (!entry) return undefined;
  const text = JSON.parse(entry.answer).result?.content?.[0]?.text ?? "null";
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && "untrusted" in value ? value.result : value;
  } catch {
    return { raw: text };
  }
}
async function tool(chat: string, name: string, input: object) {
  await exchange(chat, `TOOL ${name} ${JSON.stringify(input)}`);
  return toolAnswer(name, input);
}
const contextOf = (prompt: string): string => log().filter((entry) => entry.prompt === prompt).at(-1)?.context ?? "";
const id = () => `seed${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
/** Many documents at once, in one transaction (sqlite-batch.cjs). */
function insertMany(items: Array<[string, string, number, Record<string, unknown>]>) {
  const file = join(p.home, `seed-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(items));
  const ran = spawnSync("node", [join(REPO, "artifacts", "brain-scale", "sqlite-batch.cjs"), join(p.home, "perry.sqlite"), file], { encoding: "utf8", windowsHide: true });
  if (ran.status !== 0) throw new Error(`seeding: ${ran.stderr}`);
}
/** A query on another SQLite file (a backup), through Node as the harness does. */
function sqlOn<T>(file: string, statement: string): T[] {
  const ran = spawnSync("node", ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all()));`, file, statement], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (ran.status !== 0) throw new Error(`sqlite: ${ran.stderr}`);
  return JSON.parse(ran.stdout || "[]");
}
const count = (where: string) => Number(sql<{ n: number }>(`SELECT count(*) AS n FROM "doc_memories" WHERE ${where}`)[0].n);
const current = `json_extract(doc, '$.supersededBy') IS NULL`;
const install = () => rows("installation")[0] ?? {};
const note = (noteId: string) => rows("notes").find((row) => row._id === noteId);
const line = (lineId: string) => rows("memories").find((row) => row._id === lineId);
const lineOf = (text: string) => rows("memories").find((row) => row.text === text && !row.supersededBy);
const pageTitled = (title: string, kind?: string) => rows("notes").find((row) => row.title === title && (kind === undefined || row.kind === kind));
const backups = () => (existsSync(join(p.home, "backups")) ? readdirSync(join(p.home, "backups")) : []);
const serverUp = () => fetch(`${BASE}/api/backend/http/health`).then((response) => response.ok, () => false);

// Main's Perry, from its own checkout, on the same home and port; started and stopped as the harness does its own.
let mainServer: ChildProcess | null = null;
function startMain() {
  const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: p.home, PERRY_PORT: new URL(BASE).port, DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "grok" };
  for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
  mainServer = spawn("node", [join(MAIN, "node_modules", "next", "dist", "bin", "next"), "start", "-p", new URL(BASE).port], { cwd: MAIN, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  mainServer.stdout?.on("data", (chunk: Buffer) => { out += chunk; });
  mainServer.stderr?.on("data", (chunk: Buffer) => { out += chunk; });
  return () => out;
}
let server: ReturnType<typeof p.start> | null = null;
const startServer = async () => {
  const at = Date.now();
  server = p.start("server");
  await until(serverUp, "this Perry to start", 180);
  return Date.now() - at;
};

const browserShot = async (browser: Awaited<ReturnType<typeof p.openBrowser>>, file: string) => {
  // The page alone, never the screen; the computer's name masked.
  await browser.evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = walk.nextNode());) n.nodeValue = n.nodeValue.split(${JSON.stringify(hostname())}).join("THIS-PC"); return true; })()`);
  writeFileSync(join(outDir, file), Buffer.from((await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string }).data, "base64"));
};

try {
  // === Main's Perry writes a Brain =================================================================================
  const mainLog = startMain();
  await until(serverUp, "main's Perry to start", 180);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  // The browser opens now, on main's Perry: the same address serves this one later, so its progress is photographed at once.
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, seconds = 40) => until(() => evaluate(`(() => { try { return Boolean(${test}); } catch { return false; } })()`), what, seconds);
  const go = async (path: string) => { await send("Page.navigate", { url: `${BASE}${path}` }); await sleep(1_200); };
  const scheme = async (mode: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  await call("persona:writeUser", { text: "# About Alex\n\n- Lives in Bengaluru.\n- Works at Globex as a product designer.\n", by: "owner" });
  const timezone = await call<string>("jobs:ownerTimezone");
  const dayOf = (at: number) => new Date(at).toLocaleDateString("en-CA", { timeZone: timezone });
  const kitchen = await call<string>("projects:create", { key: KEY, name: "Kitchen" });
  // A chat with someone else, with a memory of its own.
  const guestJid = "15550003333@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: guestJid, kind: "person", name: "Priya" }] });
  const priya = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: guestJid });
  const thread = await call<string>("agentStore:createThread", { userId: `whatsapp:${guestJid}`, title: "Priya" });
  const guest = await call<string>("conversations:create", { channel: "whatsapp", externalId: guestJid, threadId: thread, contactId: priya._id });

  // Memories as main keeps them before they are moved into pages: two years of journal, Things to remember, people.
  const OLD = now - 300 * DAY;
  const memory = (doc: Record<string, unknown>, at = OLD) => ({ tags: [], source: "telegram:4242", origin: "owner", createdAt: at, ...doc });
  const items: Array<[string, string, number, Record<string, unknown>]> = [];
  const put = (doc: Record<string, unknown>, at?: number) => { const key = id(); items.push(["memories", key, now, memory(doc, at)]); return key; };
  const ACTIVITIES = ["went for a run by the lake", "cooked dal and rice", "read a chapter of a novel", "fixed a bug in the design system", "called the bank about the card",
    "walked to the market", "watched a film", "cleaned the balcony", "had a long design review", "practised the guitar", "went swimming", "worked from a cafe"];
  for (let ago = 900; ago >= 1; ago--) {
    const at = now - ago * DAY;
    const day = dayOf(at);
    put({ text: `On ${day} the owner ${ACTIVITIES[ago % ACTIVITIES.length]}.`, kind: "daily", day }, at);
    put({ text: `Spent ${20 + (ago % 40)} minutes on ${ACTIVITIES[(ago * 7) % ACTIVITIES.length].split(" ").slice(-2).join(" ")} notes on ${day}.`, kind: "daily", day }, at + 1_800_000);
    if (ago % 20 === 0) put({ text: `Coffee with Juhi on ${day}, talked about books.`, kind: "daily", day, about: ["Juhi"] }, at + 3_600_000);
    else if (ago % 30 === 7) put({ text: `Datta came by on ${day} to look at the wiring.`, kind: "daily", day, about: ["Datta"] }, at + 3_600_000);
    else put({ text: `Slept ${6 + (ago % 3)} hours before ${day}.`, kind: "daily", day }, at + 7_200_000);
  }
  const goa = [
    put({ text: "Juhi and the owner started planning a Goa trip for December.", kind: "daily", day: dayOf(now - 3 * DAY), about: ["Juhi"] }, now - 3 * DAY + 5_000_000),
    put({ text: "Booked a beach shack in Palolem for the Goa trip.", kind: "daily", day: dayOf(now - 2 * DAY) }, now - 2 * DAY + 5_000_000),
  ];
  const profile = put({ text: "Always reply in British English.", kind: "profile" });
  const work = ["The owner works at Globex on the design system.", "Globex's design review is every Thursday.", "The owner's manager at Globex is Farah.",
    "Globex pays on the last working day of the month.", "The owner leads the Globex icon refresh.", "Globex's office is in Koramangala."]
    .map((text) => put({ text, kind: "core", tags: ["work"] }));
  const health = ["The owner is allergic to penicillin.", "The owner takes vitamin D on Mondays.", "The owner's dentist is Dr Rao.",
    "The owner had a check-up in March and all was fine.", "The owner's blood group is O positive."].map((text) => put({ text, kind: "core", tags: ["health"] }));
  const home = ["The owner's flat is on the 4th floor.", "The owner's gym is Cult Fit in Indiranagar.", "The owner's gym is Cult Fit, in Indiranagar.",
    "The owner keeps the spare umbrella in the car boot.", "The owner's favourite quokka mug is chipped.", "The owner's car is a blue Skoda."].map((text) => put({ text, kind: "core", tags: ["home"] }));
  const workshop = put({ text: "Datta's workshop is in Jayanagar, near the temple.", kind: "core" });
  const datta = put({ text: "Datta is the owner's electrician.", kind: "core", about: ["Datta"] });
  const juhi = put({ text: "Juhi is the owner's oldest friend.", kind: "core", about: ["Juhi"] });
  const juhiSharma = [put({ text: "Juhi Sharma works at Initech.", kind: "core", about: ["Juhi Sharma"] }), put({ text: "Juhi Sharma's birthday is on 12 March.", kind: "core", about: ["Juhi Sharma"] })];
  const cabinets = put({ text: "Kitchen cabinets are matte green.", kind: "core", projectId: kitchen }, now - 10 * DAY);
  const guestLine = put({ text: "Priya likes voice notes.", kind: "core", conversationId: guest, about: ["Priya"] });
  insertMany(items);
  const seeded = items.length;
  await call("pages:migrate", {});
  await call("pages:fixPeople", {}).catch(() => {});
  const ownPage = await call<string>("notes:create", { key: KEY, title: "Reading list", content: "- The Overstory\n- Piranesi\n" });
  await call("pages:pin", { key: KEY, id: ownPage, pinned: true });
  // Main embeds every line with its model, as it would have long ago.
  // Main's run embeds 1,600 lines at a time; it is asked again until none is left.
  await until(async () => { await call("memories:embedMissing", {}).catch(() => {}); return count(`${current} AND json_extract(doc, '$.vectorModel') IS NULL`) === 0; }, "main's Perry to embed every line", 600);
  const before = new Map(rows("memories").map((row) => [row._id, row]));
  const onMain = { lines: before.size, current: count(current), withVector: count(`json_extract(doc, '$.vectorModel') = '${MINILM}'`) };
  notes.mainBrain = { ...onMain, seeded, pages: rows("notes").length };
  p.stop(mainServer);
  await sleep(3_000);
  notes.mainLog = mainLog().split("\n").filter((text) => text.includes("[perry]")).slice(-12);

  // === This Perry takes it over ====================================================================================
  timings.startMs = await startServer();
  // Brain opens at once, while the lines are embedded again in the background.
  const opened = Date.now();
  const listed = await call<Array<{ kind: string }>>("pages:memoryPages", { key: KEY });
  timings.brainOpensMs = Date.now() - opened;
  // As soon as the lines are being embedded again: search is checked, then Perry stops part-way and starts again.
  type Progress = { model: string; before?: string; total: number; done: number; startedAt: number; finishedAt?: number } | null;
  const progress = () => call<Progress>("memories:embedProgress", { key: KEY });
  await until(async () => ((await progress())?.done ?? 0) > 0, "re-embedding to start", 300);
  const first = (await progress())!;
  // While it runs: by words, and by meaning on the lines still on the model before.
  let ways: { words: string[]; meaning: Array<{ id: string }> } | undefined;
  let asked = 0;
  await until(async () => {
    asked++;
    ways = (await call<Array<{ parts: { words: string[]; meaning: Array<{ id: string }> } }>>("memories:recall", { query: "allergic to penicillin", everywhere: true, parts: true }))[0]?.parts;
    return (ways?.meaning.length ?? 0) > 0;
  }, "search by meaning while re-embedding", 30).catch(() => {});
  const whileAsked = (await progress())!;
  check("searchWorksWhileReembedding", (ways?.words.length ?? 0) > 0 && (ways?.meaning.length ?? 0) > 0 && !whileAsked.finishedAt && first.model === GEMMA && first.before === MINILM,
    { words: ways?.words.length, meaning: ways?.meaning.length, asked, first, whileAsked });
  const atStop = (await progress())!;
  const backupsAtStop = backups().length;
  p.stop(server);
  await sleep(3_000);
  const doneAtStop = count(`json_extract(doc, '$.embeddedWith') = '${GEMMA}'`);
  timings.restartMs = await startServer();
  const resumed = (await progress())!;
  check("reembeddingResumes", atStop.done < atStop.total && doneAtStop < atStop.total && resumed.done >= doneAtStop && resumed.startedAt === first.startedAt && backups().length === backupsAtStop,
    { atStop, doneAtStop, resumed, backups: backups() });
  // Brain shows how far it is, while it goes on.
  const shown: string[] = [];
  for (const mode of ["light", "dark"] as const) {
    await scheme(mode);
    await go("/brain");
    await waitFor(`document.querySelector("[data-reembedding]")`, "Brain's progress");
    shown.push(await evaluate(`document.querySelector("[data-reembedding]")?.innerText ?? ""`) as string);
    await browserShot(browser, `reembedding-${mode}.png`);
  }
  const seen = (await progress())!;
  check("progressShown", shown.some((text) => /Updating search: [\d,]+ of [\d,]+ lines/.test(text)) && seen.total === onMain.current && seen.done <= seen.total, { shown, seen });
  // The move of the vectors, checked once it is all read: a backup first, every line as it was, none left inside a row.
  const moveBackup = backups().find((name) => name.startsWith("perry-before-brain-index-"));
  const inBackup = moveBackup ? Number(sqlOn<{ n: number }>(join(p.home, "backups", moveBackup), `SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.vectorModel') IS NOT NULL`)[0].n) : 0;
  check("migrationBacksUpFirst", Boolean(moveBackup) && inBackup === onMain.withVector && backups().length === 1, { backups: backups(), inBackup, withVector: onMain.withVector });
  const after = new Map(rows("memories").map((row) => [row._id, row]));
  const changed = [...before.values()].filter((row) => {
    const now = after.get(row._id);
    return !now || ["text", "pageId", "section", "by", "createdAt", "kind", "day", "projectId", "conversationId", "supersededBy"].some((field) => JSON.stringify(now[field] ?? null) !== JSON.stringify(row[field] ?? null));
  }).map((row) => row._id);
  const leftInRows = count(`json_extract(doc, '$.vector') IS NOT NULL OR json_extract(doc, '$.vectorModel') IS NOT NULL`);
  check("migrationKeepsEveryLine", changed.length === 0 && after.size === before.size && leftInRows === 0, { changed: changed.slice(0, 5), lines: after.size, leftInRows });
  check("dashboardUpAtOnce", timings.startMs < 60_000 && timings.brainOpensMs < 5_000 && listed.length > 0, timings);
  const reembedStarted = first.startedAt;
  await until(async () => Boolean((await progress())?.finishedAt) || !(await progress()), "re-embedding to finish", 900);
  timings.reembedMs = Date.now() - reembedStarted;
  const left = count(`${current} AND (json_extract(doc, '$.embeddedWith') IS NULL OR json_extract(doc, '$.embeddedWith') != '${GEMMA}')`);
  const vectors = Number(sql<{ n: number }>(`SELECT count(*) AS n FROM "_vector_memories_by_embedding"`)[0].n);
  check("reembeddingFinishes", left === 0 && !install().embeddedBefore && install().embeddedWith === GEMMA && vectors === count(current), { left, vectors, current: count(current), install: { embeddedWith: install().embeddedWith, embeddedBefore: install().embeddedBefore, reembedding: install().reembedding } });
  timings.linesPerSecond = Math.round(onMain.current / ((Date.now() - first.startedAt) / 1000));

  // The archive's first start archives nothing of an existing Brain: use was not kept before.
  check("firstStartArchivesNothing", count(`json_extract(doc, '$.archivedAt') IS NOT NULL`) === 0 && typeof install().archiveSince === "number", { archiveSince: install().archiveSince });

  // === Chats ===========================================================================================================
  p.start("runner");
  await until(async () => (await p.computers()).some((computer) => computer.online && computer.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok", 120);
  const general = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: general, model: "grok-fake-fast", engine: "grok" });

  // Lately, and what every turn carries (step 2).
  const lately = await tool(general, "brain_lately", { text: "Lately: planning a Goa trip with Juhi for December; Datta is redoing the kitchen wiring; design reviews at Globex every Thursday." });
  await exchange(general, "HELLO BUDGET");
  const sent = contextOf("HELLO BUDGET");
  const latelyAt = sent.indexOf("## Lately");
  const rememberAt = sent.indexOf("## Things to remember");
  const usage = await call<{ budget: number; used: number }>("pages:pinnedUsage", { key: KEY });
  const small = await call<{ about: string; standing: string; condensed: unknown[]; used: number; budget: number }>("pages:standing", { chat: general, budget: 2_000 });
  check("turnSizedToEngine", usage.budget === Math.round(256_000 * 0.05 * 3.5) && usage.budget !== 32_000 && small.about.includes("Lives in Bengaluru") && small.condensed.length > 0
    && /\(condensed\)/.test(small.standing) && /brain_read page="/.test(small.standing), { budget: usage.budget, used: usage.used, smallUsed: small.used, condensed: small.condensed.length });
  check("latelyRightAfterAboutMe", Boolean(lately?.id) && latelyAt >= 0 && rememberAt > latelyAt && note(lately.id)?.pinned === true, { lately, latelyAt, rememberAt });

  // === Rearranging and compaction, with the owner's yes ================================================================
  const remember = pageTitled("Things to remember", "remember")!;
  const juhiPage = rows("notes").find((row) => row.kind === "person" && row.person === "juhi")!;
  const juhiSharmaPage = rows("notes").find((row) => row.kind === "person" && row.person === "juhi sharma")!;
  const dattaPage = rows("notes").find((row) => row.kind === "person" && row.person === "datta")!;
  const snapshot = () => JSON.stringify({ notes: rows("notes").map((row) => [row._id, row.content]).sort(), lines: rows("memories").map((row) => [row._id, row.pageId, row.section, row.supersededBy ?? null]).sort() });
  const beforeProposals = snapshot();
  const proposed = {
    move: await tool(general, "brain_propose", { kind: "move", replaces: [workshop], to: "Datta", why: "It is about Datta." }),
    split: await tool(general, "brain_propose", { kind: "split", page: "Things to remember", replaces: work, title: "Work at Globex", why: "Work has become a subject of its own." }),
    mergePages: await tool(general, "brain_propose", { kind: "mergePages", page: juhiSharmaPage._id, to: juhiPage._id, why: "Both pages are about Juhi." }),
    topic: await tool(general, "brain_propose", { kind: "topic", replaces: goa, title: "Goa trip", with: ["Goa trip with Juhi, planned for December 2026.", "Staying at a beach shack in Palolem."], why: "The trip is spread over the journal." }),
    condense: await tool(general, "brain_propose", { kind: "condense", page: "Things to remember", replaces: health.slice(3), with: ["The owner had a check-up in March (all fine); blood group O positive."], why: "Two health lines in one." }),
  };
  const refused = {
    crossScope: await tool(general, "brain_propose", { kind: "move", replaces: [cabinets], to: "Datta", why: "Test." }),
    guest: await call<{ error?: string }>("compaction:proposeForAgent", { chat: guest, kind: "move", replaces: [workshop], with: [], to: "Datta", why: "Test." }),
    again: await tool(general, "brain_propose", { kind: "move", replaces: [workshop], to: dattaPage._id, why: "Again." }),
  };
  const merges = await call<number>("compaction:review", {});
  type Pending = { id: string; kind: string; proposal?: { kind: string; before: string[]; after: string[]; target?: { id: string; title: string }; title?: string } };
  const pending = await call<Pending[]>("approvals:pending", { key: KEY });
  const proposals = () => rows("brainProposals");
  check("proposalsWaitInNeedsYou", Object.values(proposed).every((answer) => /Waiting for the owner's OK/.test(String(answer?.proposed))) && merges >= 1
    && ["move", "split", "mergePages", "topic", "condense", "merge"].every((kind) => pending.some((item) => item.kind === "brain" && item.proposal?.kind === kind))
    && pending.find((item) => item.proposal?.kind === "move")?.proposal?.target?.title === "Datta", { proposed, merges, pending: pending.map((item) => item.proposal?.kind) });
  check("nothingChangesBeforeYes", snapshot() === beforeProposals);
  check("proposalsRefusedWhenUnsafe", /other chats|may see/.test(String(refused.crossScope?.error)) && /chat with someone else|Not from/.test(String(refused.guest?.error)) && /already waiting/.test(String(refused.again?.error))
    && !GUEST_TOOLS.includes("brain_propose" as never) && !GUEST_TOOLS.includes("brain_review" as never), refused);
  for (const mode of ["light", "dark"] as const) {
    await scheme(mode);
    await go("/inbox");
    await waitFor(`document.querySelectorAll("[data-proposal]").length >= 6`, "the proposals in Needs you");
    await evaluate(`document.querySelector('[data-proposal="move"]').scrollIntoView({ block: "start" }); true`);
    await sleep(500);
    await browserShot(browser, `proposals-${mode}.png`);
  }
  const ask = (kind: string) => pending.find((item) => item.proposal?.kind === kind)!.id;
  // Declined: nothing changes.
  const beforeDecline = snapshot();
  await call("approvals:decide", { key: KEY, id: ask("merge"), approved: false });
  await until(() => proposals().some((row) => row.kind === "merge" && row.status === "declined"), "the decline", 30);
  check("declineChangesNothing", snapshot() === beforeDecline);
  // Approved: each applied.
  for (const kind of ["move", "split", "mergePages", "topic", "condense"]) await call("approvals:decide", { key: KEY, id: ask(kind), approved: true });
  await until(() => ["move", "split", "mergePages", "topic", "condense"].every((kind) => proposals().some((row) => row.kind === kind && row.status === "applied")), "the changes to be applied", 60);
  const unchangedRow = (lineId: string) => ["text", "by", "createdAt", "origin", "about"].every((field) => JSON.stringify(line(lineId)?.[field] ?? null) === JSON.stringify(before.get(lineId)?.[field] ?? null));
  const moved = line(workshop)!;
  check("moveKeepsTheRow", moved.pageId === dattaPage._id && unchangedRow(workshop) && note(dattaPage._id)!.content.includes("workshop is in Jayanagar") && !note(remember._id)!.content.includes("workshop is in Jayanagar"));
  const splitPage = pageTitled("Work at Globex")!;
  check("splitMakesAPageAndLinks", Boolean(splitPage) && work.every((lineId) => line(lineId)?.pageId === splitPage._id && unchangedRow(lineId)) && splitPage.pinned === true
    && note(remember._id)!.content.includes(`(/brain/${splitPage._id})`) && !work.some((lineId) => note(remember._id)!.content.includes(line(lineId)!.text)), { content: splitPage?.content });
  const merged = note(juhiSharmaPage._id)!;
  await call("memories:add", { text: "Juhi Sharma moved to Pune.", tags: [], source: "test", kind: "core", about: ["Juhi Sharma"] });
  check("mergePagesKeepsRowsAndPassesOn", merged.mergedInto === juhiPage._id && /^Merged into \[Juhi\]\(\/brain\//.test(merged.content) && juhiSharma.every((lineId) => line(lineId)?.pageId === juhiPage._id && unchangedRow(lineId))
    && lineOf("Juhi Sharma moved to Pune.")?.pageId === juhiPage._id, { merged: merged.content });
  const topicPage = pageTitled("Goa trip")!;
  const topicLines = rows("memories").filter((row) => row.pageId === topicPage?._id && !row.supersededBy);
  check("topicPageGathers", Boolean(topicPage) && topicLines.some((row) => /Palolem/.test(row.text) && JSON.stringify(row.basedOn) === JSON.stringify(goa)) && goa.every((lineId) => line(lineId)?.pageId === before.get(lineId)?.pageId)
    && /## Related/.test(topicPage.content), { content: topicPage?.content });
  const condensedNew = lineOf("The owner had a check-up in March (all fine); blood group O positive.");
  check("condenseKeepsOriginals", Boolean(condensedNew) && health.slice(3).every((lineId) => line(lineId)?.supersededBy === condensedNew!._id && line(lineId)?.compactedBy), { condensedNew: condensedNew?._id });
  for (const mode of ["light", "dark"] as const) {
    await scheme(mode);
    await go("/brain");
    await waitFor(`document.querySelector('section[aria-label="Changed with your OK"]')`, "Changed with your OK");
    await evaluate(`document.querySelector('section[aria-label="Changed with your OK"]').scrollIntoView({ block: "start" }); true`);
    await sleep(500);
    await browserShot(browser, `changed-${mode}.png`);
  }
  // Undo, each.
  const views = await call<Array<{ id: string; kind: string; status: string; headline: string }>>("compaction:list", { key: KEY });
  const undone: Record<string, unknown> = {};
  for (const view of views.filter((item) => item.status === "applied")) undone[view.kind] = await call("compaction:undo", { key: KEY, id: view.id });
  const backOn = (lineId: string) => line(lineId)?.pageId === before.get(lineId)?.pageId && line(lineId)?.section === before.get(lineId)?.section && !line(lineId)?.supersededBy;
  check("undoPutsItAllBack", Object.values(undone).every((result: any) => result.undone) && [workshop, ...work, ...juhiSharma, ...health].every(backOn)
    && !pageTitled("Work at Globex") && !pageTitled("Goa trip") && !note(remember._id)!.content.includes("Work at Globex"),
    { undone, notBack: [workshop, ...work, ...juhiSharma, ...health].filter((lineId) => !backOn(lineId)), headlines: views.map((item) => item.headline) });
  check("undoKeepsMergedPageWords", note(juhiSharmaPage._id)!.content === juhiSharmaPage.content && !note(juhiSharmaPage._id)!.mergedInto && !lineOf("The owner had a check-up in March (all fine); blood group O positive."));

  // === The archive =====================================================================================================
  // A line that held only until yesterday goes at once.
  const exam = await call<{ id: string }>("memories:add", { text: "The owner has a driving test tomorrow.", tags: [], source: "test", kind: "daily", expiresAt: now - DAY });
  await call("archive:run", {});
  await until(() => Boolean(line(exam.id!)?.archivedAt) && !install().archiveCursor, "the expired line to be archived", 60).catch(() => {});
  check("expiredLineArchived", Boolean(line(exam.id!)?.archivedAt));
  // Time moves on: the archive began 200 days ago, and About me and the page the owner pinned were written long ago too.
  // A line recalled today is used; the rest of the old ones are not.
  sql(`UPDATE "doc_installation" SET doc = json_set(doc, '$.archiveSince', ?)`, [now - 200 * DAY]);
  const aboutId = pageTitled("About me", "about")!._id;
  sql(`UPDATE "doc_memories" SET doc = json_set(doc, '$.createdAt', ?) WHERE json_extract(doc, '$.pageId') IN (?, ?)`, [now - 300 * DAY, aboutId, ownPage]);
  const usedNow = await tool(general, "recall", { query: "oldest friend" });
  await call("archive:run", {});
  await until(() => !install().archiveCursor, "the archive's pass", 60);
  const umbrella = home[3];
  const quokka = home[4];
  const archivedCount = count(`json_extract(doc, '$.archivedAt') IS NOT NULL`);
  const recentDay = rows("memories").find((row) => row.day === dayOf(now - 2 * DAY) && !row.supersededBy && row.kind === "daily");
  const aboutLines = rows("memories").filter((row) => row.pageId === pageTitled("About me", "about")?._id);
  check("archivesOnlyWhatIsUnused", Boolean(line(umbrella)?.archivedAt) && Boolean(line(quokka)?.archivedAt) && usedNow?.memories?.some((item: any) => item.id === juhi) && !line(juhi)?.archivedAt
    && !recentDay?.archivedAt && aboutLines.length > 0 && aboutLines.every((row) => !row.archivedAt) && !rows("memories").some((row) => row.pageId === ownPage && row.archivedAt)
    && !rows("memories").some((row) => row.pageId === lately?.id && row.archivedAt), { archivedCount, profile: line(profile)?.pageId });
  await exchange(general, "HELLO ARCHIVE");
  const turn = contextOf("HELLO ARCHIVE");
  // About me goes with the instructions (the fake agent logs what comes after them), whole and never archived.
  const standing = await call<{ about: string; standing: string }>("pages:standing", { chat: general });
  check("archivedNotSentWithTurns", !turn.includes("spare umbrella") && turn.includes("blue Skoda") === !line(home[5])?.archivedAt && !standing.standing.includes("spare umbrella")
    && standing.about.includes("Always reply in British English") && /## Lately/.test(turn),
    { umbrella: turn.includes("spare umbrella"), skoda: turn.includes("blue Skoda"), skodaArchived: Boolean(line(home[5])?.archivedAt), size: turn.length });
  const shallow = await tool(general, "recall", { query: "spare umbrella car boot" });
  const deep = await tool(general, "recall", { query: "spare umbrella car boot", deep: true });
  check("deepRecallFindsAndRevives", !shallow?.memories?.some((item: any) => item.id === umbrella) && deep?.memories?.some((item: any) => item.id === umbrella)
    && !line(umbrella)?.archivedAt, { shallow: shallow?.note, deep: deep?.memories?.map((item: any) => item.text) });
  const guestDeep = await call<Array<{ id: string }>>("memories:recall", { query: "quokka mug chipped", chat: guest, deep: true });
  check("guestNeverSeesTheArchive", !guestDeep.some((item) => item.id === quokka) && guestDeep.every((item) => item.id === guestLine), { guestDeep: guestDeep.map((item) => item.id) });
  // Opening a page counts as using its lines.
  sql(`UPDATE "doc_memories" SET doc = json_set(doc, '$.lastUsedAt', ?) WHERE _id = ?`, [now - 10 * DAY, datta]);
  const openedAt = Date.now();
  await call("archive:opened", { key: KEY, id: dattaPage._id });
  check("openingAPageUsesItsLines", line(datta)!.lastUsedAt >= openedAt);
  // Brain's search: not found, then found with Include archive; and the archive, with Restore.
  for (const mode of ["light", "dark"] as const) {
    await scheme(mode);
    await go("/brain");
    await waitFor(`document.querySelector('input[aria-label="Search Brain"]')`, "Brain's search");
    await evaluate(`(() => { const el = document.querySelector('input[aria-label="Search Brain"]'); el.focus(); el.select(); return true; })()`);
    await send("Input.insertText", { text: "quokka mug" });
    await waitFor(`!document.querySelector('[role="status"]') && (document.querySelector('section[aria-label="Found in Brain"]') || /Nothing in Brain says that/.test(document.body.innerText))`, "the search");
    const without = await evaluate(`Boolean(document.querySelector("[data-found-archived]"))`) as boolean;
    await evaluate(`document.querySelector("#brain-deep").click(); true`);
    await waitFor(`document.querySelector("[data-found-archived]")`, "the archived line found");
    if (mode === "light") check("brainSearchIncludesArchive", !without, { without });
    await browserShot(browser, `archive-in-search-${mode}.png`);
  }
  await scheme("light");
  await go("/brain");
  await waitFor(`document.querySelector("[data-archive-toggle]")`, "the archive");
  await evaluate(`document.querySelector("[data-archive-toggle]").click(); true`);
  await waitFor(`document.querySelectorAll("[data-archived]").length > 0`, "archived lines");
  const newest = await evaluate(`document.querySelectorAll("[data-archived]").length`) as number;
  // Searched by its words: the archive is years of lines, and the list shows the newest.
  await evaluate(`(() => { const el = document.querySelector('input[aria-label="Search the archive"]'); el.focus(); return true; })()`);
  await send("Input.insertText", { text: "quokka" });
  await waitFor(`[...document.querySelectorAll("[data-archived]")].some((item) => item.innerText.includes("quokka"))`, "the archived line, searched");
  await evaluate(`document.querySelector("[data-archive-toggle]").scrollIntoView({ block: "start" }); true`);
  await sleep(400);
  await browserShot(browser, "archive-light.png");
  notes.archiveList = { newest };
  await evaluate(`(() => { const row = [...document.querySelectorAll("[data-archived]")].find((item) => item.innerText.includes("quokka")); row.querySelector("button").click(); return true; })()`);
  await until(() => !line(quokka)?.archivedAt, "Restore", 20);
  check("restoreBringsBack", !line(quokka)?.archivedAt);
  for (const mode of ["light", "dark"] as const) {
    await scheme(mode);
    await go("/brain");
    await waitFor(`[...document.querySelectorAll("a, li")].some((el) => /Lately/.test(el.innerText))`, "Lately in Brain");
    await browserShot(browser, `lately-${mode}.png`);
  }

  // === Recall at scale: one step out reads only the neighbourhood ======================================================
  const graph = await call<BrainGraph>("brainMap:graph", { key: KEY });
  const outsideProjects = (nodeId: string) => { const node = graph.nodes.find((item) => item.id === nodeId); return node && !node.projectId && node.kind !== "project" && node.kind !== "chat"; };
  const sameAsMap = [juhiPage._id, dattaPage._id, pageTitled("About me", "about")!._id, rows("notes").find((row) => row.kind === "journal" && row.day === dayOf(now - 20 * DAY))!._id].map((pageId) => {
    const local = graph.nodes.findIndex((node) => node.id === pageId);
    const fromMap = graph.edges.filter(([a, b]) => a === local || b === local).map(([a, b]) => graph.nodes[a === local ? b : a].id).filter(outsideProjects);
    return { pageId, fromMap: [...new Set(fromMap)].sort(), fromNeighbors: [] as string[] };
  });
  for (const item of sameAsMap) {
    const found = await call<{ neighbors?: Array<{ id: string; steps: number }> }>("notes:neighborsForAgent", { chat: general, id: item.pageId });
    item.fromNeighbors = (found.neighbors ?? []).filter((neighbor) => neighbor.steps === 1).map((neighbor) => neighbor.id).filter(outsideProjects).sort();
  }
  // brain_neighbors gives the 40 most tied at most: those, all of them on the map, as many as the map has up to 40.
  check("neighbourhoodMatchesTheMap", sameAsMap.every((item) => item.fromNeighbors.every((neighbor) => item.fromMap.includes(neighbor)) && item.fromNeighbors.length === Math.min(item.fromMap.length, 40)) && sameAsMap[0].fromMap.length > 0, sameAsMap.map((item) => ({ ...item, fromMap: item.fromMap.length, fromNeighbors: item.fromNeighbors.length })));
  // Two thousand more pages, each linking two others: the whole map grows, one page's neighbourhood does not.
  const extra: Array<[string, string, number, Record<string, unknown>]> = [];
  const extraIds = Array.from({ length: 2_000 }, () => id());
  extraIds.forEach((pageId, i) => {
    const content = `- [Note ${i + 1}](/brain/${extraIds[(i + 1) % extraIds.length]})\n- [Note ${i + 7}](/brain/${extraIds[(i + 7) % extraIds.length]})\n`;
    extra.push(["notes", pageId, now, { title: `Note ${i}`, content, revision: 1, search: `Note ${i}\n\n${content}`, by: "owner", createdAt: now - i * 3_600_000, updatedAt: now - i * 3_600_000 }]);
  });
  insertMany(extra);
  const time = async (work: () => Promise<unknown>) => { const at = performance.now(); await work(); return Math.round(performance.now() - at); };
  timings.wholeMapMs = await time(() => call("brainMap:graph", { key: KEY }));
  timings.neighbourhoodMs = await time(() => call("notes:relatedForRecall", { chat: general, pages: [juhiPage._id, dattaPage._id, extraIds[5]] }));
  const nearExtra = await call<{ neighbors?: Array<{ id: string }> }>("notes:neighborsForAgent", { chat: general, id: extraIds[10] });
  check("recallReadsOnlyTheNeighbourhood", timings.neighbourhoodMs < timings.wholeMapMs && JSON.stringify((nearExtra.neighbors ?? []).map((item) => item.id).sort()) === JSON.stringify([extraIds[3], extraIds[9], extraIds[11], extraIds[17]].sort()),
    { wholeMapMs: timings.wholeMapMs, neighbourhoodMs: timings.neighbourhoodMs, near: nearExtra.neighbors?.length });

  check("noPageErrors", browser.errors.length === 0, browser.errors);
  notes.timings = timings;
  notes.realModelTurns = "none: main's Perry ran no turn, and every chat of this one ran on the fake Grok agent";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  notes.serverLog = p.logs.server.split(/\r?\n/).filter(Boolean).slice(-60);
  check("completed", false);
}
if (mainServer) p.stop(mainServer);
notes.timings = timings;
process.exit(await p.finish() ? 0 : 1);
