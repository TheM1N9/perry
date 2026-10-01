import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChat, sleep } from "../browser";

// bun artifacts/skills-page/run.ts <outDir>
// Issue #156: the Skills page (every skill in Perry's skills folder, where it
// came from, its SKILL.md, removing one), and "$name" in a message using one.
// A fresh PERRY_HOME and port, the production build (`pnpm build` first), the
// real runner with this machine's real Codex, the fake Grok agent
// (artifacts/engine-acp/fake-agent.ts) for an engine without skill input, and
// a stand-in Telegram. What reaches Codex is read from the session file Codex
// writes (~/.codex/sessions), which records the turn's input and what Codex put
// in front of the model before any model call, so it holds even when the
// account is out of quota. PERRY_E2E_MODEL picks the Codex model (gpt-6-luna).
//
// Ways it could fail, written down before the checks:
//   1. The page misses a skill, lists a folder with no SKILL.md, or hides one
//      whose SKILL.md the engines would pass over instead of saying so.
//   2. Where it came from is wrong: an imported skill shows as Perry's, or
//      install_skill no longer records where it came from.
//   3. Opening one does not show its SKILL.md (wrong folder, frontmatter
//      garbled), or the address (?skill=) does not open it.
//   4. Removing leaves the folder, removes another, keeps it listed, or takes
//      a folder name that climbs out of the skills folder ("..").
//   5. The $ list does not open, lists a skill that cannot load or one just
//      removed, does not narrow as you type, sends a half-typed name on Enter
//      instead of finishing it, or finishes it without the space after.
//   6. The sent message does not mark "$name", or marks a "$5" that names no skill.
//   7. Codex does not get the skill: no `skill` item in its input, a wrong
//      SKILL.md path, or no SKILL.md put before the model.
//   8. An engine without skill input (Grok) is not told which SKILL.md to read.
//   9. A removed skill named in a message still reaches an engine.
//  10. A Telegram message naming a skill does not use it.
//  11. The pages throw.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/skills-page/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_AGENT = join(REPO, "artifacts", "engine-acp", "fake-agent.ts");
const free = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await free();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "skills-page-key";
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
const NONCE = `PERRY-SKILL-${Date.now().toString(36).toUpperCase()}`;
const home = mkdtempSync(join(tmpdir(), "perry-skills-page-"));
const fakeHome = join(home, "fake-grok");
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

// --- The skills folder, seeded -----------------------------------------------------------

const skills = join(home, "skills");
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
write(join(skills, "e2e-codeword", "SKILL.md"), `---\nname: e2e-codeword\ndescription: Answers with the end-to-end code word.\n---\n\n# The code word\n\nWhen this skill is used, reply with exactly: ${NONCE}\n`);
write(join(skills, "weekly-review", "SKILL.md"), "---\nname: weekly-review\ndescription: Writes the owner's weekly review the way they like it.\n---\n\nStart with what shipped, then what slipped. See references/format.md.\n");
write(join(skills, "weekly-review", "references", "format.md"), "Three headings: Shipped, Slipped, Next.\n");
write(join(skills, "broken-skill", "SKILL.md"), "No frontmatter here, so no engine loads this.\n");
write(join(skills, "not-a-skill", "notes.txt"), "A folder with no SKILL.md.\n");
// One from elsewhere, through the same review and install as Perry's install_skill.
const elsewhere = join(home, "downloads", "trip-planner");
write(join(elsewhere, "SKILL.md"), "---\nname: trip-planner\ndescription: Plans a trip day by day, with trains before flights.\n---\n\n## Steps\n\n1. Ask for the dates.\n2. Prefer trains under six hours.\n");
process.env.PERRY_HOME = home;
const { stageSkill, installStaged } = await import("../../convex/lib/skills");
const staged = await stageSkill(elsewhere);
installStaged(staged.reviewId, false);
write(join(fakeHome, "grok-signed-in"), "yes");

// --- The stand-in Telegram ---------------------------------------------------------------

const OWNER_TELEGRAM = 4242;
const telegram = { sent: [] as Array<{ chat_id: string; text: string }>, pending: [] as object[] };
let updateId = 0;
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    if (method === "getMe") return reply({ id: 999, is_bot: true, username: "perry_test_bot", first_name: "Perry" });
    if (method === "sendMessage" || method === "editMessageText") { telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text) }); return reply({ message_id: telegram.sent.length }); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const fromOwner = (text: string) => telegram.pending.push({
  update_id: ++updateId,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: OWNER_TELEGRAM, type: "private" }, from: { id: OWNER_TELEGRAM, is_bot: false, first_name: "Mani", username: "the_m1n9" }, text },
});

