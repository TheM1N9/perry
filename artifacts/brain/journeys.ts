import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";
import { journalTitle } from "../../convex/lib/pages";

// bun artifacts/brain/journeys.ts <outDir>
// Issue #227: each project keeps one Journey (its running log, a heading a day, tagged with the project) instead of a
// journal page a day, and every chat of the owner's reads it. A fresh Perry from the production build (`pnpm build`
// first) on a spare port, its PERRY_HOME in PERRY_E2E_DIR (W:\perry-tests\project-journal on the owner's machine),
// the real runner, headless Chrome. No real model turn runs: every chat is on Grok played by the fake ACP agent,
// which calls Perry's tools on "TOOL" and logs what each prompt was sent; Codex and Claude Code are signed out in
// homes of their own, so the run stops if any real engine is signed in.
//
// Ways it could fail, written down before the checks.
// Moving an install's project journal days into Journeys (seeded as Perry left them before #227):
//   1. No backup is written first, or it misses the day pages or their lines.
//   2. A day's line lands in the wrong Journey, out of date order, under the wrong heading, or not at all; or two
//      projects' days end up in one Journey; or the owner's own journal days are touched.
//   3. Provenance is lost: a new id, or changed words, writer, chat, dates, tags, origin or source.
//   4. An emptied project day page stays, or a day page that still had lines is deleted.
//   5. It is not idempotent: a second start moves, writes or backs up anything again.
//   6. It cannot be undone: move-back leaves lines in the Journey, makes the days again with other ids, places,
//      headings or creation dates, leaves their lines readable outside the project, or Perry moves them in again on
//      the next start; move-in does not put them back as they were.
// Writing and reading:
//   7. A project chat's day note (remember, or brain_append "today") lands in the owner's journal, or not under
//      today's heading, newest last; or one from another chat naming the project goes elsewhere; or a wrong name
//      is saved anyway.
//   8. A chat outside the project cannot find the Journey (recall, brain_read "Journey · <project>", brain_list),
//      or a chat with someone else can (recall, pages, what it is sent).
//   9. The project's own chats are not sent its latest entries, or every other chat is sent them as pinned.
//  10. Things to remember in a project leaks outside it now that its Journey does not.
//  11. The owner's edit of the Journey loses who wrote a line, from which chat, or the line's id.
//  12. Brain does not list the Journeys with their project, the project's page does not show its Journey with its
//      newest entries, the Journey's page does not say whose it is and who reads it, or any page throws, light or dark.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/brain/journeys.ts <outDir>");
mkdirSync(outDir, { recursive: true });

