import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/access-and-effort/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch started with --auto, CONVEX_URL
// and E2E_WORKDIR. Uses new web chats only; nothing is sent to Telegram. The
// Supervised step sets the runner's policy to "ask" for one turn, and every
// setting it changes is put back at the end, pass or fail.
//
// Ways thinking levels and access can fail, and what this checks for each:
// Thinking level
// - The runner does not report efforts from model/list (wrong field names), so
//   the composer has no level picker: its options must be Default plus exactly
//   the chosen model's efforts from models.options, and that list non-empty.
// - /think is sent to Codex as a message, or lists the wrong levels: the notice
//   must start "Thinking levels for" and name each level, and no message sent.
// - A level the model does not take is saved: "/think bogus" must say so, stay
//   in the box, and leave the chat's effort unchanged.
// - The level picked before the chat exists is lost when it is created, or a
//   later /think does not reach the next turn: after "/think <low>" and a
//   message, then "/think <high>" and a message, the chat's effort, each
//   turn's requestedEffort and each run's label ("· <level>") must follow.
// - The runner drops `effort` from turn/start, or sends it under another name:
//   Codex's own session file for the chat's thread must record effort <low>
//   then <high> in its turn_context entries (checked when ~/.codex is here).
// - "/think default" leaves the old level on the thread: the chat's effort
//   must clear, and /think must mark default.
// Access
// - The default for new chats is ignored: with it set to Full access, a new
//   chat must start on Full access, and the composer must show it before the
//   chat exists; then it is put back.
// - /access does not switch, or the composer does not show Full access clearly:
//   after "/access full" the chat's access must be "full", its picker marked
//   `.full`, and the Full access warning shown under the composer.
// - Full access still sandboxes or asks: asked to write a file in the home
//   folder (outside the workspace, not in temp), the file must exist with "ok",
//   no approval row may exist for the chat, the turn must carry access "full",
//   its run label must say "full access", and the session must record
//   sandbox danger-full-access and approval policy never.
// - Switching back mid-chat keeps the old settings on the thread: after
//   "/access supervised" in the same chat and with the runner's policy "ask",
//   the same request must raise a pending approval for this chat (declined
//   here from the dashboard), the file must not exist, the approval must end
//   declined by the dashboard, and the session's last turn must be back on
//   workspace-write with approval policy on-request.
// - Any of this throws in the page: no page errors.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
// No policy here: the Supervised step sets the runner's own, and a check-in would reset it.
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
// An empty table prints nothing at all.
const table = (name: string) => JSON.parse(cli("data", name, "--limit", "100", "--order", "desc", "--format", "jsonArray").trim() || "[]") as Array<Record<string, any>>;
const screenshot = async (name: string) => {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64"));
};

const type = (text: string) => evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
/** Type a command and press Enter; returns the notice, what is left in the box, and whether anything was sent. */
const command = async (text: string) => {
  await type(text);
  await sleep(300);
  await evaluate(`document.querySelector('.chat-composer-box textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(800);
  return await evaluate(`({
    notice: document.querySelector('.chat-notice pre')?.textContent ?? null,
    draft: document.querySelector('.chat-composer-box textarea').value,
    sentAnything: document.querySelectorAll('.chat-turn.from-user').length > 0,
  })`) as { notice: string | null; draft: string; sentAnything: boolean };
};
const composer = () => evaluate(`({
  efforts: [...document.querySelectorAll('select.chat-effort option')].map((option) => option.value),
  effort: document.querySelector('select.chat-effort')?.value ?? null,
  access: document.querySelector('select.chat-access')?.value ?? null,
  accessMarked: Boolean(document.querySelector('select.chat-access.full')),
  warning: document.querySelector('.chat-access-warning')?.textContent ?? null,
})`) as Promise<{ efforts: string[]; effort: string | null; access: string | null; accessMarked: boolean; warning: string | null }>;
const newChat = async () => { await evaluate(`document.querySelector('.chat-header-new').click(); true`); await sleep(500); };
const chatIdInPage = async () => await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`) as Id<"conversations">;
const assistantCount = async (id: Id<"conversations">) => (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id, paginationOpts: { numItems: 50, cursor: null } }))
  .page.filter((message) => message.role === "assistant").length;
