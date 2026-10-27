import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServer } from "../../runner/codex";
import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/t3-v013/run.ts <outDir>
// What Perry took from T3 Code v0.1.3's fixes, in the dashboard: a fresh Perry from the production build
// (`pnpm build` first), the real runner and Codex (signed in with ChatGPT), headless Chrome. Replies run on
// PERRY_E2E_MODEL (gpt-6-luna by default).
//
// Ways it could fail, and what this checks for each:
//   1. Ctrl+B in the composer still bolds with nothing selected and collapses the sidebar too (T3 #24063):
//      with a bare caret, Ctrl+B must toggle the sidebar and leave the draft as typed; with text selected, it
//      must bold the text and leave the sidebar as it was.
//   2. The open chat says nothing to a screen reader as it starts and finishes (T3 #23752): its live region
//      must say "Working" and then "Done", and nothing about the chat when it was opened.
//   3. Another chat finishing goes unheard (T3 #23839): a chat replying in the background while another is
//      open must be announced by title as finished, and the open chat must not be announced that way.
//   4. Search ranks a match inside a word with a match at a word's start (T3 #24032): typing "auth" must list
//      "Auth tokens rotation" before the more recent "Fix the OAuth callback".
//   5. A reply's Markdown image at a local path renders as a broken <img> (T3 #24627): it must show as a named
//      path, while a web image still renders as an image.
//   6. A failed read of a plan's limits leaves Usage "Waiting…" forever (T3 #17055): the reason must show
//      with a way to sign in again, and go once a read succeeds.
//   7. ChatGPT plan ids show raw, "Prolite" or "Self_serve_business_prolite" (T3 #24200): the plan shown must
//      be ChatGPT's current name for the plan Codex reports.
//   8. Any of it throws in the page: no page errors.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/t3-v013/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const p = await perry({ name: "t3-v013", outDir, runnerEnv: () => ({}), engine: "codex" });
const { BASE, KEY, call, check, notes, until, rows, computers, openBrowser } = p;

type Summary = { id: string; title: string; status: string };
const chats = () => call<Summary[]>("dashboard:listChats", { key: KEY });
const newChat = async (title: string) => {
  const id = await call<string>("dashboard:createChat", { key: KEY });
  // Named up front, so no quick turn is spent naming it.
  await call("dashboard:renameChat", { key: KEY, id, title });
  await call("dashboard:setChatModel", { key: KEY, id, model: MODEL, engine: "codex" });
  return id;
};