let fakeHome = "";
const p = await perry({
  name: "journeys",
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
// The sentence model from the shared cache (PERRY_E2E_MODELS), so the run downloads nothing.
const MODELS = process.env.PERRY_E2E_MODELS ?? "W:/perry-tests/brain/models";
if (existsSync(join(MODELS, "onnx-community"))) cpSync(MODELS, join(p.home, "models"), { recursive: true });
const log = () => fakeLog(fakeHome);
type Row = Record<string, any> & { _id: string };

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
function seed(table: string, doc: Record<string, unknown>, id = `seed${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`): string {
  sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, ?)`, [id, table]);
  sql(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [id, Date.now(), JSON.stringify(doc)]);
  return id;
}
const note = (id: string) => rows("notes").find((row) => row._id === id);
const line = (id: string) => rows("memories").find((row) => row._id === id);
const journeyOf = (project: string) => rows("notes").find((row) => row.kind === "journey" && row.projectId === project);
const backups = () => (existsSync(join(p.home, "backups")) ? readdirSync(join(p.home, "backups")) : []);

let server: ReturnType<typeof p.start> | null = null;
const startServer = async () => {
  server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
};
const restart = async () => { p.stop(server); await sleep(2_000); await startServer(); };

try {
  await startServer();
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("persona:writeUser", { text: "# About Alex\n\n- Lives in Pune.\n", by: "owner" });
  const bathroom = await call<string>("projects:create", { key: KEY, name: "Bathroom" });
  const garden = await call<string>("projects:create", { key: KEY, name: "Garden" });
  const general = await call<string>("dashboard:createChat", { key: KEY });
  const inBathroom = await call<string>("dashboard:createChat", { key: KEY, projectId: bathroom });
  const inGarden = await call<string>("dashboard:createChat", { key: KEY, projectId: garden });
  const jid = "15550004444@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: jid, kind: "person", name: "Priya" }] });
  const priya = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: jid });
  const guestThread = await call<string>("agentStore:createThread", { userId: `whatsapp:${jid}`, title: "Priya" });
  const guest = await call<string>("conversations:create", { channel: "whatsapp", externalId: jid, threadId: guestThread, contactId: priya._id });

  // --- An install as Perry left it before #227: each project with journal pages a day, and the owner's own days ------
  // The owner's clock is this computer's from the start, as the runner sets it once it connects: days seeded now and days written later agree.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  sql(`UPDATE "doc_installation" SET doc = json_set(doc, '$.timezone', ?)`, [timezone]);
  notes.ownerTimezone = await call<string>("jobs:ownerTimezone");
  const DAY = 86_400_000;
  const now = Date.now();
  const dayOf = (at: number) => new Date(at).toLocaleDateString("en-CA", { timeZone: timezone });
  const [d3, d2, d1] = [dayOf(now - DAY * 3), dayOf(now - DAY * 2), dayOf(now - DAY)];
  type Seeded = { page: string; lines: Record<string, string>; docs: Record<string, Record<string, unknown>> };
  /** A journal day page as an older Perry left it, with its lines, each as remember or the owner's editor made it. */
  const oldDay = (day: string, projectId: string | undefined, entries: Array<{ key: string; text: string; section?: string; by: string; from?: string; at: number; tags?: string[]; origin?: string }>, extra: Record<string, unknown> = {}): Seeded => {
    let content = "";
    let section: string | undefined;
    for (const entry of entries) {
      if (entry.section && entry.section !== section) content += `${content ? "\n" : ""}## ${entry.section}\n\n`;
      section = entry.section;
      content += `- ${entry.text}\n`;
    }
    const page = seed("notes", {
      title: journalTitle(day), content, revision: 2, linesAt: 2, search: `${journalTitle(day)}\n\n${content}`, by: "assistant", kind: "journal", day,
      ...(projectId ? { projectId } : {}), createdAt: entries[0].at, updatedAt: entries.at(-1)!.at, ...extra,
    });
    const lines: Record<string, string> = {};
    const docs: Record<string, Record<string, unknown>> = {};
    entries.forEach((entry, order) => {
      docs[entry.key] = {
        text: entry.text, tags: entry.tags ?? [], source: entry.by === "owner" ? "page" : "web:dashboard", createdAt: entry.at, kind: "daily", day, pageId: page, order,
        ...(entry.section ? { section: entry.section } : {}), by: entry.by, ...(entry.from ? { from: entry.from } : {}), ...(projectId ? { projectId } : {}),
        ...(entry.origin ? { origin: entry.origin } : {}),
      };
      lines[entry.key] = seed("memories", docs[entry.key]);
    });
    return { page, lines, docs };
  };
  const b3 = oldDay(d3, bathroom, [
    { key: "tiles", text: "Tiles for the shower wall arrived, TILEWREN.", by: "assistant", from: inBathroom, at: now - DAY * 3, origin: "owner", tags: ["delivery"] },
    { key: "grout", text: "Chose warm grey grout.", by: "owner", at: now - DAY * 3 + 60_000, section: "Evening" },
  ]);
  const b1 = oldDay(d1, bathroom, [
    { key: "plumber", text: "Ravi the plumber fixed the shower valve, VALVEHERON.", by: "assistant", from: inBathroom, at: now - DAY, origin: "owner" },
  ], { pinned: false });
  const g2 = oldDay(d2, garden, [
    { key: "basil", text: "Planted basil by the south wall, BASILKITE.", by: "job", at: now - DAY * 2, origin: "job" },
  ]);
  const own = oldDay(d1, undefined, [
    { key: "swim", text: "Went for a long swim at the lake.", by: "assistant", from: general, at: now - DAY + 30_000, origin: "owner" },
  ]);
  const seededDocs = { ...b3.docs, ...b1.docs, ...g2.docs };
  const seededIds = { ...b3.lines, ...b1.lines, ...g2.lines };
  const ownBefore = note(own.page);

  // --- Before: Brain and the project's page as the old days left them -----------------------------------------------
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, ms = 30_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { let ok = false; try { ok = Boolean(${test}); } catch {} ok ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(`timed out: ${what}`)})) : setTimeout(tick, 150); }; tick(); })`);
  const go = async (path: string) => { await send("Page.navigate", { url: `${p.BASE}${path}` }); await sleep(1_500); };
  const machine = hostname();
  const shot = async (name: string) => {
    // This computer's name never goes into a picture.
    if (machine.length > 1) await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.split(${JSON.stringify(machine)}).join("THIS-PC"); return true; })()`);
    writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  await go("/brain");
  await waitFor(`document.querySelector('section[aria-label="Memory pages"] [data-memory-page="journal"]')`, "Brain before");
  await shot("brain-before.png");
  await go(`/projects/${bathroom}`);
  await waitFor(`document.querySelector('main section[aria-label="Brain"] [data-memory-page="journal"]')`, "the project's page before");
  await shot("project-before.png");

  // === Moving project days into Journeys, when Perry starts ========================================================
  await restart();
  const found = backups().filter((name) => name.startsWith("journals-before-journeys-"));
  const backup = found[0] ? JSON.parse(readFileSync(join(p.home, "backups", found[0]), "utf8")) : null;
  check("backupFirst", found.length === 1 && backup?.waiting === 3 && [b3.page, b1.page, g2.page].every((id) => backup.notes.some((row: Row) => row._id === id))
    && Object.values(seededIds).every((id) => backup.memories.some((row: Row) => row._id === id && row.projectId)),
  { found, waiting: backup?.waiting });

  const bj = journeyOf(bathroom);
  const gj = journeyOf(garden);
  const bText = String(bj?.content ?? "");
  const order = ["TILEWREN", "warm grey grout", "VALVEHERON"].map((words) => bText.indexOf(words));
  const headings = [bText.indexOf(`## ${journalTitle(d3)}`), bText.indexOf(`## ${journalTitle(d1)}`)];
  check("daysIntoTheirJourneys", Boolean(bj) && Boolean(gj) && bj!.title === "Journey" && headings[0] >= 0 && headings[0] < order[0] && order[0] < order[1] && order[1] < headings[1] && headings[1] < order[2]
    && String(gj?.content).includes(`## ${journalTitle(d2)}`) && String(gj?.content).includes("BASILKITE") && !bText.includes("BASILKITE") && !bText.includes("Evening")
    && [b3.page, b1.page, g2.page].every((id) => !note(id)) && rows("notes").filter((row) => row.kind === "journal" && row.projectId).length === 0,
  { bathroom: bText, garden: gj?.content });

  const KEPT = ["text", "by", "from", "createdAt", "tags", "origin", "source", "day", "kind"];
  const changed = Object.entries(seededIds).flatMap(([key, id]) => KEPT.filter((field) => JSON.stringify(line(id)?.[field] ?? null) !== JSON.stringify(seededDocs[key][field] ?? null)).map((field) => `${key}.${field}`));
  const placed = Object.entries(seededIds).map(([key, id]) => ({ key, page: line(id)?.pageId === (key === "basil" ? gj?._id : bj?._id), section: line(id)?.section, project: line(id)?.projectId ?? null, moved: line(id)?.journalMove }));
  check("provenanceKept", changed.length === 0 && placed.every((item) => item.page && item.project === null && item.moved?.day)
    && placed.find((item) => item.key === "grout")?.section === journalTitle(d3) && placed.find((item) => item.key === "grout")?.moved?.section === "Evening",
  { changed, placed });
  const ownAfter = note(own.page);
  check("ownJournalUntouched", ownAfter?.revision === ownBefore?.revision && ownAfter?.content === ownBefore?.content && line(own.lines.swim)?.pageId === own.page, { revision: [ownBefore?.revision, ownAfter?.revision] });

  const stable = () => JSON.stringify({
    lines: rows("memories").map((row) => [row._id, row.pageId, row.section, row.order, row.text, row.projectId]).sort(),
    pages: rows("notes").map((row) => [row._id, row.revision, row.content]).sort(),
  });
  const once = stable();
  const backupCount = backups().length;
  await restart();
  const again = await call<{ lines: number; pages: number }>("pages:moveJournals", {});
  check("idempotent", stable() === once && backups().length === backupCount && again.lines === 0 && again.pages === 0, { again, backups: backups().length - backupCount });

  // === Writing and reading ========================================================================================
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await sleep(3_000);
  const real = (await computers()).flatMap((item) => item.engines).filter((engine) => engine.signedIn && engine.kind !== "grok").map((engine) => engine.kind);
  notes.realEnginesSignedIn = real;
  if (real.length) throw new Error(`${real.join(", ")} is signed in for the test's runner; stopping before anything reaches a real model.`);
  for (const chat of [general, inBathroom, inGarden]) await onGrok(chat);

  const today = journalTitle(dayOf(Date.now()));
  const noted = await tool(inBathroom, "remember", { text: "Sealed the bathtub edge with silicone, SEALPIPIT.", kind: "daily" });
  const appended = await tool(inBathroom, "brain_append", { page: "today", content: "- Booked the electrician for Monday, SPARKTERN." });
  const fromGeneral = await tool(general, "remember", { text: "The bathroom mirror was delivered cracked, MIRRORDUNLIN.", kind: "daily", journey: "bathroom" });
  const wrongName = await tool(general, "remember", { text: "Something about the attic, ATTICNOPE.", kind: "daily", journey: "Attic" });
  const ownDay = await tool(general, "remember", { text: "Had lunch with Meera, LUNCHOWL.", kind: "daily" });
  const lasting = await tool(inBathroom, "remember", { text: "The bathroom budget is 4000 euros, BUDGETRAIL.", kind: "core" });
  const bNow = String(journeyOf(bathroom)?.content ?? "");
  const lineOf = (words: string) => rows("memories").find((row) => String(row.text).includes(words) && !row.supersededBy);
  const todayHeading = bNow.indexOf(`## ${today}`);
  const mainToday = rows("notes").find((row) => row.kind === "journal" && !row.projectId && row.day === dayOf(Date.now()));
  check("projectNotesGoInTheJourney", todayHeading > bNow.indexOf("VALVEHERON") && bNow.indexOf("SEALPIPIT") > todayHeading && bNow.indexOf("SPARKTERN") > bNow.indexOf("SEALPIPIT") && bNow.indexOf("MIRRORDUNLIN") > bNow.indexOf("SPARKTERN")
    && lineOf("SEALPIPIT")?.section === today && lineOf("SEALPIPIT")?.by === "assistant" && lineOf("SEALPIPIT")?.from === inBathroom && !lineOf("SEALPIPIT")?.projectId
    && lineOf("MIRRORDUNLIN")?.from === general && /Journey · Bathroom/.test(noted?.note ?? "") && /every chat/.test(noted?.note ?? "")
    && Boolean(appended?.updated) && noted?.stored === true && fromGeneral?.stored === true && wrongName?.stored === false && /no project called "Attic"/.test(wrongName?.note ?? "") && /"Bathroom"/.test(wrongName?.note ?? "")
    && !lineOf("ATTICNOPE") && String(mainToday?.content).includes("LUNCHOWL") && !/SEALPIPIT|SPARKTERN|MIRRORDUNLIN/.test(String(mainToday?.content ?? "")) && lineOf("BUDGETRAIL")?.projectId === bathroom,
  { journey: bNow, notes: [noted?.note, appended?.error, fromGeneral?.note, wrongName?.note, ownDay?.note, lasting?.note] });

  // --- Who reads it ------------------------------------------------------------------------------------------------
  const recalled = await tool(general, "recall", { query: "SEALPIPIT bathtub silicone" });
  const readOutside = await tool(general, "brain_read", { page: "Journey · Bathroom" });
  const listed = await tool(general, "brain_list", {});
  const fromGarden = await call<Row[]>("memories:recall", { query: "TILEWREN tiles shower wall", limit: 10, chat: inGarden });
  const budgetOutside = await call<Row[]>("memories:recall", { query: "BUDGETRAIL bathroom budget euros", limit: 10, chat: general });
  const guestRecall = await call<Row[]>("memories:recall", { query: "SEALPIPIT TILEWREN BASILKITE VALVEHERON MIRRORDUNLIN", limit: 25, chat: guest });
  const guestSearch = await call<Row[]>("memories:search", { query: "SEALPIPIT", chat: guest });
  const guestRead = await call<Row>("notes:readForAgent", { chat: guest, id: "Journey · Bathroom" });
  const guestList = await call<Row>("notes:listForAgent", { chat: guest, memory: true });
  const guestPrompt = Object.values(await call<Record<string, string>>("contacts:guestPrompt", { contactId: priya._id, conversationId: guest })).join("\n");
  const text = (value: unknown) => JSON.stringify(value ?? {});
  check("everyOwnerChatReadsIt", text(recalled).includes("SEALPIPIT") && text(recalled).includes("Journey · Bathroom") && String(readOutside?.content).includes("TILEWREN") && String(readOutside?.content).includes("SEALPIPIT")
    && readOutside?.title === "Journey · Bathroom" && (listed?.notes ?? []).some((page: any) => page.title === "Journey · Garden" && page.kind === "Journey")
    && fromGarden.some((item) => /TILEWREN/.test(item.text)) && !budgetOutside.some((item) => /BUDGETRAIL/.test(item.text)),
  { recalled: recalled?.memories?.map((item: any) => item.text), read: readOutside?.title, listed: (listed?.notes ?? []).map((page: any) => page.title), budgetOutside: budgetOutside.map((item) => item.text) });
  check("guestSeesNone", guestRecall.length === 0 && guestSearch.length === 0 && /cannot read or write them/.test(String(guestRead.error)) && guestList.notes.length === 0
    && !/SEALPIPIT|TILEWREN|BASILKITE|VALVEHERON|MIRRORDUNLIN|Journey/.test(guestPrompt),
  { guestRecall: guestRecall.map((item) => item.text), guestRead: guestRead.error, guestPrompt: guestPrompt.slice(-300) });

  // --- What each chat is sent ahead of a message -------------------------------------------------------------------
  const fresh = async (projectId?: string, prompt = "JOURNEYCHECK") => {
    const chat = await call<string>("dashboard:createChat", { key: KEY, ...(projectId ? { projectId } : {}) });
    await onGrok(chat);
    await exchange(chat, prompt);
    return contextOf(prompt);
  };
  const sentInProject = await fresh(bathroom, "JOURNEYCHECK in the bathroom");
  const sentOutside = await fresh(undefined, "JOURNEYCHECK outside");
  const sentGarden = await fresh(garden, "JOURNEYCHECK in the garden");
  const part = (sent: string) => { const at = sent.indexOf("## This project's Journey"); return at < 0 ? "" : sent.slice(at, sent.indexOf("\n## ", at + 5) > 0 ? sent.indexOf("\n## ", at + 5) : undefined); };
  // What goes as pinned, not what recall finds bearing on the message: every chat may read a Journey, and with the sentence
  // model at hand (PERRY_E2E_MODELS) recall can find one of its lines by meaning ("Possibly relevant").
  const pinnedOnly = (sent: string) => sent.split("\n## Possibly relevant")[0];
  check("projectChatsGetTheLatest", part(sentInProject).includes("SEALPIPIT") && part(sentInProject).includes("VALVEHERON") && !part(sentInProject).includes("TILEWREN")
    && !part(sentOutside) && !pinnedOnly(sentOutside).includes("SEALPIPIT") && !part(sentGarden).includes("SEALPIPIT") && !pinnedOnly(sentGarden).includes("VALVEHERON"),
  { inProject: part(sentInProject), outside: part(sentOutside).slice(0, 200), garden: part(sentGarden).slice(0, 300),
    elsewhere: [[sentOutside, "SEALPIPIT"], [sentGarden, "VALVEHERON"]].map(([sent, word]) => (sent.includes(word) ? sent.slice(Math.max(0, sent.lastIndexOf("\n## ", sent.indexOf(word))), sent.indexOf(word) + 40) : "")) });

  // --- The owner edits the Journey ----------------------------------------------------------------------------------
  const journey = journeyOf(bathroom)!;
  const before = Object.fromEntries(["TILEWREN", "SEALPIPIT", "MIRRORDUNLIN"].map((words) => [words, lineOf(words)]));
  const edited = String(journey.content).replace("Sealed the bathtub edge with silicone, SEALPIPIT.", "Sealed the bathtub edge with white silicone, SEALPIPIT.")
    .replace("- Booked the electrician for Monday, SPARKTERN.\n", "- Booked the electrician for Monday, SPARKTERN.\n- Paid the tiler, OWNERTYPED.\n");
  const saved = await call<{ ok: boolean }>("notes:save", { key: KEY, id: journey._id, expectedRevision: journey.revision, content: edited });
  const typed = lineOf("OWNERTYPED");
  const reworded = lineOf("white silicone");
  check("ownerEditKeepsProvenance", saved.ok && reworded?._id === before.SEALPIPIT?._id && reworded?.from === inBathroom && reworded?.section === today && Boolean(reworded?.editedAt)
    && lineOf("TILEWREN")?._id === before.TILEWREN?._id && lineOf("TILEWREN")?.by === "assistant" && lineOf("TILEWREN")?.from === inBathroom && lineOf("TILEWREN")?.createdAt === before.TILEWREN?.createdAt
    && lineOf("MIRRORDUNLIN")?._id === before.MIRRORDUNLIN?._id && lineOf("MIRRORDUNLIN")?.from === general
    && typed?.by === "owner" && typed?.day === dayOf(Date.now()) && typed?.kind === "daily" && !typed?.projectId,
  { reworded: reworded && { same: reworded._id === before.SEALPIPIT?._id, by: reworded.by, from: reworded.from === inBathroom }, typed: typed && { by: typed.by, day: typed.day, kind: typed.kind } });

  // === The dashboard, after ========================================================================================
  const shots: Record<string, unknown> = {};
  for (const scheme of ["light", "dark"] as const) {
    await evaluate(`localStorage.setItem("perry.theme", ${JSON.stringify(scheme)}); true`);
    await go("/brain");
    await waitFor(`document.documentElement.classList.contains("dark") === ${scheme === "dark"} && document.querySelector('ul[aria-label="Projects\\' journeys"] [data-memory-page="journey"]')`, `Brain's journeys, ${scheme}`);
    await sleep(500);
    shots[`brain-${scheme}`] = await evaluate(`(() => { const list = document.querySelector('ul[aria-label="Projects\\' journeys"]'); return { rows: [...list.querySelectorAll("li")].map((li) => li.innerText.replace(/\\s+/g, " ").trim()), chips: list.querySelectorAll("[data-project-chip]").length, journal: [...document.querySelectorAll('ul[aria-label="Journal"] li')].map((li) => li.innerText.replace(/\\s+/g, " ").trim()) }; })()`);
    await shot(`brain-after-${scheme}.png`);
    await go(`/projects/${bathroom}`);
    await waitFor(`document.documentElement.classList.contains("dark") === ${scheme === "dark"} && document.querySelector('main section[aria-label="Brain"] ul[aria-label="Journey"] [data-journey-line]')`, `the project's Journey, ${scheme}`);
    await sleep(500);
    shots[`project-${scheme}`] = await evaluate(`(() => { const list = document.querySelector('main section[aria-label="Brain"] ul[aria-label="Journey"]'); return { rows: list.querySelectorAll("a[data-memory-page='journey']").length, latest: [...list.querySelectorAll("[data-journey-line]")].map((li) => li.innerText.trim()), journalGroup: Boolean(document.querySelector('main section[aria-label="Brain"] ul[aria-label="Journal"]')) }; })()`);
    await shot(`project-after-${scheme}.png`);
    await go(`/brain/${journey._id}`);
    await waitFor(`document.querySelector("[data-note-editor]")?.innerText.includes("SEALPIPIT") && document.querySelector("[data-journey-note]")`, `the Journey's page, ${scheme}`);
    await sleep(500);
    shots[`page-${scheme}`] = await evaluate(`({ chip: document.querySelector("[data-project-chip]")?.innerText.trim(), note: document.querySelector("[data-journey-note]")?.innerText.trim(), readOnly: document.querySelector('input[aria-label="Title"]').readOnly })`);
    await shot(`journey-page-${scheme}.png`);
  }
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  const brainLight = shots["brain-light"] as { rows: string[]; chips: number; journal: string[] };
  const projectLight = shots["project-light"] as { rows: number; latest: string[]; journalGroup: boolean };
  const pageLight = shots["page-light"] as { chip: string; note: string; readOnly: boolean };
  check("dashboardShowsJourneys", brainLight.rows.length === 2 && brainLight.chips === 2 && brainLight.rows.some((row) => /Journey.*Bathroom/.test(row)) && brainLight.rows.some((row) => /Journey.*Garden/.test(row))
    && !brainLight.journal.some((row) => /Bathroom|Garden/.test(row))
    && projectLight.rows === 1 && !projectLight.journalGroup && projectLight.latest.length === 3 && projectLight.latest.some((item) => item.includes("MIRRORDUNLIN"))
    && pageLight.chip === "Bathroom" && /Every chat/.test(pageLight.note) && pageLight.readOnly,
  shots);
  check("noPageErrors", browser.errors.length === 0, browser.errors);

  // === Moving back, staying back, and moving in again ==============================================================
  const journeyIds = Object.fromEntries(["TILEWREN", "warm grey grout", "VALVEHERON", "BASILKITE", "SEALPIPIT", "MIRRORDUNLIN"].map((words) => [words, lineOf(words)?._id]));
  const undone = await call<{ journalLines: number }>("pages:undoMigration");
  const dayPage = (project: string, day: string) => rows("notes").find((row) => row.kind === "journal" && row.projectId === project && row.day === day);
  const back3 = dayPage(bathroom, d3);
  const backToday = dayPage(bathroom, dayOf(Date.now()));
  const outsideNow = await call<Row[]>("memories:recall", { query: "TILEWREN tiles shower wall", limit: 10, chat: general });
  const backChecks = {
    journeysGone: !journeyOf(bathroom) && !journeyOf(garden),
    d3: Boolean(back3) && line(journeyIds.TILEWREN!)?.pageId === back3?._id && line(journeyIds["warm grey grout"]!)?.section === "Evening"
      && String(back3?.content).indexOf("TILEWREN") < String(back3?.content).indexOf("## Evening") && back3?.createdAt === seededDocs.tiles.createdAt,
    d1: line(journeyIds.VALVEHERON!)?.pageId === dayPage(bathroom, d1)?._id && dayPage(bathroom, d1)?.pinned === false,
    garden: line(journeyIds.BASILKITE!)?.pageId === dayPage(garden, d2)?._id,
    today: Boolean(backToday) && line(journeyIds.SEALPIPIT!)?.pageId === backToday?._id && line(journeyIds.MIRRORDUNLIN!)?.pageId === backToday?._id,
    keptToProjects: Object.values(journeyIds).every((id) => line(id!)?.projectId) && line(journeyIds.BASILKITE!)?.projectId === garden && !outsideNow.some((item) => /TILEWREN/.test(item.text)),
    sameIds: Object.values(journeyIds).every((id) => Boolean(line(id!))),
    noMoveLeft: !rows("memories").some((row) => row.journalMove),
  };
  await restart();
  const stayedBack = !journeyOf(bathroom) && rows("notes").some((row) => row.kind === "journal" && row.projectId === bathroom) && !backups().some((name) => name.startsWith("journals-before-journeys-") && !found.includes(name));
  check("moveBackRestoresDays", undone.journalLines === 8 && Object.values(backChecks).every(Boolean) && stayedBack, { undone, backChecks, stayedBack });
  const redo = await call<{ journalLines?: number }>("pages:migrate", { again: true });
  const redone = journeyOf(bathroom);
  check("moveInAgain", (redo.journalLines ?? 0) === 8 && Boolean(redone) && String(redone?.content).includes("TILEWREN") && String(redone?.content).includes("SEALPIPIT")
    && line(journeyIds.TILEWREN!)?.pageId === redone?._id && !line(journeyIds.TILEWREN!)?.projectId && rows("notes").filter((row) => row.kind === "journal" && row.projectId).length === 0,
  { redo, content: redone?.content });
  notes.realModelTurns = "none: every chat ran on the fake Grok agent";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  notes.fakeLogTail = log().slice(-12).map((entry) => JSON.stringify(entry).slice(0, 600));
  notes.serverLogTail = p.logs.server.split("\n").slice(-40);
  check("completed", false);
}
process.exit(await p.finish() ? 0 : 1);