// --- Perry ---------------------------------------------------------------------------------

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production",
  TELEGRAM_BOT_TOKEN: "123456:skills-page",
  TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
  PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`,
  FAKE_ACP_HOME: fakeHome,
};
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
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
type Row = Record<string, any> & { _id: string };
/** A table of the test Perry's SQLite, read in another process as the server writes it (Bun has no node:sqlite). */
function table(name: string): Row[] {
  const script = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); db.exec("PRAGMA busy_timeout = 5000");
process.stdout.write(JSON.stringify(db.prepare('SELECT _id, doc FROM "doc_' + process.argv[2] + '"').all()));`;
  const ran = spawnSync("node", ["-e", script, join(home, "perry.sqlite"), name], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (ran.status !== 0) throw new Error(`sqlite: ${ran.stderr}`);
  return (JSON.parse(ran.stdout || "[]") as Array<{ _id: string; doc: string }>).map((row) => ({ _id: row._id, ...JSON.parse(row.doc) }));
}
type Computer = { online: boolean; engines: Array<{ kind: string; installed: boolean; signedIn: boolean }> };
const computers = () => call<Computer[]>("engines:list", { key: KEY });
const turnsOf = (chat: string) => table("codexTurns").filter((turn) => turn.conversationId === chat).sort((a, b) => a.createdAt - b.createdAt);
/** A chat's turn has come and gone: the runner took it and it ended, well or not. */
const settled = (chat: string) => { const turns = turnsOf(chat); return turns.length > 0 && turns.every((turn) => turn.status !== "queued" && turn.status !== "running"); };
/** The session file Codex wrote for a thread, as JSON lines. */
function codexSession(thread: string): Array<Record<string, any>> {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const find = (dir: string, depth: number): string | null => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (entry.isFile() && entry.name.endsWith(`${thread}.jsonl`)) return join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) { const found = find(join(dir, entry.name), depth + 1); if (found) return found; }
    }
    return null;
  };
  const file = find(root, 0);
  return file ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
/** What a Codex thread's input held, and what Codex put before the model from a skill. */
function whatCodexGot(thread: string) {
  const lines = codexSession(thread);
  const input = lines.filter((line) => line.type === "event_msg" && line.payload?.item?.type === "UserMessage").flatMap((line) => line.payload.item.content as Array<Record<string, string>>);
  const injected = lines.filter((line) => line.type === "response_item" && line.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes("skills.selected_skill_instructions"))
    .map((line) => line.payload.content.map((part: { text: string }) => part.text).join(""));
  return { found: lines.length > 0, skillItems: input.filter((part) => part.type === "skill"), text: input.filter((part) => part.type === "text").map((part) => part.text), injected };
}

let browser: Awaited<ReturnType<typeof openChat>> | null = null;
const shot = async (name: string) => {
  const image = await browser!.send("Page.captureScreenshot", { format: "png" }) as { data: string };
  writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
};
const page = <T = any>(expression: string) => browser!.evaluate(expression) as Promise<T>;

