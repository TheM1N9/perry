import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/heartbeat-todos/run.ts <outDir> [--no-codex[=<why>]]
// Issue #157: the heartbeat asked "Did you manage to restock chicken today?"
// after the owner had moved that to-do to 1 Oct, because an #open daily note
// still said 29 Sep. This replays that day, with dates relative to today (the
// note says yesterday, 6-7 PM; the to-do moves to tomorrow, 18:00), on fresh
// Perrys: the production build (`pnpm build` first) on a free port, a
// PERRY_HOME in PERRY_E2E_HOMES (else the temp folder), a stand-in Telegram Bot API. The first Perry
// has no runner, so every check there is on what the heartbeat is given. The
// second has the real runner and Codex (PERRY_E2E_MODEL, else gpt-5.5), for
// one heartbeat turn; --no-codex skips it and records why in result.json.
// Both homes are deleted at the end.
//
// Ways it could fail, written down before the checks:
//   1. A note cannot be linked: remember with todoId, or add_todo with
//      noteIds, leaves the note without its to-do; a wrong to-do id is linked
//      anyway, or silently.
//   2. update_todo moves the to-do but not the note: the old note stays
//      current, still saying 29 Sep, or the new one loses its words, its #open
//      tag or its link, or the tool does not say the note followed (and the
//      model writes the change down a second time).
//   3. The heartbeat is still handed the stale thread: the linked, moved note
//      is listed among the threads to ask about while its to-do is due later,
//      or the recalled memory block still shows the old note.
//   4. The heartbeat is not given the to-do list, or no rule for it, so an old
//      note that was never linked still wins over the moved to-do.
//   5. An unlinked note is not weighed against its to-do: the owner's real
//      case (an old #open note never linked, the to-do moved with update_todo)
//      is still handed to the heartbeat to ask about before the new time.
//   6. The fix hides too much: a genuinely open thread (the dentist call, no
//      to-do) is dropped, or tied to a to-do it has nothing to do with; an
//      unlinked note about a to-do that is overdue and not done is dropped; a
//      one-word to-do ("Gym", due tomorrow) hides every note with that word.
//   7. The model's own update of a linked note (remember with supersedes=[the
//      old id]) leaves two current versions, or drops the link.
//   8. A note moved twice says both times, or nests them.
//   9. Once the to-do's time has passed and it is not done, the thread does
//      not come back, so a real "how did it go?" is lost.
//  10. Ticking off, putting back, deleting, the pet's push back: the note does
//      not follow, keeps #open after it is done, or stays #open once dropped.
// And with Codex, one heartbeat turn:
//  11. It asks about the chicken (unlinked, moved) or the car service (linked,
//      moved) before their new time.
//  12. It no longer asks about what is genuinely open: the dentist call.

const args = process.argv.slice(2);
const outDir = args.find((arg) => !arg.startsWith("--"));
if (!outDir) throw new Error("usage: bun artifacts/heartbeat-todos/run.ts <outDir> [--no-codex[=<why>]]");
const skipCodex = args.find((arg) => arg === "--no-codex" || arg.startsWith("--no-codex="));
const withCodex = !skipCodex;
const homes = process.env.PERRY_E2E_HOMES ?? tmpdir();
mkdirSync(homes, { recursive: true });
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = "heartbeat-todos-e2e-key";
const OWNER = "4242";
const TZ = "Asia/Kolkata";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

// --- Days, as the owner's clock has them -------------------------------------------------