/** Send from the composer, and wait for the reply to be saved and the chat to be free. */
const sendAndWait = async (text: string, before: number, onRunning?: (id: Id<"conversations">) => Promise<void>) => {
  await type(text);
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  await sleep(1500);
  const id = await chatIdInPage();
  // Recorded at once, so a failure later still deletes the chat.
  if (!chats.includes(id)) chats.push(id);
  if (onRunning) await onRunning(id);
  const start = Date.now();
  while (Date.now() - start < 300_000) {
    const chat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id });
    if (chat && !chat.isRunning && await assistantCount(id) > before) {
      const messages = (await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id, paginationOpts: { numItems: 50, cursor: null } })).page;
      return { id, reply: messages.sort((a, b) => a.createdAt - b.createdAt).filter((message) => message.role === "assistant").at(-1)?.text ?? "" };
    }
    if (chat && !chat.isRunning && chat.lastError) return { id, reply: "", error: chat.lastError };
    await sleep(1000);
  }
  throw new Error(`no reply to "${text.slice(0, 40)}"`);
};

/** The turn_context entries Codex wrote for a thread, oldest first; null when its session file is not on this machine. */
function sessionTurns(threadId?: string): Array<{ effort?: string; approval_policy?: unknown; sandbox?: string }> | null {
  if (!threadId) return null;
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  if (!existsSync(root)) return null;
  const file = (readdirSync(root, { recursive: true }) as string[]).find((name) => name.endsWith(`${threadId}.jsonl`));
  if (!file) return null;
  return readFileSync(join(root, file), "utf8").split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.type === "turn_context" ? [{ effort: entry.payload.effort, approval_policy: entry.payload.approval_policy, sandbox: entry.payload.sandbox_policy?.type }] : [];
    } catch { return []; }
  });
}
const conversation = (id: string) => table("conversations").find((row) => row._id === id);
const turnsOf = (id: string) => table("codexTurns").filter((turn) => turn.conversationId === id).sort((a, b) => a.createdAt - b.createdAt);
const runsOf = async (id: Id<"conversations">) => (await convex.query(api.dashboard.listRuns, { key: dashboardKey, conversationId: id }))
  .sort((a, b) => a.startedAt - b.startedAt).map((run) => ({ prompt: run.prompt.slice(0, 40), status: run.status, model: run.model }));

const stamp = Date.now();
const fullTarget = join(homedir(), `perry-e2e-full-access-${stamp}.txt`);
const supervisedTarget = join(homedir(), `perry-e2e-supervised-${stamp}.txt`);
const writeRequest = (target: string) => `This is an automated test of access. Use your shell to write the word ok into the file ${target}. `
  + "That path is outside your workspace; if you need approval to write it, request it, and do not write anywhere else. Then reply in one short sentence saying whether it worked.";

const originalDefault = await convex.query(api.dashboard.getDefaultAccess, { key: dashboardKey });
const me = await checkIn();
const runner = (await convex.query(api.dashboard.getCompute, { key: dashboardKey })).runners
  .filter((item) => item.name === me.name && !item.revoked)
  .sort((a, b) => Number(b.workdir === process.env.E2E_WORKDIR) - Number(a.workdir === process.env.E2E_WORKDIR))[0];
if (!runner) throw new Error("The test runner is not on the Computer page.");
const originalPolicy = runner.policy;
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
const chats: Id<"conversations">[] = [];
const result: Record<string, unknown> = { ranAt: new Date().toISOString() };
let pass = false;