try {
  start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  fromOwner(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "Telegram to be paired", 30);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)
    && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner, with Codex and the fake Grok signed in", 150);

  // --- 1, 2. The Skills page lists them, with where each came from ----------------------------
  browser = await openChat(BASE, KEY);
  await browser.send("Page.navigate", { url: `${BASE}/apps/skills` });
  await until(() => page<boolean>(`document.querySelectorAll('li[data-skill]').length > 0`), "the Skills page to list skills", 30);
  const rows = await page<Array<{ name: string; text: string }>>(`[...document.querySelectorAll('li[data-skill]')].map((row) => ({ name: row.dataset.skill, text: row.innerText }))`);
  await shot("skills-page.png");
  const row = (name: string) => rows.find((item) => item.name === name)?.text ?? "";
  check("pageListsEverySkill", rows.map((item) => item.name).join(",") === "broken-skill,e2e-codeword,trip-planner,weekly-review", rows.map((item) => item.name));
  check("pageSaysWhereEachCameFrom",
    row("trip-planner").includes(`Imported from ${elsewhere}`) && row("trip-planner").includes("Plans a trip day by day")
    && row("e2e-codeword").includes("Written by Perry") && row("weekly-review").includes("Written by Perry"), rows);
  check("pageFlagsOneThatCannotLoad", /Not loaded/.test(row("broken-skill")) && /names no skill/.test(row("broken-skill")), row("broken-skill"));

  // --- 3. Opening one shows its SKILL.md, and the address opens it --------------------------------
  await page(`[...document.querySelectorAll('li[data-skill="trip-planner"] button')].find((button) => !/Remove/.test(button.textContent)).click(), true`);
  await until(() => page<boolean>(`Boolean(document.querySelector('[data-skill-md]')?.innerText.includes('Prefer trains'))`), "trip-planner's SKILL.md", 20);
  const opened = await page<{ url: string; text: string; yaml: string }>(`({ url: location.search, text: document.querySelector('[data-skill-read]').innerText, yaml: document.querySelector('[data-skill-md] pre')?.innerText ?? '' })`);
  await shot("skill-open.png");
  check("openShowsSkillMd", opened.url === "?skill=trip-planner" && opened.text.includes("Ask for the dates.") && opened.text.includes(`Imported from ${elsewhere}`)
    && opened.yaml.includes("name: trip-planner") && opened.text.includes(join(skills, "trip-planner", "SKILL.md")), opened);
  await browser.send("Page.navigate", { url: `${BASE}/apps/skills?skill=weekly-review` });
  await until(() => page<boolean>(`Boolean(document.querySelector('[data-skill-md]')?.innerText.includes('what shipped'))`), "weekly-review from the address", 30);
  const linked = await page<string>(`document.querySelector('[data-skill-read]').innerText`);
  check("addressOpensSkill", linked.includes("references/format.md"), linked.slice(0, 400));

  // --- 4. Removing one ------------------------------------------------------------------------------
  await page(`[...document.querySelectorAll('[role=dialog] button')].find((button) => button.textContent.trim() === 'Remove').click(), true`);
  await until(() => page<boolean>(`Boolean(document.querySelector('[role=alertdialog]'))`), "the question before removing", 10);
  const asked = await page<string>(`document.querySelector('[role=alertdialog]').innerText`);
  await page(`[...document.querySelectorAll('[role=alertdialog] button')].find((button) => button.textContent.trim() === 'Remove').click(), true`);
  await until(() => page<boolean>(`!document.querySelector('li[data-skill="weekly-review"]') && document.querySelectorAll('li[data-skill]').length === 3`), "weekly-review to leave the list", 20);
  const climbed = await Promise.all(["..", "../skills", ".perry-source.json", "not-a-skill"].map((folder) => call("skills:remove", { key: KEY, folder }).then(() => `${folder}: removed`, (error) => `${folder}: ${String(error).slice(0, 80)}`)));
  check("removeDeletesOnlyThatSkill", /Remove weekly-review\?/.test(asked) && !existsSync(join(skills, "weekly-review"))
    && ["e2e-codeword", "trip-planner", "broken-skill", "not-a-skill"].every((folder) => existsSync(join(skills, folder))) && climbed.every((line) => !line.endsWith("removed")),
    { asked, refused: climbed, left: readdirSync(skills) });

  // --- 5. $ in the composer --------------------------------------------------------------------------
  await browser.send("Page.navigate", { url: `${BASE}/chat` });
  await until(() => page<boolean>(`Boolean(document.querySelector('#composer'))`), "the composer", 30);
  await sleep(1_500);
  const type = (text: string) => page(`(() => {
    const box = document.querySelector('#composer');
    box.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const listed = async () => { await sleep(700); return page<{ label: string | null; items: string[] }>(`({ label: document.querySelector('#chat-commands')?.getAttribute('aria-label') ?? null, items: [...document.querySelectorAll('#chat-commands [role=option] span:first-child')].map((item) => item.textContent) })`); };
  const enter = async () => { await page(`document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })), true`); await sleep(600); return page<string>(`document.querySelector('#composer').value`); };
  // The model first, as a command, so the turn runs where the test says.
  await type(`/model codex/${MODEL}`);
  await enter();
  await type("$");
  const all = await listed();
  await shot("skills-picker.png");
  await type("Please $e2e");
  const narrowed = await listed();
  const finished = await enter();
  const sentEarly = await page<number>(`document.querySelectorAll('[data-role=user]').length`);
  check("dollarListsSkills", all.label === "Skills" && all.items.join(",") === "$e2e-codeword,$trip-planner" && narrowed.items.join(",") === "$e2e-codeword", { all, narrowed });
  check("enterFinishesTheName", finished === "Please $e2e-codeword " && sentEarly === 0, { finished, sentEarly });
  await type(`${finished}and tell me the code word. It costs $5.`);
  await page(`document.querySelector('[aria-label="Send message"]').click(), true`);
  await until(() => page<boolean>(`Boolean(document.querySelector('[data-role=user] [data-skill-mention]'))`), "the sent message", 30);
  await sleep(1_000);
  const bubble = await page<{ mentions: string[]; text: string; href: string | null }>(`(() => { const row = [...document.querySelectorAll('[data-role=user]')].at(-1); return { mentions: [...row.querySelectorAll('[data-skill-mention]')].map((item) => item.dataset.skillMention), text: row.innerText, href: row.querySelector('[data-skill-mention]')?.getAttribute('href') ?? null }; })()`);
  await shot("chat-sent.png");
  check("sentMessageMarksTheSkill", bubble.mentions.join(",") === "e2e-codeword" && bubble.text.includes("It costs $5.") && bubble.href === "/apps/skills?skill=e2e-codeword", bubble);

  // --- 7. What reached Codex --------------------------------------------------------------------------
  const webChat = await page<string>(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
  await until(() => settled(webChat), "the Codex turn to end", 240);
  const webConversation = table("conversations").find((item) => item._id === webChat)!;
  const webThread = webConversation.resume?.cursor ?? webConversation.codexThreadId;
  const webTurn = turnsOf(webChat).at(-1)!;
  const got = whatCodexGot(webThread);
  const skillPath = join(skills, "e2e-codeword", "SKILL.md");
  check("codexGetsTheSkillItem", got.skillItems.length === 1 && got.skillItems[0].name === "e2e-codeword" && got.skillItems[0].path === skillPath
    && got.text.some((text) => text.includes("$e2e-codeword and tell me")), { thread: webThread, skillItems: got.skillItems, text: got.text.map((text) => text.slice(0, 200)) });
  check("codexPutsSkillMdBeforeTheModel", got.injected.length === 1 && got.injected[0].includes("<name>e2e-codeword</name>") && got.injected[0].includes(NONCE),
    { injected: got.injected.map((text) => text.slice(0, 400)) });
  notes.codexTurn = { model: webTurn.requestedModel, status: webTurn.status, error: webTurn.error?.slice(0, 300), reply: webTurn.response?.slice(0, 200) };
  // With quota, the model answers from the skill; without it (a usage limit), the turn fails after Codex took the skill in.
  if (webTurn.response && !webTurn.error) check("codexAnswersFromTheSkill", webTurn.response.includes(NONCE), webTurn.response.slice(0, 200));

  // --- 8, 9. An engine without skill input: told where the SKILL.md is; a removed one is not named ------
  const grokChat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: grokChat, model: "grok-fake-fast", engine: "grok" });
  await call("dashboard:sendChat", { key: KEY, id: grokChat, text: "Use $trip-planner for Goa, and $weekly-review after." });
  await until(() => settled(grokChat), "the Grok turn to end", 120);
  const prompts = existsSync(join(fakeHome, "log.jsonl")) ? readFileSync(join(fakeHome, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => typeof entry.prompt === "string") : [];
  const grokPrompt: string = prompts.at(-1)?.prompt ?? "";
  check("otherEnginesAreToldWhichSkillMd", grokPrompt.startsWith("Use $trip-planner for Goa") && grokPrompt.includes("read its SKILL.md") && grokPrompt.includes(`$trip-planner: ${join(skills, "trip-planner", "SKILL.md")}`), grokPrompt);
  check("removedSkillReachesNoEngine", !grokPrompt.includes(join(skills, "weekly-review")) && !grokPrompt.includes("$weekly-review:"), grokPrompt);

  // --- 10. Telegram ----------------------------------------------------------------------------------------
  fromOwner("$e2e-codeword from Telegram, please.");
  let telegramChat = "";
  await until(() => { telegramChat = table("conversations").find((item) => item.channel === "telegram" && item.externalId === String(OWNER_TELEGRAM))?._id ?? ""; return Boolean(telegramChat) && turnsOf(telegramChat).length > 0; }, "the Telegram message to become a turn", 60);
  await until(() => settled(telegramChat), "the Telegram turn to end", 240);
  const telegramConversation = table("conversations").find((item) => item._id === telegramChat)!;
  const fromTelegram = whatCodexGot(telegramConversation.resume?.cursor ?? telegramConversation.codexThreadId);
  check("telegramMessageUsesTheSkill", fromTelegram.skillItems.some((item) => item.name === "e2e-codeword" && item.path === skillPath) && fromTelegram.injected.some((text) => text.includes(NONCE)),
    { skillItems: fromTelegram.skillItems, injected: fromTelegram.injected.length, telegramSaid: telegram.sent.slice(-1).map((item) => item.text.slice(0, 200)) });

  // --- 11. No page errors ----------------------------------------------------------------------------------
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
}

browser?.close();
for (const child of children.reverse()) if (child.pid) process.platform === "win32" ? spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }) : child.kill("SIGTERM");
stub.close();
await sleep(3_000);
notes.runnerLog = logs.runner.split("\n").filter((line) => line.trim()).slice(-25);
notes.serverErrors = logs.server.split("\n").filter((line) => /error|failed/i.test(line)).slice(-15);
try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
notes.tempHomeRemoved = !existsSync(home);
const passed = Object.values(checks).every(Boolean);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), model: MODEL, checks, notes, passed }, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(passed ? 0 : 1);
