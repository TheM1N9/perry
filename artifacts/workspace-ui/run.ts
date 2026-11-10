import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/workspace-ui/run.ts <outDir> [label]
// The chat's workspace, floating windows over the chat opened from buttons in its header: each card (Context,
// Files, Browser) on its own, or all of them stacked as cards that open and close; as the owner sees it, in
// light and dark, on a desktop and a phone: the panel's look and how it works.
// `label` prefixes the pictures, so a run before a change and one after sit
// side by side.
//
// No model runs: the engine is the fake ACP agent playing Grok Build. Its EDIT
// prompt writes files as edit steps, which puts them in the chat's Files.
// Perry's own browser is real (PERRY_BROWSER_PATH, or the one Perry downloads),
// on a page this test serves. A fresh Perry from the production build (`pnpm
// build` first) with the workspace and the browser view turned on.
//
// Ways it could fail, written down before the checks:
//   1. The panel does not open from the chat, or opens without its cards; Context does not name the chat's engine.
//      A card's own button opens some other card, or more than it; a window pushes the chat aside instead of floating.
//   2. Files: a file Perry wrote is not listed, or opening it shows nothing of it.
//   3. Browser: it cannot be opened from its card; the page never shows, or does not fit the card (cut off or
//      wider than it); taking
//      over does not hand it to the owner (address bar stays locked), or giving
//      it back does not.
//   4. The address bar does not take the owner to a page they type.
//   5. Closing the panel leaves it on screen, or it does not come back as it was.
//   6. On a phone, the panel is not a full-width sheet, or something spills sideways.
//   7. The live view lags: fewer than 4 frames a second from a page that changes
//      ten times a second, or a click on the page takes over a second to show.
//   8. The page throws.

const [outDir, label = "now"] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/workspace-ui/run.ts <outDir> [label]");
let fakeHome = "";
const site = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/clock") {
    // Changes ten times a second, and turns yellow when pressed: how live the owner's view is.
    response.end(`<!doctype html><title>Clock page</title><body style="font:48px system-ui;padding:40px"><p id="n">0</p><button id="b" style="font:inherit;padding:20px 40px" onclick="document.body.style.background='#fde047'">Press</button>
      <script>let n = 0; setInterval(() => { document.getElementById("n").textContent = ++n; }, 100);</script></body>`);
    return;
  }
  const second = request.url === "/second";
  response.end(`<!doctype html><title>${second ? "Second page" : "Workspace test page"}</title><body style="font:18px system-ui;padding:40px;max-width:640px">
    <h1>${second ? "The second page" : "Quarterly report"}</h1><p>${second ? "Typed into the address bar." : "Revenue went up in every region. The full table is below."}</p>
    <table border=1 cellpadding=8 style="border-collapse:collapse"><tr><th>Region</th><th>Q3</th></tr><tr><td>North</td><td>120</td></tr><tr><td>South</td><td>98</td></tr></table>
    <p><input aria-label="Name" placeholder="Your name" style="font:inherit;padding:6px"></p></body>`);
});
const sitePort = await new Promise<number>((done) => site.listen(0, "127.0.0.1", () => done((site.address() as { port: number }).port)));
const PAGE = `http://127.0.0.1:${sitePort}/`;

const p = await perry({
  name: "workspace-ui",
  outDir,
  env: process.env.PERRY_BROWSER_PATH ? { PERRY_BROWSER_PATH: process.env.PERRY_BROWSER_PATH } : {},
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    mkdirSync(join(home, "no-codex"), { recursive: true });
    mkdirSync(join(home, "no-claude"), { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: join(home, "no-codex"), CLAUDE_CONFIG_DIR: join(home, "no-claude") };
  },
});
const { KEY, BASE, call, check, notes, until } = p;

