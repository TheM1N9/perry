import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "../../runner/codex";
import { LIMIT_HIT } from "../../convex/lib/usage";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/engine-usage/run.ts <outDir>
// Issue #153: how much of each engine's subscription Perry is using, and what
// is left. A fresh Perry from the production build (`pnpm build` first) on a
// spare port with a temp PERRY_HOME, the real runner, this machine's real
// signed-in Codex and Claude Code (whose plan limits are read, which spends
// nothing), Grok Build played by the fake ACP agent (PERRY_GROK_COMMAND), and
// headless Chrome for the chat, the pet's page and Settings → Usage. One short
// real Codex message is sent (PERRY_E2E_MODEL, gpt-6-luna by default); when the
// plan is used up, Codex refuses it and nothing is spent. Nothing touches the
// owner's own Perry.
//
// Ways it could fail, written down before the checks:
//   1. The runner never reads Codex's plan limits, or reads them wrong: what it
//      stores differs from Codex's own account/rateLimits/read, the windows are
//      not labelled 5-hour and Weekly, or the reset times are off by 1000x.
//   2. Reading the limits spends the plan: a Claude Code session is saved for
//      it (a transcript in ~/.claude/projects), or Codex is sent a turn.
//   3. Claude Code's limits are not read (its SDK's /usage call failed or
//      changed shape), or are mislabelled.
//   4. A reply's tokens are not counted into Perry's share, or counted to the
//      wrong engine or chat, or a chat's tokens are counted twice.
//   5. A limit hit is not recognised from the engine's own words, not
//      recorded, or not cleared when a reply goes through again.
//   6. The chat does not warn before a message is sent when its engine is
//      running low or used up, or warns about an engine that has room.
//   7. A window whose reset has passed still counts as full.
//   8. The pet does not say it, or says it about an engine Perry does not use.
//   9. Settings → Usage does not show each engine, its windows and reset
//      times, or does not say plainly which engines report no limits.
//  10. The dashboard throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/engine-usage/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
let fakeHome = "";
const p = await perry({
  name: "engine-usage",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    // Grok is signed in from the start: signing in is engine-grok's run.
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome };
  },
});
const { BASE, KEY, home, call, check, notes, until, rows, getChat, computers, exchange } = p;

type Window = { id: string; label: string; usedPercent: number; resetsAt?: number; minutes?: number };
type Usage = { limits?: { windows: Window[]; plan?: string; at: number }; hit?: { at: number; message: string } };
const limits = () => call<{ engines: Array<{ kind: string; usage: Usage }>; used: string[] }>("usage:limits", { key: KEY });
const usageOf = async (kind: string) => (await limits()).engines.find((item) => item.kind === kind)?.usage;
type Overview = { engines: Array<{ kind: string; installed: boolean; signedIn: boolean; plan?: string; usage?: Usage; share: { week: { tokens: number; turns: number }; windows: Record<string, { tokens: number; turns: number }> } }>; items: Array<{ id: string; title: string; kind: string; engines: string[]; tokens: number; turns: number }> };
const overview = () => call<Overview>("usage:overview", { key: KEY });
/** Waits for the chat to settle after a message that may fail, which `exchange` does not. */
async function sendAndSettle(chat: string, text: string, seconds = 120) {
  const before = rows("runs").filter((run) => run.conversationId === chat).length;
  await call("dashboard:sendChat", { key: KEY, id: chat, text });
  await until(() => rows("runs").filter((run) => run.conversationId === chat).length > before, "the run to start", 60);
  await until(async () => !(await getChat(chat)).isRunning && rows("runs").filter((run) => run.conversationId === chat).every((run) => run.status !== "running"), "the reply to settle", seconds);
  return await getChat(chat);
}
const newChat = async (title: string, model: string, engine: string) => {
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  // Named up front, so no quick turn is spent naming it.
  await call("dashboard:renameChat", { key: KEY, id: chat, title });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model, engine });
  return chat;
};

