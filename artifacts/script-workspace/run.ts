import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/script-workspace/run.ts <outDir>
// The script workspace (issue #159): each script a folder in Perry's files,
// files/scripts/<channel>/<slug>/, with v1.md, v2.md, … and notes.md; the
// tools save_script, list_scripts, read_script and update_script; and the Work
// page's Scripts tab. The tools are driven as Codex drives them, over Perry's
// MCP endpoint with the runner's token while a turn of a web chat is running;
// this script plays that runner, so no Codex usage is spent. A real Codex turn
// (PERRY_E2E_MODEL, by default gpt-6-luna) runs only with PERRY_E2E_REAL=1.
// The real server from the production build, and a fresh PERRY_HOME under
// PERRY_TEST_DIR (the system temp folder by default).
//
// Ways it could fail, written down before the checks:
//   1. Codex is not handed the script tools at all.
//   2. The first save does not make the folder, v1.md and notes.md where the issue says.
//   3. A revision overwrites a version, or numbers it wrong.
//   4. Feedback lands under the wrong version (it is about the one before the revision).
//   5. Hooks, sources or cuts are lost, or put under the wrong version.
//   6. After two revisions list_scripts does not show 3 versions.
//   7. read_script returns the wrong text for a version, or not that version's notes.
//   8. The status does not change, or "final" does not narrow list_scripts to it.
//   9. A slug or channel with "..", slashes or an absolute path writes or reads outside the scripts folder.
//  10. The same slug in two channels is read from the wrong one.
//  11. A hand edit to the files is not what Perry and the page see (a copy kept elsewhere wins).
//  12. The Work page does not list the script with its latest version, count, status and channel.
//  13. Opening it does not show each version with its notes.
//  14. The page, left open, does not show a version Perry saves meanwhile.
//  15. The owner's status change on the page does not reach the files.
//  16. (Real turn) Asked to change a script, Perry does not save a new version by himself.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/script-workspace/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "script-workspace-e2e-key";
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const REAL = process.env.PERRY_E2E_REAL === "1";
const testDir = process.env.PERRY_TEST_DIR ?? tmpdir();
mkdirSync(testDir, { recursive: true });
const home = mkdtempSync(join(testDir, "perry-script-workspace-"));
const scriptsDir = join(home, "files", "scripts");
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

// --- Perry -------------------------------------------------------------------------------

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name.startsWith("TELEGRAM") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const logs = { server: "", runner: "" };
const children: ChildProcess[] = [];
function start(name: "server" | "runner"): ChildProcess {
  const [command, args]: [string, string[]] = name === "server"
    ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)]]
    : [process.execPath, [join(REPO, "runner", "index.ts")]];
  const child = spawn(command, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
  children.push(child);
  return child;
}
async function call<T>(path: string, args: object = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }) });
  const body = await response.json() as { value?: T; error?: string };
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body.value as T;
}
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

// --- Perry's tools, as Codex calls them ----------------------------------------------------

