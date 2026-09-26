import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { byRole, launch, sleep } from "./browser";
import { caller, seed } from "./seed";

// pnpm build, then: bun artifacts/dashboard/run.ts <outDir>
// The rebuilt dashboard, end to end: the production build served by
// `next start` on port 3013 with a fresh PERRY_HOME in a temp folder, seeded
// through the backend's own functions (seed.ts), driven by headless Chrome as
// a person would, by role and label. Deleted at the end, except the artifacts.
//
// Ways the dashboard could fail, and what catches each:
//   1. It opens for anyone, or not for the owner: a wrong key must be refused
//      with a message, the right one let in, and `perry open`'s #key= link must
//      unlock by itself and leave the key out of the address.
//   2. A page is missing or broken: every route must render its heading, an
//      unknown one the 404, and each old address must redirect to its new home.
//   3. The sidebar lies: the pinned chat must be under Pinned, the chat waiting
//      on an approval must say so, the schedule's unread chat must show as new,
//      and Needs you must count everything waiting.
//   4. ⌘K doesn't find things: it must open from the keyboard, find a chat by
//      its title, and open it.
//   5. Replies don't render: a reply's headings, lists and table must be real
//      elements, not Markdown text.
//   6. Approvals can't be answered, or answer the wrong thing: the card in the
//      chat must show the exact command and folder, Decline must decline it,
//      and Approve in Needs you must approve another, as the backend records.
//   7. Pinning, reading and dismissing don't stick: a pin from the chat menu,
//      opening an unread chat, and dismissing a watch must each change what the
//      backend returns, not only the page.
//   8. Answering a plan's question loses it: Answer must open a new chat with
//      the question's subject already in the composer.
//   9. Work's tabs don't hold: a tab must be in the address, and the plan that
//      needs you must lead its list.
//  10. Memory can't be corrected: a memory added in the form must appear, and
//      Forget must remove it after asking.
//  11. Sending fails: a first message from a new chat must create the chat,
//      move the address to it, show the message at once, queue its turn, and
//      list it in the sidebar; "/" must offer the commands. A message must
//      never be left "Sending…" once a computer has taken it, and must survive
//      a reload both while its reply is awaited and when no computer could take it.
//  12. The theme doesn't follow or switch: the system's dark must apply, and a
//      choice in Settings must stick in this browser.
//  13. It breaks on a phone or a narrow window: nothing may overflow sideways
//      at 1440, 1280, 768 or 375 pixels, and the sidebar must open as a sheet.
//  14. Text is hard to read: every visible piece of text must meet WCAG AA
//      contrast, in light and in dark.
//  15. Anything throws: no uncaught errors or console errors in the browser.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/dashboard/run.ts <outDir>");
const OUT = resolve(outDir);
mkdirSync(join(OUT, "screens"), { recursive: true });
rmSync(join(OUT, "failure.png"), { force: true });

const REPO = resolve(import.meta.dirname, "../..");
const PORT = 3013;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "dashboard-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-dashboard-e2e-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const failures: Record<string, unknown> = {};
const call = caller(BASE, KEY);
const pub = <T>(path: string, args: object = {}) => call<T>(path, { key: KEY, ...args }, false);

function check(name: string, ok: boolean, detail?: unknown) {
  checks[name] = ok;
  if (!ok && detail !== undefined) failures[name] = detail;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("NEXT_PUBLIC_CONVEX") || name === "TELEGRAM_BOT_TOKEN") delete env[name];
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });
const healthy = () => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false);

