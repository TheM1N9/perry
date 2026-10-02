import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { FAKE_AGENT, perry, REPO, sleep } from "../engine-acp/harness";
import { GUEST_TOOLS } from "../../convex/lib/engines";
import type { BrainGraph } from "../../convex/lib/graph";

// bun artifacts/brain-links/run.ts <outDir>
// Issue #230, parts 1 and 2: Perry uses Brain's map (#225). brain_neighbors shows what a page is tied to and why, from
// the same graph the Map draws; recall brings in the pages one step from its best hits; brain_link ties two pages with a
// link in each one's Related section, which the owner sees and the map draws. A fresh Perry from the production build
// (`pnpm build` first) on a spare port, PERRY_HOME in PERRY_E2E_DIR (W:\perry-tests\brain-links on the owner's machine),
// the real runner and headless Chrome. Every chat runs on Grok played by the fake ACP agent (artifacts/engine-acp/
// fake-agent.ts), which calls Perry's tools over MCP on "TOOL"; Codex and Claude Code are signed out in homes of their own.
//
// Ways it could fail, written down before the checks.
//   1. brain_neighbors is not served over MCP to the owner's chats, or finds the page by id but not by name.
//   2. A neighbour is missing (a journal day that mentions the person, a page linking them, their project) or invented,
//      two steps out does not go one further, or a neighbour comes without why it is one.
//   3. It shows what the chat may not reach: another project's pages, a chat's own page from another chat.
//   4. brain_link writes the link to one page only, outside a Related section, twice when asked twice, or over a page
//      changed since the revision Perry read; or the link does not show on the map.
//   5. recall does not bring in a page linked to its best hits, or brings in one the chat may not reach.
//   6. A chat with someone else is offered either tool, or reaches the owner's pages through them.
//   7. The instructions do not say when to link or to make a page for a topic that keeps coming up.
//   8. The page's Related section or the map after linking throws or looks wrong, in light or dark.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/brain-links/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

let fakeHome = "";
const p = await perry({
  name: "brain-links",
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
const { KEY, BASE, call, check, notes, until, sql, rows, exchange, fakeLog } = p;
type Row = Record<string, any> & { _id: string };
const DAY = 86_400_000;
const now = Date.now();

function toolAnswer(name: string, args: object): any {
  const entry = fakeLog(fakeHome).filter((item) => item.mcp && item.tool === name && JSON.stringify(item.args) === JSON.stringify(args)).at(-1);
  if (!entry) return undefined;
  const text = JSON.parse(entry.answer).result?.content?.[0]?.text ?? "null";
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && "untrusted" in value ? value.result : value;
  } catch {
    return { raw: text };
  }
}
async function tool(chat: string, name: string, args: object) {
  await exchange(chat, `TOOL ${name} ${JSON.stringify(args)}`);
  return toolAnswer(name, args);
}
function seed(table: string, doc: Record<string, unknown>): string {
  const id = `seed${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, ?)`, [id, table]);
  sql(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [id, Date.now(), JSON.stringify(doc)]);
  return id;
}

