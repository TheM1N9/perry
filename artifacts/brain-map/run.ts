import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";
import { GUEST_TOOLS } from "../../convex/lib/engines";
import type { BrainGraph } from "../../convex/lib/graph";
import { largeBrain } from "./seed";

// bun artifacts/brain-map/run.ts <outDir>
// Issue #225: Brain's map, Obsidian's graph view for Brain. A fresh Perry from the production build (`pnpm build`
// first) on a spare port, its PERRY_HOME in PERRY_E2E_DIR (W:\perry-tests\brain-map on the owner's machine), headless
// Chrome. No engine runs at all: there is no runner, so no Codex, Claude Code or Grok is reached. Two Brains, one after
// the other in the same Perry: one shaped like the owner's (About me, Things to remember and a project's, journal days
// naming people, people's pages, the owner's own pages linking each other, a chat with someone else), whose map is
// checked node for node and edge for edge; then a large synthetic one (~3,000 pages, ~20,000 edges, three years of
// journal) for time to first draw and frame rate while panning.
//
// Ways it could fail, written down before the checks.
// The data (brainMap.graph):
//   1. A page is missing from the map or shown twice, a project has no node, or a node has the wrong kind, day, project
//      or pinned mark (About me and Things to remember are pinned unless unpinned; a pinned page or section is marked).
//   2. A link in a page's words is missed: a [title](/brain/<id>) link, an old /notes/<id> link, one written out as a
//      full address; or one is invented: a link to a page that does not exist, or a page to itself.
//   3. A line about someone does not tie its journal day or page to their page, a line naming several people ties only
//      the first, or comma-separated names are taken for one person.
//   4. "Also about" is missed: a line on one person's page about another does not tie the two.
//   5. A project's pages are not tied to it.
//   6. Something ties pages that should not be: a superseded line, a line of a chat with someone else (whose people are
//      theirs, as People keeps them), a person's own lines tying them to themselves; or an edge is counted twice.
//   7. Anyone without the dashboard key reads the map, or a chat with someone else is offered it.
// The map on screen:
//   8. Brain opens on the map instead of the list, the toggle does not switch or does not keep the view in the address.
//   9. The canvas draws a different number of pages or links than the data has.
//  10. Hover does not name the page or light its neighbours; a click does not open the page; dragging a page does not
//      move it; search does not find and centre a page.
//  11. A filter does nothing or the wrong thing: kind, project (its pages and what they tie to), time, unlinked pages.
//  12. A page's local map shows the wrong neighbours, one step or two, or is missing.
//  13. Any page throws, in light or dark; colours ignore the theme.
// At scale:
//  14. Years of data are slow: the first draw takes seconds, panning drops frames, the layout blocks the page.
//  15. Zoomed out, journal days are not drawn a month to a dot; zoomed in, they do not come back.
//  16. The query reads every line (not only those naming someone), so it slows with every line ever written.
//  17. Zoomed out, a large map is a hairball: every page and link drawn at once, names piled on each other, the
//      journal a cloud of months in the middle; or zooming in does not bring the rest back.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/brain-map/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const MODELS = process.env.PERRY_E2E_MODELS ?? "W:/perry-tests/brain/models";

const p = await perry({ name: "brain-map", outDir, engine: null, runnerEnv: () => ({}) });
const { KEY, BASE, call, check, notes, until, sql, rows } = p;
type Row = Record<string, any> & { _id: string };
if (existsSync(join(MODELS, "Xenova"))) cpSync(MODELS, join(p.home, "models"), { recursive: true });

const DAY = 86_400_000;
const now = Date.now();
const dayOf = (ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);
const newId = () => { const a = "0123456789abcdefghjkmnpqrstvwxyz"; let id = ""; for (const b of randomBytes(26)) id += a[b % 32]; return id; };
function seed(table: string, doc: Record<string, unknown>): string {
  const id = newId();
  sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, ?)`, [id, table]);
  sql(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [id, Date.now(), JSON.stringify(doc)]);
  return id;
}
/** Many documents at once, in one transaction, through Node's SQLite (Bun has none); while the server is stopped. */
function bulk(docs: Array<{ table: string; id: string; doc: Record<string, unknown> }>) {
  const file = join(p.home, "bulk.json");
  writeFileSync(file, JSON.stringify(docs));
  const script = `const { DatabaseSync } = require("node:sqlite"); const fs = require("node:fs");
