import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, REPO, sleep } from "../engine-acp/harness";
import { GUEST_TOOLS } from "../../convex/lib/engines";
import { toTelegramHtml } from "../../convex/lib/telegramFormat";

// bun artifacts/notes/run.ts <outDir>
// Issue #205: notes, pages of Markdown the owner and Perry write together, and the places they appear.
// A fresh Perry from the production build (`pnpm build` first) on a spare port, with its PERRY_HOME
// in PERRY_E2E_DIR (W:\perry-tests\notes on the owner's machine), the real runner, and headless
// Chrome for the dashboard and the pet's page. No real model turn runs: every chat is on Grok played
// by the fake ACP agent (artifacts/engine-acp/fake-agent.ts), which calls Perry's tools on "TOOL";
// Codex and Claude Code are signed out in homes of their own. Telegram is a stand-in Bot API here,
// and WhatsApp the stand-in driver (artifacts/whatsapp/fake-driver.mjs): no real account is reached.
//
// Ways it could fail, written down before the checks:
//   1. A note made on the Notes page does not stick: the title or the words typed into the editor
//      (headings and checklists from the "/" menu among them) are not saved without a Save button,
//      or come back different after a reload.
//   2. A stale edit overwrites a newer one: the owner's editor saves over words Perry added while
//      they typed, or a save naming an old revision is taken; or the owner's draft is thrown away
//      when the conflict is found, or "Keep mine" and "Load theirs" do not do what they say.
//   3. Perry's tools fail: list, read, search, create, or update (append to the end or a section,
//      replace a section) does the wrong thing; a replace without the revision, or with an old one,
//      goes through; a misspelt section makes a second copy instead of being refused.
//   4. A project's notes do not reach its chats (not listed in what a turn is told, not readable),
//      reach chats outside it, or their words are pasted into every turn; or an edit to a note makes
//      every chat be told the project afresh.
//   5. A chat with someone else can list, read, search, create or change notes, even when its row
//      says it is in a project; or its tools include the note tools.
//   6. "Save as note" on a reply, or "Save chat as note", makes nothing, loses words, or puts a
//      project chat's note outside the project.
//   7. "/note" from Telegram, WhatsApp, the web chat or the pet is not added to the Inbox note, starts
//      a model turn, or is not answered; "/note" alone does not keep the last reply.
//   8. A job with a note does not add its runs to it (under the date, one section per run), or stops
//      telling the owner its result.
//   9. Search (Ctrl+K) does not find a note by its title or by words inside it, or does not open it.
//  10. A link to a note in a reply is not a link into the dashboard, or a phone gets a broken link.
//  11. Download gives a file that differs from the note; a .md file does not open as a new note.
//  12. Deleting a project deletes its notes; deleting a note leaves a job writing to nothing.
//  13. Perry's instructions do not say what goes in notes and what in memory.
//  14. Any page throws, in light or dark.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/notes/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

// --- A stand-in Telegram Bot API -----------------------------------------------------------------
const OWNER_TG = "4242";
type TgSent = { chat_id: string; text: string; at: number };
const telegram = { sent: [] as TgSent[], pending: [] as object[], next: 1 };
const tg = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 1, is_bot: true, username: "perry_notes_bot" });
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    if (method === "sendMessage") {
      telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), at: Date.now() });
      return reply({ message_id: telegram.sent.length });
    }
    if (method === "editMessageText") {
      const message = telegram.sent[Number(args.message_id) - 1];
      if (message) message.text = String(args.text);
      return reply(true);
    }
    return reply(true);
  });
});
await new Promise<void>((done) => tg.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.next++,
  message: { message_id: telegram.next, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER_TG), type: "private" }, from: { id: Number(OWNER_TG), is_bot: false, first_name: "Alex" }, text },
});
const toOwner = (after: number) => telegram.sent.filter((message) => message.chat_id === OWNER_TG && message.at > after);

// --- A stand-in WhatsApp (fake-driver.mjs takes its orders from here) ------------------------------
const OWNER_WA = "919876543210@s.whatsapp.net";
const wa = { commands: [] as object[], sent: [] as Array<{ jid: string; text?: string; at: number }>, connects: 0 };
const control = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const done = (value: unknown = true) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    switch (request.url) {
      case "/next":
        if (wa.commands.length) return done(wa.commands.splice(0));
        return void setTimeout(() => done(wa.commands.splice(0)), 500);
      case "/sent": wa.sent.push({ ...data, at: Date.now() }); return done();
      case "/connect": wa.connects += 1; return done();
      default: return done();
    }
  });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
