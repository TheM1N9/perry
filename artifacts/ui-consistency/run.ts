import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/ui-consistency/run.ts <outDir> [--before <checkout>]
// Issue #176: the browser's own controls and one-off styles replaced with
// Perry's (Checkbox, RadioGroup cards, DatePicker and TimePicker, Table,
// Tooltip, ScrollArea, the pet's menu and tabs). A fresh Perry: the production
// build (`pnpm build` first) on a free port, a PERRY_HOME in PERRY_E2E_HOMES
// (else the temp folder), no Telegram, and no Codex or Claude: CODEX_HOME and
// CLAUDE_CONFIG_DIR point into the test's home, and the runner is played by its
// calls (a reply with a checklist and a table, a failed run, a traced one).
// Everything is seeded through the backend, as the other checks do: memories
// (one kept to a chat, one to a project, one promoted overnight), to-dos with
// repeats and a streak, a schedule that ran, a failed update, an approval and
// a decided one, a skill. Headless Chrome, in light and in dark; the pet's page
// in a plain tab at the pet window's 404×620, never the real pet (the owner's
// runs on this computer). With --before <checkout>, the same seed and shots
// from that checkout's build (main), and no checks, for the before pictures.
//
// Ways it could fail, written down before the checks:
//   1. A browser control is still the browser's: a visible native checkbox,
//      date, time or datetime-local field, or a <details>, on a checked screen,
//      in either theme.
//   2. A search box shows two clear buttons: the browser's × still drawn beside
//      Perry's, or Perry's gone.
//   3. A reply's checklist still has bullets or the browser's grey box, its
//      boxes are tickable, or its table has a doubled bottom border and no
//      header background.
//   4. The date picker saves the wrong moment for a one-time schedule: another
//      day, a month off, the time lost when the day changes, or shifted by the
//      timezone; the time picker saves a daily schedule at the wrong hour or
//      minute; quiet hours are not saved when focus leaves their time.
//   5. A tooltip that replaced a title= does not show on hover, or on keyboard
//      focus, or says the wrong thing.
//   6. The pet's chat picker does not open, or does not close on Escape or on
//      a click outside; Escape closes the whole panel with it; arrow keys do
//      not move through the chats, or Enter does not open the one picked; its
//      menu is not data-solid, so the pet's window would let its clicks through.
//   7. A tooltip on the pet opens outside its 404×620 window, or is not
//      data-solid.
//   8. The pet's tabs and buttons show no focus when reached by the keyboard,
//      or the tabs lost their tab semantics.
//   9. Anything throws or logs an error on a checked page.
//  10. A picture proves nothing: a screen is shot before its seeded content
//      shows (each shot waits for its seeded words).

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: bun artifacts/ui-consistency/run.ts <outDir> [--before <checkout>]");
const beforeAt = args.indexOf("--before");
const REPO = beforeAt >= 0 ? resolve(args[beforeAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BEFORE = beforeAt >= 0;
const OUT = resolve(outDir);
mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "ui-consistency-e2e-key";
const homes = process.env.PERRY_E2E_HOMES ?? tmpdir();
mkdirSync(homes, { recursive: true });
const home = mkdtempSync(join(homes, "perry-ui-consistency-"));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => {
  checks[name] = ok;
  if (note !== undefined) notes[name] = note;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && note !== undefined ? ` ${JSON.stringify(note).slice(0, 400)}` : ""}`);
};

// A skill, so "$weekly-review" in a message is marked as one.
mkdirSync(join(home, "skills", "weekly-review"), { recursive: true });
writeFileSync(join(home, "skills", "weekly-review", "SKILL.md"), "---\nname: weekly-review\ndescription: Writes the owner's weekly review the way they like it.\n---\n\nStart with what shipped, then what slipped.\n");

const env: NodeJS.ProcessEnv = {
  ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  // Never the owner's accounts: no engine here has a sign-in.
  CODEX_HOME: join(home, "codex-home"), CLAUDE_CONFIG_DIR: join(home, "claude-home"),
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE" || name === "PERRY_URL") delete env[name];
mkdirSync(env.CODEX_HOME!, { recursive: true });
mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
let log = "";
const server: ChildProcess = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

async function call<T>(path: string, callArgs: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args: callArgs }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<unknown> | unknown, what: string, seconds = 30) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}

type DomNode = { nodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
type Job = { id: string; name: string; schedule?: string; runAt?: number };
type Browser = Awaited<ReturnType<typeof openChat>>;
let browser: Browser | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

const CHECKLIST_REPLY = `Here's the week, with what's done ticked:

- [x] Book the dentist
- [x] Send the invoice to Priya
- [ ] Renew the passport photos
- [ ] Call Sam about Saturday

| Day | Plan | Time |
| --- | --- | --- |
| Monday | Gym, then the design review | 07:30 |
| Wednesday | Dentist | 14:00 |
| Friday | Weekly review | 16:00 |

Want me to put the passport photos on your list?`;

try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  const runnerJson = join(home, "runner.json");
  await until(() => existsSync(runnerJson), "the server to connect this computer", 60);
  const token = (JSON.parse(readFileSync(runnerJson, "utf8")) as { token: string }).token;
  const workdir = join(home, "work", "a-long-folder-name-that-the-row-cuts-off", "and-one-more-level-for-good-measure");
  const online = async () => {
    await call("runner:checkIn", { token, platform: "win32", hostname: "E2E", workdir });
    await call("codex:reportAccount", { token, available: true, authMode: "chatgpt", planType: "plus" }).catch(() => {});
  };
  await online();
  heartbeat = setInterval(() => void online().catch(() => {}), 20_000);

  // --- The seed ----------------------------------------------------------------------------
  const project = await call<string>("projects:create", { key: KEY, name: "Kitchen renovation" }).catch(() => null);
  const chat = async (title: string) => {
    const id = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:renameChat", { key: KEY, id, title }).catch(() => {});
    return id;
  };
  /** Send in a chat, and play the runner: take the turn, report what it did, and finish it. */
  const turn = async (id: string, text: string, finish: { response?: string; error?: string; spans?: object[] }) => {
    await call("dashboard:sendChat", { key: KEY, id, text });
    let queued: { _id: string } | undefined;
    await until(async () => { queued = (await call<Array<{ _id: string; conversationId: string }>>("codex:queuedTurns", { token })).find((item) => item.conversationId === id); return Boolean(queued); }, "the turn to queue", 30);
    await call("codex:claimTurn", { token, id: queued!._id });
    if (finish.spans) await call("codex:traceTurn", { token, id: queued!._id, spans: finish.spans, steps: 3, usage: { inputTokens: 18_204, cachedInputTokens: 12_000, outputTokens: 912 } });
    await call("codex:finishTurn", { token, id: queued!._id, ...(finish.response ? { response: finish.response, model: "gpt-6-luna" } : {}), ...(finish.error ? { error: finish.error } : {}) });
  };

  const planChat = await chat("Plan my week");
  const receiptsChat = await chat("Export last year's receipts");
  const memoryChat = await chat("Coffee order");
  const coffee = await call<{ id?: string }>("memories:add", { text: "Sam takes their coffee black, no sugar.", tags: [], source: "e2e", kind: "profile", origin: "owner" });
  await call("memories:add", { text: "In this chat, answers stay under three lines.", tags: [], source: "e2e", kind: "core", origin: "owner", conversationId: memoryChat });
  if (project) await call("memories:add", { text: "The kitchen tiles are the matte green ones from Porto.", tags: [], source: "e2e", kind: "core", origin: "owner", projectId: project });
  await call("memories:add", { text: "Prefers trains to flights for trips under six hours.", tags: [], source: "dreaming", kind: "core", origin: "owner" });
  await call("memories:add", { text: "Booked passport photos for Saturday at 11:00.", tags: [], source: "e2e", kind: "daily", origin: "owner" });

  const started = Date.now() - 40_000;
  await turn(planChat, "$weekly-review Plan my week, and tick off what's already done.", {
    response: `${CHECKLIST_REPLY}\nmemories: ${coffee.id}`,
    spans: [
      { callId: "c1", kind: "command", name: "Get-Content calendar.ics", status: "ok", startedAt: started, durationMs: 1_800, input: "Get-Content C:\\Users\\sam\\calendar.ics | Select-String 'DTSTART'", output: Array.from({ length: 40 }, (_, i) => `DTSTART:202610${String(i % 28 + 1).padStart(2, "0")}T0${i % 9}3000`).join("\n") },
      { callId: "c2", kind: "fileChange", name: "notes/week.md", status: "ok", startedAt: started + 2_000, durationMs: 400, input: "notes/week.md", output: "Added the week's plan." },
    ],
  });
  await turn(receiptsChat, "Export last year's receipts from the bank.", { error: "The bank's export page asked for a one-time code, and none was available.\nOpened https://bank.example/statements/export?year=2025&format=pdf&account=primary-savings-and-current" });

  const today = new Date();
  const at = (days: number, hours: number, minutes = 0) => { const d = new Date(today); d.setDate(d.getDate() + days); d.setHours(hours, minutes, 0, 0); return d.getTime(); };
  await call("todos:add", { key: KEY, title: "Stretch", dueAt: at(1, 11), repeat: "0 11 * * *" });
  await call("todos:add", { key: KEY, title: "Water the plants", dueAt: Date.now() + 2 * 3_600_000 });
  await call("todos:add", { key: KEY, title: "Weekly review", dueAt: at(2, 16), repeat: "0 16 * * 5" });
  const done = await call<string>("todos:add", { key: KEY, title: "Send the invoice to Priya" });
  await call("todos:setDone", { key: KEY, id: done, done: true });

  const job = await call<{ id: string }>("jobs:create", { name: "Morning briefing", schedule: "0 8 * * 1-5", prompt: "Summarise my calendar and anything urgent in email." });
  await call("jobs:trigger", { id: job.id });
  await call("jobs:finished", { id: job.id, result: "Three meetings today; the 14:00 with Priya moved to 15:30." });

  await call("updates:finished", { result: {
    id: "e2e-update", by: "nightly", at: Date.now() - 3 * 3_600_000, ok: false, from: "6fb9d92", to: "429446f",
    error: "pnpm install could not reach the registry.",
    log: Array.from({ length: 30 }, (_, i) => `step ${i + 1}: ${i === 29 ? "ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/next: request to https://registry.npmjs.org/next failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org" : "ok"}`).join("\n"),
  } });

  await call("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\build-cache", cwd: join(workdir, "site"), conversationId: planChat });
  const old = await call<{ id: string }>("approvals:request", { token, kind: "command", title: "git push origin main --force-with-lease --no-verify # after the rebase of the long-lived feature branch", cwd: workdir });
  await call("approvals:decide", { key: KEY, id: old.id, approved: false });

  // --- The browser -------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  // console.error too, not only what throws: a hydration or key warning is logged, not thrown.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errors = []; { const e = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ").slice(0, 300)); e(...a); }; }` });
  const errors: Array<{ page: string; error: string }> = [];
  const collectErrors = async (page: string) => { for (const error of (await evaluate(`window.__errors ?? []`).catch(() => [])) as string[]) errors.push({ page, error }); await evaluate(`window.__errors = []; true`).catch(() => {}); };
  const waitFor = (test: string, what: string, seconds = 20) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const go = async (path: string, words: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(`document.body.innerText.includes(${JSON.stringify(words)})`, `${path} to show "${words}"`, 30);
    await sleep(600);
  };
  const shot = async (name: string) => {
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(OUT, `${name}${BEFORE ? "-before" : ""}.png`), Buffer.from(image.data, "base64"));
  };
  const size = (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  /** The middle of what `expression` finds, in the page's coordinates. */
  const middle = (expression: string) => evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
  const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
  const click = async (expression: string) => {
    const point = await middle(expression);
    if (!point) throw new Error(`nothing to click: ${expression}`);
    await mouse("mouseMoved", point.x, point.y);
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseReleased", point.x, point.y);
    await sleep(250);
  };
  const key = async (keyName: string, code = keyName, keyCode = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
    await sleep(150);
  };
  const KEYS = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39 } as const;
  const press = (name: keyof typeof KEYS) => key(name, name, KEYS[name]);
  /** Focus as the keyboard does: a Tab first, so the page is in keyboard mode, then the element. */
  const keyboardFocus = async (expression: string) => {
    await press("Tab");
    return evaluate(`(() => { const el = ${expression}; if (!el) return null; el.focus(); return el.matches(":focus-visible"); })()`) as Promise<boolean | null>;
  };
  const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.innerText.trim().includes(${JSON.stringify(text)}))`;
  /** Put text into the focused field as typing does. */
  const typeText = async (text: string) => { await send("Input.insertText", { text }); await sleep(150); };

  /** Native controls visible on the page; with nativeClearButtons, search boxes still drawing the browser's own ×. */
  const NATIVE = `(() => {
    const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && el.getAttribute("aria-hidden") !== "true" && !el.closest("[aria-hidden=true]"); };
    const natives = [...document.querySelectorAll("input[type=checkbox], input[type=date], input[type=time], input[type=datetime-local], details")].filter(shown).map((el) => el.outerHTML.slice(0, 120));
    return { natives };
  })()`;
  const nativesFound: Record<string, unknown> = {};
  const noNatives = async (screen: string) => {
    const found = await evaluate(NATIVE) as { natives: string[] };
    const searchX = (await nativeClearButtons()).filter((item) => item.appearance !== "none");
    if (found.natives.length || searchX.length) nativesFound[screen] = { ...found, searchX };
  };
  /**
   * The browser's own × of each search box: an element in the input's user-agent shadow root, which only DevTools
   * reaches (getComputedStyle cannot name it), and how it is drawn: "none" is not at all.
   */
  const nativeClearButtons = async () => {
    await send("DOM.enable");
    await send("CSS.enable");
    const { root } = await send("DOM.getDocument", { depth: -1, pierce: true }) as { root: DomNode };
    const found: number[] = [];
    const walk = (node: DomNode) => {
      const attributes = node.attributes ?? [];
      for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === "pseudo" && attributes[i + 1] === "-webkit-search-cancel-button") found.push(node.nodeId);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };
    walk(root);
    const out: Array<{ appearance?: string; display?: string }> = [];
    for (const nodeId of found) {
      const { computedStyle } = await send("CSS.getComputedStyleForNode", { nodeId }) as { computedStyle: Array<{ name: string; value: string }> };
      const style = (name: string) => computedStyle.find((item) => item.name === name)?.value;
      out.push({ appearance: style("appearance") ?? style("-webkit-appearance"), display: style("display") });
    }
    return out;
  };
  /** The tooltip showing now: its words, where it is, and whether the pet's window would take the pointer there. */
  const tooltip = () => evaluate(`(() => {
    const tip = [...document.querySelectorAll("[data-slot=tooltip-content]")].find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && !el.hasAttribute("data-closed"); });
    if (!tip) return null;
    const r = tip.getBoundingClientRect();
    return { text: tip.innerText.trim(), solid: tip.hasAttribute("data-solid"), left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  })()`) as Promise<{ text: string; solid: boolean; left: number; top: number; right: number; bottom: number } | null>;
  const away = async () => { await mouse("mouseMoved", 1, 1); await evaluate(`document.activeElement?.blur(); true`); await sleep(500); };
  /** A tooltip shows on hover and on keyboard focus, with these words. */
  const tipResults: Record<string, unknown> = {};
  const tipCheck = async (name: string, expression: string, words: RegExp, { focus = true } = {}) => {
    const point = await middle(expression);
    let hover: Awaited<ReturnType<typeof tooltip>> = null;
    if (point) {
      await mouse("mouseMoved", point.x, point.y);
      await sleep(900);
      hover = await tooltip();
    }
    await away();
    let focused: Awaited<ReturnType<typeof tooltip>> | "skipped" = "skipped";
    if (focus) {
      await keyboardFocus(expression);
      await sleep(900);
      focused = await tooltip();
      await away();
    }
    const ok = Boolean(hover && words.test(hover.text)) && (focused === "skipped" || Boolean(focused && words.test(focused.text)));
    tipResults[name] = { hover: hover?.text ?? null, focus: focused === "skipped" ? "skipped" : focused?.text ?? null };
    if (!ok) console.log(`  tip ${name}: ${JSON.stringify(tipResults[name])}`);
    return ok;
  };

  for (const mode of ["light", "dark"] as const) {
    await scheme(mode);
    await size(1280, 800);

    // --- Chat: the checklist and the table ------------------------------------------------
    await go(`/chat/${planChat}`, "Call Sam about Saturday");
    await shot(`chat-reply-${mode}`);
    if (!BEFORE) {
      await noNatives(`chat-${mode}`);
      if (mode === "light") {
        const list = await evaluate(`(() => {
          const reply = [...document.querySelectorAll(".prose-chat")].find((el) => el.innerText.includes("Call Sam about Saturday"));
          const list = reply.querySelector("ul.contains-task-list");
          const boxes = [...list.querySelectorAll("[data-slot=checkbox]")];
          const table = reply.querySelector("table");
          const rows = [...table.querySelectorAll("tbody tr")];
          const wrapper = table.closest(".rounded-lg");
          return {
            bullets: getComputedStyle(list).listStyleType,
            boxes: boxes.map((box) => ({ role: box.getAttribute("role"), checked: box.getAttribute("aria-checked"), readonly: box.getAttribute("aria-readonly"), tab: box.tabIndex })),
            header: getComputedStyle(table.querySelector("thead")).backgroundColor,
            lastRowBorder: getComputedStyle(rows.at(-1)).borderBottomWidth,
            wrapperBorder: getComputedStyle(wrapper).borderBottomWidth,
          };
        })()`) as { bullets: string; boxes: Array<{ role: string; checked: string; readonly: string; tab: number }>; header: string; lastRowBorder: string; wrapperBorder: string };
        // Clicking a box must not tick it: a reply's checklist is read-only.
        await click(`document.querySelector(".prose-chat ul.contains-task-list [data-slot=checkbox][aria-checked=false]")`);
        const afterClick = await evaluate(`document.querySelectorAll(".prose-chat ul.contains-task-list [data-slot=checkbox][aria-checked=true]").length`);
        check("checklistIsPerrys", list.bullets === "none" && list.boxes.length === 4 && list.boxes.every((box) => box.role === "checkbox" && box.readonly === "true" && box.tab === -1)
          && list.boxes.filter((box) => box.checked === "true").length === 2 && afterClick === 2, { ...list, afterClick });
        check("tableIsPerrys", !/rgba\(0, 0, 0, 0\)|transparent/.test(list.header) && list.lastRowBorder === "0px" && list.wrapperBorder === "1px", list);
        check("skillChipTip", await tipCheck("skill chip", `document.querySelector("[data-skill-mention]")`, /The weekly-review skill/));
        check("memoryChipTip", await tipCheck("memory chip", `document.querySelector("[data-memories] a")`, /coffee black/));
        check("kbdInComposerNote", Boolean(await evaluate(`[...document.querySelectorAll("[data-slot=kbd]")].some((k) => k.textContent === "/")`)));
        // The sidebar: a chat's dot, and New project.
        check("statusDotTip", await tipCheck("status dot", `document.querySelector('[data-sidebar] a[href="/chat/${receiptsChat}"]')`, /The last reply failed/));
        check("newProjectTip", await tipCheck("new project", `document.querySelector('[aria-label="New project"]')`, /New project/));
      }
    }
    await collectErrors(`chat-${mode}`);

    // --- Memory: one clear button; tips on "Only in…" and "Promoted overnight" ---------------
    await go("/memory", "coffee black");
    const search = `document.querySelector('input[aria-label="Search memories"]')`;
    await evaluate(`${search}.focus(); true`);
    await typeText("e");
    await waitFor(`document.querySelector('[aria-label="Clear search"]')`, "the clear button", 10).catch(() => {});
    await shot(`memory-${mode}`);
    if (!BEFORE) {
      await noNatives(`memory-${mode}`);
      if (mode === "light") {
        const clear = await evaluate(`({ ours: document.querySelectorAll('[aria-label="Clear search"]').length, type: ${search}.type })`) as { ours: number; type: string };
        const browsers = await nativeClearButtons();
        check("searchHasOneClearButton", clear.ours === 1 && clear.type === "search" && browsers.length > 0 && browsers.every((item) => item.appearance === "none"), { ...clear, browsers });
        await click(`document.querySelector('[aria-label="Clear search"]')`);
        await sleep(500);
        check("onlyInChatTip", await tipCheck("only in chat", byText("span[tabindex]", "Only in Coffee order"), /Kept to one chat/));
        if (project) check("onlyInProjectTip", await tipCheck("only in project", `document.querySelector('a[href^="/projects/"]')`, /Kept to a project/));
        check("promotedTip", await tipCheck("promoted overnight", byText("span[tabindex]", "Promoted overnight"), /Promoted from daily notes overnight/));
      }
    }
    await collectErrors(`memory-${mode}`);
    await go("/memory?tab=about", "USER.md");
    if (!BEFORE) await noNatives(`about-${mode}`);

    // --- Work: tips on the schedule's times; the time and date pickers ------------------------
    await go("/work", "Morning briefing");
    await shot(`work-${mode}`);
    if (!BEFORE) {
      await noNatives(`work-${mode}`);
      if (mode === "light") {
        check("cronTip", await tipCheck("cron", byText("span[tabindex]", "Weekdays"), /0 8 \* \* 1-5/));
        check("nextRunTip", await tipCheck("next run", byText("span[tabindex]", "Next"), /\d{4}|\d:\d\d/));
        check("lastRanTip", await tipCheck("last ran", byText("span[tabindex]", "Last ran"), /\d{4}|\d:\d\d/));
      }
    }
    // A daily schedule at 07:45, by the time picker.
    await click(byText("button", "New schedule"));
    await waitFor(`document.querySelector("#schedule-name")`, "the schedule form");
    if (!BEFORE && mode === "light") {
      await evaluate(`document.querySelector("#schedule-name").focus(); true`);
      await typeText("E2E stretch reminder");
      await evaluate(`document.querySelector("#schedule-prompt").focus(); true`);
      await typeText("Remind me to stretch.");
      await evaluate(`document.querySelector('[aria-label="At: hours"]').focus(); true`);
      await typeText("07");
      await evaluate(`document.querySelector('[aria-label="At: minutes"]').focus(); true`);
      await typeText("45");
      await noNatives("schedule-daily");
      await click(byText('[role=dialog] button[type=submit]', "Save"));
      let daily: Job | undefined;
      await until(async () => { daily = (await call<{ jobs: Job[] }>("jobs:listForDashboard", { key: KEY })).jobs.find((item) => item.name === "E2E stretch reminder"); return Boolean(daily); }, "the daily schedule", 15).catch(() => {});
      check("timePickerSavesDailyTime", daily?.schedule === "45 7 * * *", daily);
      await waitFor(`!document.querySelector("[role=dialog]")`, "the dialog to close", 10).catch(() => {});
      await click(byText("button", "New schedule"));
      await waitFor(`document.querySelector("#schedule-name")`, "the schedule form");
    }
    // Once, on the 15th of next month at 16:20, by the date picker.
    await evaluate(`document.querySelector("#schedule-name").focus(); true`);
    await typeText(`E2E passport photos ${mode}`);
    await evaluate(`document.querySelector("#schedule-prompt").focus(); true`);
    await typeText("Remind me to bring the passport photos.");
    await click(`document.querySelector("#schedule-repeat")`);
    await waitFor(byText("[role=option]", "Once"), "the Once option");
    await click(byText("[role=option]", "Once"));
    await waitFor(`document.querySelector("#schedule-once")`, "the date field");
    const target = await evaluate(`(() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(15); d.setHours(16, 20, 0, 0); return { ms: d.getTime(), day: d.toLocaleDateString() }; })()`) as { ms: number; day: string };
    if (!BEFORE) {
      await click(`document.querySelector("#schedule-once")`);
      await waitFor(`document.querySelector("[data-slot=calendar]")`, "the calendar");
      await click(`document.querySelector('[data-slot=calendar] .rdp-button_next, [data-slot=calendar] button[aria-label*="next" i]')`);
      await waitFor(`document.querySelector('[data-slot=calendar] [data-day=${JSON.stringify(target.day)}]')`, "next month's 15th");
      await click(`document.querySelector('[data-slot=calendar] [data-day=${JSON.stringify(target.day)}]')`);
      await evaluate(`document.querySelector('[aria-label="Time: hours"]').focus(); true`);
      await typeText("16");
      await evaluate(`document.querySelector('[aria-label="Time: minutes"]').focus(); true`);
      await typeText("20");
      await sleep(300);
      await noNatives(`schedule-once-${mode}`);
      await shot(`schedule-once-${mode}`);
      await press("Escape");
      const afterEscape = await evaluate(`({ calendar: Boolean(document.querySelector("[data-slot=calendar]")), dialog: Boolean(document.querySelector("[role=dialog]")), shown: document.querySelector("#schedule-once").innerText })`) as { calendar: boolean; dialog: boolean; shown: string };
      await click(byText('[role=dialog] button[type=submit]', "Save"));
      let once: Job | undefined;
      await until(async () => { once = (await call<{ jobs: Job[] }>("jobs:listForDashboard", { key: KEY })).jobs.find((item) => item.name === `E2E passport photos ${mode}`); return Boolean(once); }, "the one-time schedule", 15).catch(() => {});
      check(`datePickerSavesOnce-${mode}`, once?.runAt === target.ms && !afterEscape.calendar && afterEscape.dialog && /16:20|4:20/.test(afterEscape.shown), { saved: once?.runAt && new Date(once.runAt).toString(), wanted: new Date(target.ms).toString(), afterEscape });
    } else {
      await sleep(500);
      await shot(`schedule-once-${mode}`);
      await press("Escape");
    }
    await collectErrors(`work-${mode}`);

    // --- Settings: the theme, quiet hours, the update's log; WhatsApp's cards and checkbox -----
    await go("/settings", "Quiet hours");
    if (!BEFORE) {
      await noNatives(`settings-${mode}`);
      if (mode === "light") {
        const logOpen = byText("button", "What it said");
        check("updateLogIsCollapsible", Boolean(await evaluate(`Boolean(${logOpen}) && !document.querySelector("details")`)));
        await click(logOpen);
        check("updateLogOpens", Boolean(await evaluate(`document.body.innerText.includes("ERR_PNPM_META_FETCH_FAIL")`)));
        // Quiet hours, saved when focus leaves the time.
        await click(`document.querySelector('[role=switch][aria-label="Quiet hours"]')`);
        await sleep(400);
        await evaluate(`document.querySelector('[aria-label="Quiet from: hours"]').focus(); true`);
        await typeText("21");
        await evaluate(`document.querySelector('[aria-label="Quiet from: minutes"]').focus(); true`);
        await typeText("30");
        await evaluate(`document.activeElement.blur(); true`);
        let manners: { quietHours?: { start: string; end: string } } | null = null;
        await until(async () => { manners = await call("dashboard:getManners", { key: KEY }); return manners?.quietHours?.start === "21:30"; }, "quiet hours to save", 10).catch(() => {});
        check("timePickerSavesQuietHours", (manners as { quietHours?: { start: string } } | null)?.quietHours?.start === "21:30", manners);
        const theme = await evaluate(`(() => { const group = document.querySelector('[aria-label="Theme"]'); const items = [...group.querySelectorAll("button")]; return { role: group.getAttribute("role"), items: items.map((b) => [b.innerText.trim(), b.getAttribute("aria-pressed")]) }; })()`);
        check("themeIsToggleGroup", JSON.stringify(theme).includes('["System","true"]'), theme);
      }
    }
    await sleep(300);
    await shot(`settings-${mode}`);
    await go("/settings?tab=whatsapp", "A separate number");
    await evaluate(`[...document.querySelectorAll("label")].find((l) => l.innerText.includes("Link with a code"))?.scrollIntoView({ block: "center" }); true`);
    await shot(`settings-whatsapp-${mode}`);
    if (!BEFORE) {
      await noNatives(`whatsapp-${mode}`);
      if (mode === "light") {
        const before = await evaluate(`document.querySelector('[role=radio][aria-checked=true]')?.innerText.split("\\n")[0]`);
        await keyboardFocus(`document.querySelector('[role=radio][aria-checked=true]')`);
        await press("ArrowDown");
        const moved = await evaluate(`document.querySelector('[role=radio][aria-checked=true]')?.innerText.split("\\n")[0]`);
        await click(byText("label", "Link with a code"));
        const phone = await evaluate(`Boolean(document.querySelector("#whatsapp-phone"))`);
        check("radioCardsAndCheckbox", before === "A separate number" && moved === "My own number" && phone === true, { before, moved, phone });
      }
    }
    await collectErrors(`settings-${mode}`);

    // --- Activity: lists, scroll areas, the inset focus ring -------------------------------------
    await go("/activity", "Export last year's receipts");
    await click(byText("[data-slot=collapsible-trigger]", "Export last year's receipts"));
    await click(byText("[data-slot=collapsible-trigger]", "Plan my week"));
    await waitFor(`document.body.innerText.includes("Get-Content calendar.ics")`, "the trace", 15).catch(() => {});
    await click(byText("[data-slot=collapsible-trigger]", "Get-Content calendar.ics"));
    await sleep(500);
    await shot(`activity-${mode}`);
    if (!BEFORE) {
      await noNatives(`activity-${mode}`);
      if (mode === "light") {
        const bars = await evaluate(`(() => {
          const scrolls = [...document.querySelectorAll("[data-slot=scroll-area]")];
          const native = [...document.querySelectorAll("main pre, main p")].filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight);
          return { scrollAreas: scrolls.length, nativeScrollers: native.length };
        })()`) as { scrollAreas: number; nativeScrollers: number };
        const ring = await keyboardFocus(byText("[data-slot=collapsible-trigger]", "Export last year's receipts"));
        const inset = await evaluate(`getComputedStyle(document.activeElement).boxShadow`) as string;
        check("activityScrollsAndFocus", bars.scrollAreas >= 2 && bars.nativeScrollers === 0 && ring === true && /inset/.test(inset), { ...bars, ring, inset });
      }
    }
    await collectErrors(`activity-${mode}`);

    // --- Needs you: the approval's expiry --------------------------------------------------------
    await go("/inbox", "build-cache");
    await shot(`inbox-${mode}`);
    if (!BEFORE) {
      await noNatives(`inbox-${mode}`);
      if (mode === "light") check("approvalExpiryTip", await tipCheck("approval expiry", byText("span[tabindex]", "left"), /declined when this runs out/));
    }
    await collectErrors(`inbox-${mode}`);

    // --- Computer: the cut-off folder and command -------------------------------------------------
    await go("/computer", "Recent requests");
    if (!BEFORE) {
      await noNatives(`computer-${mode}`);
      if (mode === "light") {
        check("workdirTip", await tipCheck("workdir", byText("span[tabindex]", "a-long-folder-name"), /and-one-more-level-for-good-measure/));
        check("commandTip", await tipCheck("command", byText("span[tabindex]", "git push origin main"), /no-verify # after the rebase/));
      }
    }
    await collectErrors(`computer-${mode}`);

    // --- To-dos: the round checkbox, the repeat's tip, the streak ---------------------------------
    await go("/todos", "Water the plants");
    await shot(`todos-${mode}`);
    if (!BEFORE) {
      await noNatives(`todos-${mode}`);
      if (mode === "light") {
        check("repeatTip", await tipCheck("repeat", `document.querySelector('[aria-label^="Repeats daily"]')`, /11/));
        check("streakTip", await tipCheck("streak", byText("span[tabindex]", "day"), /Days in a row/));
        const box = await evaluate(`(() => { const box = document.querySelector('[role=checkbox][aria-label^="Done: “Water the plants”"]'); return box && { radius: getComputedStyle(box).borderRadius, slot: box.dataset.slot }; })()`) as { radius: string; slot: string } | null;
        await click(`document.querySelector('[role=checkbox][aria-label^="Done: “Water the plants”"]')`);
        let ticked = false;
        await until(async () => { const board = await call<{ doneToday: Array<{ title: string }> }>("todos:board", { key: KEY }); ticked = board.doneToday.some((todo) => todo.title === "Water the plants"); return ticked; }, "the to-do to be done", 10).catch(() => {});
        check("roundCheckboxTicks", box?.slot === "checkbox" && box.radius !== "4px" && ticked, { box, ticked });
        await call<{ doneToday: Array<{ id: string; title: string }> }>("todos:board", { key: KEY }).then(async (board) => {
          const water = board.doneToday.find((todo) => todo.title === "Water the plants");
          if (water) await call("todos:setDone", { key: KEY, id: water.id, done: false });
        });
      }
    }
    await collectErrors(`todos-${mode}`);

    for (const [path, words] of [["/skills", "weekly-review"], ["/connectors", "Composio"], ["/welcome", "Meet your assistant"]] as const) {
      await go(path, words).catch(() => {});
      if (!BEFORE) await noNatives(`${path.slice(1)}-${mode}`);
      await collectErrors(`${path.slice(1)}-${mode}`);
    }

    // --- The pet's page, at his window's size -----------------------------------------------------
    await size(404, 620);
    await evaluate(`localStorage.setItem("perry.pet.chat", ${JSON.stringify(planChat)}); true`);
    await send("Page.navigate", { url: `${BASE}/pet#key=${encodeURIComponent(KEY)}` });
    await waitFor(`document.querySelector('button[aria-label^="Perry."]')`, "the pet", 30);
    await sleep(800);
    const openPanel = async () => {
      if (await evaluate(`Boolean(document.querySelector('section[aria-label="Perry"]'))`)) return;
      await click(`document.querySelector('button[aria-label^="Perry."]')`);
      await waitFor(`document.querySelector('section[aria-label="Perry"]')`, "his panel");
      await sleep(600);
    };
    await openPanel();
    await waitFor(`document.querySelector('section[aria-label="Perry"]').innerText.includes("Call Sam about Saturday")`, "his chat", 15).catch(() => {});
    await shot(`pet-chat-${mode}`);
    const picker = BEFORE ? `document.querySelector('section[aria-label="Perry"] button[aria-expanded]')` : `document.querySelector('[aria-label$=": pick a chat"]')`;
    await click(picker);
    await sleep(400);
    await shot(`pet-picker-${mode}`);
    await press("Escape");
    await openPanel();
    if (!BEFORE) {
      await noNatives(`pet-chat-${mode}`);
      if (mode === "light") {
        // Open, Escape; open, click outside; open by keyboard, arrow, Enter.
        const menu = `document.querySelector("[role=menu]")`;
        await click(picker);
        const opened = await evaluate(`(() => { const m = ${menu}; return m && { solid: m.hasAttribute("data-solid"), items: [...m.querySelectorAll("[role=menuitemradio]")].map((i) => i.innerText.trim()) }; })()`) as { solid: boolean; items: string[] } | null;
        await press("Escape");
        const escaped = await evaluate(`({ menu: Boolean(${menu}), panel: Boolean(document.querySelector('section[aria-label="Perry"]')) })`) as { menu: boolean; panel: boolean };
        await click(picker);
        await click(`document.querySelector('section[aria-label="Perry"] header p')`);
        await sleep(300);
        const outside = await evaluate(`({ menu: Boolean(${menu}), panel: Boolean(document.querySelector('section[aria-label="Perry"]')) })`) as { menu: boolean; panel: boolean };
        await keyboardFocus(picker);
        await press("ArrowDown");
        await sleep(300);
        const first = await evaluate(`document.activeElement?.closest("[role=menu]") ? document.activeElement.innerText.trim() : null`);
        await press("ArrowDown");
        const second = await evaluate(`document.activeElement?.closest("[role=menu]") ? document.activeElement.innerText.trim() : null`) as string | null;
        // Back up to the first, which is not the chat open now, and open it.
        await press("ArrowUp");
        await press("Enter");
        await sleep(600);
        const picked = await evaluate(`({ label: ${picker}?.getAttribute("aria-label"), stored: localStorage.getItem("perry.pet.chat"), menu: Boolean(${menu}) })`) as { label: string; stored: string; menu: boolean };
        check("petPickerMenu", Boolean(opened?.solid) && (opened?.items.length ?? 0) >= 3 && !escaped.menu && escaped.panel && !outside.menu && outside.panel
          && Boolean(first) && Boolean(second) && first !== second && !picked.menu && Boolean(first && picked.label.startsWith(String(first))) && picked.stored === receiptsChat,
        { opened, escaped, outside, first, second, picked });
        // Back to the chat with the reply.
        await click(picker);
        await click(byText("[role=menuitemradio]", "Plan my week"));
        await sleep(400);

        // Focus that shows, on the tabs and the buttons, reached by the keyboard.
        const focusables = {
          "Chat tab": byText("[role=tab]", "Chat"), "To-dos tab": byText("[role=tab]", "To-dos"), "Needs you tab": byText("[role=tab]", "Needs you"),
          "Open Perry": `document.querySelector('button[aria-label="Open Perry"]')`, Close: `document.querySelector('button[aria-label="Close"]')`,
          "Chat picker": picker, "New chat": `document.querySelector('button[aria-label="New chat"]')`, "Open in Perry": `document.querySelector('button[aria-label="Open this chat in Perry"]')`,
        };
        const focus: Record<string, unknown> = {};
        for (const [name, expression] of Object.entries(focusables)) {
          const visible = await keyboardFocus(expression);
          const style = await evaluate(`(() => { const s = getComputedStyle(document.activeElement); return { ring: s.boxShadow, outline: s.outlineStyle }; })()`) as { ring: string; outline: string };
          focus[name] = { visible, shows: style.ring !== "none" || style.outline !== "none" };
        }
        const tabs = await evaluate(`[...document.querySelectorAll('[role=tablist] [role=tab]')].map((t) => [t.innerText.trim().replace(/\\s+/g, " "), t.getAttribute("aria-selected")])`);
        await keyboardFocus(byText("[role=tab]", "Chat"));
        await press("ArrowRight");
        const arrowed = await evaluate(`document.activeElement?.getAttribute("role") === "tab" ? document.activeElement.innerText.trim() : null`);
        check("petFocusShows", Object.values(focus).every((item) => (item as { visible: boolean; shows: boolean }).visible && (item as { shows: boolean }).shows) && Array.isArray(tabs) && tabs.length === 3 && /To-dos/.test(String(arrowed)), { focus, tabs, arrowed });
        await away();

        // Tips on his buttons: inside his window, and data-solid.
        const petTips: Record<string, unknown> = {};
        for (const [name, expression, words] of [
          ["Close", `document.querySelector('button[aria-label="Close"]')`, /Close/],
          ["Open Perry", `document.querySelector('button[aria-label="Open Perry"]')`, /Open Perry/],
          ["New chat", `document.querySelector('button[aria-label="New chat"]')`, /New chat/],
          ["Open in Perry", `document.querySelector('button[aria-label="Open this chat in Perry"]')`, /Open in Perry/],
        ] as const) {
          const point = await middle(expression);
          await mouse("mouseMoved", point!.x, point!.y);
          await sleep(900);
          const tip = await tooltip();
          await away();
          await keyboardFocus(expression);
          await sleep(900);
          const focusTip = await tooltip();
          await away();
          petTips[name] = { hover: tip, focus: focusTip?.text ?? null, ok: Boolean(tip && words.test(tip.text) && tip.solid && tip.left >= 0 && tip.top >= 0 && tip.right <= 404 && tip.bottom <= 620 && focusTip && words.test(focusTip.text)) };
        }
        check("petTipsInWindow", Object.values(petTips).every((item) => (item as { ok: boolean }).ok), petTips);
      }
    }
    await collectErrors(`pet-chat-${mode}`);
    await click(BEFORE ? byText('section[aria-label="Perry"] [role=tab]', "To-dos") : byText("[role=tab]", "To-dos"));
    await waitFor(`document.querySelector('section[aria-label="Perry"]').innerText.includes("Stretch")`, "his to-dos", 15).catch(() => {});
    await sleep(400);
    await shot(`pet-todos-${mode}`);
    if (!BEFORE) await noNatives(`pet-todos-${mode}`);
    await click(byText("[role=tab]", "Needs you"));
    await waitFor(`document.querySelector('section[aria-label="Perry"]').innerText.includes("build-cache")`, "what needs you", 15).catch(() => {});
    await sleep(400);
    await shot(`pet-needs-${mode}`);
    if (!BEFORE) await noNatives(`pet-needs-${mode}`);
    await collectErrors(`pet-${mode}`);
    await click(byText("[role=tab]", "Chat"));
  }

  if (!BEFORE) {
    check("noNativeControls", Object.keys(nativesFound).length === 0, nativesFound);
    notes.tooltips = tipResults;
    const exceptions = browser.errors;
    check("nothingThrows", exceptions.length === 0 && errors.length === 0, { exceptions, consoleErrors: errors });
  }
} catch (error) {
  checks.completed = false;
  notes.error = error instanceof Error ? error.stack : String(error);
  console.error(error);
  if (browser) await browser.send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(OUT, `failure${BEFORE ? "-before" : ""}.png`), Buffer.from(image.data, "base64"))).catch(() => {});
} finally {
  if (heartbeat) clearInterval(heartbeat);
  browser?.close();
  if (process.platform === "win32" && server.pid) spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill();
  await sleep(1500);
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

if (!BEFORE) {
  const pass = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
  const result = { ranAt: new Date().toISOString(), pass, checks, notes, serverLog: pass ? undefined : log.slice(-4000) };
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}
process.exit(0);
