import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { perry } from "../engine-acp/harness";

// bun artifacts/telegram-commands/run.ts <outDir> [refused|stalled]
// With "refused" the stand-in answers setMyCommands with an error, with
// "stalled" it never answers: /help must still be answered either way.
// The list Telegram shows when the owner types "/". A fresh Perry from the
// production build (`pnpm build` first) on a spare port with a temp
// PERRY_HOME and a stand-in Telegram Bot API that records setMyCommands and
// answers /help. Nothing touches the owner's own Perry or bot.
//
// Ways it could fail, written down before the checks:
//   1. Perry never calls setMyCommands, so "/" shows nothing.
//   2. Telegram would refuse the list: a name with a slash, capitals or spaces,
//      a duplicate, an empty or over-256-character description, or over 100 entries.
//   3. The list names a command Perry does not answer (it is not in /help), or
//      leaves out one /help lists, so the two drift apart.
//   4. A refusal of the list, or a request for it that never returns, stops
//      polling: the owner's /help goes unanswered.

const [outDir, mode] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/telegram-commands/run.ts <outDir> [refused|stalled]");
mkdirSync(outDir, { recursive: true });

const OWNER = 4242;
const telegram = { sent: [] as Array<{ chat_id: string; text: string; at: number }>, pending: [] as object[], nextUpdate: 1, commands: [] as Array<{ command: string; description: string }>, listCalls: 0 };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const method = request.url?.split("/").pop() ?? "";
    const args = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, username: "perry_commands_bot", first_name: "Perry" });
    if (method === "setMyCommands") {
      telegram.listCalls++;
      if (mode === "stalled") return; // never answered
      if (mode === "refused") { response.writeHead(400, { "content-type": "application/json" }); return void response.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: refused by the stand-in" })); }
      telegram.commands = args.commands ?? [];
      return reply(true);
    }
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
  name: mode ? `telegram-commands-${mode}` : "telegram-commands",
  outDir,
  engine: "claude",
  runnerEnv: () => ({}),
  env: { TELEGRAM_BOT_TOKEN: "123456:commands-e2e", TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}` },
});
const { call, check, notes, until, start, finish } = p;

try {
  start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await until(() => telegram.listCalls > 0, "setMyCommands to be called", 30);
  notes.commands = telegram.commands;

  // 1, 2.
  const registered = !mode;
  const names = telegram.commands.map((item) => item.command);
  if (registered) {
    check("listRegistered", names.length > 0);
    check("namesAreValid", names.every((name) => /^[a-z0-9_]{1,32}$/.test(name)) && new Set(names).size === names.length);
    check("descriptionsAreValid", telegram.commands.every((item) => item.description.length >= 1 && item.description.length <= 256) && names.length <= 100);
  } else check("listWasAttempted", telegram.listCalls > 0);

  // 3, 4. Pair the owner, then /help, which must still be answered and agree with the list.
  const { code } = await call<{ code: string }>("installation:startPairing");
  ownerSays(code);
  await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
  const at = Date.now();
  ownerSays("/help");
  await until(() => telegram.sent.some((message) => message.chat_id === String(OWNER) && message.at > at && /\/help/.test(message.text)), "an answer to /help", 60);
  const help = telegram.sent.filter((message) => message.at > at).map((message) => message.text).join("\n");
  const helped = [...help.matchAll(/^\s*\/([a-z]+)\s{2,}/gm)].map((match) => match[1]);
  notes.helped = helped;
  check("helpAnsweredAfterList", helped.length > 0);
  if (registered) {
    check("everyListedCommandIsInHelp", names.every((name) => helped.includes(name)));
    check("everyHelpCommandIsListed", helped.every((name) => names.includes(name)));
  }
} catch (error) {
  check("noError", false, String(error));
}
process.exit((await finish()) ? 0 : 1);