try {
  // 1. The default for new chats.
  await convex.mutation(api.dashboard.setDefaultAccess, { key: dashboardKey, access: "full" });
  await newChat();
  await sleep(800);
  const draftComposer = await composer();
  const made = await convex.mutation(api.dashboard.createChat, { key: dashboardKey });
  chats.push(made);
  const madeChat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: made });
  await convex.mutation(api.dashboard.setDefaultAccess, { key: dashboardKey, access: "supervised" });
  const defaults = { draftComposer, newChatAccess: madeChat.access };

  // 2. Thinking levels, picked before the chat exists and after.
  await newChat();
  const options = (await convex.query(api.models.options, { key: dashboardKey })).codex;
  const model = options.find((item) => item.isDefault) ?? options[0];
  const levels = model?.efforts ?? [];
  if (!levels.length) throw new Error("The runner reported no thinking levels; is it on this branch?");
  const low = levels.includes("low") ? "low" : levels[0];
  const high = levels.includes("high") ? "high" : levels.at(-1)!;
  const picker = await composer();
  const listed = await command("/think");
  const bogus = await command("/think bogus");
  const effortAfterBogus = (await composer()).effort;
  await type("");
  const setLow = await command(`/think ${low}`);
  const first = await sendAndWait("This is an automated test. Reply with the single word pong.", 0);
  const setHigh = await command(`/think ${high}`);
  const afterHigh = await composer();
  const second = await sendAndWait("This is an automated test. Reply with the single word ping.", 1);
  const thinkChat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: first.id });
  const setDefault = await command("/think default");
  const clearedChat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: first.id });
  const listedAfter = await command("/think");
  await screenshot("thinking-levels.png");
  const thinkTurns = turnsOf(first.id);
  const thinkRuns = await runsOf(first.id);
  const thinkSession = sessionTurns(conversation(first.id)?.codexThreadId);
  const thinking = {
    model: model.id,
    levels,
    picker,
    listed,
    bogus: { ...bogus, effortAfter: effortAfterBogus },
    setLow: setLow.notice,
    setHigh: setHigh.notice,
    afterHigh,
    effortAfterHigh: thinkChat.effort,
    replies: [first.reply, second.reply],
    turns: thinkTurns.map((turn) => ({ requestedEffort: turn.requestedEffort, access: turn.access ?? null })),
    runs: thinkRuns,
    session: thinkSession?.map((turn) => turn.effort) ?? null,
    setDefault: setDefault.notice,
    effortAfterDefault: clearedChat.effort ?? null,
    listedAfterDefault: listedAfter.notice,
  };

  // 3. Full access, switched on with /access in a new chat.
  await newChat();
  rmSync(fullTarget, { force: true });
  rmSync(supervisedTarget, { force: true });
  const accessBefore = await command("/access");
  const toFull = await command("/access full");
  const fullComposer = await composer();
  const fullTurn = await sendAndWait(writeRequest(fullTarget), 0);
  await screenshot("full-access.png");
  const fullChat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id: fullTurn.id });
  const fullWritten = existsSync(fullTarget) ? readFileSync(fullTarget, "utf8").trim() : null;
  const approvalsAfterFull = table("approvals").filter((row) => row.conversationId === fullTurn.id);

  // 4. Back to Supervised in the same chat, with the runner asking the owner.
  const toSupervised = await command("/access supervised");
  await convex.mutation(api.dashboard.setRunnerPolicy, { key: dashboardKey, runnerId: runner.id, policy: "ask" });
  let asked: { id: Id<"approvals">; title: string } | null = null;
  const supervisedTurn = await sendAndWait(writeRequest(supervisedTarget), 1, async (id) => {
    const start = Date.now();
    while (!asked && Date.now() - start < 240_000) {
      const pending = await convex.query(api.approvals.pending, { key: dashboardKey });
      const mine = pending.find((row) => row.chat?.id === id);
      if (mine) asked = { id: mine.id, title: mine.title };
      else await sleep(500);
    }
    if (!asked) throw new Error("the Supervised turn never asked for approval");
    await sleep(1500);
    await screenshot("supervised-approval.png");
    await convex.mutation(api.approvals.decide, { key: dashboardKey, id: asked.id, approved: false });
  });
  await convex.mutation(api.dashboard.setRunnerPolicy, { key: dashboardKey, runnerId: runner.id, policy: originalPolicy });
  const supervisedWritten = existsSync(supervisedTarget);
  const approvalRows = table("approvals").filter((row) => row.conversationId === fullTurn.id);
  const accessTurns = turnsOf(fullTurn.id);
  const accessRuns = await runsOf(fullTurn.id);
  const accessSession = sessionTurns(conversation(fullTurn.id)?.codexThreadId);
  const statusAfter = await command("/access");

  const access = {
    defaults,
    accessBefore: accessBefore.notice,
    toFull: toFull.notice,
    fullComposer,
    fullChatAccess: fullChat.access,
    fullReply: fullTurn.reply,
    fullWritten,
    approvalsDuringFull: approvalsAfterFull.length,
    toSupervised: toSupervised.notice,
    asked,
    supervisedReply: supervisedTurn.reply,
    supervisedWritten,
    approvals: approvalRows.map((row) => ({ title: row.title.slice(0, 160), status: row.status, decidedBy: row.decidedBy ?? null })),
    turns: accessTurns.map((turn) => ({ access: turn.access ?? null, requestedEffort: turn.requestedEffort ?? null })),
    runs: accessRuns,
    session: accessSession?.map((turn) => ({ sandbox: turn.sandbox, approvalPolicy: turn.approval_policy })) ?? null,
    statusAfter: statusAfter.notice,
  };
  Object.assign(result, { chats, thinking, access });

  const lowRun = thinkRuns[0]?.model ?? "";
  const highRun = thinkRuns[1]?.model ?? "";
  // One turn_context per turn today; checked by order rather than position in case Codex writes more.
  const sessionEfforts = thinkSession?.map((turn) => turn.effort) ?? [];
  const thinkingPass = picker.efforts.join(",") === ["", ...levels].join(",")
    && (listed.notice ?? "").startsWith(`Thinking levels for ${model.name}`) && levels.every((level) => listed.notice!.includes(level)) && !listed.sentAnything
    && (bogus.notice ?? "").includes('no thinking level "bogus"') && bogus.draft === "/think bogus" && effortAfterBogus === ""
    && thinkTurns.length === 2 && thinkTurns[0].requestedEffort === low && thinkTurns[1].requestedEffort === high
    && lowRun.endsWith(`· ${low}`) && highRun.endsWith(`· ${high}`) && thinkRuns.every((run) => run.status === "ok")
    && afterHigh.effort === high && thinkChat.effort === high
    && (thinkSession === null || (sessionEfforts.includes(low) && sessionEfforts.at(-1) === high && sessionEfforts.lastIndexOf(low) < sessionEfforts.lastIndexOf(high)))
    && clearedChat.effort === undefined && (listedAfter.notice ?? "").includes("• default");
  const fullIndex = accessSession?.findIndex((turn) => turn.sandbox === "danger-full-access") ?? -1;
  const fullSession = accessSession?.[fullIndex];
  const supervisedSession = fullIndex >= 0 ? accessSession?.slice(fullIndex + 1).at(-1) : undefined;
  const accessPass = draftComposer.access === "full" && draftComposer.accessMarked && madeChat.access === "full"
    && (accessBefore.notice ?? "").startsWith("This chat is Supervised")
    && fullComposer.access === "full" && fullComposer.accessMarked && Boolean(fullComposer.warning)
    && fullChat.access === "full" && fullWritten === "ok" && approvalsAfterFull.length === 0
    && accessTurns[0]?.access === "full" && (accessRuns[0]?.model ?? "").endsWith("· full access")
    && (accessSession === null || (fullSession?.sandbox === "danger-full-access" && fullSession?.approval_policy === "never"))
    && Boolean(asked) && !supervisedWritten
    && approvalRows.length >= 1 && approvalRows.some((row) => row.status === "declined" && row.decidedBy === "dashboard")
    && accessTurns[1]?.access === "supervised" && !(accessRuns[1]?.model ?? "").includes("full access")
    && (accessSession === null || (supervisedSession?.sandbox === "workspace-write" && supervisedSession?.approval_policy === "on-request"))
    && (statusAfter.notice ?? "").startsWith("This chat is Supervised");
  result.sessionFilesChecked = thinkSession !== null && accessSession !== null;
  result.thinkingPass = thinkingPass;
  result.accessPass = accessPass;
  pass = thinkingPass && accessPass && errors.length === 0;
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  clearInterval(heartbeat);
  // Put back everything this changed, pass or fail, and leave nothing waiting on the runner.
  const waiting = await convex.query(api.approvals.pending, { key: dashboardKey }).catch(() => []);
  for (const row of waiting.filter((item) => item.chat && chats.includes(item.chat.id))) {
    await convex.mutation(api.approvals.decide, { key: dashboardKey, id: row.id, approved: false }).catch(() => {});
  }
  await convex.mutation(api.dashboard.setRunnerPolicy, { key: dashboardKey, runnerId: runner.id, policy: originalPolicy }).catch(() => {});
  await convex.mutation(api.dashboard.setDefaultAccess, { key: dashboardKey, access: originalDefault }).catch(() => {});
  rmSync(fullTarget, { force: true });
  rmSync(supervisedTarget, { force: true });
  for (const id of chats) {
    for (let i = 0; i < 30; i += 1) {
      const chat = await convex.query(api.dashboard.getChat, { key: dashboardKey, id }).catch(() => null);
      if (!chat?.isRunning) break;
      await sleep(1000);
    }
    await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id }).catch((error) => console.error(`could not delete ${id}: ${String(error)}`));
  }
  result.cleanedUp = { policy: originalPolicy, defaultAccess: originalDefault, chatsDeleted: chats.length };
  result.pageErrors = errors;
  result.pass = pass;
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  close();
}
process.exit(pass ? 0 : 1);
