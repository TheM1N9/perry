import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/usage-command/run.ts <outDir>
// /usage on Telegram: how much of the chat's engine's plan is used and left.
// A fresh Perry from the production build (`pnpm build` first) on a spare port
// with a temp PERRY_HOME, the real runner with the fake ACP agent playing Grok
// Build, Codex and Claude Code with empty homes (so no real model turn runs),
// and a stand-in Telegram Bot API. The plan limits are written through the
// runner's own report call (usage.report), as the runner writes what an
// engine told it, so the numbers the reply must show are known. Nothing
// touches the owner's own Perry.
//
// Ways it could fail, written down before the checks:
//   1. The command is not answered as a command: it reaches the model as a
//      message (a run starts), or Perry says it does not know /usage (an old
//      build, or the case missing).
//   2. With no reading yet, the reply invents numbers instead of saying there
//      is none.
//   3. With a reading, the reply differs from what the engine reported: a window
//      is missing, "used" is not the reported percent rounded, "left" is not
//      100 less that, the plan is not named, or the reset time is missing.
//   4. A window whose reset has passed still counts as used.
//   5. The reading's age is wrong: when another engine's reading is newer, the
//      reply says "just now" for limits read hours ago.
//   6. An engine that reports no limits (Grok Build) is shown numbers, or is
//      not told plainly that there is no balance; a limit it hit is not shown.
//   7. It is refused while Perry is paused (it only reads, so it must answer).
//   8. A chat on a different engine is told about the wrong engine.
//   9. Perry's share counts another engine's runs, or the reply throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/usage-command/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

// --- The stand-in Telegram -------------------------------------------------------------

const OWNER = 4242;
const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[], nextUpdate: 1 };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, username: "perry_usage_bot", first_name: "Perry" });
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
  message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Adi" }, text },
});

const p = await perry({
  name: "usage-command",
  outDir,
  engine: "claude",
  runnerEnv: (home) => ({
    PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`,
    FAKE_ACP_HOME: join(home, "fake-grok"),
    CODEX_HOME: join(home, "codex-empty"),
    CLAUDE_CONFIG_DIR: join(home, "claude-empty"),
  }),
  env: { TELEGRAM_BOT_TOKEN: "123456:usage-e2e", TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}` },
});
const { home, call, check, notes, until, rows, start, finish, computers } = p;
for (const dir of ["fake-grok", "codex-empty", "claude-empty"]) mkdirSync(join(home, dir), { recursive: true });
writeFileSync(join(home, "fake-grok", "grok-signed-in"), "yes");

/** Say something on Telegram and return what Perry answered. */
async function ask(text: string): Promise<string> {
  const at = Date.now();
  ownerSays(text);
  await until(() => telegram.sent.some((message) => message.chat_id === String(OWNER) && message.at > at), `an answer to "${text}"`, 60);
  await sleep(1_200);
  return telegram.sent.filter((message) => message.chat_id === String(OWNER) && message.at > at).map((message) => message.text).join("\n");
}
const runCount = () => rows("runs").length;
const MIN = 60_000;

try {
  start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner to report Grok signed in", 120);
  const token = String(rows("runners").find((row) => !row.revoked)?.token);
  const runsBefore = runCount();

  // 1, 2. Answered as a command, and honest while there is no reading.
  const none = await ask("/usage");
  notes.noReading = none;
  check("answeredAsACommand", /Claude Code usage/.test(none) && !/Don't know/.test(none));
  check("noRunStarted", runCount() === runsBefore);
  check("noReadingSaysSo", /No reading of Claude Code's limits yet/.test(none) && !/\d+% used/.test(none));

  // 3, 4, 5. A reading, written as the runner writes it: 5-hour 42% (resets in 95 min), Weekly 83.4% (in 3 days),
  // Weekly (Opus) 100% but already reset. The reading is 2 hours old, while another engine's report is new.
  const now = Date.now();
  await call("usage:report", { token, engine: "claude", limits: { plan: "Max 5x", at: now - 120 * MIN, windows: [
    { id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: now + 95 * MIN, minutes: 300 },
    { id: "seven_day", label: "Weekly", usedPercent: 83.4, resetsAt: now + 3 * 86_400_000, minutes: 10080 },
    { id: "seven_day_opus", label: "Weekly (Opus)", usedPercent: 100, resetsAt: now - 1_000, minutes: 10080 },
  ] } });
  const read = await ask("/usage");
  notes.withReading = read;
  check("namesEngineAndPlan", /^Claude Code usage \(Max 5x\)/.test(read));
  check("fiveHourWindow", /5-hour: 42% used, 58% left, resets /.test(read));
  check("weeklyWindowRounded", /Weekly: 83% used, 17% left, resets /.test(read));
  check("resetWindowCountsAsUnused", /Weekly \(Opus\): 0% used, 100% left/.test(read) && !/Opus\): 100% used/.test(read));
  check("everyWindowShown", (read.match(/% used/g) ?? []).length === 3);
  check("readingAgeIsTheEnginesOwn", /Read 2 h ago/.test(read) && !/Read just now/.test(read));
  check("perrysShareShown", /Perry's share this week: 0 turns, 0 tokens/.test(read));

  // 7. While paused it still answers, and says nothing of a pause.
  await ask("/pause");
  const paused = await ask("/usage");
  notes.whilePaused = paused;
  check("answersWhilePaused", /Claude Code usage \(Max 5x\)/.test(paused) && !/paused, so nothing runs/.test(paused));
  await ask("/resume");

  // 6, 8. A chat on Grok Build, which reports no limits: it is about Grok, with no numbers, and says what it last hit.
  const models = await ask("/model");
  const grokModel = models.match(/Grok Build models:\n[•\s]*([^\s,]+)/)?.[1];
  notes.grokModel = grokModel;
  const switched = grokModel ? await ask(`/model grok/${grokModel}`) : "";
  notes.switched = switched;
  const grok = await ask("/usage");
  notes.grok = grok;
  check("switchedToGrok", /now uses/.test(switched));
  check("otherEngineIsNamed", /^Grok Build usage/.test(grok) && !/Claude Code usage/.test(grok));
  check("noLimitsSaysNoBalance", /doesn't report its plan's limits, so there is no balance to show/.test(grok) && !/% used/.test(grok));
  await call("usage:report", { token, engine: "grok", hit: { at: Date.now(), message: "You've hit your usage limit. Try again later." } });
  const hit = await ask("/usage");
  notes.grokHit = hit;
  check("limitHitShown", /refused a reply for its limit/.test(hit) && /hit your usage limit/.test(hit));

  // 1 again, from the other command list: it is in /help.
  const help = await ask("/help");
  check("inHelp", /\/usage\s+how much of this chat's model plan is used/.test(help));
} catch (error) {
  check("noError", false, String(error));
}
process.exit((await finish()) ? 0 : 1);
