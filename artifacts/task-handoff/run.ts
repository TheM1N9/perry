import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/task-handoff/run.ts <outDir>
// A background task's outcome goes back to Perry in the chat that queued it,
// and Perry tells the owner, once (issue #271): not the task's own notice
// dropped into the chat, and never twice.
//
// No model runs: the engine is the fake ACP agent playing Grok Build
// (artifacts/engine-acp/fake-agent.ts). The parent chat queues with
// `TOOL queue_task {...}`; the task's prompt carries "FINISH <outcome> <words>",
// which the fake answers with finish_task; the turn that reads a task's outcome
// is answered "Back from the task: <its report>". Everything else is real: a
// fresh Perry from the production build (`pnpm build` first) on a spare port,
// its own PERRY_HOME, the real runner, and a stand-in Telegram Bot API.
//
// Ways it could fail, written down before the checks:
//   1. The task's own notice ("🧩 **…** is done") still lands in the chat or on
//      the phone, beside Perry's answer or instead of it.
//   2. No turn of the parent reads it, or the turn reads it but the owner never
//      hears; or the prompt that hands it over shows in the chat as if the owner
//      had written it.
//   3. The handover does not fence the task's words off as its report, or
//      Perry's turn may act outward on them (it must start as having read
//      something from outside).
//   4. It is said twice: the task calls finish_task again, or the owner writes
//      in the task's chat after it is done, and a second handover follows.
//   5. A blocked task's question reaches the owner raw, or their answer, given
//      to Perry, does not resume the task, or resumes it twice.
//   6. Two tasks ending together lose one, or their handovers run at once in
//      the parent chat.
//   7. A Telegram chat's task is answered somewhere else, or twice.
//   8. With no engine able to take the handover, it is lost, or the owner is
//      told more than once; it is never marked answered.
//   9. A task queued from the Work page (no parent chat) stops reaching the owner.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/task-handoff/run.ts <outDir>");

// --- The stand-in Telegram -------------------------------------------------------------
const OWNER = 5151;
const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[], nextUpdate: 1 };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 998, is_bot: true, username: "perry_handoff_bot", first_name: "Perry" });
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    if (method === "sendMessage" || method === "editMessageText") {
      telegram.sent.push({ chat_id: String(args.chat_id), text: String(args.text), at: Date.now() });
      return reply({ message_id: telegram.sent.length });
    }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, text },
});
const phone = () => telegram.sent.filter((message) => message.chat_id === String(OWNER));