const DAY = 86_400_000;
/** "2026-09-29" for yesterday. */
const dayOn = (offset: number) => new Date(Date.now() + offset * DAY).toLocaleDateString("en-CA", { timeZone: TZ });
/** "29 Sep 2026" for yesterday. */
const dateWords = (offset: number) => new Date(Date.now() + offset * DAY).toLocaleDateString("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
/** An ISO time with the owner's offset, as update_todo takes it. */
const isoAt = (offset: number, clock: string) => `${dayOn(offset)}T${clock}:00+05:30`;
const epochAt = (offset: number, clock: string) => Date.parse(isoAt(offset, clock));

// --- A stand-in Telegram -----------------------------------------------------------------

const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[], nextUpdate: 1 };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const input = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 1, is_bot: true, username: "perry_e2e_bot" });
    if (method === "getUpdates") {
      if (telegram.pending.length) return reply(telegram.pending.splice(0));
      return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
    }
    if (method === "sendMessage") { telegram.sent.push({ chat_id: String(input.chat_id), text: String(input.text), at: Date.now() }); return reply({ message_id: telegram.sent.length }); }
    if (method === "editMessageText") { const message = telegram.sent[Number(input.message_id) - 1]; if (message) message.text = String(input.text); return reply(true); }
    return reply(true);
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const ownerSays = (text: string) => telegram.pending.push({
  update_id: telegram.nextUpdate++,
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false, first_name: "Owner" }, text },
});
const toOwner = (after: number) => telegram.sent.filter((message) => message.chat_id === OWNER && message.at > after);

async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const stop = (child: ChildProcess | null) => {
  if (!child?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};

type Memory = { id: string; text: string; tags: string[]; todoId?: string };
type Job = { id: string; name: string; builtin?: string; chatId?: string; lastResult?: string; lastError?: string };
type Thread = { id: string; day?: string; text: string; todo?: string };
type Linked = { linkedNotes?: string[]; note?: string; error?: string };

/** A fresh Perry: its own home and port, paired with the stand-in Telegram, on the owner's timezone, its schedules paused. */
async function perry(label: string) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(homes, `perry-heartbeat-todos-${label}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env, PERRY_HOME: home, PERRY_PORT: String(port), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex",
    TELEGRAM_BOT_TOKEN: "123456:heartbeat-todos-e2e", TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
  };
  for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
  const logs = { server: "", runner: "" };
  const launch = (name: "server" | "runner") => {
    const [command, argv]: [string, string[]] = name === "server"
      ? ["node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)]]
      : [process.execPath, [join(REPO, "runner", "index.ts")]];
    const child = spawn(command, argv, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { logs[name] += chunk; });
    return child;
  };
  const server = launch("server");
  let runner: ChildProcess | null = null;
  async function call<T>(path: string, input: object = {}): Promise<T> {
    const response = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args: input }) });
    const body = await response.json() as { value?: T; error?: string };
    if (body.error) throw new Error(`${path}: ${body.error}`);
    return body.value as T;
  }
  const shutdown = async () => {
    stop(runner);
    stop(server);
    await sleep(2_000);
    writeFileSync(join(outDir!, `${label}-server.log`), logs.server.replaceAll(KEY, "<key>"));
    if (logs.runner) writeFileSync(join(outDir!, `${label}-runner.log`), logs.runner.replaceAll(KEY, "<key>"));
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  };
  try {
    await until(() => fetch(`${base}/api/backend/http/health`).then((r) => r.ok, () => false), `${label}: the server to start`, 90);
    const { code } = await call<{ code: string }>("installation:startPairing");
    ownerSays(code);
    await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, `${label}: the owner to be claimed`, 30);
    await call("jobs:setTimezone", { key: KEY, timezone: TZ });
    await until(async () => (await call<Job[]>("jobs:list")).filter((job) => job.builtin).length === 3, `${label}: the built-in jobs`, 90);
    // Only the runs this script starts: no scheduled heartbeat or summary in the middle of it.
    for (const job of (await call<Job[]>("jobs:list")).filter((item) => item.builtin)) await call("jobs:update", { id: job.id, enabled: false });
  } catch (error) {
    await shutdown();
    throw error;
  }
  const jobs = () => call<Job[]>("jobs:list");
  const heartbeat = async () => (await jobs()).find((job) => job.builtin === "heartbeat")!;
  const daily = () => call<Memory[]>("dashboard:listMemories", { key: KEY, query: "", kind: "daily" });
  const noteById = async (id: string) => (await daily()).find((memory) => memory.id === id);
  const remember = (text: string, extra: { tags?: string[]; todoId?: string; supersedes?: string[] } = {}) =>
    call<{ id: string; duplicate: boolean; superseded: number; linked?: boolean }>("memories:add", { text, tags: extra.tags ?? ["open"], source: "e2e", kind: "daily", origin: "owner", ...(extra.todoId ? { todoId: extra.todoId } : {}), ...(extra.supersedes ? { supersedes: extra.supersedes } : {}) });
  /** A to-do the owner made for a time, which may have passed (the dashboard takes any time). */
  const todo = (title: string, dueAt: number) => call<string>("todos:add", { key: KEY, title, dueAt });
  /**
   * What the heartbeat is told, in full, from a run started now. With no runner the turn cannot start, and
   * the prompt is kept in the heartbeat's chat as it was sent (a run keeps only its first 2000 characters).
   */
  async function heartbeatPrompt(): Promise<string> {
    const after = Date.now() - 1_000;
    await call("jobs:run", { id: (await heartbeat()).id });
    let prompt = "";
    await until(async () => {
      const chat = (await heartbeat()).chatId;
      const conversation = chat ? await call<{ threadId: string } | null>("conversations:getById", { id: chat }) : null;
      if (!conversation) return false;
      const { page } = await call<{ page: Array<{ _creationTime: number; message?: { role: string; content: unknown } }> }>(
        "agentStore:listMessages", { threadId: conversation.threadId, paginationOpts: { numItems: 20, cursor: null } });
      const sent = page.find((item) => item._creationTime >= after && item.message?.role === "user" && typeof item.message.content === "string" && item.message.content.includes("⏰ Heartbeat ("));
      prompt = String(sent?.message?.content ?? "");
      return Boolean(prompt);
    }, `${label}: the heartbeat's prompt`, 30);
    return prompt;
  }
  return { call, jobs, heartbeat, daily, noteById, remember, todo, heartbeatPrompt, shutdown, startRunner: () => { runner = launch("runner"); } };
}