type Browser = NonNullable<ReturnType<typeof p.browser>>;
let ok = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await call<Array<{ online: boolean; engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY }))
    .some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });
  const files = join(p.home, "files");
  mkdirSync(files, { recursive: true });

  const b = await p.openBrowser() as Browser;
  const { evaluate, send } = b;
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const size = (width: number, height: number, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const shot = async (name: string) => {
    await sleep(500);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, `${label}-${name}.png`), Buffer.from(image.data, "base64"));
  };
  const click = (selector: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
  const clickText = (scope: string, text: string) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
  const PANEL = `[aria-label="Chat workspace"]`;

  await scheme("light");
  await size(1440, 900);
  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await waitFor(`document.querySelector("#composer")`, "the chat to open");

  // Two files written by Perry, so Files has something in it.
  for (const [name, text] of [["report.md", "# Quarterly report\n\nRevenue went up in every region.\n\n| Region | Q3 |\n| --- | --- |\n| North | 120 |\n| South | 98 |\n"], ["notes.txt", "Call the supplier on Monday.\nAsk about the October invoice.\n"]] as const) {
    await call("dashboard:sendChat", { key: KEY, id: chat, text: `EDIT ${JSON.stringify({ path: join(files, name), text, reply: `I wrote ${name}.` })}` });
    await waitFor(`[...document.querySelectorAll('[data-role="assistant"]')].some((el) => el.textContent.includes("I wrote ${name}"))`, `the reply about ${name}`, 90);
  }

  // --- Each card's own button, then all of them ------------------------------------------------------
  const chatWidth = () => evaluate(`Math.round(document.querySelector("#content").getBoundingClientRect().width)`) as Promise<number>;
  const before = await chatWidth();
  const own: Record<string, unknown> = {};
  for (const [label, view] of [["Open Context", "context"], ["Open Files", "files"], ["Open Browser", "browser"]] as const) {
    await click(`button[aria-label="${label}"]`);
    await waitFor(`document.querySelector('${PANEL}')?.dataset.view === "${view}"`, `the ${view} window`, 10).catch(() => {});
    own[view] = await evaluate(`(() => { const panel = document.querySelector('${PANEL}'); return panel && { view: panel.dataset.view, title: panel.querySelector("h2")?.textContent, cards: [...panel.querySelectorAll("[data-card]")].map((card) => card.dataset.card), pressed: document.querySelector('button[aria-label="${label}"]').getAttribute("aria-pressed") }; })()`);
    if (view === "files") await shot("own-files-light");
  }
  notes.ownWindows = own;
  check("eachCardItsOwnWindow", Object.entries(own).every(([view, got]) => { const g = got as { view: string; cards: string[]; pressed: string } | null; return g?.view === view && g.cards.length === 1 && g.cards[0] === view && g.pressed === "true"; }), own);
  const during = await chatWidth();
  check("floatsOverTheChat", during === before, { before, during });
  await click(`button[aria-label="Open Browser"]`);
  check("sameButtonCloses", await waitFor(`!document.querySelector('${PANEL}')`, "the window to close", 10).then(() => true, () => false));

  // --- Files -----------------------------------------------------------------------------------------
  check("panelOpens", await click(`button[aria-label="Open workspace"]`) && await waitFor(`document.querySelector('${PANEL}')`, "the panel", 10).then(() => true, () => false));
  const cards = await evaluate(`[...document.querySelectorAll('${PANEL} [data-card]')].map((card) => card.dataset.card)`) as string[];
  check("panelCards", ["context", "files", "browser"].every((name) => cards.includes(name)), cards);
  const context = await evaluate(`document.querySelector('${PANEL} [data-card="context"]')?.innerText ?? ""`) as string;
  notes.contextCard = context;
  check("contextCard", /Engine\s*Grok Build/.test(context) && /(% used|after Perry's next reply)/.test(context), context);
  const listed = await waitFor(`document.querySelector('${PANEL}').textContent.includes("report.md")`, "report.md in Files", 20).then(() => true, () => false);
  check("filesListed", listed);
  await shot("files-light");
  await clickText(`${PANEL} button`, "report.md") || await evaluate(`(() => { const el = [...document.querySelectorAll('${PANEL} button')].find((el) => el.textContent.includes("report.md") && !el.textContent.includes("Latest")); el?.click(); return Boolean(el); })()`);
  check("filePreview", await waitFor(`document.querySelector('${PANEL}').textContent.includes("Revenue went up")`, "the file's words", 20).then(() => true, () => false));
  await shot("file-preview-light");
  await click(`${PANEL} button[aria-label="All files"]`);

  // --- Browser, in its card --------------------------------------------------------------------------
  if (!await evaluate(`Boolean(document.querySelector('${PANEL} [data-card="browser"] [data-browser-state]'))`)) await click(`${PANEL} [data-card="browser"] [data-slot="collapsible-trigger"]`);
  await waitFor(`document.querySelector('${PANEL} [data-card="browser"] [data-browser-state]')`, "the browser card to open", 10);
  await sleep(1_000);
  await shot("browser-closed-light");
  const opened = await clickText(`${PANEL} button`, "Open browser");
  notes.openButton = opened;
  const live = await waitFor(`document.querySelector('${PANEL} img[alt^="Live page"]')`, "the page in the panel", 60).then(() => true, () => false);
  check("browserOpens", live);
  if (live) {
    // Take over, then go to the test page from the address bar.
    await clickText(`${PANEL} button`, "Pause & take over") || await evaluate(`(() => { const el = [...document.querySelectorAll('${PANEL} button')].find((el) => /take over/i.test(el.textContent)); el?.click(); return Boolean(el); })()`);
    const unlocked = await waitFor(`!document.querySelector('${PANEL} input[aria-label="Browser address"]')?.disabled`, "the address bar to unlock", 20).then(() => true, () => false);
    check("takeOver", unlocked);
    await evaluate(`(() => { const input = document.querySelector('${PANEL} input[aria-label="Browser address"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, ${JSON.stringify(PAGE)}); input.dispatchEvent(new Event("input", { bubbles: true })); input.form.requestSubmit(); return true; })()`);
    const navigated = await waitFor(`document.querySelector('${PANEL} img[alt="Live page: Workspace test page"]')`, "the test page", 30).then(() => true, () => false);
    check("addressBar", navigated);
    await sleep(1_500);
    // The page fits its card: as wide as the card at most, and not cut off by it.
    const fit = await evaluate(`(() => {
      const card = document.querySelector('${PANEL} [data-card="browser"]').getBoundingClientRect();
      const page = document.querySelector('${PANEL} [data-card="browser"] [role="application"]').getBoundingClientRect();
      return { card: [Math.round(card.left), Math.round(card.right), Math.round(card.bottom)], page: [Math.round(page.left), Math.round(page.right), Math.round(page.bottom)], wide: Math.round(page.width) };
    })()`) as { card: number[]; page: number[]; wide: number };
    notes.browserFit = fit;
    check("browserFitsTheCard", fit.page[0]! >= fit.card[0]! && fit.page[1]! <= fit.card[1]! && fit.page[2]! <= fit.card[2]! && fit.wide >= 500, fit);
    await shot("browser-paused-light");
    await scheme("dark");
    await sleep(800);
    await shot("browser-paused-dark");
    await scheme("light");

    // How live it is: frames a second from a page that changes ten times a second, and a click until it shows.
    await evaluate(`(() => { const input = document.querySelector('${PANEL} input[aria-label="Browser address"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, ${JSON.stringify(`${PAGE}clock`)}); input.dispatchEvent(new Event("input", { bubbles: true })); input.form.requestSubmit(); return true; })()`);
    await waitFor(`document.querySelector('${PANEL} img[alt="Live page: Clock page"]')`, "the clock page", 30);
    await sleep(1_500);
    await evaluate(`(() => { window.__frames = []; const watch = () => { const img = document.querySelector('${PANEL} img[alt^="Live page"]'); if (img && img.src !== window.__last) { window.__last = img.src; window.__frames.push(performance.now()); } requestAnimationFrame(watch); }; watch(); return true; })()`);
    await sleep(3_000);
    const fps = (await evaluate(`window.__frames.length`) as number) / 3;
    notes.framesPerSecond = fps;
    check("liveFrames", fps >= 4, fps);
    // The button sits at about x 50-260, y 240-360 on the 1280x900 page; the click lands where the panel maps it.
    const clickAt = await evaluate(`(() => { const box = document.querySelector('${PANEL} [role="application"]').getBoundingClientRect(); return { x: box.left + box.width * 140 / 1280, y: box.top + box.height * 300 / 900 }; })()`) as { x: number; y: number };
    const pressed = await evaluate(`(async () => {
      const page = document.querySelector('${PANEL} [role="application"]');
      const yellow = async () => { const img = page.querySelector("img"); const bitmap = await createImageBitmap(img); const canvas = new OffscreenCanvas(1, 1); const draw = canvas.getContext("2d"); draw.drawImage(bitmap, bitmap.width - 4, bitmap.height - 4, 1, 1, 0, 0, 1, 1); const [r, g, b] = draw.getImageData(0, 0, 1, 1).data; return r > 200 && g > 200 && b < 120; };
      const start = performance.now();
      page.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: ${clickAt.x}, clientY: ${clickAt.y} }));
      while (performance.now() - start < 5000) { if (await yellow()) return Math.round(performance.now() - start); await new Promise((done) => setTimeout(done, 25)); }
      return null;
    })()`) as number | null;
    notes.clickToScreenMs = pressed;
    check("clickShowsQuickly", pressed !== null && pressed < 1_000, pressed);
    await shot("browser-clock-light");
    await scheme("light");
    await evaluate(`(() => { const el = [...document.querySelectorAll('${PANEL} button')].find((el) => /resume/i.test(el.textContent)); el?.click(); return Boolean(el); })()`);
    check("giveBack", await waitFor(`document.querySelector('${PANEL} input[aria-label="Browser address"]')?.disabled`, "the address bar to lock again", 20).then(() => true, () => false));
    await shot("browser-live-light");
  }

  // --- Closing and opening again ---------------------------------------------------------------------
  await click(`${PANEL} button[aria-label="Close workspace"]`);
  const closed = await waitFor(`!document.querySelector('${PANEL}')`, "the panel to close", 10).then(() => true, () => false);
  await click(`button[aria-label="Open workspace"]`);
  const back = await waitFor(`document.querySelector('${PANEL} [data-card="browser"] img[alt^="Live page"]')`, "the browser card open again, live", 20).then(() => true, () => false);
  check("closeAndReopen", closed && back, { closed, back });

  // --- Dark, and a phone -----------------------------------------------------------------------------
  await scheme("dark");
  await click(`${PANEL} [data-card="browser"] [data-slot="collapsible-trigger"]`);
  await sleep(800);
  await shot("files-dark");
  await click(`button[aria-label="Open Browser"]`);
  await waitFor(`document.querySelector('${PANEL} img[alt^="Live page"]')`, "the browser window", 20).catch(() => {});
  await sleep(800);
  await shot("own-browser-dark");
  await click(`button[aria-label="Open Files"]`);
  await sleep(500);
  await size(390, 844, true);
  await sleep(800);
  await shot("phone-dark");
  const spill = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) as number;
  const sheet = await evaluate(`(() => { const el = document.querySelector('[role="dialog"]'); return el ? Math.round(el.getBoundingClientRect().width) : 0; })()`) as number;
  check("phoneSheet", spill <= 0 && sheet >= 380, { spill, sheet });
  check("noPageErrors", b.errors.length === 0, b.errors);
  ok = true;
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
} finally {
  site.close();
}
const passed = await p.finish({ ok });
process.exit(passed ? 0 : 1);
