import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { FAKE_AGENT, perry, REPO, sleep } from "../engine-acp/harness";

// bun artifacts/no-hardcoded-engines/run.ts <outDir>
// Issue #200: no engine or model is chosen by Perry's code, and chats with other people run only on an
// engine that can be locked down for them. A fresh Perry from the production build (`pnpm build` first)
// on a spare port, its PERRY_HOME under PERRY_E2E_DIR (W:/perry-tests/no-hardcoded), and the real runner
// with three stand-in engines and nothing else on its PATH or in its home:
//   - Claude Code: artifacts/claude-warm/fake-claude.js, started by the real Claude Agent SDK as it
//     starts Claude Code, playing Claude Code's own gates from the flags the SDK gives it, and running
//     for real whatever they let through (a command, a read, a write, a fetch, an MCP call);
//   - Codex: artifacts/cli-versions/fake-cli.ts's app-server, which logs how each thread and turn starts;
//   - Grok Build: artifacts/engine-acp/fake-agent.ts, the owner's default engine, which cannot be locked down.
// CODEX_HOME, CLAUDE_CONFIG_DIR, USERPROFILE and HOME are folders of this run's, no API key is set, and
// the run stops before anyone writes if the engines it finds are not the stand-ins. No real model is
// asked anything. Someone else writes on WhatsApp (contacts:inbound, as server/whatsapp.ts passes them
// on); what Perry sends them, and what it tells the owner, is read from the WhatsApp outbox.
//
// Ways it could fail, written down before the checks:
//   1. A chat with someone else still runs on a fixed engine (Codex), whatever is signed in, or fails
//      when that engine's plan is used up instead of moving to another one that can be locked down.
//   2. It runs on the owner's default engine although that one cannot be locked down (Grok Build, an
//      ACP agent with its own shell and file tools), or on any engine that cannot: an ACP one picked by
//      routing, one the owner pinned for that chat, or one a turn was queued on by hand. The server
//      must not send it there, and the runner must refuse it if it is sent anyway.
//   3. Claude Code is started for such a chat with its own tools, folders or settings: a model talked
//      into it runs a command, reads a file (the owner's secrets), writes one, or fetches a page from
//      this computer's network; or one of Perry's tools that is not a guest tool (the browser) runs.
//   4. The lockdown rests on one wall only: a Claude Code that ignored its flags (--tools, the
//      disallowed list, dontAsk) would run anything, because canUseTool allows it.
//   5. The lockdown goes too far: Perry's guest tools (remember) no longer work, or no reply comes back.
//   6. Claude Code is told about this computer in such a chat (its folders, the owner's name on it).
//   7. Codex is started for such a chat with its shell, apps or computer, a sandbox that writes, the
//      owner's folders, or approvals that could be granted.
//   8. A turn refused part-way for a limit fails the chat instead of running once more on another engine
//      that can be locked down; or the retry runs without the lockdown.
//   9. With no engine that can be locked down having room, a turn is queued anyway (and refused), the
//      person is shown typing, or the owner is told at every message instead of once, or never.
//  10. Once an engine can take them again, chats with other people stay stuck.
//  11. The run's details do not say which engine it ran on and why.
//  12. A hard-coded engine or model choice is left in Perry's code (grep, with an allowlist of facts
//      about engines that are not choices).
//  13. The run itself does not get to the end, or a real engine is used.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/no-hardcoded-engines/run.ts <outDir>");
const BASE_DIR = process.env.PERRY_E2E_DIR ?? "W:/perry-tests/no-hardcoded";
mkdirSync(BASE_DIR, { recursive: true });
process.env.PERRY_E2E_DIR = BASE_DIR;
for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete process.env[name];