let waId = 0;
const waIncoming = (text: string) => wa.commands.push({
  event: "messages.upsert",
  data: { type: "notify", messages: [{ key: { id: `IN${Date.now()}${++waId}`, remoteJid: OWNER_WA, fromMe: true }, pushName: "Alex", message: { conversation: text } }] },
});

let fakeHome = "";
const p = await perry({
  name: "notes",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "signed in for the test");
    const codexHome = join(home, "codex-signed-out");
    const claudeHome = join(home, "claude-signed-out");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
  },
  env: {
    TELEGRAM_BOT_TOKEN: "123456:notes-e2e",
    TELEGRAM_API_BASE: `http://127.0.0.1:${(tg.address() as { port: number }).port}`,
    PERRY_WHATSAPP_DRIVER: join(REPO, "artifacts", "whatsapp", "fake-driver.mjs"),
    PERRY_WHATSAPP_CONTROL: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
  },
});
const { KEY, call, check, notes, until, sql, rows, turnsOf, getChat, conversation, computers, exchange, fakeLog, messagesOf } = p;
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
const noteRows = () => rows("notes");
const noteRow = (id: string) => noteRows().find((row) => row._id === id);
const inbox = () => noteRows().find((row) => row.title === "Inbox" && !row.projectId);

let server: ReturnType<typeof p.start> | null = null;
try {
  server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  // The owner's Telegram, claimed with the pairing code as a real phone would.
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner's Telegram to be claimed", 60);
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await sleep(3_000);
  const real = (await computers()).flatMap((item) => item.engines).filter((engine) => engine.signedIn && engine.kind !== "grok").map((engine) => engine.kind);
  notes.realEnginesSignedIn = real;
  if (real.length) throw new Error(`${real.join(", ")} is signed in for the test's runner; stopping before anything reaches a real model.`);

  const general = await call<string>("dashboard:createChat", { key: KEY });
  await onGrok(general);
  await exchange(general, "Hello, this is the general chat.");

  // --- The browser --------------------------------------------------------------------------------
  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const waitFor = (test: string, what: string, ms = 30_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { let ok = false; try { ok = Boolean(${test}); } catch {} ok ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(`timed out: ${what}`)})) : setTimeout(tick, 150); }; tick(); })`);
  async function click(selector: string, name?: string, last = false) {
    const box = await evaluate(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((item) => ${name === undefined ? "true" : `item.getAttribute("aria-label") === ${JSON.stringify(name)} || item.innerText.trim() === ${JSON.stringify(name)}`});
      const el = ${last ? "all.at(-1)" : "all[0]"};
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
    await sleep(120);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(300);
  }
  const key = async (keyName: string, code = keyName, vk = 0, modifiers = 0, text?: string) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(120);
  };
  const enter = () => key("Enter", "Enter", 13, 0, "\r");
  const typeText = async (text: string) => { await send("Input.insertText", { text }); await sleep(150); };
  async function fill(selector: string, text: string) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); return true; })()`);
    await key("Delete", "Delete", 46);
    await typeText(text);
  }
  /** The caret at the very end of the note's editor. */
  const editorEnd = () => evaluate(`(() => { const el = document.querySelector("[data-note-editor]"); el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); return true; })()`);
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const go = async (path: string) => { await send("Page.navigate", { url: `${p.BASE}${path}` }); await sleep(1_500); };
  const path = () => evaluate("location.pathname") as Promise<string>;
  const savedState = () => evaluate(`document.querySelector("[data-save]")?.getAttribute("data-save") ?? ""`) as Promise<string>;

  // Light first (headless Chrome reports a dark system theme); dark at the end.
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);

  // --- 1. A note made and written on the Notes page, saved as it is typed ---------------------------------
  // Notes are pages in Brain now (issue #210); /notes still lands there.
  await go("/notes");
  await waitFor(`location.pathname === "/brain" && document.body.innerText.includes("No pages yet")`, "the empty Brain page");
  await shot("notes-empty.png");
  await click("main button", "New page");
  await waitFor(`/^\\/brain\\/[a-z0-9]+$/.test(location.pathname) && document.querySelector("[data-note-editor]")`, "the new note's editor");
  const lisbon = (await path()).split("/").pop()!;
  await fill('input[aria-label="Title"]', "Lisbon trip");
  await editorEnd();
  await typeText("Flights on Friday, TAP 1234.");
  await enter();
  await typeText("/");
  await waitFor(`document.querySelector("#note-block-menu")`, "the / menu");
  await shot("note-slash-menu.png");
  // The menu filters on what follows the "/", up to a space: "section" leaves Heading 2 alone.
  await typeText("section");
  await enter();
  await typeText("Packing");
  await enter();
  await typeText("/");
  await typeText("checklist");
  await enter();
  await typeText("Passport");
  await enter();
  await typeText("Sunscreen");
  await until(async () => String(noteRow(lisbon)?.content ?? "").includes("Sunscreen") && noteRow(lisbon)?.title === "Lisbon trip", "the note to save itself", 20);
  await waitFor(`document.querySelector('[data-save="saved"]')`, "Saved under the title", 10_000).catch(() => {});
  const first = noteRow(lisbon)!;
  notes.firstSave = { title: first.title, content: first.content, revision: first.revision };
  await shot("note-editor.png");
  await go(`/notes/${lisbon}`);
  await waitFor(`document.querySelector("[data-note-editor]")?.innerText.includes("Sunscreen")`, "the note after a reload");
  const reloaded = await evaluate(`({ title: document.querySelector('input[aria-label="Title"]').value, heading: document.querySelector("[data-note-editor] h2")?.innerText, tasks: [...document.querySelectorAll('[data-note-editor] ul[data-type="taskList"] li > div')].map((item) => item.innerText.trim()) })`);
  check("noteSavesAsTyped", first.title === "Lisbon trip" && /^## Packing$/m.test(first.content) && /- \[ \] Passport/.test(first.content) && /- \[ \] Sunscreen/.test(first.content)
    && first.content.includes("TAP 1234") && first.revision > 1 && first.by === "owner", notes.firstSave);
  check("noteKeepsAfterReload", reloaded.title === "Lisbon trip" && reloaded.heading === "Packing" && JSON.stringify(reloaded.tasks) === JSON.stringify(["Passport", "Sunscreen"]), reloaded);

  // --- 2. A stale edit is refused ---------------------------------------------------------------------
  // Perry adds to the note while the owner types: the owner's save names the old revision and is refused.
  await editorEnd();
  await typeText(" and a hat HATDRAFT");
  await call("notes:updateForAgent", { id: lisbon, mode: "append", content: "PERRYADD-ONE" });
  await waitFor(`document.querySelector("[data-conflict]")`, "the conflict to show", 10_000);
  await sleep(1_500);
  const during = noteRow(lisbon)!;
  await shot("note-conflict.png");
  const draftKept = await evaluate(`document.querySelector("[data-note-editor]").innerText.includes("HATDRAFT")`);
  check("staleEditRefused", during.content.includes("PERRYADD-ONE") && !during.content.includes("HATDRAFT") && draftKept === true,
    { saved: during.content.slice(-80), draftOnScreen: draftKept, revision: during.revision });
  await click("[data-conflict] button", "Load theirs");
  await waitFor(`!document.querySelector("[data-conflict]") && document.querySelector("[data-note-editor]").innerText.includes("PERRYADD-ONE")`, "the newer note loaded");
  const afterLoad = await evaluate(`document.querySelector("[data-note-editor]").innerText`);
  check("loadTheirsShowsNewer", !afterLoad.includes("HATDRAFT") && !noteRow(lisbon)!.content.includes("HATDRAFT"));
  // Again, and this time the owner keeps their own words, over the newer note they have now seen.
  await editorEnd();
  await typeText(" KEEPMINE");
  await call("notes:updateForAgent", { id: lisbon, mode: "append", content: "PERRYADD-TWO" });
  await waitFor(`document.querySelector("[data-conflict]")`, "the second conflict", 10_000);
  await click("[data-conflict] button", "Keep mine");
  await until(() => String(noteRow(lisbon)?.content).includes("KEEPMINE"), "the owner's words to be kept", 15);
  check("keepMineSavesDraft", noteRow(lisbon)!.content.includes("KEEPMINE") && noteRow(lisbon)!.by === "owner", noteRow(lisbon)!.content.slice(-120));
  // A save naming an old revision, straight to the server, changes nothing.
  const before = noteRow(lisbon)!;
  const stale = await call<{ ok: boolean; note: { revision: number } }>("notes:save", { key: KEY, id: lisbon, content: "OVERWRITE ATTEMPT", expectedRevision: 1 });
  check("oldRevisionSaveRefused", stale.ok === false && stale.note.revision === before.revision && noteRow(lisbon)!.content === before.content, { ok: stale.ok, revision: stale.note.revision });

  // --- 3. Perry's tools -----------------------------------------------------------------------------------
  const listed = await tool(general, "list_notes", {});
  const found = await tool(general, "search_notes", { query: "sunscreen" });
  const read = await tool(general, "read_note", { id: lisbon });
  check("toolsListSearchRead", listed?.notes?.some((note: Row) => note.id === lisbon && note.link === `/brain/${lisbon}`)
    && found?.notes?.some((note: Row) => note.id === lisbon && /sunscreen/i.test(note.snippet))
    && read?.content?.includes("Passport") && read?.sections?.includes("Packing") && read?.revision === noteRow(lisbon)!.revision,
    { listed: listed?.notes?.map((note: Row) => note.title), found: found?.found, sections: read?.sections, revision: read?.revision });
  const appendArgs = { id: lisbon, mode: "append", section: "Packing", content: "- [ ] Plug adapter PLUGWREN" };
  const appendedToSection = await tool(general, "update_note", appendArgs);
  const afterSection = noteRow(lisbon)!.content as string;
  const packing = afterSection.slice(afterSection.indexOf("## Packing"));
  check("appendToSection", Boolean(appendedToSection?.updated) && packing.includes("Sunscreen") && packing.includes("PLUGWREN") && noteRow(lisbon)!.by === "assistant", packing);
  const staleReplace = await tool(general, "update_note", { id: lisbon, mode: "replace_section", section: "Packing", content: "- nothing", expectedRevision: read.revision });
  const noRevision = await tool(general, "update_note", { id: lisbon, mode: "replace_all", content: "gone" });
  const misspelt = await tool(general, "update_note", { id: lisbon, mode: "replace_section", section: "Pakcing", content: "- nothing", expectedRevision: noteRow(lisbon)!.revision });
  check("staleToolEditRefused", /changed since revision/.test(staleReplace?.error ?? "") && staleReplace?.current?.content?.includes("PLUGWREN") && /expectedRevision/.test(noRevision?.error ?? "")
    && misspelt?.sections?.includes("Packing") && noteRow(lisbon)!.content.includes("PLUGWREN") && !noteRow(lisbon)!.content.includes("- nothing"),
    { stale: staleReplace?.error, noRevision: noRevision?.error, misspelt: misspelt?.error });
  const replaceArgs = { id: lisbon, mode: "replace_section", section: "Packing", content: "- [x] Passport\n- [ ] Sunscreen\n- [ ] Plug adapter PLUGWREN", expectedRevision: noteRow(lisbon)!.revision };
  const replaced = await tool(general, "update_note", replaceArgs);
  const replacedContent = noteRow(lisbon)!.content as string;
  check("replaceSection", Boolean(replaced?.updated) && replacedContent.includes("- [x] Passport") && replacedContent.includes("TAP 1234") && (replacedContent.match(/## Packing/g) ?? []).length === 1, replacedContent);
  const madeArgs = { title: "Book ideas", content: "## Fiction\n\n- The Overstory BOOKWREN" };
  const made = await tool(general, "create_note", madeArgs);
  const book = made?.created?.id as string;
  check("createNote", noteRow(book)?.by === "assistant" && noteRow(book)?.from === general && !noteRow(book)?.projectId && made?.created?.link === `/brain/${book}`, made);

  // --- 4. A project's notes reach its chats, and only them -----------------------------------------------------
  const project = await call<string>("projects:create", { key: KEY, name: "Kitchen renovation" });
  const inProject = await call<string>("dashboard:createChat", { key: KEY, projectId: project });
  await onGrok(inProject);
  const tiles = (await tool(inProject, "create_note", { title: "Tile choices", content: "Grey hexagon tiles, code GREYHEX-41." }))?.created?.id as string;
  await exchange(inProject, "What tiles did we pick?");
  const told = contextOf("What tiles did we pick?");
  const readInProject = await tool(inProject, "read_note", { id: tiles });
  check("projectNoteInProject", noteRow(tiles)?.projectId === project && told.includes("## Its notes") && told.includes(`"Tile choices" (id ${tiles})`)
    // The project lists its notes by title; a note's words come only as recall, when they bear on the message (issue #210).
    && !told.slice(told.indexOf("## Its notes"), told.indexOf("## Its memory")).includes("GREYHEX-41")
    && readInProject?.content?.includes("GREYHEX-41"), told.slice(told.indexOf("## Its notes"), told.indexOf("## Its notes") + 400));
  const outsideRead = await tool(general, "read_note", { id: tiles });
  const outsideList = await tool(general, "list_notes", {});
  const outsideSearch = await tool(general, "search_notes", { query: "GREYHEX" });
  check("projectNoteNotOutside", /no (?:note|page) (?:with|by) that id/.test(outsideRead?.error ?? "") && !outsideList?.notes?.some((note: Row) => note.id === tiles) && outsideSearch?.found === 0,
    { read: outsideRead, search: outsideSearch?.found });
  // The owner edits the note: the words change, the list of notes does not, so the chat is not told the project again.
  const tileNow = noteRow(tiles)!;
  await call("notes:save", { key: KEY, id: tiles, content: "Grey hexagon tiles, code GREYHEX-41. Grout: charcoal.", expectedRevision: tileNow.revision });
  await exchange(inProject, "And the grout?");
  const notRetold = contextOf("And the grout?");
  await call("notes:create", { key: KEY, title: "Budget", content: "Under 4000.", projectId: project });
  await exchange(inProject, "How is the budget?");
  const retold = contextOf("How is the budget?");
  check("projectToldOnlyWhenListChanges", !notRetold.includes("# This project") && retold.includes("# This project") && retold.includes('"Budget"'), { afterEdit: notRetold.includes("# This project"), afterNewNote: retold.includes('"Budget"') });

  // --- 5. A chat with someone else reaches no note ---------------------------------------------------------------
  const jid = "15550001111@s.whatsapp.net";
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: jid, kind: "person", name: "Datta" }] });
  const contact = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: jid });
  const thread = await call<string>("agentStore:createThread", { userId: `whatsapp:${jid}`, title: "Datta" });
  const theirs = await call<string>("conversations:create", { channel: "whatsapp", externalId: jid, threadId: thread, contactId: contact._id });
  sql(`UPDATE "doc_conversations" SET doc = json_set(doc, '$.projectId', ?) WHERE _id = ?`, [project, theirs]);
  const sealed = {
    list: await call<Row>("notes:listForAgent", { chat: theirs }),
    read: await call<Row>("notes:readForAgent", { chat: theirs, id: lisbon }),
    readProject: await call<Row>("notes:readForAgent", { chat: theirs, id: tiles }),
    search: await call<Row>("notes:searchForAgent", { chat: theirs, query: "GREYHEX" }),
    create: await call<Row>("notes:createForAgent", { chat: theirs, title: "x", content: "THEIRNOTE" }),
    update: await call<Row>("notes:updateForAgent", { chat: theirs, id: lisbon, mode: "append", content: "THEIRWORDS" }),
    job: await call<Row>("notes:reachableFrom", { chat: theirs, id: lisbon }),
  };
  sql(`UPDATE "doc_conversations" SET doc = json_remove(doc, '$.projectId') WHERE _id = ?`, [theirs]);
  const noteTools = ["list_notes", "read_note", "search_notes", "create_note", "update_note"];
  check("contactChatSealedOff", Object.values(sealed).every((answer) => /cannot read or write them/.test(String(answer.error)))
    && sealed.list.notes.length === 0 && !noteRows().some((row) => String(row.content).includes("THEIRNOTE") || String(row.content).includes("THEIRWORDS"))
    && !GUEST_TOOLS.some((name) => noteTools.includes(name)), { errors: Object.fromEntries(Object.entries(sealed).map(([name, answer]) => [name, answer.error])), guestTools: GUEST_TOOLS });

  // --- 6. Save a reply, and a whole chat, as a note ------------------------------------------------------------------
  await go(`/chat/${inProject}`);
  await waitFor(`document.querySelectorAll('[data-role="assistant"] button[aria-label="Save as note"]').length > 0`, "the reply's Save as note");
  const beforeSave = noteRows().length;
  await evaluate(`(() => { const rows = [...document.querySelectorAll('[data-role="assistant"]')]; rows.at(-1).querySelector('button[aria-label="Save as note"]').setAttribute("data-pick", "yes"); return true; })()`);
  await click('button[data-pick="yes"]');
  await until(() => noteRows().length > beforeSave, "the reply to be saved as a note", 15);
  await waitFor(`document.body.innerText.includes("Saved as the note")`, "the toast", 5_000).catch(() => {});
  await shot("chat-saved-as-note.png");
  const fromReply = noteRows().filter((row) => row.from === inProject).sort((a, b) => b.createdAt - a.createdAt)[0];
  const lastReply = (await messagesOf(inProject)).filter((message) => message.role === "assistant").at(-1)!.text.replace(/\n?<!--[\s\S]*?-->/g, "").trim();
  check("saveReplyAsNote", Boolean(fromReply) && fromReply.content.trim() === lastReply && fromReply.projectId === project, { title: fromReply?.title, projectId: fromReply?.projectId, same: fromReply?.content.trim() === lastReply });
  await go(`/chat/${general}`);
  await waitFor(`document.querySelector('[aria-label="Chat options"]')`, "the chat menu");
  await click('[aria-label="Chat options"]');
  await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.innerText.includes("Save chat as note"))`, "Save chat as note");
  await click('[role="menuitem"]', "Save chat as note");
  await until(() => noteRows().some((row) => row.from === general && String(row.content).includes("**You:**")), "the chat to be saved as a note", 15);
  const wholeChat = noteRows().find((row) => row.from === general && String(row.content).includes("**You:**"))!;
  check("saveChatAsNote", wholeChat.content.includes("Hello, this is the general chat.") && wholeChat.content.includes("**Perry:**") && !wholeChat.projectId, wholeChat.content.slice(0, 300));

  // --- 7. "/note" from the web chat, Telegram, WhatsApp and the pet ----------------------------------------------------
  const runsBefore = (await call<unknown[]>("dashboard:listRuns", { key: KEY, conversationId: general })).length;
  await fill('textarea[aria-label^="Message"]', "/note Pick up the dry cleaning WEBJOT");
  await enter();
  await until(() => String(inbox()?.content ?? "").includes("WEBJOT"), "the web /note", 15);
  check("webSlashNote", (await call<unknown[]>("dashboard:listRuns", { key: KEY, conversationId: general })).length === runsBefore, { inbox: inbox()?.content });

  let at = Date.now();
  ownerSays("/note Buy oat milk TGJOT");
  await until(() => toOwner(at).some((message) => message.text.includes("Inbox note")), "Telegram's answer to /note", 30);
  const tgChat = (await call<{ _id: string } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER_TG }))?._id;
  check("telegramSlashNote", String(inbox()?.content).includes("TGJOT") && (tgChat ? turnsOf(tgChat).length === 0 : true), { said: toOwner(at).map((message) => message.text) });
  // A reply on Telegram, then "/note" alone keeps it.
  at = Date.now();
  ownerSays("Plan a Sunday walk TGWALK");
  await until(() => toOwner(at).some((message) => message.text.includes("TGWALK")), "Perry's Telegram reply", 120);
  await sleep(2_000);
  at = Date.now();
  ownerSays("/note");
  await until(() => toOwner(at).some((message) => message.text.includes("Saved my last reply")), "Telegram's /note alone", 30);
  check("telegramSlashNoteKeepsReply", noteRows().some((row) => String(row.content).includes("Fake grok reply to: Plan a Sunday walk TGWALK") && row.from && !row.projectId), toOwner(at).map((message) => message.text));
  // Perry, asked on the phone, writes a note with his tools.
  at = Date.now();
  const phoneArgs = { title: "Phone list", content: "- milk PHONENOTE" };
  ownerSays(`TOOL create_note ${JSON.stringify(phoneArgs)}`);
  await until(() => noteRows().some((row) => row.title === "Phone list"), "Perry's note from Telegram", 120);
  check("perryNotesFromPhone", noteRows().find((row) => row.title === "Phone list")?.from === tgChat);
  // A link to a note in a reply is plain words on a phone.
  at = Date.now();
  ownerSays(`See [Lisbon trip](/notes/${lisbon}) TGLINK`);
  await until(() => toOwner(at).some((message) => message.text.includes("TGLINK")), "the Telegram reply with a link", 120);
  await sleep(2_500);
  const linkOnPhone = toOwner(at).find((message) => message.text.includes("TGLINK"))!.text;
  check("noteLinkPlainOnPhone", linkOnPhone.includes("Lisbon trip") && !linkOnPhone.includes("/notes/") && !toTelegramHtml(`[x](/notes/abc)`).includes("href"), linkOnPhone);

  // WhatsApp, linked to the owner's own number ("Message yourself").
  await call("whatsapp:startLinking", { key: KEY, mode: "self" });
  await until(() => wa.connects > 0, "the stand-in WhatsApp to start", 30);
  wa.commands.push({ user: { id: "919876543210:12@s.whatsapp.net", lid: "123456789:12@lid", name: "Alex" } }, { event: "connection.update", data: { connection: "open" } });
  await until(() => Boolean(rows("installation")[0]?.whatsappOwner), "WhatsApp to pair", 30);
  at = Date.now();
  waIncoming("/note Call the plumber WAJOT");
  await until(() => wa.sent.some((message) => message.at > at && String(message.text).includes("Inbox note")), "WhatsApp's answer to /note", 30);
  check("whatsappSlashNote", String(inbox()?.content).includes("WAJOT"), wa.sent.filter((message) => message.at > at).map((message) => message.text));

  // The pet: "/note" typed in his chat, and one of his replies kept.
  await go("/chat");
  await evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(general)}); true`);
  await go("/pet");
  await waitFor(`document.querySelector('button[aria-label^="Perry."]')`, "the pet");
  await click('button[aria-label^="Perry."]');
  await waitFor(`document.querySelector('textarea[aria-label="Message Perry"]')`, "the pet's chat");
  await fill('textarea[aria-label="Message Perry"]', "/note Water the plants PETJOT");
  await enter();
  await until(() => String(inbox()?.content ?? "").includes("PETJOT"), "the pet's /note", 15);
  await waitFor(`document.querySelector("[data-noted]")`, "the pet saying where it went", 5_000).catch(() => {});
  await shot("pet-note.png");
  const petBefore = noteRows().length;
  await evaluate(`(() => { const all = [...document.querySelectorAll('.group\\\\/reply button[aria-label="Save as note"]')]; all.at(-1).setAttribute("data-pick", "pet"); return all.length; })()`);
  await click('button[data-pick="pet"]');
  await until(() => noteRows().length > petBefore, "the pet's reply kept as a note", 15);
  check("petNotes", String(inbox()?.content).includes("PETJOT") && noteRows().length === petBefore + 1, { inbox: inbox()?.content });
  const inboxShown = inbox()!;
  notes.inbox = inboxShown.content;

  // --- 8. A job that adds each run to a note --------------------------------------------------------------------------
  const reviews = (await tool(general, "create_note", { title: "Weekly reviews", content: "" }))?.created?.id as string;
  const jobArgs = { name: "Weekly review", schedule: "0 18 * * 5", prompt: "Write the weekly review WEEKLYWREN.", noteId: reviews };
  const jobMade = await tool(general, "create_job", jobArgs);
  const job = (await call<Array<{ id: string; noteId?: string; name: string }>>("jobs:list")).find((item) => item.name === "Weekly review")!;
  await call("jobs:trigger", { id: job.id });
  await until(() => String(noteRow(reviews)?.content ?? "").includes("WEEKLYWREN"), "the job's first run in its note", 120);
  await until(async () => (await messagesOf(general)).some((message) => message.text.includes("Added to your note “Weekly reviews”")), "the job's report", 30);
  await call("jobs:trigger", { id: job.id });
  await until(() => (String(noteRow(reviews)?.content ?? "").match(/WEEKLYWREN/g) ?? []).length >= 2, "the job's second run in its note", 120);
  const log2 = noteRow(reviews)!.content as string;
  check("jobAddsToNote", jobMade?.id && job.noteId === reviews && (log2.match(/^## \w{3}, \d{1,2} \w{3} \d{4}$/gm) ?? []).length === 2 && (log2.match(/WEEKLYWREN/g) ?? []).length >= 2, log2.slice(0, 400));
  await go("/work");
  await waitFor(`document.querySelector("[data-job-note]")`, "the job's note on the Work page");
  const jobNoteLabel = await evaluate(`document.querySelector("[data-job-note]").innerText`);
  await shot("work-job-note.png");
  check("workPageShowsJobNote", jobNoteLabel.includes("Weekly reviews"), jobNoteLabel);

  // --- 9. Search (Ctrl+K) ----------------------------------------------------------------------------------------------
  await go("/chat");
  await key("k", "KeyK", 75, 2);
  await waitFor(`document.querySelector('[cmdk-input]')`, "the search palette");
  await typeText("oat milk");
  // Words inside a note are found as its lines, in one group with memory (issue #210).
  await waitFor(`[...document.querySelectorAll('[cmdk-group-heading]')].some((item) => item.innerText === "Brain") && document.querySelector('[data-recalled="page"]')?.innerText.includes("Inbox")`, "Inbox found by its words", 20_000);
  await shot("search-notes.png");
  const byWords = await evaluate(`document.querySelector('[data-recalled="page"]').innerText`);
  await fill("[cmdk-input]", "Lisbon");
  await waitFor(`[...document.querySelectorAll('[data-value^="note-"]')].some((item) => item.innerText.includes("Lisbon trip"))`, "Lisbon found by title", 10_000);
  await click('[data-value^="note-"]', undefined);
  await waitFor(`location.pathname === ${JSON.stringify(`/brain/${lisbon}`)}`, "the note to open from search");
  check("searchFindsNotes", byWords.includes("TGJOT") || byWords.includes("oat milk"), byWords);

  // --- 10. A link to a note in a reply -----------------------------------------------------------------------------------
  await exchange(general, `See [Lisbon trip](/notes/${lisbon}) WEBLINK`);
  await go(`/chat/${general}`);
  await waitFor(`document.querySelector('a[data-note-link]')`, "the note link in the reply");
  await click("a[data-note-link]");
  // A link from before Brain (/notes/<id>) still opens the page, at its new address.
  await waitFor(`location.pathname === ${JSON.stringify(`/brain/${lisbon}`)}`, "the note link to open the note");
  check("noteLinkOpensNote", true);

  // --- 11. Download as .md, and a .md file opened as a new note ---------------------------------------------------------------
  const downloads = join(p.home, "downloads");
  mkdirSync(downloads, { recursive: true });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await waitFor(`document.querySelector('[aria-label="Page options"]')`, "the note's menu");
  await click('[aria-label="Page options"]');
  await click('[role="menuitem"]', "Download .md");
  await until(() => existsSync(join(downloads, "Lisbon trip.md")), "the download", 15);
  const file = readFileSync(join(downloads, "Lisbon trip.md"), "utf8");
  check("downloadIsTheNote", file === noteRow(lisbon)!.content, { bytes: file.length });
  const edited = join(downloads, "Lisbon trip by hand.md");
  writeFileSync(edited, `${file}\nEdited by hand HANDEDIT-7\n`);
  await go("/notes");
  await waitFor(`document.querySelector('input[aria-label="Open a Markdown file"]')`, "the Notes page");
  const input = await send("Runtime.evaluate", { expression: `document.querySelector('input[aria-label="Open a Markdown file"]')` });
  await send("DOM.setFileInputFiles", { files: [edited], objectId: input.result.objectId });
  await until(() => noteRows().some((row) => row.title === "Lisbon trip by hand"), "the .md file to open as a note", 15);
  check("openMarkdownFile", String(noteRows().find((row) => row.title === "Lisbon trip by hand")?.content).includes("HANDEDIT-7"));

  // --- The project page, and deleting a project keeps its notes ---------------------------------------------------------------
  await go(`/projects/${project}`);
  // Its pages are in its Brain, as Brain lists them (issue #226).
  await waitFor(`document.querySelector('main section[aria-label="Brain"] ul[aria-label="Pages"]')?.innerText.includes("Tile choices")`, "the project's notes");
  await shot("project-notes.png");
  await call("projects:remove", { key: KEY, id: project });
  check("projectDeleteKeepsNotes", Boolean(noteRow(tiles)) && !noteRow(tiles)?.projectId);

  // --- 12. Deleting a note from its page ---------------------------------------------------------------------------------------
  await go(`/notes/${reviews}`);
  await waitFor(`document.querySelector('[aria-label="Page options"]')`, "the note to delete");
  await click('[aria-label="Page options"]');
  await click('[role="menuitem"]', "Delete");
  await waitFor(`document.querySelector('[role="alertdialog"]')`, "the delete dialog");
  await click('[role="alertdialog"] button', "Delete");
  await until(() => !noteRow(reviews), "the note to go", 15);
  const jobAfter = (await call<Array<{ id: string; noteId?: string }>>("jobs:list")).find((item) => item.id === job.id);
  check("deleteNoteFreesJob", !jobAfter?.noteId, jobAfter);

  // --- 13. What Perry is told about notes and memory ------------------------------------------------------------------------------
  const instructions = String(turnsOf(general).at(-1)?.instructions ?? "");
  // Notes and memory are one place, Brain (issue #210): the instructions say where each goes.
  check("instructionsDrawTheLine", instructions.includes("their Brain") && instructions.includes("A memory is a line in a page") && instructions.includes("brain_write mode=create"),
    instructions.slice(instructions.indexOf("Everything you know"), instructions.indexOf("Everything you know") + 400));

  // --- 14. Light and dark, and no page errors --------------------------------------------------------------------------------------
  await go("/notes");
  await waitFor(`!document.documentElement.classList.contains("dark") && document.querySelector('ul[aria-label="Pages"]')`, "the notes list, light");
  await shot("notes-list.png");
  await evaluate(`localStorage.setItem("perry.theme", "dark"); true`);
  await go("/notes");
  await waitFor(`document.documentElement.classList.contains("dark") && document.querySelector('ul[aria-label="Pages"]')`, "dark Notes");
  await shot("notes-list-dark.png");
  await go(`/notes/${lisbon}`);
  await waitFor(`document.querySelector("[data-note-editor]")?.innerText.includes("Passport")`, "dark note");
  await shot("note-editor-dark.png");
  await go("/chat");
  await key("k", "KeyK", 75, 2);
  await waitFor(`document.querySelector('[cmdk-input]')`, "the dark palette");
  await typeText("trip");
  await waitFor(`document.querySelector('[data-value^="note-"]')`, "notes in the dark palette", 10_000);
  await shot("search-notes-dark.png");
  await key("Escape", "Escape", 27);
  await go(`/projects/${(await call<Array<{ id: string }>>("projects:list", { key: KEY }))[0]?.id ?? ""}`).catch(() => {});
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
  notes.codexRealTurn = "not run: no real model turns in this check (fake Grok only)";
} catch (error) {
  notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  check("completed", false);
}
tg.close();
control.close();
// Downloads live in the test's home, which finish() deletes; the screenshots stay in outDir.
for (const name of readdirSync(outDir)) if (name.endsWith(".md")) rmSync(join(outDir, name));
process.exit(await p.finish() ? 0 : 1);
