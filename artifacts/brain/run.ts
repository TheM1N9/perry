import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";
import { GUEST_TOOLS } from "../../convex/lib/engines";

// bun artifacts/brain/run.ts <outDir>
// Issue #210: Brain, where notes and memory are one place and a memory is a line in a page. Grown step by step.
// A fresh Perry from the production build (`pnpm build` first) on a spare port, its PERRY_HOME in
// PERRY_E2E_DIR (W:\perry-tests\brain on the owner's machine), the real runner, headless Chrome. No real
// model turn runs: every chat is on Grok played by the fake ACP agent (artifacts/engine-acp/fake-agent.ts),
// which calls Perry's tools on "TOOL" and logs what each prompt was sent; Codex and Claude Code are signed out
// in homes of their own, so the run stops if any real engine is signed in. The sentence model for search by
// meaning comes from PERRY_E2E_MODELS (W:\perry-tests\brain\models), downloaded there by the first run.
//
// Ways it could fail, written down before the checks.
// Step 1, one search across memory and notes:
//   1. A note's paragraphs never become lines, so search cannot find what is inside a note; or a note from
//      before lines (an old install, an import) stays unsearchable after Perry starts.
//   2. An edit loses where a line came from: an unchanged line gets a new row, an edited line is taken for a
//      new one, a deleted line stays findable, or a line Perry added does not say Perry wrote it, from which chat.
//   3. recall finds memories but not notes, or notes but not memories, by words or by meaning.
//   4. A project's note is found from a chat outside the project; a chat with someone else finds the owner's
//      notes or memories; deleting a project takes its notes' lines with it.
//   5. Notes' lines leak into what is loaded as memory every turn (the long-term list), the Memory page's
//      list, or the memory count; or forget/supersedes deletes a note's line behind the note's back.
//   6. What a turn is sent leaves out a note paragraph that bears on the message.
//   7. Ctrl+K finds only chats and note titles: not a memory, not the words inside a note, or a hit opens
//      the wrong place.
//   8. Any page throws, in light or dark.
// Step 2, memory shown as pages:
//   9. remember puts a memory on the wrong page or section: a standing preference not in About me under "How I
//      like things done"; a fact not in Things to remember under the section named, or the one it fits; one about
//      someone else not on their page under People; a day's note not in today's journal; a project's memory not in
//      the project's Things to remember; "this chat" not in that chat's page; or a chat with someone else making a
//      People page, or its memory reaching the owner's chats.
//  10. About me is not USER.md: it starts from something else, update_user_md and the page drift apart, or
//      USER.md's history stops keeping versions.
//  11. The owner's edit in a page of memory does not change the memory: an edited line gets a new id (losing its
//      to-do link and citations), recall still finds the old words, a deleted line is still recalled, or a line
//      typed in is not a memory (no layer, no section).
//  12. Said again, a memory is saved twice instead of counted as confirmed; superseded, the old line stays in the
//      page or loses its history; a to-do's change duplicates its note instead of changing it where it stands;
//      forget leaves the line in the page; an alert is not in today's journal.
//  13. A memory written while the owner types in the same page overwrites their words, or theirs overwrites it.
//  14. Older memories, from before pages, vanish from the Memory page or from what a turn is sent.
//  15. The Memory page does not list the pages, or a page of memory can be renamed, moved or (About me, Things to
//      remember) deleted; any of it throws in light or dark.
// Step 3, pinning and the budget:
//  16. Pinned content does not reach a turn, or what is not pinned does: a person's page, an ordinary page, a
//      section that was not pinned. (Asserted on what the engine was sent, in a fresh chat each time.)
//  17. Unpinning About me or Things to remember leaves them loaded; pinning one section loads the whole page.
//  18. The budget is not kept: a big pinned page goes past it or pushes out About me or Things to remember, or what
//      is left out is not said, with where to read it.
//  19. A chat outside a project is sent the project's pinned page; a chat with someone else is sent any of it.
//  20. The pin button does not pin, or the Memory page does not show what is pinned and how much of the budget it uses.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/brain/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const MODELS = process.env.PERRY_E2E_MODELS ?? (process.env.PERRY_E2E_DIR ? join(process.env.PERRY_E2E_DIR, "models") : "");
const MODEL_DIR = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const modelReady = (dir: string) => Boolean(dir) && existsSync(join(dir, MODEL_DIR, "onnx", "model_quantized.onnx"));