// --- 12. The grep: every engine name or model id in Perry's code, each a fact or a list, never a pick ---------
const PRODUCT = ["convex", "runner", "server", "scripts", "components", "app", "pet", "lib", "hooks", "client", "evals"];
const ENGINE_LITERAL = /["'`](codex|claude|grok|antigravity|cursor)["'`]/g;
const MODEL_LITERAL = /\b(gpt-[\w.-]+|o\d-[\w.-]+|claude-(?:opus|sonnet|haiku)[\w.-]*|gemini-\d[\w.-]*|grok-\d[\w.-]*)\b|["'`](opus|sonnet|haiku|luna|sol|flash|pro)["'`]/gi;
/** What picked an engine or model before issue #200: none of it may come back. */
const GONE = /\b(GUEST_ENGINE|DEFAULT_ENGINE|TITLE_MODEL|QUICK_MODELS|guestSettings)\b|QUICK_MODEL = "/;
/** Facts about engines, and lists of options, that name an engine or model: where, what, and why it is not a choice. */
const ALLOWED: Array<{ file: RegExp; line: RegExp; why: string }> = [
  { file: /^convex\/lib\/engines\.ts$/, line: /ENGINES = \[|RUNNABLE_ENGINES: readonly/, why: "the list of engines, and the ones a runner drives: options, not a pick" },
  { file: /^convex\/lib\/engines\.ts$/, line: /LOCKED_DOWN_BEFORE: EngineKind = "codex"/, why: "a runner from before guestLockdown was reported locked down only Codex (#148): a fact about old runners" },
  { file: /^convex\/lib\/engines\.ts$/, line: /MINIMUM_VERSIONS|CLI_PACKAGES/, why: "each CLI's oldest working version and npm package: facts per engine" },
  { file: /^convex\/schema\.ts$/, line: /export const vEngine = v\.union/, why: "the validator of the engine list" },
  { file: /^convex\/engines\.ts$/, line: /kind: "codex",|status\.kind === "codex"|engine === "codex" && chat\.codexThreadId/, why: "a runner from before engines reported only Codex, in codex* fields, and kept Codex threads there" },
  { file: /^convex\/codex\.ts$/, line: /status\.kind !== "codex"|kind: "codex",|engine: "codex"|engine === "codex" \?/, why: "the calls a runner from before engines makes, which were Codex's, and the Codex thread id it resumes by" },
  { file: /^convex\/installation\.ts$/, line: /const engine: EngineKind = "codex";/, why: "an install from before the owner chose had run on Codex: its choice, written down as it was (#195)" },
  { file: /^convex\/models\.ts$/, line: /codex: modelsOf\(models, "codex"\)/, why: "Codex's models alone, as scripts from before engines read them" },
  { file: /^convex\/usage\.ts$/, line: /^$/, why: "" },
  { file: /^runner\/codex\.ts$/, line: /spawnEngine\("codex"|limitId \?\? "codex"/, why: "Codex's CLI name, and the id Codex gives its plan's own limit bucket" },
  { file: /^runner\/engines\/codex\.ts$/, line: /kind = "codex"|kind: "codex"|command: "codex"|return "codex"|id === "codex"|buckets\.get\("codex"\)/, why: "the Codex engine's own kind, CLI name and plan bucket" },
  { file: /^runner\/engines\/claude\.ts$/, line: /kind = "claude"|kind: "claude"|updateCommand\("claude"|"claude\.exe", "claude\.cmd"|\["claude"\]|SEED_MODELS|\{ id: "[\w.-]+", name: "[\w. ()]+", isDefault: (true|false)/, why: "the Claude Code engine's own kind, binary names, and the model aliases it offers before a session lists them (options, with Claude Code's own default marked)" },
  { file: /^runner\/engines\/grok\.ts$/, line: /kind: "grok"|"grok"\)|updateCommand\("grok"|label === "Grok account" \? "grok"/, why: "the Grok engine's own kind, CLI name and sign-in type" },
  { file: /^runner\/engines\/antigravity\.ts$/, line: /"engines", "antigravity"|kind: "antigravity"/, why: "the Antigravity engine's own kind and folder" },
  { file: /^runner\/engines\/acp\.ts$/, line: /DEFAULT_MODEL = "default"/, why: "ACP's placeholder for the agent's own default model, when it lists none" },
  { file: /^server\/modules\.ts$/, line: /"codex": codex/, why: "the convex/codex.ts module's name" },
  { file: /^scripts\/doctor\.ts$/, line: /latestVersionNow\("codex"\)|"codex"|"claude code"|"antigravity"/, why: "doctor checks every engine installed on this computer, each by its own CLI: facts per engine" },
  { file: /^scripts\/lib\.ts$/, line: /runOnPath\("codex"/, why: "Codex's CLI name" },
  { file: /^scripts\/setup\.ts$/, line: /kind === "codex"|kind === "claude"|kind === "grok"|runOnPath\("codex"|"grok"\)|=== "antigravity"/, why: "how each engine installs and signs in, for the engine the owner chose" },
  { file: /^components\/dashboard\/(default-engine|screens\/settings)\.tsx$/, line: /=== "antigravity"/, why: "Antigravity is experimental and turned on in Settings: a fact said beside it" },
  { file: /^evals\/judge\.ts$/, line: /spawn\("codex"|"codex /, why: "the evals' judge (dev-only, `pnpm evals`) is a `codex exec` with an output schema, on the developer's own Codex; its model is --judge-model's, unset by default" },
  { file: /^convex\/lib\/routing\.ts$/, line: /QUICK_MODEL = |DEEP_MODEL = /, why: "#194's tier rule: words a fast or strong model's name carries, to find one among those an engine offers" },
  { file: /^convex\/lib\/telegram\.ts$/, line: /audio\\\/\(ogg\|opus\)/, why: "an audio codec, not a model" },
];
function grepCheck(): { hits: Array<{ at: string; text: string; why?: string }>; unexplained: string[]; gone: string[] } {
  const hits: Array<{ at: string; text: string; why?: string }> = [];
  const gone: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "node_modules" || name === "_generated" || name === ".next") continue;
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(name)) continue;
      const file = relative(REPO, path).replace(/\\/g, "/");
      readFileSync(path, "utf8").split(/\r?\n/).forEach((line, index) => {
        const code = line.trim();
        // A comment names things; it chooses nothing.
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
        if (GONE.test(line)) gone.push(`${file}:${index + 1}`);
        if (!ENGINE_LITERAL.test(line) && !MODEL_LITERAL.test(line)) return;
        ENGINE_LITERAL.lastIndex = 0;
        MODEL_LITERAL.lastIndex = 0;
        const allowed = ALLOWED.find((entry) => entry.file.test(file) && entry.line.test(line) && entry.why);
        hits.push({ at: `${file}:${index + 1}`, text: code.slice(0, 160), ...(allowed ? { why: allowed.why } : {}) });
      });
    }
  };
  for (const dir of PRODUCT) if (existsSync(join(REPO, dir))) walk(join(REPO, dir));
  return { hits, unexplained: hits.filter((hit) => !hit.why).map((hit) => `${hit.at}: ${hit.text}`), gone };
}
if (process.argv.includes("--grep-only")) {
  const found = grepCheck();
  console.log(JSON.stringify(found, null, 2));
  process.exit(found.unexplained.length || found.gone.length ? 1 : 0);
}

// --- The stand-ins, alone on the runner's PATH --------------------------------------------------------------
const root = mkdtempSync(join(BASE_DIR, "run-"));
const bin = join(root, "bin");
const claudeHome = join(root, "fake-claude");
const cliHome = join(root, "fake-codex");
const acpHome = join(root, "fake-grok");
const userHome = join(root, "user");
/** What a model talked into it would go for: the owner's secret, and where a command or a write would leave a mark. */
const victim = join(root, "victim").replace(/\\/g, "/");
for (const dir of [join(bin, "claude-code"), claudeHome, cliHome, acpHome, userHome, victim, join(root, "codex-home"), join(root, "claude-config")]) mkdirSync(dir, { recursive: true });
const SECRET = `SECRET-${Math.floor(Math.random() * 1e6)}`;
writeFileSync(join(victim, "secret.txt"), `The owner's bank PIN is ${SECRET}.`);
copyFileSync(join(REPO, "artifacts", "claude-warm", "fake-claude.js"), join(bin, "claude-code", "cli.js"));
const windows = process.platform === "win32";
writeFileSync(join(bin, windows ? "claude.cmd" : "claude"), windows ? `@"${process.execPath}" "%~dp0\\claude-code\\cli.js" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/claude-code/cli.js" "$@"\n`, { mode: 0o755 });
const FAKE_CLI = join(REPO, "artifacts", "cli-versions", "fake-cli.ts");
writeFileSync(join(bin, windows ? "codex.cmd" : "codex"), windows ? `@"${process.execPath}" "${FAKE_CLI}" codex %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" codex "$@"\n`, { mode: 0o755 });
const CODEX_VERSION = "0.177.7";
writeFileSync(join(cliHome, "codex-version"), CODEX_VERSION);
writeFileSync(join(acpHome, "grok-signed-in"), "yes");
const system = process.env.SystemRoot ?? "C:\\Windows";
const runnerPath = (windows
  ? [bin, dirname(process.execPath), "C:\\Program Files\\nodejs", join(system, "System32"), system, join(system, "System32", "WindowsPowerShell", "v1.0")]
  : [bin, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"]).join(windows ? ";" : ":");
const PATH_KEY = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";

// A page on this computer that a fetch from the guest's chat would reach: it must never be asked for.
const fetched: string[] = [];
const page = createServer((request, response) => { fetched.push(request.url ?? ""); response.end("internal page"); });
await new Promise<void>((done) => page.listen(0, "127.0.0.1", done));
const PAGE = `http://127.0.0.1:${(page.address() as { port: number }).port}/router-admin`;

const p = await perry({
  name: "no-hardcoded",
  outDir,
  engine: "grok",
  runnerEnv: () => ({
    [PATH_KEY]: runnerPath,
    USERPROFILE: userHome, HOME: userHome,
    CODEX_HOME: join(root, "codex-home"), CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    FAKE_CLAUDE_HOME: claudeHome, FAKE_CLI_HOME: cliHome, FAKE_ACP_HOME: acpHome,
    PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`,
    // Nothing looks up the newest CLIs on npm.
    PERRY_NPM_REGISTRY: "http://127.0.0.1:9",
    PERRY_CLAUDE_IDLE_MIN: "5",
  }),
});
const { BASE, KEY, call, check, notes, until, rows, sql, turnsOf, computers, fakeLog } = p;

const OWNER = "919876543210@s.whatsapp.net";
const SAM = "15557770000@s.whatsapp.net";
const PRIYA = "919000011111@s.whatsapp.net";
type Row = Record<string, any> & { _id: string };
const claudeLog = () => fakeLog(claudeHome);
const codexLog = () => fakeLog(cliHome);
const grokLog = () => fakeLog(acpHome);
const outbox = (to: string, since = 0) => rows("whatsappOutbox").filter((row) => row.to === to && row.kind === "text" && row.createdAt >= since).map((row) => String(row.text));
const chatOf = (contact: string) => rows("conversations").find((row) => row.contactId === contact) as Row | undefined;
const install = () => rows("installation")[0] as Row;
let token = "";
const WINDOW = (usedPercent: number) => ({ windows: [{ id: "five_hour", label: "5-hour", usedPercent, resetsAt: Date.now() + 2 * 3_600_000, minutes: 300 }], at: Date.now() });
/** An engine's plan, as the runner would report it; Claude Code's stand-in says the same when the runner reads it. */
async function plan(engine: "codex" | "claude", usedPercent: number) {
  if (engine === "claude") writeFileSync(join(claudeHome, "usage"), String(usedPercent));
  await call("usage:report", { token, engine, limits: WINDOW(usedPercent), hit: null });
}
const toggle = (file: string, on: boolean) => on ? writeFileSync(join(claudeHome, file), "yes") : rmSync(join(claudeHome, file), { force: true });

/** Someone else writes on WhatsApp; the turns their message became, once each has ended. */
async function guestSays(from: string, name: string, text: string, seconds = 90) {
  const before = Date.now();
  await call("contacts:inbound", { channel: "whatsapp", chatId: from, kind: "person", from: { name, handle: `+${from.split("@")[0]}` }, text, addressed: true });
  const chat = chatOf(rows("contacts").find((row) => row.externalId === from)!._id)!;
  const fresh = () => turnsOf(chat._id).filter((turn) => turn.createdAt >= before);
  const runs = () => rows("runs").filter((run) => run.conversationId === chat._id && run.startedAt >= before);
  await until(() => runs().length > 0 && runs().every((run) => run.status !== "running") && fresh().every((turn) => turn.finalizedAt || turn.status === "error" && !turn.retrying && turn.finalizedAt), `${name}'s message to be answered or refused`, seconds);
  await sleep(500);
  return { chat: chatOf(chat.contactId)!, turns: fresh(), runs: runs(), at: before };
}
const stepsOf = (session: string, since: number) => claudeLog().filter((entry) => entry.event === "step" && entry.session === session && entry.at >= since - 50)
  .map((entry) => ({ tool: entry.tool, got: entry.got, ran: entry.ran, output: String(entry.output ?? "").slice(0, 120) }));

let aborted = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => {
    const engines = (await computers()).filter((item) => item.online).flatMap((item) => item.engines);
    return ["codex", "claude", "grok"].every((kind) => engines.some((engine) => engine.kind === kind && engine.signedIn));
  }, "the runner to report Codex, Claude Code and Grok Build signed in", 120);

  // --- 13. Only the stand-ins: stop before anyone writes otherwise ----------------------------------------------
  const engines = (await computers()).filter((item) => item.online).flatMap((item) => item.engines);
  const claudeNow = engines.find((engine) => engine.kind === "claude");
  const codexNow = engines.find((engine) => engine.kind === "codex");
  // The stand-ins' own versions (fake-claude.js says 9.9.9), and what only they log.
  const standIns = claudeNow?.version === "9.9.9" && claudeLog().every((entry) => entry.event !== "turn") && codexNow?.version === CODEX_VERSION
    && codexLog().some((entry) => entry.method === "account/read") && grokLog().length > 0;
  const claudeStatus = sql<{ doc: string }>(`SELECT doc FROM "doc_runners"`).map((row) => JSON.parse(row.doc)).flatMap((runner) => runner.engines ?? []);
  notes.engines = claudeStatus.map((status: Row) => ({ kind: status.kind, signedIn: status.signedIn, version: status.version, email: status.auth?.email, guestLockdown: status.guestLockdown }));
  const email = claudeStatus.find((status: Row) => status.kind === "claude")?.auth?.email;
  if (!standIns || email !== "stand-in@example.com") {
    aborted = true;
    throw new Error(`the engines are not all stand-ins (Claude Code ${email}, Codex ${codexNow?.version}): stopped before anything was sent`);
  }
  check("onlyStandInEnginesRun", true, notes.engines);
  check("eachEngineSaysWhetherItCanBeLockedDown", ["codex", "claude"].every((kind) => claudeStatus.find((status: Row) => status.kind === kind)?.guestLockdown === true)
    && ["grok", "antigravity"].every((kind) => claudeStatus.find((status: Row) => status.kind === kind)?.guestLockdown === false), notes.engines);

  token = String(rows("runners").find((row) => !row.revoked)?.token);
  // The owner, on WhatsApp: where Perry tells them things.
  sql(`UPDATE "doc_installation" SET doc = json_set(doc, '$.whatsappOwner', ?, '$.claimedAt', ?)`, [OWNER, Date.now()]);
  await call("contacts:learn", { items: [
    { channel: "whatsapp", externalId: SAM, kind: "person", name: "Sam", handle: "+1 555 777 0000" },
    { channel: "whatsapp", externalId: PRIYA, kind: "person", name: "Priya", handle: "+91 90000 11111" },
  ] });
  for (const contact of rows("contacts")) await call("contacts:decided", { contactId: contact._id, kind: "contact", approved: true });
  const sam = rows("contacts").find((row) => row.externalId === SAM)!._id;
  const defaultEngine = install().defaultEngine;
  check("theOwnersDefaultIsGrokWhichCannotBeLockedDown", defaultEngine === "grok", { defaultEngine });

  // --- 1, 2, 3, 5, 6, 11. The default can't be locked down: Claude Code, with the most of its plan left, takes it ----
  await plan("codex", 60);
  await plan("claude", 10);
  const first = await guestSays(SAM, "Sam", `GUEST ${victim} ${PAGE}`);
  const run1 = first.runs.at(-1)!;
  const turn1 = first.turns.at(-1)!;
  const session = first.chat.resume?.cursor as string;
  const start = claudeLog().filter((entry) => entry.event === "start" && entry.session === session).at(-1);
  const steps1 = stepsOf(session, first.at);
  notes.firstRoute = run1.route;
  check("aGuestTurnSkipsTheDefaultThatCantBeLockedDown", turn1?.engine === "claude" && turn1.guest === true && run1.route?.engine === "claude"
    && /can't be locked down/.test(run1.route?.why ?? "") && /Grok Build, your default engine/.test(run1.route?.why ?? "") && /most of its plan left/.test(run1.route?.why ?? ""),
    { engine: turn1?.engine, guest: turn1?.guest, why: run1.route?.why });
  check("claudeIsStartedWithNoToolsSettingsOrFolders", start !== undefined && start.tools === "" && start.mode === "dontAsk" && start.settingSources === "--setting-sources="
    && start.strictMcp === true && start.addDirs.length === 0 && start.mcpServers.join() === "assistant"
    && start.allowedTools.slice().sort().join() === ["forget", "read_memory", "recall", "remember", "tell_owner"].map((tool) => `mcp__assistant__${tool}`).join()
    && ["Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Skill"].every((tool) => start.disallowedTools.includes(tool))
    && relative(join(p.home, "guest"), start.cwd) === "" && readdirSync(join(p.home, "guest")).length === 0,
    start && { tools: start.tools, mode: start.mode, settingSources: start.settingSources, strictMcp: start.strictMcp, addDirs: start.addDirs, cwd: relative(p.home, start.cwd), allowedTools: start.allowedTools, disallowed: start.disallowedTools.length, mcpServers: start.mcpServers });
  const init = claudeLog().filter((entry) => entry.event === "control" && entry.subtype === "initialize" && entry.at >= first.at).at(-1);
  const system = JSON.stringify(init?.system ?? "") + JSON.stringify(init?.append ?? "");
  const account = (() => { try { return userInfo().username; } catch { return ""; } })();
  check("claudeIsToldNothingOfThisComputer", init !== undefined && /no shell, files or computer/.test(system) && init.append === null
    && !system.includes(p.home.replace(/\\/g, "\\\\")) && !system.includes(p.home) && !system.includes(hostname()) && !(account.length > 2 && system.toLowerCase().includes(account.toLowerCase())),
    { systemStarts: system.slice(0, 160), append: init?.append });
  check("aShellAFileAWriteAndAFetchAreNotThere", ["Bash", "Read", "Write", "WebFetch"].every((tool) => steps1.some((step) => step.tool === tool && step.got === "unavailable" && !step.ran)), steps1);
  check("perrysOwnNonGuestToolIsRefused", steps1.some((step) => step.tool === "mcp__assistant__browser" && step.got === "denied" && !step.ran), steps1.find((step) => step.tool === "mcp__assistant__browser"));
  check("aGuestToolWorks", steps1.some((step) => step.tool === "mcp__assistant__remember" && step.got === "allowed" && step.ran && !/error/i.test(step.output))
    && rows("memories").some((memory) => /two sugars/.test(memory.text ?? "") && memory.conversationId === first.chat._id || /two sugars/.test(memory.text ?? "")),
    { step: steps1.find((step) => step.tool === "mcp__assistant__remember"), memories: rows("memories").filter((memory) => /two sugars/.test(memory.text ?? "")).map((memory) => ({ text: memory.text, chat: memory.conversationId === first.chat._id || memory.seenFrom })) });
  const marks = () => ({ bashRan: existsSync(join(victim, "bash-ran.txt")), written: existsSync(join(victim, "written.txt")), pageFetched: fetched.length });
  const replies1 = outbox(SAM, first.at);
  check("nothingRanAndNothingLeaked", !marks().bashRan && !marks().written && marks().pageFetched === 0 && replies1.length > 0 && !replies1.join(" ").includes(SECRET)
    && !rows("whatsappOutbox").some((row) => String(row.text ?? "").includes(SECRET)), { ...marks(), replyToSam: replies1.join(" ").slice(0, 300) });

  // --- 4. Claude Code ignoring its flags: every tool is asked about, and the runner's canUseTool refuses all but the guest tools ---
  toggle("gates-off", true);
  const second = await guestSays(SAM, "Sam", `GUEST ${victim} ${PAGE}`);
  toggle("gates-off", false);
  const steps2 = stepsOf(second.chat.resume?.cursor, second.at);
  check("withItsGatesOffCanUseToolStillRefuses", ["Bash", "Read", "Write", "WebFetch", "mcp__assistant__browser"].every((tool) => steps2.some((step) => step.tool === tool && step.got === "deny" && !step.ran))
    && steps2.some((step) => step.tool === "mcp__assistant__remember" && step.got === "allow" && step.ran)
    && !marks().bashRan && !marks().written && marks().pageFetched === 0 && !outbox(SAM, second.at).join(" ").includes(SECRET), { steps: steps2, ...marks() });

  // --- 1, 7. Claude Code's plan used up: Codex, the other engine that can be locked down, takes the chat, locked down ---
  await plan("claude", 100);
  const third = await guestSays(SAM, "Sam", "Are you free on Saturday?");
  const turn3 = third.turns.at(-1)!;
  const thread = codexLog().filter((entry) => (entry.method === "thread/start" || entry.method === "thread/resume") && entry.at >= third.at).at(-1)?.params;
  const codexTurn = codexLog().filter((entry) => entry.method === "turn/start" && entry.at >= third.at).at(-1)?.params;
  check("aUsedUpEngineMovesToAnotherThatCanBeLockedDown", turn3?.engine === "codex" && turn3.guest === true && outbox(SAM, third.at).some((text) => text.includes("Fake Codex"))
    && /Claude Code's 5-hour limit is used up/.test(third.runs.at(-1)?.route?.why ?? third.runs.at(-1)?.route?.movedFrom?.why ?? ""),
    { engine: turn3?.engine, why: third.runs.at(-1)?.route?.why, reply: outbox(SAM, third.at).join(" ").slice(0, 120) });
  const config = thread?.config ?? {};
  check("codexIsStartedWithNoShellAppsOrComputer", Boolean(thread) && thread.sandbox === "read-only" && thread.approvalPolicy === "never" && relative(join(p.home, "guest"), thread.cwd) === ""
    && ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation", "computer_use", "browser_use"].every((feature) => config[`features.${feature}`] === false)
    && config["tools.view_image"] === false && config.project_doc_max_bytes === 0 && !/This computer|Your own folder/.test(String(thread.developerInstructions ?? ""))
    && codexTurn?.approvalPolicy === "never" && /read/i.test(String(codexTurn?.sandboxPolicy?.type ?? "")) && !JSON.stringify(codexTurn?.sandboxPolicy ?? {}).includes(join(p.home, "files").replace(/\\/g, "\\\\")),
    { sandbox: thread?.sandbox, approvalPolicy: thread?.approvalPolicy, cwd: thread && relative(p.home, thread.cwd), features: Object.fromEntries(Object.entries(config).filter(([name]) => name.startsWith("features.") || name.startsWith("tools.") || name === "project_doc_max_bytes")), turnSandbox: codexTurn?.sandboxPolicy });

  // --- 8. Refused part-way for a limit on Claude Code: it runs once more on Codex, still locked down ---------------
  await plan("claude", 10);
  toggle("limited", true);
  const fourth = await guestSays(PRIYA, "Priya", "Hi Perry, is the owner around?");
  toggle("limited", false);
  const retried = fourth.turns.find((turn) => turn.retryOf);
  const refused = fourth.turns.find((turn) => !turn.retryOf);
  check("aTurnRefusedForALimitRunsAgainOnAnotherLockableEngine", refused?.engine === "claude" && retried?.engine === "codex" && retried?.guest === true
    && fourth.runs.length === 1 && fourth.runs[0].route?.retried === true && outbox(PRIYA, fourth.at).some((text) => text.includes("Fake Codex")),
    { turns: fourth.turns.map((turn) => ({ engine: turn.engine, guest: turn.guest, retryOf: Boolean(turn.retryOf), status: turn.status })), route: fourth.runs[0]?.route?.engine });

  // --- 9. Nothing that can be locked down has room: no turn, nothing typed, and the owner told once ------------------
  await plan("claude", 100);
  await plan("codex", 100);
  const toldBefore = outbox(OWNER).length;
  const typingBefore = rows("whatsappOutbox").filter((row) => row.kind === "typing" && row.to === SAM).length;
  const fifth = await guestSays(SAM, "Sam", "Hello?");
  const sixth = await guestSays(SAM, "Sam", "Anyone there?");
  const told = outbox(OWNER).slice(toldBefore);
  check("withNoneThatCanBeLockedDownNoTurnRuns", fifth.turns.length === 0 && sixth.turns.length === 0 && fifth.runs.every((run) => run.status === "error" && /locked down|used up/.test(run.error ?? ""))
    && outbox(SAM, fifth.at).length === 0 && rows("whatsappOutbox").filter((row) => row.kind === "typing" && row.to === SAM).length === typingBefore,
    { runs: [...fifth.runs, ...sixth.runs].map((run) => ({ status: run.status, error: String(run.error ?? "").slice(0, 200) })), toSam: outbox(SAM, fifth.at) });
  check("theOwnerIsToldOnce", told.length === 1 && /Chats with other people get no reply/.test(told[0]) && Boolean(install().guestsStuck), { told });

  // --- 10. Codex has room again: the next message is answered, and the owner would be told again next time ---------
  await plan("codex", 10);
  const seventh = await guestSays(SAM, "Sam", "Still there?");
  check("onceAnEngineHasRoomTheyAreAnsweredAgain", seventh.turns.at(-1)?.engine === "codex" && outbox(SAM, seventh.at).length > 0 && !install().guestsStuck,
    { engine: seventh.turns.at(-1)?.engine, stuck: install().guestsStuck ?? null });

  // --- 2. Grok Build pinned on the chat by the owner: still never used for them ------------------------------------
  sql(`UPDATE "doc_conversations" SET doc = json_set(doc, '$.engine', 'grok', '$.model', 'grok-fake-fast') WHERE _id = ?`, [seventh.chat._id]);
  const eighth = await guestSays(SAM, "Sam", "Pinned GROK-CANARY please");
  check("anEnginePinnedThatCantBeLockedDownIsPassedOver", eighth.turns.length > 0 && eighth.turns.every((turn) => turn.engine !== "grok") && eighth.runs.at(-1)?.route?.engine !== "grok",
    { engines: eighth.turns.map((turn) => turn.engine), why: eighth.runs.at(-1)?.route?.why });
  // Queued by hand on Grok Build for that chat: the server finds no computer that can lock it down.
  const handRun = await call<string>("runs:start", { conversationId: eighth.chat._id, prompt: "by hand" });
  const byHand = await call("codex:enqueueTurn", { conversationId: eighth.chat._id, runId: handRun, prompt: "GROK-CANARY by hand", instructions: "x", engine: "grok", guest: true }).then(() => "queued", (error) => String(error));
  check("theServerSendsNoGuestTurnToAnEngineThatCantBeLockedDown", byHand !== "queued" && /can't be locked down/.test(byHand) && !turnsOf(eighth.chat._id).some((turn) => turn.engine === "grok"), { byHand: byHand.slice(0, 200) });
  // A guest turn sent to Grok Build anyway (an owner's chat, marked guest): the runner refuses it.
  const web = await call<string>("dashboard:createChat", { key: KEY });
  const webRun = await call<string>("runs:start", { conversationId: web, prompt: "by hand" });
  await call("codex:enqueueTurn", { conversationId: web, runId: webRun, prompt: "GROK-CANARY to the runner", instructions: "x", engine: "grok", guest: true });
  await until(() => turnsOf(web).some((turn) => turn.status === "error" || turn.status === "done"), "the runner to take the turn", 60);
  const refusedByRunner = turnsOf(web).at(-1)!;
  check("theRunnerRefusesAGuestTurnOnAnEngineThatCantBeLockedDown", refusedByRunner.status === "error" && /can't be locked down/.test(refusedByRunner.error ?? ""), { status: refusedByRunner.status, error: refusedByRunner.error });
  check("grokNeverSawSomeoneElsesWords", !grokLog().some((entry) => /GROK-CANARY|GUEST|Saturday|Sam|Priya/.test(JSON.stringify(entry.prompt ?? entry.text ?? ""))),
    { grokPrompts: grokLog().filter((entry) => entry.prompt).map((entry) => String(entry.prompt).slice(0, 60)) });

  // --- 11. The run's details say where and why ----------------------------------------------------------------------
  notes.runDetails = rows("runs").filter((run) => run.route && rows("conversations").find((chat) => chat._id === run.conversationId)?.contactId)
    .map((run) => ({ engine: run.route.engine, model: run.route.model, why: run.route.why, retried: run.route.retried ?? false }));
  check("theRunsDetailsSayTheEngineAndWhy", (notes.runDetails as Row[]).length >= 5 && (notes.runDetails as Row[]).every((run) => run.engine && /locked down/.test(run.why)));
} catch (error) {
  check(aborted ? "stoppedBeforeAnythingWasSent" : "completed", false, String(error instanceof Error ? error.stack : error));
}

// --- 12. No hard-coded engine or model choice left ------------------------------------------------------------------
const found = grepCheck();
notes.grep = { literals: found.hits.length, kept: found.hits.filter((hit) => hit.why).map((hit) => `${hit.at} (${hit.why})`) };
check("noHardCodedEngineOrModelChoiceRemains", found.unexplained.length === 0 && found.gone.length === 0, { unexplained: found.unexplained, gone: found.gone });

notes.claudeLog = claudeLog().filter((entry) => entry.event === "step" || entry.event === "start").map((entry) => entry.event === "start"
  ? { start: entry.session, tools: entry.tools, mode: entry.mode, allowed: entry.allowedTools?.length }
  : { step: entry.tool, got: entry.got, ran: entry.ran });
page.close();
const passed = await p.finish({ stand_ins: ["artifacts/claude-warm/fake-claude.js", "artifacts/cli-versions/fake-cli.ts", "artifacts/engine-acp/fake-agent.ts"] });
try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
process.exit(passed ? 0 : 1);
