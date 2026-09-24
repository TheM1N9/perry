import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/offline-fallback/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner named e2e-offline-fallback on this branch
// (its own PERRY_HOME, signed in to ChatGPT), CONVEX_URL and E2E_WORKDIR.
// Web chats only; nothing is sent to Telegram.
//
// How answering without the computer could fail, and what this checks:
// 1. The runner never pushes a token (getAuthStatus shape wrong, setting not
//    seen on check-in, push rejected): a valid token for the test runner must
//    appear in Convex after the setting is turned on.
// 2. The first turn goes to the fallback although the runner is online: the
//    normal turn's run model must be a Codex one, and its turn must carry the
//    test runner's id.
// 3. The chat is not bound to the test runner, so killing it changes nothing:
//    checked through that same turn's runner id.
// 4. With the runner gone, the turn still fails with "runner offline" (setting
//    not read, token thought expired, wrong conditions): the second reply must
//    arrive at all.
// 5. The ChatGPT request is malformed for the Codex backend (instructions,
//    store, max_output_tokens, item ids, account header) or not authorised:
//    the reply must be exactly "42", not an error.
// 6. The reply is not marked: its run model must start with "chatgpt fallback",
//    the message must carry `fallback`, and the note must show in the chat.
// 7. Tools are not bound in-process (missing ctx, wrong userId): asking it to
//    remember must call `remember` and store the marker, and asking again must
//    bring the marker back.
// 8. The token leaks to the dashboard: no public query's result may contain
//    the stored access token, or its tail.
// 9. The test leaves traces: the setting is restored, the memory deleted and
//    the chat deleted, even when a check fails.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
const NAME = "e2e-offline-fallback";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
// An empty table prints nothing at all.
const table = (name: string) => JSON.parse(cli("data", name, "--limit", "100", "--format", "jsonArray").trim() || "[]") as Array<Record<string, any>>;
const waitFor = async <T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 180_000): Promise<T> => {
  for (const start = Date.now(); Date.now() - start < ms; await sleep(1000)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};

const runner = table("runners").find((row) => row.token === runnerToken);
if (!runner) throw new Error("No runner has that token.");
const runnerId = runner._id as Id<"runners">;
const before = await convex.query(api.chatgpt.status, { key: dashboardKey });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const checks: Record<string, unknown> = {};
let chatId: Id<"conversations"> | undefined;
let marker = "";
let heartbeat: ReturnType<typeof setInterval> | undefined;
let pass = false;

const messages = async () => (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: chatId!, paginationOpts: { numItems: 50, cursor: null } })).page.slice().reverse();
const runs = () => convex.query(api.dashboard.listRuns, { key: dashboardKey, conversationId: chatId });
/** Type into the composer and send, then wait for the reply that follows and its run. */
const ask = async (text: string) => {
  const replies = (await messages().catch(() => [])).filter((message) => message.role === "assistant").length;
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  chatId ??= await waitFor("the chat id", async () => await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`) || null) as Id<"conversations">;
  return await waitFor(`a reply to "${text}"`, async () => {
    const chat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: chatId! });
    if (chat.isRunning) return null;
    if (chat.lastError) throw new Error(`the turn failed: ${chat.lastError}`);
    const reply = (await messages()).filter((message) => message.role === "assistant")[replies];
    const run = (await runs())[0];
    return reply && run && run.status !== "running" ? { reply, run } : null;
  });
};

try {
  // 1. The setting on, and the test runner online, sharing its token.
  await convex.mutation(api.chatgpt.setEnabled, { key: dashboardKey, enabled: true });
  await checkIn();
  // Checking in every second keeps the test runner the freshest, so the new chat binds to it.
  heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
  const pushed = await waitFor("the runner's ChatGPT token", async () => table("chatgptTokens").find((row) => row.runnerId === runnerId && row.expiresAt > Date.now() + 60_000), 120_000);
  checks.tokenPushed = { expiresAt: new Date(pushed.expiresAt).toISOString(), hasAccountId: Boolean(pushed.accountId) };

  // 2. A normal turn, on Codex through the test runner.
  await evaluate(`document.querySelector('.chat-header-new').click(); true`);
  await sleep(1000);
  const normal = await ask("This is an automated test. Reply with just the word ready.");
  const normalTurn = table("codexTurns").find((row) => row.conversationId === chatId);
  checks.normal = { reply: normal.reply.text, model: normal.run.model, runnerId: normalTurn?.runnerId, fallback: normal.reply.fallback ?? false };
  const normalOk = /ready/i.test(normal.reply.text) && !normal.reply.fallback && !String(normal.run.model).startsWith("chatgpt fallback")
    && normalTurn?.runnerId === runnerId && !normalTurn?.fallback;

  // 3. The runner dies, and its heartbeat with it; the chat's runner counts as offline after 90 seconds.
  clearInterval(heartbeat);
  heartbeat = undefined;
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${NAME}' -and $_.Name -match 'bun' } | ForEach-Object { taskkill /T /F /PID $_.ProcessId }`]);
  await sleep(95_000);
  const offline = !(await convex.query(api.codex.accounts, { key: dashboardKey })).find((account) => account.id === runnerId)?.online;

  // 4. The same chat, answered without the computer.
  const sum = await ask("What is 17 + 25? Reply with just the number.");
  const note = await evaluate(`document.querySelectorAll('.chat-fallback-note').length`);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "fallback-chat.png"), Buffer.from(shot.data, "base64"));
  checks.fallback = { offline, reply: sum.reply.text, model: sum.run.model, marked: sum.reply.fallback ?? false, notesShown: note };
  const fallbackOk = offline && sum.reply.text.trim() === "42" && String(sum.run.model).startsWith("chatgpt fallback") && sum.reply.fallback === true && note >= 1;

  // 5. Perry's own tools, in-process.
  marker = `zephyr${Math.random().toString(36).slice(2, 8)}`;
  const remembered = await ask(`This is an automated test. Remember this fact about me with your memory tool: my test marker word is ${marker}. Then reply with just the word done.`);
  const stored = await waitFor("the marker in memory", async () => {
    const found = await convex.query(api.dashboard.listMemories, { key: dashboardKey, query: marker });
    return found.some((memory) => memory.text.includes(marker)) ? found : null;
  }, 20_000).catch(() => []);
  const recalled = await ask("What is my test marker word? Check your memory, and reply with just the word.");
  checks.tools = {
    rememberCalls: remembered.run.toolCalls, stored: stored.length, recallReply: recalled.reply.text, recallCalls: recalled.run.toolCalls,
    marked: Boolean(remembered.reply.fallback && recalled.reply.fallback),
  };
  const toolsOk = Boolean(remembered.run.toolCalls?.includes("remember")) && stored.length > 0 && recalled.reply.text.includes(marker)
    && String(recalled.run.model).startsWith("chatgpt fallback");

  // 6. No public query gives the token away.
  const secret = table("chatgptTokens").find((row) => row.runnerId === runnerId)?.accessToken ?? pushed.accessToken;
  const results = await Promise.all([
    convex.query(api.chatgpt.status, { key: dashboardKey }),
    convex.query(api.codex.accounts, { key: dashboardKey }),
    convex.query(api.models.options, { key: dashboardKey }),
    convex.query(api.dashboard.listChats, { key: dashboardKey }),
    convex.query(api.dashboard.getChat, { key: dashboardKey, id: chatId! }),
    messages(),
    runs(),
    convex.query(api.dashboard.listActivitySessions, { key: dashboardKey }),
    convex.query(api.dashboard.getStatus, { key: dashboardKey }),
    convex.query(api.dashboard.getWork, { key: dashboardKey }),
    convex.query(api.dashboard.getCompute, { key: dashboardKey }),
    convex.query(api.dashboard.getKeys, { key: dashboardKey }),
    convex.query(api.dashboard.listMemories, { key: dashboardKey }),
    convex.query(api.approvals.pending, { key: dashboardKey }),
    convex.query(api.jobs.listForDashboard, { key: dashboardKey }),
    ...(await runs()).map((run) => convex.query(api.dashboard.runTrace, { key: dashboardKey, runId: run.id as Id<"runs"> })),
  ]);
  const everything = JSON.stringify(results);
  const leaked = everything.includes(secret) || everything.includes(secret.slice(-24));
  checks.tokenLeak = { queriesChecked: results.length, leaked };

  pass = normalOk && fallbackOk && toolsOk && !leaked && errors.length === 0;
} catch (error) {
  checks.error = error instanceof Error ? error.message : String(error);
} finally {
  if (heartbeat) clearInterval(heartbeat);
  // Leave nothing behind: the marker memory, the chat and the setting as it was.
  if (marker) {
    for (const memory of await convex.query(api.dashboard.listMemories, { key: dashboardKey, query: marker }).catch(() => [])) {
      if (memory.text.includes(marker)) await convex.mutation(api.dashboard.deleteMemory, { key: dashboardKey, id: memory.id });
    }
  }
  if (chatId) {
    await waitFor("the chat to finish", async () => !(await convex.query(api.dashboard.getChat, { key: dashboardKey, id: chatId! })).isRunning, 120_000).catch(() => {});
    await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id: chatId }).catch((error) => { checks.cleanupError = String(error); });
  }
  await convex.mutation(api.chatgpt.setEnabled, { key: dashboardKey, enabled: before.enabled });
}

const result = { ranAt: new Date().toISOString(), chatId, settingRestoredTo: before.enabled, ...checks, pageErrors: errors, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
