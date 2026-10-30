import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/chat-panel/run.ts <outDir>
// The chat panel ported from T3 Code's right panel (components/dashboard/chat/panel/chat-panel.tsx): a column
// docked beside the chat on a wide window, floating over it on a narrower one, a sheet on a phone; tabs of
// surfaces (Details, Files, Browser, Agents, Work) with "Open a surface" as the empty state and a "+" menu in the tab bar.
// Two fresh Perrys from the production build (`pnpm build` first): one for default surface availability,
// one with the real runner and Codex (signed in with ChatGPT) for a reply the Details and Work surfaces describe, and
// headless Chrome. Replies run on PERRY_E2E_MODEL (gpt-6-luna by default).
//
// Ways it could fail, written down before the checks:
//   1. The header's toggle does not open the panel, opens it without the launcher, or does not say it is pressed;
//      the panel opens over the chat instead of beside it on a wide window, so the chat does not narrow.
//   2. Closed, the docked panel still takes width, can be tabbed into (not inert), or keeps its surfaces mounted.
//   3. The launcher's letters do nothing, fire while typing in the composer, or open a surface that is defaults;
//      arrow keys and Enter do not move through the rows or open the highlighted one.
//   4. The "+" menu does not list the surfaces, its letters do not pick one, or picking one opens a second tab of it.
//   5. Tabs: clicking does not switch; arrow keys do not move between them; closing a tab shows nothing; closing
//      the last one leaves an empty panel open instead of closing it; focus is dropped on the page instead of
//      returning to the toggle.
//   6. The panel shortcuts (Ctrl+Alt+B to show or hide, Ctrl+Alt+N to pick a surface) do nothing, or are not
//      listed in Settings.
//   7. Resizing: dragging the left edge does not change the width, goes under 360px or over 70% of the window or
//      past leaving the chat 360px; the arrow keys on the edge do nothing; the width is not saved per chat, so a
//      reload loses it or another chat gets it.
//   8. State piles up: one localStorage key per chat (the floating workspace's perry.workspace.view.<id>) stays,
//      or perry.panel grows past 50 chats.
//   9. Listeners or timers leak: opening, closing and switching chats leaves more keydown, resize or pointer
//      listeners on the window than before.
//  10. The Browser surface stays mounted (and streaming) while another tab is shown.
//  11. At 1024px it docks (and squeezes the chat) instead of floating; Escape does not close the floating one.
//      At 390px it is not a full-width sheet.
//  12. Files and Browser are unavailable without configuration; on a chat not started yet, Browser and Work
//      do not say they need one.
//  13. Details does not name the chat's engine, or Work does not list the reply Perry just worked on.
//  14. Any of it throws in the page: no page errors, on either Perry.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/chat-panel/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const MAC = process.platform === "darwin";
/** CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. CommandOrControl is ⌘ on a Mac. */
const MOD = MAC ? 4 : 2;
const ALT = 1;

const p = await perry({ name: "chat-panel", outDir, runnerEnv: () => ({}), engine: "codex" });
const defaults = await perry({ name: "chat-panel-defaults", outDir: join(outDir, "defaults"), runnerEnv: () => ({}), engine: "codex" });
const { BASE, KEY, call, check, notes, until, computers, openBrowser } = p;

