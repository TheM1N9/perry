import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/projects/run.ts <outDir>
// Issue #170: projects, folders of chats with their own instructions, whose chats share context.
// A fresh Perry from the production build (`pnpm build` first) on a spare port, with its
// PERRY_HOME in PERRY_E2E_DIR (the temp folder by default), the real runner, and headless
// Chrome for the dashboard. No real model turn can run (the Codex limit is used up and
// Claude is rate-limited), so every chat is on Grok played by the fake ACP agent
// (artifacts/engine-acp/fake-agent.ts); what it was sent is read from its log and from the
// turn rows the runner takes. Codex is signed out (an empty CODEX_HOME), so nothing reaches it.
//
// Ways it could fail, written down before the checks:
//   1. Making a project from the sidebar, or saving its instructions on its page, does not
//      stick; or the new project's page does not open.
//   2. A new chat started inside a project is not in it (it lands in the plain chat list).
//   3. The project's instructions do not reach the engine, or reach it as the chat's
//      instructions, where a running session never sees an edit (and every project would
//      miss the spare Codex thread).
//   4. They are sent with every message, whether or not anything changed.
//   5. An edit does not reach a chat already going: the next message in the same session
//      carries the old instructions, or none.
//   6. A chat is not told the project's other chats, or is told of chats outside it.
//   7. search_chats or read_chat in a project's chat misses the project's other chats; or a
//      chat outside the project (or someone else's chat) finds or reads a project's chat.
//   8. scope "this project" still returns chats outside the project, or "everywhere" does not.
//   9. What Perry remembers in a project's chat is seen outside it (recalled, searched), or not
//      in the project's other chats; or something saved "everywhere" from a project stays in it; or
//      correcting, in a project's chat, a fact every chat knows takes it away from the other chats.
//  10. A chat with someone else can be put in a project, or sees project content even when
//      its row says it is in one.
//  11. An old project chat (issue #106) is not migrated at startup: no project named after it,
//      its private memories left chat-only or, worse, made shared.
//  12. Moving a chat in from its menu does not tell the running chat it is now in the
//      project; taking it out does not tell it, and it keeps seeing project memory.
//  13. Deleting a project deletes its chats, or leaves its memories to leak everywhere.
//  14. A job set up in a project's chat works outside it; the day's summary reads project chats;
//      the heartbeat, whose chat is outside every project, is given a project's open threads.
//  15. The dashboard throws, or the sidebar does not show projects as folders with their chats.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/projects/run.ts <outDir>");
let fakeHome = "";
const p = await perry({
  name: "projects",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "signed in for the test");
    // Codex and Claude Code signed out, in homes of their own: no turn and no chat title may reach a real model.
    const codexHome = join(home, "codex-signed-out");
    const claudeHome = join(home, "claude-signed-out");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
  },
});
const { KEY, call, check, notes, until, sql, rows, turnsOf, getChat, conversation, computers, exchange, fakeLog } = p;
const log = () => fakeLog(fakeHome);
type Row = Record<string, any> & { _id: string };

/** What the engine was sent ahead of a message: every text block but the message itself. */
const contextOf = (prompt: string): string => log().filter((entry) => entry.prompt === prompt).at(-1)?.context ?? "";
/** The turn row the runner took for a message: its instructions, and what went with the message. */
const turnOf = (chat: string, prompt: string): Row | undefined => turnsOf(chat).filter((turn) => turn.prompt === prompt).at(-1);
/** What one of Perry's tools answered the fake agent, parsed; the tool call is found by its arguments. */
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
const memoryRows = () => rows("memories");
const seenFrom = async (chat: string, words: string) => (await call<Array<{ text: string }>>("memories:search", { query: words, chat })).some((memory) => memory.text.includes(words));