try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await p.computers()).some((computer) => computer.online && computer.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok", 120);

  // An owner-shaped Brain: journal days naming Juhi and Datta, their pages, a trip page and a packing list, a project.
  const timezone = await call<string>("jobs:ownerTimezone");
  const dayOf = (ago: number) => new Date(now - ago * DAY).toLocaleDateString("en-CA", { timeZone: timezone });
  const kitchen = await call<string>("projects:create", { key: KEY, name: "Kitchen" });
  const memory = (doc: Record<string, unknown>) => ({ tags: [], source: "telegram:4242", createdAt: now - DAY * 30, origin: "owner", ...doc });
  seed("memories", memory({ text: "Dinner with Juhi at the Goan place.", kind: "daily", day: dayOf(2), createdAt: now - 2 * DAY, about: ["Juhi"] }));
  seed("memories", memory({ text: "Juhi suggested Goa for December.", kind: "daily", day: dayOf(9), createdAt: now - 9 * DAY, about: ["Juhi"] }));
  seed("memories", memory({ text: "Datta fixed the sink.", kind: "daily", day: dayOf(4), createdAt: now - 4 * DAY, about: ["Datta"] }));
  seed("memories", memory({ text: "Juhi is the owner's oldest friend.", kind: "core", about: ["Juhi"] }));
  seed("memories", memory({ text: "Cabinets are matte green.", kind: "core", projectId: kitchen }));
  await call("pages:migrate", {});
  await call("pages:fixPeople", {});
  const person = (name: string) => rows("notes").find((row) => row.kind === "person" && row.person === name.toLowerCase())!;
  const juhi = person("Juhi")._id;
  const trip = await call<string>("notes:create", { key: KEY, title: "Goa trip", content: "## Plan\n\n- Fly on 20 Dec\n- Beach shack in Palolem\n" });
  const packing = await call<string>("notes:create", { key: KEY, title: "Packing list", content: `- Sunscreen\n- [Goa trip](/brain/${trip})\n` });
  const kitchenPlan = await call<string>("notes:create", { key: KEY, title: "Kitchen plan", projectId: kitchen, content: "Juhi recommended the carpenter.\n" });

  const general = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: general, model: "grok-fake-fast", engine: "grok" });

  // 1, 2. brain_neighbors by name, one step and two.
  const one = await tool(general, "brain_neighbors", { page: "People/Juhi" });
  const titles = (list: any[] = []) => list.map((item) => `${item.title}${item.steps === 2 ? " (2)" : ""}`).sort();
  const days = rows("notes").filter((row) => row.kind === "journal" && [dayOf(2), dayOf(9)].includes(row.day)).map((row) => row.title);
  check("neighborsByName", one?.page?.id === juhi && JSON.stringify(titles(one?.neighbors)) === JSON.stringify(days.sort())
    && one.neighbors.every((item: any) => item.why?.length && item.why.every((why: string) => /about Juhi/.test(why)) && item.link?.startsWith("/brain/")), one);
  const tripTwo = await tool(general, "brain_neighbors", { page: trip, steps: 2 });
  check("neighborsTwoSteps", tripTwo?.neighbors?.some((item: any) => item.title === "Packing list" && item.steps === 1 && item.why.includes("a link between them")), tripTwo);
  // 3. Not across projects: Kitchen plan is in a project this chat is not in.
  check("neighborsKeepToReach", !JSON.stringify(one).includes(kitchenPlan) && !JSON.stringify(tripTwo).includes(kitchenPlan));

  // 4. brain_link: both pages, in Related, once, revision-checked, on the map.
  const tripRow = () => rows("notes").find((row) => row._id === trip)!;
  const juhiRow = () => rows("notes").find((row) => row._id === juhi)!;
  const stale = await tool(general, "brain_link", { a: "Goa trip", b: "People/Juhi", why: "planning it together", revisionA: tripRow().revision + 5 });
  check("linkRefusesAStaleRevision", /changed since revision/.test(String(stale?.error)) && !tripRow().content.includes("Related"), stale);
  const linked = await tool(general, "brain_link", { a: "Goa trip", b: "People/Juhi", why: "planning it together", revisionA: tripRow().revision });
  const tripContent = tripRow().content as string;
  const juhiContent = juhiRow().content as string;
  check("linkOnBothPagesInRelated", linked?.linked?.length === 2 && linked.linked.every((item: any) => item.added)
    && /## Related\n\n- \[Juhi\]\(\/brain\/[a-z0-9]+\): planning it together/.test(tripContent) && tripContent.includes(`/brain/${juhi}`)
    && /## Related\n\n- \[Goa trip\]\(\/brain\/[a-z0-9]+\): planning it together/.test(juhiContent) && juhiContent.includes(`/brain/${trip}`), { tripContent, juhiContent, linked });
  const again = await tool(general, "brain_link", { a: trip, b: juhi });
  check("linkOnce", again?.linked?.every((item: any) => !item.added) && tripRow().content === tripContent && juhiRow().content === juhiContent, again);
  const graph = await call<BrainGraph>("brainMap:graph", { key: KEY });
  const at = (id: string) => graph.nodes.findIndex((node) => node.id === id);
  check("linkOnTheMap", graph.edges.some(([a, b, kind]) => kind === "link" && [a, b].includes(at(trip)) && [a, b].includes(at(juhi))));
  const after = await tool(general, "brain_neighbors", { page: "Juhi" });
  check("neighborsSeeTheLink", after?.neighbors?.some((item: any) => item.title === "Goa trip" && item.why.includes("a link between them")), after);

  // 5. recall: asking about Juhi brings in the Goa trip, one step from her page.
  // Asked what matches a line of her page alone, recall finds that line and brings in the Goa trip linked to her page.
  const recalled = await tool(general, "recall", { query: "oldest friend" });
  check("recallBringsInLinkedPages", recalled?.memories?.some((item: any) => /oldest friend/.test(item.text)) && !recalled.memories.some((item: any) => item.note?.id === trip)
    && recalled?.related?.some((item: any) => item.id === trip && item.from === "Juhi" && item.why.includes("a link between them")) && !JSON.stringify(recalled).includes(kitchenPlan),
    { related: recalled?.related, found: recalled?.found });

  // 6. Guests: neither tool is offered, and the queries behind them refuse a chat with someone else.
  const guestJid = "15550002222@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: guestJid, kind: "person", name: "Priya" }] });
  const priya = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: guestJid });
  const thread = await call<string>("agentStore:createThread", { userId: `whatsapp:${guestJid}`, title: "Priya" });
  const theirs = await call<string>("conversations:create", { channel: "whatsapp", externalId: guestJid, threadId: thread, contactId: priya._id });
  const guestNeighbors = await call<Row>("notes:neighborsForAgent", { chat: theirs, id: "Juhi" });
  const guestLink = await call<Row>("notes:linkForAgent", { chat: theirs, a: "Goa trip", b: "Packing list" });
  const guestRelated = await call<Row[]>("notes:relatedForRecall", { chat: theirs, pages: [juhi] });
  const guestTools: readonly string[] = GUEST_TOOLS;
  check("guestGetsNone", !guestTools.includes("brain_neighbors") && !guestTools.includes("brain_link")
    && readFileSync(join(REPO, "convex", "mcp.ts"), "utf8").includes('"brain_list", "brain_neighbors", "brain_link"')
    && /cannot read or write/.test(String(guestNeighbors.error)) && /cannot read or write/.test(String(guestLink.error)) && guestRelated.length === 0
    && !(rows("notes").find((row) => row._id === packing)!.content as string).includes("Related"), { guestNeighbors: guestNeighbors.error, guestLink: guestLink.error });

  // 7. The instructions say when to link and when to make a topic page.
  const fresh = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: fresh, model: "grok-fake-fast", engine: "grok" });
  await exchange(fresh, "HELLO MAP");
  const context = fakeLog(fakeHome).filter((entry) => entry.prompt === "HELLO MAP").at(-1)?.context ?? "";
  check("instructionsSayWhenToLink", /brain_link/.test(context) && /same trip, the same project/.test(context) && /keeps coming up/.test(context) && /brain_neighbors/.test(context));

  // 8. What the owner sees: the trip page's Related section, and the map after linking.
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string) => until(() => evaluate(`(() => { try { return Boolean(${test}); } catch { return false; } })()`), what, 40);
  const shot = async (file: string) => {
    await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = walk.nextNode());) n.nodeValue = n.nodeValue.split(${JSON.stringify(hostname())}).join("THIS-PC"); return true; })()`);
    writeFileSync(join(outDir, file), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  for (const mode of ["light", "dark"] as const) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
    await send("Page.navigate", { url: `${BASE}/brain/${trip}` });
    await waitFor(`[...document.querySelectorAll("[data-note-editor] h2")].some((h) => h.innerText.trim() === "Related")`, "the Related section");
    await evaluate(`[...document.querySelectorAll("[data-note-editor] h2")].find((h) => h.innerText.trim() === "Related").scrollIntoView({ block: "center" }); true`);
    await sleep(800);
    await shot(`related-${mode}.png`);
    await send("Page.navigate", { url: `${BASE}/brain?view=map` });
    await waitFor(`document.querySelector("canvas[data-brain-map]")?.dataset.settled === "true"`, "the map");
    const point = await evaluate(`(() => { const c = document.querySelector("canvas[data-brain-map]"); const at = c.brainMap.screenOf(${JSON.stringify(juhi)}); const r = c.getBoundingClientRect(); return { x: r.left + at.x, y: r.top + at.y }; })()`) as { x: number; y: number };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
    await sleep(400);
    const lit = await evaluate(`({ ...document.querySelector("canvas[data-brain-map]").dataset })`) as Record<string, string>;
    if (mode === "light") check("mapShowsTheLinkOnHover", lit.lit === "Juhi" && Number(lit.litNeighbours) === 3, lit);
    await shot(`map-after-linking-${mode}.png`);
  }
  check("noPageErrors", browser.errors.length === 0, browser.errors);
  notes.realModelTurns = "none: every chat ran on the fake Grok agent";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  check("completed", false);
}
process.exit(await p.finish() ? 0 : 1);