// Text against what is really painted behind it. Disabled controls are exempt, as in WCAG.
const CONTRAST = `(() => {
  const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const parse = (c) => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = "rgba(0,0,0,0)"; paint.fillStyle = c; paint.fillRect(0, 0, 1, 1); const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data; return { r, g, b, a: a / 255 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const page = parse(getComputedStyle(document.body).backgroundColor);
  const background = (el, node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const at = stack.findIndex((e) => e === el || el.contains(e));
    const below = (at >= 0 ? stack.slice(at) : [...(function* () { for (let n = el; n; n = n.parentElement) yield n; })()]).reverse();
    return below.reduce((under, e) => over(parse(getComputedStyle(e).backgroundColor), under), page);
  };
  const faded = (el) => { for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) < 1) return true; return false; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const failures = [];
  let seen = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent.trim() || !el.getClientRects().length || el.closest(".sr-only, [aria-hidden=true], nextjs-portal, [disabled], [aria-disabled=true], [data-disabled]")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || faded(el) || style.color.includes("transparent") || parse(style.color).a === 0) continue;
    const bg = background(el, node);
    const fg = over(parse(style.color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    seen++;
    if (ratio < (large ? 3 : 4.5)) failures.push({ text: node.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
  }
  return { seen, failures };
})()`;
const OVERFLOW = `document.documentElement.scrollWidth - document.documentElement.clientWidth`;

const ROUTES: Array<{ path: string; heading: string; name: string }> = [
  { path: "/chat", heading: "New chat", name: "chat-new" },
  { path: "/inbox", heading: "Needs you", name: "inbox" },
  { path: "/work", heading: "Work", name: "work" },
  { path: "/memory", heading: "Memory", name: "memory" },
  { path: "/connectors", heading: "Connectors", name: "connectors" },
  { path: "/computer", heading: "Computer", name: "computer" },
  { path: "/activity", heading: "Activity", name: "activity" },
  { path: "/settings", heading: "Settings", name: "settings" },
];