let server: ReturnType<typeof p.start> | null = null;
try {
  server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // --- 11. An old project chat, as issue #106 left it -------------------------------------------------------
  const legacy = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:renameChat", { key: KEY, id: legacy, title: "Kitchen renovation" });
  await call("memories:add", { text: "The kitchen tiles are the grey hexagon ones, code GREYHEX-41.", tags: [], source: "test", kind: "core", origin: "owner", conversationId: legacy });
  sql(`UPDATE "doc_conversations" SET doc = json_set(doc, '$.project', json('true')) WHERE _id = ?`, [legacy]);
  const legacyMemory = memoryRows().find((row) => String(row.text).includes("GREYHEX-41"))!;
  p.stop(server);
  await sleep(3_000);
  server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start again", 120);
  const migrated = rows("conversations").find((row) => row._id === legacy)!;
  const kitchen = rows("projects").find((row) => row._id === migrated.projectId);
  const movedMemory = memoryRows().find((row) => row._id === legacyMemory._id)!;
  check("oldProjectChatMigrated", kitchen?.name === "Kitchen renovation" && !migrated.project && movedMemory.projectId === kitchen?._id && !movedMemory.conversationId,
    { project: kitchen && { name: kitchen.name }, chat: { project: migrated.project, projectId: migrated.projectId }, memory: { projectId: movedMemory.projectId, conversationId: movedMemory.conversationId } });

  // --- The runner, with Grok played by the fake agent and Codex signed out -----------------------------------
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await sleep(3_000);
  const real = (await computers()).flatMap((item) => item.engines).filter((engine) => engine.signedIn && engine.kind !== "grok").map((engine) => engine.kind);
  notes.realEnginesSignedIn = real;
  if (real.length) throw new Error(`${real.join(", ")} is signed in for the test's runner; stopping before anything reaches a real model.`);

  // A chat outside any project, written in first, so new chats start on its model (Grok).
  const outside = await call<string>("dashboard:createChat", { key: KEY });
  await onGrok(outside);
  await exchange(outside, "Plan my weekend hike MARMOTLANTERN");

  // --- 1. A project from the sidebar, and its instructions from its page ----------------------------------------
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, ms = 30_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { let ok = false; try { ok = Boolean(${test}); } catch {} ok ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(`timed out: ${what}`)})) : setTimeout(tick, 150); }; tick(); })`);
  /**
   * A real mouse click on the element matching the selector whose text or label is `name`; one a toast
   * covers is clicked as a script would, since the mouse would land on the toast.
   */
  async function click(selector: string, name?: string) {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => ${name === undefined ? "true" : `item.getAttribute("aria-label") === ${JSON.stringify(name)} || item.innerText.trim() === ${JSON.stringify(name)}`});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const rect = el.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (!el.contains(document.elementFromPoint(x, y))) { el.click(); return { covered: true }; }
      return { x, y };
    })()`) as { x: number; y: number; covered?: boolean } | null;
    if (!box) throw new Error(`nothing to click: ${selector} ${name ?? ""}`);
    if (box.covered) { await sleep(300); return; }
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await sleep(150);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(300);
  }
  /** Type into a field as a person would, after emptying it. */
  async function type(selector: string, text: string) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); return true; })()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await send("Input.insertText", { text });
    await sleep(200);
  }
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const go = async (path: string) => { await send("Page.navigate", { url: `${p.BASE}${path}` }); await sleep(1_500); };
  const path = () => evaluate("location.pathname") as Promise<string>;
  /** The instructions save as they are typed (#183): the line under them says Saved once they have. */
  const saved = (what: string) => waitFor(`[...document.querySelectorAll('[data-save="saved"]')].some((el) => el.textContent.trim() === "Saved")`, what, 20_000);

  await click('[data-sidebar="group-action"]', "New project");
  await waitFor(`document.querySelector('[aria-label="Project name"]')`, "the new project dialog");
  await type('[aria-label="Project name"]', "Hackonomics scripts");
  await click("button", "Create");
  await waitFor(`location.pathname.startsWith("/projects/")`, "the new project's page");
  const project = (await path()).split("/").pop()!;
  await waitFor(`document.querySelector("#project-instructions")`, "the instructions editor");
  await type("#project-instructions", "Scripts for the Hackonomics YouTube channel. Short punchy sentences. Sign off every script with STAYCURIOUS-7.");
  await saved("the instructions to say Saved");
  await until(async () => (await call<{ instructions: string } | null>("projects:get", { key: KEY, id: project }))?.instructions.includes("STAYCURIOUS-7") ?? false, "the instructions to save", 20);
  const made = await call<{ name: string; instructions: string }>("projects:get", { key: KEY, id: project });
  check("projectMadeFromSidebar", made.name === "Hackonomics scripts" && made.instructions.includes("STAYCURIOUS-7"), { name: made.name, instructions: made.instructions });

  // --- 2. A new chat inside the project, from its page -----------------------------------------------------------
  await click("main a", "New chat");
  await waitFor(`document.body.innerText.includes("New chat in Hackonomics scripts")`, "the new chat in the project");
  await shot("new-chat-in-project.png");
  const opening = "Draft the hook for the compound interest episode ZEPHYRQUILL";
  await type('textarea[aria-label^="Message"]', opening);
  await click('button[aria-label="Send message"]');
  await waitFor(`/^\\/chat\\/[a-z0-9]+$/.test(location.pathname)`, "the new chat's address");
  const chatA = (await path()).split("/").pop()!;
  await until(async () => !(await getChat(chatA)).isRunning && turnsOf(chatA).some((turn) => turn.status === "done"), "the first reply in the project", 120);
  const a = await conversation(chatA);
  check("newChatInProject", a.projectId === project && a.engine === "grok", { projectId: a.projectId, engine: a.engine });

  // --- 3. The instructions reach the turn, with the message --------------------------------------------------------
  const firstContext = contextOf(opening);
  const firstTurn = turnOf(chatA, opening)!;
  const outsideTurn = turnOf(outside, "Plan my weekend hike MARMOTLANTERN")!;
  check("instructionsReachTheTurn", firstContext.includes("# This project: Hackonomics scripts") && firstContext.includes("STAYCURIOUS-7")
    && String(firstTurn.recalled).includes("STAYCURIOUS-7") && Boolean(firstTurn.projectDigest),
    { context: firstContext.slice(firstContext.indexOf("# This project"), firstContext.indexOf("# This project") + 700) });
  // As the chat's own instructions, an edit would never reach a running Codex thread, and no spare thread would match.
  check("notInTheChatsInstructions", !String(firstTurn.instructions).includes("Hackonomics") && firstTurn.instructions === outsideTurn.instructions,
    { sameAsOutside: firstTurn.instructions === outsideTurn.instructions });

  // --- 4. Not again while nothing changed ----------------------------------------------------------------------------
  await exchange(chatA, "Give me three title ideas");
  check("notResentWhenUnchanged", !contextOf("Give me three title ideas").includes("# This project"), contextOf("Give me three title ideas").slice(0, 300));

  // --- 5. An edit reaches the chat already going ------------------------------------------------------------------
  const cursorBefore = (await conversation(chatA)).resume?.cursor;
  const sessionsBefore = log().filter((entry) => entry.method === "session/new").length;
  await go(`/projects/${project}`);
  await waitFor(`document.querySelector("#project-instructions")`, "the instructions editor again");
  await type("#project-instructions", "Scripts for the Hackonomics YouTube channel. Short punchy sentences. Sign off every script with STAYBOLD-9.");
  await saved("the edit to say Saved");
  await until(async () => (await call<{ instructions: string }>("projects:get", { key: KEY, id: project })).instructions.includes("STAYBOLD-9"), "the edit to save", 20);
  await exchange(chatA, "Now write the outro");
  const edited = contextOf("Now write the outro");
  const cursorAfter = (await conversation(chatA)).resume?.cursor;
  check("editReachesRunningChat", edited.includes("STAYBOLD-9") && !edited.includes("STAYCURIOUS-7") && cursorBefore === cursorAfter && Boolean(cursorAfter)
    && log().filter((entry) => entry.method === "session/new").length === sessionsBefore,
    { sameSession: cursorBefore === cursorAfter, newSessions: log().filter((entry) => entry.method === "session/new").length - sessionsBefore, told: edited.slice(edited.indexOf("## The project's instructions"), edited.indexOf("## The project's instructions") + 300) });

  // --- 6, 7. A second chat in the project: told of the first, and can search and read it ---------------------------
  const chatB = await call<string>("dashboard:createChat", { key: KEY, projectId: project });
  await onGrok(chatB);
  const searchA = { query: "ZEPHYRQUILL" };
  const found = await tool(chatB, "search_chats", searchA);
  const overview = contextOf(`TOOL search_chats ${JSON.stringify(searchA)}`);
  check("toldTheOtherChats", overview.includes("## Its other chats") && overview.includes(`id ${chatA}`) && overview.includes("ZEPHYRQUILL") && !overview.includes(outside),
    overview.slice(overview.indexOf("## Its other chats"), overview.indexOf("## Its other chats") + 500));
  const read = await tool(chatB, "read_chat", { chatId: chatA });
  check("searchesAndReadsTheProject", found?.results?.some((hit: { chatId: string }) => hit.chatId === chatA) && read?.messages?.some((message: { text: string }) => message.text.includes("ZEPHYRQUILL")),
    { found: found?.results?.map((hit: { chatId: string; chat: string }) => hit.chat), read: read?.messages?.length });

  // --- 8. Scope ------------------------------------------------------------------------------------------------------
  const inProject = await tool(chatB, "search_chats", { query: "MARMOTLANTERN" });
  const everywhere = await tool(chatB, "search_chats", { query: "MARMOTLANTERN", scope: "everywhere" });
  check("scopeKeepsToTheProject", !inProject?.results?.some((hit: { chatId: string }) => hit.chatId === outside) && everywhere?.results?.some((hit: { chatId: string }) => hit.chatId === outside),
    { thisProject: inProject?.results?.map((hit: { chat: string }) => hit.chat), everywhere: everywhere?.results?.map((hit: { chat: string }) => hit.chat) });

  // --- 7. From outside: nothing of the project -----------------------------------------------------------------------
  const fromOutside = await tool(outside, "search_chats", searchA);
  const readFromOutside = await tool(outside, "read_chat", { chatId: chatA });
  check("outsideCannotReadIn", Boolean(fromOutside) && !fromOutside.results.some((hit: { chatId: string }) => hit.chatId === chatA || hit.chatId === chatB)
    && readFromOutside?.messages?.length === 0 && /stays in the project/.test(readFromOutside?.note ?? ""),
    { found: fromOutside?.results?.map((hit: { chat: string }) => hit.chat), read: readFromOutside });

  // --- 9. Memory ------------------------------------------------------------------------------------------------------
  await exchange(chatA, "REMEMBER Every Hackonomics outro ends with KESTRELBRIDGE.");
  const everywhereArgs = { text: "The owner drinks oolong tea every morning, OOLONGWREN.", kind: "core", scope: "everywhere" };
  await tool(chatA, "remember", everywhereArgs);
  const thisChatArgs = { text: "Only the second chat knows HERONVAULT.", scope: "this chat" };
  await tool(chatB, "remember", thisChatArgs);
  const kestrel = memoryRows().find((row) => String(row.text).includes("KESTRELBRIDGE"));
  const oolong = memoryRows().find((row) => String(row.text).includes("OOLONGWREN"));
  const heron = memoryRows().find((row) => String(row.text).includes("HERONVAULT"));
  check("rememberKeepsToTheProject", kestrel?.projectId === project && !kestrel?.conversationId && !oolong?.projectId && !oolong?.conversationId
    && heron?.conversationId === chatB && !heron?.projectId,
    { kestrel: kestrel && { projectId: kestrel.projectId, conversationId: kestrel.conversationId }, oolong: oolong && { projectId: oolong.projectId }, heron: heron && { conversationId: heron.conversationId } });
  // A fact every chat knows, corrected in a project's chat, is still known everywhere.
  await tool(chatA, "remember", { text: "The owner now drinks green tea every morning instead of oolong, GREENWREN.", kind: "core", supersedes: [oolong?._id] });
  const green = memoryRows().find((row) => String(row.text).includes("GREENWREN"));
  check("correctionStaysShared", Boolean(green) && !green?.projectId && !green?.conversationId && memoryRows().find((row) => row._id === oolong?._id)?.supersededBy === green?._id,
    green && { projectId: green.projectId, conversationId: green.conversationId });
  await exchange(chatB, "What should I know before writing?");
  await exchange(outside, "Anything new for my hike?");
  const inB = contextOf("What should I know before writing?");
  const inOutside = contextOf("Anything new for my hike?");
  const recallOutside = await tool(outside, "recall", { query: "KESTRELBRIDGE outro" });
  check("projectMemorySeenOnlyInProject", inB.includes("KESTRELBRIDGE") && inB.includes("GREENWREN") && !inOutside.includes("KESTRELBRIDGE") && inOutside.includes("GREENWREN")
    && !JSON.stringify(recallOutside ?? {}).includes("KESTRELBRIDGE") && !(await seenFrom(chatA, "HERONVAULT")) && await seenFrom(chatB, "HERONVAULT"),
    { inProject: inB.includes("KESTRELBRIDGE"), outside: inOutside.includes("KESTRELBRIDGE"), everywhereOutside: inOutside.includes("GREENWREN"), recallOutside: recallOutside?.found });
  // The first chat is told again, now that the project has a second chat.
  const retold = contextOf("REMEMBER Every Hackonomics outro ends with KESTRELBRIDGE.");
  check("toldAgainWhenTheProjectChanges", retold.includes("# This project") && retold.includes(`id ${chatB}`), retold.slice(retold.indexOf("## Its other chats"), retold.indexOf("## Its other chats") + 300));

  // --- 12. Moving a chat in, from its menu, and out, from the project's page ------------------------------------------
  await go(`/chat/${outside}`);
  await waitFor(`document.querySelector('[aria-label="Chat options"]')`, "the chat's menu");
  await click('[aria-label="Chat options"]');
  await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.innerText.includes("Move to project"))`, "Move to project");
  await click('[role="menuitem"]', "Move to project");
  await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.innerText.trim() === "Hackonomics scripts")`, "the projects to move to");
  await shot("move-to-project.png");
  await click('[role="menuitem"]', "Hackonomics scripts");
  await until(async () => (await conversation(outside)).projectId === project, "the chat to move in", 20);
  await exchange(outside, "What are we working on here?");
  const movedIn = contextOf("What are we working on here?");
  const findsOutside = await tool(chatB, "search_chats", { query: "MARMOTLANTERN" });
  check("movedInIsTold", movedIn.includes("# This project: Hackonomics scripts") && movedIn.includes("STAYBOLD-9") && await seenFrom(outside, "KESTRELBRIDGE")
    && findsOutside?.results?.some((hit: { chatId: string }) => hit.chatId === outside),
    movedIn.slice(movedIn.indexOf("# This project"), movedIn.indexOf("# This project") + 200));
  await waitFor(`document.body.innerText.includes("Hackonomics scripts") && document.querySelector('[aria-label="Chats in Hackonomics scripts"]')`, "the folder open in the sidebar");
  await sleep(500);
  await shot("chat-in-project.png");

  await go(`/projects/${project}`);
  await waitFor(`document.body.innerText.includes("KESTRELBRIDGE")`, "the project's page with its memory");
  await shot("project-page.png");
  await evaluate(`(() => { const row = [...document.querySelectorAll("main li")].find((item) => item.innerText.includes("MARMOTLANTERN")); [...row.querySelectorAll("button")].find((button) => button.innerText.includes("Take out")).setAttribute("data-take-out", "yes"); return true; })()`);
  await click('button[data-take-out="yes"]');
  await until(async () => !(await conversation(outside)).projectId, "the chat to be taken out", 20);
  await exchange(outside, "And now?");
  const takenOut = contextOf("And now?");
  check("takenOutIsTold", takenOut.includes("# No longer in a project") && !takenOut.includes("STAYBOLD-9") && !(await seenFrom(outside, "KESTRELBRIDGE")),
    takenOut.slice(takenOut.indexOf("# No longer"), takenOut.indexOf("# No longer") + 200));

  // --- 15. The sidebar and the Memory page --------------------------------------------------------------------------
  await go(`/chat/${chatA}`);
  await waitFor(`document.querySelector('[aria-label="Chats in Hackonomics scripts"]')`, "the project's folder open");
  const sidebar = await evaluate(`(() => ({
    folders: [...document.querySelectorAll('[aria-label="Projects"] > li > [data-sidebar="menu-button"]')].map((item) => item.innerText.trim()),
    inFolder: [...document.querySelectorAll('[aria-label="Chats in Hackonomics scripts"] a')].map((item) => item.innerText.trim()),
    listed: [...document.querySelectorAll('[data-sidebar="group"] ul[aria-label]:not([aria-label="Projects"]):not([aria-label^="Chats in"]) a')].map((item) => item.getAttribute("href")),
  }))()`) as { folders: string[]; inFolder: string[]; listed: string[] };
  await shot("sidebar-projects.png");
  check("sidebarShowsFolders", sidebar.folders.includes("Hackonomics scripts") && sidebar.folders.includes("Kitchen renovation")
    && sidebar.inFolder.some((title) => title.includes("ZEPHYRQUILL")) && !sidebar.listed.includes(`/chat/${chatA}`) && sidebar.listed.includes(`/chat/${outside}`), sidebar);
  await go("/memory");
  await waitFor(`document.body.innerText.includes("KESTRELBRIDGE")`, "the Memory page");
  const label = await evaluate(`document.body.innerText.includes("Only in Hackonomics scripts")`);
  await shot("memory-page.png");
  check("memoryPageSaysWhichProject", label === true);

  // --- 10. A chat with someone else --------------------------------------------------------------------------------
  const jid = "15550001111@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: jid, kind: "person", name: "Datta" }] });
  const contact = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: jid });
  const thread = await call<string>("agentStore:createThread", { userId: `whatsapp:${jid}`, title: "Datta" });
  const theirs = await call<string>("conversations:create", { channel: "whatsapp", externalId: jid, threadId: thread, contactId: contact._id });
  const refused = await call("projects:moveChat", { key: KEY, id: theirs, projectId: project }).then(() => "moved", (error: Error) => error.message);
  // Even with its row saying it is in the project, it is told nothing of it and sees none of it.
  sql(`UPDATE "doc_conversations" SET doc = json_set(doc, '$.projectId', ?) WHERE _id = ?`, [project, theirs]);
  const toldThem = await call<string | null>("projects:forTurn", { conversationId: theirs });
  const theySearch = await call<{ found: number }>("history:search", { query: "ZEPHYRQUILL", from: theirs });
  const theyRead = await call<{ messages: unknown[] }>("history:read", { chatId: chatA, from: theirs });
  const theySee = await seenFrom(theirs, "KESTRELBRIDGE");
  sql(`UPDATE "doc_conversations" SET doc = json_remove(doc, '$.projectId') WHERE _id = ?`, [theirs]);
  const phoneThread = await call<string>("agentStore:createThread", { userId: "telegram:424242", title: "Telegram" });
  const phone = await call<string>("conversations:create", { channel: "telegram", externalId: "424242", threadId: phoneThread });
  const phoneRefused = await call("projects:moveChat", { key: KEY, id: phone, projectId: project }).then(() => "moved", (error: Error) => error.message);
  check("othersSealedOff", /other people/.test(refused as string) && toldThem === null && theySearch.found === 0 && theyRead.messages.length === 0 && !theySee && /stay out of projects/.test(phoneRefused as string),
    { refused, toldThem, theySearch: theySearch.found, theyRead: theyRead.messages.length, theySee, phoneRefused });

  // --- 14. A job set up in the project's chat, the day's summary and the heartbeat's open threads --------------------
  const job = await call<{ id: string }>("jobs:create", { name: "Weekly video ideas", schedule: "0 9 1 1 *", prompt: "Pitch three video ideas.", origin: chatA });
  const jobThread = await call<string>("agentStore:createThread", { userId: "web:dashboard", title: "Weekly video ideas" });
  await call("jobs:chatFor", { id: job.id, threadId: jobThread });
  const jobChat = rows("conversations").find((row) => row.jobId === job.id);
  const summarised = await call<Array<{ id: string }>>("conversations:activeSince", { since: 0 });
  check("jobWorksInTheProject", jobChat?.projectId === project, { projectId: jobChat?.projectId });
  check("daySummaryLeavesProjectOut", !summarised.some((chat) => chat.id === chatA || chat.id === chatB) && summarised.some((chat) => chat.id === outside));
  await call("jobs:remove", { id: job.id }).catch(() => {});
  await tool(chatA, "remember", { text: "The owner has to call the sponsor about episode 12, OPENPIKE.", kind: "daily", tags: ["open"] });
  const openThreads = await call<Array<{ text: string }>>("memories:openThreads", {});
  check("heartbeatLeavesProjectThreads", memoryRows().some((row) => String(row.text).includes("OPENPIKE") && row.projectId === project) && !openThreads.some((thread) => thread.text.includes("OPENPIKE")),
    openThreads.map((thread) => thread.text));

  // --- 13. Deleting a project keeps its chats and drops its memory ---------------------------------------------------
  await go(`/projects/${kitchen!._id}`);
  await waitFor(`document.querySelector('[aria-label="Project options"]')`, "the old project's page");
  await click('[aria-label="Project options"]');
  await click('[role="menuitem"]', "Delete");
  await waitFor(`document.body.innerText.includes("Delete this project?") && document.body.innerText.includes("one memory")`, "the delete dialog");
  const warning = await evaluate(`document.querySelector('[role="alertdialog"]')?.innerText ?? ""`);
  await click('[role="alertdialog"] button', "Delete");
  await until(() => !rows("projects").some((row) => row._id === kitchen!._id), "the project to go", 20);
  const kept = rows("conversations").find((row) => row._id === legacy);
  check("deleteKeepsChatsDropsMemory", Boolean(kept) && !kept?.projectId && !memoryRows().some((row) => row._id === legacyMemory._id) && /chat stays/.test(warning),
    { chatKept: Boolean(kept), chatProject: kept?.projectId, memoryLeft: memoryRows().some((row) => row._id === legacyMemory._id), warning });

  check("noPageErrors", browser.errors.length === 0, browser.errors);
  notes.codexRealTurn = "not run: limit (the Codex weekly limit is used up until 4 Oct 03:01, and Claude is rate-limited); Codex gets the same turn row, and its runner puts `recalled` ahead of the message as the first text of the turn input (runner/codex.ts userInput)";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  check("completed", false);
}
process.exit(await p.finish() ? 0 : 1);
