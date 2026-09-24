import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openChat, sleep } from "../browser";

// bun artifacts/profile/run.ts <outDir> <dashboardKey>
// Needs `next dev -p 3005` against a deployment that has this branch's
// dashboard functions. Read-only: it only clicks links.
//
// Ways this could fail, and what catches each:
//   1. The sidebar still lists every page: its Main nav must hold exactly
//      Tasks (chats are the list below it), and there must be no Configure group.
//   2. A page becomes unreachable: the Profile page must link Memory,
//      Connectors, Activity, Computer, Settings, Keys and Setup, and each link
//      must open that page with its own heading.
//   3. You lose your place on a moved page: the breadcrumb must read
//      Perry / Profile / <page>, its Profile link must lead back, and the
//      sidebar's profile button must stay marked current.
//   4. The profile button is missing from Chat, the page you spend time on.
//   5. Old links break: /connectors opened directly (Composio's return URL)
//      must still render the Connectors page.
//   6. The phone layout breaks: at 390px the drawer must show the profile
//      button, and Profile rows must stay one line of icon, text and chevron.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/profile/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const moved = ["memory", "connectors", "activity", "computer", "settings", "keys", "setup"];
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const browser = await openChat(base, dashboardKey);
const { evaluate, send } = browser;
const waitFor = (test: string, what: string) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > 30000 ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); tick(); })`);
const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const heading = () => evaluate(`document.querySelector(".page-head h1")?.innerText ?? ""`);

try {
  // 4. The profile button on Chat.
  checks.profileButtonOnChat = await evaluate(`!!document.querySelector(".sidebar-footer a.profile-link[href='/profile']")`);

  // 1. The sidebar's main nav.
  const mainNav = await evaluate(`[...document.querySelectorAll("nav[aria-label=Main] a")].map((a) => a.innerText.trim())`);
  notes.mainNav = mainNav;
  checks.sidebarIsTasksOnly = JSON.stringify(mainNav) === JSON.stringify(["Tasks"]) && !(await evaluate(`!!document.querySelector("nav[aria-label=Configure]")`));
  await shot("chat-sidebar.png");

  // Open Profile from the button.
  await evaluate(`document.querySelector(".sidebar-footer a.profile-link").click(); true`);
  await waitFor(`location.pathname === "/profile" && document.querySelector(".profile-card")`, "Profile page never opened");
  checks.profileOpensFromButton = (await heading()) === "Profile" && (await evaluate(`document.querySelector(".profile-link").getAttribute("aria-current") === "page"`));
  await shot("profile.png");

  // 2 and 3. Every moved page, from Profile and back.
  const linked = await evaluate(`[...document.querySelectorAll("a.item-link")].map((a) => a.getAttribute("href"))`);
  notes.profileLinks = linked;
  checks.profileLinksEveryMovedPage = moved.every((id) => linked.includes(`/${id}`)) && linked.length === moved.length;
  const visits: Record<string, boolean> = {};
  for (const id of moved) {
    await evaluate(`document.querySelector("a.item-link[href='/${id}']").click(); true`);
    await waitFor(`location.pathname === "/${id}"`, `${id} never opened`);
    await sleep(300);
    const crumb = await evaluate(`document.querySelector(".breadcrumb").innerText.replace(/\\s+/g, " ").trim()`);
    const current = await evaluate(`document.querySelector(".profile-link").getAttribute("aria-current") === "page"`);
    const title = await heading();
    visits[id] = crumb.startsWith("Perry / Profile / ") && crumb.endsWith(title) && title.length > 0 && current;
    await evaluate(`document.querySelector(".breadcrumb a[href='/profile']").click(); true`);
    await waitFor(`location.pathname === "/profile" && document.querySelector(".profile-card")`, `no way back from ${id}`);
  }
  notes.visits = visits;
  checks.everyMovedPageOpensWithProfileCrumb = Object.values(visits).every(Boolean);

  // Tasks stays a top-level page, with no Profile crumb.
  await evaluate(`document.querySelector("nav[aria-label=Main] a[href='/tasks']").click(); true`);
  await waitFor(`location.pathname === "/tasks"`, "Tasks never opened");
  await sleep(300);
  checks.tasksIsTopLevel = await evaluate(`!document.querySelector(".breadcrumb a[href='/profile']") && document.querySelector("nav[aria-label=Main] a[href='/tasks']").getAttribute("aria-current") === "page"`);

  // 5. A direct link still works.
  await send("Page.navigate", { url: `${base}/connectors` });
  await waitFor(`document.querySelector(".page-head h1")?.innerText === "Connectors"`, "/connectors did not render");
  checks.directLinkStillWorks = true;
  await shot("connectors-crumb.png");

  // 6. Phone.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${base}/profile` });
  await waitFor(`document.querySelector(".profile-card")`, "Profile did not render on a phone");
  await sleep(400);
  checks.phoneRowsStayInline = await evaluate(`[...document.querySelectorAll("a.item-link")].every((a) => getComputedStyle(a).flexDirection === "row")`);
  await shot("profile-phone.png");
  await evaluate(`document.querySelector(".mobile-menu").click(); true`);
  await sleep(400);
  checks.phoneDrawerHasProfile = await evaluate(`(() => { const r = document.querySelector(".sidebar.open .profile-link")?.getBoundingClientRect(); return !!r && r.width > 0 && r.bottom <= innerHeight; })()`);
  await shot("drawer-phone.png");

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} finally {
  browser.close();
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
