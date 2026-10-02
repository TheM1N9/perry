import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/inline-steps/run.ts <outDir>
// Each step Perry took, as a card in the chat's work log (issue #203): a
// command with its output, a file with its diff and a link, Perry's browser
// with a picture of the page, a web search with its results, and another of
// Perry's tools with what it was given and said. Live while the reply runs,
// kept after, the same on the Activity page.
//
// No model runs: the engine is the fake ACP agent playing Grok Build
// (artifacts/engine-acp/fake-agent.ts, its STEPS prompt), with CODEX_HOME and
// CLAUDE_CONFIG_DIR empty folders in the test's home. Everything else is real:
// a fresh Perry from the production build (`pnpm build` first) on a spare port,
// its own PERRY_HOME (under PERRY_E2E_DIR when set), the real runner, Perry's
// own browser on a page this test serves, and the chat in headless Chrome.
//
// Ways it could fail, written down before the checks:
//   1. A step cannot be opened, or opens to nothing: each kind must open to its
//      own card (command, file, browser, search, tool).
//   2. Opened while it runs, a command's card does not follow its output, or
//      the steps after it do not join the list until the reply lands.
//   3. A long output fills the chat: it must show its last lines with "Show all",
//      and say where the trace cut it; "Show all" must show the rest.
//   4. A file has no link, the link does not serve the file, or the diff is not
//      marked as lines taken out and put in.
//   5. The browser step shows no picture, or a broken one; or a page with a
//      saved login on it is pictured (a picture cannot be hidden).
//   6. A saved login shows anywhere: in a command's line or output, a page's
//      text, the trace kept on the server, or the page's text in the chat.
//   7. The search shows no results, or all of them at once.
//   8. Another tool shows no arguments or no result.
//   9. A failed step does not read as failed.
//  10. The cards are gone after the reply lands, or after the page loads again.
//  11. The steps are open from the start (it must be quiet by default).
//  12. The Activity page opens a step to something else than the chat's card.
//  13. The page throws, in light or dark.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/inline-steps/run.ts <outDir>");
const SECRET = `perry-steps-secret-${Date.now().toString(36)}`;
const HIDDEN = "[saved in Logins & secrets]";
let fakeHome = "";
const p = await perry({
  name: "inline-steps",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    // Signed in to the fake Grok from the start; no real Codex or Claude Code.
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    // The saved login, for the agent to put in its steps; not in the owner's message, which Activity shows.
    writeFileSync(join(fakeHome, "steps-secret"), SECRET);
    mkdirSync(join(home, "no-codex"), { recursive: true });
    mkdirSync(join(home, "no-claude"), { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: join(home, "no-codex"), CLAUDE_CONFIG_DIR: join(home, "no-claude") };
  },
});
const { KEY, BASE, call, check, notes, until, rows, getChat } = p;

// Two pages for Perry's browser: an ordinary one, and one that shows the saved login.
const site = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/secret") response.end(`<!doctype html><title>Your account key</title><body style="font:20px sans-serif;padding:40px"><h1>API key</h1><p>${SECRET}</p></body>`);
  else response.end(`<!doctype html><title>Perry steps test page</title><body style="font:20px sans-serif;padding:40px;background:#fef3c7"><h1>Perry steps test page</h1><p>A page for the browser step's picture.</p><a href="/secret">Account</a></body>`);
});
const sitePort = await new Promise<number>((done) => site.listen(0, "127.0.0.1", () => done((site.address() as { port: number }).port)));
const PAGE = `http://127.0.0.1:${sitePort}/`;
const workDir = join(p.home, "work");
mkdirSync(workDir, { recursive: true });