/** The part of a heartbeat prompt listing the threads to ask about, and the part with the to-do list. */
const threadsPart = (prompt: string) => prompt.split("Threads the owner left open")[1]?.split("If the moment for one")[0] ?? "";
const todosPart = (prompt: string) => prompt.split("The owner's to-do list as it stands now")[1]?.split("Conditional delivery")[0] ?? "";

// ===========================================================================================
// Perry A: no runner. Everything the heartbeat is given, and every way a note follows a to-do.
// ===========================================================================================

const chickenWords = `The owner plans to restock chicken on ${dateWords(-1)} around 6-7 PM.`;
const dentistWords = `The owner had a call with the dentist on ${dateWords(-1)} at 16:00 about a possible filling.`;
notes.dates = { yesterday: dateWords(-1), tomorrow: dateWords(1), newDue: isoAt(1, "18:00") };
const tomorrowDue = `due ${new Date(epochAt(1, "18:00")).toLocaleString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
notes.tomorrowDue = tomorrowDue;

try {
  const a = await perry("a");
  try {
    // --- 1. Linking ---------------------------------------------------------------------------
    const chicken = await a.todo("Restock chicken", epochAt(-1, "18:00"));
    const linkedNote = await a.remember(chickenWords, { todoId: chicken });
    const dentist = await a.remember(dentistWords);
    const wrong = await a.remember("The owner wants to repaint the balcony railing.", { todoId: "not-a-todo", tags: [] });
    check("rememberLinksToTodo", linkedNote.linked === true && (await a.noteById(linkedNote.id))?.todoId === chicken);
    check("wrongTodoIdSaysSo", wrong.linked === false && !(await a.noteById(wrong.id))?.todoId);

    const plumberNote = await a.remember(`The owner needs to call the plumber about the leaking tap on ${dateWords(1)} at 11 AM.`);
    const plumber = await a.call<{ added?: { id: string } } & Linked>("todos:addFromAgent", { title: "Call the plumber", at: isoAt(1, "11:00"), noteIds: [plumberNote.id] });
    check("addTodoLinksNote", Boolean(plumber.added) && plumber.linkedNotes?.[0] === plumberNote.id && (await a.noteById(plumberNote.id))?.todoId === plumber.added?.id, plumber);

    // --- 2. update_todo moves the to-do, and the note follows ------------------------------------
    const moved = await a.call<{ updated?: { due?: string } } & Linked>("todos:updateFromAgent", { id: chicken, at: isoAt(1, "18:00") });
    const current = await a.daily();
    const follower = current.find((memory) => memory.id === moved.linkedNotes?.[0]);
    check("updateTodoSupersedesNote", !current.some((memory) => memory.id === linkedNote.id) && Boolean(follower), { moved, follower });
    check("followerSaysNewTime", Boolean(follower?.text.startsWith(chickenWords) && follower.text.includes(`(To-do: moved, now ${tomorrowDue}.)`)), follower?.text);
    check("followerKeepsOpenAndLink", Boolean(follower?.tags.includes("open") && follower.todoId === chicken));
    check("toolSaysNoteFollowed", Boolean(moved.note && /do not remember the change again/.test(moved.note)));
    check("oneCurrentChickenNote", current.filter((memory) => /restock chicken/i.test(memory.text)).length === 1);

    // --- 3, 4, 6. What the heartbeat is given -----------------------------------------------------
    const linkedPrompt = await a.heartbeatPrompt();
    notes.linkedPrompt = linkedPrompt;
    check("linkedMovedNoteNotAThread", !/chicken/i.test(threadsPart(linkedPrompt)) && !linkedPrompt.includes(follower?.id ?? "-"));
    check("plumberDueLaterNotAThread", !threadsPart(linkedPrompt).includes(plumberNote.id));
    check("genuineThreadStillListed", threadsPart(linkedPrompt).includes(dentist.id) && !/looks like the to-do|its to-do/.test(threadsPart(linkedPrompt).split("\n").find((line) => line.includes(dentist.id)) ?? ""));
    check("todoListGiven", todosPart(linkedPrompt).includes(`- Restock chicken: ${tomorrowDue}, still to come`) && /go by the to-do, whatever time the note gave/.test(linkedPrompt), todosPart(linkedPrompt));
    const context = await a.call<{ recalled: string }>("memories:context", { query: "" });
    notes.recalledMemory = context.recalled;
    check("recalledMemoryShowsFollower", context.recalled.includes(`${follower?.id}; follows to-do ${chicken}`) && !context.recalled.includes(linkedNote.id));

    // --- 7. The model writes its own update of the note, naming the old id -------------------------
    const rewrite = await a.remember(`The owner will restock chicken on ${dateWords(1)} at 6 PM.`, { supersedes: [linkedNote.id] });
    const afterRewrite = (await a.daily()).filter((memory) => /restock chicken/i.test(memory.text));
    check("rewriteReplacesCurrentVersion", rewrite.superseded === 1 && afterRewrite.length === 1 && afterRewrite[0].id === rewrite.id && afterRewrite[0].todoId === chicken, afterRewrite);

    // --- 8, 9. Its time passes, not done: the thread comes back, with one note of the move -----------
    await a.call("todos:edit", { key: KEY, id: chicken, dueAt: Date.now() - 60 * 60_000 });
    await a.call("todos:edit", { key: KEY, id: chicken, dueAt: Date.now() - 30 * 60_000 });
    const overdue = (await a.daily()).find((memory) => /restock chicken/i.test(memory.text));
    check("movedTwiceSaysOnce", (overdue?.text.match(/\(To-do:/g) ?? []).length === 1, overdue?.text);
    const threadsNow = await a.call<Thread[]>("memories:openThreads", {});
    const back = threadsNow.find((thread) => thread.id === overdue?.id);
    check("passedAndNotDoneComesBack", Boolean(back?.todo && /"Restock chicken", was due .*not ticked off/.test(back.todo)), back);

    // --- 10. Done, put back, dropped; the pet's push back ---------------------------------------------
    const done = await a.call<Linked>("todos:updateFromAgent", { id: chicken, done: true });
    const doneNote = await a.noteById(done.linkedNotes?.[0] ?? "-");
    check("doneSettlesNote", Boolean(doneNote && /\(To-do: done, ticked off /.test(doneNote.text) && !doneNote.tags.includes("open")), doneNote);
    check("doneNotAThread", !(await a.call<Thread[]>("memories:openThreads", {})).some((thread) => /chicken/i.test(thread.text)));
    const undone = await a.call<Linked>("todos:updateFromAgent", { id: chicken, done: false });
    const undoneNote = await a.noteById(undone.linkedNotes?.[0] ?? "-");
    check("putBackReopensNote", Boolean(undoneNote && /\(To-do: not done after all, back on the list /.test(undoneNote.text) && undoneNote.tags.includes("open")), undoneNote);
    await a.call("todos:pushBack", { key: KEY, id: plumber.added!.id, minutes: 60 });
    const pushed = (await a.daily()).find((memory) => /plumber/.test(memory.text));
    check("petPushBackFollows", Boolean(pushed && pushed.id !== plumberNote.id && /\(To-do: moved, now due /.test(pushed.text)), pushed?.text);
    await a.call("todos:removeFromAgent", { id: chicken });
    const dropped = (await a.daily()).find((memory) => /restock chicken/i.test(memory.text));
    check("deleteDropsNote", Boolean(dropped && /\(To-do: dropped from the list /.test(dropped.text) && !dropped.tags.includes("open")), dropped);

    // --- 5. The owner's real data: an old note, never linked, and the to-do moved with update_todo -------
    await a.call("memories:removeMany", { ids: (await a.daily()).filter((memory) => /chicken/i.test(memory.text)).map((memory) => memory.id) });
    const chicken2 = await a.todo("Restock chicken", epochAt(-1, "18:00"));
    const oldNote = await a.remember(chickenWords);
    const moved2 = await a.call<{ updated?: { due?: string } } & Linked>("todos:updateFromAgent", { id: chicken2, at: isoAt(1, "18:00") });
    check("unlinkedNoteLeftAsItWas", !moved2.linkedNotes && (await a.noteById(oldNote.id))?.text === chickenWords);
    // Beside it: a bill overdue and not paid, and a one-word to-do due tomorrow with a note that merely shares its word.
    await a.todo("Pay the electricity bill", epochAt(-1, "12:00"));
    const bill = await a.remember(`The owner has to pay the electricity bill on ${dateWords(-1)} by noon.`);
    await a.todo("Gym", epochAt(1, "07:00"));
    const knee = await a.remember(`The owner hurt his knee at the gym on ${dateWords(-1)} and will see how it feels.`);
    const unlinkedPrompt = await a.heartbeatPrompt();
    notes.unlinkedPrompt = unlinkedPrompt;
    const listed = threadsPart(unlinkedPrompt).split("\n");
    check("unlinkedMovedThreadLeftOut", !listed.some((line) => line.includes(oldNote.id) || /chicken/i.test(line)), threadsPart(unlinkedPrompt));
    check("unlinkedTodoListAndRule", todosPart(unlinkedPrompt).includes(`- Restock chicken: ${tomorrowDue}, still to come`) && /one due later than now has not happened yet/.test(unlinkedPrompt));
    check("overdueUnlinkedStillListed", listed.some((line) => line.includes(bill.id) && /looks like the to-do "Pay the electricity bill": was due .*not ticked off/.test(line)), listed.find((line) => line.includes(bill.id)));
    check("oneWordTodoHidesNothing", listed.some((line) => line.includes(knee.id)));
    check("dentistStillPlain", listed.some((line) => line.includes(dentist.id) && !line.includes("to-do")));
  } finally {
    await a.shutdown();
  }

  // ===========================================================================================
  // Perry B: the real runner and Codex, one heartbeat turn.
  // ===========================================================================================

  if (!withCodex) notes.codexTurn = `not run: ${skipCodex!.split("=").slice(1).join("=") || "--no-codex"}`;
  else {
    const b = await perry("b");
    try {
      const chicken = await b.todo("Restock chicken", epochAt(-1, "18:00"));
      const chickenNote = await b.remember(chickenWords);
      await b.call("todos:updateFromAgent", { id: chicken, at: isoAt(1, "18:00") });
      const car = await b.todo("Get the car serviced", epochAt(-1, "10:00"));
      const carNote = await b.remember(`The owner plans to get the car serviced on ${dateWords(-1)} at 10 AM.`, { todoId: car });
      await b.call("todos:updateFromAgent", { id: car, at: isoAt(1, "10:00") });
      const dentist = await b.remember(dentistWords);

      b.startRunner();
      await until(async () => (await b.call<Array<{ lastSeenAt?: number; codexAuthMode?: string }>>("runner:listRunners")).some((item) => Date.now() - (item.lastSeenAt ?? 0) < 90_000 && item.codexAuthMode === "chatgpt"), "the runner to come online signed in to Codex", 120);
      await until(async () => (await b.call<unknown[]>("models:list")).length > 0, "the runner's model list", 60);
      const models = await b.call<Array<{ id: string; isDefault: boolean }>>("models:list");
      const model = process.env.PERRY_E2E_MODEL ?? (models.find((item) => item.id === "gpt-5.5") ?? models.find((item) => !item.isDefault) ?? models[0]).id;
      notes.model = model;
      const heartbeat = await b.heartbeat();
      const thread = await b.call<string>("agentStore:createThread", { userId: "web:dashboard", title: "⏰ Heartbeat" });
      const chat = await b.call<{ externalId: string }>("jobs:chatFor", { id: heartbeat.id, threadId: thread });
      const conversation = await b.call<{ _id: string }>("conversations:getByExternalId", { channel: "web", externalId: chat.externalId });
      await b.call("conversations:setModel", { id: conversation._id, model });

      const at = Date.now();
      await b.call("jobs:run", { id: heartbeat.id });
      let finished: Job | undefined;
      await until(async () => {
        finished = (await b.jobs()).find((job) => job.id === heartbeat.id);
        return Boolean(finished?.lastResult || finished?.lastError);
      }, "the heartbeat to finish", 300);
      await until(() => toOwner(at).some((message) => message.text.startsWith("⏰ Heartbeat")), "the heartbeat on Telegram", 20).catch(() => {});
      const said = toOwner(at).filter((message) => message.text.startsWith("⏰ Heartbeat")).map((message) => message.text).join("\n");
      const prompt = (await b.call<Array<{ prompt: string; startedAt: number }>>("dashboard:listRuns", { key: KEY })).find((run) => run.startedAt >= at - 1_000 && run.prompt.includes("⏰ Heartbeat ("))?.prompt ?? "";
      notes.codexPrompt = prompt;
      notes.heartbeatResult = finished?.lastResult ?? finished?.lastError;
      notes.heartbeatSaid = said;
      const after = await b.daily();
      const asked = (id: string) => after.find((memory) => memory.id === id)?.tags.includes("asked") === true;
      const carNow = after.find((memory) => /car serviced/.test(memory.text));
      check("codexRanClean", Boolean(finished?.lastResult) && !finished?.lastError);
      check("codexNoChickenQuestion", !/chicken|restock/i.test(`${finished?.lastResult ?? ""}\n${said}`) && !asked(chickenNote.id));
      check("codexNoCarQuestion", !/car|servic/i.test(`${finished?.lastResult ?? ""}\n${said}`) && !asked(carNote.id) && !(carNow?.tags.includes("asked")));
      check("codexAsksAboutDentist", /dentist|filling/i.test(said) && said.includes("?") && asked(dentist.id));
    } finally {
      await b.shutdown();
    }
  }
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  stub.close();
}

notes.telegram = telegram.sent.filter((message) => !/^\d{6}$/.test(message.text)).map(({ chat_id, text }) => ({ chat_id, text }));
const result = { ranAt: new Date().toISOString(), withCodex, checks, notes, passed: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