type Browser = Awaited<ReturnType<typeof openBrowser>>;
/** What the page can be asked about the panel, the same on either Perry. */
function driver(browser: Browser, base: string) {
  const { evaluate, send } = browser;
  const go = async (path: string) => {
    await send("Page.navigate", { url: `${base}${path}` });
    await evaluate(`new Promise((resolve) => { const tick = () => document.querySelector('textarea#composer') && document.querySelector('[data-chat-panel-toggle]') ? resolve(true) : setTimeout(tick, 100); tick(); })`);
    await sleep(800);
  };
  const press = async (key: string, modifiers = 0) => {
    const named: Record<string, [string, number]> = { ArrowDown: ["ArrowDown", 40], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowLeft: ["ArrowLeft", 37], Enter: ["Enter", 13], Escape: ["Escape", 27] };
    const [code, virtual] = named[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
    const text = key.length === 1 && !(modifiers & ~8) ? key : undefined;
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", modifiers, key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
    await sleep(350);
  };
  const click = (selector: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
  /** A real pointer click, for Base UI triggers that open on the press rather than the click event. */
  const pointerClick = async (selector: string) => {
    const at = await centre(selector);
    if (!at) return false;
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(400);
    return true;
  };
  /** To another chat from the sidebar, inside the page, so the chat screen stays mounted as it does for the owner. */
  const spa = async (path: string) => {
    await evaluate(`document.querySelector('a[href="${path}"]')?.click(), true`);
    await evaluate(`new Promise((resolve) => { const tick = () => location.pathname === ${JSON.stringify(path)} ? resolve(true) : setTimeout(tick, 100); tick(); })`);
    await sleep(800);
  };
  const centre = (selector: string) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`) as Promise<{ x: number; y: number } | null>;
  const hover = async (selector: string) => {
    const at = await centre(selector);
    if (!at) return "";
    for (let step = 0; step <= 4; step++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x - 20 + step * 5, y: at.y }); await sleep(60); }
    await sleep(1_000);
    return await evaluate(`[...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => el.textContent.trim()).join(" | ")`) as string;
  };
  type Info = { mode: string; open: boolean; inert: boolean; width: number; tabs: Array<{ id: string; selected: boolean }>; surface: string | null; launcher: string | null; pressed: string | null; focus: string | null; chatWidth: number; rowWidth: number };
  const panel = () => evaluate(`(() => {
    const el = document.querySelector('[data-chat-panel]');
    const toggle = document.querySelector('[data-chat-panel-toggle]');
    const active = document.activeElement;
    const focus = active?.hasAttribute('data-chat-panel-toggle') ? 'toggle' : active?.dataset?.panelTab ? 'tab:' + active.dataset.panelTab
      : active?.hasAttribute('data-panel-launcher') ? 'launcher' : active === document.body ? 'body' : active?.tagName ?? null;
    const chatWidth = Math.round(document.querySelector('#content')?.getBoundingClientRect().width ?? 0);
    if (!el) return { mode: 'none', open: false, inert: false, width: 0, tabs: [], surface: null, launcher: null, pressed: toggle?.getAttribute('aria-pressed') ?? null, focus, chatWidth, rowWidth: 0 };
    const mode = el.dataset.panelMode;
    return {
      mode, open: mode === 'docked' ? el.dataset.open === 'true' : true, inert: el.hasAttribute('inert'),
      width: Math.round(el.getBoundingClientRect().width),
      tabs: [...el.querySelectorAll('[data-panel-tab]')].map((tab) => ({ id: tab.dataset.panelTab, selected: tab.getAttribute('aria-selected') === 'true' })),
      surface: el.querySelector('[data-panel-surface]')?.dataset.panelSurface ?? null,
      launcher: el.querySelector('[data-panel-launcher]')?.dataset.panelLauncher ?? null,
      pressed: toggle?.getAttribute('aria-pressed') ?? null, focus, chatWidth, rowWidth: Math.round(el.parentElement?.clientWidth ?? 0),
    };
  })()`) as Promise<Info>;
  const settle = () => sleep(450);
  return { go, spa, press, click, pointer: pointerClick, hover, panel, settle, evaluate, send };
}

const scheme = async (browser: Browser, value: "light" | "dark") => {
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  await browser.evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  await sleep(300);
};
const size = (browser: Browser, width: number, height: number, mobile = false) => browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });

let defaultsFinished = false;
try {
  // --- 12. Default surface availability ---------------------------------------------------------
  defaults.start("server");
  await defaults.until(() => fetch(`${defaults.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the defaults server to start", 90);
  await defaults.call("dashboard:skipOnboarding", { key: defaults.KEY }).catch(() => {});
  const defaultChat = await defaults.call<string>("dashboard:createChat", { key: defaults.KEY });
  await defaults.call("dashboard:renameChat", { key: defaults.KEY, id: defaultChat, title: "Defaults" });
  const defaultBrowser = await defaults.openBrowser();
  await size(defaultBrowser, 1440, 900);
  const o = driver(defaultBrowser, defaults.BASE);
  await o.go(`/chat/${defaultChat}`);
  await o.click("[data-chat-panel-toggle]");
  await o.settle();
  const rows = await o.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-launcher-row]')].map((row) => [row.dataset.launcherRow, { unavailable: row.hasAttribute('data-unavailable'), opacity: getComputedStyle(row).opacity, text: row.textContent.trim() }]))`) as Record<string, { unavailable: boolean; opacity: string; text: string }>;
  await o.evaluate(`document.querySelector('[data-panel-launcher]')?.focus(), true`);
  await o.press("f");
  const afterF = await o.panel();
  await o.pointer("[data-panel-add]");
  const menu = await o.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-menu-surface]')].map((item) => [item.dataset.menuSurface, item.hasAttribute('data-disabled')]))`) as Record<string, boolean>;
  await o.press("Escape");
  await o.go("/chat");
  await o.click("[data-chat-panel-toggle]");
  await o.settle();
  const unstarted = await o.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-launcher-row]')].map((row) => [row.dataset.launcherRow, row.hasAttribute('data-unavailable') ? row.textContent.trim() : null]))`) as Record<string, string | null>;
  notes.defaults = { rows, afterF, menu, unstarted, pageErrors: defaultBrowser.errors };
  check("defaultRowsAvailable", Boolean(!rows.files?.unavailable && !rows.browser?.unavailable && !rows.details?.unavailable && !rows.work?.unavailable));
  check("defaultLetterOpensFiles", afterF.tabs.some((tab) => tab.id === "files" && tab.selected));
  check("defaultMenuAvailable", menu.files === false && menu.browser === false && menu.details === false && menu.work === false);
  check("unstartedChatSaysWhy", Boolean(unstarted.work?.includes("once this chat has started")) && Boolean(unstarted.browser?.includes("once this chat has started")) && unstarted.details === null && unstarted.files === null);
  check("defaultNoPageErrors", defaultBrowser.errors.length === 0);
  await defaults.finish();
  defaultsFinished = true;

  // --- The Perry with everything on ---------------------------------------------------------------------------
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)),
    "the runner to report Codex signed in", 120);
  const newChat = async (title: string) => {
    const id = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:renameChat", { key: KEY, id, title });
    await call("dashboard:setChatModel", { key: KEY, id, model: MODEL, engine: "codex" });
    return id;
  };
  const chat = await newChat("Panel chat");
  const other = await newChat("Another chat");
  const PROMPT = "Reply with the word ok.";
  await call("dashboard:sendChat", { key: KEY, id: chat, text: PROMPT });
  await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: chat })).isRunning
    && (await call<{ page: Array<{ role: string }> }>("dashboard:getChatMessages", { key: KEY, id: chat, paginationOpts: { numItems: 10, cursor: null } })).page.some((m) => m.role === "assistant"),
    "the reply", 300);

  const browser = await openBrowser();
  const { errors } = browser;
  const d = driver(browser, BASE);
  const { evaluate, send, press, click, pointer, panel, settle } = d;
  const shot = async (name: string) => { await sleep(400); writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64")); };
  await size(browser, 1440, 900);
  await scheme(browser, "light");
  // A key the floating workspace left behind, to see it swept.
  await evaluate(`localStorage.setItem("perry.workspace.view.legacy", "files"); localStorage.setItem("perry.workspace.chat.legacy", "{}"); true`);
  await d.go(`/chat/${chat}`);

  // Listeners on the window before anything is opened, to compare with after (9).
  const listeners = async () => {
    const { result } = await send("Runtime.evaluate", { expression: "window" }) as { result: { objectId: string } };
    const { listeners: all } = await send("DOMDebugger.getEventListeners", { objectId: result.objectId }) as { listeners: Array<{ type: string }> };
    const counts: Record<string, number> = {};
    for (const { type } of all) if (/^(keydown|resize|pointer|blur)/.test(type)) counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  };
  const baseline = await listeners();

  // --- 1, 2. Closed, then opened by the toggle --------------------------------------------------------------
  const closed = await panel();
  check("closedTakesNoRoom", closed.mode === "docked" && !closed.open && closed.inert && closed.width <= 1 && closed.surface === null && closed.pressed === "false", closed);
  check("legacyKeysSwept", await evaluate(`Object.keys(localStorage).every((key) => !key.startsWith("perry.workspace."))`) as boolean);
  await click("[data-chat-panel-toggle]");
  await settle();
  const opened = await panel();
  check("toggleOpensDockedLauncher", opened.mode === "docked" && opened.open && !opened.inert && opened.pressed === "true" && opened.launcher === "DFBW"
    && opened.tabs.length === 0 && opened.focus === "launcher" && opened.width === 540, opened);
  check("chatNarrowsWhenDocked", opened.chatWidth <= closed.chatWidth - 500 && opened.chatWidth >= 360, { closed: closed.chatWidth, opened: opened.chatWidth });
  await shot("launcher-light.png");
  await scheme(browser, "dark");
  await shot("launcher-dark.png");
  await scheme(browser, "light");

  // --- 3. Arrows and Enter, then closing the last tab --------------------------------------------------------
  await press("ArrowDown");
  await press("ArrowDown");
  await press("Enter");
  const arrowed = await panel();
  check("arrowsAndEnterOpen", arrowed.tabs.length === 1 && arrowed.tabs[0].id === "files" && arrowed.tabs[0].selected && arrowed.surface === "files" && arrowed.focus === "tab:files", arrowed);
  await click('[data-panel-tab-close="files"]');
  await settle();
  const lastClosed = await panel();
  check("closingLastTabClosesPanel", !lastClosed.open && lastClosed.inert && lastClosed.tabs.length === 0 && lastClosed.pressed === "false" && lastClosed.focus === "toggle", lastClosed);

  // --- 6, 3, 13. The shortcut, a letter, and what Work and Details say ---------------------------------------
  await evaluate(`document.querySelector('textarea#composer').focus(), true`);
  await press("b", MOD | ALT);
  await settle();
  const byShortcut = await panel();
  check("shortcutOpensPanel", byShortcut.open && byShortcut.launcher !== null, byShortcut);
  await evaluate(`document.querySelector('textarea#composer').focus(), true`);
  await press("w");
  const typed = await panel();
  const draft = await evaluate(`document.querySelector('textarea#composer').value`) as string;
  check("lettersIgnoredWhileTyping", typed.tabs.length === 0 && draft.endsWith("w"), { typed, draft });
  await evaluate(`(() => { const box = document.querySelector('textarea#composer'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ''); box.dispatchEvent(new Event('input', { bubbles: true })); box.blur(); return true; })()`);
  await press("w");
  await until(() => evaluate(`Boolean(document.querySelector('[data-work-item]'))`), "Work to list the reply", 20).catch(() => {});
  const work = await evaluate(`document.querySelector('[data-surface="work"]')?.innerText ?? ""`) as string;
  notes.work = work;
  check("letterOpensWork", (await panel()).surface === "work");
  check("workListsTheReply", work.includes(PROMPT));

  // --- 4. The "+" menu ------------------------------------------------------------------------------------------
  await pointer("[data-panel-add]");
  const listed = await evaluate(`[...document.querySelectorAll('[data-menu-surface]')].map((item) => item.dataset.menuSurface)`) as string[];
  await press("d");
  const plus = await panel();
  const detailsText = await evaluate(`document.querySelector('[data-surface="details"]')?.innerText ?? ""`) as string;
  notes.details = detailsText;
  check("plusMenuLetterOpens", listed.join() === "details,files,browser,agents,work" && plus.tabs.map((tab) => tab.id).join() === "work,details" && plus.surface === "details", { listed, plus });
  check("detailsNamesEngine", /Engine\s*Codex/.test(detailsText) && detailsText.includes(MODEL) && /Access/.test(detailsText));
  await shot("details-light.png");
  await pointer("[data-panel-add]");
  await press("w");
  check("pickingOpenSurfaceReusesTab", (await panel()).tabs.length === 2);

  // --- 10. The Browser tab, by the second shortcut ------------------------------------------------------------
  await press("n", MOD | ALT);
  await sleep(400);
  const menuOpen = await evaluate(`Boolean(document.querySelector('[data-slot="dropdown-menu-content"][data-open]'))`) as boolean;
  await press("b");
  await settle();
  const live = await evaluate(`Boolean(document.querySelector('[data-chat-panel] [aria-label="Live browser"]'))`) as boolean;
  check("surfaceShortcutOpensMenu", menuOpen && (await panel()).surface === "browser", { menuOpen });
  await click('[data-panel-tab="details"]');
  await settle();
  const gone = await evaluate(`!document.querySelector('[aria-label="Live browser"]')`) as boolean;
  check("browserUnmountsWhenInactive", live && gone, { live, gone });

  // --- 5. Tabs by keyboard --------------------------------------------------------------------------------------
  await evaluate(`document.querySelector('[data-panel-tab="details"]').focus(), true`);
  await press("ArrowRight");
  const right = await panel();
  check("arrowKeysSwitchTabs", right.surface === "browser" && right.focus === "tab:browser", right);
  await click('[data-panel-tab-close="browser"]');
  await settle();
  const afterClose = await panel();
  check("closingTabShowsNeighbour", afterClose.open && afterClose.tabs.map((tab) => tab.id).join() === "work,details" && afterClose.surface === "details", afterClose);
  await scheme(browser, "dark");
  await shot("details-dark.png");
  await scheme(browser, "light");

  // --- 7. Resizing ----------------------------------------------------------------------------------------------
  const edge = async () => evaluate(`(() => { const r = document.querySelector('[data-panel-resize]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200 }; })()`) as Promise<{ x: number; y: number }>;
  const drag = async (by: number) => {
    const at = await edge();
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 10; step++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + by * step / 10, y: at.y, button: "left", buttons: 1 }); await sleep(20); }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x + by, y: at.y, button: "left", buttons: 0, clickCount: 1 });
    await settle();
    return (await panel()).width;
  };
  const cap = await evaluate(`(() => { const row = document.querySelector('[data-chat-panel]').parentElement; return Math.max(360, Math.min(Math.floor(innerWidth * 0.7), row.clientWidth - 360)); })()`) as number;
  const wider = await drag(-120);
  const widest = await drag(-2000);
  const narrowest = await drag(2000);
  const chosen = await drag(-240);
  await evaluate(`document.querySelector('[data-panel-resize]').focus(), true`);
  await press("ArrowLeft");
  const keyed = (await panel()).width;
  const saved = await evaluate(`JSON.parse(localStorage.getItem("perry.panel") ?? "{}")[${JSON.stringify(chat)}]?.value ?? null`) as { width?: number; tabs?: string[] } | null;
  notes.resize = { cap, wider, widest, narrowest, chosen, keyed, saved };
  check("dragResizes", wider >= 650 && wider <= 670);
  check("resizeRespectsMax", widest === cap);
  check("resizeRespectsMin", narrowest === 360);
  check("arrowKeysResize", keyed === chosen + 16);
  check("widthSaved", saved?.width === keyed);
  const docked = await panel();
  check("chatKeepsRoom", docked.chatWidth >= 360 && docked.width + docked.chatWidth <= docked.rowWidth + 1, docked);

  // --- 8. The capped key, then a reload -------------------------------------------------------------------------
  await evaluate(`(() => { const map = JSON.parse(localStorage.getItem("perry.panel") ?? "{}"); for (let i = 0; i < 60; i++) map["stale-" + i] = { at: i, value: { open: true } }; localStorage.setItem("perry.panel", JSON.stringify(map)); return true; })()`);
  await d.go(`/chat/${chat}`);
  await settle();
  const reloaded = await panel();
  check("persistsAcrossReload", reloaded.open && reloaded.width === keyed && reloaded.tabs.map((tab) => tab.id).join() === "work,details" && reloaded.surface === "details", reloaded);
  await click('[data-panel-tab="work"]');
  await sleep(200);
  const entries = await evaluate(`Object.keys(JSON.parse(localStorage.getItem("perry.panel") ?? "{}"))`) as string[];
  check("panelKeyCapped", entries.length <= 50 && entries.includes(chat), { count: entries.length });

  // --- 7. Per chat ------------------------------------------------------------------------------------------------
  await d.spa(`/chat/${other}`);
  const elsewhere = await panel();
  await click("[data-chat-panel-toggle]");
  await settle();
  const otherOpen = await panel();
  await click("[data-chat-panel-toggle]");
  await settle();
  await d.spa(`/chat/${chat}`);
  const back = await panel();
  check("widthPerChat", !elsewhere.open && otherOpen.width === 540 && otherOpen.launcher !== null && back.open && back.width === keyed, { elsewhere, otherOpen, back });

  // --- 9. Listeners, after opening, closing and moving between chats ------------------------------------------------
  // Measured where the baseline was (this chat, panel closed), without a reload in between, so a leak would show.
  await d.go(`/chat/${chat}`);
  if ((await panel()).open) { await press("b", MOD | ALT); await settle(); }
  const baselineClosed = await listeners();
  for (let round = 0; round < 5; round++) {
    await press("b", MOD | ALT);
    await press("w");
    await press("b", MOD | ALT);
    await d.spa(`/chat/${round % 2 ? chat : other}`);
  }
  await d.spa(`/chat/${chat}`);
  if ((await panel()).open) { await press("b", MOD | ALT); await settle(); }
  const closedAgain = await panel();
  const after = await listeners();
  notes.listeners = { firstLoad: baseline, baseline: baselineClosed, after };
  check("noListenerLeak", closedAgain.mode === "docked" && !closedAgain.open
    && Object.keys({ ...baselineClosed, ...after }).every((type) => (after[type] ?? 0) <= (baselineClosed[type] ?? 0)), { baseline: baselineClosed, after });

  // --- 11. Floating at 1024, a sheet at 390 -----------------------------------------------------------------------
  await size(browser, 1024, 768);
  await settle();
  const narrowClosed = await panel();
  await click("[data-chat-panel-toggle]");
  await settle();
  const floating = await panel();
  check("overlayAt1024", floating.mode === "overlay" && floating.width <= 400 && floating.chatWidth === narrowClosed.chatWidth, { narrowClosed, floating });
  await shot("overlay-1024-light.png");
  await evaluate(`document.querySelector('[data-chat-panel] [aria-selected="true"]')?.focus(), true`);
  await press("Escape");
  await settle();
  const escaped = await panel();
  check("escapeClosesOverlay", escaped.mode === "none" && escaped.pressed === "false" && escaped.focus === "toggle", escaped);
  await size(browser, 390, 844, true);
  await settle();
  await click("[data-chat-panel-toggle]");
  await settle();
  const sheet = await panel();
  check("sheetAt390", sheet.mode === "sheet" && sheet.width >= 388, sheet);
  await shot("sheet-390-light.png");
  await click('[data-chat-panel] button[aria-label="Close panel"]');
  await settle();
  await size(browser, 1440, 900);

  // --- 6. Settings lists the panel's keys ----------------------------------------------------------------------------
  await send("Page.navigate", { url: `${BASE}/settings/desktop-pet#shortcuts` });
  await until(() => evaluate(`Boolean(document.querySelector('#shortcuts li'))`), "the shortcuts in Settings", 30).catch(() => {});
  const settings = await evaluate(`document.querySelector('#shortcuts')?.innerText ?? ""`) as string;
  notes.settingsShortcuts = settings;
  check("shortcutsInSettings", settings.includes("Chat panel") && settings.includes("Open in the chat panel"));

  notes.pageErrors = errors;
  check("noPageErrors", errors.length === 0);
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
}

if (!defaultsFinished) await defaults.finish().catch(() => false);
process.exit(await p.finish() ? 0 : 1);
