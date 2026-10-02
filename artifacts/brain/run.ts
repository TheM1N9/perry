import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";
import { GUEST_TOOLS } from "../../convex/lib/engines";
import { journalTitle as journalTitleOf, peopleIn } from "../../convex/lib/pages";

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
// Step 4, memories from before pages moved into them (an old-style install seeded as an older Perry left it):
//  21. A memory lands on the wrong page or section, or none: each layer (profile, core, a row with no layer, daily with
//      and without its day), each scope (everywhere, a project, one chat, a chat with someone else), people (one and
//      two named), alerts and open threads.
//  22. Provenance is lost: a new id (citations, to-do links and asked threads break), or changed words, tags, people,
//      scope, source, origin, dates or vector; words that cannot be one line are changed without the original kept.
//  23. No backup is written first, or it misses rows (superseded ones, USER.md's versions, the notes).
//  24. A superseded memory is moved in as if current; About me loses USER.md or the owner's preferences.
//  25. It is not idempotent: a second start moves, writes or backs up anything again.
//  26. It cannot be undone: moving back leaves rows in pages, changes their words or ids, leaves empty pages it made,
//      leaves the lines of the owner's other pages an older Perry would read as memories, or Perry moves them in again
//      on the next start; moving in again does not put them back where they were.
//  27. Memories moved in are no longer loaded or listed: the Memory page loses them, or turns are not sent them.
// Step 5, one Brain:
//  28. The sidebar still has Memory or Notes, or Brain is missing or goes elsewhere.
//  29. An old link (/memory, /memory?q=, /memory?tab=about, /about, /notes, /notes/<id>, a reply's /notes/ link) lands
//      nowhere, or on the wrong page.
//  30. The brain_* family is missing or wrong: brain_list leaves out pages of memory, brain_read does not find a page by
//      its name, brain_write, brain_append and brain_pin do nothing, brain_search misses memory or pages; or a name from
//      before (read_memory, search_memory, list_notes, read_note, search_notes, create_note, update_note,
//      update_user_md) no longer works.
//  31. A chat with someone else is given, or reaches, any brain_* tool or the owner's pages.
//  32. Perry writes a secret into a page or a memory: a value saved in Logins & secrets, or a key-shaped string.
//  33. The instructions do not say where to write what, how pinning works, or that a chat with someone else has none of it.
//  34. The Brain page misses a part (search, pinned, journal, people, pages) or throws, in light or dark.
// People (issue #218), on an install shaped like the owner's: `about` with several names, comma-separated in one or
// one by one, on daily and core memories, and WhatsApp contacts and a group:
//  35. Someone named in a memory gets no page in People, or a name with commas becomes one page.
//  36. A person's page misses one of their memories (one about several people, a day's note in the journal), or
//      shows one twice; a memory is copied (two rows) or lost.
//  37. A page is linked to the wrong contact: one of two people with the same name, or a group.
//  38. On an install already moved into pages, the follow-up does not make the missing pages, makes no backup first,
//      changes anything but adding pages, or runs again on the next start.
//  39. remember about several people leaves one of them without a page.
//  40. A pinned person's page sends a memory twice, or recall returns one twice; Settings → People and Brain → People
//      list different people.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/brain/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const MODELS = process.env.PERRY_E2E_MODELS ?? (process.env.PERRY_E2E_DIR ? join(process.env.PERRY_E2E_DIR, "models") : "");
const MODEL_DIR = "onnx-community/embeddinggemma-300m-ONNX";
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
const isPinnedRow = (page?: Row) => Boolean(page) && (page!.pinned ?? (page!.kind === "about" || page!.kind === "remember")) === true;
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

  // --- An install as an older Perry left it: USER.md, chats, a project, someone the owner lets Perry talk with, a to-do,
  // a note from before lines and memories from before pages, every layer and scope.
  const now = Date.now();
  const userMd = "# About Alex\n\n- **Call them:** Alex\n- Lives in Pune.\n";
  await call("persona:writeUser", { text: userMd, by: "owner" });
  const general = await call<string>("dashboard:createChat", { key: KEY });
  const project = await call<string>("projects:create", { key: KEY, name: "Bathroom" });
  const inProject = await call<string>("dashboard:createChat", { key: KEY, projectId: project });
  const jid = "15550001111@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: jid, kind: "person", name: "Datta" }] });
  const contact = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: jid });
  const thread = await call<string>("agentStore:createThread", { userId: `whatsapp:${jid}`, title: "Datta" });
  const theirs = await call<string>("conversations:create", { channel: "whatsapp", externalId: jid, threadId: thread, contactId: contact._id });
  const followUp = (await call<{ added?: { id: string } }>("todos:addFromAgent", { title: "Dentist follow-up" })).added!.id;
  // The owner's people on WhatsApp: Juhi and Vivek once each, two Aadils, and a group.
  await call("contacts:learn", { items: [
    { channel: "whatsapp", externalId: "15550003001@s.whatsapp.net", kind: "person", name: "Juhi" },
    { channel: "whatsapp", externalId: "15550003002@s.whatsapp.net", kind: "person", name: "Vivek" },
    { channel: "whatsapp", externalId: "15550003003@s.whatsapp.net", kind: "person", name: "Aadil" },
    { channel: "whatsapp", externalId: "15550003004@s.whatsapp.net", kind: "person", name: "aadil" },
    { channel: "whatsapp", externalId: "120363000000000001@g.us", kind: "group", name: "Manvi" },
  ] });
  const timezone = await call<string>("jobs:ownerTimezone");
  const dayOf = (at: number) => new Date(at).toLocaleDateString("en-CA", { timeZone: timezone });
  const DAY = 86_400_000;
  const oldNote = seed("notes", {
    title: "Old garden plan", content: "## Beds\n\n- Tomatoes by the south wall\n- Basil between them\n\nWater at dawn in July.\n",
    revision: 3, search: "Old garden plan", by: "owner", createdAt: now - DAY * 40, updatedAt: now - DAY * 30,
  });
  const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  const memory = (doc: Record<string, unknown>) => ({ tags: [], source: "telegram:4242", createdAt: now - DAY * 90, origin: "owner", ...doc });
  const seeds: Record<string, Record<string, unknown>> = {
    profile: memory({ text: "Always answer in British English.", kind: "profile", createdAt: now - DAY * 60 }),
    noKind: memory({ text: "The owner's flat is on the 4th floor.", source: "web:dashboard", createdAt: now - DAY * 300 }),
    car: memory({ text: "The owner's car is a blue Skoda.", kind: "core", createdAt: now - DAY * 200, editedAt: now - DAY * 100 }),
    cousin: memory({ text: "Arjun is the owner's cousin in Bangalore.", kind: "core", about: ["Arjun"] }),
    wedding: memory({ text: "Arjun and Meera are getting married in Dec 2026.", kind: "core", about: ["Arjun", "Meera"] }),
    budget: memory({ text: "Bathroom budget is 4000 euros.", kind: "core", projectId: project }),
    plumber: memory({ text: "Ravi the plumber comes on Tuesdays.", kind: "core", projectId: project, about: ["Ravi"] }),
    spanish: memory({ text: "In this project, reply in Spanish.", kind: "profile", projectId: project }),
    dentist: memory({ text: "Dentist follow-up call on Friday.", kind: "daily", day: dayOf(now - DAY * 3), createdAt: now - DAY * 3, tags: ["open"], todoId: followUp }),
    alert: memory({ text: "Alerted the owner at 06:00: Flight moved to 7:25.", kind: "daily", day: dayOf(now - DAY), createdAt: now - DAY, tags: ["alert"], origin: "job", source: "alert" }),
    // At noon UTC: its day is worked out when it moves in, in the owner's timezone, which is UTC until the browser sets it; noon is the
    // same day in both, so a run past midnight on the owner's clock does not move it to another day on moving in again.
    kettle: memory({ text: "Bought a new kettle.", kind: "daily", createdAt: Math.floor((now - DAY * 5) / DAY) * DAY + DAY / 2 }),
    tiles: memory({ text: "Tiles for the bathroom arrived.", kind: "daily", day: dayOf(now - DAY * 2), createdAt: now - DAY * 2, projectId: project }),
    owl: memory({ text: "Codename for the surprise party is OWL.", kind: "core", conversationId: general }),
    voice: memory({ text: "Datta prefers WhatsApp voice notes.", kind: "core", conversationId: theirs, about: ["Datta"], origin: "tool", source: `whatsapp:${jid}` }),
    globex: memory({ text: "The owner works at Globex.", kind: "core", createdAt: now - DAY * 20 }),
    list: memory({ text: "Shopping list idea:\n\nmilk and bread", kind: "core" }),
    checkbox: memory({ text: "[x] Renewed the passport in May.", kind: "core" }),
    tea: memory({ text: "The owner's favourite tea is Assam.", kind: "core", vector: "AACAPw==", vectorModel: MODEL }),
    // People as the owner's memories name them: several at once, comma-separated or one by one.
    cricket: memory({ text: "Vivek, Juhi and Aadil run the Sunday cricket game.", kind: "core", about: ["Vivek", "Juhi", "Aadil"] }),
    dinner: memory({ text: "Had dinner with Juhi, Aadil and Vivek.", kind: "daily", day: dayOf(now - DAY * 2), createdAt: now - DAY * 2, about: ["Juhi,Aadil,Vivek"] }),
    hackerrank: memory({ text: "Called Manvi about the HackerRank test.", kind: "daily", day: dayOf(now - DAY), createdAt: now - DAY, about: ["Manvi"] }),
    visit: memory({ text: "Pranav and Ishita Shree came over.", kind: "daily", day: dayOf(now - DAY * 4), createdAt: now - DAY * 4, about: ["Pranav, Ishita Shree"] }),
    sister: memory({ text: "Manvi is the owner's sister.", kind: "core", about: ["Manvi"] }),
  };
  const old: Record<string, string> = {};
  for (const [name, doc] of Object.entries(seeds)) old[name] = seed("memories", doc);
  // A fact that was replaced: it stays as history, superseded, and is not moved in.
  seeds.acme = memory({ text: "The owner works at Acme.", kind: "core", createdAt: now - DAY * 400, supersededBy: old.globex });
  old.acme = seed("memories", seeds.acme);
  // And memories already in pages as Brain first left them: Ravi's page holds one about Ravi and Meena, and a
  // journal day one about Meena; Meena has no page.
  const ravi = seed("notes", { title: "Ravi", content: "- Ravi and Meena are moving to Goa.\n", revision: 1, linesAt: 1, search: "Ravi", by: "owner", kind: "person", person: "ravi", createdAt: now - DAY * 7, updatedAt: now - DAY * 7 });
  const oldDay = dayOf(now - DAY * 6);
  const meenaDay = seed("notes", { title: journalTitleOf(oldDay), content: "- Meena called about the move.\n", revision: 1, linesAt: 1, search: "x", by: "owner", kind: "journal", day: oldDay, createdAt: now - DAY * 6, updatedAt: now - DAY * 6 });
  const inPages = {
    goa: seed("memories", memory({ text: "Ravi and Meena are moving to Goa.", kind: "core", about: ["Ravi, Meena"], pageId: ravi, order: 0, by: "assistant", createdAt: now - DAY * 7 })),
    called: seed("memories", memory({ text: "Meena called about the move.", kind: "daily", day: oldDay, about: ["Meena"], pageId: meenaDay, order: 0, by: "assistant", createdAt: now - DAY * 6 })),
  };
  const beforeRestart = linesOf(oldNote).length;
  p.stop(server);
  await sleep(2_000);
  await startServer();

  // --- 1. The note from before lines is indexed when Perry starts ----------------------------------------------
  const oldLines = linesOf(oldNote);
  check("oldNoteIndexedOnStart", beforeRestart === 0 && oldLines.length === 3 && oldLines[0].section === "Beds" && oldLines[2].text === "Water at dawn in July."
    && noteRow(oldNote)?.linesAt === 3 && oldLines.every((line) => line.by === "owner" && line.createdAt === now - DAY * 30),
  { beforeRestart, lines: oldLines.map((line) => ({ text: line.text, section: line.section, by: line.by })) });

  // === Step 4: memories from before pages, moved into them when Perry starts ========================================
  const M = (name: string) => rows("memories").find((row) => row._id === old[name]);
  const P = (name: string) => rows("notes").find((row) => row._id === M(name)?.pageId);
  const at = (name: string) => ({ page: P(name)?.title, kind: P(name)?.kind, section: M(name)?.section, project: P(name)?.projectId === project ? "project" : P(name)?.projectId, chat: P(name)?.conversationId === general ? "general" : P(name)?.conversationId === theirs ? "theirs" : P(name)?.conversationId });
  const places = Object.fromEntries(Object.keys(old).map((name) => [name, at(name)]));
  const expect: Record<string, Partial<ReturnType<typeof at>>> = {
    profile: { kind: "about", page: "About me", section: "How I like things done" },
    noKind: { kind: "remember", page: "Things to remember", section: "Home", project: undefined },
    car: { kind: "remember", section: "Home", project: undefined },
    cousin: { kind: "person", page: "Arjun" },
    wedding: { kind: "person", page: "Arjun" },
    budget: { kind: "remember", project: "project" },
    plumber: { kind: "remember", project: "project", section: "People" },
    spanish: { kind: "remember", project: "project", section: "How I like things done" },
    dentist: { kind: "journal", page: journalTitleOf(dayOf(now - DAY * 3)), project: undefined },
    alert: { kind: "journal", page: journalTitleOf(dayOf(now - DAY)) },
    kettle: { kind: "journal", page: journalTitleOf(dayOf(now - DAY * 5)) },
    // A project's day note goes in its Journey, under its day (issue #227).
    tiles: { kind: "journey", project: "project", page: "Journey", section: journalTitleOf(dayOf(now - DAY * 2)) },
    owl: { kind: "chat", chat: "general" },
    voice: { kind: "chat", chat: "theirs" },
    globex: { kind: "remember", section: "Work" },
    list: { kind: "remember" },
    checkbox: { kind: "remember" },
    tea: { kind: "remember", section: "Preferences" },
    cricket: { kind: "person", page: "Vivek" },
    dinner: { kind: "journal", page: journalTitleOf(dayOf(now - DAY * 2)) },
    hackerrank: { kind: "journal", page: journalTitleOf(dayOf(now - DAY)) },
    visit: { kind: "journal", page: journalTitleOf(dayOf(now - DAY * 4)) },
    sister: { kind: "person", page: "Manvi" },
  };
  const misplaced = Object.entries(expect).filter(([name, want]) => Object.entries(want).some(([field, value]) => (places[name] as Record<string, unknown>)[field] !== value)).map(([name]) => ({ name, got: places[name], want: expect[name] }));
  const inContent = Object.keys(expect).filter((name) => !String(P(name)?.content ?? "").includes(String(M(name)?.text).split("\n")[0]));
  check("migratedIntoPages", misplaced.length === 0 && inContent.length === 0 && !rows("notes").some((row) => row.kind === "person" && row.person === "datta")
    && String(rows("notes").find((row) => row.kind === "about")?.content).startsWith("# About Alex"),
  { misplaced, inContent, about: rows("notes").find((row) => row.kind === "about")?.content });

  // A vector is no longer kept inside its row (#220): it moves to the vector index, and one that is not a vector is made again.
  const KEPT = ["text", "tags", "source", "origin", "createdAt", "editedAt", "about", "todoId", "day", "kind", "projectId", "conversationId"];
  // A row with no vector gets one from the sentence model once Perry runs; one that had one keeps it.
  const unchanged = (name: string, field: string) => (field !== "vector" && field !== "vectorModel") || seeds[name].vector !== undefined;
  // A Journey's lines are every chat's (issue #227): the project's day note keeps all but its project, which its page has.
  const changed = Object.keys(expect).flatMap((name) => KEPT.filter((field) => (field !== "text" || (name !== "list" && name !== "checkbox")) && unchanged(name, field) && !(name === "tiles" && field === "projectId"))
    .filter((field) => JSON.stringify(M(name)?.[field] ?? null) !== JSON.stringify(seeds[name][field] ?? null)).map((field) => `${name}.${field}`));
  check("provenanceKept", Boolean(M("profile")) && changed.length === 0 && Object.keys(expect).every((name) => typeof M(name)?.migratedAt === "number")
    && M("list")?.text === "Shopping list idea:\nmilk and bread" && M("list")?.migratedFrom === "Shopping list idea:\n\nmilk and bread"
    && M("checkbox")?.text === "Renewed the passport in May." && M("checkbox")?.migratedFrom === "[x] Renewed the passport in May." && M("checkbox")?.origin === "owner" && !M("checkbox")?.editedAt
    && !M("acme")?.pageId && M("acme")?.supersededBy === old.globex && !M("acme")?.migratedAt,
  { changed, list: M("list") && { text: M("list")!.text, from: M("list")!.migratedFrom }, acme: M("acme") && { pageId: M("acme")!.pageId, supersededBy: M("acme")!.supersededBy } });

  const backups = existsSync(join(p.home, "backups")) ? readdirSync(join(p.home, "backups")).filter((name) => name.startsWith("memories-before-pages-")) : [];
  const backup = backups[0] ? JSON.parse(readFileSync(join(p.home, "backups", backups[0]), "utf8")) : null;
  check("backupFirst", backups.length === 1 && backup?.waiting === Object.keys(expect).length && backup.memories.length >= Object.keys(old).length
    && backup.memories.some((row: Row) => row._id === old.acme) && backup.memories.every((row: Row) => !row.pageId || row.kind === "page" || Object.values(inPages).includes(row._id)) && backup.persona.some((row: Row) => row.text === userMd.trim()) && backup.notes.some((row: Row) => row._id === oldNote),
  { backups, waiting: backup?.waiting, rows: backup?.memories?.length });

  // === People (issue #218) ==========================================================================================
  const personPages = () => rows("notes").filter((row) => row.kind === "person");
  const personPage = (name: string) => personPages().find((row) => row.person === name.toLocaleLowerCase());
  const named = (name: string) => rows("memories").filter((row) => !row.supersededBy && row.kind !== "page" && peopleIn(row.about).some((who) => who.toLocaleLowerCase() === name.toLocaleLowerCase())
    && !(row.conversationId && row.conversationId === theirs)).map((row) => row._id).sort();
  const shownFor = async (name: string) => {
    const page = personPage(name);
    if (!page) return { own: [] as string[], elsewhere: [] as string[] };
    const elsewhere = (await call<Array<{ id: string }>>("pages:mentions", { key: KEY, id: page._id })).map((mention) => mention.id);
    return { own: rows("memories").filter((row) => row.pageId === page._id && !row.supersededBy).map((row) => row._id), elsewhere };
  };
  const everyone = ["Vivek", "Juhi", "Aadil", "Manvi", "Pranav", "Ishita Shree", "Ravi", "Meena", "Arjun", "Meera"];
  const coverage: Record<string, unknown> = {};
  let complete = true;
  for (const name of everyone) {
    const { own, elsewhere } = await shownFor(name);
    const shown = [...own, ...elsewhere].sort();
    const ok = Boolean(personPage(name)) && JSON.stringify(shown) === JSON.stringify(named(name)) && new Set(shown).size === shown.length;
    coverage[name] = { page: personPage(name)?.title, own: own.length, elsewhere: elsewhere.length, expected: named(name).length, ok };
    complete &&= ok;
  }
  const texts = ["Vivek, Juhi and Aadil run the Sunday cricket game.", "Had dinner with Juhi, Aadil and Vivek.", "Called Manvi about the HackerRank test.", "Pranav and Ishita Shree came over.", "Manvi is the owner's sister.", "Ravi and Meena are moving to Goa.", "Meena called about the move."];
  const copies = Object.fromEntries(texts.map((text) => [text, rows("memories").filter((row) => row.text === text && !row.supersededBy).length]));
  check("everyPersonHasAPageWithAllTheirMemories", complete && Object.values(copies).every((count) => count === 1) && !personPages().some((row) => row.title.includes(",")),
    { coverage, copies, pages: personPages().map((row) => row.title) });

  const contactOf = (externalId: string) => rows("contacts").find((row) => row.externalId === externalId)?._id;
  check("pagesLinkedToTheirContacts", personPage("Juhi")?.contactId === contactOf("15550003001@s.whatsapp.net") && personPage("Vivek")?.contactId === contactOf("15550003002@s.whatsapp.net")
    && !personPage("Aadil")?.contactId && !personPage("Manvi")?.contactId,
  { juhi: Boolean(personPage("Juhi")?.contactId), vivek: Boolean(personPage("Vivek")?.contactId), aadil: personPage("Aadil")?.contactId ?? null, manvi: personPage("Manvi")?.contactId ?? null });

  const peopleBackups = readdirSync(join(p.home, "backups")).filter((name) => name.startsWith("people-before-pages-"));
  const peopleBackup = peopleBackups[0] ? JSON.parse(readFileSync(join(p.home, "backups", peopleBackups[0]), "utf8")) : null;
  const ravisPage = rows("notes").find((row) => row._id === ravi);
  check("followUpOnAMovedInstall", Boolean(personPage("Meena")) && peopleBackups.length === 1 && peopleBackup?.notes?.some((row: Row) => row._id === ravi) && !peopleBackup?.notes?.some((row: Row) => row.kind === "person" && row.person === "meena")
    && ravisPage?.revision === 1 && ravisPage?.content === "- Ravi and Meena are moving to Goa.\n"
    && rows("memories").find((row) => row._id === inPages.goa)?.pageId === ravi && rows("memories").find((row) => row._id === inPages.called)?.pageId === meenaDay,
  { peopleBackups, missingInBackup: peopleBackup?.missing });

  // --- 25. A second start moves nothing, writes nothing, backs up nothing ------------------------------------------
  const stable = () => JSON.stringify({
    memories: rows("memories").filter((row) => row.kind !== "page").map((row) => [row._id, row.pageId, row.section, row.order, row.text, row.migratedAt]).sort(),
    pages: rows("notes").map((row) => [row._id, row.revision, row.content]).sort(),
  });
  const once = stable();
  const backupCount = readdirSync(join(p.home, "backups")).length;
  p.stop(server);
  await sleep(2_000);
  await startServer();
  const twice = await call<{ moved: number }>("pages:migrate", {});
  const backupsAfter = readdirSync(join(p.home, "backups")).length;
  check("migrationIdempotent", stable() === once && twice.moved === 0 && backupsAfter === backupCount, { twice, backupsAfter });

  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await sleep(3_000);
  const real = (await computers()).flatMap((item) => item.engines).filter((engine) => engine.signedIn && engine.kind !== "grok").map((engine) => engine.kind);
  notes.realEnginesSignedIn = real;
  if (real.length) throw new Error(`${real.join(", ")} is signed in for the test's runner; stopping before anything reaches a real model.`);

  await onGrok(general);
  await exchange(general, "Hello, this is the general chat.");
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
  // Every memory from before pages was moved in (step 4): none is left listed apart. The count is those and the three above.
  const memoryRows = rows("memories").filter((row) => !row.supersededBy && row.kind !== "page").length;
  check("linesAreNotMemories", !memoryPage.some((memory) => memory.kind === "page") && memoryPage.length === 0 && count === memoryRows && count < rows("memories").filter((row) => !row.supersededBy).length
    && forgot.deleted === 0 && Boolean(linesOf(lisbon).find((line) => line._id === passport)),
  { listed: memoryPage.map((memory) => memory.text), count, forgot });

  // --- The sentence model, and every line's vector -------------------------------------------------------------
  // Every current line has a vector from the model in use (kept in the vector index; the row says which model, #220).
  const embedded = () => rows("memories").every((row) => row.embeddedWith === "onnx-community/embeddinggemma-300m-ONNX" || row.supersededBy);
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
    && byWords.memories.some((item: any) => item.kind === "note" && item.note?.title === "Lisbon trip" && item.note?.link === `/brain/${lisbon}`),
  byWords?.memories?.map((item: any) => [item.kind, item.text]));
  check("recallByMeaning", notes.allEmbedded === true
    && byMeaningMemory?.memories?.[0]?.text === "The owner is vegetarian and avoids eggs."
    && (byMeaningNote?.memories ?? []).slice(0, 3).some((item: any) => item.text === "Passport"),
  { memory: byMeaningMemory?.memories?.map((item: any) => item.text), note: byMeaningNote?.memories?.map((item: any) => item.text) });

  // --- 4. Where a note may be found from -----------------------------------------------------------------------
  const outside = await tool(general, "recall", { query: "GREYHEX hexagon tiles" });
  const inside = await tool(inProject, "recall", { query: "GREYHEX hexagon tiles" });
  const guest = await call<Row[]>("memories:recall", { query: "Lisbon passport vegetarian GREYHEX", limit: 25, chat: theirs });
  // Empty, the newest of what it may see: only what Datta's own chat kept.
  const guestEmpty = await call<Row[]>("memories:recall", { query: "", limit: 25, chat: theirs });
  check("scopeKept", !(outside?.memories ?? []).some((item: any) => /GREYHEX/.test(item.text))
    && (inside?.memories ?? []).some((item: any) => item.kind === "note" && /GREYHEX/.test(item.text))
    && guest.length === 0 && guestEmpty.length === 1 && guestEmpty[0].text === "Datta prefers WhatsApp voice notes." && !GUEST_TOOLS.some((name) => /note|page|brain/.test(name)),
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
  const prefer = await tool(general, "remember", { text: "Prefers replies in bullet points.", kind: "profile" });
  const about = pageOf("about");
  check("aboutMeIsUserMd", content(about).startsWith("# About Alex") && content(about).includes("## How I like things done") && sectionOf(about, "Prefers replies in bullet points.") === "How I like things done"
    && sectionOf(about, "Always answer in British English.") === "How I like things done"
    && lineOf("Prefers replies in bullet points.")?.kind === "profile" && /About me, How I like things done/.test(prefer?.note ?? ""),
  { about: content(about), prefer });
  await tool(general, "update_user_md", { text: `${content(pageOf("about")).trim()}\n- Has a cat called Miso.\n` });
  const persona = await call<{ user: string }>("persona:current");
  const history = await call<Array<{ text?: string }>>("persona:history", { kind: "user", limit: 10 });
  check("userMdAndPageAgree", content(pageOf("about")).includes("Has a cat called Miso.") && persona.user === content(pageOf("about")) && history[0]?.text?.includes("Has a cat called Miso.") === true
    && history.some((version) => version.text?.includes("Prefers replies in bullet points.")) && Boolean(lineOf("Has a cat called Miso.")),
  { historyCount: history.length });

  // USER.md written whole again, as the welcome page does, without the preferences: they stay, the same memories.
  await call("persona:writeUser", { text: `${userMd.trim()}\n- Has a cat called Miso.\n`, by: "owner" });
  const rewritten = pageOf("about");
  check("userMdRewriteKeepsPreferences", sectionOf(rewritten, "Always answer in British English.") === "How I like things done" && sectionOf(rewritten, "Prefers replies in bullet points.") === "How I like things done"
    && lineOf("Always answer in British English.")?._id === old.profile && content(rewritten).includes("Has a cat called Miso."), content(rewritten));

  // --- 9. Each memory lands on its page, in its section ---------------------------------------------------------------
  const blood = await tool(general, "remember", { text: "The owner's blood group is O+.", kind: "core" });
  const acme = await tool(general, "remember", { text: "Works at Acme as a designer.", kind: "core", section: "Work" });
  const brother = await tool(general, "remember", { text: "Datta is the owner's brother.", kind: "core", about: ["Datta"] });
  const dentist = await tool(general, "remember", { text: "Dentist call at 3pm on Friday.", kind: "daily", tags: ["open"] });
  const kept = await tool(general, "remember", { text: "Codename for this chat is HERON.", kind: "core", scope: "this chat" });
  const grout = await tool(inProject, "remember", { text: "Grout colour is warm grey.", kind: "core" });
  const remember = pageOf("remember", (row) => !row.projectId);
  const datta = pageOf("person", (row) => row.person === "datta");
  const today = dayOf(Date.now());
  const journal = pageOf("journal", (row) => !row.projectId && row.day === today);
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
    && followed?.supersededBy === undefined && /To-do: moved/.test(followed?.text ?? "") && content(pageOf("journal", (row) => !row.projectId && row.day === today)).includes("(To-do: moved")
    && rows("memories").filter((row) => /Dentist call at 3pm/.test(row.text) && !row.supersededBy).length === 1
    && content(pageOf("journal", (row) => !row.projectId && row.day === today)).includes("Alerted the owner at 06:10: Your 6:40 flight moved to 7:25.") && alerts.some((alert) => alert.includes("7:25"))
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

  // --- 14, 27. Memories from before pages stay: in their page, and in what a turn is sent ----------------------------------
  const olderListed = await call<Row[]>("dashboard:listMemories", { key: KEY, query: "" });
  const askCar = "What colour is my car again?";
  await exchange(general, askCar);
  const carSent = log().filter((entry) => entry.prompt && String(entry.context ?? "").includes("The owner's car is a blue Skoda.")).length > 0;
  const carPage = rows("notes").find((row) => row._id === M("car")?.pageId);
  check("movedMemoriesStillThere", olderListed.length === 0 && carPage?.kind === "remember" && carSent && String(carPage?.content).includes("The owner's car is a blue Skoda."),
    { olderListed: olderListed.map((item) => item.text), carSent });

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

  // A pinned page bigger than the budget, a share of the engine's window (#220; Grok's here, 44,800 characters, no longer
  // 32,000): it is sent condensed, and says where to read the rest; what comes first stays whole.
  const big = Array.from({ length: 640 }, (_, i) => `BIGLINE ${i} of a long plan, with enough words in it to fill a line of about a hundred characters.`).join("\n\n");
  const bigPlan = await call<string>("notes:create", { key: KEY, title: "Big plan", content: `${big}\n` });
  await pinPage(bigPlan, true);
  const overBudget = await fresh();
  const usage = await call<{ used: number; budget: number; left: string[] }>("pages:pinnedUsage", { key: KEY });
  const aboutPart = overBudget.instructions.slice(overBudget.instructions.indexOf("## About me"));
  // The parts measured here carry a little more than the budget counts: the recalled block's header, and what follows About me in the instructions.
  check("budgetKept", usage.budget === 44_800 && usage.used <= usage.budget && overBudget.standing.length <= usage.budget && overBudget.standing.length + aboutPart.length <= usage.budget + 1_500
    && overBudget.standing.includes("blue Skoda")
    && /\(condensed\)/.test(overBudget.standing) && overBudget.standing.includes('brain_read page="Big plan"') && overBudget.standing.split("BIGLINE").length - 1 < 640
    && overBudget.standing.includes("vegetarian") && overBudget.instructions.includes("Has a cat called Miso") && usage.left.some((title) => title.startsWith("Big plan")),
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

  // === Step 5: one Brain ============================================================================================
  // --- 30. The brain_* family, and the names from before ---------------------------------------------------------------
  // A chat of its own: the harness counts a chat's replies on its newest page of messages, which the general chat has filled.
  const brainChat = await call<string>("dashboard:createChat", { key: KEY });
  await onGrok(brainChat);
  const { CODEX_TOOLS, OLD_NAMES } = await import("../../convex/mcp");
  const listedAll = await tool(brainChat, "brain_list", {});
  const kindsListed = (listedAll?.notes ?? []).map((page: any) => page.kind ?? "page");
  const readRemember = await tool(brainChat, "brain_read", { page: "Things to remember" });
  const readDatta = await tool(brainChat, "brain_read", { page: "People/Datta" });
  const readToday = await tool(brainChat, "brain_read", { page: "today" });
  const readSection = await tool(brainChat, "brain_read", { page: "Things to remember", section: "Health" });
  const made = await tool(brainChat, "brain_write", { mode: "create", title: "Packing for Goa", content: "## Things\n\n- Sunscreen\n" });
  const goa = made?.created?.id as string;
  await tool(brainChat, "brain_append", { page: "Packing for Goa", section: "Clothes", content: "- Linen shirt" });
  const goaRead = await tool(brainChat, "brain_read", { page: goa });
  const replacedGoa = await tool(brainChat, "brain_write", { mode: "replace_section", page: goa, section: "Clothes", content: "- Two linen shirts", expectedRevision: goaRead?.revision });
  const pinnedGoa = await tool(brainChat, "brain_pin", { page: "Packing for Goa", pinned: true });
  const goaFresh = await fresh();
  await pinPage(goa, false);
  const searched = await tool(brainChat, "brain_search", { query: "linen shirts" });
  check("brainTools", ["About me", "Things to remember", "journal", "person", "page"].every((kind) => kindsListed.includes(kind))
    && /vegetarian/.test(readRemember?.content ?? "") && (readRemember?.lines ?? []).some((line: any) => /vegetarian/.test(line.text) && line.id && line.section === "Health")
    && readDatta?.title === "Datta" && readToday?.day === dayOf(Date.now()) && /^## Health/.test(readSection?.content ?? "") && !/## Work/.test(readSection?.content ?? "")
    && made?.created?.link === `/brain/${goa}` && /## Clothes\n\n- Two linen shirts/.test(String(noteRow(goa)?.content)) && Boolean(replacedGoa?.updated)
    && pinnedGoa?.pinned?.pinned === true && goaFresh.standing.includes("## Pinned: Packing for Goa")
    && (searched?.memories ?? []).some((item: any) => /linen shirts/.test(item.text)),
  { kindsListed, made: made?.created, goa: noteRow(goa)?.content, replaced: replacedGoa?.error, pinned: pinnedGoa, searched: searched?.memories?.map((item: any) => item.text) });

  const oldMemory = await tool(brainChat, "read_memory", { kind: "core" });
  const oldSearch = await tool(brainChat, "search_memory", { query: "vegetarian" });
  const oldList = await tool(brainChat, "list_notes", {});
  const oldRead = await tool(brainChat, "read_note", { id: "Lisbon trip" });
  const oldNotes = await tool(brainChat, "search_notes", { query: "Passport" });
  const oldCreate = await tool(brainChat, "create_note", { title: "Old habits", content: "Made with an old name." });
  const oldUpdate = await tool(brainChat, "update_note", { id: oldCreate?.created?.id, mode: "append", content: "And added to." });
  const aboutNow = String(pageOf("about")?.content ?? "").trim();
  const oldUser = await tool(brainChat, "update_user_md", { text: `${aboutNow}\n- Plays the guitar.\n` });
  check("oldNamesStillWork", (oldMemory?.memories ?? []).some((item: any) => /vegetarian/.test(item.text)) && (oldSearch?.memories ?? []).some((item: any) => /vegetarian/.test(item.text))
    && (oldList?.notes ?? []).some((page: any) => page.title === "Lisbon trip") && oldRead?.title === "Lisbon trip" && oldNotes?.found > 0
    && Boolean(oldCreate?.created) && /And added to/.test(String(noteRow(oldCreate?.created?.id)?.content)) && oldUser?.saved === true && /Plays the guitar/.test(String(pageOf("about")?.content))
    && ["brain_search", "brain_read", "brain_write", "brain_append", "brain_pin", "brain_list", "remember", "recall", "forget"].every((name) => CODEX_TOOLS.includes(name as never))
    && !OLD_NAMES.some((name) => CODEX_TOOLS.includes(name)),
  { advertised: CODEX_TOOLS.filter((name) => /brain|memor|note|recall|remember|forget|user_md/.test(name)), oldNames: OLD_NAMES });

  // --- 39, 40. remember with several people; a pinned person's page and recall send each memory once; Settings agrees -------
  const kiran = await tool(brainChat, "remember", { text: "Kiran and Juhi are starting a bakery.", kind: "core", about: ["Kiran", "Juhi"] });
  const kiranMemory = rows("memories").find((row) => row._id === kiran?.id);
  const juhiNow = await shownFor("Juhi");
  await pinPage(personPage("Juhi")!._id, true);
  const juhiFresh = await fresh();
  await pinPage(personPage("Juhi")!._id, false);
  const ids = [...juhiFresh.all.matchAll(/\(([a-z0-9]{20,})[;)]/g)].map((match) => match[1]);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  const recalled = await call<Row[]>("memories:recall", { query: "Juhi Aadil Vivek dinner cricket", limit: 25, chat: general });
  const people = await call<{ byContact: Record<string, Row[]>; pages: Record<string, string>; others: Array<{ name: string; pageId?: string }> }>("contacts:memoriesForDashboard", { key: KEY });
  const settingsPages = [...Object.values(people.pages), ...people.others.map((other) => other.pageId)].filter(Boolean).sort();
  check("rememberPeopleAndNothingTwice", Boolean(personPage("Kiran")) && kiranMemory?.pageId === personPage("Kiran")?._id && juhiNow.elsewhere.includes(kiran?.id)
    && juhiFresh.standing.includes("## Pinned: Juhi") && juhiFresh.standing.includes("Had dinner with Juhi, Aadil and Vivek.") && repeated.length === 0
    && new Set(recalled.map((item) => item.id)).size === recalled.length
    && JSON.stringify(settingsPages) === JSON.stringify(personPages().map((row) => row._id).sort()),
  { kiran: kiran?.note, repeated, settings: settingsPages.length, brain: personPages().length });

  // --- 31. A chat with someone else gets none of it ---------------------------------------------------------------------
  const guestTries = {
    list: await call<Row>("notes:listForAgent", { chat: theirs, memory: true }),
    read: await call<Row>("notes:readForAgent", { chat: theirs, id: "Things to remember" }),
    write: await call<Row>("notes:createForAgent", { chat: theirs, title: "GUESTPAGE", content: "x" }),
    append: await call<Row>("notes:updateForAgent", { chat: theirs, id: "About me", mode: "append", content: "GUESTLINE" }),
    pin: await call<Row>("notes:pinForAgent", { chat: theirs, id: "Things to remember", pinned: false }),
  };
  const guestTools: readonly string[] = GUEST_TOOLS;
  check("guestHasNoBrain", Object.values(guestTries).every((answer) => /cannot read or write them/.test(String(answer.error))) && guestTries.list.notes.length === 0
    && !guestTools.some((name) => name.startsWith("brain_") || OLD_NAMES.includes(name as never) && name !== "read_memory")
    && !rows("notes").some((row) => /GUESTPAGE|GUESTLINE/.test(`${row.title} ${row.content}`)) && isPinnedRow(pageOf("remember", (row) => !row.projectId)),
  { errors: Object.fromEntries(Object.entries(guestTries).map(([name, answer]) => [name, answer.error])), guestTools });

  // --- 32. No secrets in pages or memory --------------------------------------------------------------------------------
  await call("vault:save", { label: "Netflix", url: "https://netflix.com", username: "alex@example.com", value: "Tr0ub4dor-SECRET-77", by: "owner" });
  const savedSecret = await tool(brainChat, "remember", { text: "The owner's Netflix password is Tr0ub4dor-SECRET-77.", kind: "core" });
  const keyShaped = await tool(brainChat, "brain_append", { page: "Packing for Goa", content: "- API key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234" });
  const notedPassword = await tool(brainChat, "create_note", { title: "Wifi", content: "The wifi password is hunter2-house" });
  const leaked = rows("memories").some((row) => /Tr0ub4dor|sk-proj-ABCD|hunter2-house/.test(row.text)) || rows("notes").some((row) => /Tr0ub4dor|sk-proj-ABCD|hunter2-house/.test(row.content));
  check("noSecretsInPages", savedSecret?.stored === false && /Logins & secrets/.test(savedSecret?.note ?? "") && /save_secret/.test(keyShaped?.error ?? "") && /save_secret/.test(notedPassword?.error ?? "") && !leaked,
    { savedSecret: savedSecret?.note, keyShaped: keyShaped?.error, notedPassword: notedPassword?.error, leaked });

  // --- 33. What Perry is told ---------------------------------------------------------------------------------------------
  const told = (await fresh()).instructions;
  check("instructionsSayWhere", told.includes("their Brain") && told.includes("A memory is a line in a page") && told.includes("brain_pin") && told.includes("A chat with someone else has none of this")
    && told.includes("About me") && !told.includes("update_user_md") && !told.includes("list_notes"),
  told.slice(told.indexOf("Everything you know"), told.indexOf("Everything you know") + 1200));

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
  await waitFor(`${groupHas("Brain")} && document.querySelector('[data-recalled="core"]')?.innerText.includes("vegetarian")`, "a memory in search", 20_000);
  const memoryHit = await evaluate(`document.querySelector('[data-recalled="core"]').innerText`);
  await fill("[cmdk-input]", "passport");
  await waitFor(`document.querySelector('[data-recalled="page"]')?.innerText.includes("Passport")`, "a note's line in search", 20_000);
  await shot("search-memory-and-notes.png");
  const lineHit = await evaluate(`document.querySelector('[data-recalled="page"]').innerText`);
  await click('[data-recalled="page"]');
  await waitFor(`location.pathname === ${JSON.stringify(`/brain/${lisbon}`)}`, "the note to open from its line");
  await palette("eggs");
  await waitFor(`document.querySelector('[data-recalled="core"]')`, "the memory again", 20_000);
  await click('[data-recalled="core"]');
  // A memory is a line of its page now (step 2): it opens there.
  await waitFor(`location.pathname === ${JSON.stringify(`/brain/${pageOf("remember", (row) => !row.projectId)?._id}`)}`, "the memory to open in its page");
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
  await click('[aria-label="Page options"]');
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
  check("pinButtonAndUsage", /Two parts/.test(pinnedGroup) && /Lisbon trip/.test(pinnedGroup) && /Datta/.test(pinnedGroup) && /About me/.test(pinnedGroup) && /of 44,800 characters on Grok Build/.test(usageText),
    { pinnedGroup, usageText });

  // --- 28, 29, 34. The sidebar, old links, and the Brain page ------------------------------------------------------------
  await go("/chat");
  await waitFor(`document.querySelectorAll("[data-sidebar=menu-button]").length > 3`, "the sidebar");
  const sidebarItems = await evaluate(`[...document.querySelectorAll("[data-sidebar=menu-button]")].map((item) => item.innerText.trim()).filter(Boolean)`) as string[];
  await evaluate(`[...document.querySelectorAll("[data-sidebar=menu-button]")].find((item) => item.innerText.trim() === "Brain")?.click(); true`);
  await waitFor(`location.pathname === "/brain" && document.querySelector('section[aria-label="Memory pages"]') && document.querySelector('ul[aria-label="Pages"]')`, "Brain from the sidebar");
  await shot("brain.png");
  // Each page once: a journal day, Things to remember or a person is onBrain in its group, never again among the owner's pages.
  const onBrain = await evaluate(`(() => {
    const entries = [...document.querySelectorAll('section[aria-label="Memory pages"] a[href^="/brain/"], ul[aria-label="Pages"] a[href^="/brain/"], section[aria-label="Memory pages"] a[href^="/notes/"], ul[aria-label="Pages"] a[href^="/notes/"]')].map((a) => a.getAttribute("href"));
    const inPages = [...document.querySelectorAll('ul[aria-label="Pages"] li')].map((li) => li.innerText.split("\\n")[0].trim());
    return { entries, inPages };
  })()`) as { entries: string[]; inPages: string[] };
  const blocks = await evaluate(`({ lists: document.querySelectorAll('section[aria-label="Memory pages"]').length, teach: document.querySelectorAll('#memory-text').length })`) as { lists: number; teach: number };
  const memoryTitles = rows("notes").filter((row) => row.kind).map((row) => String(row.title));
  check("eachPageListedOnce", blocks.lists === 1 && blocks.teach === 0 && onBrain.entries.length > 0 && new Set(onBrain.entries).size === onBrain.entries.length && !onBrain.inPages.some((title) => memoryTitles.includes(title)),
    { blocks, onBrain: onBrain.entries.length, unique: new Set(onBrain.entries).size, memoryInPages: onBrain.inPages.filter((title) => memoryTitles.includes(title)) });
  const landed: Record<string, string> = {};
  const land = async (path: string, test: string, what: string) => { await go(path); await waitFor(test, what); landed[path] = await evaluate("location.pathname + location.search") as string; };
  const aboutPageId = pageOf("about")!._id;
  await land("/memory", `location.pathname === "/brain"`, "/memory to Brain");
  await land("/memory?q=vegetarian", `location.pathname === "/brain" && document.querySelector('[data-found]')?.innerText.includes("vegetarian")`, "a memory found from an old link");
  await shot("brain-search.png");
  await land("/memory?tab=about", `location.pathname === ${JSON.stringify(`/brain/${aboutPageId}`)}`, "About you to About me");
  await land("/about", `location.pathname === ${JSON.stringify(`/brain/${aboutPageId}`)} && document.querySelector("[data-note-editor]")`, "/about to About me");
  // Its earlier versions, opened.
  await evaluate(`[...document.querySelectorAll("button")].find((item) => item.innerText.trim() === "Earlier versions")?.click(); true`);
  await waitFor(`document.querySelector("[data-about-versions]")`, "About me's versions");
  await shot("about-me.png");
  await land("/notes", `location.pathname === "/brain"`, "/notes to Brain");
  await land(`/notes/${lisbon}`, `location.pathname === ${JSON.stringify(`/brain/${lisbon}`)} && document.querySelector("[data-note-editor]")?.innerText.includes("Passport")`, "an old note link");
  check("sidebarAndOldLinks", sidebarItems.includes("Brain") && !sidebarItems.includes("Memory") && !sidebarItems.includes("Notes") && Object.keys(landed).length === 6,
    { sidebarItems, landed });

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
  await go("/brain");
  await waitFor(`document.documentElement.classList.contains("dark") && document.querySelector('ul[aria-label="Pages"]')`, "dark Brain");
  await shot("brain-dark.png");
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  check("searchDarkAndDaily", swim.includes("daily") && swim.includes("page"), swim);
  check("noPageErrors", browser.errors.length === 0, browser.errors);

  // --- 26. Moving back, exactly as before; staying back on the next start; and moving in again ---------------------------
  const backupsBeforeUndo = readdirSync(join(p.home, "backups")).length;
  const undone = await call<{ movedBack: number; pagesDeleted: number; linesDropped: number }>("pages:undoMigration");
  // The project's memories went with the project when it was deleted (4b), as a project's memory does; the rest come back.
  const alive = Object.keys(expect).filter((name) => !seeds[name].projectId);
  const goneWithProject = Object.keys(expect).filter((name) => seeds[name].projectId).every((name) => !M(name));
  const notBack = alive.map((name) => ({ name, row: M(name) })).filter(({ name, row }) => !row || row.pageId || row.migratedAt || row.section || row.text !== seeds[name].text
    || KEPT.some((field) => field !== "text" && unchanged(name, field) && JSON.stringify(row[field] ?? null) !== JSON.stringify(seeds[name][field] ?? null))).map(({ name }) => name);
  const arjunGone = !rows("notes").some((row) => row.kind === "person" && row.person === "arjun");
  const pageLinesGone = !rows("memories").some((row) => row.kind === "page");
  const flagged = rows("installation")[0]?.memoriesInPages === "undone";
  const userAfter = await call<{ user: string }>("persona:current");
  const latestUser = (await call<Array<{ text?: string }>>("persona:history", { kind: "user", limit: 1 }))[0]?.text;
  p.stop(server);
  await sleep(2_000);
  await startServer();
  const stayedBack = alive.every((name) => !M(name)?.pageId);
  const backupsNow = readdirSync(join(p.home, "backups")).length - backupsBeforeUndo;
  check("undoMovesBack", undone.movedBack === alive.length && goneWithProject && notBack.length === 0 && arjunGone && pageLinesGone && flagged && stayedBack && backupsNow === 0
    && latestUser?.trim() === userAfter.user.trim(),
  { undone, notBack, arjunGone, pageLinesGone, flagged, stayedBack, backupsNow });
  const redo = await call<{ moved: number }>("pages:migrate", { again: true });
  // Where each goes again; a chat's page is named after the chat, which has been renamed since, so its title is left out.
  const placeOf = (name: string, from: Record<string, ReturnType<typeof at>>) => JSON.stringify({ ...from[name], page: from[name].kind === "chat" ? undefined : from[name].page });
  const redone = Object.fromEntries(Object.keys(old).map((name) => [name, at(name)]));
  const differ = alive.filter((name) => placeOf(name, redone) !== placeOf(name, places) || M(name)?._id !== old[name]);
  check("moveInAgain", redo.moved === alive.length && differ.length === 0 && !rows("installation")[0]?.memoriesInPages && !M("acme")?.pageId,
    { redo, differ });
  notes.realModelTurns = "none: every chat ran on the fake Grok agent";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  // What the engine and the server were doing when it stopped.
  notes.fakeLogTail = log().slice(-12).map((entry) => JSON.stringify(entry).slice(0, 600));
  notes.serverLogTail = p.logs.server.split("\n").slice(-40);
  check("completed", false);
}
process.exit(await p.finish() ? 0 : 1);
