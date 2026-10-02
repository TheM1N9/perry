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
  check("linesAreNotMemories", !memoryPage.some((memory) => memory.kind === "page") && memoryPage.length === 3 && count === 3
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
  const longTerms = log().filter((entry) => entry.prompt && String(entry.context ?? "").includes("## Long-term memory"))
    .map((entry) => { const text = String(entry.context); const at = text.indexOf("## Long-term memory"); const end = text.indexOf("\n## ", at + 5); return text.slice(at, end > 0 ? end : undefined); });
  check("turnGetsNoteParagraph", sent.includes("## Possibly relevant older memories and notes") && relevant.includes(`note "Lisbon trip", section "Packing"`)
    && relevant.includes("] Passport") && longTerms.length > 0 && longTerms.every((part) => !/Passport|GREYHEX|Tomatoes/.test(part)) && longTerms.some((part) => part.includes("vegetarian")),
  { relevant: relevant.slice(0, 600), longTerms: longTerms.map((part) => part.slice(0, 300)) });

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
  await waitFor(`location.pathname === "/memory" && location.search.includes("vegetarian")`, "the memory to open on the Memory page");
  check("searchFindsMemoryAndNotes", /vegetarian/.test(memoryHit) && /Long-term/.test(memoryHit) && /Passport/.test(lineHit) && /Lisbon trip › Packing/.test(lineHit), { memoryHit, lineHit });

  // --- 8. Dark, and no page errors -------------------------------------------------------------------------------------
  await evaluate(`localStorage.setItem("perry.theme", "dark"); true`);
  await palette("swim");
  await waitFor(`document.documentElement.classList.contains("dark") && document.querySelectorAll('[data-recalled]').length >= 2`, "dark search with a daily note and a note line", 20_000);
  const swim = await evaluate(`[...document.querySelectorAll('[data-recalled]')].map((item) => item.getAttribute("data-recalled"))`) as string[];
  await shot("search-memory-and-notes-dark.png");
  await key("Escape", "Escape", 27);
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  check("searchDarkAndDaily", swim.includes("daily") && swim.includes("page"), swim);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
  notes.realModelTurns = "none: every chat ran on the fake Grok agent";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  check("completed", false);
}
process.exit(await p.finish() ? 0 : 1);