const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000"); const docs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ids = db.prepare('INSERT INTO "_ids" (id, tbl) VALUES (?, ?)'); const made = {}; db.exec("BEGIN"); let t = Date.now();
for (const { table, id, doc } of docs) { made[table] ??= db.prepare('INSERT INTO "doc_' + table + '" (_id, _creationTime, doc) VALUES (?, ?, ?)'); ids.run(id, table); made[table].run(id, t += 0.001, JSON.stringify(doc)); }
db.exec("COMMIT");`;
  const ran = spawnSync("node", ["-e", script, join(p.home, "perry.sqlite"), file], { encoding: "utf8", windowsHide: true });
  if (ran.status !== 0) throw new Error(`bulk insert: ${ran.stderr}`);
}
const startServer = async () => {
  const server = p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 180);
  return server;
};
const graphNow = () => call<BrainGraph>("brainMap:graph", { key: KEY });
/** An edge as "<title or id> | <title or id> | kind", the pair in a fixed order. */
const edgeKey = (a: string, b: string, kind: string) => `${[a, b].sort().join(" | ")} | ${kind}`;
const edgesOf = (graph: BrainGraph, name: (id: string) => string) => graph.edges.map(([a, b, kind]) => edgeKey(name(graph.nodes[a].id), name(graph.nodes[b].id), kind)).sort();
const uniquePairs = (graph: BrainGraph) => new Set(graph.edges.map(([a, b]) => `${Math.min(a, b)} ${Math.max(a, b)}`)).size;
const results: Record<string, unknown> = {};

let server: ReturnType<typeof p.start> | null = null;
try {
  server = await startServer();
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // --- An owner-shaped Brain ----------------------------------------------------------------------
  await call("persona:writeUser", { text: "# About Alex\n\n- **Call them:** Alex\n- Lives in Pune.\n", by: "owner" });
  const kitchen = await call<string>("projects:create", { key: KEY, name: "Kitchen" });
  // A chat with someone else (Priya on WhatsApp): what it keeps is its own, and its people are not the owner's.
  const guestJid = "15550002222@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: guestJid, kind: "person", name: "Priya" }] });
  const priya = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: guestJid });
  const priyaThread = await call<string>("agentStore:createThread", { userId: `whatsapp:${guestJid}`, title: "Priya" });
  const priyaChat = await call<string>("conversations:create", { channel: "whatsapp", externalId: guestJid, threadId: priyaThread, contactId: priya._id });
  // Memories as an install from before pages left them, then moved into pages as Perry does when it starts.
  const memory = (doc: Record<string, unknown>) => ({ tags: [], source: "telegram:4242", createdAt: now - DAY * 30, origin: "owner", ...doc });
  const daily = (ago: number, text: string, about?: string[], extra: Record<string, unknown> = {}) =>
    seed("memories", memory({ text, kind: "daily", day: dayOf(ago), createdAt: now - ago * DAY, ...(about ? { about } : {}), ...extra }));
  daily(1, "Coffee with Datta at Blue Tokai.", ["Datta"]);
  daily(1, "Called Manvi about her exam.", ["Manvi"]);
  daily(2, "Dinner with Juhi, Aadil and Vivek.", ["Juhi,Aadil,Vivek"]);
  const lunch = daily(3, "Lunch with Arjun.", ["Arjun"]);
  daily(3, "Went for a run.");
  daily(5, "Datta helped move the sofa.", ["Datta"]);
  daily(8, "Manvi's birthday.", ["Manvi"]);
  daily(12, "Quiet day at home.");
  daily(40, "Trip planning with Juhi.", ["Juhi"]);
  daily(400, "Met Arjun at the conference.", ["Arjun"]);
  daily(2, "The tiler came, with Datta.", ["Datta"], { projectId: kitchen });
  seed("memories", memory({ text: "Datta is the owner's plumber.", kind: "core", about: ["Datta"] }));
  seed("memories", memory({ text: "Vivek and Juhi are married.", kind: "core", about: ["Vivek", "Juhi"] }));
  seed("memories", memory({ text: "Manvi is the owner's sister.", kind: "core", about: ["Manvi"] }));
  seed("memories", memory({ text: "Prefers window seats.", kind: "core" }));
  seed("memories", memory({ text: "Likes coffee black.", kind: "profile" }));
  seed("memories", memory({ text: "Cabinets are matte green.", kind: "core", projectId: kitchen }));
  seed("memories", memory({ text: "Juhi owes Priya lunch.", kind: "core", about: ["Juhi"], conversationId: priyaChat, origin: "tool" }));
  await call("pages:migrate", {});
  await call("pages:fixPeople", {});
  // "Lunch with Arjun." was replaced: it stays for the record and ties nothing.
  sql(`UPDATE "doc_memories" SET doc = json_set(doc, '$.supersededBy', ?) WHERE _id = ?`, [lunch, lunch]);
  const person = (name: string) => rows("notes").find((row) => row.kind === "person" && row.person === name.toLowerCase())!;
  // The owner's own pages, linking each other.
  const packing = await call<string>("notes:create", { key: KEY, title: "Packing list", content: "- Passport\n- Charger\n" });
  const trip = await call<string>("notes:create", { key: KEY, title: "Goa trip", content: `Plan it with [Juhi](/brain/${person("Juhi")._id}). Pack from [Packing list](/brain/${packing}).\n\nAlso at http://127.0.0.1:7377/brain/${packing}.\n` });
  const reading = await call<string>("notes:create", { key: KEY, title: "Reading list", content: `From [the trip](/notes/${trip}). A page that is gone: [gone](/brain/zzzzzzzzzzzzzzzzzzzzzzzzzz). Itself: [here](/brain/PLACEHOLDER).\n` });
  const readingRow = rows("notes").find((row) => row._id === reading)!;
  await call("notes:save", { key: KEY, id: reading, content: readingRow.content.replace("PLACEHOLDER", reading), expectedRevision: readingRow.revision });
  const ideas = await call<string>("notes:create", { key: KEY, title: "Ideas", content: "A standing desk.\n" });
  const plan = await call<string>("notes:create", { key: KEY, title: "Kitchen plan", projectId: kitchen, content: `Ask [Datta](/brain/${person("Datta")._id}) about the pipes.\n` });
  await call("pages:pin", { key: KEY, id: trip, pinned: true });

  const pages = rows("notes");
  const graph = await graphNow();
  const byId = new Map(pages.map((row) => [row._id, row]));
  // A page by a name that says which it is: a journal day with its project, else its title.
  const name = (id: string) => {
    const row = byId.get(id);
    if (!row) return id === kitchen ? "project Kitchen" : id;
    if (row.kind === "journal") return `journal ${row.day}`;
    // A project's day notes go to its Journey (#229), not a journal day of its own.
    if (row.kind === "journey") return "Kitchen Journey";
    if (row.kind === "remember") return row.projectId ? "Kitchen Things to remember" : "Things to remember";
    if (row.kind === "chat") return "chat with Priya";
    return row.title;
  };
  const ids = graph.nodes.map((node) => node.id).sort();
  check("everyPageAndProjectOnce", JSON.stringify(ids) === JSON.stringify([...pages.map((row) => row._id), kitchen].sort()), { nodes: graph.nodes.length, pages: pages.length });
  const node = (id: string) => graph.nodes.find((item) => item.id === id);
  const kindsRight = pages.every((row) => node(row._id)?.kind === (row.kind ?? "page") && node(row._id)?.day === row.day && node(row._id)?.projectId === row.projectId)
    && node(kitchen)?.kind === "project";
  check("kindsDaysProjects", kindsRight, graph.nodes.map((item) => `${item.kind} ${name(item.id)}${item.projectId ? " (Kitchen)" : ""}`));
  const pinned = graph.nodes.filter((item) => item.pinned).map((item) => name(item.id)).sort();
  check("pinnedMarked", JSON.stringify(pinned) === JSON.stringify(["About me", "Goa trip", "Kitchen Things to remember", "Things to remember"]), pinned);
  const expected = [
    edgeKey("Goa trip", "Juhi", "link"), edgeKey("Goa trip", "Packing list", "link"), edgeKey("Reading list", "Goa trip", "link"), edgeKey("Kitchen plan", "Datta", "link"),
    edgeKey(`journal ${dayOf(1)}`, "Datta", "about"), edgeKey(`journal ${dayOf(1)}`, "Manvi", "about"),
    edgeKey(`journal ${dayOf(2)}`, "Juhi", "about"), edgeKey(`journal ${dayOf(2)}`, "Aadil", "about"), edgeKey(`journal ${dayOf(2)}`, "Vivek", "about"),
    edgeKey(`journal ${dayOf(5)}`, "Datta", "about"), edgeKey(`journal ${dayOf(8)}`, "Manvi", "about"),
    edgeKey(`journal ${dayOf(40)}`, "Juhi", "about"), edgeKey(`journal ${dayOf(400)}`, "Arjun", "about"),
    edgeKey("Kitchen Journey", "Datta", "about"),
    edgeKey("Vivek", "Juhi", "also"),
    edgeKey("Kitchen Things to remember", "project Kitchen", "project"), edgeKey("Kitchen Journey", "project Kitchen", "project"), edgeKey("Kitchen plan", "project Kitchen", "project"),
  ].sort();
  const actual = edgesOf(graph, name);
  check("edgesMatchTheData", JSON.stringify(actual) === JSON.stringify(expected), { missing: expected.filter((edge) => !actual.includes(edge)), extra: actual.filter((edge) => !expected.includes(edge)) });
  check("noEdgeFromSupersededOrGuestOrBrokenLinks", !actual.some((edge) => edge.includes(`journal ${dayOf(3)}`) || edge.includes("chat with Priya") || edge.includes("zzzz") || edge.startsWith("Reading list | Reading list")), actual);
  check("weights", graph.edges.every(([, , , weight]) => weight >= 1) && graph.edges.find(([a, b, kind]) => kind === "about" && [name(graph.nodes[a].id), name(graph.nodes[b].id)].includes("Datta") && [name(graph.nodes[a].id), name(graph.nodes[b].id)].includes(`journal ${dayOf(1)}`))?.[3] === 1);
  // Privacy: the key is needed, and a chat with someone else has no tool for it.
  const keyless = await fetch(`${BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "brainMap:graph", args: { key: "wrong" } }) }).then((r) => r.json() as Promise<{ error?: string; value?: unknown }>);
  check("ownerOnly", Boolean(keyless.error) && keyless.value === undefined && GUEST_TOOLS.every((tool) => !/map|graph|brain/i.test(tool)), keyless.error?.slice(0, 120));
  const local = await call<BrainGraph>("brainMap:graph", { key: KEY, around: person("Datta")._id, depth: 1 });
  check("localGraphQuery", JSON.stringify(local.nodes.map((item) => name(item.id)).sort()) === JSON.stringify(["Datta", `journal ${dayOf(1)}`, `journal ${dayOf(5)}`, "Kitchen Journey", "Kitchen plan"].sort()), local.nodes.map((item) => name(item.id)));
  results.ownerShaped = { nodes: graph.nodes.length, edges: graph.edges.length };

  // --- The map on screen -------------------------------------------------------------------------
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errors = []; { const e = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ").slice(0, 300)); e(...a); }; } addEventListener("error", (event) => window.__errors.push(String(event.message)));` });
  const pageErrors: Array<{ page: string; error: string }> = [];
  const collect = async (page: string) => { for (const error of (await evaluate(`window.__errors ?? []`).catch(() => [])) as string[]) pageErrors.push({ page, error }); await evaluate(`window.__errors = []; true`).catch(() => {}); };
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`(() => { try { return Boolean(${test}); } catch { return false; } })()`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const MACHINE = hostname();
  const shot = async (file: string) => {
    // The computer's name, wherever the dashboard shows it, is masked.
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = walk.nextNode());) n.nodeValue = n.nodeValue.split(${JSON.stringify(MACHINE)}).join("THIS-PC"); return true; })()`);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, file), Buffer.from(image.data, "base64"));
  };
  const go = async (path: string, test: string) => { await send("Page.navigate", { url: `${BASE}${path}` }); await waitFor(test, path); await sleep(500); };
  const mouse = (type: string, x: number, y: number, buttons = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  const CANVAS = `document.querySelector("canvas[data-brain-map]")`;
  const LOCAL = `document.querySelector("[data-local-map] canvas")`;
  /** Where a page is drawn, in the window's pixels. */
  const pointOf = (canvas: string, id: string) => evaluate(`(() => { const c = ${canvas}; const at = c.brainMap.screenOf(${JSON.stringify(id)}); if (!at) return null; const r = c.getBoundingClientRect(); return { x: r.left + at.x, y: r.top + at.y }; })()`) as Promise<{ x: number; y: number } | null>;
  const data = (canvas: string) => evaluate(`({ ...${canvas}.dataset })`) as Promise<Record<string, string>>;
  const settled = (canvas = CANVAS) => waitFor(`${canvas}?.dataset.settled === "true"`, "the layout to settle", 60);
  const click = async (expression: string) => {
    const at = await evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number } | null;
    if (!at) throw new Error(`nothing to click: ${expression}`);
    await mouse("mouseMoved", at.x, at.y);
    await mouse("mousePressed", at.x, at.y, 1);
    await mouse("mouseReleased", at.x, at.y);
    await sleep(400);
  };
  const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.innerText.trim() === ${JSON.stringify(text)})`;
  const where = () => evaluate(`location.pathname + location.search`) as Promise<string>;

  await scheme("light");
  await go("/brain", `document.querySelector('section[aria-label="Pages"]') && document.querySelector('section[aria-label="Memory pages"]')`);
  check("listIsTheDefault", !(await evaluate(`Boolean(${CANVAS})`)) && await evaluate(`Boolean(document.querySelector('section[aria-label="Memory pages"]'))`));
  await click(byText("[data-slot=toggle-group-item]", "Map"));
  await waitFor(CANVAS, "the map");
  check("toggleKeepsTheViewInTheAddress", (await where()) === "/brain?view=map");
  await settled();
  const shown = await data(CANVAS);
  const smallLabels = await evaluate(`(() => { const boxes = ${CANVAS}.brainMap.stats.labels; let n = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) n++; } return { labels: boxes.length, overlaps: n }; })()`) as { labels: number; overlaps: number };
  check("smallMapNamesAllWithoutOverlap", smallLabels.overlaps === 0 && smallLabels.labels >= 15 && Number((await data(CANVAS)).drawnNodes) === graph.nodes.length, smallLabels);
  check("canvasDrawsTheData", Number(shown.nodes) === graph.nodes.length && Number(shown.edges) === uniquePairs(graph), { canvas: shown, nodes: graph.nodes.length, pairs: uniquePairs(graph) });
  // Hover: Datta is named and its neighbours lit.
  const datta = person("Datta")._id;
  const dattaNeighbours = new Set(graph.edges.flatMap(([a, b]) => (graph.nodes[a].id === datta ? [b] : graph.nodes[b].id === datta ? [a] : []))).size;
  let at = await pointOf(CANVAS, datta);
  await mouse("mouseMoved", at!.x, at!.y);
  await sleep(300);
  let lit = await data(CANVAS);
  check("hoverNamesAndLightsNeighbours", lit.lit === "Datta" && Number(lit.litNeighbours) === dattaNeighbours, { lit: lit.lit, neighbours: lit.litNeighbours, expected: dattaNeighbours });
  await shot("map-light.png");
  // Drag: Ideas, tied to nothing, goes where it is dropped.
  const before = await pointOf(CANVAS, ideas);
  await mouse("mouseMoved", before!.x, before!.y);
  await mouse("mousePressed", before!.x, before!.y, 1);
  for (let i = 1; i <= 10; i++) { await mouse("mouseMoved", before!.x + i * 8, before!.y + i * 5, 1); await sleep(30); }
  await sleep(200);
  const during = await pointOf(CANVAS, ideas);
  await mouse("mouseReleased", before!.x + 80, before!.y + 50);
  check("dragMovesAPage", Math.hypot(during!.x - (before!.x + 80), during!.y - (before!.y + 50)) < 6, { before, during });
  check("dragDoesNotOpen", (await where()) === "/brain?view=map");
  // Click opens the page.
  await settled();
  at = await pointOf(CANVAS, packing);
  await mouse("mouseMoved", at!.x, at!.y);
  await mouse("mousePressed", at!.x, at!.y, 1);
  await mouse("mouseReleased", at!.x, at!.y);
  await until(async () => (await where()) === `/brain/${packing}`, "the page to open", 15).catch(() => {});
  check("clickOpensThePage", (await where()) === `/brain/${packing}`, await where());
  await collect("map-light");

  // Search finds and centres a page.
  await go("/brain?view=map", CANVAS);
  await settled();
  await click(`document.querySelector('input[aria-label="Find in map"]')`);
  await send("Input.insertText", { text: "Manv" });
  await waitFor(`document.querySelector('[data-found-node="${person("Manvi")._id}"]')`, "Manvi in the results");
  await click(`document.querySelector('[data-found-node="${person("Manvi")._id}"]')`);
  await sleep(400);
  const centre = await evaluate(`(() => { const r = ${CANVAS}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
  at = await pointOf(CANVAS, person("Manvi")._id);
  const found = await data(CANVAS);
  check("searchFindsAndCentres", found.lit === "Manvi" && Math.hypot(at!.x - centre.x, at!.y - centre.y) < 40, { lit: found.lit, at, centre });
  await shot("map-search-light.png");

  // Filters.
  const count = async () => Number((await data(CANVAS)).nodes);
  const journals = graph.nodes.filter((item) => item.kind === "journal").length;
  await go("/brain?view=map", CANVAS);
  await settled();
  await click(`document.querySelector('[data-kind="journal"]')`);
  const noJournal = await count();
  await shot("map-filters-light.png");
  await click(`document.querySelector('[data-kind="journal"]')`);
  const journalBack = await count();
  check("filterByKind", noJournal === graph.nodes.length - journals && journalBack === graph.nodes.length, { noJournal, journals, all: graph.nodes.length });
  await click(`document.querySelector('[aria-label="Project"]')`);
  await click(byText("[role=option]", "Kitchen"));
  const inKitchen = await count();
  check("filterByProject", inKitchen === 5, { inKitchen, expected: "Kitchen, its Things to remember, its journal day, Kitchen plan, and Datta they tie to" });
  await shot("map-project-light.png");
  await click(`document.querySelector('[aria-label="Project"]')`);
  await click(byText("[role=option]", "All projects"));
  await click(`document.querySelector('[aria-label="Time"]')`);
  await click(byText("[role=option]", "Past week"));
  const week = await count();
  const olderDays = pages.filter((row) => row.kind === "journal" && row.day < dayOf(7)).length;
  check("filterByTime", week === graph.nodes.length - olderDays, { week, olderDays });
  await click(`document.querySelector('[aria-label="Time"]')`);
  await click(byText("[role=option]", "Any time"));
  await click(`document.querySelector('[aria-label="Pages with no links"]')`);
  const tied = await count();
  const degree = new Map<number, number>();
  for (const [a, b] of graph.edges) { degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1); }
  const orphans = graph.nodes.filter((_, i) => !degree.get(i)).map((item) => name(item.id));
  check("unlinkedOff", tied === graph.nodes.length - orphans.length && orphans.includes("Ideas") && orphans.includes("chat with Priya") && orphans.includes(`journal ${dayOf(3)}`), { tied, orphans });
  await collect("filters-light");

  // A person's local map, one step and two.
  await go(`/brain/${datta}`, LOCAL);
  await settled(LOCAL);
  const one = await data(LOCAL);
  const two = await call<BrainGraph>("brainMap:graph", { key: KEY, around: datta, depth: 2 });
  check("localMapOneStep", Number(one.nodes) === local.nodes.length && Number(one.edges) === uniquePairs(local), { canvas: one, nodes: local.nodes.length });
  await evaluate(`document.querySelector("[data-local-map]").scrollIntoView({ block: "center" }); true`);
  await sleep(300);
  await shot("local-map-datta-light.png");
  await click(`[...document.querySelectorAll("[data-local-map] [data-slot=toggle-group-item]")].find((el) => el.innerText.includes("2"))`);
  await waitFor(`Number(${LOCAL}.dataset.nodes) === ${two.nodes.length}`, "two steps out", 20).catch(() => {});
  await settled(LOCAL);
  const twoShown = await data(LOCAL);
  // Two steps: through the journal days to the people met there, but not through Kitchen to all of its pages.
  check("localMapTwoSteps", Number(twoShown.nodes) === two.nodes.length && two.nodes.some((item) => name(item.id) === "Manvi") && two.nodes.some((item) => item.id === kitchen), { canvas: twoShown, nodes: two.nodes.map((item) => name(item.id)) });
  await shot("local-map-datta-2-light.png");
  // A local map's page opens another.
  await evaluate(`${LOCAL}.scrollIntoView({ block: "center" }); true`);
  at = await pointOf(LOCAL, plan);
  await mouse("mouseMoved", at!.x, at!.y);
  await mouse("mousePressed", at!.x, at!.y, 1);
  await mouse("mouseReleased", at!.x, at!.y);
  await until(async () => (await where()) === `/brain/${plan}`, "Kitchen plan to open", 15).catch(() => {});
  check("localMapOpensAPage", (await where()) === `/brain/${plan}`, await where());
  await go(`/brain/${ideas}`, `document.querySelector("[data-note-editor]")`);
  await sleep(1_500);
  check("noLocalMapForAPageTiedToNothing", !(await evaluate(`Boolean(document.querySelector("[data-local-map]"))`)));
  await collect("local-light");

  // Dark.
  await scheme("dark");
  await go("/brain?view=map", CANVAS);
  await settled();
  at = await pointOf(CANVAS, person("Juhi")._id);
  await mouse("mouseMoved", at!.x, at!.y);
  await sleep(300);
  const darkPixel = await evaluate(`({ bg: getComputedStyle(document.body).backgroundColor, dark: document.documentElement.classList.contains("dark") })`) as { bg: string; dark: boolean };
  check("darkTheme", darkPixel.dark, darkPixel);
  await shot("map-dark.png");
  await go(`/brain/${person("Juhi")._id}`, LOCAL);
  await settled(LOCAL);
  await evaluate(`document.querySelector("[data-local-map]").scrollIntoView({ block: "center" }); true`);
  await sleep(300);
  await shot("local-map-juhi-dark.png");
  await collect("dark");
  await scheme("light");

  // --- A large Brain: three years ----------------------------------------------------------------
  p.stop(server);
  await sleep(2_000);
  const { docs, summary } = largeBrain(now);
  bulk(docs);
  notes.largeSeeded = summary;
  server = await startServer();

  // The query, three times: the first waits for what Perry does as it starts; the others are what each change costs.
  const queryMs: number[] = [];
  let large: BrainGraph = { nodes: [], edges: [], projects: [] };
  for (let i = 0; i < 3; i++) { const began = performance.now(); large = await graphNow(); queryMs.push(Math.round(performance.now() - began)); }
  const allLines = sql<{ n: number }>(`SELECT count(*) AS n FROM "doc_memories"`)[0].n;
  const aboutLines = sql<{ n: number }>(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.about') >= ''`)[0].n;
  const explain = spawnSync("node", ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all("")));`,
    join(p.home, "perry.sqlite"), `EXPLAIN QUERY PLAN SELECT _id, _creationTime, doc FROM "doc_memories" WHERE json_extract(doc, '$.about') >= ? ORDER BY json_extract(doc, '$.about') ASC, _creationTime ASC`], { encoding: "utf8", windowsHide: true });
  const plan16 = (JSON.parse(explain.stdout || "[]") as Array<{ detail: string }>).map((row) => row.detail).join("; ");
  check("queryUsesTheAboutIndex", /i_memories_by_about/.test(plan16), plan16);
  check("largeGraphShape", large.nodes.length >= 3000 && large.edges.length >= 18_000, { nodes: large.nodes.length, edges: large.edges.length, pairs: uniquePairs(large) });
  results.large = { nodes: large.nodes.length, edges: large.edges.length, pairs: uniquePairs(large), queryMs, lines: allLines, linesNamingSomeone: aboutLines };

  // Time to first draw, and to settle, from the navigation.
  await go("/brain", `document.querySelector('section[aria-label="Pages"]')`);
  await send("Page.navigate", { url: `${BASE}/brain?view=map` });
  await waitFor(`${CANVAS}?.brainMap?.stats.firstDraw > 0`, "the large map's first draw", 60);
  const firstDraw = await evaluate(`Math.round(${CANVAS}.brainMap.stats.firstDraw)`) as number;
  const dataAt = await evaluate(`Math.round(${CANVAS}.brainMap.stats.dataAt)`) as number;
  // While it lays out, the page stays free: a frame probe records the gaps between frames until it settles.
  await evaluate(`(() => { window.__gaps = []; let last = performance.now(); const tick = (now) => { window.__gaps.push(now - last); last = now; if (${CANVAS}?.dataset.settled !== "true") requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
  await settled();
  const settledAt = await evaluate(`Math.round(performance.now())`) as number;
  const gaps = (await evaluate(`window.__gaps`) as number[]).sort((a, b) => a - b);
  const whileLayingOut = { frames: gaps.length, frameMsP50: Math.round(gaps[Math.floor(gaps.length / 2)] ?? 0), frameMsP95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0), longestMs: Math.round(gaps.at(-1) ?? 0) };
  const big = await data(CANVAS);
  check("largeCanvasDrawsTheData", Number(big.nodes) === large.nodes.length && Number(big.edges) === uniquePairs(large), { canvas: big });
  check("zoomedOutJournalByMonth", big.view === "months" && Number(big.drawnNodes) < large.nodes.length - 900, { view: big.view, drawn: big.drawnNodes });
  // Readable at the default zoom: the hubs and most-tied pages only (150, the months and projects among them), at most
  // 1,200 links (graph-view.tsx, EDGE_BUDGET: past that, on a map this size, lines read as a grey fill), no name over another.
  const overlaps = async (canvas: string) => evaluate(`(() => { const boxes = ${canvas}.brainMap.stats.labels; let n = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) n++; } return { labels: boxes.length, overlaps: n }; })()`) as Promise<{ labels: number; overlaps: number }>;
  const atFit = await overlaps(CANVAS);
  results.readableAtFit = { drawnNodes: Number(big.drawnNodes), drawnEdges: Number(big.drawnEdges), ...atFit };
  check("largeMapReadableAtDefaultZoom", Number(big.drawnNodes) <= 150 && Number(big.drawnEdges) <= 1200 && atFit.overlaps === 0 && atFit.labels >= 20, results.readableAtFit);
  await shot("large-map-light.png");

  /** Pan for two seconds, a move every frame, and read how long frames took. */
  const pan = async () => {
    const box = await evaluate(`(() => { const r = ${CANVAS}.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`) as { x: number; y: number; w: number; h: number };
    // From a spot with no page under it, so it pans rather than drags.
    const spot = await evaluate(`(() => { const c = ${CANVAS}; for (let y = 10; y < c.clientHeight; y += 17) for (let x = 10; x < c.clientWidth / 2; x += 23) if (!c.brainMap.nodeAt(x, y)) return { x, y }; return { x: 10, y: 10 }; })()`) as { x: number; y: number };
    const sx = box.x + spot.x;
    const sy = box.y + spot.y;
    await evaluate(`${CANVAS}.brainMap.stats.frames.length = 0; ${CANVAS}.brainMap.stats.draws.length = 0; true`);
    // The moves come from the page itself, one a frame, as a hand on a trackpad would: what is measured is the map,
    // not how fast the DevTools protocol delivers events.
    await evaluate(`new Promise((resolve) => {
      const c = ${CANVAS}; const r = c.getBoundingClientRect(); const x0 = r.left + ${spot.x}, y0 = r.top + ${spot.y};
      const at = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 7, pointerType: "mouse", bubbles: true }));
      at("pointerdown", x0, y0); let step = 0; const start = performance.now();
      const move = (now) => { step++; at("pointermove", x0 + Math.sin(step / 10) * 150 + 150, y0 + Math.cos(step / 10) * 100 + 100); if (now - start < 2000) requestAnimationFrame(move); else { at("pointerup", x0, y0); resolve(true); } };
      requestAnimationFrame(move);
    })`);
    void sx; void sy;
    const stats = await evaluate(`(() => { const s = ${CANVAS}.brainMap.stats; return { frames: [...s.frames], draws: [...s.draws], drawn: s.drawn }; })()`) as { frames: number[]; draws: number[]; drawn: { nodes: number; edges: number; months: boolean } };
    const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
    const pct = (list: number[], q: number) => { const s = sorted(list); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))] * 10) / 10 : 0; };
    // The first interval runs from before the pan began.
    const frames = stats.frames.slice(1);
    return {
      frames: frames.length, fps: frames.length ? Math.round(1000 / pct(frames, 0.5)) : 0, longFrames: frames.filter((ms) => ms > 34).length,
      frameMsP50: pct(frames, 0.5), frameMsP95: pct(frames, 0.95), drawMsP50: pct(stats.draws, 0.5), drawMsP95: pct(stats.draws, 0.95), drawn: stats.drawn,
    };
  };
  const panOut = await pan();
  // Zoom in on the person met most (the middle of the people and the timeline) until days are pages again, and pan there.
  const largeDegree = new Map<number, number>();
  for (const [a, b] of large.edges) { largeDegree.set(a, (largeDegree.get(a) ?? 0) + 1); largeDegree.set(b, (largeDegree.get(b) ?? 0) + 1); }
  const most = large.nodes.map((item, i) => ({ item, n: largeDegree.get(i) ?? 0 })).filter(({ item }) => item.kind === "person").sort((a, b) => b.n - a.n)[0].item;
  const rect = await evaluate(`(() => { const r = ${CANVAS}.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: Math.min(r.bottom, innerHeight) }; })()`) as { left: number; top: number; right: number; bottom: number };
  const target = await pointOf(CANVAS, most.id);
  const box = target && target.x > rect.left && target.x < rect.right && target.y > rect.top && target.y < rect.bottom
    ? target : { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  for (let i = 0; i < 40 && (await data(CANVAS)).view === "months"; i++) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -240 }); await sleep(60); }
  await sleep(300);
  const zoomed = await data(CANVAS);
  const atZoom = await overlaps(CANVAS);
  results.zoomedIn = { drawnNodes: Number(zoomed.drawnNodes), drawnEdges: Number(zoomed.drawnEdges), ...atZoom };
  check("zoomedInJournalDaysComeBack", zoomed.view === "pages", zoomed.view);
  check("zoomingInRevealsMore", Number(zoomed.drawnNodes) > Number(big.drawnNodes) && atZoom.overlaps === 0, results.zoomedIn);
  await shot("large-map-zoomed-light.png");
  const panIn = await pan();
  results.performance = { dataMs: dataAt, firstDrawMs: firstDraw, drawAfterDataMs: firstDraw - dataAt, settledMs: settledAt, whileLayingOut, panZoomedOut: panOut, panZoomedIn: panIn };
  // From the navigation: the page loads, the query answers (most of it: reading every line that names someone), and the
  // map draws as soon as the first slice of layout is back.
  check("drawsSoonAfterTheData", firstDraw - dataAt < 1_000, { dataAt, firstDraw });
  // A frame's drawing takes a millisecond or two; a frame can still run long when the machine is busy elsewhere (other
  // checks building beside this one), so a few are allowed: one in ten.
  check("panningSmooth", [panOut, panIn].every((run) => run.fps >= 50 && run.longFrames <= run.frames * 0.1 && run.drawMsP95 < 16), { panOut, panIn });
  check("layoutOffTheMainThread", whileLayingOut.frameMsP95 < 50, whileLayingOut);
  await scheme("dark");
  await go("/brain?view=map", CANVAS);
  await waitFor(`${CANVAS}?.brainMap?.stats.firstDraw > 0`, "the dark large map", 60);
  await settled();
  await shot("large-map-dark.png");
  await collect("large");
  check("noPageErrors", pageErrors.length === 0 && browser.errors.length === 0, { pageErrors, thrown: browser.errors });
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  check("completed", false);
}
process.exit(await p.finish(results) ? 0 : 1);