try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)),
    "the runner to report Codex signed in", 120);
  const token = String(rows("runners").find((row) => !row.revoked)?.token);

  const browser = await openBrowser();
  const { evaluate, send, errors } = browser;
  const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  // Every text a polite sr-only region is given, in order, from the moment the page loads.
  const RECORD = `(() => { window.__said = []; const seen = new WeakMap();
    new MutationObserver(() => { for (const node of document.querySelectorAll('div.sr-only[aria-live="polite"]')) {
      const text = node.textContent.trim(); if (text && seen.get(node) !== text) window.__said.push(text); seen.set(node, text); } })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true }); return true; })()`;
  const go = async (path: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await evaluate(`new Promise((resolve) => { const tick = () => document.querySelector('textarea#composer') ? resolve(true) : setTimeout(tick, 100); tick(); })`);
    await evaluate(RECORD);
  };
  const lost: string[] = [];
  // Null when the page has reloaded since the recorder went in (a new build, a lost connection): noted, and reinstalled.
  const said = async (): Promise<string[]> => {
    const all = await evaluate("window.__said ? window.__said.slice() : null") as string[] | null;
    if (all) return all;
    lost.push(await evaluate("location.pathname") as string);
    notes.recorderLost = lost;
    await evaluate(RECORD);
    return [];
  };
  const key = async (key: string, modifiers: number) => {
    const code = `Key${key.toUpperCase()}`;
    const virtual = key.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
    await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
    await sleep(300);
  };
  const CTRL = 2;
  const sidebar = () => evaluate(`document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state') ?? null`) as Promise<string | null>;
  const draft = (text: string, start: number, end: number) => evaluate(`(() => {
    const box = document.querySelector('textarea#composer');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus(); box.setSelectionRange(${start}, ${end}); return true; })()`);
  const composer = () => evaluate(`document.querySelector('textarea#composer').value`) as Promise<string>;

  // --- 1. Ctrl+B ---------------------------------------------------------------------------------------------
  await go("/chat");
  await draft("hello", 5, 5);
  await sleep(300);
  const before = await sidebar();
  await key("b", CTRL);
  const bare = { sidebar: await sidebar(), draft: await composer() };
  await key("b", CTRL);
  const back = await sidebar();
  await evaluate(`(() => { const box = document.querySelector('textarea#composer'); box.focus(); box.setSelectionRange(0, 5); return true; })()`);
  await key("b", CTRL);
  const selected = { sidebar: await sidebar(), draft: await composer() };
  notes.ctrlB = { before, bare, back, selected };
  check("ctrlBWithoutSelectionTogglesSidebar", before === "expanded" && bare.sidebar === "collapsed" && bare.draft === "hello" && back === "expanded");
  check("ctrlBWithSelectionBolds", selected.draft === "**hello**" && selected.sidebar === "expanded");
  await draft("", 0, 0);

  // --- 2 and 5. The open chat, with an image in its message ----------------------------------------------------
  const auth = await newChat("Auth tokens rotation");
  await go(`/chat/${auth}`);
  await draft("Here is the chart: ![sales chart](C:/perry-e2e/missing/chart.png) and a web one ![logo](https://example.com/logo.png). Reply with the word ok.", 0, 0);
  await sleep(200);
  await evaluate(`document.querySelector('[aria-label="Send message"]').click(), true`);
  await until(async () => (await chats()).find((chat) => chat.id === auth)?.status === "running", "the open chat to start", 30);
  await until(async () => (await chats()).find((chat) => chat.id === auth)?.status === "idle", "the open chat's reply", 300);
  await sleep(1_500);
  const openSaid = await said();
  notes.openChatSaid = openSaid;
  check("openChatAnnounced", openSaid.includes("Working") && openSaid.includes("Done") && openSaid.indexOf("Working") < openSaid.lastIndexOf("Done"));
  const images = await evaluate(`(() => {
    const user = [...document.querySelectorAll('[data-role="user"]')].at(-1);
    return {
      localImg: [...document.querySelectorAll('img')].some((img) => (img.getAttribute('src') ?? '').includes('perry-e2e')),
      path: user?.querySelector('[data-file-path]')?.textContent?.trim() ?? null,
      pathTitle: user?.querySelector('[data-file-path]')?.getAttribute('title') ?? null,
      webImg: Boolean(user?.querySelector('img[src="https://example.com/logo.png"]')),
    };
  })()`) as { localImg: boolean; path: string | null; pathTitle: string | null; webImg: boolean };
  notes.images = images;
  check("localImageNamedNotBroken", !images.localImg && images.path === "sales chart" && Boolean(images.pathTitle?.includes("C:/perry-e2e/missing/chart.png")));
  check("webImageStillRenders", images.webImg);
  await shot("image-path.png");

  // --- 3. Another chat finishing ---------------------------------------------------------------------------------
  const oauth = await newChat("Fix the OAuth callback");
  await call("dashboard:sendChat", { key: KEY, id: oauth, text: "Reply with the word ok." });
  await until(async () => (await chats()).find((chat) => chat.id === oauth)?.status === "running", "the background chat to start", 30);
  // Read while it runs, so a reload of the page in between shows up as such rather than as silence.
  const heard: string[] = [];
  await until(async () => { heard.push(...(await said()).filter((text) => !heard.includes(text))); return heard.some((text) => text.includes("Fix the OAuth callback finished")); },
    "the background chat to be announced", 300).catch(() => {});
  notes.backgroundSaid = heard;
  check("backgroundChatAnnounced", heard.some((text) => text.includes("Fix the OAuth callback finished")) && !heard.some((text) => text.includes("Auth tokens rotation finished")));

  // --- 4. Search ranking ---------------------------------------------------------------------------------------
  const order = (await chats()).map((chat) => chat.title);
  await key("k", CTRL);
  await until(() => evaluate(`Boolean(document.querySelector('[cmdk-input]'))`), "the search dialog", 10);
  await evaluate(`(() => { const input = document.querySelector('[cmdk-input]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'auth');
    input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(800);
  const hits = await evaluate(`[...([...document.querySelectorAll('[cmdk-group]')].find((group) => group.querySelector('[cmdk-group-heading]')?.textContent.trim() === 'Chats')
    ?.querySelectorAll('[cmdk-item]') ?? [])].map((item) => item.textContent.trim())`) as string[];
  notes.search = { recencyOrder: order, hits };
  check("searchRanksWordStart", order.indexOf("Fix the OAuth callback") < order.indexOf("Auth tokens rotation")
    && hits[0]?.startsWith("Auth tokens rotation") === true && hits.some((hit) => hit.startsWith("Fix the OAuth callback")));
  await shot("search.png");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  // --- 6 and 7. Usage --------------------------------------------------------------------------------------------
  const app = await new CodexAppServer().start();
  let raw: string | undefined;
  try { raw = (await app.request<{ account?: { planType?: string | null } | null }>("account/read", { refreshToken: false })).account?.planType ?? undefined; } finally { app.close(); }
  const failure = "Your access token could not be refreshed. Please sign out and sign in again.";
  await call("usage:report", { token, engine: "codex", unread: { at: Date.now(), message: failure } });
  await send("Page.navigate", { url: `${BASE}/settings/usage` });
  await until(() => evaluate(`Boolean(document.querySelector('li[aria-label="Codex plan"]'))`), "the Usage page", 30);
  const row = () => evaluate(`(() => { const row = document.querySelector('li[aria-label="Codex plan"]');
    return { text: row?.innerText ?? '', signIn: Boolean([...(row?.querySelectorAll('a') ?? [])].find((a) => a.textContent.trim() === 'sign in again' && a.getAttribute('href') === '/settings/engines')) }; })()`) as Promise<{ text: string; signIn: boolean }>;
  await until(async () => /Couldn(?:'|’)t read Codex(?:'|’)s limits/.test((await row()).text), "the failed read on Usage", 20).catch(() => {});
  const failed = await row();
  notes.usageFailed = failed.text;
  check("failedReadShown", failed.text.includes(failure) && failed.signIn && !failed.text.includes("Waiting for Codex"));
  await shot("usage-failed-read.png");
  await call("usage:requestRefresh", { key: KEY });
  await until(async () => !(await row()).text.includes(failure), "a successful read to clear it", 90).catch(() => {});
  const recovered = await row();
  notes.usageRecovered = recovered.text;
  check("failedReadClearsOnSuccess", !recovered.text.includes(failure));
  const shown = (await call<{ engines: Array<{ kind: string; plan?: string }> }>("usage:overview", { key: KEY })).engines.find((engine) => engine.kind === "codex")?.plan;
  notes.plan = { raw, shown };
  const current: Record<string, string> = { pro: "Pro 200", prolite: "Pro 100", promax: "Pro 500", self_serve_business_prolite: "Business Premium", team: "Business" };
  check("planNamedAsChatGPTDoes", Boolean(shown) && !shown!.includes("_") && (raw && raw in current ? shown === current[raw] : shown === raw));
  await shot("usage.png");

  notes.pageErrors = errors;
  check("noPageErrors", errors.length === 0);
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
}

process.exit(await p.finish() ? 0 : 1);