let page: Awaited<ReturnType<typeof launch>> | null = null;
try {
  for (let i = 0; i < 180 && !(await healthy()); i++) await sleep(500);
  if (!(await healthy())) throw new Error(`the server did not start:\n${log}`);
  const seeded = await seed(BASE, KEY, home);
  notes.seeded = seeded;
  // A second request, to approve from Needs you while the chat's own is declined in the chat.
  const runner = JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string };
  const second = await call<{ id: string }>("approvals:request", { token: runner.token, kind: "write", title: "~/notes/lisbon.md", cwd: "~/notes", conversationId: seeded.pinnedChat }, false);

  page = await launch();
  const p = page;
  const heading = (text: string) => p.waitFor(byRole("heading", text), `the "${text}" heading`);
  await p.scheme("light");
  await p.viewport(1440, 900);

  // 1. The gate.
  await p.go(`${BASE}/chat`);
  await heading("Unlock Perry");
  await p.click(`document.getElementById("dashboard-key")`);
  await p.type("not-the-key");
  await p.press("Enter");
  await p.waitFor(`[...document.querySelectorAll("[role=alert]")].some((el) => /doesn't match/.test(el.innerText))`, "the wrong key to be refused");
  check("gate refuses a wrong key", true);
  await p.evaluate(`(() => { const input = document.getElementById("dashboard-key"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await p.click(`document.getElementById("dashboard-key")`);
  await p.type(KEY);
  await p.press("Enter");
  await p.waitFor(byRole("button", "Search"), "the dashboard to open");
  check("gate lets the owner in", true);
  await p.evaluate(`localStorage.removeItem("perry.dashboard.key")`);
  await p.go(`${BASE}/inbox#key=${KEY}`);
  await heading("Needs you");
  check("#key= link unlocks and leaves the address", await p.evaluate(`!location.hash && localStorage.getItem("perry.dashboard.key") === ${JSON.stringify(KEY)}`));

  // 2. Every page, the 404, and the old addresses.
  const missing: string[] = [];
  for (const route of ROUTES) {
    await p.go(`${BASE}${route.path}`);
    try { await heading(route.heading); } catch { missing.push(route.path); }
  }
  await p.go(`${BASE}/nowhere`);
  try { await heading("Nothing here"); } catch { missing.push("/nowhere (404)"); }
  check("every route renders its heading", missing.length === 0, missing);
  const redirects: Record<string, string> = { "/tasks": "/work", "/about": "/memory?tab=about", "/profile": "/settings", "/keys": "/settings?tab=keys", "/setup": "/settings?tab=telegram" };
  const wrong: Record<string, string | null> = {};
  for (const [from, to] of Object.entries(redirects)) {
    const response = await fetch(`${BASE}${from}`, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 400 || !location || new URL(location, BASE).pathname + new URL(location, BASE).search !== to) wrong[from] = location;
  }
  check("old addresses redirect to their new pages", Object.keys(wrong).length === 0, wrong);

  // 3. The sidebar.
  await p.go(`${BASE}/chat`);
  await p.waitFor(`document.querySelector('[aria-label="Pinned"]')`, "the chat list");
  const sidebar = await p.evaluate<{ pinned: string; waiting: boolean; unread: boolean; count: string }>(`(() => {
    const row = (title) => [...document.querySelectorAll("[data-sidebar=menu-item]")].find((li) => li.innerText.trim().startsWith(title));
    return {
      pinned: document.querySelector('[aria-label="Pinned"]')?.innerText ?? "",
      waiting: Boolean(row("Clean up my downloads")?.querySelector('[aria-label="Waiting for your approval"]')),
      unread: Boolean(row("⏰ Morning briefing")?.querySelector('[aria-label="New reply"]')),
      count: [...document.querySelectorAll("[data-sidebar=menu-item]")].find((li) => li.innerText.includes("Needs you"))?.querySelector("[data-sidebar=menu-badge]")?.innerText ?? "",
    };
  })()`);
  check("the pinned chat is under Pinned", sidebar.pinned.includes("Plan the Lisbon trip"), sidebar);
  check("a chat waiting on an approval says so", sidebar.waiting, sidebar);
  check("a schedule's unread chat shows as new", sidebar.unread, sidebar);
  // Two approvals, a question, a failed plan, a schedule's news and a watch.
  check("Needs you counts everything waiting", sidebar.count === "6", sidebar);
  for (const scheme of ["light", "dark"] as const) {
    await p.scheme(scheme);
    await sleep(300);
    await p.shot(join(OUT, "screens", `chat-new-${scheme}-desktop.png`));
  }
  await p.scheme("light");

  // 4. ⌘K.
  await p.evaluate(`document.activeElement?.blur()`);
  await p.press("k", "KeyK", 2);
  await p.waitFor(`document.querySelector("[cmdk-input]")`, "the palette to open");
  await p.type("Lisbon");
  await p.waitFor(byRole("option", /Plan the Lisbon trip/), "the palette to find the chat");
  await p.shot(join(OUT, "screens", "palette-light-desktop.png"));
  await p.press("Enter");
  await p.waitFor(`location.pathname === ${JSON.stringify(`/chat/${seeded.pinnedChat}`)}`, "the palette to open the chat");
  check("⌘K finds a chat by title and opens it", true);

  // 5. A reply's Markdown.
  await p.waitFor(`document.querySelector("[data-role=assistant] table")`, "the reply to render");
  const markdown = await p.evaluate<{ headings: number; items: number; rows: number; raw: boolean }>(`(() => { const reply = document.querySelector("[data-role=assistant]"); return { headings: reply.querySelectorAll("h2").length, items: reply.querySelectorAll("li").length, rows: reply.querySelectorAll("tr").length, raw: reply.innerText.includes("## ") || reply.innerText.includes("| ---") }; })()`);
  check("a reply renders its headings, lists and table", markdown.headings === 2 && markdown.items === 6 && markdown.rows === 3 && !markdown.raw, markdown);
  for (const scheme of ["light", "dark"] as const) {
    await p.scheme(scheme);
    await sleep(300);
    await p.shot(join(OUT, "screens", `chat-${scheme}-desktop.png`));
  }
  await p.scheme("light");

  // 7a. Pin from the chat menu.
  await p.go(`${BASE}/chat/${seeded.chats[2]}`);
  await p.waitFor(byRole("button", "Chat options"), "the chat menu button");
  await p.click(byRole("button", "Chat options"));
  await p.waitFor(byRole("menuitem", "Pin"), "the chat menu");
  await p.click(byRole("menuitem", "Pin"));
  await p.waitFor(`document.querySelector('[aria-label="Pinned"]')?.innerText.includes("Gym plan")`, "the chat to move under Pinned");
  const pinnedNow = (await pub<Array<{ id: string; pinned: boolean }>>("dashboard:listChats")).find((chat) => chat.id === seeded.chats[2])?.pinned;
  check("pinning from the chat menu sticks", pinnedNow === true);

  // 6a. The approval in its chat: the exact command, then Decline.
  await p.go(`${BASE}/chat/${seeded.approvalChat}`);
  await p.waitFor(byRole("article", /wants to run a command/), "the approval card");
  const card = await p.evaluate<string>(`${byRole("article", /wants to run a command/)}.innerText`);
  check("the approval card shows the exact command and folder", card.includes("-mtime +30 -exec mv") && card.includes("~/Downloads"), card);
  await p.shot(join(OUT, "screens", "approval-light-desktop.png"));
  await p.click(`[...${byRole("article", /wants to run a command/)}.querySelectorAll("button")].find((b) => b.innerText.trim() === "Decline")`);
  await p.waitFor(`!(${byRole("article", /wants to run a command/)})`, "the card to go once answered");
  await sleep(300);
  const recent = await pub<Array<{ id: string; status: string; decidedBy?: string }>>("approvals:recent");
  const declined = recent.find((item) => item.id === seeded.approvalId);
  check("Decline declines it, from the dashboard", declined?.status === "declined" && declined.decidedBy === "dashboard", declined);

  // 7b. Opening an unread chat reads it.
  await p.go(`${BASE}/chat/${seeded.jobChat}`);
  await p.waitFor(`document.querySelector("[data-role=assistant]")`, "the schedule's chat");
  await sleep(800);
  const jobSummary = (await pub<Array<{ id: string; unseen: boolean }>>("dashboard:listChats")).find((chat) => chat.id === seeded.jobChat);
  const inboxAfterRead = await pub<Array<{ kind: string }>>("dashboard:getInbox");
  check("opening an unread chat marks it read", jobSummary?.unseen === false && !inboxAfterRead.some((item) => item.kind === "job-result"), { jobSummary, inboxAfterRead });

  // 6b, 7c, 8. Needs you.
  await p.go(`${BASE}/inbox`);
  await heading("Needs you");
  await p.waitFor(byRole("article", /wants to write a file/), "the second approval");
  for (const scheme of ["light", "dark"] as const) {
    await p.scheme(scheme);
    await sleep(300);
    await p.shot(join(OUT, "screens", `inbox-${scheme}-desktop.png`));
  }
  await p.scheme("light");
  await p.click(`[...${byRole("article", /wants to write a file/)}.querySelectorAll("button")].find((b) => b.innerText.trim() === "Approve")`);
  await p.waitFor(`!(${byRole("article", /wants to write a file/)})`, "the approved card to go");
  await sleep(300);
  const approved = (await pub<Array<{ id: string; status: string }>>("approvals:recent")).find((item) => item.id === second.id);
  check("Approve in Needs you approves it", approved?.status === "approved", approved);
  await p.click(`[...document.querySelectorAll("li")].find((li) => li.innerText.includes("Leica Q3"))?.querySelector("button:last-of-type")`);
  await p.waitFor(`![...document.querySelectorAll("li")].some((li) => li.innerText.includes("Leica Q3"))`, "the watch to be dismissed");
  await sleep(300);
  check("dismissing a watch sticks", !(await pub<Array<{ kind: string }>>("dashboard:getInbox")).some((item) => item.kind === "watch"));
  await p.click(byRole("link", "Answer"));
  await p.waitFor(`document.querySelector("#composer")?.value.startsWith("About “Book the Lisbon flights”")`, "the composer to hold the answer's start");
  check("Answer opens a chat with the question's subject", await p.evaluate(`location.pathname === "/chat" && !location.search`));

  // 9. Work.
  await p.go(`${BASE}/work`);
  await heading("Work");
  await p.click(byRole("tab", /^Plans/));
  await p.waitFor(`location.search === "?tab=plans"`, "the tab to be in the address");
  const firstPlan = await p.evaluate<string>(`document.querySelector('[aria-label="Plans"] li h3')?.innerText ?? ""`);
  check("Work's tab is in the address, and what needs you leads", firstPlan === "Book the Lisbon flights", firstPlan);
  for (const scheme of ["light", "dark"] as const) {
    await p.scheme(scheme);
    await sleep(300);
    await p.shot(join(OUT, "screens", `work-plans-${scheme}-desktop.png`));
  }
  await p.scheme("light");
  await p.click(byRole("tab", /^Watches/));
  await p.waitFor(`document.body.innerText.includes("Leica Q3 back in stock")`, "the watches tab");
  check("each Work tab shows its own", true);

  // 10. Memory.
  await p.go(`${BASE}/memory`);
  await heading("Memory");
  await p.click(`document.getElementById("memory-text")`);
  await p.type("Sam prefers window seats on flights.");
  await p.press("Enter");
  await p.waitFor(`[...document.querySelectorAll('[aria-label="Memories"] li')].some((li) => li.innerText.includes("window seats"))`, "the new memory to appear");
  await p.click(`[...[...document.querySelectorAll('[aria-label="Memories"] li')].find((li) => li.innerText.includes("window seats")).querySelectorAll("button")].find((b) => b.innerText.trim() === "Forget")`);
  await p.waitFor(byRole("button", "Forget"), "the confirmation");
  await p.click(`[...document.querySelectorAll("[role=alertdialog] button")].find((b) => b.innerText.trim() === "Forget")`);
  await p.waitFor(`![...document.querySelectorAll('[aria-label="Memories"] li')].some((li) => li.innerText.includes("window seats"))`, "the memory to go");
  check("a memory can be added and forgotten", !(await pub<Array<{ text: string }>>("dashboard:listMemories", { query: "window seats" })).some((memory) => memory.text.includes("window seats")));

  // 11. Sending.
  await p.go(`${BASE}/chat`);
  await p.waitFor(`document.querySelector("#composer")`, "the composer");
  await p.click(`document.querySelector("#composer")`);
  await p.type("/");
  await p.waitFor(byRole("option", /^\/model/), "the command list");
  check("\"/\" offers the commands", true);
  await p.press("Escape");
  await p.evaluate(`(() => { const box = document.querySelector("#composer"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(box, ""); box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await p.click(`document.querySelector("#composer")`);
  await p.type("What should I pack for Lisbon in October?");
  await p.press("Enter");
  await p.waitFor(`/^\\/chat\\/[^/]+$/.test(location.pathname)`, "the address to move to the new chat");
  const newId = await p.evaluate<string>(`location.pathname.split("/")[2]`);
  await p.waitFor(`[...document.querySelectorAll("[data-sidebar=menu-item]")].some((li) => li.innerText.includes("What should I pack for Lisbon"))`, "the chat in the sidebar");
  // The turn itself waits for a computer, and none is connected here: the chat is named for the message and its turn is queued, or failed saying why.
  const made = await pub<{ title: string; isRunning: boolean; lastError?: string }>("dashboard:getChat", { id: newId });
  check("a first message makes the chat and queues its turn", made.title === "What should I pack for Lisbon in October?" && (made.isRunning || Boolean(made.lastError)), made);
  check("the sent message shows at once", await p.evaluate(`[...document.querySelectorAll("[data-role=user]")].some((el) => el.innerText.includes("pack for Lisbon"))`));
  await p.shot(join(OUT, "screens", "chat-sent-light-desktop.png"));
  // With no computer to take it, the turn fails; the message stays in the chat, above the error, through a reload.
  await p.waitFor(`document.body.innerText.includes("couldn't finish the last reply")`, "the failure to show", 30_000);
  await p.go(`${BASE}/chat/${newId}`);
  await p.waitFor(`document.querySelector("[data-role=assistant], [role=alert]")`, "the chat to load").catch(() => {});
  await p.waitFor(`[...document.querySelectorAll("[data-role=user]")].some((el) => el.innerText.includes("pack for Lisbon"))`, "the message after a reload").catch(() => {});
  const kept = await pub<{ page: Array<{ role: string; text: string; pending?: boolean }> }>("dashboard:getChatMessages", { id: newId, paginationOpts: { numItems: 5, cursor: null } });
  check("a message no computer could take stays in the chat through a reload",
    kept.page.some((message) => message.role === "user" && message.text.includes("pack for Lisbon") && !message.pending)
      && await p.evaluate(`[...document.querySelectorAll("[data-role=user]")].some((el) => el.innerText.includes("pack for Lisbon"))`), kept);

  // A computer that takes the turn and has not answered yet: the message is sent, not "Sending…", and a reload keeps it.
  await call("codex:reportAccount", { token: runner.token, available: true, authMode: "chatgpt" }, false);
  await call("runner:checkIn", { token: runner.token }, false);
  await p.go(`${BASE}/chat`);
  await p.waitFor(`document.querySelector("#composer")`, "the composer");
  await p.click(`document.querySelector("#composer")`);
  await p.type("Find me a quiet cafe near the hotel.");
  await p.press("Enter");
  await p.waitFor(`/^\\/chat\\/[^/]+$/.test(location.pathname)`, "the address to move to the queued chat");
  const queuedId = await p.evaluate<string>(`location.pathname.split("/")[2]`);
  await p.waitFor(`[...document.querySelectorAll("[data-role=user]")].some((el) => el.innerText.includes("quiet cafe"))`, "the queued message");
  await sleep(1500);
  const sendingWhileQueued = await p.evaluate<boolean>(`document.body.innerText.includes("Sending…")`);
  const queuedChat = await pub<{ isRunning: boolean }>("dashboard:getChat", { id: queuedId });
  check("a message a computer has taken is not left \"Sending…\"", queuedChat.isRunning && !sendingWhileQueued, { queuedChat, sendingWhileQueued });
  await p.go(`${BASE}/chat/${queuedId}`);
  await p.waitFor(`[...document.querySelectorAll("[data-role=user]")].some((el) => el.innerText.includes("quiet cafe"))`, "the queued message after a reload").catch(() => {});
  const queued = await pub<{ page: Array<{ role: string; text: string; pending?: boolean }> }>("dashboard:getChatMessages", { id: queuedId, paginationOpts: { numItems: 5, cursor: null } });
  check("a message waiting on its reply stays through a reload",
    queued.page.filter((message) => message.text.includes("quiet cafe")).length === 1 && queued.page.some((message) => message.pending)
      && await p.evaluate(`[...document.querySelectorAll("[data-role=user]")].some((el) => el.innerText.includes("quiet cafe")) && !document.body.innerText.includes("Sending…")`), queued);
  await p.shot(join(OUT, "screens", "chat-queued-light-desktop.png"));

  // 12. Theme.
  await p.scheme("dark");
  await p.go(`${BASE}/settings`);
  await heading("Settings");
  check("the system's dark theme applies", await p.evaluate(`document.documentElement.classList.contains("dark")`));
  await p.scheme("light");
  await p.click(byRole("radio", "Dark"));
  await p.waitFor(`document.documentElement.classList.contains("dark")`, "dark to apply");
  await p.go(`${BASE}/settings`);
  await heading("Settings");
  check("a theme picked in Settings sticks", await p.evaluate(`localStorage.getItem("perry.theme") === "dark" && document.documentElement.classList.contains("dark")`));
  await p.click(byRole("radio", "System"));
  await p.waitFor(`!document.documentElement.classList.contains("dark")`, "the system theme to return");

  // 13, 14. Every page at four widths, in both themes: overflow, contrast, screenshots.
  const overflow: Record<string, number> = {};
  const contrast: Record<string, unknown> = {};
  let texts = 0;
  const pages = [...ROUTES, { path: `/chat/${seeded.pinnedChat}`, heading: "", name: "chat" }, { path: "/settings?tab=keys", heading: "Settings", name: "keys" }, { path: "/settings?tab=telegram", heading: "Settings", name: "telegram" }, { path: "/memory?tab=about", heading: "Memory", name: "about" }, { path: "/welcome", heading: "Meet your assistant", name: "welcome" }];
  for (const [width, height, mobile] of [[1440, 900, false], [1280, 800, false], [768, 1024, true], [375, 812, true]] as const) {
    await p.viewport(width, height, mobile);
    for (const scheme of ["light", "dark"] as const) {
      await p.scheme(scheme);
      for (const route of pages) {
        await p.go(`${BASE}${route.path}`);
        if (route.heading) await heading(route.heading).catch(() => {});
        else await p.waitFor(`document.querySelector("[data-role=assistant]")`, "the chat").catch(() => {});
        await sleep(250);
        const over = await p.evaluate<number>(OVERFLOW);
        if (over > 0) overflow[`${route.path} ${width} ${scheme}`] = over;
        if (width === 1440 || width === 375) {
          const result = await p.evaluate<{ seen: number; failures: unknown[] }>(CONTRAST);
          texts += result.seen;
          if (result.failures.length) contrast[`${route.path} ${width} ${scheme}`] = result.failures;
          await p.shot(join(OUT, "screens", `${route.name}-${scheme}-${width === 1440 ? "desktop" : "phone"}.png`));
        }
      }
    }
  }
  check("nothing overflows at 1440, 1280, 768 or 375", Object.keys(overflow).length === 0, overflow);
  check(`text meets WCAG AA in light and dark (${texts} text nodes)`, Object.keys(contrast).length === 0, contrast);

  await p.viewport(375, 812, true);
  await p.scheme("light");
  await p.go(`${BASE}/inbox`);
  await heading("Needs you");
  await p.click(byRole("button", "Toggle Sidebar"));
  await p.waitFor(`[...document.querySelectorAll("[role=dialog]")].some((d) => d.innerText.includes("Plan the Lisbon trip"))`, "the sidebar sheet");
  await sleep(400);
  await p.shot(join(OUT, "screens", "sidebar-light-phone.png"));
  check("on a phone the sidebar opens as a sheet", true);

  // 15.
  notes.pageErrors = p.errors;
  check("no uncaught errors or console errors", p.errors.length === 0, p.errors);
} catch (cause) {
  checks.completed = false;
  failures.completed = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  console.error(cause);
  // What the page showed when it stopped.
  await page?.shot(join(OUT, "failure.png")).catch(() => {});
  notes.failurePage = await page?.evaluate(`[location.href, document.body.innerText.slice(0, 1500)]`).catch((error) => String(error));
  notes.failureErrors = page?.errors;
  notes.failurePending = page?.pending();
  notes.failureServerAnswers = await pub("dashboard:getStatus").then(() => true, (error) => String(error));
} finally {
  page?.close();
  if (server.pid) {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill("SIGTERM");
  }
  await sleep(1500);
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  const passed = Object.values(checks).every(Boolean);
  writeFileSync(join(OUT, "result.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform, passed, checks, failures, notes }, null, 2)}\n`);
  console.log(passed ? `\nAll ${Object.keys(checks).length} checks passed.` : "\nSome checks failed; see result.json.");
  process.exit(passed ? 0 : 1);
}