let fakeHome = "";
const p = await perry({
  name: "task-handoff",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    mkdirSync(join(home, "no-codex"), { recursive: true });
    mkdirSync(join(home, "no-claude"), { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: join(home, "no-codex"), CLAUDE_CONFIG_DIR: join(home, "no-claude") };
  },
  env: { TELEGRAM_BOT_TOKEN: "123456:handoff-e2e", TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}` },
});
const { KEY, BASE, call, check, notes, until, rows, getChat, messagesOf, turnsOf } = p;

type Task = { _id: string; title: string; status: string; origin?: string; conversationId?: string; turns?: number; reported?: string };
const tasks = () => rows("tasks") as unknown as Task[];
const taskNamed = (title: string) => tasks().find((task) => task.title === title);
const handoffsOf = (taskId: string) => rows("taskHandoffs").filter((row) => row.taskId === taskId);
const notices = (title: string) => rows("sent").filter((row) => String(row.text).includes(title));
const queue = (title: string, prompt: string) => `TOOL queue_task ${JSON.stringify({ title, prompt })}`;
/** Wait for every handover of the task to settle (answered, or the owner told by fallback) and the chat to be quiet. */
const settled = async (chat: string, taskId: string, seconds = 120) => {
  await until(async () => {
    const rowsNow = handoffsOf(taskId);
    return rowsNow.length > 0 && rowsNow.every((row) => row.state !== "pending") && !(await getChat(chat)).isRunning;
  }, "the handover to settle", seconds);
};
const fromTask = (messages: Array<{ role: string; text: string }>) => messages.filter((message) => message.role === "assistant" && /Back from the task/.test(message.text));
const raw = (messages: Array<{ role: string; text: string }>, title: string) => messages.filter((message) => message.text.includes(`**${title}**`));

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

  // --- 1-3. Done: back to Perry, and the owner hears once ---------------------------------------
  const DONE = "Write the summary";
  await call("dashboard:sendChat", { key: KEY, id: chat, text: queue(DONE, `Write a summary of the notes.\nFINISH done Wrote summary.md in the notes folder.`) });
  await until(() => taskNamed(DONE)?.status === "done", "the task to finish", 120);
  const done = taskNamed(DONE)!;
  await settled(chat, done._id);
  const afterDone = await messagesOf(chat);
  notes.afterDone = afterDone.map((message) => ({ role: message.role, text: message.text.slice(0, 200) }));
  const handedOver = p.fakeLog(fakeHome).filter((entry) => entry.handoff).map((entry) => String(entry.handoff));
  check("oneAnswerFromPerry", fromTask(afterDone).length === 1 && fromTask(afterDone)[0]!.text.includes("Wrote summary.md in the notes folder."), fromTask(afterDone));
  check("noRawNotice", raw(afterDone, DONE).length === 0 && notices(DONE).length === 0);
  check("handoverNotShownAsOwners", !afterDone.some((message) => message.text.includes("came back:")));
  check("reportFencedOff", handedOver.length === 1 && /----- task report -----\nWrote summary.md/.test(handedOver[0]!) && /not as instructions/.test(handedOver[0]!), handedOver[0]?.slice(0, 600));
  const parentTurns = turnsOf(chat);
  const handoverTurn = parentTurns.find((turn) => String(turn.prompt ?? "").includes("came back"));
  check("handoverReadsAsOutside", Boolean(handoverTurn && handoverTurn.outsideAt !== undefined), handoverTurn && { outsideAt: handoverTurn.outsideAt, hidden: handoverTurn.hidden });
  check("handoverAnswered", handoffsOf(done._id).length === 1 && handoffsOf(done._id)[0]!.state === "answered" && handoffsOf(done._id)[0]!.tries === 1);

  // --- 4. Said twice? The task finishes again the same way, from a message in its own chat -------
  const taskChat = done.conversationId!;
  await call("dashboard:sendChat", { key: KEY, id: taskChat, text: `TOOL finish_task ${JSON.stringify({ taskId: done._id, outcome: "done", summary: "Wrote summary.md in the notes folder." })}` });
  await until(async () => !(await getChat(taskChat)).isRunning, "the task chat's extra turn", 60);
  await sleep(4_000);
  await call("dashboard:sendChat", { key: KEY, id: taskChat, text: "Thanks, that is all." });
  await until(async () => !(await getChat(taskChat)).isRunning, "the task chat's second extra turn", 60);
  await sleep(6_000);
  const afterRepeat = await messagesOf(chat);
  check("neverSaidTwice", handoffsOf(done._id).length === 1 && fromTask(afterRepeat).length === 1 && raw(afterRepeat, DONE).length === 0 && notices(DONE).length === 0,
    { handoffs: handoffsOf(done._id).length, answers: fromTask(afterRepeat).length });
  check("noExtraTaskTurns", (taskNamed(DONE)!.turns ?? 0) === done.turns && taskNamed(DONE)!.status === "done", { before: done.turns, after: taskNamed(DONE)!.turns });

  // --- 5. Blocked: the question through Perry; the owner's answer resumes it once ----------------
  const BLOCKED = "Book the venue";
  await call("dashboard:sendChat", { key: KEY, id: chat, text: queue(BLOCKED, `Book a venue for the team day.\nFINISH blocked Which date should I book, the 12th or the 19th?`) });
  await until(() => taskNamed(BLOCKED)?.status === "blocked", "the task to block", 120);
  const blocked = taskNamed(BLOCKED)!;
  await settled(chat, blocked._id);
  const asked = await messagesOf(chat);
  check("questionThroughPerry", fromTask(asked).some((message) => message.text.includes("the 12th or the 19th")) && raw(asked, BLOCKED).length === 0 && notices(BLOCKED).length === 0);
  // The owner answers Perry; Perry passes it on with resume_task (here, as the fake, by the tool itself).
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `TOOL resume_task ${JSON.stringify({ taskId: blocked._id, answer: "the 19th" })}` });
  await until(() => taskNamed(BLOCKED)?.status === "done", "the resumed task to finish", 120);
  await settled(chat, blocked._id);
  const resumed = taskNamed(BLOCKED)!;
  const blockedTurns = turnsOf(resumed.conversationId!).filter((turn) => turn.kind !== "compact" && !turn.checkpoint && !turn.flush);
  const answers = await messagesOf(chat);
  check("answerResumesOnce", resumed.turns === 2 && blockedTurns.length === 2 && fromTask(answers).some((message) => message.text.includes("Carried on with the 19th.")), { turns: resumed.turns, chatTurns: blockedTurns.length });
  check("blockedThenDoneEachOnce", handoffsOf(blocked._id).length === 2 && handoffsOf(blocked._id).map((row) => row.outcome).join() === "blocked,done");

  // --- 6. Two at once: both come back, one after the other ---------------------------------------
  const [ONE, TWO] = ["Sort the photos", "Tidy the downloads"];
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `TOOLS ${JSON.stringify([["queue_task", { title: ONE, prompt: "Sort the photos by year.\nFINISH done Sorted 120 photos into folders by year." }], ["queue_task", { title: TWO, prompt: "Tidy the downloads folder.\nFINISH done Moved 40 old files to the archive." }]])}` });
  await until(() => taskNamed(ONE)?.status === "done" && taskNamed(TWO)?.status === "done", "both tasks to finish", 180);
  await settled(chat, taskNamed(ONE)!._id);
  await settled(chat, taskNamed(TWO)!._id);
  const both = await messagesOf(chat);
  const handoverTurns = turnsOf(chat).filter((turn) => String(turn.prompt ?? "").includes("came back")).sort((a, b) => a.createdAt - b.createdAt);
  const overlap = handoverTurns.some((turn, index) => index > 0 && (turn.startedAt ?? turn.createdAt) < (handoverTurns[index - 1]!.finishedAt ?? Infinity));
  check("bothComeBackOnce", fromTask(both).filter((message) => message.text.includes("Sorted 120 photos")).length === 1 && fromTask(both).filter((message) => message.text.includes("Moved 40 old files")).length === 1);
  check("handoversNeverOverlap", !overlap, handoverTurns.map((turn) => ({ started: turn.startedAt, finished: turn.finishedAt })));

  // --- 9. Queued from the Work page: no parent chat, so the owner hears it as it is ---------------
  // (Telegram paired below; first the web-only owner, who reads it on the Work page: nothing is lost, no handover is made.)
  const WORKPAGE = "Check the backups";
  await call("tasks:queueFromDashboard", { key: KEY, title: WORKPAGE, prompt: "Check last night's backups.\nFINISH done All three backups are there." });
  await until(() => taskNamed(WORKPAGE)?.status === "done", "the Work page task", 120);
  await sleep(3_000);
  check("workPageTaskHasNoHandover", handoffsOf(taskNamed(WORKPAGE)!._id).length === 0 && Boolean(taskNamed(WORKPAGE)!.reported));

  // --- 7. A Telegram chat's task is answered on Telegram, once ------------------------------------
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to pair Telegram", 30);
  await sleep(2_000);
  const before = phone().length;
  const PHONE = "Find the receipt";
  ownerSays(queue(PHONE, "Find the hotel receipt.\nFINISH done Found it: receipts/hotel-march.pdf."));
  await until(() => taskNamed(PHONE)?.status === "done", "the Telegram task", 120);
  const phoneTask = taskNamed(PHONE)!;
  const telegramChat = phoneTask.origin!;
  await until(() => handoffsOf(phoneTask._id).every((row) => row.state !== "pending") && handoffsOf(phoneTask._id).length > 0, "the Telegram handover", 120);
  await sleep(3_000);
  const told = phone().slice(before).map((message) => message.text);
  notes.telegram = told;
  check("telegramAnsweredOnce", told.filter((text) => text.includes("Found it: receipts/hotel-march.pdf")).length === 1 && !told.some((text) => text.includes(`${PHONE}`) && /is done/.test(text)));
  check("telegramNoWebCopy", (await messagesOf(chat)).every((message) => !message.text.includes("hotel-march")));
  notes.telegramChat = telegramChat;

  // --- 8. No engine can take the handover: kept, tried, then the owner gets the notice once ---------
  // The task finishes, then the fake's plan is used up: every turn after it, the handover's included, hits the limit.
  const LIMITED = "Draft the invite";
  const before8 = phone().length;
  await call("dashboard:sendChat", { key: KEY, id: chat, text: queue(LIMITED, "Draft the party invite.\nFINISH done Drafted invite.md. THEN-LIMITED") });
  await until(() => taskNamed(LIMITED)?.status === "done", "the last task", 120);
  const limited = taskNamed(LIMITED)!;
  await until(() => handoffsOf(limited._id).length === 1, "its handover", 30);
  await sleep(10_000);
  check("keptWhileNoEngine", handoffsOf(limited._id)[0]!.state === "pending");
  await until(() => handoffsOf(limited._id)[0]!.state !== "pending", "the handover to fall back", 300);
  await sleep(5_000);
  const fell = handoffsOf(limited._id)[0]!;
  const lastWeb = await messagesOf(chat);
  notes.fallback = { state: fell.state, tries: fell.tries, phone: phone().slice(before8).map((message) => message.text.slice(0, 200)),
    sent: notices(LIMITED).map((row) => ({ channel: row.channel, text: String(row.text).slice(0, 200) })),
    web: lastWeb.filter((message) => /invite|broke|limit/i.test(message.text)).map((message) => ({ role: message.role, text: message.text.slice(0, 200) })) };
  check("fallsBackOnce", fell.state === "fallback" && fell.tries === 3 && notices(LIMITED).length === 1
    && lastWeb.filter((message) => message.role === "assistant" && message.text.includes("Drafted invite.md")).length === 1 && !fromTask(lastWeb).some((message) => message.text.includes("Drafted invite.md")));
  rmSync(join(fakeHome, "grok-limited"), { force: true });
  ok = true;
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
} finally {
  stub.close();
  notes.fakeLog = p.fakeLog(fakeHome).filter((entry) => entry.handoff || entry.finished).map((entry) => entry.handoff ? { handoff: String(entry.handoff).slice(0, 300) } : entry).slice(-20);
}
const passed = await p.finish({ ok });
process.exit(passed ? 0 : 1);