let fakeHome = "";
const p = await perry({
  name: "brain",
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
const { KEY, call, check, notes, until, sql, rows, exchange, fakeLog, computers } = p;
const log = () => fakeLog(fakeHome);
type Row = Record<string, any> & { _id: string };
if (modelReady(MODELS)) cpSync(MODELS, join(p.home, "models"), { recursive: true });

/** What the engine was sent with a message: the instructions and everything ahead of the message. */
const contextOf = (prompt: string): string => log().filter((entry) => entry.prompt === prompt).at(-1)?.context ?? "";
function toolAnswer(name: string, args: object): any {
  const entry = log().filter((item) => item.mcp && item.tool === name && JSON.stringify(item.args) === JSON.stringify(args)).at(-1);
  if (!entry) return undefined;
  const text = JSON.parse(entry.answer).result?.content?.[0]?.text ?? "null";
  const value = JSON.parse(text);
  return value && typeof value === "object" && "untrusted" in value ? value.result : value;
}
async function tool(chat: string, name: string, args: object) {
  await exchange(chat, `TOOL ${name} ${JSON.stringify(args)}`);
  return toolAnswer(name, args);
}
const onGrok = (id: string) => call("dashboard:setChatModel", { key: KEY, id, model: "grok-fake-fast", engine: "grok" });
const lines = (): Row[] => rows("memories").filter((row) => row.kind === "page");
const linesOf = (page: string) => lines().filter((row) => row.pageId === page).sort((a, b) => a.order - b.order);
const noteRow = (id: string) => rows("notes").find((row) => row._id === id);
/** Insert a document as an older Perry would have left it, with its id recorded as the store does. */
function seed(table: string, doc: Record<string, unknown>, id = `seed${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`): string {
  sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, ?)`, [id, table]);
  sql(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [id, Date.now(), JSON.stringify(doc)]);
  return id;
}

let server: ReturnType<typeof p.start> | null = null;
const startServer = async () => {
  server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
};
try {
  await startServer();
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // --- 1. A note from before lines, as an older Perry left it, is indexed when Perry starts --------------------
  const now = Date.now();
  const oldNote = seed("notes", {
    title: "Old garden plan", content: "## Beds\n\n- Tomatoes by the south wall\n- Basil between them\n\nWater at dawn in July.\n",
    revision: 3, search: "Old garden plan", by: "owner", createdAt: now - 86_400_000 * 40, updatedAt: now - 86_400_000 * 30,
  });
  // And a memory from before pages: a row with no page, as every install has today.
  const oldCar = seed("memories", { text: "The owner's car is a blue Skoda.", tags: [], source: "telegram:4242", createdAt: now - 86_400_000 * 200, kind: "core", origin: "owner" });
  const beforeRestart = linesOf(oldNote).length;
  p.stop(server);
  await sleep(2_000);
  await startServer();
  const oldLines = linesOf(oldNote);
  check("oldNoteIndexedOnStart", beforeRestart === 0 && oldLines.length === 3 && oldLines[0].section === "Beds" && oldLines[2].text === "Water at dawn in July."
    && noteRow(oldNote)?.linesAt === 3 && oldLines.every((line) => line.by === "owner" && line.createdAt === now - 86_400_000 * 30),
  { beforeRestart, lines: oldLines.map((line) => ({ text: line.text, section: line.section, by: line.by })) });

  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await sleep(3_000);
  const real = (await computers()).flatMap((item) => item.engines).filter((engine) => engine.signedIn && engine.kind !== "grok").map((engine) => engine.kind);
  notes.realEnginesSignedIn = real;
  if (real.length) throw new Error(`${real.join(", ")} is signed in for the test's runner; stopping before anything reaches a real model.`);

  const general = await call<string>("dashboard:createChat", { key: KEY });
  await onGrok(general);
  await exchange(general, "Hello, this is the general chat.");
  const project = await call<string>("projects:create", { key: KEY, name: "Bathroom" });
  const inProject = await call<string>("dashboard:createChat", { key: KEY, projectId: project });
  await onGrok(inProject);
  await exchange(inProject, "Hello from the bathroom project.");

  // --- Memories and notes to find -------------------------------------------------------------------------------
  await call("memories:add", { text: "The owner is vegetarian and avoids eggs.", tags: ["food"], source: "test", kind: "core", origin: "owner" });
  await call("memories:add", { text: "Datta flies to Lisbon on 12 Oct 2026.", tags: [], source: "test", kind: "core", origin: "owner", about: ["Datta"] });
  await call("memories:add", { text: "Went for a long swim at the lake.", tags: [], source: "test", kind: "daily", origin: "owner" });
  const lisbon = await call<string>("notes:create", { key: KEY, title: "Lisbon trip", content: "Flights on Friday, TAP 1234.\n\n## Packing\n\n- Passport\n- Travel adapter\n- Sunscreen\n" });
  const tiles = await call<string>("notes:create", { key: KEY, title: "Tile choices", content: "Grey hexagon tiles GREYHEX for the floor.\n", projectId: project });

  // --- 2. Lines keep where they came from through edits ------------------------------------------------------
  const first = linesOf(lisbon);
  const id = (text: string, list = linesOf(lisbon)) => list.find((line) => line.text === text)?._id;
  const passport = id("Passport", first);
  const adapter = id("Travel adapter", first);
  const sunscreen = id("Sunscreen", first);
  const note = noteRow(lisbon)!;
  // The owner moves Sunscreen up, rewords the adapter where it stands, and deletes nothing yet.
  await call("notes:save", { key: KEY, id: lisbon, expectedRevision: note.revision, content: "Flights on Friday, TAP 1234.\n\n## Packing\n\n- Sunscreen\n- Passport\n- Travel adapter for the UK plugs\n" });
  const second = linesOf(lisbon);
  const reworded = second.find((line) => line.text === "Travel adapter for the UK plugs");
  // Then deletes the flights line.
  await call("notes:save", { key: KEY, id: lisbon, expectedRevision: noteRow(lisbon)!.revision, content: "## Packing\n\n- Sunscreen\n- Passport\n- Travel adapter for the UK plugs\n" });
  const third = linesOf(lisbon);
  // And Perry adds a line from the general chat.
  await tool(general, "update_note", { id: lisbon, mode: "append", section: "Packing", content: "- Swimsuit for the beach" });
  const fourth = linesOf(lisbon);
  const swimsuit = fourth.find((line) => line.text === "Swimsuit for the beach");
  check("linesKeepProvenance", first.length === 4 && id("Sunscreen", second) === sunscreen && id("Passport", second) === passport
    && reworded?._id === adapter && Boolean(reworded?.editedAt) && reworded?.section === "Packing"
    && second[1].text === "Sunscreen" && third.length === 3 && !third.some((line) => line.text.startsWith("Flights"))
    && swimsuit?.by === "assistant" && swimsuit?.from === general && fourth.length === 4,
  { first: first.map((line) => line.text), second: second.map((line) => [line.text, line._id === adapter || line._id === passport || line._id === sunscreen ? "kept" : "new"]), swimsuit: swimsuit && { by: swimsuit.by, from: swimsuit.from === general } });

  // --- 5. Lines are not memories: not loaded as long-term memory, not listed, not counted, not forgotten --------
  const memoryPage = await call<Row[]>("dashboard:listMemories", { key: KEY, query: "" });
  const forgot = await call<{ deleted: number; missing: string[] }>("memories:removeMany", { ids: [passport!], chat: general });
  const count = await call<number>("memories:count");
  check("linesAreNotMemories", !memoryPage.some((memory) => memory.kind === "page") && memoryPage.length === 1 && memoryPage[0].text === "The owner's car is a blue Skoda." && count === 4
    && forgot.deleted === 0 && Boolean(linesOf(lisbon).find((line) => line._id === passport)),
  { listed: memoryPage.map((memory) => memory.text), count, forgot });

  // --- The sentence model, and every line's vector -------------------------------------------------------------
  const embedded = () => rows("memories").every((row) => row.vector);
  for (let tries = 0; tries < 120 && !embedded(); tries++) {
    await call("memories:embedMissing", {}).catch(() => {});
    if (!embedded()) await sleep(5_000);
  }
  notes.allEmbedded = embedded();
  if (MODELS && !modelReady(MODELS) && modelReady(join(p.home, "models"))) cpSync(join(p.home, "models"), MODELS, { recursive: true });

  // --- 3. recall finds memories and notes, by words and by meaning ------------------------------------------
  const byWords = await tool(general, "recall", { query: "Lisbon" });
  const kinds = (answer: any) => (answer?.memories ?? []).map((item: any) => item.kind);
  const byMeaningMemory = await tool(general, "recall", { query: "what food should I not cook for the owner" });
  const byMeaningNote = await tool(general, "recall", { query: "documents I need at the airport" });
  check("recallFindsBoth", kinds(byWords).includes("core") && kinds(byWords).includes("note")
    && byWords.memories.some((item: any) => item.kind === "note" && item.note?.title === "Lisbon trip" && item.note?.link === `/notes/${lisbon}`),
  byWords?.memories?.map((item: any) => [item.kind, item.text]));
  check("recallByMeaning", notes.allEmbedded === true
    && byMeaningMemory?.memories?.[0]?.text === "The owner is vegetarian and avoids eggs."
    && (byMeaningNote?.memories ?? []).slice(0, 3).some((item: any) => item.text === "Passport"),
  { memory: byMeaningMemory?.memories?.map((item: any) => item.text), note: byMeaningNote?.memories?.map((item: any) => item.text) });

  // --- 4. Where a note may be found from -----------------------------------------------------------------------
  const outside = await tool(general, "recall", { query: "GREYHEX hexagon tiles" });
  const inside = await tool(inProject, "recall", { query: "GREYHEX hexagon tiles" });
  const jid = "15550001111@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: jid, kind: "person", name: "Datta" }] });
  const contact = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: jid });
  const thread = await call<string>("agentStore:createThread", { userId: `whatsapp:${jid}`, title: "Datta" });
  const theirs = await call<string>("conversations:create", { channel: "whatsapp", externalId: jid, threadId: thread, contactId: contact._id });
  const guest = await call<Row[]>("memories:recall", { query: "Lisbon passport vegetarian GREYHEX", limit: 25, chat: theirs });
  const guestEmpty = await call<Row[]>("memories:recall", { query: "", limit: 25, chat: theirs });
  check("scopeKept", !(outside?.memories ?? []).some((item: any) => /GREYHEX/.test(item.text))
    && (inside?.memories ?? []).some((item: any) => item.kind === "note" && /GREYHEX/.test(item.text))
    && guest.length === 0 && guestEmpty.length === 0 && !GUEST_TOOLS.some((name) => /note|page|brain/.test(name)),
  { outside: outside?.memories?.map((item: any) => item.text), inside: inside?.memories?.map((item: any) => item.text), guest: guest.map((item) => item.text), guestTools: GUEST_TOOLS });

  // --- 6. A turn is sent the note paragraph that bears on it, and lines are not loaded as memory ------------------
  const ask = "Any tips for packing my passport for Lisbon?";
  await exchange(general, ask);
  const sent = contextOf(ask);
  const relevant = sent.slice(sent.indexOf("## Possibly relevant"));
  // Long-term memory goes again only when it changed, so every time it went in this chat is looked at.
  const longTerms = log().filter((entry) => entry.prompt && String(entry.context ?? "").includes("## Things to remember"))
    .map((entry) => { const text = String(entry.context); const at = text.indexOf("## Things to remember"); const end = text.indexOf("\n## ", at + 5); return text.slice(at, end > 0 ? end : undefined); });
  check("turnGetsNoteParagraph", sent.includes("## Possibly relevant, from pages not loaded above") && relevant.includes(`note "Lisbon trip", section "Packing"`)
    && relevant.includes("] Passport") && longTerms.length > 0 && longTerms.every((part) => !/Passport|GREYHEX|Tomatoes/.test(part)) && longTerms.some((part) => part.includes("vegetarian")),
  { relevant: relevant.slice(0, 600), longTerms: longTerms.map((part) => part.slice(0, 300)) });

  // === Step 2: memory as pages =====================================================================================
  const pages = () => rows("notes");
  const pageOf = (kind: string, test: (row: Row) => boolean = () => true) => pages().find((row) => row.kind === kind && test(row));
  const lineOf = (text: string) => rows("memories").find((row) => row.text === text && !row.supersededBy);
  const content = (page?: Row) => String(page?.content ?? "");
  const sectionOf = (page: Row | undefined, text: string) => { const body = content(page); const at = body.indexOf(text); const head = body.slice(0, at).match(/^## (.+)$/gm); return head?.at(-1)?.slice(3); };

  // --- 10. About me starts as USER.md --------------------------------------------------------------------------
  const userMd = "# About Alex\n\n- **Call them:** Alex\n- Lives in Pune.\n";
  await call("persona:writeUser", { text: userMd, by: "owner" });
  const prefer = await tool(general, "remember", { text: "Prefers replies in bullet points.", kind: "profile" });
  const about = pageOf("about");
  check("aboutMeIsUserMd", content(about).startsWith("# About Alex") && content(about).includes("## How I like things done") && sectionOf(about, "Prefers replies in bullet points.") === "How I like things done"
    && lineOf("Prefers replies in bullet points.")?.kind === "profile" && /About me, How I like things done/.test(prefer?.note ?? ""),
  { about: content(about), prefer });
  await tool(general, "update_user_md", { text: `${content(pageOf("about")).trim()}\n- Has a cat called Miso.\n` });
  const persona = await call<{ user: string }>("persona:current");
  const history = await call<Array<{ text?: string }>>("persona:history", { kind: "user", limit: 10 });
  check("userMdAndPageAgree", content(pageOf("about")).includes("Has a cat called Miso.") && persona.user === content(pageOf("about")) && history[0]?.text?.includes("Has a cat called Miso.") === true
    && history.some((version) => version.text?.includes("Prefers replies in bullet points.")) && Boolean(lineOf("Has a cat called Miso.")),
  { historyCount: history.length });

  // --- 9. Each memory lands on its page, in its section ---------------------------------------------------------------
  const blood = await tool(general, "remember", { text: "The owner's blood group is O+.", kind: "core" });
  const acme = await tool(general, "remember", { text: "Works at Acme as a designer.", kind: "core", section: "Work" });
  const brother = await tool(general, "remember", { text: "Datta is the owner's brother.", kind: "core", about: ["Datta"] });
  const dentist = await tool(general, "remember", { text: "Dentist call at 3pm on Friday.", kind: "daily", tags: ["open"] });
  const kept = await tool(general, "remember", { text: "Codename for this chat is HERON.", kind: "core", scope: "this chat" });
  const grout = await tool(inProject, "remember", { text: "Grout colour is warm grey.", kind: "core" });
  const remember = pageOf("remember", (row) => !row.projectId);
  const datta = pageOf("person", (row) => row.person === "datta");
  const journal = pageOf("journal", (row) => !row.projectId);
  const chatPage = pageOf("chat", (row) => row.conversationId === general);
  const projectRemember = pageOf("remember", (row) => row.projectId === project);
  check("rememberLandsInPlace", remember?.title === "Things to remember" && sectionOf(remember, "The owner's blood group is O+.") === "Health" && sectionOf(remember, "Works at Acme as a designer.") === "Work"
    && sectionOf(remember, "The owner is vegetarian and avoids eggs.") === "Health"
    && datta?.title === "Datta" && content(datta).includes("Datta is the owner's brother.") && content(datta).includes("Datta flies to Lisbon") && !content(remember).includes("Datta is")
    && lineOf("Datta is the owner's brother.")?.about?.[0] === "Datta"
    && content(journal).includes("Dentist call at 3pm on Friday.") && lineOf("Dentist call at 3pm on Friday.")?.tags?.includes("open") && lineOf("Dentist call at 3pm on Friday.")?.kind === "daily"
    && content(chatPage).includes("HERON") && lineOf("Codename for this chat is HERON.")?.conversationId === general
    && content(projectRemember).includes("Grout colour is warm grey.") && lineOf("Grout colour is warm grey.")?.projectId === project
    && lineOf("Works at Acme as a designer.")?.by === "assistant" && lineOf("Works at Acme as a designer.")?.from === general,
  { notes: [blood?.note, acme?.note, brother?.note, dentist?.note, kept?.note, grout?.note], remember: content(remember) });

  // A chat with someone else keeps what it learns to its own page, and makes no page in People.
  const guestJid = "15550002222@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: guestJid, kind: "person", name: "Priya" }] });
  const priya = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: guestJid });
  const priyaThread = await call<string>("agentStore:createThread", { userId: `whatsapp:${guestJid}`, title: "Priya" });
  const priyaChat = await call<string>("conversations:create", { channel: "whatsapp", externalId: guestJid, threadId: priyaThread, contactId: priya._id });
  await call("memories:add", { text: "Priya is allergic to peanuts.", tags: [], source: "whatsapp", kind: "core", origin: "tool", conversationId: priyaChat, about: ["Priya"], from: priyaChat });
  const priyaPage = pageOf("chat", (row) => row.conversationId === priyaChat);
  const ownerSees = await call<Row[]>("memories:recall", { query: "peanuts allergic Priya", limit: 25, chat: general });
  const guestSees = await call<Row[]>("memories:recall", { query: "peanuts allergic Priya blood Acme HERON", limit: 25, chat: priyaChat });
  check("guestMemoryStaysInItsChat", content(priyaPage).includes("Priya is allergic to peanuts.") && !pageOf("person", (row) => row.person === "priya")
    && !ownerSees.some((item) => /peanuts/.test(item.text)) && guestSees.length === 1 && guestSees[0].text === "Priya is allergic to peanuts.",
  { ownerSees: ownerSees.map((item) => item.text), guestSees: guestSees.map((item) => item.text) });

  // --- 12. Said again, superseded, followed by a to-do, forgotten, an alert ----------------------------------------------
  const again = await tool(general, "remember", { text: "The owner's blood group is O+.", kind: "core" });
  const bloodLine = lineOf("The owner's blood group is O+.");
  const acmeId = lineOf("Works at Acme as a designer.")?._id;
  await tool(general, "remember", { text: "Works at Globex as a lead designer.", kind: "core", supersedes: [acmeId] });
  const after = pageOf("remember", (row) => !row.projectId);
  const oldAcme = rows("memories").find((row) => row._id === acmeId);
  const globex = lineOf("Works at Globex as a lead designer.");
  const dentistId = lineOf("Dentist call at 3pm on Friday.")!._id;
  const due = new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d+Z$/, "+00:00");
  const todo = await tool(general, "add_todo", { title: "Dentist call", at: due, noteIds: [dentistId] });
  const later = new Date(Date.now() + 5 * 86_400_000).toISOString().replace(/\.\d+Z$/, "+00:00");
  await tool(general, "update_todo", { id: todo?.added?.id, at: later });
  const followed = rows("memories").find((row) => row._id === dentistId);
  await call("memories:noteAlert", { text: "Your 6:40 flight moved to 7:25.", at: "06:10" });
  const alerts = await call<string[]>("memories:alertsSince", { since: Date.now() - 60_000 });
  await tool(general, "forget", { ids: [lineOf("Codename for this chat is HERON.")!._id] });
  check("confirmSupersedeFollowForget", again?.stored === false && Boolean(bloodLine?.confirmedAt)
    && !content(after).includes("Acme") && sectionOf(after, "Works at Globex as a lead designer.") === "Work" && oldAcme?.supersededBy === globex?._id && oldAcme?.text === "Works at Acme as a designer."
    && followed?.supersededBy === undefined && /To-do: moved/.test(followed?.text ?? "") && content(pageOf("journal", (row) => !row.projectId)).includes("(To-do: moved")
    && rows("memories").filter((row) => /Dentist call at 3pm/.test(row.text) && !row.supersededBy).length === 1
    && content(pageOf("journal", (row) => !row.projectId)).includes("Alerted the owner at 06:10: Your 6:40 flight moved to 7:25.") && alerts.some((alert) => alert.includes("7:25"))
    && !content(pageOf("chat", (row) => row.conversationId === general)).includes("HERON") && !lineOf("Codename for this chat is HERON."),
  { again, followed: followed?.text, alerts });

  // --- 11. The owner edits a page of memory as text ---------------------------------------------------------------------
  const before = pageOf("remember", (row) => !row.projectId)!;
  const bloodId = lineOf("The owner's blood group is O+.")!._id;
  const edited = content(before).replace("The owner's blood group is O+.", "The owner's blood group is B+.").replace("- The owner is vegetarian and avoids eggs.\n", "- The owner is vegetarian and avoids eggs.\n- Allergic to penicillin.\n");
  const saved = await call<{ ok: boolean }>("notes:save", { key: KEY, id: before._id, expectedRevision: before.revision, content: edited });
  const typed = lineOf("Allergic to penicillin.");
  const bPlus = lineOf("The owner's blood group is B+.");
  const recalledB = await call<Row[]>("memories:recall", { query: "blood group", limit: 10, chat: general });
  await call("dashboard:editMemory", { key: KEY, id: globex!._id, text: "Works at Globex as design lead." });
  // Rewritten with none of its words left, it is still the same memory.
  const groutId = lineOf("Grout colour is warm grey.")!._id;
  await call("dashboard:editMemory", { key: KEY, id: groutId, text: "Use epoxy for the shower tray." });
  const editChecks = {
    saved: saved.ok, sameId: bPlus?._id === bloodId, ownerNow: bPlus?.origin === "owner", typedKind: typed?.kind, typedSection: typed?.section, typedBy: typed?.by,
    recalledNew: recalledB.some((item) => item.text === "The owner's blood group is B+."), recalledOld: recalledB.some((item) => item.text.includes("O+")),
    dashboardEdit: content(pageOf("remember", (row) => !row.projectId)).includes("Works at Globex as design lead."), dashboardSameId: lineOf("Works at Globex as design lead.")?._id === globex?._id,
    rewrittenSameId: lineOf("Use epoxy for the shower tray.")?._id === groutId && content(pageOf("remember", (row) => row.projectId === project)).includes("Use epoxy"),
  };
  check("ownerEditsMemoryAsText", editChecks.saved && editChecks.sameId && editChecks.ownerNow && editChecks.typedKind === "core" && editChecks.typedSection === "Health" && editChecks.typedBy === "owner"
    && editChecks.recalledNew && !editChecks.recalledOld && editChecks.dashboardEdit && editChecks.dashboardSameId && editChecks.rewrittenSameId,
  { ...editChecks, recalled: recalledB.map((item) => item.text) });

  // --- 14. Older memories stay: on the Memory page, and in what a turn is sent ---------------------------------------------
  const olderListed = await call<Row[]>("dashboard:listMemories", { key: KEY, query: "" });
  const askCar = "What colour is my car again?";
  await exchange(general, askCar);
  const carSent = log().filter((entry) => entry.prompt && String(entry.context ?? "").includes("blue Skoda")).length > 0;
  check("olderMemoriesStay", olderListed.length === 1 && olderListed[0].id === oldCar && carSent, { olderListed: olderListed.map((item) => item.text), carSent });

  // === Step 3: pinning and the budget ===============================================================================
  /** A fresh chat (so nothing was sent before), one message, and what the engine was sent with it. */
  let freshCount = 0;
  const fresh = async (projectId?: string) => {
    const chat = await call<string>("dashboard:createChat", { key: KEY, ...(projectId ? { projectId } : {}) });
    await onGrok(chat);
    const prompt = `PINCHECK ${++freshCount}`;
    await exchange(chat, prompt);
    const all = contextOf(prompt);
    const from = all.indexOf("# Recalled memory");
    const to = all.indexOf("## Possibly relevant", from);
    return { all, standing: from >= 0 ? all.slice(from, to > from ? to : undefined) : "", instructions: from >= 0 ? all.slice(0, from) : all };
  };
  const pinPage = (id: string, pinned: boolean, section?: string) => call("pages:pin", { key: KEY, id, pinned, ...(section ? { section } : {}) });
  const dattaId = pageOf("person", (row) => row.person === "datta")!._id;
  const rememberId = pageOf("remember", (row) => !row.projectId)!._id;
  const aboutId = pageOf("about")!._id;

  const base = await fresh();
  await pinPage(lisbon, true);
  const twoParts = await call<string>("notes:create", { key: KEY, title: "Two parts", content: "## Keep\n\nKEEPME this part.\n\n## Skip\n\nSKIPME not this part.\n" });
  await pinPage(twoParts, true, "Keep");
  await pinPage(dattaId, true);
  const pinnedNow = await fresh();
  check("pinnedReachesTurnsUnpinnedDoesNot", base.standing.includes("## Things to remember") && base.standing.includes("vegetarian") && base.instructions.includes("Has a cat called Miso")
    && !base.standing.includes("Datta is the owner's brother") && !base.standing.includes("Passport") && !base.standing.includes("KEEPME")
    && pinnedNow.standing.includes("## Pinned: Lisbon trip") && pinnedNow.standing.includes("Passport") && pinnedNow.standing.includes("KEEPME") && !pinnedNow.standing.includes("SKIPME")
    && pinnedNow.standing.includes("Datta is the owner's brother"),
  { base: base.standing.slice(0, 1200), pinned: pinnedNow.standing.slice(0, 2500) });

  await pinPage(rememberId, false);
  await pinPage(aboutId, false);
  const unpinned = await fresh();
  await pinPage(rememberId, true);
  await pinPage(aboutId, true);
  check("unpinningLasting", !unpinned.standing.includes("vegetarian") && !unpinned.all.includes("Has a cat called Miso") && unpinned.standing.includes("Passport"),
    { standing: unpinned.standing.slice(0, 800) });

  // A pinned page bigger than the budget: it is cut, and says so; what comes first stays whole.
  const big = Array.from({ length: 420 }, (_, i) => `BIGLINE ${i} of a long plan, with enough words in it to fill a line of about a hundred characters.`).join("\n\n");
  const bigPlan = await call<string>("notes:create", { key: KEY, title: "Big plan", content: `${big}\n` });
  await pinPage(bigPlan, true);
  const overBudget = await fresh();
  const usage = await call<{ used: number; budget: number; left: string[] }>("pages:pinnedUsage", { key: KEY });
  const aboutPart = overBudget.instructions.slice(overBudget.instructions.indexOf("## About me"));
  // The parts measured here carry a little more than the budget counts: the recalled block's header, and what follows About me in the instructions.
  check("budgetKept", usage.budget === 32_000 && usage.used <= usage.budget && overBudget.standing.length <= usage.budget && overBudget.standing.length + aboutPart.length <= usage.budget + 1_500
    && overBudget.standing.includes("blue Skoda")
    && /more lines not loaded here/.test(overBudget.standing) && overBudget.standing.includes(`read the page (id ${bigPlan})`) && overBudget.standing.includes("BIGLINE 0 ") && !overBudget.standing.includes("BIGLINE 419 ")
    && overBudget.standing.includes("vegetarian") && overBudget.instructions.includes("Has a cat called Miso") && usage.left.some((title) => title.startsWith("Pinned: Big plan")),
  { usage, standingChars: overBudget.standing.length, aboutChars: aboutPart.length });
  await pinPage(bigPlan, false);

  // A project's pinned page stays in the project; a chat with someone else gets none of it.
  await pinPage(tiles, true);
  const outsideProject = await fresh();
  const insideProject = await fresh(project);
  const guestPrompt = await call<Record<string, string>>("contacts:guestPrompt", { contactId: priya._id, conversationId: priyaChat });
  const guestText = Object.values(guestPrompt).join("\n");
  check("pinsKeepTheirScope", !outsideProject.standing.includes("GREYHEX") && insideProject.standing.includes("GREYHEX") && insideProject.standing.includes("Use epoxy")
    && !/vegetarian|Miso|Passport|GREYHEX|KEEPME|Datta is the owner/.test(guestText) && guestText.includes("Priya is allergic to peanuts."),
  { inside: insideProject.standing.slice(0, 800), guest: guestText.slice(-600) });
  await pinPage(tiles, false);

  // --- 4b. Deleting the project keeps its notes, and their lines move out with them ---------------------------------
  await call("projects:remove", { key: KEY, id: project });
  const moved = linesOf(tiles);
  check("projectDeleteKeepsLines", moved.length === 1 && !moved[0].projectId && !noteRow(tiles)?.projectId, moved.map((line) => ({ text: line.text, projectId: line.projectId })));

  // --- 7. Ctrl+K: one search across memory and notes ------------------------------------------------------------------
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, ms = 30_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { let ok = false; try { ok = Boolean(${test}); } catch {} ok ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(`timed out: ${what}`)})) : setTimeout(tick, 150); }; tick(); })`);
  const key = async (keyName: string, code = keyName, vk = 0, modifiers = 0, text?: string) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(120);
  };
  const typeText = async (text: string) => { await send("Input.insertText", { text }); await sleep(150); };
  async function fill(selector: string, text: string) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); return true; })()`);
    await key("Delete", "Delete", 46);
    await typeText(text);
  }
  async function click(selector: string) {
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number } | null;
    if (!box) throw new Error(`nothing to click: ${selector}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(300);
  }
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const go = async (path: string) => { await send("Page.navigate", { url: `${p.BASE}${path}` }); await sleep(1_500); };
  const palette = async (words: string) => {
    await go("/chat");
    await key("k", "KeyK", 75, 2);
    await waitFor(`document.querySelector('[cmdk-input]')`, "the search palette");
    await typeText(words);
  };
  const groupHas = (heading: string) => `[...document.querySelectorAll('[cmdk-group-heading]')].some((item) => item.innerText === ${JSON.stringify(heading)})`;

  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  await palette("eggs");
  await waitFor(`${groupHas("Memory and notes")} && document.querySelector('[data-recalled="core"]')?.innerText.includes("vegetarian")`, "a memory in search", 20_000);
  const memoryHit = await evaluate(`document.querySelector('[data-recalled="core"]').innerText`);
  await fill("[cmdk-input]", "passport");
  await waitFor(`document.querySelector('[data-recalled="page"]')?.innerText.includes("Passport")`, "a note's line in search", 20_000);
  await shot("search-memory-and-notes.png");
  const lineHit = await evaluate(`document.querySelector('[data-recalled="page"]').innerText`);
  await click('[data-recalled="page"]');
  await waitFor(`location.pathname === ${JSON.stringify(`/notes/${lisbon}`)}`, "the note to open from its line");
  await palette("eggs");
  await waitFor(`document.querySelector('[data-recalled="core"]')`, "the memory again", 20_000);
  await click('[data-recalled="core"]');
  // A memory is a line of its page now (step 2): it opens there.
  await waitFor(`location.pathname === ${JSON.stringify(`/notes/${pageOf("remember", (row) => !row.projectId)?._id}`)}`, "the memory to open in its page");
  check("searchFindsMemoryAndNotes", /vegetarian/.test(memoryHit) && /Things to remember › Health/.test(memoryHit) && /Passport/.test(lineHit) && /Lisbon trip › Packing/.test(lineHit), { memoryHit, lineHit });

  // --- 15, 13. The Memory page lists the pages; a page of memory in the editor ------------------------------------------
  await go("/memory");
  await waitFor(`document.querySelector('section[aria-label="Memory pages"]') && document.querySelector('[data-memory-page="remember"]')`, "the memory pages");
  const listed = await evaluate(`[...document.querySelectorAll('[data-memory-page]')].map((item) => item.getAttribute("data-memory-page") + ":" + item.innerText.trim())`) as string[];
  await shot("memory-pages.png");
  const rememberPage = pageOf("remember", (row) => !row.projectId)!;
  await go(`/notes/${rememberPage._id}`);
  await waitFor(`document.querySelector("[data-note-editor]")?.innerText.includes("Allergic to penicillin")`, "Things to remember in the editor");
  const locked = await evaluate(`({ readOnly: document.querySelector('input[aria-label="Title"]').readOnly, crumb: document.querySelector("header a, nav a")?.innerText })`);
  await click('[aria-label="Note options"]');
  const menu = await evaluate(`[...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map((item) => item.innerText.trim())`) as string[];
  await key("Escape", "Escape", 27);
  // Where each memory came from.
  await click("[data-sources] button");
  await waitFor(`document.querySelectorAll("[data-line]").length > 3`, "the lines and where they came from");
  const sources = await evaluate(`document.querySelector("[data-sources]").innerText`) as string;
  await shot("things-to-remember.png");
  // The owner types while Perry remembers something into the same page: their words stay, and they choose.
  await evaluate(`(() => { const el = document.querySelector("[data-note-editor]"); el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); return true; })()`);
  await send("Input.insertText", { text: " OWNERTYPING" });
  await call("memories:add", { text: "Takes the train to work.", tags: [], source: "test", kind: "core", section: "Work" });
  await sleep(4_000);
  const conflict = await evaluate(`Boolean(document.querySelector("[data-conflict]")) && document.querySelector("[data-note-editor]").innerText.includes("OWNERTYPING")`);
  const stillPerrys = content(pageOf("remember", (row) => !row.projectId)).includes("Takes the train to work.");
  if (conflict) { await shot("memory-conflict.png"); await click("[data-conflict] button:last-child"); await sleep(2_000); }
  const merged = content(pageOf("remember", (row) => !row.projectId));
  check("memoryPagesInTheEditor", listed.some((item) => item.startsWith("about:")) && listed.some((item) => item.startsWith("remember:")) && listed.some((item) => item.startsWith("journal:")) && listed.some((item) => item === "person:Datta")
    && listed.some((item) => item.startsWith("chat:")) && locked.readOnly === true && !menu.some((item) => /Delete|Move to project/.test(item))
    && /Perry/.test(sources) && /You/.test(sources) && /from “/.test(sources)
    && conflict === true && stillPerrys,
  { listed, locked, menu, sources: sources.slice(0, 400), conflict, kept: { owner: merged.includes("OWNERTYPING"), perry: merged.includes("Takes the train") } });

  // --- 20. The pin button, and what the Memory page says is pinned --------------------------------------------------------
  await go(`/notes/${twoParts}`);
  await waitFor(`document.querySelector('button[aria-label="Pin to every chat"]')`, "the pin button");
  await click('button[aria-label="Pin to every chat"]');
  await until(() => noteRow(twoParts)?.pinned === true, "the page to be pinned", 10);
  await waitFor(`document.querySelector('button[aria-label="Unpin from every chat"]') && document.querySelector("[data-pinned]")`, "the page to show it is pinned");
  await shot("page-pinned.png");
  await go("/memory");
  await waitFor(`document.querySelector("[data-usage]") && document.querySelector('[data-memory-page="page"]')`, "the pinned pages and their budget");
  const pinnedGroup = await evaluate(`document.querySelector('ul[aria-label="Pinned: in every chat"]')?.innerText ?? ""`) as string;
  const usageText = await evaluate(`document.querySelector("[data-usage]").innerText`) as string;
  await shot("memory-pinned.png");
  await click('button[aria-label="Unpin from every chat"]').catch(() => {});
  check("pinButtonAndUsage", /Two parts/.test(pinnedGroup) && /Lisbon trip/.test(pinnedGroup) && /Datta/.test(pinnedGroup) && /About me/.test(pinnedGroup) && /of 32,000 characters/.test(usageText),
    { pinnedGroup, usageText });

  // --- 8. Dark, and no page errors -------------------------------------------------------------------------------------
  await evaluate(`localStorage.setItem("perry.theme", "dark"); true`);
  await palette("swim");
  await waitFor(`document.documentElement.classList.contains("dark") && document.querySelectorAll('[data-recalled]').length >= 2`, "dark search with a daily note and a note line", 20_000);
  const swim = await evaluate(`[...document.querySelectorAll('[data-recalled]')].map((item) => item.getAttribute("data-recalled"))`) as string[];
  await shot("search-memory-and-notes-dark.png");
  await key("Escape", "Escape", 27);
  await go("/memory");
  await waitFor(`document.documentElement.classList.contains("dark") && document.querySelector('[data-memory-page="about"]')`, "dark Memory page");
  await shot("memory-pages-dark.png");
  await go(`/notes/${pageOf("about")!._id}`);
  await waitFor(`document.querySelector("[data-note-editor]")?.innerText.includes("Miso")`, "dark About me");
  await shot("about-me-dark.png");
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  check("searchDarkAndDaily", swim.includes("daily") && swim.includes("page"), swim);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
  notes.realModelTurns = "none: every chat ran on the fake Grok agent";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  check("completed", false);
}
process.exit(await p.finish() ? 0 : 1);
