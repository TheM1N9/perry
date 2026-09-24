import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS } from "../../app/sections";
import { openChat, sleep } from "../browser";

// bun artifacts/layout/run.ts <outDir> <dashboardKey>
// Needs `next dev -p 3005` against a deployment with this branch's dashboard
// functions and at least one web chat. Read-only.
//
// Ways this could fail, and what catches each:
//   1. A second scrollbar: something absolutely positioned (a screen-reader
//      label, say) escapes the page's own scroll area and makes the document
//      itself scroll. On every page, at desktop and phone widths, the document
//      must be no taller than the window.
//   2. The chat list still has icons: no chat row may contain an svg besides
//      its actions button.
//   3. The count beside "Chats" is back: the label must read exactly "Chats".
//   4. Date groups are back: no Today, Yesterday, Previous 7 days or Older
//      labels, and the rows must be one list in the order the server sent.
//   5. The tab says "Perry" on a page opened directly: every page but Chat
//      must be titled "<page> · Perry" once it has loaded.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/layout/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const browser = await openChat(base, dashboardKey);
const { evaluate, send } = browser;
const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const settle = () => evaluate(`new Promise((resolve) => { const start = Date.now(); const tick = () => document.querySelector(".page-head, .chat-main") && !document.querySelector(".skeleton, .loading") || Date.now() - start > 20000 ? setTimeout(() => resolve(true), 600) : setTimeout(tick, 150); tick(); })`);
const documentOverflow = () => evaluate(`document.documentElement.scrollHeight - innerHeight`);

try {
  // 2, 3 and 4. The chat list.
  const list = await evaluate(`(() => {
    const rows = [...document.querySelectorAll(".chat-list-item")];
    return {
      rows: rows.length,
      rowIcons: rows.filter((row) => row.querySelector(".chat-list-select svg")).length,
      label: [...document.querySelectorAll(".sidebar-label")].map((el) => el.innerText.trim()),
      dateLabels: [...document.querySelectorAll(".sidebar-scroll *")].filter((el) => el.children.length === 0 && /^(Today|Yesterday|Previous 7 days|Older)$/.test(el.textContent.trim())).length,
      groups: document.querySelectorAll(".chat-group").length,
    };
  })()`);
  notes.chatList = list;
  checks.chatListHasRows = list.rows > 0;
  checks.noChatIcons = list.rowIcons === 0;
  checks.noChatCount = JSON.stringify(list.label) === JSON.stringify(["Chats"]);
  checks.noDateGroups = list.dateLabels === 0 && list.groups === 1;
  await shot("chat-sidebar.png");

  // 1. No page scrolls the document, at either width.
  const overflow: Record<string, number> = {};
  const titles: Record<string, string> = {};
  for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]] as const) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    for (const section of SECTIONS) {
      const path = section.id === "chat" ? "/chat" : `/${section.id}`;
      await send("Page.navigate", { url: `${base}${path}` });
      await sleep(500);
      await settle();
      overflow[`${width}${path}`] = await documentOverflow();
      if (width === 1280 && section.id !== "chat") titles[path] = await evaluate(`document.title`);
    }
  }
  notes.documentOverflow = overflow;
  checks.oneScrollbarEverywhere = Object.values(overflow).every((extra) => extra <= 0);
  notes.titles = titles;
  checks.titledOnDirectLoad = SECTIONS.filter((section) => section.id !== "chat").every((section) => titles[`/${section.id}`] === `${section.label} · Perry`);

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const path of ["/keys", "/tasks"]) {
    await send("Page.navigate", { url: `${base}${path}` });
    await sleep(500);
    await settle();
    await shot(`${path.slice(1)}.png`);
  }

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} finally {
  browser.close();
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
