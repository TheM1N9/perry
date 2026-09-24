import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openChat, sleep } from "../browser";

// bun artifacts/sidebar/run.ts <outDir> <dashboardKey>
// Needs `next dev -p 3005` against a deployment with this branch's dashboard
// functions and at least two web chats. Read-only: dialogs are opened and
// cancelled, and nothing is renamed, deleted or sent.
//
// Ways this could fail, and what catches each:
//   1. "Chat" is still a sidebar item: no nav link may point at /chat, and the
//      Main nav must read exactly Tasks.
//   2. Leaving the chat page strips the sidebar: on Tasks, Profile and Keys the
//      sidebar must show New chat, Search, Tasks and the same chat rows, in the
//      same order, as on the chat page.
//   3. A chat picked from another page goes nowhere, or to the wrong chat: from
//      Tasks, clicking the second chat must open /chat/<its id> with its title
//      in the header, and that row must be marked current.
//   4. Search only works on the chat page: Ctrl K on Tasks must open the search
//      dialog, and Escape must close it.
//   5. Rename and delete only work on the chat page: on Tasks, a row's menu must
//      open, and Rename and Delete must each open their dialog (then cancel).
//   6. New chat from another page lands on an old chat: from Tasks it must open
//      /chat with the welcome screen, not a conversation.
//   7. Tasks loses its highlight or the chat page gains one: Tasks is current on
//      /tasks, and no nav link is current on the chat page.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/sidebar/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const browser = await openChat(base, dashboardKey);
const { evaluate, send } = browser;
const waitFor = (test: string, what: string) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > 30000 ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); tick(); })`);
const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const sidebar = () => evaluate(`({
  actions: [...document.querySelectorAll(".sidebar-actions > button")].map((b) => b.innerText.split("\\n")[0].trim()),
  nav: [...document.querySelectorAll("nav[aria-label=Main] a")].map((a) => a.innerText.trim()),
  navToChat: document.querySelectorAll(".sidebar a.nav-item[href^='/chat']").length,
  rows: [...document.querySelectorAll(".chat-list-select")].map((a) => a.getAttribute("href")),
  currentNav: [...document.querySelectorAll(".sidebar a.nav-item[aria-current=page]")].map((a) => a.innerText.trim()),
})`);
const open = async (path: string) => {
  await send("Page.navigate", { url: `${base}${path}` });
  await waitFor(`document.querySelectorAll(".chat-list-select").length > 0`, `no chat list on ${path}`);
  await sleep(500);
};

try {
  // The chat page, as the reference.
  const onChat = await sidebar();
  notes.onChat = { ...onChat, rows: onChat.rows.length };
  checks.noChatNavItem = onChat.navToChat === 0 && JSON.stringify(onChat.nav) === JSON.stringify(["Tasks"]);
  checks.nothingCurrentOnChat = onChat.currentNav.length === 0;
  checks.enoughChats = onChat.rows.length >= 2;

  // 2. The same sidebar elsewhere.
  const same: Record<string, boolean> = {};
  for (const path of ["/tasks", "/profile", "/keys"]) {
    await open(path);
    const here = await sidebar();
    same[path] = JSON.stringify(here.actions) === JSON.stringify(["New chat", "Search"])
      && JSON.stringify(here.nav) === JSON.stringify(["Tasks"])
      && JSON.stringify(here.rows) === JSON.stringify(onChat.rows);
    if (path === "/tasks") checks.tasksIsCurrent = JSON.stringify(here.currentNav) === JSON.stringify(["Tasks"]);
    await shot(`sidebar-${path.slice(1)}.png`);
  }
  notes.sameSidebar = same;
  checks.sameSidebarEverywhere = Object.values(same).every(Boolean);

  // 4. Search from Tasks.
  await open("/tasks");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", modifiers: 2, windowsVirtualKeyCode: 75 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", modifiers: 2, windowsVirtualKeyCode: 75 });
  await waitFor(`!!document.querySelector("dialog[open] input[aria-label='Search chats']")`, "Ctrl K did not open search on Tasks");
  await shot("search-on-tasks.png");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector("dialog[open]")`, "search did not close");
  checks.searchOnTasks = true;

  // 5. Rename and delete dialogs from Tasks, both cancelled.
  const openMenu = `(() => { const row = document.querySelectorAll(".chat-list-item")[1]; row.querySelector(".chat-list-more").click(); return true; })()`;
  await evaluate(openMenu);
  await waitFor(`!!document.querySelector(".chat-list-item .menu")`, "row menu did not open on Tasks");
  await evaluate(`[...document.querySelectorAll(".menu button")].find((b) => b.innerText.includes("Rename")).click(); true`);
  await waitFor(`!!document.querySelector("dialog[open] #rename-chat")`, "rename dialog did not open on Tasks");
  await shot("rename-on-tasks.png");
  await evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.innerText === "Cancel").click(); true`);
  await waitFor(`!document.querySelector("dialog[open]")`, "rename did not cancel");
  await evaluate(openMenu);
  await waitFor(`!!document.querySelector(".chat-list-item .menu")`, "row menu did not reopen");
  await evaluate(`[...document.querySelectorAll(".menu button")].find((b) => b.innerText.includes("Delete")).click(); true`);
  await waitFor(`!!document.querySelector("dialog[open][role=alertdialog]")`, "delete dialog did not open on Tasks");
  await evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.innerText === "Cancel").click(); true`);
  await waitFor(`!document.querySelector("dialog[open]")`, "delete did not cancel");
  checks.rowActionsOnTasks = true;
  checks.rowsUnchanged = JSON.stringify((await sidebar()).rows) === JSON.stringify(onChat.rows);

  // 3. Opening a chat from Tasks.
  const target = await evaluate(`(() => { const a = document.querySelectorAll(".chat-list-select")[1]; return { href: a.getAttribute("href"), title: a.title }; })()`);
  await evaluate(`document.querySelectorAll(".chat-list-select")[1].click(); true`);
  await waitFor(`location.pathname === ${JSON.stringify(target.href)} && !!document.querySelector(".chat-header-title strong")`, "picking a chat on Tasks did not open it");
  await waitFor(`document.querySelector(".chat-header-title strong").innerText === ${JSON.stringify(target.title)}`, "the wrong chat opened");
  checks.chatOpensFromTasks = await evaluate(`document.querySelector(".chat-list-select[aria-current=page]")?.getAttribute("href") === ${JSON.stringify(target.href)}`);
  await shot("opened-from-tasks.png");

  // 6. New chat from Tasks.
  await open("/tasks");
  await evaluate(`[...document.querySelectorAll(".sidebar-actions button")].find((b) => b.innerText.includes("New chat")).click(); true`);
  await waitFor(`location.pathname === "/chat" && !!document.querySelector(".chat-welcome")`, "New chat on Tasks did not open a fresh chat");
  checks.newChatFromTasks = await evaluate(`!document.querySelector(".chat-list-select[aria-current=page]")`);
  await shot("new-chat-from-tasks.png");

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} finally {
  browser.close();
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