let token = "";
let rpcId = 0;
async function mcp(method: string, params: object = {}): Promise<Record<string, any>> {
  const response = await fetch(`${BASE}/api/backend/http/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await response.json() as { result?: Record<string, any>; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result!;
}
/** A tool's answer, as Codex reads it. */
async function tool<T = Record<string, any>>(name: string, args: object): Promise<T> {
  const result = await mcp("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "null";
  if (result.isError) return { error: text } as T;
  return JSON.parse(text) as T;
}
/** Every folder and file under Perry's home, to see nothing was written where it should not be. */
const everything = (dir = home): string[] => readdirSync(dir, { recursive: true }) as string[];
const onDisk = (...path: string[]) => readFileSync(join(scriptsDir, ...path), "utf8");

const V1 = "Amazon will take back almost anything you bought.\n\nBut what happens to it after that? It goes to a warehouse called Boomerang.";
const V2 = "You returned it. Amazon sold it again, the same week.\n\nThat is Boomerang: the warehouse where returns get a second life.";
const V3 = "That phone you returned? Someone else is unboxing it right now.\n\nWelcome to Boomerang, Amazon's warehouse for second chances.";
const V4 = "That phone you returned? It is already in someone else's hands.\n\nThis is Boomerang.";

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
let turn: { _id: string } | null = null;
try {
  start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // This computer's runner, played here: online, with Codex signed in, so a web chat's turn goes to it.
  await until(() => existsSync(join(home, "runner.json")), "the server to pair this computer", 30);
  token = (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string }).token;
  await call("runner:checkIn", { token, platform: platform(), hostname: hostname(), workdir: home });
  await call("engines:report", { token, engines: [{
    kind: "codex", installed: true, version: "0.0.0-e2e", signedIn: true, auth: { type: "chatgpt", label: "ChatGPT" },
    models: [{ id: MODEL, name: MODEL, isDefault: true, efforts: ["low"], defaultEffort: "low" }],
  }] });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:sendChat", { key: KEY, id: chat, text: "Write me a 30-second script on Amazon's Boomerang warehouse for Tech Talks." });
  let queued: Array<{ _id: string; conversationId: string }> = [];
  await until(async () => { queued = await call("codex:queuedTurns", { token }); return queued.some((item) => item.conversationId === chat); }, "the chat's turn to queue");
  turn = await call<{ _id: string } | null>("codex:claimTurn", { token, id: queued.find((item) => item.conversationId === chat)!._id });
  if (!turn) throw new Error("could not claim the turn");

  // --- 1. Codex is handed the tools ------------------------------------------------------------
  const listed: string[] = (await mcp("tools/list")).tools.map((item: { name: string }) => item.name);
  check("toolsHandedToCodex", ["save_script", "list_scripts", "read_script", "update_script"].every((name) => listed.includes(name)), listed.filter((name) => name.includes("script")));

  // --- 2. The first save -------------------------------------------------------------------------
  const first = await tool("save_script", {
    title: "Amazon Boomerang", channel: "Tech Talks", text: V1,
    hook: "Amazon will take back almost anything you bought.", changed: "First draft.",
    hooks: ["Where do your Amazon returns go?", "Amazon has a secret warehouse for your returns."],
    sources: ["https://www.aboutamazon.com/news/operations/amazon-returns (how returns are resold)"],
  });
  const folder = join("tech-talks", "amazon-boomerang");
  check("firstSaveMakesTheFolder", first.saved === true && first.version === 1 && first.slug === "amazon-boomerang" && first.channel === "tech-talks"
    && onDisk(folder, "v1.md") === `${V1}\n` && /^# Amazon Boomerang$/m.test(onDisk(folder, "notes.md")) && /^Status: draft$/m.test(onDisk(folder, "notes.md")),
    { result: first, files: readdirSync(join(scriptsDir, folder)) });

  // --- 3-5. Two revisions, each answering the owner's feedback on the one before -----------------
  const second = await tool("save_script", {
    slug: "amazon-boomerang", text: V2, hook: "You returned it. Amazon sold it again, the same week.",
    changed: "Opens on the resale instead of the warehouse.", feedback: ["The hook is too slow; open on the surprise."],
    hooks: ["Your return was resold before your refund landed."],
    cuts: [{ claim: "Boomerang handles 40% of all returns", why: "No source gives that number." }],
  });
  const third = await tool("save_script", {
    slug: "amazon-boomerang", text: V3, hook: "That phone you returned? Someone else is unboxing it right now.",
    changed: "A concrete object in the hook.", feedback: ["Better, but make it about one thing people return."],
    hooks: ["Your old headphones have a new owner."],
    sources: ["https://www.theverge.com/amazon-returns-resale (resale timing)"],
  });
  const notesMd = onDisk(folder, "notes.md");
  const section = (version: number) => notesMd.split(/^(?=## v\d+)/m).find((part) => part.startsWith(`## v${version} `)) ?? "";
  check("revisionsAreNewVersions", second.version === 2 && third.version === 3 && onDisk(folder, "v1.md") === `${V1}\n` && onDisk(folder, "v2.md") === `${V2}\n` && onDisk(folder, "v3.md") === `${V3}\n`,
    { second, third });
  check("feedbackUnderTheVersionItIsAbout", section(1).includes("The hook is too slow") && section(2).includes("one thing people return")
    && !section(2).includes("too slow") && !section(3).includes("### Feedback"), { v1: section(1), v2: section(2), v3: section(3) });
  check("hooksSourcesCutsKept", section(1).includes("secret warehouse") && section(1).includes("aboutamazon.com")
    && section(2).includes("### Cut") && section(2).includes("40% of all returns") && section(2).includes("No source gives that number")
    && section(3).includes("new owner") && section(3).includes("theverge.com") && section(3).includes("Hook: That phone you returned?"), notesMd);
  writeFileSync(join(outDir, "notes.md"), notesMd);

  // --- 6. list_scripts ---------------------------------------------------------------------------
  const listing = await tool<{ count: number; scripts: Array<Record<string, any>> }>("list_scripts", {});
  const listedScript = listing.scripts.find((item) => item.slug === "amazon-boomerang");
  check("listShowsThreeVersions", listedScript?.versions === 3 && listedScript.channel === "Tech Talks" && listedScript.status === "draft" && /Someone else is unboxing/.test(listedScript.hook ?? ""), listing);

  // --- 7. read_script, any version, with its notes -----------------------------------------------
  const reads = await Promise.all([1, 2, 3].map((version) => tool("read_script", { slug: "amazon-boomerang", version })));
  const latest = await tool("read_script", { slug: "amazon-boomerang" });
  check("readAnyVersionWithItsNotes",
    reads.every((read, index) => read.version === index + 1 && read.text === `${[V1, V2, V3][index]}\n` && read.versions === 3)
    && reads[0].notes.includes("secret warehouse") && reads[0].notes.includes("too slow") && !reads[0].notes.includes("40%")
    && reads[1].notes.includes("40% of all returns") && reads[2].notes.includes("new owner")
    && latest.version === 3 && latest.text === `${V3}\n` && latest.notes.includes("## v1") && latest.notes.includes("## v3"),
    { v1: reads[0], latest: { version: latest.version, notesLength: latest.notes?.length } });

  // --- 8. Notes on a saved version, and the status ------------------------------------------------
  const cut = await tool("update_script", { slug: "amazon-boomerang", cuts: [{ claim: "Resold within 24 hours", why: "The Verge says within a week." }], feedback: ["Love it, lock it."] });
  const final = await tool("update_script", { slug: "amazon-boomerang", status: "final" });
  const finals = await tool<{ scripts: Array<{ slug: string }> }>("list_scripts", { status: "final" });
  const drafts = await tool<{ scripts: Array<{ slug: string }> }>("list_scripts", { status: "draft" });
  const afterStatus = onDisk(folder, "notes.md");
  check("statusChanges", cut.updated === true && cut.version === 3 && final.status === "final" && /^Status: final$/m.test(afterStatus)
    && finals.scripts.map((item) => item.slug).join() === "amazon-boomerang" && !drafts.scripts.some((item) => item.slug === "amazon-boomerang")
    && afterStatus.split(/^(?=## v\d+)/m).find((part) => part.startsWith("## v3 "))!.includes("Resold within 24 hours"),
    { cut, final, finals });

  // --- 9. Paths stay inside the scripts folder -----------------------------------------------------
  const before = new Set(everything());
  const attempts = await Promise.all([
    tool("save_script", { title: "Escape", channel: "../../..", text: "x" }),
    tool("save_script", { title: "Escape", channel: "Tech Talks", slug: "..\\..\\..\\runner", text: "x" }),
    tool("save_script", { title: "Escape", channel: "C:\\Windows", text: "x" }),
    tool("read_script", { slug: "../../runner.json" }),
    tool("read_script", { slug: "amazon-boomerang", channel: "../scripts/tech-talks" }),
    tool("update_script", { slug: "../../../files", status: "shot" }),
  ]);
  const added = everything().filter((path) => !before.has(path));
  check("pathsGuarded", attempts.every((answer) => typeof answer.error === "string" && !answer.saved && !answer.text) && added.length === 0,
    { errors: attempts.map((answer) => answer.error), added });

  // --- 10. The same slug in two channels --------------------------------------------------------------
  const telugu = await tool("save_script", { title: "Amazon Boomerang", channel: "Tech Telugu", text: "Telugu version.", hook: "Telugu hook" });
  const ambiguous = await tool("read_script", { slug: "amazon-boomerang" });
  const pickedTelugu = await tool("read_script", { slug: "amazon-boomerang", channel: "Tech Telugu" });
  const pickedTalks = await tool("read_script", { slug: "amazon-boomerang", channel: "Tech Talks" });
  check("sameSlugTwoChannels", telugu.saved === true && telugu.channel === "tech-telugu" && typeof telugu.note === "string"
    && /more than one channel/.test(ambiguous.error ?? "") && pickedTelugu.text === "Telugu version.\n" && pickedTalks.version === 3,
    { telugu, ambiguous: ambiguous.error });

  // --- 11. The files are the truth -----------------------------------------------------------------
  writeFileSync(join(scriptsDir, "tech-telugu", "amazon-boomerang", "notes.md"), onDisk("tech-telugu", "amazon-boomerang", "notes.md").replace("Status: draft", "Status: shot"));
  const handEdited = await tool<{ scripts: Array<{ channel: string; status: string }> }>("list_scripts", { channel: "Tech Telugu" });
  check("handEditsAreWhatPerrySees", handEdited.scripts[0]?.status === "shot", handEdited);

  // --- 12-15. The Work page --------------------------------------------------------------------------
  browser = await openChat(BASE, KEY);
  const { evaluate, send } = browser;
  const shot = async (name: string) => {
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  const text = async (selector = "body") => String(await evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`));
  await send("Page.navigate", { url: `${BASE}/work?tab=scripts` });
  await until(async () => (await text()).includes("Amazon Boomerang") && (await text()).includes("v3 · 3 versions"), "the Scripts tab to list the script", 30).catch(() => {});
  const page = await text("main");
  await shot("work-scripts.png");
  check("workPageLists", page.includes("Amazon Boomerang") && page.includes("Tech Talks") && page.includes("v3 · 3 versions") && page.includes("Final")
    && page.includes("Tech Telugu") && page.includes("Shot") && page.includes("Someone else is unboxing"), page.slice(0, 900));

  await send("Page.navigate", { url: `${BASE}/work?tab=scripts&script=tech-talks/amazon-boomerang` });
  await until(async () => (await text('[role="dialog"]')).includes("Notes on v3"), "the script to open", 30).catch(() => {});
  const openedLatest = await text('[role="dialog"]');
  await shot("script-latest.png");
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.innerText.trim() === "v1").click(); true`);
  await until(async () => (await text('[role="dialog"]')).includes("Notes on v1"), "v1 to show", 15).catch(() => {});
  const openedFirst = await text('[role="dialog"]');
  await shot("script-v1.png");
  check("openShowsEachVersionWithNotes", openedLatest.includes("Someone else is unboxing") && openedLatest.includes("v3 (latest)") && openedLatest.includes("Resold within 24 hours")
    && openedFirst.includes("take back almost anything") && openedFirst.includes("secret warehouse") && openedFirst.includes("The hook is too slow") && !openedFirst.includes("Resold within 24 hours"),
    { latest: openedLatest.slice(0, 600), first: openedFirst.slice(0, 600) });

  // Perry saves a fourth version while the page is open.
  const fourth = await tool("save_script", { slug: "amazon-boomerang", channel: "Tech Talks", text: V4, hook: "That phone you returned? It is already in someone else's hands.", feedback: ["Shorter."] });
  await until(async () => (await text('[role="dialog"]')).includes("v4"), "the new version to show without a reload", 15).catch(() => {});
  const live = await text('[role="dialog"]');
  await shot("script-live-v4.png");
  check("pageShowsANewVersionAsItIsSaved", fourth.version === 4 && fourth.status === "draft" && live.includes("v4") && live.includes("4 versions"), live.slice(0, 400));

  // The owner marks it shot from the page.
  await evaluate(`[...document.querySelectorAll('[role="dialog"] [aria-label="Status"] button')].find((button) => button.innerText.trim() === "Shot").click(); true`);
  await until(() => /^Status: shot$/m.test(onDisk(folder, "notes.md")), "the page's status change to reach the files", 15).catch(() => {});
  check("ownersStatusChangeReachesTheFiles", /^Status: shot$/m.test(onDisk(folder, "notes.md")), onDisk(folder, "notes.md").split("\n").slice(0, 5));
  await evaluate(`(() => { const dialog = document.querySelector('[role="dialog"]'); dialog.scrollTop = dialog.scrollHeight; return true; })()`);
  await sleep(500);
  await shot("script-marked-shot.png");
  check("dashboardThrewNothing", browser.errors.length === 0, browser.errors);

  await call("codex:finishTurn", { token, id: turn._id, response: "Saved.", model: `codex/${MODEL}` }).catch(() => {});
  turn = null;

  // --- 16. A real Codex turn ---------------------------------------------------------------------------
  if (!REAL) {
    notes.realTurn = "not run: the owner's ChatGPT Codex weekly limit is used up until 4 Oct 2026, 03:01. Run again with PERRY_E2E_REAL=1.";
  } else {
    start("runner");
    await until(async () => (await call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner", 120);
    const real = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id: real, model: MODEL });
    const ask = async (words: string) => {
      await call("dashboard:sendChat", { key: KEY, id: real, text: words });
      await until(async () => (await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: real })).isRunning, "the turn to start", 60).catch(() => {});
      await until(async () => !(await call<{ isRunning: boolean }>("dashboard:getChat", { key: KEY, id: real })).isRunning, "the turn to finish", 300);
    };
    const versionsOf = () => existsSync(join(scriptsDir, "tech-talks")) ? readdirSync(join(scriptsDir, "tech-talks")).filter((slug) => slug.includes("fridge")).flatMap((slug) => readdirSync(join(scriptsDir, "tech-talks", slug)).filter((name) => /^v\d+\.md$/.test(name))) : [];
    await ask("Write a 20-second script for Tech Talks on why quantum computers need fridges colder than space.");
    const afterFirst = versionsOf().length;
    await ask("The hook is boring. Give me a punchier one.");
    check("realTurnSavesARevisionUnasked", afterFirst >= 1 && versionsOf().length > afterFirst, { afterFirst, afterRevision: versionsOf() });
  }
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
}

if (turn) await call("codex:finishTurn", { token, id: turn._id, response: "Stopped.", model: `codex/${MODEL}` }).catch(() => {});
browser?.close();
for (const child of children.reverse()) if (child.pid) process.platform === "win32" ? spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }) : child.kill("SIGTERM");
await sleep(3_000);
notes.serverErrors = logs.server.split("\n").filter((line) => /error|failed/i.test(line)).slice(-20);
if (REAL) notes.runnerLog = logs.runner.split("\n").filter(Boolean).slice(-30);
try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
const passed = Object.values(checks).every(Boolean);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), model: MODEL, realTurn: REAL, checks, notes, passed }, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(passed ? 0 : 1);