try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await until(async () => Boolean((await call<Array<{ builtin?: string }>>("jobs:list")).find((job) => job.builtin === "heartbeat")), "the built-in jobs", 90);
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)
    && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner to report Codex and Grok signed in", 120);
  const token = String(rows("runners").find((row) => !row.revoked)?.token);

  // --- 1. Codex's real plan limits, as the runner read them, against Codex's own read ------------------------
  await until(async () => Boolean((await usageOf("codex"))?.limits?.windows.length), "the runner to report Codex's limits", 90);
  const stored = (await usageOf("codex"))!.limits!;
  const app = await new CodexAppServer().start();
  let direct: Record<string, any>;
  try { direct = await app.request("account/rateLimits/read", { excludeResetCreditDetails: true }); } finally { app.close(); }
  const bucket = direct.rateLimitsByLimitId?.codex ?? direct.rateLimits;
  const primary = stored.windows.find((window) => window.id === "codex:primary");
  const secondary = stored.windows.find((window) => window.id === "codex:secondary");
  notes.codexDirect = { primary: bucket.primary, secondary: bucket.secondary, planType: bucket.planType, ordinaryUsageAllowed: direct.ordinaryUsageAllowed };
  notes.codexStored = stored;
  check("codexLimitsRead", Boolean(primary && secondary) && primary!.label === "5-hour" && secondary!.label === "Weekly"
    && primary!.minutes === 300 && secondary!.minutes === 10080
    && primary!.usedPercent === bucket.primary.usedPercent && secondary!.usedPercent === bucket.secondary.usedPercent
    && primary!.resetsAt === bucket.primary.resetsAt * 1000 && secondary!.resetsAt === bucket.secondary.resetsAt * 1000
    && stored.plan === bucket.planType);
  check("codexResetsAhead", [primary, secondary].every((window) => window!.resetsAt! > Date.now() && window!.resetsAt! < Date.now() + 8 * 86_400_000));

  // --- 2, 3. Claude Code's real plan limits, read without a session ------------------------------------------
  const claude = (await computers()).flatMap((item) => item.engines).find((engine) => engine.kind === "claude");
  notes.claudeSignedIn = Boolean(claude?.signedIn);
  if (claude?.signedIn) {
    await until(async () => Boolean((await usageOf("claude"))?.limits), "the runner to report Claude Code's limits", 120);
    const claudeLimits = (await usageOf("claude"))!.limits!;
    notes.claudeStored = claudeLimits;
    const five = claudeLimits.windows.find((window) => window.id === "five_hour");
    const week = claudeLimits.windows.find((window) => window.id === "seven_day");
    check("claudeLimitsRead", Boolean(five && week) && five!.label === "5-hour" && week!.label === "Weekly"
      && [five, week].every((window) => window!.usedPercent >= 0 && window!.usedPercent <= 100 && (window!.resetsAt ?? 0) > Date.now() - 60_000));
    // Claude Code saves a session's transcript under a folder named for its working folder, which is Perry's home.
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    const folder = join(projects, home.replace(/[^A-Za-z0-9]/g, "-"));
    check("claudeReadSavesNoSession", !existsSync(folder), folder);
  } else {
    check("claudeLimitsRead", true, "Claude Code is not signed in on this machine; its read was not exercised.");
  }

  // --- 4. Perry's share: a Grok reply's tokens, counted once, to Grok and to its chat ------------------------
  const grokChat = await newChat("Usage check on Grok", "grok-fake-fast", "grok");
  const first = await exchange(grokChat, "hello from the usage check");
  const grokRun = rows("runs").find((run) => run.conversationId === grokChat);
  const afterReply = await overview();
  const grokShare = afterReply.engines.find((engine) => engine.kind === "grok")!.share.week;
  const grokItem = afterReply.items.find((item) => item.id === grokChat);
  notes.grokShare = { reply: first.reply.slice(0, 80), run: grokRun?.usage, share: grokShare, item: grokItem };
  check("tokensCountedToEngineAndChat", grokRun?.usage?.totalTokens === 1280 && grokShare.tokens === 1280 && grokShare.turns === 1
    && grokItem?.tokens === 1280 && grokItem.turns === 1 && grokItem.engines.join() === "grok" && grokItem.kind === "chat" && grokItem.title === "Usage check on Grok");

  // --- 5. Grok refuses a reply for the plan's limit: recorded from its own words ------------------------------
  const refused = await sendAndSettle(grokChat, "LIMIT");
  await until(async () => Boolean((await usageOf("grok"))?.hit), "Grok's limit hit to be recorded", 30);
  const hit = (await usageOf("grok"))!.hit!;
  notes.grokHit = { lastError: refused.lastError, hit };
  check("limitHitRecorded", LIMIT_HIT.test(refused.lastError ?? "") && /rate limit for your plan/.test(hit.message));
  const used = (await limits()).used;
  check("usedEnginesKnown", used.includes("grok"), used);

  // --- 6, 10. The chat says so, above the composer ------------------------------------------------------------
  const browser = await p.openBrowser();
  const { evaluate, send, errors } = browser;
  const shot = async (name: string) => {
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  // The note above the composer about the engine's limit: the one that links to Settings → Usage.
  const note = () => evaluate(`[...document.querySelectorAll('[role="alert"], [role="status"]')].find((el) => el.querySelector('a[href="/settings?tab=usage"]'))?.innerText ?? ""`) as Promise<string>;
  const openChatPage = async (chat: string) => {
    await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
    await until(() => evaluate(`Boolean(document.querySelector('textarea'))`), "the chat page", 30);
    await sleep(1_500);
  };
  await openChatPage(grokChat);
  await until(async () => /Grok Build hit its plan's limit/.test(await note()), "the chat's limit note", 20).catch(() => {});
  const grokNote = await note();
  await shot("chat-grok-limit.png");
  notes.grokNote = grokNote;
  check("chatWarnsOnHit", /Grok Build hit its plan's limit/.test(grokNote) && /rate limit for your plan/.test(grokNote) && /See usage/.test(grokNote));

  // --- 8. The pet says it too, about the engine Perry uses ----------------------------------------------------
  await evaluate(`localStorage.removeItem("perry.pet.limits"); localStorage.removeItem("perry.pet.chat"); true`);
  await send("Page.navigate", { url: `${BASE}/pet` });
  await until(() => evaluate(`Boolean(document.querySelector('button[aria-label^="Perry."]'))`), "the pet's page", 30);
  const bubble = () => evaluate(`(() => { const b = document.querySelector('main [role="status"]'); return b ? [...b.querySelectorAll("p")].map((p) => p.textContent.trim()) : []; })()`) as Promise<string[]>;
  await until(async () => /limit/.test((await bubble()).join(" ")), "the pet's limit bubble", 20).catch(() => {});
  const petSaid = await bubble();
  await shot("pet-limit.png");
  const usedNow = (await limits()).used;
  notes.petSaid = { said: petSaid, used: usedNow };
  // Claude Code's limits are known too, but Perry has not used it here: the pet speaks only of the engines it has
  // (Grok, and Codex if a built-in job has run on it since the start, whose used-up week then comes first).
  check("petWarns", (petSaid[0] === "Grok Build hit its plan's limit" || (usedNow.includes("codex") && /^Codex's \S+ limit is used up$/.test(petSaid[0] ?? "")))
    && !/Claude/.test(petSaid.join(" ")) && /rate limit|resets/.test(petSaid.join(" ")));

  // --- 5. A reply that goes through again clears the hit -------------------------------------------------------
  await exchange(grokChat, "and again, after the limit");
  await until(async () => !(await usageOf("grok"))?.hit, "Grok's hit to clear", 30).catch(() => {});
  check("hitClearsAfterReply", !(await usageOf("grok"))?.hit);
  await openChatPage(grokChat);
  check("chatNoteGoneWithRoom", !/Grok Build/.test(await note()));

  // --- 6. Codex: warned before anything is sent, from the real limits; then one short real message ------------
  const codexChat = await newChat("Usage check on Codex", MODEL, "codex");
  await openChatPage(codexChat);
  const codexStanding = (await usageOf("codex"))!.limits!.windows.reduce((most, window) => Math.max(most, window.resetsAt! > Date.now() ? window.usedPercent : 0), 0);
  const codexBefore = await note();
  await shot("chat-codex-before.png");
  notes.codexBefore = { fullest: codexStanding, note: codexBefore };
  check("chatWarnsBeforeSending", codexStanding >= 100 ? /Codex's (5-hour|weekly) limit is used up/.test(codexBefore) && /resets/.test(codexBefore)
    : codexStanding >= 80 ? /Codex is running low/.test(codexBefore)
    : codexBefore === "");
  const codexAfter = await sendAndSettle(codexChat, "Reply with only the word OK.", 180);
  const codexRun = rows("runs").find((run) => run.conversationId === codexChat);
  notes.codexTurn = { lastError: codexAfter.lastError, run: { status: codexRun?.status, model: codexRun?.model, usage: codexRun?.usage } };
  if (codexAfter.lastError) {
    // The plan is used up: Codex refused, in its own words, and the hit is recorded.
    await until(async () => Boolean((await usageOf("codex"))?.hit), "Codex's hit to be recorded", 30).catch(() => {});
    const codexHit = (await usageOf("codex"))?.hit;
    notes.codexHit = codexHit;
    check("codexRealTurn", LIMIT_HIT.test(codexAfter.lastError) && Boolean(codexHit) && codexStanding >= 100);
  } else {
    // The plan had room: its tokens count to Codex, within the 5-hour window too.
    await sleep(2_000);
    const share = (await overview()).engines.find((engine) => engine.kind === "codex")!.share;
    notes.codexShare = share;
    check("codexRealTurn", (codexRun?.usage?.totalTokens ?? 0) > 0 && share.week.tokens === codexRun!.usage.totalTokens && share.windows["codex:primary"]?.turns === 1);
  }

  // --- 6, 7. Running low: a 5-hour window at 85%, and a weekly one at 100% whose reset has passed ------------
  const claudeChat = await newChat("Usage check on Claude Code", "default", "claude");
  await call("usage:report", {
    token, engine: "claude", limits: {
      plan: "max", at: Date.now(), windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 85, resetsAt: Date.now() + 90 * 60_000, minutes: 300 },
        { id: "seven_day", label: "Weekly", usedPercent: 100, resetsAt: Date.now() - 60_000, minutes: 10080 },
      ],
    },
  });
  await openChatPage(claudeChat);
  await until(async () => /running low/.test(await note()), "the running-low note", 20).catch(() => {});
  const lowNote = await note();
  await shot("chat-claude-low.png");
  notes.lowNote = lowNote;
  check("chatWarnsRunningLow", /Claude Code is running low/.test(lowNote) && /85% of the 5-hour limit is used; it resets at/.test(lowNote));
  check("passedResetNotFull", !/used up/.test(lowNote));

  // --- 9. Settings → Usage -------------------------------------------------------------------------------------
  await send("Page.navigate", { url: `${BASE}/settings?tab=usage` });
  await until(() => evaluate(`Boolean(document.querySelector('section[aria-label="Your plans"] li'))`), "the Usage tab", 30);
  await sleep(1_500);
  const plans = await evaluate(`document.querySelector('section[aria-label="Your plans"]').innerText`) as string;
  const share = await evaluate(`document.querySelector('section[aria-label="Perry\\'s share this week"]').innerText`) as string;
  await evaluate(`window.scrollTo(0, 0); true`);
  await shot("settings-usage.png");
  await evaluate(`document.querySelector('section[aria-label="Perry\\'s share this week"]').scrollIntoView(); true`);
  await shot("settings-usage-share.png");
  notes.usageTab = { plans, share };
  check("usageShowsCodexWindows", /Codex/.test(plans) && /5-hour/.test(plans) && /Weekly/.test(plans) && /% used/.test(plans) && /resets/.test(plans) && /counts all your Codex use/.test(plans));
  check("usageSaysWhoReportsNothing", /Grok Build doesn't say how much of your plan is used or left/.test(plans) && /Antigravity reports neither/.test(plans));
  // Two Grok replies of 1,280 tokens each; the refused one used none, and neither did a Codex message it refused.
  const refusedCodex = Boolean(notes.codexHit);
  check("usageShowsPerrysShare", /Usage check on Grok/.test(share) && /2\.6k tokens/i.test(share) && /2 replies/.test(share) && /Grok Build/.test(share)
    && (!refusedCodex || !/Usage check on Codex/.test(share)));
  check("dashboardDidNotThrow", errors.length === 0, errors);
} catch (error) {
  check("ranToTheEnd", false, error instanceof Error ? error.stack : String(error));
}
const passed = await p.finish({ codexModel: MODEL, grok: "fake (artifacts/engine-acp/fake-agent.ts --profile grok)" });
process.exit(passed ? 0 : 1);