type Browser = NonNullable<ReturnType<typeof p.browser>>;
let ok = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("vault:save", { label: "Steps test key", url: PAGE, value: SECRET, by: "owner" });
  p.start("runner");
  await until(async () => (await call<Array<{ online: boolean; engines: Array<{ kind: string; installed: boolean; signedIn: boolean }> }>>("engines:list", { key: KEY }))
    .some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });

  const b = await p.openBrowser() as Browser;
  const { evaluate, send } = b;
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const shot = async (name: string, selector?: string) => {
    if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" }); true`);
    await sleep(300);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  const pageText = () => evaluate(`document.body.innerText`) as Promise<string>;
  await scheme("light");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await waitFor(`document.querySelector("#composer")`, "the chat to open");

  // --- Live: the steps join the list as they come; a command opened follows its output -----------------
  const LIVE = `[data-role="assistant"]:is([data-thinking], [data-streaming]) [data-work-steps]`;
  const liveKinds: string[][] = [];
  let watching = true;
  const watch = (async () => {
    while (watching) {
      const kinds = await evaluate(`[...document.querySelectorAll('${LIVE} [data-step]')].map((step) => step.dataset.kind)`).catch(() => null) as string[] | null;
      if (kinds && JSON.stringify(kinds) !== JSON.stringify(liveKinds.at(-1))) liveKinds.push(kinds);
      await sleep(150);
    }
  })();
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `STEPS ${JSON.stringify({ dir: workDir, page: PAGE, secretPage: `${PAGE}secret`, gap: 1500 })}` });
  await waitFor(`document.querySelector('${LIVE} [data-kind="command"][data-status="running"] button')`, "the command to run", 90);
  await evaluate(`document.querySelector('${LIVE} [data-kind="command"] button').click(); true`);
  await waitFor(`document.querySelector('${LIVE} [data-step-card="command"] [data-step-text="output"]')`, "the command's output while it runs", 20);
  const liveOutput = async () => evaluate(`document.querySelector('${LIVE} [data-step-card="command"] [data-step-text="output"]')?.innerText ?? ""`) as Promise<string>;
  const firstOutput = await liveOutput();
  await shot("live-command-light.png", LIVE);
  await until(async () => (await liveOutput()).includes("check 15 of 150"), "the output to grow", 20).catch(() => {});
  const laterOutput = await liveOutput();
  check("liveOutputGrows", firstOutput.includes("check 1 of 150") && !firstOutput.includes("check 15 of 150") && laterOutput.includes("check 15 of 150"), { firstOutput: firstOutput.slice(-120), laterOutput: laterOutput.slice(-120) });
  await waitFor(`document.querySelector('${LIVE} [data-kind="mcpToolCall"]')`, "the browser step, live", 90);
  await shot("live-steps-light.png", LIVE);
  await until(async () => !(await getChat(chat)).isRunning, "the reply to finish", 120);
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]") && document.querySelector('[data-role="assistant"] [data-work] button')`, "the reply to land", 30);
  watching = false;
  await Promise.race([watch, sleep(3_000)]);
  const lastLive = liveKinds.filter((kinds) => kinds.length).at(-1) ?? [];
  check("stepsJoinLive", liveKinds.filter((kinds) => kinds.length).length >= 4 && ["command", "fileChange", "webSearch", "mcpToolCall"].every((kind) => lastLive.includes(kind)), { liveKinds });
  check("liveCommandOpenedToOutput", firstOutput.length > 0);

  // --- After: folded, quiet; each step opens to its card -----------------------------------------------
  const WORK = `[...document.querySelectorAll('[data-role="assistant"] [data-work]')].at(-1)`;
  type Opened = { kind: string; label: string; status: string; card: string | null; text: string; html: string };
  const openAll = async () => {
    await evaluate(`(() => { const work = ${WORK}; const toggle = work.querySelector(":scope > button"); if (toggle.getAttribute("aria-expanded") !== "true") toggle.click(); return true; })()`);
    await sleep(300);
    const closedAtFirst = await evaluate(`[...${WORK}.querySelectorAll("[data-step] > button")].every((button) => button.getAttribute("aria-expanded") === "false") && !${WORK}.querySelector("[data-step-card]")`) as boolean;
    await evaluate(`(() => { for (const button of ${WORK}.querySelectorAll("[data-step] > button")) button.click(); return true; })()`);
    await waitFor(`${WORK}.querySelectorAll("[data-step-card]").length === ${WORK}.querySelectorAll("[data-step]").length`, "every step's card", 20);
    await sleep(800);
    const steps = await evaluate(`[...${WORK}.querySelectorAll("[data-step]")].map((step) => ({ kind: step.dataset.kind, label: step.dataset.step, status: step.dataset.status,
      card: step.querySelector("[data-step-card]")?.dataset.stepCard ?? null, text: step.querySelector("[data-step-card]")?.innerText ?? "", html: step.querySelector("[data-step-card]")?.innerHTML ?? "" }))`) as Opened[];
    return { closedAtFirst, steps };
  };
  const after = await openAll();
  const steps = after.steps;
  notes.steps = steps.map(({ html: _html, ...step }) => ({ ...step, text: step.text.slice(0, 400) }));
  check("quietByDefault", after.closedAtFirst);
  check("everyKindHasItsCard", ["command", "file", "browser", "search", "tool"].every((kind) => steps.some((step) => step.card === kind))
    && steps.every((step) => step.card !== null), steps.map((step) => [step.kind, step.card]));

  const command = steps.find((step) => step.card === "command" && step.status === "ok");
  check("commandShowsItsEnd", Boolean(command && command.text.includes("all 150 checks passed") && !command.text.includes("check 1 of 150") && /Show all \d+ lines/.test(command.text)), command?.text.slice(-300));
  // The output is longer than the 2 KB the trace keeps: its start was cut, and "Show all" says so with "…".
  await evaluate(`(() => { const card = ${WORK}.querySelector('[data-step][data-status="ok"] [data-step-card="command"]'); [...card.querySelectorAll("button")].find((b) => /Show all/.test(b.textContent)).click(); return true; })()`);
  await sleep(300);
  const whole = await evaluate(`${WORK}.querySelector('[data-step][data-status="ok"] [data-step-card="command"]').innerText`) as string;
  check("showAllAndCut", whole.startsWith(`$ node scripts/check.js`) && /\n…\ncheck \d+ of 150 passed\n/.test(whole) && !whole.includes("check 1 of 150 passed") && whole.split("\n").length > 20 && /Show less/.test(whole), whole.slice(0, 300));

  const file = steps.find((step) => step.card === "file");
  const href = await evaluate(`${WORK}.querySelector("[data-file-link]")?.getAttribute("href") ?? null`) as string | null;
  const served = href ? await evaluate(`fetch(${JSON.stringify(href)}).then(async (r) => ({ status: r.status, text: await r.text() }))`) as { status: number; text: string } : null;
  const marked = await evaluate(`(() => { const card = ${WORK}.querySelector('[data-step-card="file"]'); return { added: card.querySelectorAll(".text-success").length, removed: card.querySelectorAll(".text-destructive").length }; })()`) as { added: number; removed: number };
  check("fileLinkAndDiff", Boolean(file?.text.includes("notes.md") && href?.startsWith("/api/media/") && served?.status === 200 && served.text.includes("Perry shows each step")) && marked.added >= 2 && marked.removed >= 1, { href, served: served && { status: served.status, text: served.text.slice(0, 60) }, marked, text: file?.text });

  const browsers = steps.filter((step) => step.card === "browser");
  const pictures = await evaluate(`[...${WORK}.querySelectorAll('[data-step-card="browser"]')].map((card) => { const img = card.querySelector("[data-step-picture]"); return img ? { src: img.getAttribute("src"), loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth } : null; })`) as Array<{ src: string; loaded: boolean; width: number } | null>;
  check("browserPicture", browsers.length === 2 && browsers.every((step) => step.label === "Opening 127.0.0.1") && browsers[0]!.text.includes("Perry steps test page") && Boolean(pictures[0]?.loaded && pictures[0].src.startsWith("/api/media/") && pictures[0].width === 640), { pictures, texts: browsers.map((step) => step.text) });
  check("noPictureOfASavedLogin", pictures[1] === null && browsers[1]?.text.includes("Your account key") === true, { picture: pictures[1], text: browsers[1]?.text });

  const search = steps.find((step) => step.card === "search");
  const shownResults = await evaluate(`${WORK}.querySelectorAll('[data-step-card="search"] [data-step-results] li').length`) as number;
  await evaluate(`[...${WORK}.querySelectorAll('[data-step-card="search"] button')].find((b) => /Show all/.test(b.textContent))?.click(); true`);
  await sleep(200);
  const allResults = await evaluate(`[...${WORK}.querySelectorAll('[data-step-card="search"] [data-step-results] a')].map((a) => a.href)`) as string[];
  check("searchResults", shownResults === 3 && allResults.length === 5 && allResults.every((url) => url.startsWith("https://example.com/steps/")) && Boolean(search?.label.includes("perry inline steps")), { shownResults, allResults, label: search?.label });

  const tool = steps.find((step) => step.card === "tool");
  check("toolArgsAndResult", Boolean(tool && tool.status === "ok" && tool.label === "Adding a to-do" && /title\s*Look at the inline steps/.test(tool.text) && tool.html.includes('data-step-text="result"')), tool?.text);

  const failed = steps.find((step) => step.card === "command" && step.status === "error");
  check("failedReadsFailed", Boolean(failed?.text.includes("Cannot find module")), failed?.text);
  const failedIcon = await evaluate(`Boolean(${WORK}.querySelector('[data-step][data-status="error"] [aria-label="Failed"]'))`) as boolean;
  check("failedIcon", failedIcon);

  // A saved login shows nowhere: not in the chat, not in what the server kept.
  const text = await pageText();
  const spans = rows("runSpans");
  const leaked = spans.filter((span) => `${span.name} ${span.input ?? ""} ${span.output ?? ""}`.includes(SECRET)).map((span) => span.kind);
  check("secretHidden", !text.includes(SECRET) && text.includes(HIDDEN) && leaked.length === 0 && (command?.text.includes(`--token ${HIDDEN}`) ?? false), { leaked, hiddenShown: text.split(HIDDEN).length - 1 });
  const previews = rows("chatAttachments").filter((row) => row.messageKey === "steps");
  check("onePictureTaken", previews.length === 1, previews.map((row) => row.fileName));

  // Pictured as it reads once opened: long text folded again.
  await evaluate(`(() => { for (const button of ${WORK}.querySelectorAll("[data-step-card] button")) if (/Show less/.test(button.textContent)) button.click(); return true; })()`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 2400, deviceScaleFactor: 1, mobile: false });
  await shot("after-light.png", '[data-role="assistant"] [data-work]');
  check("noPageErrorsLight", b.errors.length === 0, b.errors);

  // --- After a reload, in dark --------------------------------------------------------------------------
  await scheme("dark");
  await send("Page.reload", {});
  await waitFor(`document.querySelector('[data-role="assistant"] [data-work] button')`, "the chat to load again", 30);
  await sleep(1_000);
  const again = await openAll();
  check("keptAfterReload", again.closedAtFirst && again.steps.length === steps.length && again.steps.every((step, index) => step.card === steps[index]!.card), again.steps.map((step) => step.card));
  await shot("after-dark.png", '[data-role="assistant"] [data-work]');
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });

  // --- The Activity page opens a step to the same card --------------------------------------------------
  for (const mode of ["dark", "light"] as const) {
    await scheme(mode);
    await send("Page.navigate", { url: `${BASE}/activity?session=${chat}` });
    await waitFor(`document.querySelector('ul[aria-label="Runs"] li button')`, "Activity's runs", 30);
    await evaluate(`document.querySelector('ul[aria-label="Runs"] li button').click(); true`);
    await waitFor(`document.querySelector('ol[aria-label="Trace"] li button')`, "the run's trace", 30);
    await evaluate(`(() => { for (const button of document.querySelectorAll('ol[aria-label="Trace"] li button')) if (/browser|node scripts\\/check/.test(button.textContent)) button.click(); return true; })()`);
    await waitFor(`document.querySelectorAll('ol[aria-label="Trace"] [data-step-card]').length >= 2`, "Activity's step cards", 20);
    await sleep(800);
    const cards = await evaluate(`[...document.querySelectorAll('ol[aria-label="Trace"] [data-step-card]')].map((card) => card.dataset.stepCard)`) as string[];
    const activityText = await pageText();
    check(`activityCards_${mode}`, cards.includes("command") && cards.includes("browser") && !activityText.includes(SECRET), cards);
    await shot(`activity-${mode}.png`, 'ol[aria-label="Trace"]');
  }
  check("noPageErrors", b.errors.length === 0, b.errors);
  ok = true;
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
} finally {
  site.close();
  notes.fakeLog = p.fakeLog(fakeHome).filter((entry) => entry.mcp || entry.finished).slice(-10);
}
const passed = await p.finish({ ok });
process.exit(passed ? 0 : 1);
