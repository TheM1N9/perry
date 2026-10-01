import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";
import { seed, startPerry, type Perry } from "../fewer-boxes/seed";

// bun artifacts/less-text/run.ts <outDir> [--before <checkout>]
// Issue #197: no usage in the account menu (a Usage item that opens Settings →
// Usage instead), and much less text on every page, the pet and onboarding.
// A fresh Perry: the production build (`pnpm build` first) on a free port, a
// PERRY_HOME in PERRY_E2E_HOMES (else the temp folder), no Telegram, no
// Composio, and no Codex or Claude: CODEX_HOME and CLAUDE_CONFIG_DIR point into
// the test's home, and the runner is played by its calls; no model turn runs.
// The seed is artifacts/fewer-boxes' (seed.ts), plus a Codex plan at 85% of its
// 5-hour window, so the usage page has bars and the chat its warning. Headless
// Chrome, light and dark; the pet's page in a plain tab at his window's
// 404×620, never the real pet.
// With --before <checkout>, the same seed, word counts and pictures from that
// checkout's build (main), and no checks; the run after reads its counts
// (words-before.json) and compares page by page.
//
// Ways it could fail, written down before the checks:
//   1. The account menu still shows usage: a bar, a "Usage" group, an engine's
//      windows, or "No limits reported yet"; or it lost the name, the plan line
//      under it, Theme, Settings or Lock dashboard; or its items are not, in
//      order, Usage, Theme, Settings, Lock dashboard.
//   2. Usage in the menu goes nowhere, or to a page that is not usage (the old
//      /settings/engines, where usage no longer is).
//   3. An old usage address breaks: /settings?tab=usage (bookmarks, Perry's
//      past messages), /settings/engines#usage, the composer's "See usage"
//      under a plan running low, or the pet's "See usage", landing on Engines
//      or a 404 instead of Usage.
//   4. Settings' nav or its phone switcher lost a section, or Usage is not
//      under Perry beside Engines, or Engines still says "& usage".
//   5. A page's words are not down by the target, measured the same way on the
//      same seed against main: visible text only (not screen-reader text, not
//      tooltips that are closed, not what is faded out), placeholders counted.
//   6. A cut went too far: a warning, a destructive action's consequence in its
//      confirmation, an error, or a fact a person could not otherwise know is
//      gone (each listed below in SAFETY, looked for on its page, or in its
//      dialog, or in the tooltip it moved into).
//   7. A cut changed behaviour: a section, button or field is missing (the
//      checks above find their words, and the reruns of settings-sections,
//      fewer-boxes and ui-consistency cover the rest).
//   8. Anything throws or logs an error on a page, in light or dark.
//   9. A picture proves nothing: a page is shot before its seeded content
//      shows (each waits for words from the seed).

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: bun artifacts/less-text/run.ts <outDir> [--before <checkout>]");
const beforeAt = args.indexOf("--before");
const REPO = beforeAt >= 0 ? resolve(args[beforeAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BEFORE = beforeAt >= 0;
const OUT = resolve(outDir);
mkdirSync(OUT, { recursive: true });

const KEY = "less-text-e2e-key";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => {
  checks[name] = ok;
  if (note !== undefined) notes[name] = note;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && note !== undefined ? ` ${JSON.stringify(note).slice(0, 600)}` : ""}`);
};

/**
 * How far each page's words must come down, as a share of main's count on the
 * same seed. Pages are mostly the seed's own rows (memories, schedules, a
 * reply), which no cut touches, so the share is of the whole page; what is cut
 * is the explanation around them. Pages whose words are mostly the seed's, or
 * that had little to cut, have a lower bar; none may grow.
 */
const TARGETS: Record<string, number> = {
  // A reply, its approval card and the plan warning: the seed's words, a consequence and a warning, all kept.
  "chat-reply": 0.03,
  // The seed's runs and the prompts they were given, nothing to explain.
  "settings-activity": 0,
  // The personalities are what is saved as the assistant's personality, word for word, and stay.
  "welcome-1": 0.05,
  // An approval with its consequence, a question, and the to-dos: nothing there was explanation.
  "pet-needs": 0,
  "pet-todos": 0,
};
const DEFAULT_TARGET = 0.2;
/**
 * A page's words, with its times ("now", "3 min ago", "at 3:22") as one word and the chat's jump button (there
 * or not by where the scroll ended up) left out, so the clock and the scroll between two runs move nothing.
 */
const wordsOf = (text: string) => (text.replace(/Jump to latest|New reply below/g, "").replace(/\b(just now|now|\d+ (?:sec|min|hr|h|day|week|month)s?\.? ago|\d+:\d{2}( left)?)\b/g, "T").match(/\S+/g) ?? [])
  .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

/**
 * What must stay, by page: warnings, the consequences of destructive actions,
 * errors, and facts a person could not otherwise know. `where` is a page's
 * address, `open` (optional) what to click first, and `find` what must show,
 * in the page's words, an open dialog's, or a tooltip's (an InfoTip names its
 * words in its aria-label).
 */
type Safety = { name: string; path: string; wait: string; find: RegExp; open?: string; dialog?: boolean };

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
let perry: Perry | null = null;
const words: Record<string, { words: number; text: string }> = {};

try {
  perry = await startPerry({ repo: REPO, key: KEY, name: "less-text" });
  const { base: BASE, call, until, soon, token } = perry;
  const { project, planChat, receiptsChat } = await seed(perry, notes);
  // A Codex plan running low: bars on the usage page, and the chat's warning with its "See usage".
  await call("usage:report", {
    token, engine: "codex", limits: {
      plan: "plus", at: Date.now(), windows: [
        { id: "primary", label: "5-hour", usedPercent: 85, resetsAt: Date.now() + 90 * 60_000, minutes: 300 },
        { id: "secondary", label: "Weekly", usedPercent: 40, resetsAt: Date.now() + 3 * 86_400_000, minutes: 10080 },
      ],
    },
  });

  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errors = []; { const e = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ").slice(0, 300)); e(...a); }; }` });
  const errors: Array<{ page: string; error: string }> = [];
  const collectErrors = async (page: string) => { for (const error of (await evaluate(`window.__errors ?? []`).catch(() => [])) as string[]) errors.push({ page, error }); await evaluate(`window.__errors = []; true`).catch(() => {}); };
  const waitFor = (test: string, what: string, seconds = 20) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const go = async (path: string, text: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, `${path} to show "${text}"`, 30);
    await sleep(700);
  };
  const where = () => evaluate(`location.pathname + location.search + location.hash`) as Promise<string>;
  let theme: "light" | "dark" = "light";
  const shot = async (name: string, full = true) => {
    let clip: object | undefined;
    if (full) {
      const size = await evaluate(`(() => { const s = document.querySelector("main") ?? document.body; const scroller = [...document.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 40 && ["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.clientWidth > 600); return { height: Math.max(document.documentElement.scrollHeight, scroller ? scroller.scrollHeight + 48 : 0, s.scrollHeight) }; })()`) as { height: number };
      if (size.height > 800) clip = { x: 0, y: 0, width: 1280, height: Math.min(size.height, 4000), scale: 1 };
    }
    const image = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) }) as { data: string };
    writeFileSync(join(OUT, `${name}-${theme}${BEFORE ? "-before" : ""}.png`), Buffer.from(image.data, "base64"));
  };
  const size = (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const middle = (expression: string) => evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
  const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
  const click = async (expression: string) => {
    const point = await middle(expression);
    if (!point) throw new Error(`nothing to click: ${expression}`);
    await mouse("mouseMoved", point.x, point.y);
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseReleased", point.x, point.y);
    await sleep(300);
  };
  const escape = async () => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
  };
  const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.innerText.trim().includes(${JSON.stringify(text)}))`;

  /**
   * The words a person sees in `root`: text that is rendered and visible (not
   * screen-reader-only, not faded out, not a closed tooltip), and the
   * placeholders of empty fields. A word is anything with a letter or digit in it.
   */
  const count = (root: string) => evaluate(`(() => {
    const root = ${root};
    if (!root) return null;
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || el.closest(".sr-only, script, style, template, [hidden]")) continue;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      parts.push(node.textContent);
    }
    for (const field of root.querySelectorAll("input[placeholder], textarea[placeholder]")) {
      if (!field.value && field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) parts.push(field.placeholder);
    }
    const text = parts.join(" ").replace(/\\s+/g, " ").trim();
    return { words: (text.match(/\\S+/g) ?? []).filter((word) => /[\\p{L}\\p{N}]/u.test(word)).length, text };
  })()`) as Promise<{ words: number; text: string } | null>;
  const MAIN = `document.querySelector("main")`;
  const CHAT = `document.querySelector("#content")?.parentElement`;
  const PET = `document.querySelector('section[aria-label="Perry"]')`;
  const measure = async (page: string, root = MAIN) => {
    if (theme !== "light") return;
    const found = await count(root);
    if (found) words[page] = found;
  };

  /** Each page: its name, address, words from the seed that show once it has loaded, and where its words are. */
  const PAGES: Array<{ name: string; path: string; wait: string; root?: string; after?: boolean }> = [
    { name: "chat-new", path: "/chat", wait: "Plan my day", root: CHAT },
    { name: "chat-reply", path: `/chat/${planChat}`, wait: "Call Sam about Saturday", root: CHAT },
    { name: "chat-alert", path: `/chat/${receiptsChat}`, wait: "couldn't finish the last reply", root: CHAT },
    { name: "inbox", path: "/inbox", wait: "build-cache" },
    { name: "todos", path: "/todos", wait: "Water the plants" },
    { name: "work", path: "/work", wait: "Morning briefing" },
    { name: "work-plans", path: "/work?tab=plans", wait: "Compare three flats" },
    { name: "work-goals", path: "/work?tab=goals", wait: "half marathon" },
    { name: "work-watches", path: "/work?tab=watches", wait: "Headphones" },
    { name: "memory", path: "/memory", wait: "coffee black" },
    { name: "memory-about", path: "/memory?tab=about", wait: "USER.md" },
    { name: "project", path: `/projects/${project}`, wait: "matte green" },
    { name: "apps-connectors", path: "/apps/connectors", wait: "Composio key" },
    { name: "apps-skills", path: "/apps/skills", wait: "weekly-review" },
    { name: "settings-general", path: "/settings/general", wait: "Update on his own at night" },
    // Main had usage at the foot of Engines & usage; here it is a section of its own.
    { name: "settings-engines", path: "/settings/engines", wait: "Gemini API key" },
    { name: "settings-usage", path: "/settings/usage", wait: "Perry's share this week", after: true },
    { name: "settings-computers", path: "/settings/computers", wait: "a-long-folder-name" },
    { name: "settings-access", path: "/settings/access", wait: "git push origin main" },
    { name: "settings-notifications", path: "/settings/notifications", wait: "Quiet hours" },
    { name: "settings-telegram", path: "/settings/telegram", wait: "Pair with Telegram" },
    { name: "settings-whatsapp", path: "/settings/whatsapp", wait: "A separate number" },
    { name: "settings-desktop-pet", path: "/settings/desktop-pet", wait: "Show Perry the screen" },
    { name: "settings-people", path: "/settings/people", wait: "Datta" },
    { name: "settings-logins", path: "/settings/logins", wait: "Netflix" },
    { name: "settings-security", path: "/settings/security", wait: "Lock this browser" },
    { name: "settings-activity", path: "/settings/activity", wait: "Export last year's receipts" },
  ];

  for (const mode of ["light", "dark"] as const) {
    theme = mode;
    await scheme(mode);
    await size(1280, 800);

    for (const page of PAGES) {
      if (page.after && BEFORE) continue;
      await go(page.path, page.wait);
      await shot(page.name, !page.root);
      await measure(page.name, page.root);
      await collectErrors(`${page.name}-${mode}`);
    }

    // --- Onboarding: its three steps, never finished ---------------------------------------------------
    await go("/welcome", "Meet your assistant");
    await shot("welcome-1");
    await measure("welcome-1");
    await click(`[...document.querySelectorAll("main button[type=submit]")].find((b) => b.innerText.trim() === "Continue")`);
    await waitFor(`document.body.innerText.includes("What should I call you?")`, "the second step");
    await sleep(500);
    await shot("welcome-2");
    await measure("welcome-2");
    await click(`[...document.querySelectorAll("main button[type=submit]")].find((b) => b.innerText.trim() === "Continue")`);
    await waitFor(`document.querySelector("main h1")?.innerText.includes("USER.md")`, "the third step");
    await sleep(500);
    await shot("welcome-3");
    await measure("welcome-3");
    await collectErrors(`welcome-${mode}`);

    // --- The account menu -----------------------------------------------------------------------------
    await go("/todos", "Water the plants");
    await click(`document.querySelector("[data-account-line]")?.closest("button")`);
    await waitFor(`document.querySelector("[role=menu]")`, "the account menu");
    await sleep(800);
    await shot("account-menu", false);
    await measure("account-menu", `document.querySelector("[role=menu]")`);
    if (!BEFORE && mode === "light") {
      const menu = await evaluate(`(() => {
        const menu = document.querySelector("[role=menu]");
        return {
          items: [...menu.querySelectorAll("[role=menuitem]")].map((item) => item.innerText.trim()),
          bars: menu.querySelectorAll("[role=progressbar], [data-slot=progress]").length,
          usageGroup: Boolean(menu.querySelector('[aria-label="Usage"], [aria-label$=" usage"]')),
          text: menu.innerText,
          line: document.querySelector("[data-account-line]")?.innerText.trim(),
        };
      })()`) as { items: string[]; bars: number; usageGroup: boolean; text: string; line: string };
      notes.accountMenu = menu;
      check("accountMenuHasNoUsage", menu.bars === 0 && !menu.usageGroup && !/% left|No limits reported|5-hour|Weekly/.test(menu.text), menu);
      check("accountMenuItems", JSON.stringify(menu.items) === JSON.stringify(["Usage", "Theme", "Settings", "Lock dashboard"]), menu.items);
      check("accountMenuKeepsNameAndPlan", /You|E2E|Sam/.test(menu.text.split("\n")[0]) && Boolean(menu.line?.trim()) && menu.text.includes(menu.line), menu);
      await click(byText("[role=menuitem]", "Usage"));
      const landed = await soon(async () => (await where()) === "/settings/usage" && await evaluate(`document.body.innerText.includes("Your plans")`), 10);
      check("menuUsageOpensUsage", landed, await where());
      const nav = await evaluate(`[...document.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => a.innerText.trim())`) as string[];
      check("usageIsASectionBesideEngines", nav.slice(0, 4).join("|") === "General|Engines|Usage|Computers" && !nav.some((label) => /& usage/.test(label)), nav);
    } else {
      await escape();
    }
    await collectErrors(`account-menu-${mode}`);

    // --- The pet: his chat with nothing open, what needs you, the to-dos ------------------------------------
    await size(404, 620);
    await evaluate(`localStorage.removeItem("perry.pet.chat"); true`);
    await send("Page.navigate", { url: `${BASE}/pet#key=${encodeURIComponent(KEY)}` });
    await waitFor(`document.querySelector('button[aria-label^="Perry."]')`, "the pet", 30);
    await sleep(800);
    if (!(await evaluate(`Boolean(${PET})`))) {
      await click(`document.querySelector('button[aria-label^="Perry."]')`);
      await waitFor(PET, "his panel");
      await sleep(600);
    }
    await shot("pet-chat", false);
    await measure("pet-chat", PET);
    await click(byText("[role=tab]", "Needs you"));
    await waitFor(`${PET}.innerText.includes("build-cache")`, "what needs you", 15).catch(() => {});
    await sleep(400);
    await shot("pet-needs", false);
    await measure("pet-needs", PET);
    await click(byText("[role=tab]", "To-dos"));
    await waitFor(`${PET}.innerText.includes("Water the plants")`, "the to-dos", 15).catch(() => {});
    await sleep(400);
    await shot("pet-todos", false);
    await measure("pet-todos", PET);
    await click(byText("[role=tab]", "Chat"));
    await collectErrors(`pet-${mode}`);
    await size(1280, 800);
  }

  if (BEFORE) {
    writeFileSync(join(OUT, "words-before.json"), JSON.stringify(words, null, 2) + "\n");
  } else {
    theme = "light";
    await scheme("light");

    // --- Old addresses for usage ---------------------------------------------------------------------------
    const tab = await fetch(`${BASE}/settings?tab=usage`, { redirect: "manual" });
    check("oldUsageTabRedirects", tab.status === 307 && new URL(tab.headers.get("location") ?? "", BASE).pathname === "/settings/usage", { status: tab.status, location: tab.headers.get("location") });
    await send("Page.navigate", { url: `${BASE}/settings/engines#usage` });
    const hashed = await soon(async () => (await where()) === "/settings/usage" && await evaluate(`document.body.innerText.includes("Your plans")`), 15);
    check("oldUsageAnchorRedirects", hashed, await where());
    await send("Page.navigate", { url: `${BASE}/settings/engines` });
    await waitFor(`document.body.innerText.includes("Gemini API key")`, "Engines");
    await sleep(1500);
    check("enginesStaysWithoutTheAnchor", (await where()) === "/settings/engines" && !(await evaluate(`document.body.innerText.includes("Your plans")`)), await where());
    await go(`/chat/${planChat}`, "Call Sam about Saturday");
    await waitFor(`${byText("a", "See usage")}`, "the composer's See usage", 15).catch(() => {});
    const seeUsage = await evaluate(`${byText("a", "See usage")}?.getAttribute("href") ?? null`);
    if (seeUsage) await click(byText("a", "See usage"));
    const fromComposer = await soon(async () => (await where()) === "/settings/usage", 10);
    check("composerSeeUsageOpensUsage", seeUsage === "/settings/usage" && fromComposer, { seeUsage, at: await where() });
    await collectErrors("old-addresses");

    // --- What must stay ------------------------------------------------------------------------------------
    const SAFETY: Safety[] = [
      { name: "whatsappBanWarning", path: "/settings/whatsapp", wait: "A separate number", find: /WhatsApp may ban the number[\s\S]*a ban is possible/i },
      { name: "whatsappOwnNumberRisk", path: "/settings/whatsapp", wait: "A separate number", find: /ban would take your own WhatsApp/ },
      { name: "whatsappSeparateNumberRisk", path: "/settings/whatsapp", wait: "A separate number", find: /ban would only take that number/ },
      { name: "telegramWhoeverPairsOwnsIt", path: "/settings/telegram", wait: "Pair with Telegram", find: /Whoever sends it first owns this Perry/ },
      { name: "approvalsExpire", path: "/inbox", wait: "build-cache", find: /declined after ten minutes/ },
      { name: "chatErrorStays", path: `/chat/${receiptsChat}`, wait: "couldn't finish the last reply", find: /one-time code[\s\S]*Try again/ },
      { name: "lowPlanWarningStays", path: `/chat/${planChat}`, wait: "Call Sam about Saturday", find: /Codex is running low[\s\S]*85% of the 5-hour limit/ },
      { name: "failedUpdateSaysWhy", path: "/settings/general", wait: "Update on his own at night", find: /didn't work\. pnpm install could not reach the registry/ },
      { name: "passwordsNeverShownAgain", path: "/settings/logins", wait: "Netflix", find: /never shown again/i },
      { name: "composioHoldsSignIns", path: "/apps/connectors", wait: "Composio key", find: /Perry never sees a password or token/ },
      { name: "memoryStaysHere", path: "/memory", wait: "coffee black", find: /stays on this computer/i },
      { name: "nothingSharedByDefault", path: "/settings/people", wait: "Datta", find: /Perry shares nothing about you with them/ },
      { name: "peopleKeptApart", path: "/settings/people", wait: "Datta", find: /only in yours[\s\S]*only in theirs/ },
      { name: "dashboardKeyHowToChange", path: "/settings/security", wait: "Lock this browser", find: /DASHBOARD_KEY in \.env\.local/ },
      { name: "computersUnreachable", path: "/settings/computers", wait: "a-long-folder-name", find: /none can be reached from the internet/ },
      { name: "screenLookLimits", path: "/settings/desktop-pet", wait: "Show Perry the screen", find: /[Nn]ever in scheduled/ },
      { name: "petLoopbackOrPairingWarning", path: "/settings/desktop-pet", wait: "Show Perry the screen", find: /no other computer can reach it|Add a computer/ },
      { name: "usageCountsAllYourUse", path: "/settings/usage", wait: "Perry's share this week", find: /all your Codex use/ },
      { name: "remindersAlwaysGo", path: "/settings/notifications", wait: "Quiet hours", find: /Due reminders always go/ },
      { name: "deleteChatConsequence", path: `/chat/${planChat}`, wait: "Call Sam about Saturday", open: `document.querySelector('button[aria-label="Chat options"]')|Delete`, dialog: true, find: /go for good[\s\S]*memory from it stays/ },
      { name: "forgetMemoryConsequence", path: "/memory", wait: "coffee black", open: `${byText("main li", "coffee black")}?.querySelector("button:last-of-type")`, dialog: true, find: /is deleted, and Perry won.t recall it again/ },
      { name: "revokeComputerConsequence", path: "/settings/computers", wait: "a-long-folder-name", open: byText("main button", "Revoke"), dialog: true, find: /next request is refused/ },
      { name: "signOutEngineConsequence", path: "/settings/engines", wait: "Gemini API key", open: byText("main button", "Sign out"), dialog: true, find: /can't use Codex on this computer until you sign in again/ },
      { name: "blockPersonConsequence", path: "/settings/people", wait: "Datta", open: byText("main button", "Block"), dialog: true, find: /stops answering them/ },
      { name: "deleteLoginConsequence", path: "/settings/logins", wait: "Netflix", open: byText("main li button", "Delete"), dialog: true, find: /cannot be undone/ },
      { name: "removeSkillConsequence", path: "/apps/skills", wait: "weekly-review", open: byText("main li button", "Remove"), dialog: true, find: /folder is deleted from this computer/ },
      { name: "deleteProjectConsequence", path: `/projects/${project}`, wait: "matte green", open: `document.querySelector('button[aria-label="Project options"]')|Delete`, dialog: true, find: /deleted with it/ },
      { name: "cancelPlanConsequence", path: "/work?tab=plans", wait: "Compare three flats", open: byText("main li button", "Cancel"), dialog: true, find: /What it already did stays done/ },
      { name: "deleteRuleOrRequestsRecorded", path: "/settings/access", wait: "git push origin main", find: /Declined/ },
    ];
    const kept: Record<string, boolean> = {};
    for (const item of SAFETY) {
      try {
        await go(item.path, item.wait);
        if (item.open) {
          const [opener, menuItem] = item.open.split("|");
          await click(opener);
          if (menuItem) { await waitFor(`document.querySelector("[role=menu]")`, "the menu"); await click(byText("[role=menuitem]", menuItem)); }
          await waitFor(`document.querySelector("[role=alertdialog]")`, `${item.name}'s confirmation`, 10);
          await sleep(300);
        }
        // The page's words, an open dialog's, and what each InfoTip says on hover.
        const text = await evaluate(`[document.querySelector("[role=alertdialog]")?.innerText ?? "", document.body.innerText, ...[...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"))].join("\\n")`) as string;
        kept[item.name] = item.find.test(text);
        if (item.dialog) await escape();
      } catch (error) {
        kept[item.name] = false;
        notes[`safety-${item.name}`] = String(error);
      }
    }
    notes.kept = kept;
    check("safetyTextKept", Object.values(kept).every(Boolean), Object.fromEntries(Object.entries(kept).filter(([, ok]) => !ok)));
    // The full-access warning under the composer, for a chat set to Full access.
    await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
    await go("/chat", "Plan my day");
    check("fullAccessWarningKept", await evaluate(`document.body.innerText.includes("acts on this computer without asking")`) as boolean);
    await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
    await collectErrors("safety");

    // The pet, in a plain tab: what it opens goes through window.open once no dashboard tab claims it. A
    // question waiting on you holds his line, and an approval his bubble, so the approval is answered first
    // and his note of the plan running low shown again; it is his bubble's See usage that is clicked.
    for (const pending of await call<Array<{ id: string }>>("approvals:pending", { key: KEY })) await call("approvals:decide", { key: KEY, id: pending.id, approved: false });
    // The seed's task and schedule have turns waiting for the runner, whose "Thinking" would hold his bubble: the runner (played here) ends them.
    for (const turn of await call<Array<{ _id: string }>>("codex:queuedTurns", { token })) {
      await call("codex:claimTurn", { token, id: turn._id }).catch(() => {});
      await call("codex:finishTurn", { token, id: turn._id, response: "Done.", model: "gpt-6-luna" }).catch(() => {});
    }
    await evaluate(`localStorage.removeItem("perry.pet.limits"); true`);
    await size(404, 620);
    await send("Page.navigate", { url: `${BASE}/pet#key=${encodeURIComponent(KEY)}` });
    await waitFor(`document.querySelector('button[aria-label^="Perry."]')`, "the pet", 30);
    await evaluate(`window.__opened = []; window.open = (url) => { window.__opened.push(String(url)); return null; }; true`);
    await waitFor(byText("button", "See usage"), "the pet's See usage", 20);
    await shot("pet-limit", false);
    await click(byText("button", "See usage"));
    const petOpened = await soon(async () => ((await evaluate(`window.__opened`)) as string[]).includes("/settings/usage"), 10);
    check("petSeeUsageOpensUsage", petOpened, { opened: await evaluate(`window.__opened`) });
    await size(1280, 800);
    await collectErrors("pet-see-usage");

    // --- Words, page by page, against main --------------------------------------------------------------
    writeFileSync(join(OUT, "words.json"), JSON.stringify(words, null, 2) + "\n");
    const beforeFile = join(OUT, "words-before.json");
    if (!existsSync(beforeFile)) throw new Error(`no ${beforeFile}: run with --before <main checkout> first`);
    const before = JSON.parse(readFileSync(beforeFile, "utf8")) as typeof words;
    // Engines & usage was one page; it is Engines and Usage now.
    for (const page of Object.values(before)) page.words = wordsOf(page.text);
    const after = Object.fromEntries(Object.entries(words).map(([page, found]) => [page, { ...found, words: wordsOf(found.text) }]));
    if (after["settings-usage"]) after["settings-engines"] = { words: after["settings-engines"].words + after["settings-usage"].words, text: "" };
    const table: Array<{ page: string; before: number; after: number; down: string; target: string; ok: boolean }> = [];
    for (const [page, was] of Object.entries(before)) {
      const now = after[page];
      if (!now) { table.push({ page, before: was.words, after: -1, down: "missing", target: "", ok: false }); continue; }
      const down = 1 - now.words / was.words;
      const target = TARGETS[page] ?? DEFAULT_TARGET;
      table.push({ page, before: was.words, after: now.words, down: `${Math.round(down * 100)}%`, target: `${Math.round(target * 100)}%`, ok: down >= target - 1e-9 });
    }
    const total = { before: table.reduce((sum, row) => sum + row.before, 0), after: table.reduce((sum, row) => sum + Math.max(0, row.after), 0) };
    notes.words = { table, total, down: `${Math.round((1 - total.after / total.before) * 100)}%` };
    console.table(table);
    check("wordsDownOnEveryPage", table.every((row) => row.ok), table.filter((row) => !row.ok));

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
if (checks.completed === false) process.exit(1);
process.exit(0);
