import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";
import { seed, startPerry, type Perry } from "../fewer-boxes/seed";

// bun artifacts/settings-sections/run.ts <outDir> [--before <checkout>]
// Issue #184: the navigation regrouped. Settings is one page of sections, each
// at /settings/<section>, in groups down the left (a switcher on a phone);
// Computer, Activity and the Keys tab are gone into it, each key beside what
// it unlocks; Connectors and Skills are one page, Apps & skills, in the
// sidebar with Memory; the account menu is the plan, what is left of it,
// Theme, Settings and Lock. Old addresses redirect.
// A fresh Perry and the fewer-boxes seed (artifacts/fewer-boxes/seed.ts: the
// production build on a free port, its own PERRY_HOME, CODEX_HOME and
// CLAUDE_CONFIG_DIR, no Telegram or Composio, the runner played by its calls),
// plus Claude Code signed in on Claude Max, Codex's 5-hour and weekly limits,
// and an approval rule. Headless Chrome at 1280×800 and 375×812, light and
// dark. With --before <checkout>, pictures of the old tabs, the Computer and
// Connectors pages and the phone's tab row from that checkout's build, and no
// checks.
//
// Ways it could fail, written down before the checks:
//   1. A section does not render at its address, renders another's contents,
//      or something the old tabs, the Computer page or Connectors held is in
//      no section: each section is checked for what it should hold.
//   2. A key is still on a page of keys rather than beside what it unlocks:
//      the Telegram token outside Telegram, the Gemini key outside Engines &
//      usage, the Composio key outside Connectors, a Keys tab anywhere.
//   3. The nav's groups or order differ from the issue's table, a group of
//      one is named twice, or the nav is drawn as a box.
//   4. The active state is wrong: no section marked, two marked, or the wrong
//      one; or the sidebar's Computer row is not marked on Computers.
//   5. The keyboard cannot use the nav: Tab does not reach it, the arrows,
//      Home and End do not move along it, Enter does not open a section, or
//      the focus is not shown.
//   6. An old address lands wrong: /connectors, /skills, /computer,
//      /activity, /settings, each /settings?tab=…, /keys, /profile and /setup;
//      or a redirect drops its query (?session=, ?skill=, ?connected=), or an
//      unknown section is not a 404.
//   7. The account menu still lists pages, lacks Usage, Theme, Settings or
//      Lock, or shows usage itself (#197 moved it to Settings → Usage, which
//      its Usage opens); or the line under the name still counts memories
//      instead of the plan and engine.
//   8. The sidebar lacks Memory or Apps & skills or has them out of order; the
//      footer is not the pet, then the computer, then the owner; Pet settings
//      or the computer row lands somewhere else.
//   9. A link in the app points at an address that is gone: every a[href] on
//      every page visited, every router.push target clicked (the account
//      menu, the pet's menu, the command palette) and the pet's own targets
//      must land on a page that is not a 404.
//  10. A key does not save from its new home (the Telegram token in
//      Telegram, the Composio key in Connectors), or Connectors does not
//      notice the new key until reloaded.
//  11. Approval rules no longer list, or cannot be deleted, from Access &
//      approvals.
//  12. On a phone the left nav shows instead of the switcher, the switcher
//      does not go anywhere, or a section overflows the 375px width (the old
//      row of seven tabs overflowed by 68px).
//  13. Apps & skills: a tab does not open at its address, or Connectors or
//      Skills shows its own page heading inside the page.
//  14. Anything throws or logs an error, in either theme.
//  15. A picture proves nothing: each is taken once its seeded words show.
// After the owner's review:
//  16. Logins & secrets is not a section of its own, holds more than the
//      logins, or the logins are still in Access & approvals.
//  17. New chat and Search are not one row: New chat under 70% of it, Search
//      with words or without its name, tooltip and shortcut, or a box around
//      the row; collapsed to icons, the two are not stacked, New chat first.
//  18. The chat list still has date headings (Today, Yesterday, Previous 7
//      days…), a Pinned heading, pinned chats not first, or the rest not
//      newest first; or a pinned chat has no pin to say so.

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: bun artifacts/settings-sections/run.ts <outDir> [--before <checkout>]");
const beforeAt = args.indexOf("--before");
const REPO = beforeAt >= 0 ? resolve(args[beforeAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BEFORE = beforeAt >= 0;
const OUT = resolve(outDir);
mkdirSync(OUT, { recursive: true });

const KEY = "settings-sections-e2e-key";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => {
  checks[name] = ok;
  if (note !== undefined) notes[name] = note;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && note !== undefined ? ` ${JSON.stringify(note).slice(0, 600)}` : ""}`);
};

/** The issue's table: each group, its sections, and what each must show once loaded (the first is waited for). */
const GROUPS: Array<[string, Array<[string, string, string[]]>]> = [
  ["Perry", [
    ["general", "General", ["Update on his own at night", "Your assistant", "Personality", "Appearance", "Updates"]],
    ["engines", "Engines", ["Gemini API key", "Engines", "Codex", "Claude Code"]],
    // #197: usage left Engines for a section of its own, which the account menu's Usage opens.
    ["usage", "Usage", ["Perry's share this week", "Your plans", "Codex", "Claude Code"]],
    ["computers", "Computers", ["a-long-folder-name", "Computers", "Revoke"]],
  ]],
  ["Permissions", [["access", "Access & approvals", ["pnpm test", "Access for new chats", "Always allowed", "Recent requests", "git push origin main"]]]],
  ["Reaching you", [
    ["notifications", "Notifications", ["Quiet hours", "Messages Perry sends on his own", "At most", "When you're away"]],
    ["telegram", "Telegram", ["Pair with Telegram", "Telegram bot token", "Generate code"]],
    ["whatsapp", "WhatsApp", ["A separate number", "WhatsApp may ban the number", "Link WhatsApp"]],
  ]],
  ["Desktop pet", [["desktop-pet", "Desktop pet", ["Show Perry the screen", "Others follow their system", "Let Perry look at the screen", "Keyboard shortcuts", "Talk to Perry"]]]],
  ["People", [["people", "People", ["Talks with Perry", "Datta"]]]],
  ["Security", [
    ["logins", "Logins & secrets", ["Netflix", "Logins & secrets", "Add a login", "sam@example.com"]],
    ["security", "Dashboard key", ["Lock this browser", "Dashboard key", "DASHBOARD_KEY", "Lock dashboard"]],
  ]],
  ["System", [["activity", "Activity log", ["Export last year's receipts", "Plan my week", "Runs"]]]],
];
const SECTIONS = GROUPS.flatMap(([group, sections]) => sections.map(([slug, label, words]) => ({ group, slug, label, words })));
/** Words that must stay in one place: a key outside its home, or Keys, means the move is not done. */
const ONLY_IN: Array<[string, string]> = [["Telegram bot token", "telegram"], ["Gemini API key", "engines"], ["Composio key", "apps"], ["Logins & secrets", "logins"], ["Add a login", "logins"], ["Netflix", "logins"], ["Keyboard shortcuts", "desktop-pet"]];

const OLD_TABS = ["general", "usage", "keys", "people", "shortcuts", "telegram", "whatsapp"] as const;
const REDIRECTS: Record<string, string> = {
  "/settings": "/settings/general",
  "/settings?tab=general": "/settings/general",
  "/settings?tab=usage": "/settings/usage",
  "/settings?tab=keys": "/settings/logins",
  "/settings?tab=keys&key=TELEGRAM_BOT_TOKEN": "/settings/telegram",
  "/settings?tab=keys&key=COMPOSIO_API_KEY": "/apps/connectors",
  "/settings?tab=keys&key=GEMINI_API_KEY": "/settings/engines",
  "/settings?tab=people": "/settings/people",
  "/settings?tab=shortcuts": "/settings/desktop-pet#shortcuts",
  "/settings?tab=telegram": "/settings/telegram",
  "/settings?tab=whatsapp": "/settings/whatsapp",
  "/settings?tab=nonsense": "/settings/general",
  "/connectors": "/apps/connectors",
  "/connectors?connected=slack&status=failed": "/apps/connectors?connected=slack&status=failed",
  "/skills": "/apps/skills",
  "/skills?skill=weekly-review": "/apps/skills?skill=weekly-review",
  "/computer": "/settings/computers",
  "/activity": "/settings/activity",
  "/activity?status=error": "/settings/activity?status=error",
  "/apps": "/apps/connectors",
  "/keys": "/settings/logins",
  "/profile": "/settings/general",
  "/setup": "/settings/telegram",
};
/** Where the pet sends the dashboard (components/pet/pet.tsx, pet/main.js): not links, so the crawl does not find them. */
const PET_TARGETS = ["/settings/engines", "/settings/desktop-pet#shortcuts", "/"];

type Browser = Awaited<ReturnType<typeof openChat>>;
let browser: Browser | null = null;
let perry: Perry | null = null;

try {
  perry = await startPerry({ repo: REPO, key: KEY, name: "settings-sections" });
  const { base: BASE, call, until, soon, token } = perry;
  const { planChat, receiptsChat } = await seed(perry, notes);

  // --- What this check adds to the seed: a second engine, Codex's limits, an approval rule ----------
  const now = Date.now();
  const engines = [
    { kind: "codex", installed: true, signedIn: true, auth: { type: "chatgpt", label: "ChatGPT", plan: "plus" }, models: [] },
    { kind: "claude", installed: true, signedIn: true, auth: { type: "subscription", label: "Claude", plan: "max", email: "sam@example.com" }, models: [] },
  ];
  await call("engines:report", { token, engines }).catch((error) => { notes.enginesSeed = String(error); });
  await call("usage:report", { token, engine: "codex", limits: {
    plan: "plus", at: now,
    windows: [
      { id: "codex:primary", label: "5-hour", usedPercent: 37, resetsAt: now + 2 * 3_600_000 + 13 * 60_000, minutes: 300 },
      { id: "codex:secondary", label: "Weekly", usedPercent: 84, resetsAt: now + 3 * 86_400_000, minutes: 10_080 },
    ],
  } }).catch((error) => { notes.usageSeed = String(error); });
  const ask = await call<{ id: string }>("approvals:request", { token, kind: "command", title: "pnpm test", cwd: perry.workdir });
  await call("approvals:decide", { key: KEY, id: ask.id, approved: true, always: true }).catch((error) => { notes.ruleSeed = String(error); });

  // --- The browser -------------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errors = []; { const e = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ").slice(0, 300)); e(...a); }; }` });
  const errors: Array<{ page: string; error: string }> = [];
  const collectErrors = async (page: string) => { for (const error of (await evaluate(`window.__errors ?? []`).catch(() => [])) as string[]) errors.push({ page, error }); await evaluate(`window.__errors = []; true`).catch(() => {}); };
  const waitFor = (test: string, what: string, seconds = 20) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const text = () => evaluate(`document.querySelector("main")?.innerText ?? document.body.innerText`) as Promise<string>;
  /** What the open section shows, without the nav beside it, which names every section. */
  const sectionText = () => evaluate(`document.querySelector('nav[aria-label=Settings]')?.parentElement.lastElementChild.innerText ?? ""`) as Promise<string>;
  const where = () => evaluate(`location.pathname + location.search + location.hash`) as Promise<string>;
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  let width = 1280;
  const size = async (w: number, h: number) => { width = w; await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }); };
  const go = async (path: string, words: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(`document.body.innerText.includes(${JSON.stringify(words)})`, `${path} to show "${words}"`, 30);
    await sleep(700);
  };
  let theme: "light" | "dark" = "light";
  const shot = async (name: string, full = true) => {
    let clip: object | undefined;
    if (full) {
      const height = await evaluate(`Math.max(document.documentElement.scrollHeight, document.querySelector("main")?.scrollHeight ?? 0)`) as number;
      const viewport = await evaluate(`innerHeight`) as number;
      if (height > viewport) clip = { x: 0, y: 0, width, height: Math.min(height, 5000), scale: 1 };
    }
    const image = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) }) as { data: string };
    writeFileSync(join(OUT, `${BEFORE ? "before-" : ""}${name}-${theme}.png`), Buffer.from(image.data, "base64"));
  };
  // Scrolled only as far as needed: scrolling a long page under an open menu would move the page, not the menu.
  const middle = (expression: string) => evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
  const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
  const click = async (expression: string) => {
    const point = await middle(expression);
    if (!point) throw new Error(`nothing to click: ${expression}`);
    await mouse("mouseMoved", point.x, point.y);
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseReleased", point.x, point.y);
    await sleep(300);
  };
  const KEYS = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 } as const;
  const press = async (name: keyof typeof KEYS, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: KEYS[name], modifiers, ...(name === "Enter" ? { text: "\r" } : {}) });
    if (name === "Enter") await send("Input.dispatchKeyEvent", { type: "char", key: name, code: name, windowsVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: KEYS[name], modifiers });
    await sleep(200);
  };
  const byText = (selector: string, words: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.offsetParent !== null && el.innerText.trim().includes(${JSON.stringify(words)}))`;
  /** The owner, last in the sidebar's footer: the account menu's button. */
  const ACCOUNT = `[...document.querySelectorAll("[data-sidebar=footer] [data-sidebar=menu-button]")].at(-1)`;
  const typeText = async (words: string) => { await send("Input.insertText", { text: words }); await sleep(120); };
  const focus = (expression: string) => evaluate(`(() => { const el = ${expression}; el.focus(); return true; })()`);
  const is404 = () => evaluate(`document.body.innerText.includes("Nothing here")`) as Promise<boolean>;
  /** Every link on the page, by address, for the crawl. */
  const hrefs = new Map<string, string>();
  const gather = async (page: string) => {
    const found = await evaluate(`[...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))`) as string[];
    for (const href of found) if (!hrefs.has(href)) hrefs.set(href, page);
  };
  /** How far anything on the page reaches past the window's right edge, outside what scrolls sideways on purpose. */
  const OVERFLOW = `(() => {
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    let worst = 0, what = null;
    for (const el of document.querySelectorAll("main *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let up = el.parentElement, scrolls = false;
      while (up && up !== document.body) { const x = getComputedStyle(up).overflowX; if (x === "auto" || x === "scroll") { scrolls = true; break; } up = up.parentElement; }
      if (scrolls || el.closest(".sr-only")) continue;
      const over = r.right - innerWidth;
      if (over > worst + 0.5) { worst = over; what = el.tagName.toLowerCase() + " " + String(el.className).slice(0, 60) + " " + (el.innerText ?? "").trim().slice(0, 30); }
    }
    const tabs = [...document.querySelectorAll("[data-slot=tabs-list]")].map((el) => el.scrollWidth - el.clientWidth);
    return { doc, worst: Math.round(worst), what, tabs };
  })()`;

  if (BEFORE) {
    // --- The old pages, for the before pictures ---------------------------------------------------
    for (const mode of ["light", "dark"] as const) {
      theme = mode;
      await scheme(mode);
      await size(1280, 800);
      const words: Record<(typeof OLD_TABS)[number], string> = { general: "Quiet hours", usage: "Your plans", keys: "Logins and secrets", people: "Talks with Perry", shortcuts: "Show Perry the screen", telegram: "Pair with Telegram", whatsapp: "A separate number" };
      for (const tab of OLD_TABS) {
        await go(`/settings?tab=${tab}`, words[tab]);
        await shot(`settings-${tab}`);
      }
      await go("/computer", "Recent requests");
      await shot("computer");
      await go("/connectors", "Composio");
      await shot("connectors");
      await go("/skills", "weekly-review");
      await shot("skills");
      await go("/activity", "Export last year's receipts");
      await shot("activity");
      // The account menu, as it was.
      await click(ACCOUNT);
      await waitFor(`document.querySelector("[role=menu]")`, "the account menu");
      await sleep(400);
      await shot("account-menu", false);
      notes[`accountMenu-${mode}`] = await evaluate(`document.querySelector("[role=menu]").innerText`);
      await press("Escape");
    }
    theme = "light";
    await scheme("light");
    await size(375, 812);
    await go("/settings", "Quiet hours");
    notes.phoneOverflowBefore = await evaluate(OVERFLOW);
    await shot("phone-settings", false);
    writeFileSync(join(OUT, "before.json"), JSON.stringify({ ranAt: new Date().toISOString(), notes }, null, 2) + "\n");
  } else {
    // --- 1, 2, 4, 14, 15. Every section at its address, in both themes -----------------------------------
    const misplaced: Record<string, string[]> = {};
    const missing: Record<string, string[]> = {};
    const marked: Record<string, unknown> = {};
    for (const mode of ["light", "dark"] as const) {
      theme = mode;
      await scheme(mode);
      await size(1280, 800);
      for (const section of SECTIONS) {
        await go(`/settings/${section.slug}`, section.words[0]);
        if (mode === "light") {
          const shown = await sectionText();
          const absent = section.words.filter((words) => !shown.includes(words));
          if (absent.length) missing[section.slug] = absent;
          for (const [words, home] of ONLY_IN) if (home !== section.slug && shown.includes(words)) (misplaced[section.slug] ??= []).push(words);
          if (/\bKeys\b/.test(await evaluate(`[...document.querySelectorAll("main h1, main h2, main h3, nav a, [role=tab]")].map((el) => el.innerText).join("\\n")`) as string)) (misplaced[section.slug] ??= []).push("Keys");
          const current = await evaluate(`[...document.querySelectorAll('nav[aria-label=Settings] a[aria-current=page]')].map((a) => a.innerText.trim())`) as string[];
          if (current.length !== 1 || current[0] !== section.label) marked[section.slug] = current;
          const title = await evaluate(`document.title`) as string;
          if (!title.startsWith(`${section.label} · Settings`)) marked[`${section.slug}-title`] = title;
          await gather(`/settings/${section.slug}`);
        }
        await shot(`settings-${section.slug}`);
        await collectErrors(`settings-${section.slug}-${mode}`);
      }
    }
    check("everySectionHoldsWhatItShould", Object.keys(missing).length === 0, missing);
    check("eachKeyOnlyBesideWhatItUnlocks", Object.keys(misplaced).length === 0, misplaced);
    check("navMarksTheOpenSection", Object.keys(marked).length === 0, marked);
    // 16. Logins & secrets on its own: the logins and nothing else; Access & approvals without them.
    await go("/settings/logins", "Netflix");
    const logins = await evaluate(`[...document.querySelector('nav[aria-label=Settings]').parentElement.lastElementChild.querySelectorAll("section")].map((section) => section.getAttribute("aria-label"))`) as string[];
    await go("/settings/access", "pnpm test");
    const access = await sectionText();
    check("loginsIsItsOwnSection", JSON.stringify(logins) === '["Logins & secrets"]' && !/Netflix|Add a login|Logins & secrets/.test(access), { logins, accessHasLogins: /Netflix|Add a login|Logins & secrets/.test(access) });
    theme = "light";
    await scheme("light");
    await size(1280, 800);

    // --- 3. The nav's groups, in the issue's order, and no box around it --------------------------------
    await go("/settings/general", "Update on his own at night");
    const nav = await evaluate(`(() => {
      const nav = document.querySelector('nav[aria-label=Settings]');
      const groups = [...nav.querySelectorAll("ul")].map((ul) => ({ name: ul.getAttribute("aria-label") ?? document.getElementById(ul.getAttribute("aria-labelledby"))?.innerText, items: [...ul.querySelectorAll("a")].map((a) => a.innerText.trim()), shownName: Boolean(ul.getAttribute("aria-labelledby")) }));
      const clear = (c) => c === "transparent" || /rgba\\(\\d+, \\d+, \\d+, 0\\)/.test(c);
      const boxes = [nav, ...nav.querySelectorAll("*")].filter((el) => { const s = getComputedStyle(el); const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(s["border" + side + "Width"]) > 0 && !clear(s["border" + side + "Color"])).length; return (sides >= 3 || !clear(s.backgroundColor)) && el.getAttribute("aria-current") !== "page"; }).map((el) => el.tagName + " " + el.className);
      return { groups, boxes };
    })()`) as { groups: Array<{ name: string; items: string[]; shownName: boolean }>; boxes: string[] };
    const wanted = GROUPS.map(([name, sections]) => ({ name, items: sections.map(([, label]) => label), shownName: !(sections.length === 1 && sections[0][1] === name) }));
    check("navGroupsAsTheIssueSays", JSON.stringify(nav.groups) === JSON.stringify(wanted), { got: nav.groups, wanted });
    check("navIsNotABox", nav.boxes.length === 0, nav.boxes);

    // --- 5. The keyboard ---------------------------------------------------------------------------------
    await evaluate(`document.activeElement?.blur?.(); document.body.focus(); true`);
    let tabs = 0;
    for (; tabs < 80; tabs++) {
      await press("Tab");
      if (await evaluate(`document.activeElement?.closest?.('nav[aria-label=Settings]') !== null && document.activeElement?.tagName === "A"`)) break;
    }
    const reached = await evaluate(`document.activeElement.innerText.trim()`) as string;
    const ring = await evaluate(`document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).boxShadow !== "none"`);
    const steps: string[] = [reached];
    for (const key of ["ArrowDown", "ArrowDown", "End", "ArrowUp", "Home", "ArrowDown", "ArrowDown"] as const) {
      await press(key);
      steps.push(await evaluate(`document.activeElement.innerText.trim()`) as string);
    }
    await press("Enter");
    const opened = await soon(async () => (await where()) === "/settings/usage", 8);
    await waitFor(`document.body.innerText.includes("Your plans")`, "Usage", 15).catch(() => {});
    check("navByKeyboard", reached === "General" && ring === true && opened
      && JSON.stringify(steps) === JSON.stringify(["General", "Engines", "Usage", "Activity log", "Dashboard key", "General", "Engines", "Usage"]), { tabs, reached, ring, steps, opened, at: await where() });

    // --- 6. Old addresses, and an unknown section -----------------------------------------------------
    const wrong: Record<string, unknown> = {};
    for (const [from, to] of Object.entries(REDIRECTS)) {
      const response = await fetch(`${BASE}${from}`, { redirect: "manual" });
      const location = response.headers.get("location");
      const landed = location ? new URL(location, BASE) : null;
      const at = landed ? landed.pathname + landed.search + landed.hash : null;
      if (response.status < 300 || response.status >= 400 || at !== to) wrong[from] = { status: response.status, location };
    }
    const unknown = await fetch(`${BASE}/settings/keys`).then((response) => response.status);
    check("oldAddressesRedirect", Object.keys(wrong).length === 0, wrong);
    check("unknownSectionIs404", unknown === 404, unknown);
    // In the browser too: the redirect keeps the query the page reads.
    await send("Page.navigate", { url: `${BASE}/activity?session=${receiptsChat}` });
    await waitFor(`location.pathname === "/settings/activity" && document.body.innerText.includes("Export last year's receipts")`, "the activity log for one chat", 30).catch(() => {});
    await sleep(800);
    const filtered = await evaluate(`({ at: location.pathname + location.search, plan: [...document.querySelectorAll('ul[aria-label=Runs] > li')].some((li) => li.innerText.includes("Plan my week")), runs: document.querySelectorAll('ul[aria-label=Runs] > li').length })`) as { at: string; plan: boolean; runs: number };
    await send("Page.navigate", { url: `${BASE}/skills?skill=weekly-review` });
    const skillOpen = await soon(() => evaluate(`location.pathname === "/apps/skills" && Boolean(document.querySelector("[role=dialog]")?.innerText.includes("weekly-review"))`), 20);
    await press("Escape");
    await send("Page.navigate", { url: `${BASE}/settings?tab=shortcuts` });
    const shortcuts = await soon(() => evaluate(`location.pathname === "/settings/desktop-pet" && location.hash === "#shortcuts" && document.body.innerText.includes("Show Perry the screen")`), 20);
    // And inside the app, as an older pet asks the dashboard to open its old address: a client-side push.
    await go("/chat", "New chat");
    await call("pet:askToOpen", { key: KEY, path: "/settings?tab=people" });
    const pushed = await soon(async () => (await where()) === "/settings/people" && (await text()).includes("Talks with Perry"), 15);
    check("redirectsKeepTheirQuery", filtered.at.startsWith("/settings/activity?session=") && !filtered.plan && filtered.runs > 0 && skillOpen && shortcuts && pushed, { filtered, skillOpen, shortcuts, pushed, at: await where() });
    await collectErrors("redirects");

    // --- 8. The sidebar: its items, the footer's order, and where the footer goes ------------------------
    await go("/chat", "New chat");
    const sidebar = await evaluate(`(() => {
      const top = [...document.querySelector("[data-sidebar=content] [data-sidebar=group] [data-sidebar=menu]").querySelectorAll(":scope > [data-sidebar=menu-item]")].flatMap((li) => [...li.querySelectorAll("[data-sidebar=menu-button]")].map((b) => b.innerText.trim().split("\\n")[0] || b.getAttribute("aria-label")));
      const footer = [...document.querySelector("[data-sidebar=footer]").querySelectorAll("[data-sidebar=menu-button]")].map((b) => b.innerText.replace(/\\s+/g, " ").trim());
      return { top, footer };
    })()`) as { top: string[]; footer: string[] };
    check("sidebarHasMemoryAndApps", JSON.stringify(sidebar.top) === JSON.stringify(["New chat", "Search", "Needs you", "To-dos", "Work", "Memory", "Apps & skills"]), sidebar.top);

    // --- 17. New chat and Search, one row; stacked when the sidebar is icons ----------------------------------
    const ROW = `document.querySelector("[data-new-chat-row]")`;
    const rowShape = () => evaluate(`(() => {
      const row = ${ROW}; const [chat, search] = row.querySelectorAll("[data-sidebar=menu-button]");
      const r = row.getBoundingClientRect(), c = chat.getBoundingClientRect(), s = search.getBoundingClientRect();
      const clear = (v) => v === "transparent" || /rgba\\(\\d+, \\d+, \\d+, 0\\)/.test(v);
      const st = getComputedStyle(row);
      return {
        share: Math.round((c.width / r.width) * 100), chat: chat.innerText.trim(), search: { words: search.innerText.trim(), label: search.getAttribute("aria-label"), keys: search.getAttribute("aria-keyshortcuts"), tag: search.tagName, icon: Boolean(search.querySelector("svg")), focusable: search.tabIndex >= 0 },
        boxed: ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(st["border" + side + "Width"]) > 0) || !clear(st.backgroundColor),
        stacked: s.top >= c.bottom - 1 && Math.abs(s.left - c.left) < 4, sideBySide: Math.abs(s.top - c.top) < 4 && s.left >= c.right,
        sizes: [Math.round(c.width), Math.round(c.height), Math.round(s.width), Math.round(s.height)],
      };
    })()`) as Promise<{ share: number; chat: string; search: { words: string; label: string; keys: string; tag: string; icon: boolean; focusable: boolean }; boxed: boolean; stacked: boolean; sideBySide: boolean; sizes: number[] }>;
    const open = await rowShape();
    const searchButton = `${ROW}.querySelectorAll("[data-sidebar=menu-button]")[1]`;
    const hover = await middle(searchButton);
    if (hover) await mouse("mouseMoved", hover.x, hover.y);
    const tip = await soon(() => evaluate(`[...document.querySelectorAll("[data-slot=tooltip-content]")].some((el) => el.innerText.trim() === "Search · Ctrl+K")`), 5);
    await click(searchButton);
    const palette1 = await soon(() => evaluate(`Boolean(document.querySelector("[cmdk-input]"))`), 5);
    await press("Escape");
    // Keyboard: focus the button and press Enter.
    await focus(searchButton);
    await press("Enter");
    const palette2 = await soon(() => evaluate(`Boolean(document.querySelector("[cmdk-input]"))`), 5);
    await press("Escape");
    check("newChatAndSearchShareARow", open.share >= 70 && open.chat === "New chat" && open.sideBySide && !open.boxed
      && open.search.words === "" && open.search.label === "Search" && open.search.icon && open.search.tag === "BUTTON" && open.search.focusable && /Control\+K/.test(open.search.keys)
      && tip && palette1 && palette2, { open, tip, palette1, palette2 });
    await shot("sidebar-row", false);
    // Collapsed to icons: the two stacked, New chat first.
    const collapsed: Record<string, unknown> = {};
    for (const mode of ["light", "dark"] as const) {
      theme = mode;
      await scheme(mode);
      await go("/chat", "New chat");
      await click(`document.querySelector("[data-sidebar=trigger]")`);
      await waitFor(`document.querySelector("[data-collapsible=icon]")`, "the sidebar to collapse", 10).catch(() => {});
      await sleep(600);
      collapsed[mode] = await rowShape();
      await shot("sidebar-collapsed", false);
      await click(`document.querySelector("[data-sidebar=trigger]")`);
      await sleep(600);
    }
    theme = "light";
    await scheme("light");
    const folded = collapsed.light as Awaited<ReturnType<typeof rowShape>>;
    check("collapsedShowsTwoStackedIcons", folded.stacked && folded.sizes.every((size) => size > 0 && size <= 40), collapsed);

    // --- 18. One plain list of chats: no date headings, pinned first with a pin, the rest newest first ------------------
    await call("dashboard:setChatPinned", { key: KEY, id: receiptsChat, pinned: true });
    await go("/chat", "New chat");
    await waitFor(`document.querySelector('[aria-label=Pinned] [aria-label=Pinned]')`, "the pinned chat", 15).catch(() => {});
    const chatList = await evaluate(`(() => {
      const headings = [...document.querySelectorAll("[data-sidebar=content] [data-sidebar=group-label]")].map((el) => el.innerText.trim());
      const rows = [...document.querySelectorAll("[data-sidebar=content] ul[aria-label=Pinned] > li, [data-sidebar=content] ul[aria-label=Chats] > li")].map((li) => ({ title: li.querySelector("[data-sidebar=menu-button]").innerText.trim(), pin: Boolean(li.querySelector('[aria-label=Pinned]')) }));
      const words = document.querySelector("[data-sidebar=content]").innerText;
      return { headings, rows, dates: ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Pinned"].filter((word) => words.split("\\n").some((line) => line.trim() === word)) };
    })()`) as { headings: string[]; rows: Array<{ title: string; pin: boolean }>; dates: string[] };
    const all = (await call<Array<{ id: string; title: string; pinned?: boolean; projectId?: string; lastMessageAt: number }>>("dashboard:listChats", { key: KEY })).filter((chat) => !chat.projectId);
    const wantedOrder = [...all.filter((chat) => chat.pinned), ...all.filter((chat) => !chat.pinned).sort((a, b) => b.lastMessageAt - a.lastMessageAt)].map((chat) => chat.title);
    await shot("sidebar-chats", false);
    check("chatsAreOnePlainList", JSON.stringify(chatList.headings) === '["Projects"]' && chatList.dates.length === 0
      && chatList.rows.length === wantedOrder.length && chatList.rows.every((row, index) => row.title.includes(wantedOrder[index])) && chatList.rows[0]?.pin === true && chatList.rows.slice(1).every((row) => !row.pin), { chatList, wantedOrder });
    await call("dashboard:setChatPinned", { key: KEY, id: receiptsChat, pinned: false });
    await collectErrors("sidebar-row");
    const computer = (await call<{ runners: Array<{ name: string; revoked?: boolean }> }>("dashboard:getCompute", { key: KEY })).runners.find((runner) => !runner.revoked)?.name ?? "";
    const owner = (await call<{ displayName?: string }>("dashboard:getStatus", { key: KEY })).displayName ?? "You";
    // The pet's button starts with his sleeping "z", the owner's with their initial.
    check("footerIsPetThenComputerThenYou", sidebar.footer.length === 3 && sidebar.footer[0].endsWith("Desktop pet") && sidebar.footer[1] === computer && sidebar.footer[2].includes(`${owner} ChatGPT Plus · Codex`), { footer: sidebar.footer, computer, owner });
    await gather("/chat");
    const computerButton = byText("[data-sidebar=footer] [data-sidebar=menu-button]", computer);
    await click(computerButton);
    const computerRow = await soon(async () => (await where()) === "/settings/computers" && Boolean(await evaluate(`${computerButton}?.hasAttribute("data-active")`)), 10);
    await click(byText("[data-sidebar=footer] [data-sidebar=menu-button]", "Desktop pet"));
    await waitFor(`document.querySelector("[role=menu]")`, "the pet's menu");
    await click(byText("[role=menuitem]", "Pet settings"));
    const petSettings = await soon(async () => (await where()) === "/settings/desktop-pet" && (await text()).includes("Let Perry look at the screen"), 10);
    check("footerLandsOnItsSections", computerRow && petSettings, { computerRow, petSettings, at: await where() });
    await click(byText("[data-sidebar=menu-button]", "Apps & skills"));
    const apps = await soon(async () => (await where()) === "/apps/connectors", 10);
    await click(byText("[data-sidebar=menu-button]", "Memory"));
    const memory = await soon(async () => (await where()) === "/memory", 10);
    check("sidebarItemsGoToTheirPages", apps && memory, { apps, memory });
    await collectErrors("sidebar");

    // --- 7. The account menu, in both themes --------------------------------------------------------------
    const line = await evaluate(`document.querySelector("[data-account-line]")?.innerText.trim()`) as string;
    check("lineUnderTheNameIsThePlan", line === "ChatGPT Plus · Codex", line);
    for (const mode of ["light", "dark"] as const) {
      theme = mode;
      await scheme(mode);
      await go("/chat", "New chat");
      await click(ACCOUNT);
      await waitFor(byText("[role=menuitem]", "Lock dashboard"), "the account menu", 15).catch(() => {});
      await sleep(400);
      await shot("account-menu", false);
      if (mode === "light") {
        const menu = await evaluate(`(() => {
          const menu = document.querySelector("[role=menu]");
          const items = [...menu.querySelectorAll("[role=menuitem]")].map((el) => el.innerText.trim());
          const usage = Object.fromEntries([...menu.querySelectorAll('[role=group][aria-label$=" usage"]')].map((el) => [el.getAttribute("aria-label"), el.innerText.replace(/\\s+/g, " ").trim()]));
          const bars = [...menu.querySelectorAll("[data-slot=progress]")].map((el) => el.getAttribute("aria-label") ?? el.querySelector("[aria-label]")?.getAttribute("aria-label"));
          return { items, usage, bars };
        })()`) as { items: string[]; usage: Record<string, string>; bars: string[] };
        // #197: no usage in the menu, only the item that opens it.
        check("accountMenuItems", JSON.stringify(menu.items) === JSON.stringify(["Usage", "Theme", "Settings", "Lock dashboard"]), menu.items);
        check("accountMenuHasNoUsage", Object.keys(menu.usage).length === 0 && menu.bars.length === 0, menu);
        await click(byText("[role=menuitem]", "Usage"));
        const details = await soon(async () => (await where()) === "/settings/usage" && (await text()).includes("Your plans"), 10);
        await sleep(600);
        await click(ACCOUNT);
        await waitFor(byText("[role=menuitem]", "Lock dashboard"), "the account menu");
        await sleep(400);
        await click(byText("[role=menuitem]", "Settings"));
        const settings = await soon(async () => (await where()) === "/settings/general", 10);
        check("accountMenuGoes", details && settings, { details, settings });
      } else await press("Escape");
      await collectErrors(`account-menu-${mode}`);
    }
    theme = "light";
    await scheme("light");

    // --- 13. Apps & skills: two tabs, each at its address, and no page in the page ----------------------
    for (const mode of ["light", "dark"] as const) {
      theme = mode;
      await scheme(mode);
      await go("/apps/connectors", "Connect through Composio");
      await shot("apps-connectors");
      if (mode === "light") {
        const page = await evaluate(`({ h1: [...document.querySelectorAll("main h1")].map((h) => h.innerText), tabs: [...document.querySelectorAll("[role=tab]")].map((t) => [t.innerText.trim(), t.getAttribute("aria-selected")]), key: Boolean(document.querySelector("#key-COMPOSIO_API_KEY")), below: document.querySelector('a[href="#key-COMPOSIO_API_KEY"]')?.innerText })`) as { h1: string[]; tabs: string[][]; key: boolean; below?: string };
        await gather("/apps/connectors");
        await click(byText("[role=tab]", "Skills"));
        const skills = await soon(async () => (await where()) === "/apps/skills" && (await text()).includes("weekly-review"), 10);
        const skillsPage = await evaluate(`({ h1: [...document.querySelectorAll("main h1")].map((h) => h.innerText), selected: document.querySelector("[role=tab][aria-selected=true]")?.innerText.trim() })`) as { h1: string[]; selected: string };
        await gather("/apps/skills");
        check("appsAndSkillsTabs", JSON.stringify(page.h1) === '["Apps & skills"]' && JSON.stringify(page.tabs) === '[["Connectors","true"],["Skills","false"]]' && page.key && page.below === "below"
          && skills && JSON.stringify(skillsPage.h1) === '["Apps & skills"]' && skillsPage.selected === "Skills", { page, skills, skillsPage });
      }
      await go("/apps/skills", "weekly-review");
      await shot("apps-skills");
      await collectErrors(`apps-${mode}`);
    }
    theme = "light";
    await scheme("light");

    // --- 10. Keys save from where they live now -----------------------------------------------------------
    const keyOf = async (name: string) => (await call<Array<{ name: string; set: boolean; preview?: string; source: string }>>("dashboard:getKeys", { key: KEY })).find((entry) => entry.name === name);
    await go("/settings/telegram", "Telegram bot token");
    await focus(`document.querySelector("#key-TELEGRAM_BOT_TOKEN")`);
    await typeText("123456789:e2e-not-a-real-token-AbCd");
    await press("Enter");
    const telegramSaved = await soon(async () => (await keyOf("TELEGRAM_BOT_TOKEN"))?.preview === "…AbCd", 8);
    const checkBot = await soon(() => evaluate(`Boolean(${byText("main button", "Check the bot")})`), 10);
    await shot("telegram-token-saved");
    check("telegramTokenSavesInTelegram", telegramSaved && checkBot, { telegramSaved, checkBot, key: await keyOf("TELEGRAM_BOT_TOKEN") });
    // Not left set: the server would keep asking Telegram for a bot that is not there.
    await call("dashboard:clearKey", { key: KEY, name: "TELEGRAM_BOT_TOKEN" });

    await go("/apps/connectors", "Connect through Composio");
    await focus(`document.querySelector("#key-COMPOSIO_API_KEY")`);
    await typeText("e2e-not-a-real-composio-key-9Zq1");
    await press("Enter");
    const composioSaved = await soon(async () => (await keyOf("COMPOSIO_API_KEY"))?.preview === "…9Zq1", 8);
    // The connectors start over with the key: the setup is gone (Composio may refuse a made-up key; that shows as an error).
    const noticed = await soon(async () => !(await text()).includes("Connect through Composio"), 30);
    await sleep(500);
    await shot("composio-key-saved");
    notes.connectorsAfterKey = (await text()).slice(0, 400);
    await call("dashboard:clearKey", { key: KEY, name: "COMPOSIO_API_KEY" });
    const backToSetup = await soon(async () => (await text()).includes("Connect through Composio"), 30);
    check("composioKeySavesInConnectors", composioSaved && noticed && backToSetup, { composioSaved, noticed, backToSetup });
    await collectErrors("keys");

    // --- 11. Approval rules, from Access & approvals --------------------------------------------------------
    await go("/settings/access", "pnpm test");
    const listed = await evaluate(`[...document.querySelectorAll('ul[aria-label=Rules] > li')].map((li) => li.innerText.split("\\n")[0])`) as string[];
    await click(`document.querySelector('ul[aria-label=Rules] > li button[aria-label="Delete rule"]')`);
    await waitFor(`document.querySelector("[role=alertdialog]")`, "the confirm");
    await click(byText("[role=alertdialog] button", "Delete"));
    const gone = await soon(async () => (await call<unknown[]>("approvals:rules", { key: KEY })).length === 0, 8);
    const emptied = await soon(() => evaluate(`document.body.innerText.includes("No saved rules")`), 8);
    check("approvalRulesListAndDelete", listed.some((rule) => rule.includes("pnpm test")) && gone && emptied, { listed, gone, emptied });
    await collectErrors("rules");

    // --- 12. A phone: the switcher, and nothing wider than the screen -----------------------------------------
    await size(375, 812);
    const overflow: Record<string, unknown> = {};
    for (const section of SECTIONS) {
      await go(`/settings/${section.slug}`, section.words[0]);
      const measured = await evaluate(OVERFLOW) as { doc: number; worst: number; what: string | null; tabs: number[] };
      if (measured.doc > 0 || measured.worst > 0 || measured.tabs.some((over) => over > 0)) overflow[section.slug] = measured;
      await shot(`phone-settings-${section.slug}`, false);
    }
    const phone = await evaluate(`({ nav: getComputedStyle(document.querySelector('nav[aria-label=Settings]')).display, switcher: Boolean(document.querySelector('[aria-label="Settings section"]')?.offsetParent), shown: document.querySelector('[aria-label="Settings section"]')?.innerText.trim() })`) as { nav: string; switcher: boolean; shown: string };
    await click(`document.querySelector('[aria-label="Settings section"]')`);
    await waitFor(`document.querySelector("[role=listbox]")`, "the switcher's list");
    await sleep(300);
    const listed2 = await evaluate(`[...document.querySelectorAll("[role=listbox] [role=group]")].map((g) => g.innerText.replace(/\\s+/g, " ").trim())`) as string[];
    await shot("phone-switcher-open", false);
    // The list opens at the section shown, at its foot; Telegram is scrolled to first, as a thumb would.
    await evaluate(`${byText("[role=option]", "Telegram")}.scrollIntoView({ block: "center" }); true`);
    await sleep(300);
    await click(byText("[role=option]", "Telegram"));
    const switched = await soon(async () => (await where()) === "/settings/telegram", 10);
    check("phoneUsesTheSwitcher", phone.nav === "none" && phone.switcher && phone.shown === "Activity log" && listed2.length === 7 && switched, { phone, listed: listed2, switched });
    for (const path of ["/apps/connectors", "/apps/skills"]) {
      await go(path, path.endsWith("skills") ? "weekly-review" : "Composio");
      const measured = await evaluate(OVERFLOW) as { doc: number; worst: number; tabs: number[] };
      if (measured.doc > 0 || measured.worst > 0 || measured.tabs.some((over) => over > 0)) overflow[path] = measured;
      await shot(`phone${path.replaceAll("/", "-")}`, false);
    }
    check("nothingOverflowsAPhone", Object.keys(overflow).length === 0, overflow);
    await collectErrors("phone");
    await size(1280, 800);

    // --- 9. No link in the app goes nowhere ------------------------------------------------------------------
    for (const [path, words] of [["/inbox", "build-cache"], ["/todos", "Water the plants"], ["/work", "Morning briefing"], ["/memory", "coffee black"], ["/memory?tab=about", "USER.md"], [`/chat/${planChat}`, "Call Sam about Saturday"]] as const) {
      await go(path, words).catch(() => {});
      await gather(path);
    }
    // The command palette's pages go by router.push: each is opened.
    const palette: Record<string, string> = {};
    await go("/chat", "New chat");
    for (let index = 0; index < 20; index++) {
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 });
      await waitFor(`document.querySelector("[cmdk-group-heading]")`, "the command palette", 10);
      await sleep(300);
      const items = await evaluate(`[...document.querySelectorAll("[cmdk-group]")].find((g) => g.querySelector("[cmdk-group-heading]")?.innerText === "Go to")?.querySelectorAll("[cmdk-item]").length ?? 0`) as number;
      if (index >= items) { await press("Escape"); break; }
      const label = await evaluate(`[...[...document.querySelectorAll("[cmdk-group]")].find((g) => g.querySelector("[cmdk-group-heading]")?.innerText === "Go to").querySelectorAll("[cmdk-item]")][${index}].innerText.trim()`) as string;
      await click(`[...[...document.querySelectorAll("[cmdk-group]")].find((g) => g.querySelector("[cmdk-group-heading]")?.innerText === "Go to").querySelectorAll("[cmdk-item]")][${index}]`);
      await sleep(1500);
      palette[label] = (await is404()) ? `404 at ${await where()}` : await where();
    }
    notes.palette = palette;
    const dead: Record<string, unknown> = {};
    for (const [label, at] of Object.entries(palette)) if (at.startsWith("404")) dead[`palette: ${label}`] = at;
    for (const [href, page] of [...hrefs, ...PET_TARGETS.map((target) => [target, "the pet"] as const)]) {
      if (/^(https?:|mailto:)/.test(href) && !href.startsWith(BASE)) continue;
      const path = href.startsWith("#") ? page : href;
      const response = await fetch(new URL(path, BASE), { redirect: "follow" });
      if (response.status >= 400) dead[href] = { status: response.status, on: page };
    }
    notes.linksCrawled = hrefs.size + PET_TARGETS.length;
    check("noLinkGoesNowhere", Object.keys(dead).length === 0 && Object.keys(palette).length >= 10, { dead, palette: Object.keys(palette).length });
    await collectErrors("crawl");

    const exceptions = browser.errors;
    check("nothingThrows", exceptions.length === 0 && errors.length === 0, { exceptions, consoleErrors: errors });
  }
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
  console.error(error);
  if (browser) await browser.send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(OUT, `failure${BEFORE ? "-before" : ""}.png`), Buffer.from(image.data, "base64"))).catch(() => {});
} finally {
  browser?.close();
  await perry?.stop();
}

if (!BEFORE) {
  const pass = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
  const result = { ranAt: new Date().toISOString(), pass, checks, notes, serverLog: pass ? undefined : perry?.log().slice(-4000) };
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}
process.exit(0);
